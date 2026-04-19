/**
 * Message inbox/outbox management for agent-bridge.
 *
 * Production-grade features:
 * - Auto-pruning: old messages, TTL-expired, max inbox size
 * - Deduplication via processed-ID tracking
 * - Efficient cached file list (watcher-driven invalidation)
 * - Malformed JSON → .failed/ quarantine
 * - Chronological ordering by message timestamp
 * - Inbox stats
 */

import { randomUUID } from 'crypto';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  appendFileSync,
} from 'fs';
import { join } from 'path';
import {
  INBOX_DIR,
  OUTBOX_DIR,
  FAILED_DIR,
  PROCESSED_FILE,
  DELIVERED_FILE,
  PROCESSED_FILE_MAX_SIZE,
  PRUNE_MAX_AGE_MS,
  PRUNE_MAX_INBOX_SIZE,
  PRUNE_INTERVAL_MS,
  DEFAULT_TTL_SECONDS,
  OUTBOX_MAX_AGE_MS,
} from './config.js';
import { sshWriteFile } from './ssh.js';
import { logInfo, logWarn, logError, logDebug } from './logger.js';
import { logEvent } from './log.js';
import type { MachineConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BridgeMessage {
  id: string;
  from: string;
  to: string;
  type: 'message' | 'command' | 'response';
  content: string;
  timestamp: string;
  replyTo: string | null;
  /** Time-to-live in seconds. 0 = no expiry. Default: 3600 (1 hour). */
  ttl?: number;
}

export interface InboxStats {
  pendingCount: number;
  oldestMessageAge: number | null; // seconds, or null if empty
  totalSizeBytes: number;
  watcherBackend: 'fswatch' | 'inotifywait' | 'polling' | 'unknown';
  watcherHealthy: boolean;
  processedIdCount: number;
  failedCount: number;
}

// ── Internal state ───────────────────────────────────────────────────────────

/** Cached set of pending file names (populated by watcher, invalidated on change). */
let pendingFiles = new Set<string>();
/** True once the cache has been initially populated. */
let cacheInitialized = false;
/** Dirty flag — set to true when the watcher signals a change. */
let cacheDirty = true;

/** Set of message IDs that have already been consumed (dedup). */
let processedIds = new Set<string>();

/** Set of message IDs that have been delivered via channel notification. */
let deliveredIds = new Set<string>();

/** Periodic prune timer handle. */
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Watcher metadata (set externally by watcher.ts). */
let _watcherBackend: InboxStats['watcherBackend'] = 'unknown';
let _watcherHealthy = false;

// ── Directory helpers ────────────────────────────────────────────────────────

export function ensureInboxDirs(): void {
  for (const dir of [INBOX_DIR, OUTBOX_DIR, FAILED_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

// ── Watcher status (set from watcher.ts) ─────────────────────────────────────

export function setWatcherStatus(
  backend: InboxStats['watcherBackend'],
  healthy: boolean,
): void {
  _watcherBackend = backend;
  _watcherHealthy = healthy;
}

// ── Cache invalidation (called by watcher.ts) ────────────────────────────────

/**
 * Mark the file cache as dirty so the next read re-scans the directory.
 * Called by the watcher when new files are detected.
 */
export function invalidateCache(): void {
  cacheDirty = true;
}

/**
 * Notify the inbox that specific files were added (avoids a full rescan).
 */
export function notifyNewFiles(fileNames: string[]): void {
  for (const f of fileNames) {
    if (f.endsWith('.json')) {
      pendingFiles.add(f);
    }
  }
}

// ── Processed-ID tracking (deduplication) ────────────────────────────────────

function loadProcessedIds(): void {
  processedIds.clear();
  if (!existsSync(PROCESSED_FILE)) return;
  try {
    const raw = readFileSync(PROCESSED_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const id = line.trim();
      if (id) processedIds.add(id);
    }
    logDebug(`Loaded ${processedIds.size} processed message IDs`);
  } catch (err) {
    logWarn(`Failed to load processed IDs: ${err}`);
  }
}

function markProcessed(id: string): void {
  processedIds.add(id);
  try {
    appendFileSync(PROCESSED_FILE, id + '\n');
    rotateProcessedFileIfNeeded();
  } catch (err) {
    logWarn(`Failed to append processed ID ${id}: ${err}`);
  }
}

function rotateProcessedFileIfNeeded(): void {
  try {
    if (!existsSync(PROCESSED_FILE)) return;
    const stat = statSync(PROCESSED_FILE);
    if (stat.size > PROCESSED_FILE_MAX_SIZE) {
      // Keep only the most recent half of IDs
      const ids = Array.from(processedIds);
      const keepCount = Math.floor(ids.length / 2);
      const keep = ids.slice(ids.length - keepCount);
      processedIds = new Set(keep);
      writeFileSync(PROCESSED_FILE, keep.join('\n') + '\n', { mode: 0o600 });
      logInfo(`Rotated .processed file: kept ${keepCount} of ${ids.length} IDs`);
    }
  } catch (err) {
    logWarn(`Failed to rotate processed file: ${err}`);
  }
}

// ── Delivered-ID tracking (channel notification dedup) ──────────────────────

function loadDeliveredIds(): void {
  deliveredIds.clear();
  if (!existsSync(DELIVERED_FILE)) return;
  try {
    const raw = readFileSync(DELIVERED_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const id = line.trim();
      if (id) deliveredIds.add(id);
    }
    logDebug(`Loaded ${deliveredIds.size} delivered message IDs`);
  } catch (err) {
    logWarn(`Failed to load delivered IDs: ${err}`);
  }
}

/**
 * Check if a message ID has already been delivered via channel notification.
 */
export function isDelivered(id: string): boolean {
  return deliveredIds.has(id);
}

/**
 * Mark a message ID as delivered via channel notification.
 */
export function markDelivered(id: string): void {
  deliveredIds.add(id);
  try {
    appendFileSync(DELIVERED_FILE, id + '\n');
    rotateDeliveredFileIfNeeded();
  } catch (err) {
    logWarn(`Failed to append delivered ID ${id}: ${err}`);
  }
}

function rotateDeliveredFileIfNeeded(): void {
  try {
    if (!existsSync(DELIVERED_FILE)) return;
    const stat = statSync(DELIVERED_FILE);
    if (stat.size > PROCESSED_FILE_MAX_SIZE) {
      const ids = Array.from(deliveredIds);
      const keepCount = Math.floor(ids.length / 2);
      const keep = ids.slice(ids.length - keepCount);
      deliveredIds = new Set(keep);
      writeFileSync(DELIVERED_FILE, keep.join('\n') + '\n', { mode: 0o600 });
      logInfo(`Rotated .delivered file: kept ${keepCount} of ${ids.length} IDs`);
    }
  } catch (err) {
    logWarn(`Failed to rotate delivered file: ${err}`);
  }
}

// ── File scanning & caching ──────────────────────────────────────────────────

function refreshCacheIfNeeded(): void {
  if (cacheInitialized && !cacheDirty) return;

  pendingFiles.clear();
  try {
    if (existsSync(INBOX_DIR)) {
      const files = readdirSync(INBOX_DIR).filter(
        f => f.endsWith('.json'),
      );
      for (const f of files) {
        pendingFiles.add(f);
      }
    }
  } catch (err) {
    logError(`Failed to scan inbox directory: ${err}`);
  }
  cacheInitialized = true;
  cacheDirty = false;
}

// ── Message parsing (with quarantine for malformed files) ────────────────────

function parseMessageFile(filePath: string): BridgeMessage | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp) {
      throw new Error('Missing required fields: id, timestamp');
    }
    return msg;
  } catch (err) {
    const fileName = filePath.split('/').pop() ?? filePath;
    logWarn(`Malformed message file ${fileName}, moving to .failed/: ${err}`);
    try {
      const dest = join(FAILED_DIR, fileName);
      renameSync(filePath, dest);
    } catch (moveErr) {
      logError(`Failed to quarantine ${fileName}: ${moveErr}`);
      // Last resort: try to delete
      try {
        unlinkSync(filePath);
      } catch { /* ignore */ }
    }
    return null;
  }
}

// ── TTL / age check ─────────────────────────────────────────────────────────

function isExpired(msg: BridgeMessage, nowMs: number): boolean {
  const ttl = msg.ttl ?? DEFAULT_TTL_SECONDS;
  if (ttl <= 0) return false; // no expiry
  const msgTime = new Date(msg.timestamp).getTime();
  return nowMs - msgTime > ttl * 1000;
}

function isOlderThanMaxAge(msg: BridgeMessage, nowMs: number): boolean {
  const msgTime = new Date(msg.timestamp).getTime();
  return nowMs - msgTime > PRUNE_MAX_AGE_MS;
}

// ── Core read / consume ──────────────────────────────────────────────────────

/**
 * Create a new message object.
 */
export function createMessage(
  from: string,
  to: string,
  type: BridgeMessage['type'],
  content: string,
  replyTo: string | null = null,
  ttl: number = DEFAULT_TTL_SECONDS,
): BridgeMessage {
  return {
    id: `msg-${randomUUID()}`,
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
    replyTo,
    ttl,
  };
}

/**
 * Send a message to a remote machine by writing it to their inbox via SSH.
 * Retries once on failure before throwing.
 */
export async function sendMessage(
  machine: MachineConfig,
  message: BridgeMessage,
): Promise<void> {
  const remotePath = `~/.agent-bridge/inbox/${message.id}.json`;
  const content = JSON.stringify(message, null, 2);

  logInfo(`Sending message ${message.id} to ${machine.name}: ${message.type}`);
  logEvent({
    event: 'message.send_start',
    msg: `Sending message ${message.id} to ${machine.name}`,
    context: {
      msg_id: message.id,
      to: machine.name,
      host: machine.host,
      type: message.type,
      content_length: message.content?.length ?? 0,
      reply_to: message.replyTo ?? undefined,
      ttl: message.ttl,
    },
  });

  let result = await sshWriteFile(machine, remotePath, content);
  if (result.exitCode !== 0) {
    logWarn(`First send attempt to ${machine.name} failed, retrying once...`);
    logEvent({
      event: 'message.send_retry',
      level: 'warn',
      msg: `First send attempt to ${machine.name} failed, retrying`,
      context: { msg_id: message.id, to: machine.name, stderr: result.stderr },
    });
    result = await sshWriteFile(machine, remotePath, content);
    if (result.exitCode !== 0) {
      logError(`Send failed after retry to ${machine.name}: ${result.stderr}`);
      logEvent({
        event: 'message.send_failed',
        level: 'error',
        msg: `Send failed after retry to ${machine.name}`,
        context: {
          msg_id: message.id,
          to: machine.name,
          host: machine.host,
          exit_code: result.exitCode,
          stderr: result.stderr,
        },
      });
      throw new Error(
        `Failed to deliver message to ${machine.name}: ${result.stderr}`,
      );
    }
  }

  // Save a copy in the local outbox for tracking
  try {
    const outboxPath = join(OUTBOX_DIR, `${message.id}.json`);
    writeFileSync(outboxPath, content, { mode: 0o600 });
  } catch (err) {
    // Disk-full or permission issue
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('ENOSPC')) {
      throw new Error(`Disk full: cannot save outbox copy of ${message.id}`);
    }
    logWarn(`Failed to write outbox copy: ${errMsg}`);
  }

  logInfo(`Message ${message.id} delivered to ${machine.name}`);
  logEvent({
    event: 'message.delivered',
    msg: `Message ${message.id} delivered to ${machine.name}`,
    context: { msg_id: message.id, to: machine.name, host: machine.host, type: message.type },
  });
}

/**
 * Read all messages from the local inbox (batch read).
 * Returns messages sorted by timestamp (oldest first).
 * Skips duplicates and expired messages (auto-prunes them).
 */
export function readInbox(): BridgeMessage[] {
  ensureInboxDirs();
  refreshCacheIfNeeded();

  const messages: BridgeMessage[] = [];
  const nowMs = Date.now();
  const filesToRemove: string[] = [];

  // Batch-read all pending files
  const fileNames = Array.from(pendingFiles);
  for (const fileName of fileNames) {
    const filePath = join(INBOX_DIR, fileName);

    // Skip files that no longer exist (race with external consumers)
    if (!existsSync(filePath)) {
      pendingFiles.delete(fileName);
      continue;
    }

    const msg = parseMessageFile(filePath);
    if (!msg) {
      // Malformed — already quarantined by parseMessageFile
      pendingFiles.delete(fileName);
      continue;
    }

    // Dedup: skip already-processed messages
    if (processedIds.has(msg.id)) {
      logDebug(`Skipping duplicate message ${msg.id}`);
      filesToRemove.push(filePath);
      pendingFiles.delete(fileName);
      continue;
    }

    // TTL check
    if (isExpired(msg, nowMs)) {
      logInfo(`Pruning TTL-expired message ${msg.id} (ttl=${msg.ttl ?? DEFAULT_TTL_SECONDS}s)`);
      filesToRemove.push(filePath);
      pendingFiles.delete(fileName);
      continue;
    }

    // Max-age check
    if (isOlderThanMaxAge(msg, nowMs)) {
      logInfo(`Pruning max-age-expired message ${msg.id}`);
      filesToRemove.push(filePath);
      pendingFiles.delete(fileName);
      continue;
    }

    messages.push(msg);
  }

  // Clean up expired/duplicate files
  for (const fp of filesToRemove) {
    try { unlinkSync(fp); } catch { /* ignore */ }
  }

  // Sort by timestamp, oldest first
  messages.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return messages;
}

/**
 * Read and remove all messages from the local inbox (consume them).
 * Marks consumed IDs for deduplication.
 */
export function consumeInbox(): BridgeMessage[] {
  const messages = readInbox();

  for (const msg of messages) {
    const filePath = join(INBOX_DIR, `${msg.id}.json`);
    try {
      unlinkSync(filePath);
      logDebug(`Consumed message ${msg.id}`);
    } catch {
      // Already removed
    }
    pendingFiles.delete(`${msg.id}.json`);
    markProcessed(msg.id);
  }

  return messages;
}

/**
 * Peek at inbox without consuming (for polling/status checks).
 */
export function peekInbox(): { count: number; messages: BridgeMessage[] } {
  const messages = readInbox();
  return { count: messages.length, messages };
}

/**
 * Clear all messages from the inbox.
 */
export function clearInbox(): number {
  ensureInboxDirs();
  let count = 0;
  try {
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        unlinkSync(join(INBOX_DIR, file));
        count++;
      } catch { /* ignore */ }
    }
    pendingFiles.clear();
    cacheDirty = true;
  } catch {
    // Directory might not exist
  }
  logInfo(`Cleared ${count} message(s) from inbox`);
  return count;
}

// ── Pruning ──────────────────────────────────────────────────────────────────

/**
 * Run a single prune pass:
 * 1. Remove TTL-expired messages
 * 2. Remove messages older than PRUNE_MAX_AGE_MS
 * 3. Enforce max inbox size (oldest first)
 */
export function pruneInbox(): number {
  ensureInboxDirs();

  let pruned = 0;
  const nowMs = Date.now();

  let files: string[];
  try {
    files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }

  // Parse all messages to sort by timestamp
  const entries: { fileName: string; msg: BridgeMessage; filePath: string }[] = [];

  for (const fileName of files) {
    const filePath = join(INBOX_DIR, fileName);
    const msg = parseMessageFile(filePath);
    if (!msg) {
      // Already quarantined
      pruned++;
      continue;
    }

    // TTL expiry
    if (isExpired(msg, nowMs)) {
      logInfo(`Prune: TTL-expired ${msg.id}`);
      try { unlinkSync(filePath); } catch { /* ignore */ }
      pendingFiles.delete(fileName);
      pruned++;
      continue;
    }

    // Max-age expiry
    if (isOlderThanMaxAge(msg, nowMs)) {
      logInfo(`Prune: max-age-expired ${msg.id}`);
      try { unlinkSync(filePath); } catch { /* ignore */ }
      pendingFiles.delete(fileName);
      pruned++;
      continue;
    }

    entries.push({ fileName, msg, filePath });
  }

  // Enforce max inbox size: delete oldest first
  if (entries.length > PRUNE_MAX_INBOX_SIZE) {
    entries.sort(
      (a, b) =>
        new Date(a.msg.timestamp).getTime() - new Date(b.msg.timestamp).getTime(),
    );
    const overflow = entries.length - PRUNE_MAX_INBOX_SIZE;
    for (let i = 0; i < overflow; i++) {
      const { fileName, msg, filePath } = entries[i];
      logInfo(`Prune: inbox overflow, removing ${msg.id}`);
      try { unlinkSync(filePath); } catch { /* ignore */ }
      pendingFiles.delete(fileName);
      pruned++;
    }
  }

  if (pruned > 0) {
    cacheDirty = true;
    logInfo(`Prune pass completed: ${pruned} message(s) removed`);
  }

  return pruned;
}

/**
 * Prune outbox: remove sent-message copies older than OUTBOX_MAX_AGE_MS.
 * The outbox is purely a debugging aid — old entries have no operational value.
 */
export function pruneOutbox(): number {
  let pruned = 0;
  const nowMs = Date.now();

  let files: string[];
  try {
    files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }

  for (const fileName of files) {
    const filePath = join(OUTBOX_DIR, fileName);
    try {
      const stat = statSync(filePath);
      if (nowMs - stat.mtimeMs > OUTBOX_MAX_AGE_MS) {
        unlinkSync(filePath);
        pruned++;
      }
    } catch { /* ignore */ }
  }

  if (pruned > 0) {
    logInfo(`Outbox prune: removed ${pruned} old sent-message copy(s)`);
  }

  return pruned;
}

/**
 * Start the periodic prune timer.
 */
export function startPruneTimer(): void {
  if (pruneTimer) return;

  // Run immediately on startup
  logInfo('Running startup prune pass...');
  pruneInbox();
  pruneOutbox();

  pruneTimer = setInterval(() => {
    logDebug('Running periodic prune pass...');
    pruneInbox();
    pruneOutbox();
  }, PRUNE_INTERVAL_MS);

  // Don't block shutdown
  if (pruneTimer.unref) pruneTimer.unref();

  logInfo(`Prune timer started (every ${PRUNE_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the periodic prune timer.
 */
export function stopPruneTimer(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
    logInfo('Prune timer stopped');
  }
}

// ── Inbox stats ──────────────────────────────────────────────────────────────

export function getInboxStats(): InboxStats {
  ensureInboxDirs();

  let pendingCount = 0;
  let oldestAge: number | null = null;
  let totalSize = 0;
  let failedCount = 0;

  const nowMs = Date.now();

  try {
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    pendingCount = files.length;

    for (const f of files) {
      const fp = join(INBOX_DIR, f);
      try {
        const stat = statSync(fp);
        totalSize += stat.size;

        // Read timestamp from file for accurate age
        const raw = readFileSync(fp, 'utf8');
        const msg = JSON.parse(raw) as BridgeMessage;
        if (msg.timestamp) {
          const ageMs = nowMs - new Date(msg.timestamp).getTime();
          const ageSec = Math.floor(ageMs / 1000);
          if (oldestAge === null || ageSec > oldestAge) {
            oldestAge = ageSec;
          }
        }
      } catch {
        // Count it but skip age calculation
      }
    }
  } catch {
    // Inbox dir might not exist
  }

  try {
    if (existsSync(FAILED_DIR)) {
      failedCount = readdirSync(FAILED_DIR).filter(f => f.endsWith('.json')).length;
    }
  } catch { /* ignore */ }

  return {
    pendingCount,
    oldestMessageAge: oldestAge,
    totalSizeBytes: totalSize,
    watcherBackend: _watcherBackend,
    watcherHealthy: _watcherHealthy,
    processedIdCount: processedIds.size,
    failedCount,
  };
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the inbox system: load processed IDs, populate cache, start pruning.
 */
export function initInbox(): void {
  ensureInboxDirs();
  loadProcessedIds();
  loadDeliveredIds();
  refreshCacheIfNeeded();
  startPruneTimer();
  logInfo('Inbox system initialized');
}

/**
 * Clean shutdown of the inbox system.
 */
export function shutdownInbox(): void {
  stopPruneTimer();
  logInfo('Inbox system shut down');
}
