/**
 * File watcher for incoming Claude Code messages in ~/.agent-bridge/inbox/claude-code/.
 *
 * Polling-only (2s interval). No external dependencies.
 *
 * Historical note: earlier versions of this file spawned `fswatch` (macOS) or
 * `inotifywait` (Linux) as child processes and fell back to polling only if
 * the spawn failed. That was removed in mcp-server 3.4.3 because:
 *  - fswatch is not installed by default on macOS and required Homebrew
 *  - the spawned children occasionally outlived their parent MCP, leaving
 *    zombie watchers pinned to dead Claude sessions
 *  - the extra code path (spawn/crash/backoff/restart) was a frequent source
 *    of race bugs, and the benefit (sub-second latency) wasn't worth it
 *    when polling at 2 s uses effectively zero CPU and zero dependencies.
 *
 * Responsibilities kept:
 *  - Notify inbox cache on new files
 *  - Report health status via setWatcherStatus()
 *  - Emit channel notifications when new messages arrive (push to Claude)
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  CLAUDE_CODE_TARGET,
  LOCKS_DIR,
  inboxSubdir,
  archiveSubdir,
  failedSubdir,
  isValidTarget,
} from './config.js';

/**
 * The inbox subdir this watcher owns. As of mcp-server 3.4.0 the watcher
 * scopes to `inbox/claude-code/` instead of the flat root inbox. Other
 * harnesses (openclaw-channel etc.) watch their own subdirs independently.
 */
const CLAUDE_CODE_INBOX_DIR = inboxSubdir(CLAUDE_CODE_TARGET);
const CLAUDE_CODE_ARCHIVE_DIR = archiveSubdir(CLAUDE_CODE_TARGET);
const CLAUDE_CODE_FAILED_DIR = failedSubdir(CLAUDE_CODE_TARGET);
const INBOX_DIR = CLAUDE_CODE_INBOX_DIR;
import { logInfo, logError, logDebug, logWarn } from './logger.js';
import { logEvent } from './log.js';
import { invalidateCache, notifyNewFiles, setWatcherStatus, isDelivered, markDelivered } from './inbox.js';
import type { BridgeMessage } from './inbox.js';

type MessageCallback = (files: string[]) => void;

/**
 * Callback invoked with a parsed BridgeMessage when a new inbox file arrives.
 * Used to push channel notifications into the running Claude session.
 */
type ChannelNotifyCallback = (message: BridgeMessage) => void | Promise<void>;

type WatcherLeaseFile = {
  pid: number;
  target: string;
  role: string;
  token: string;
  startedAt: number;
  updatedAt: number;
};

type WatcherLeaseState = {
  filePath: string;
  heartbeat: ReturnType<typeof setInterval>;
  meta: WatcherLeaseFile;
};

type WatcherLeaseAcquireResult = 'acquired' | 'busy' | 'failed';

let pollInterval: ReturnType<typeof setInterval> | null = null;
let knownFiles = new Set<string>();
let watcherLease: WatcherLeaseState | null = null;
let watcherLeaseRenewFailures = 0;
let standbyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let savedMessageCallback: MessageCallback | null = null;
let savedWatcherRole = 'auto';

/** Maximum entries in knownFiles before evicting oldest (insertion-order). */
const KNOWN_FILES_MAX = 2000;
const WATCHER_LEASE_STALE_MS = 15_000;
const WATCHER_LEASE_HEARTBEAT_MS = 5_000;
const WATCHER_LEASE_MAX_RENEW_FAILURES = 3;
const WATCHER_STANDBY_RETRY_MS = 2_000;
const DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS = 10_000;

function addKnownFile(name: string): void {
  if (knownFiles.has(name)) return;
  if (knownFiles.size >= KNOWN_FILES_MAX) {
    // Evict the oldest entry (Sets iterate in insertion order)
    const first = knownFiles.values().next().value;
    if (first !== undefined) knownFiles.delete(first);
  }
  knownFiles.add(name);
}

/**
 * Current backend used for watching. Always 'polling' as of 3.4.3. Retained
 * as a constant (rather than removed entirely) so the exported
 * `getWatcherBackend()` signature and `setWatcherStatus()` contract continue
 * to compile and callers (inbox stats, tests) don't break.
 */
const currentBackend: 'polling' = 'polling';

/** The channel notification callback. */
let savedChannelCallback: ChannelNotifyCallback | null = null;

function channelNotifyTimeoutMs(): number {
  const raw = process.env.AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT_MS;
  if (!raw) return DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_CHANNEL_NOTIFY_TIMEOUT_MS;
  return Math.min(parsed, 120_000);
}

function withChannelNotifyTimeout<T>(promise: Promise<T>, msgId: string): Promise<T> {
  const timeoutMs = channelNotifyTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const err = new Error(
        `Channel notification for ${msgId} did not settle within ${timeoutMs}ms`,
      );
      (err as Error & { code?: string }).code = 'AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT';
      reject(err);
    }, timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function watcherLeasePath(target: string): string {
  const safeTarget = target.replaceAll('/', '__');
  return join(LOCKS_DIR, `${safeTarget}.watcher-lock.json`);
}

function readWatcherLease(filePath: string): WatcherLeaseFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WatcherLeaseFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    const startedAt = Number(parsed.startedAt);
    const updatedAt = Number(parsed.updatedAt);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof parsed.target !== 'string' || !parsed.target) return null;
    if (typeof parsed.role !== 'string' || !parsed.role) return null;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) {
      return null;
    }
    return {
      pid,
      target: parsed.target,
      role: parsed.role,
      token: parsed.token,
      startedAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ESRCH';
  }
}

function watcherLeaseIsStale(filePath: string, lease: WatcherLeaseFile): boolean {
  if (!pidIsAlive(lease.pid)) return true;
  try {
    const stats = statSync(filePath);
    const lastUpdated = Math.max(Number(lease.updatedAt) || 0, stats.mtimeMs);
    return Date.now() - lastUpdated > WATCHER_LEASE_STALE_MS;
  } catch {
    return true;
  }
}

function clearWatcherLeaseState(): void {
  if (watcherLease?.heartbeat) {
    clearInterval(watcherLease.heartbeat);
  }
  watcherLease = null;
  watcherLeaseRenewFailures = 0;
}

function releaseWatcherLease(): void {
  if (!watcherLease) return;
  const { filePath, meta } = watcherLease;
  clearWatcherLeaseState();
  try {
    const current = readWatcherLease(filePath);
    if (current?.token === meta.token && existsSync(filePath)) {
      unlinkSync(filePath);
      logEvent({
        event: 'watcher.lease_released',
        msg: `Watcher lease released for ${meta.target}`,
        context: { target: meta.target, pid: process.pid, role: meta.role },
      });
    }
  } catch (err) {
    logWarn(`Watcher: failed to release lease ${filePath}: ${err}`);
  }
}

function stopPollingForLeaseLoss(reason: string): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  clearWatcherLeaseState();
  setWatcherStatus(currentBackend, false);
  logWarn(`Watcher: stopping poller because lease ownership was lost (${reason})`);
  logEvent({
    event: 'watcher.lease_lost',
    level: 'warn',
    msg: `Watcher lease lost for ${CLAUDE_CODE_TARGET}`,
    context: { reason, pid: process.pid, target: CLAUDE_CODE_TARGET },
  });
  if (savedMessageCallback) {
    scheduleStandbyRetry(savedMessageCallback, savedWatcherRole);
  }
}

function renewWatcherLease(): void {
  if (!watcherLease) return;
  try {
    const current = readWatcherLease(watcherLease.filePath);
    if (!current || current.token !== watcherLease.meta.token) {
      stopPollingForLeaseLoss('lock file replaced by another owner');
      return;
    }
    watcherLease.meta.updatedAt = Date.now();
    writeFileSync(watcherLease.filePath, JSON.stringify(watcherLease.meta, null, 2));
    watcherLeaseRenewFailures = 0;
    setWatcherStatus(currentBackend, true);
  } catch (err) {
    watcherLeaseRenewFailures += 1;
    setWatcherStatus(currentBackend, false);
    logWarn(
      `Watcher: failed to renew lease heartbeat `
      + `(${watcherLeaseRenewFailures}/${WATCHER_LEASE_MAX_RENEW_FAILURES}): ${err}`,
    );
    logEvent({
      event: 'watcher.heartbeat_failed',
      level: 'warn',
      msg: `Watcher lease heartbeat failed for ${CLAUDE_CODE_TARGET}`,
      context: {
        target: CLAUDE_CODE_TARGET,
        pid: process.pid,
        failures: watcherLeaseRenewFailures,
        maxFailures: WATCHER_LEASE_MAX_RENEW_FAILURES,
        error: String(err),
      },
    });
    if (watcherLeaseRenewFailures >= WATCHER_LEASE_MAX_RENEW_FAILURES) {
      stopPollingForLeaseLoss('lease heartbeat write failures');
    }
  }
}

function tryAcquireWatcherLease(role: string): WatcherLeaseAcquireResult {
  mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  const filePath = watcherLeasePath(CLAUDE_CODE_TARGET);
  const now = Date.now();
  const meta: WatcherLeaseFile = {
    pid: process.pid,
    target: CLAUDE_CODE_TARGET,
    role,
    token: `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: now,
    updatedAt: now,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(filePath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(meta, null, 2));
      } finally {
        closeSync(fd);
      }
      const heartbeat = setInterval(renewWatcherLease, WATCHER_LEASE_HEARTBEAT_MS);
      heartbeat.unref?.();
      watcherLease = { filePath, heartbeat, meta };
      logInfo(`Watcher lease acquired for ${meta.target} (role=${role}, pid=${process.pid})`);
      logEvent({
        event: 'watcher.lease_acquired',
        msg: `Watcher lease acquired for ${meta.target}`,
        context: { target: meta.target, role, pid: process.pid },
      });
      return 'acquired';
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') {
        logError(`Watcher: failed to acquire lease ${filePath}: ${err}`);
        return 'failed';
      }

      const existing = readWatcherLease(filePath);
      if (!existing) {
        try {
          unlinkSync(filePath);
          continue;
        } catch (unlinkErr) {
          logWarn(`Watcher: could not remove malformed lease ${filePath}: ${unlinkErr}`);
          return 'failed';
        }
      }

      if (!watcherLeaseIsStale(filePath, existing)) {
        logWarn(
          `Watcher standby: ${CLAUDE_CODE_TARGET} lease already held by pid=${existing.pid} role=${existing.role}`,
        );
        logEvent({
          event: 'watcher.lease_busy',
          level: 'warn',
          msg: `Watcher lease busy for ${CLAUDE_CODE_TARGET}`,
          context: {
            target: CLAUDE_CODE_TARGET,
            holderPid: existing.pid,
            holderRole: existing.role,
            pid: process.pid,
            role,
          },
        });
        return 'busy';
      }

      try {
        unlinkSync(filePath);
        logWarn(
          `Watcher: removed stale lease for ${CLAUDE_CODE_TARGET} held by pid=${existing.pid} role=${existing.role}`,
        );
        logEvent({
          event: 'watcher.lease_stolen',
          level: 'warn',
          msg: `Removed stale watcher lease for ${CLAUDE_CODE_TARGET}`,
          context: {
            target: CLAUDE_CODE_TARGET,
            stalePid: existing.pid,
            staleRole: existing.role,
            pid: process.pid,
            role,
          },
        });
      } catch (unlinkErr) {
        logWarn(`Watcher: failed to remove stale lease ${filePath}: ${unlinkErr}`);
        return 'failed';
      }
    }
  }

  return 'failed';
}

function clearStandbyRetryTimer(): void {
  if (standbyRetryTimer) {
    clearTimeout(standbyRetryTimer);
    standbyRetryTimer = null;
  }
}

function activateWatcher(callback: MessageCallback): void {
  initKnownFiles();
  startPolling(callback);
}

function scheduleStandbyRetry(callback: MessageCallback, role: string): void {
  savedMessageCallback = callback;
  savedWatcherRole = role;
  if (standbyRetryTimer || pollInterval || watcherLease) return;

  const retry = () => {
    standbyRetryTimer = null;
    if (pollInterval || watcherLease) return;

    const result = tryAcquireWatcherLease(savedWatcherRole);
    if (result === 'acquired') {
      logWarn(`Watcher standby: promoted to active owner for ${CLAUDE_CODE_TARGET}`);
      logEvent({
        event: 'watcher.standby_promoted',
        level: 'warn',
        msg: `Watcher standby promoted for ${CLAUDE_CODE_TARGET}`,
        context: { target: CLAUDE_CODE_TARGET, pid: process.pid, role: savedWatcherRole },
      });
      activateWatcher(callback);
      void replayUndeliveredMessages();
      return;
    }

    if (result === 'failed') {
      logWarn(
        `Watcher standby: lease acquisition failed for ${CLAUDE_CODE_TARGET}; `
        + `will retry in ${WATCHER_STANDBY_RETRY_MS}ms`,
      );
    }

    standbyRetryTimer = setTimeout(retry, WATCHER_STANDBY_RETRY_MS);
    standbyRetryTimer.unref?.();
  };

  logWarn(
    `Watcher standby: will retry ${CLAUDE_CODE_TARGET} lease every `
    + `${WATCHER_STANDBY_RETRY_MS}ms`,
  );
  logEvent({
    event: 'watcher.standby_retry_scheduled',
    level: 'warn',
    msg: `Watcher standby retry scheduled for ${CLAUDE_CODE_TARGET}`,
    context: { target: CLAUDE_CODE_TARGET, pid: process.pid, role },
  });
  standbyRetryTimer = setTimeout(retry, WATCHER_STANDBY_RETRY_MS);
  standbyRetryTimer.unref?.();
}

/**
 * Try to parse a message file and emit a channel notification.
 * Marks the message as delivered to avoid re-emitting on next startup.
 * Errors are logged but never thrown — the watcher must keep running.
 */
function quarantineFailed(fileName: string, reason: string): void {
  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(CLAUDE_CODE_FAILED_DIR)) {
      mkdirSync(CLAUDE_CODE_FAILED_DIR, { recursive: true, mode: 0o700 });
    }
    renameSync(filePath, join(CLAUDE_CODE_FAILED_DIR, fileName));
    knownFiles.delete(fileName);
    invalidateCache();
    logWarn(`Channel: moved ${fileName} to .failed/${CLAUDE_CODE_TARGET}/: ${reason}`);
  } catch (err) {
    logError(`Channel: failed to quarantine ${fileName}: ${err}`);
  }
}

function archiveDeliveredMessage(fileName: string, id: string, reason: string): void {
  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(filePath)) {
      knownFiles.delete(fileName);
      invalidateCache();
      return;
    }
    if (!existsSync(CLAUDE_CODE_ARCHIVE_DIR)) {
      mkdirSync(CLAUDE_CODE_ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    }
    const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${fileName}`;
    renameSync(filePath, join(CLAUDE_CODE_ARCHIVE_DIR, stamped));
    knownFiles.delete(fileName);
    invalidateCache();
    logDebug(`Channel: archived delivered message ${id} (${reason})`);
  } catch (err) {
    // Delivery has already happened (or was already ledgered), so do not
    // retry/duplicate the channel notification just because debug archival
    // failed. Leave the file in place; .delivered prevents re-emission.
    logWarn(`Channel: failed to archive delivered message ${id} (${fileName}): ${err}`);
  }
}

function emitChannelNotification(fileName: string): void {
  if (!savedChannelCallback) return;

  const filePath = join(INBOX_DIR, fileName);
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp || typeof msg.content !== 'string') {
      quarantineFailed(fileName, 'missing required fields: id, timestamp, content');
      return;
    }
    if (!msg.target || !isValidTarget(msg.target)) {
      quarantineFailed(fileName, `missing/invalid target ${JSON.stringify(msg.target ?? null)}`);
      return;
    }
    if (msg.target !== CLAUDE_CODE_TARGET) {
      quarantineFailed(fileName, `target ${JSON.stringify(msg.target)} does not match ${CLAUDE_CODE_TARGET}`);
      return;
    }
    // Skip if already delivered in a previous session, but archive the stale
    // inbox file so `inbox/claude-code/` represents only genuinely pending work.
    if (isDelivered(msg.id)) {
      logDebug(`Channel: skipping already-delivered message ${msg.id}`);
      archiveDeliveredMessage(fileName, msg.id, 'already delivered');
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
    withChannelNotifyTimeout(Promise.resolve(savedChannelCallback(msg)), msg.id)
      .then(() => {
        markDelivered(msg.id);
        archiveDeliveredMessage(fileName, msg.id, 'pushed to channel');
      })
      .catch((err) => {
        knownFiles.delete(fileName);
        invalidateCache();
        logError(`Channel: notification callback failed for ${msg.id}: ${err}; will retry on next poll`);
        // 3.5.5 — explicit notification.push_failed event with a deliberate
        // decision field. Earlier builds only logged `message.push_failed`
        // from index.ts (and rethrew), which left the post-mortem chain
        // ambiguous about WHY the file was left pending. This event makes
        // the contract unambiguous: file stays in inbox/, not markDelivered'd,
        // ready for the next live channel-owner / replay scan.
        const errCode =
          (err as { code?: string } | undefined)?.code
          ?? ((err && typeof err === 'object' && 'name' in err) ? String((err as { name?: string }).name) : undefined);
        logEvent({
          event: 'notification.push_failed',
          level: 'error',
          msg: `Channel notification push failed for ${msg.id}; leaving file pending for next owner`,
          context: {
            msg_id: msg.id,
            from: msg.from,
            to: msg.to,
            target: msg.target,
            reply_to: msg.replyTo,
            error: String(err),
            error_code: errCode,
            decision: 'leave_pending_for_next_owner',
            file_name: fileName,
          },
        });
      });
  } catch (err) {
    quarantineFailed(fileName, `failed to parse/emit notification: ${err}`);
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

// ── Polling implementation ───────────────────────────────────────────────────

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start watching the inbox for new messages.
 * Polling-only (2 s interval).
 *
 * @param callback - Called with file paths when new messages are detected.
 * @param channelCallback - Optional. Called with parsed BridgeMessage for
 *   each new message, used to push channel notifications into Claude.
 */
export async function startWatcher(
  callback: MessageCallback,
  channelCallback?: ChannelNotifyCallback,
  opts?: { role?: string },
): Promise<boolean> {
  savedMessageCallback = callback;
  if (channelCallback) {
    savedChannelCallback = channelCallback;
  }

  // Ensure inbox directory exists
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  }

  const role = opts?.role?.trim() || 'auto';
  savedWatcherRole = role;
  const leaseResult = tryAcquireWatcherLease(role);
  if (leaseResult === 'acquired') {
    clearStandbyRetryTimer();
    activateWatcher(callback);
    return true;
  }

  setWatcherStatus(currentBackend, false);
  if (leaseResult === 'busy') {
    // A healthy process owns delivery right now. Stay connected as a standby
    // channel owner and retry the lease so a future stale owner is recovered
    // without requiring a manual Claude/plugin restart. This mirrors the
    // OpenClaw channel watcher lifecycle while preserving the single-owner
    // delivery invariant. Returning true tells index.ts to keep this
    // channel-capable process alive across benign stdin/SIGTERM events.
    scheduleStandbyRetry(callback, role);
    return true;
  }

  return false;
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
export async function replayUndeliveredMessages(): Promise<void> {
  const channelCallback = savedChannelCallback;
  if (!channelCallback) {
    logWarn('Replay: no channel callback registered, skipping');
    return;
  }
  if (!watcherLease) {
    logInfo('Replay: this process is standby (no watcher lease), skipping');
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
        if (!msg.id || !msg.timestamp || typeof msg.content !== 'string') {
          quarantineFailed(fileName, 'replay missing required fields: id, timestamp, content');
          continue;
        }
        if (!msg.target || !isValidTarget(msg.target) || msg.target !== CLAUDE_CODE_TARGET) {
          quarantineFailed(
            fileName,
            `replay target ${JSON.stringify(msg.target ?? null)} is not ${CLAUDE_CODE_TARGET}`,
          );
          continue;
        }
        if (isDelivered(msg.id)) {
          archiveDeliveredMessage(fileName, msg.id, 'already delivered during replay');
          continue;
        }
        undelivered.push({ fileName, msg });
      } catch (err) {
        quarantineFailed(fileName, `replay failed to parse message: ${err}`);
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
      try {
        await withChannelNotifyTimeout(Promise.resolve(channelCallback(msg)), msg.id);
        markDelivered(msg.id);
        archiveDeliveredMessage(fileName, msg.id, 'replayed to channel');
      } catch (err) {
        knownFiles.delete(fileName);
        invalidateCache();
        logError(`Replay: failed to push ${fileName}: ${err}; will retry on next poll`);
      }
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
  clearStandbyRetryTimer();
  if (pollInterval) {
    logInfo('Stopping polling watcher');
    clearInterval(pollInterval);
    pollInterval = null;
  }
  releaseWatcherLease();
  setWatcherStatus(currentBackend, false);
  logInfo('Watcher stopped');
  logEvent({
    event: 'watcher.stopped',
    msg: 'Watcher stopped',
    context: { backend: currentBackend },
  });
}

/**
 * Get the current watcher backend. Always `'polling'` as of 3.4.3 (the
 * fswatch/inotifywait spawn paths were removed). Kept as a function so
 * callers compile unchanged.
 */
export function getWatcherBackend(): 'polling' {
  return currentBackend;
}
