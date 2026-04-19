/**
 * File watcher for incoming messages in ~/.agent-bridge/inbox/.
 *
 * Uses:
 * - macOS: fswatch (install via `brew install fswatch`)
 * - Linux: inotifywait (from inotify-tools)
 * - Fallback: polling every 2 seconds
 *
 * Production-grade features:
 * - Auto-restart with exponential backoff (max 3 retries, then polling fallback)
 * - Notifies inbox cache on new files
 * - Reports health status
 * - Emits channel notifications when new messages arrive (push to Claude)
 */

import { spawn, type ChildProcess } from 'child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { INBOX_DIR } from './config.js';
import { logInfo, logError, logDebug, logWarn } from './logger.js';
import { logEvent } from './log.js';
import { invalidateCache, notifyNewFiles, setWatcherStatus, isDelivered, markDelivered } from './inbox.js';
import type { BridgeMessage } from './inbox.js';

type MessageCallback = (files: string[]) => void;

/**
 * Callback invoked with a parsed BridgeMessage when a new inbox file arrives.
 * Used to push channel notifications into the running Claude session.
 */
type ChannelNotifyCallback = (message: BridgeMessage) => void;

let watcherProcess: ChildProcess | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let knownFiles = new Set<string>();

/** Maximum entries in knownFiles before evicting oldest (insertion-order). */
const KNOWN_FILES_MAX = 2000;

function addKnownFile(name: string): void {
  if (knownFiles.has(name)) return;
  if (knownFiles.size >= KNOWN_FILES_MAX) {
    // Evict the oldest entry (Sets iterate in insertion order)
    const first = knownFiles.values().next().value;
    if (first !== undefined) knownFiles.delete(first);
  }
  knownFiles.add(name);
}

/** Current backend used for watching. */
let currentBackend: 'fswatch' | 'inotifywait' | 'polling' | 'unknown' = 'unknown';

/** Number of consecutive crash-restarts for the native watcher. */
let restartCount = 0;
const MAX_RESTARTS = 3;
const BASE_BACKOFF_MS = 1000;

/** The callback for new messages, saved for restart purposes. */
let savedCallback: MessageCallback | null = null;

/** The channel notification callback, saved for restart purposes. */
let savedChannelCallback: ChannelNotifyCallback | null = null;

/**
 * Try to parse a message file and emit a channel notification.
 * Marks the message as delivered to avoid re-emitting on next startup.
 * Errors are logged but never thrown — the watcher must keep running.
 */
function emitChannelNotification(fileName: string): void {
  if (!savedChannelCallback) return;

  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp || !msg.content) {
      logWarn(`Channel: skipping malformed message file ${fileName}`);
      return;
    }
    // Skip if already delivered in a previous session
    if (isDelivered(msg.id)) {
      logDebug(`Channel: skipping already-delivered message ${msg.id}`);
      return;
    }
    logEvent({
      event: 'message.received',
      msg: `Inbox message ${msg.id} received from ${msg.from}`,
      context: {
        msg_id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        reply_to: msg.replyTo,
        content_length: msg.content?.length ?? 0,
      },
    });
    savedChannelCallback(msg);
    markDelivered(msg.id);
  } catch (err) {
    logError(`Channel: failed to emit notification for ${fileName}: ${err}`);
  }
}

// ── Known-files init ─────────────────────────────────────────────────────────

function initKnownFiles(): void {
  knownFiles.clear();
  try {
    if (existsSync(INBOX_DIR)) {
      const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        knownFiles.add(f);
      }
    }
  } catch {
    // Ignore errors
  }
}

// ── Polling fallback ─────────────────────────────────────────────────────────

function checkForNewFiles(callback: MessageCallback): void {
  try {
    if (!existsSync(INBOX_DIR)) return;
    const currentFiles = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    const newFiles = currentFiles.filter(f => !knownFiles.has(f));

    if (newFiles.length > 0) {
      logDebug(`Watcher detected ${newFiles.length} new message(s)`);
      for (const f of newFiles) {
        addKnownFile(f);
      }
      // Notify the inbox cache
      notifyNewFiles(newFiles);
      invalidateCache();

      // Emit channel notifications for each new message
      for (const f of newFiles) {
        emitChannelNotification(f);
      }

      callback(newFiles.map(f => join(INBOX_DIR, f)));
    }
  } catch (err) {
    logError(`Watcher error checking files: ${err}`);
  }
}

function startPolling(callback: MessageCallback): void {
  if (pollInterval) return;
  currentBackend = 'polling';
  setWatcherStatus('polling', true);
  logInfo('Using polling watcher (2s interval)');
  logEvent({
    event: 'watcher.started',
    msg: 'Using polling watcher (2s interval)',
    context: { backend: 'polling', intervalMs: 2000 },
  });
  pollInterval = setInterval(() => checkForNewFiles(callback), 2000);
  if (pollInterval.unref) pollInterval.unref();
}

// ── Spawn helper ─────────────────────────────────────────────────────────────

function trySpawn(
  command: string,
  args: string[],
  timeoutMs: number = 500,
): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          resolve(proc);
        } else {
          resolve(null);
        }
      }, timeoutMs);

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

// ── Auto-restart with exponential backoff ────────────────────────────────────

function scheduleRestart(callback: MessageCallback): void {
  restartCount++;
  if (restartCount > MAX_RESTARTS) {
    logWarn(
      `Native watcher crashed ${restartCount} times. Falling back to polling permanently.`,
    );
    startPolling(callback);
    return;
  }

  const delay = BASE_BACKOFF_MS * Math.pow(2, restartCount - 1);
  logWarn(
    `Native watcher crashed. Restarting in ${delay}ms (attempt ${restartCount}/${MAX_RESTARTS})...`,
  );

  setTimeout(async () => {
    logInfo(`Restarting native watcher (attempt ${restartCount}/${MAX_RESTARTS})...`);
    // Re-attempt native watcher, preserving the channel callback
    await startWatcher(callback, savedChannelCallback ?? undefined);
  }, delay);
}

// ── fswatch handler (macOS) ──────────────────────────────────────────────────

function setupFswatchHandler(proc: ChildProcess, callback: MessageCallback): void {
  currentBackend = 'fswatch';
  setWatcherStatus('fswatch', true);
  watcherProcess = proc;

  proc.stdout!.on('data', (chunk: Buffer) => {
    const paths = chunk
      .toString()
      .split('\0')
      .filter(p => p.endsWith('.json'));
    if (paths.length > 0) {
      // Dedup: fswatch can fire multiple events for the same file
      const newNames: string[] = [];
      const seen = new Set<string>();
      for (const p of paths) {
        const name = p.split('/').pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        if (!knownFiles.has(name)) {
          addKnownFile(name);
          newNames.push(name);
        }
      }
      if (newNames.length === 0) return;

      notifyNewFiles(newNames);
      invalidateCache();

      // Emit channel notifications for each new message
      for (const name of newNames) {
        emitChannelNotification(name);
      }

      callback(newNames.map(n => join(INBOX_DIR, n)));
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    logDebug(`fswatch stderr: ${chunk.toString().trim()}`);
  });

  proc.on('close', (code) => {
    if (watcherProcess === proc) {
      watcherProcess = null;
      setWatcherStatus('fswatch', false);
      logWarn(`fswatch exited with code ${code}`);
      scheduleRestart(callback);
    }
  });

  proc.on('error', (err) => {
    logError(`fswatch error: ${err.message}`);
    if (watcherProcess === proc) {
      watcherProcess = null;
      setWatcherStatus('fswatch', false);
      scheduleRestart(callback);
    }
  });
}

// ── inotifywait handler (Linux) ──────────────────────────────────────────────

function setupInotifywaitHandler(
  proc: ChildProcess,
  callback: MessageCallback,
): void {
  currentBackend = 'inotifywait';
  setWatcherStatus('inotifywait', true);
  watcherProcess = proc;

  proc.stdout!.on('data', (chunk: Buffer) => {
    const files = chunk
      .toString()
      .trim()
      .split('\n')
      .filter(f => f.endsWith('.json'));
    if (files.length > 0) {
      for (const f of files) {
        addKnownFile(f);
      }
      notifyNewFiles(files);
      invalidateCache();

      // Emit channel notifications for each new message
      for (const f of files) {
        emitChannelNotification(f);
      }

      callback(files.map(f => join(INBOX_DIR, f)));
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    logDebug(`inotifywait stderr: ${chunk.toString().trim()}`);
  });

  proc.on('close', (code) => {
    if (watcherProcess === proc) {
      watcherProcess = null;
      setWatcherStatus('inotifywait', false);
      logWarn(`inotifywait exited with code ${code}`);
      scheduleRestart(callback);
    }
  });

  proc.on('error', (err) => {
    logError(`inotifywait error: ${err.message}`);
    if (watcherProcess === proc) {
      watcherProcess = null;
      setWatcherStatus('inotifywait', false);
      scheduleRestart(callback);
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start watching the inbox for new messages.
 * Tries native watchers first, falls back to polling.
 *
 * @param callback - Called with file paths when new messages are detected.
 * @param channelCallback - Optional. Called with parsed BridgeMessage for
 *   each new message, used to push channel notifications into Claude.
 */
export async function startWatcher(
  callback: MessageCallback,
  channelCallback?: ChannelNotifyCallback,
): Promise<void> {
  savedCallback = callback;
  if (channelCallback) {
    savedChannelCallback = channelCallback;
  }

  // Ensure inbox directory exists
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  }

  initKnownFiles();

  const platform = process.platform;

  // Try fswatch on macOS
  if (platform === 'darwin') {
    logInfo('Attempting to start fswatch watcher...');
    const proc = await trySpawn('fswatch', [
      '-0',
      '--event',
      'Created',
      INBOX_DIR,
    ]);

    if (proc) {
      logInfo('fswatch watcher started');
      logEvent({
        event: 'watcher.started',
        msg: 'fswatch watcher started',
        context: { backend: 'fswatch', pid: proc.pid },
      });
      restartCount = 0; // reset on successful start
      setupFswatchHandler(proc, callback);
      return;
    }
  }

  // Try inotifywait on Linux
  if (platform === 'linux') {
    logInfo('Attempting to start inotifywait watcher...');
    const proc = await trySpawn('inotifywait', [
      '-m',
      '-e',
      'create',
      '--format',
      '%f',
      INBOX_DIR,
    ]);

    if (proc) {
      logInfo('inotifywait watcher started');
      logEvent({
        event: 'watcher.started',
        msg: 'inotifywait watcher started',
        context: { backend: 'inotifywait', pid: proc.pid },
      });
      restartCount = 0;
      setupInotifywaitHandler(proc, callback);
      return;
    }
  }

  // Fallback: polling
  startPolling(callback);
}

/**
 * Replay undelivered messages from the inbox.
 *
 * Scans the inbox for .json files that have not yet been pushed as channel
 * notifications (i.e. messages that arrived while Claude was offline).
 * Emits a channel notification for each, sorted oldest-first so the agent
 * sees them in chronological order.
 *
 * Call this AFTER the MCP server is connected so that
 * `notifications/claude/channel` can actually be sent.
 */
export function replayUndeliveredMessages(): void {
  if (!savedChannelCallback) {
    logWarn('Replay: no channel callback registered, skipping');
    return;
  }

  try {
    if (!existsSync(INBOX_DIR)) return;

    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // Parse all valid messages, filter to undelivered, sort by timestamp
    const undelivered: { fileName: string; msg: BridgeMessage }[] = [];

    for (const fileName of files) {
      const filePath = join(INBOX_DIR, fileName);
      try {
        const raw = readFileSync(filePath, 'utf8');
        const msg = JSON.parse(raw) as BridgeMessage;
        if (!msg.id || !msg.timestamp || !msg.content) continue;
        if (isDelivered(msg.id)) continue;
        undelivered.push({ fileName, msg });
      } catch {
        // Skip malformed files — the prune pass will handle them
      }
    }

    if (undelivered.length === 0) {
      logInfo('Replay: no undelivered messages found');
      return;
    }

    // Sort oldest first
    undelivered.sort(
      (a, b) =>
        new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime(),
    );

    logInfo(`Replay: emitting ${undelivered.length} undelivered message(s)`);

    for (const { fileName, msg } of undelivered) {
      logInfo(`Replay: pushing message ${msg.id} from ${msg.from} (ts: ${msg.timestamp})`);
      savedChannelCallback(msg);
      markDelivered(msg.id);
    }

    logInfo(`Replay: completed, ${undelivered.length} message(s) delivered`);
  } catch (err) {
    logError(`Replay: failed to scan inbox for undelivered messages: ${err}`);
  }
}

/**
 * Stop the watcher (for clean shutdown).
 */
export function stopWatcher(): void {
  if (watcherProcess) {
    logInfo(`Stopping ${currentBackend} watcher process (pid ${watcherProcess.pid})`);
    watcherProcess.kill();
    watcherProcess = null;
  }
  if (pollInterval) {
    logInfo('Stopping polling watcher');
    clearInterval(pollInterval);
    pollInterval = null;
  }
  setWatcherStatus(currentBackend, false);
  logInfo('Watcher stopped');
  logEvent({
    event: 'watcher.stopped',
    msg: 'Watcher stopped',
    context: { backend: currentBackend },
  });
}

/**
 * Get the current watcher backend.
 */
export function getWatcherBackend(): typeof currentBackend {
  return currentBackend;
}
