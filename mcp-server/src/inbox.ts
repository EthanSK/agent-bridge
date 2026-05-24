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
  ARCHIVE_DIR,
  UNROUTED_DIR,
  LOCKS_DIR,
  PROCESSED_FILE,
  DELIVERED_FILE,
  PROCESSED_FILE_MAX_SIZE,
  PRUNE_MAX_AGE_MS,
  PRUNE_MAX_INBOX_SIZE,
  PRUNE_INTERVAL_MS,
  DEFAULT_TTL_SECONDS,
  OUTBOX_MAX_AGE_MS,
  CLAUDE_CODE_TARGET,
  MCP_SERVER_VERSION,
  DEFAULT_PERSONA,
  claudeCodeTargetForPersona,
  inboxSubdir,
  archiveSubdir,
  pendingAckSubdir,
  failedSubdir,
  leaseFileNameForTarget,
  isValidTarget,
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
  type: 'message' | 'command' | 'response' | 'reply';
  content: string;
  timestamp: string;
  replyTo: string | null;
  /** Time-to-live in seconds. 0 = no expiry. Default: 86400 (1 day). */
  ttl?: number;
  /**
   * Slash-delimited routing target. Added in mcp-server 3.4.0 to support the
   * per-harness/per-session inbox subdir layout. Examples:
   *   "claude-code/default"
   *   "claude-code/yolo"
   *   "openclaw/default"
   *   "openclaw/clawdiboi2"
   * Legacy "claude-code" is still accepted for rolling upgrades and routed
   * to the receiver's default persona on v4 receivers.
   * Messages arriving without a target are moved to `.failed/_unrouted/` —
   * there is intentionally no default routing.
   */
  target?: string;
  /**
   * Sender's OWN target-ID. Lets the receiver know WHERE to route a reply so
   * round-trip bridge conversations land back in the session that originated
   * the message (e.g. OpenClaw @Clawdiboi2bot ↔ Claude Code, not just
   * one-way injection). Refinement 3 — 2026-04-20.
   *
   * Example: a message sent from Claude Code arrives with
   * `fromTarget: "claude-code/default"` (or another active persona target).
   * When OpenClaw's agent calls `bridge_send_message`, `buildReply` copies
   * `incoming.fromTarget` into `reply.target` so the reply lands back in
   * that Claude Code persona's inbox subdir.
   */
  fromTarget?: string;
  /**
   * Agent Bridge/runtime version of the sender that created this message.
   * Added in 4.5.0 so relay notices can display source and destination
   * versions separately during rolling upgrades. Older peers omit it.
   */
  sourceAgentBridgeVersion?: string;
  /**
   * Optional source-authored user-facing relay summary. When present,
   * receiving harnesses can post the Agent Bridge relay receipt from code
   * without asking the destination agent to synthesize a summary.
   */
  relaySummary?: string;
}

export interface InboxStats {
  /** Pending files in the active Claude Code persona inbox only. */
  pendingCount: number;
  oldestMessageAge: number | null; // seconds, or null if empty
  totalSizeBytes: number;
  watcherBackend: 'fswatch' | 'inotifywait' | 'polling' | 'unknown';
  watcherHealthy: boolean;
  /** Shared on-disk watcher lease metadata, when present. */
  watcherLeasePid: number | null;
  watcherLeaseRole: string | null;
  watcherLeaseAge: number | null; // seconds since heartbeat/mtime, or null
  watcherLeaseAlive: boolean | null;
  watcherLeaseFresh: boolean | null;
  processedIdCount: number;
  failedCount: number;
}

export interface TargetInboxPeekOptions {
  includeArchived?: boolean;
  includePendingAck?: boolean;
  replyTo?: string;
  limit?: number;
}

export interface TargetInboxPeekResult {
  target: string;
  pending: BridgeMessage[];
  pendingAck: BridgeMessage[];
  archived: BridgeMessage[];
  parseErrors: string[];
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

const WATCHER_LEASE_STALE_MS = 15_000;

type SharedWatcherLease = {
  pid: number | null;
  role: string | null;
  ageSeconds: number | null;
  alive: boolean | null;
  fresh: boolean | null;
};

// ── 4.0.0 — Active persona state ─────────────────────────────────────────────

/**
 * 4.0.0 — Active Claude Code persona for THIS mcp-server child. Set once
 * at init time (`setActivePersona`) by `index.ts` after persona resolution.
 * Defaults to `DEFAULT_PERSONA` so unit tests / tools-only hosts that read
 * stats etc. without calling `setActivePersona` still see a coherent
 * persona-scoped layout.
 */
let activePersona: string = DEFAULT_PERSONA;
let activeClaudeCodeTarget: string = claudeCodeTargetForPersona(DEFAULT_PERSONA);
/**
 * 4.0.0 — true once `setActivePersona` has been called. Used by
 * `getActiveClaudeCodeTarget()` to distinguish "we have a real persona
 * binding" from "we are still on the cold default because nobody bound
 * us yet". Tools-only children NEVER call setActivePersona, so they
 * observe `personaIsBound === false` and `getActiveClaudeCodeTarget()`
 * returns null. Path-resolution callers use
 * `getActiveClaudeCodeTargetOrDefault()` which falls back to
 * `claude-code/default` regardless of binding state.
 */
let personaIsBound = false;

/**
 * Set the active Claude Code persona for this MCP child. Called by
 * `index.ts` after persona resolution. Idempotent. Subsequent calls to
 * `getClaudeCodeInboxDir()` / `getClaudeCodeArchiveDir()` /
 * `getClaudeCodeFailedDir()` will resolve to the new persona's subdir.
 */
export function setActivePersona(persona: string): void {
  if (!persona || typeof persona !== 'string') {
    throw new Error(`setActivePersona: invalid persona ${JSON.stringify(persona)}`);
  }
  activePersona = persona;
  activeClaudeCodeTarget = claudeCodeTargetForPersona(persona);
  personaIsBound = true;
}

/** Active persona this MCP child is bound to (for diagnostics). */
export function getActivePersona(): string {
  return activePersona;
}

/**
 * Active persona-scoped Claude Code target string ("claude-code/<persona>"),
 * or `null` when no persona has been bound (tools-only children). Callers
 * that need a non-null fallback (e.g. the inbox/watcher subdir resolvers)
 * should use the dir-scoped helpers — those always have a coherent persona
 * to fall back to. Sender code that wants the "did we bind?" signal calls
 * this helper directly; normal tool reply routing uses
 * `getActiveClaudeCodeTargetOrDefault()` so tools-only/cold-start sends
 * fall back to `claude-code/default`.
 */
export function getActiveClaudeCodeTarget(): string | null {
  return personaIsBound ? activeClaudeCodeTarget : null;
}

/**
 * 4.0.0 — Path-resolution variant: always returns a non-null target so
 * inbox/archive/failed dir helpers can compose paths without null-checks.
 * Falls back to `claude-code/default` when no persona is bound (matches
 * pre-codex-fix behavior of `getActiveClaudeCodeTarget`).
 */
export function getActiveClaudeCodeTargetOrDefault(): string {
  return activeClaudeCodeTarget;
}

/**
 * 4.0.0 — Persona-scoped inbox/archive/failed subdir getters. The watcher
 * and inbox modules call these instead of the deleted const exports
 * because the active persona is set at runtime by `index.ts` after
 * persona resolution. The legacy `inbox/claude-code/<file>.json`
 * (no persona segment) is supported via `getLegacyClaudeCodeInboxDir()`
 * and the one-time migration scan in `migrateLegacyInboxFiles()`.
 */
export function getClaudeCodeInboxDir(): string {
  return inboxSubdir(activeClaudeCodeTarget);
}
export function getClaudeCodeArchiveDir(): string {
  return archiveSubdir(activeClaudeCodeTarget);
}
export function getClaudeCodeFailedDir(): string {
  return failedSubdir(activeClaudeCodeTarget);
}

/**
 * 4.0.0 — The *legacy* `inbox/claude-code/` path (no persona segment).
 * Pre-4.0.0 senders write here; the migration scan moves these files
 * into the active persona's subdir at startup.
 */
export function getLegacyClaudeCodeInboxDir(): string {
  return inboxSubdir(CLAUDE_CODE_TARGET);
}

// ── Directory helpers ────────────────────────────────────────────────────────

export function ensureInboxDirs(): void {
  for (const dir of [
    INBOX_DIR,
    OUTBOX_DIR,
    FAILED_DIR,
    ARCHIVE_DIR,
    UNROUTED_DIR,
    inboxSubdir(CLAUDE_CODE_TARGET), // parent claude-code/ (legacy + persona container)
    getClaudeCodeInboxDir(),
    getClaudeCodeArchiveDir(),
    getClaudeCodeFailedDir(),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * 4.0.0 — One-time migration: any JSON file living directly at
 * `inbox/claude-code/<file>.json` (no persona segment) was written by a
 * pre-4.0.0 sender that addressed `target=claude-code`. The receiver
 * routes those to the `default` persona's subdir on first boot, so the
 * default persona's channel-owner picks them up via its normal poll +
 * channel push. Non-default personas leave legacy files alone — they
 * belong to whoever is bound to `default`.
 *
 * Returns the number of legacy files moved. Logs one
 * `inbox.legacy_migrated` event with a list of file IDs so post-mortem
 * tooling can correlate any "where did this message go?" question
 * against the boot log.
 *
 * Idempotent: subsequent boots find the legacy directory already drained
 * and quickly no-op.
 */
export function migrateLegacyClaudeCodeInboxFiles(): number {
  if (activePersona !== DEFAULT_PERSONA) return 0;
  const legacyDir = getLegacyClaudeCodeInboxDir();
  const targetDir = getClaudeCodeInboxDir();
  // The legacy dir IS the parent of the persona subdir, so be careful
  // to scan only the top-level (don't recurse into persona/, .archive/
  // etc.). `withFileTypes: true` gives us the type without a follow-up
  // stat per entry.
  let moved = 0;
  const movedIds: string[] = [];
  try {
    if (!existsSync(legacyDir)) return 0;
    const entries = readdirSync(legacyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      // Skip hidden / metadata files.
      if (entry.name.startsWith('.')) continue;
      const src = join(legacyDir, entry.name);
      // Best-effort sanity: parse to capture the message id for logging.
      let msgId: string | null = null;
      try {
        const raw = readFileSync(src, 'utf8');
        const msg = JSON.parse(raw) as Partial<BridgeMessage>;
        if (typeof msg.id === 'string') msgId = msg.id;
      } catch { /* best-effort */ }
      if (!existsSync(targetDir)) {
        try { mkdirSync(targetDir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
      }
      const dest = join(targetDir, entry.name);
      try {
        // If a same-named file already exists in the persona subdir, the
        // newer (persona-routed) write wins. Quarantine the legacy
        // duplicate to `.failed/_unrouted/` (with a `.legacy-dup-` prefix
        // so post-mortem tooling can identify it) rather than clobber
        // the persona-subdir write or pollute the live inbox with a
        // `.legacy-*.json` file that the watcher would still pick up
        // and process under a non-canonical filename.
        if (existsSync(dest)) {
          const altDest = join(UNROUTED_DIR, `.legacy-dup-${Date.now()}-${entry.name}`);
          try { mkdirSync(UNROUTED_DIR, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
          renameSync(src, altDest);
          moved += 1;
          if (msgId) movedIds.push(`${msgId}→quarantined:${altDest.split('/').pop()}`);
          continue;
        }
        renameSync(src, dest);
        moved += 1;
        if (msgId) movedIds.push(msgId);
      } catch (err) {
        logError(`migrateLegacyClaudeCodeInboxFiles: failed to move ${entry.name}: ${err}`);
      }
    }
  } catch (err) {
    logWarn(`migrateLegacyClaudeCodeInboxFiles: scan failed: ${err}`);
  }
  if (moved > 0) {
    logInfo(
      `Migrated ${moved} legacy claude-code inbox file(s) to persona "${activePersona}" `
      + `(${movedIds.slice(0, 10).join(', ')}${movedIds.length > 10 ? `, +${movedIds.length - 10} more` : ''})`,
    );
    logEvent({
      event: 'inbox.legacy_migrated',
      level: 'info',
      msg: `Migrated ${moved} legacy claude-code inbox file(s) to persona "${activePersona}"`,
      context: {
        persona: activePersona,
        moved,
        ids: movedIds,
        legacyDir,
        targetDir,
      },
    });
  }
  return moved;
}

/**
 * One-shot migration: any JSON file at the top level of INBOX_DIR is a legacy
 * pre-3.4.0 message with no `target` field. It cannot be routed deterministically
 * — per Ethan's design "no default routing" — so we move it to
 * `.failed/_unrouted/` with a deprecation log line. This runs on every startup
 * so the window stays clean even if an old sender keeps writing flat files.
 */
export function migrateLegacyFlatFiles(): number {
  ensureInboxDirs();
  let moved = 0;
  try {
    if (!existsSync(INBOX_DIR)) return 0;
    const entries = readdirSync(INBOX_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      const src = join(INBOX_DIR, entry.name);
      const dest = join(UNROUTED_DIR, entry.name);
      try {
        renameSync(src, dest);
        moved += 1;
        logWarn(
          `Legacy flat-file inbox message moved to .failed/_unrouted/: ${entry.name}. `
          + `Senders must now set BridgeMessage.target (e.g. "claude-code/default", "openclaw/clawdiboi2").`,
        );
      } catch (err) {
        logError(`Failed to migrate legacy inbox file ${entry.name}: ${err}`);
      }
    }
  } catch (err) {
    logWarn(`Legacy-file migration scan failed: ${err}`);
  }
  return moved;
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
    if (existsSync(getClaudeCodeInboxDir())) {
      const files = readdirSync(getClaudeCodeInboxDir()).filter(
        f => f.endsWith('.json'),
      );
      for (const f of files) {
        pendingFiles.add(f);
      }
    }
  } catch (err) {
    logError(`Failed to scan claude-code inbox subdir: ${err}`);
  }
  cacheInitialized = true;
  cacheDirty = false;
}

// ── Message parsing (with quarantine for malformed files) ────────────────────

/**
 * 4.0.0 — Persona-scoped target check. A message file living in
 * `inbox/claude-code/<persona>/` is considered well-targeted when its
 * `target` field is EITHER:
 *   - the legacy `claude-code` literal (pre-4.0.0 senders, routed here
 *     by the migration scan or the sender-side normalization), OR
 *   - the active persona-scoped target (`claude-code/<activePersona>`).
 *
 * Anything else is malformed for this persona — it'll be quarantined
 * to `.failed/claude-code/<persona>/` so the post-mortem chain stays
 * intact.
 */
function isTargetForActivePersona(target: string): boolean {
  if (target === CLAUDE_CODE_TARGET) return true;
  if (target === activeClaudeCodeTarget) return true;
  return false;
}

function parseMessageFile(filePath: string): BridgeMessage | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp) {
      throw new Error('Missing required fields: id, timestamp');
    }
    if (!msg.target || !isValidTarget(msg.target)) {
      throw new Error(`Missing/invalid target: ${JSON.stringify(msg.target ?? null)}`);
    }
    if (!isTargetForActivePersona(msg.target)) {
      throw new Error(
        `Message target ${JSON.stringify(msg.target)} does not match `
        + `${JSON.stringify(activeClaudeCodeTarget)} (or legacy ${JSON.stringify(CLAUDE_CODE_TARGET)})`,
      );
    }
    return msg;
  } catch (err) {
    const fileName = filePath.split('/').pop() ?? filePath;
    logWarn(`Malformed claude-code inbox file ${fileName}, moving to .failed/${activeClaudeCodeTarget}/: ${err}`);
    try {
      if (!existsSync(getClaudeCodeFailedDir())) mkdirSync(getClaudeCodeFailedDir(), { recursive: true, mode: 0o700 });
      const dest = join(getClaudeCodeFailedDir(), fileName);
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

function targetMatchesExpected(messageTarget: string, expectedTarget: string): boolean {
  if (messageTarget === expectedTarget) return true;
  // Rolling-upgrade compatibility: pre-4.0.0 Claude senders may still put the
  // legacy target literal in files that physically live under
  // inbox/claude-code/default/.
  if (expectedTarget === claudeCodeTargetForPersona(DEFAULT_PERSONA) && messageTarget === CLAUDE_CODE_TARGET) {
    return true;
  }
  return false;
}

function parseMessageFileForTarget(
  filePath: string,
  expectedTarget: string,
): { message: BridgeMessage | null; error?: string } {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const msg = JSON.parse(raw) as BridgeMessage;
    if (!msg.id || !msg.timestamp) {
      throw new Error('Missing required fields: id, timestamp');
    }
    if (!msg.target || !isValidTarget(msg.target)) {
      throw new Error(`Missing/invalid target: ${JSON.stringify(msg.target ?? null)}`);
    }
    if (!targetMatchesExpected(msg.target, expectedTarget)) {
      throw new Error(
        `Message target ${JSON.stringify(msg.target)} does not match ${JSON.stringify(expectedTarget)}`,
      );
    }
    return { message: msg };
  } catch (err) {
    const fileName = filePath.split('/').pop() ?? filePath;
    const errMsg = err instanceof Error ? err.message : String(err);
    return { message: null, error: `${fileName}: ${errMsg}` };
  }
}

function readTargetDir(
  dir: string,
  target: string,
  opts: { replyTo?: string; parseErrors: string[] },
): BridgeMessage[] {
  if (!existsSync(dir)) return [];
  const messages: BridgeMessage[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    opts.parseErrors.push(`${dir}: ${errMsg}`);
    return [];
  }

  for (const file of files) {
    const { message, error } = parseMessageFileForTarget(join(dir, file), target);
    if (!message) {
      if (error) opts.parseErrors.push(error);
      continue;
    }
    if (opts.replyTo && message.replyTo !== opts.replyTo) continue;
    messages.push(message);
  }

  messages.sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  return messages;
}

function countJsonFilesRecursive(dir: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countJsonFilesRecursive(child);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        count += 1;
      }
    }
  } catch {
    // Ignore unreadable dirs in stats.
  }
  return count;
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
  target?: string,
  fromTarget?: string,
  sourceAgentBridgeVersion: string = MCP_SERVER_VERSION,
  relaySummary?: string,
): BridgeMessage {
  const msg: BridgeMessage = {
    id: `msg-${randomUUID()}`,
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
    replyTo,
    ttl,
  };
  if (target) msg.target = target;
  if (fromTarget) msg.fromTarget = fromTarget;
  if (sourceAgentBridgeVersion) msg.sourceAgentBridgeVersion = sourceAgentBridgeVersion;
  const cleanedRelaySummary = cleanRelaySummary(relaySummary);
  if (cleanedRelaySummary) msg.relaySummary = cleanedRelaySummary;
  return msg;
}

function cleanRelaySummary(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Deliver a message to the LOCAL machine — no SSH.
 *
 * Same-machine delivery (3.5.0+) writes directly to
 * `~/.agent-bridge/inbox/<target>/<id>.json` using the same atomic write
 * pattern as the SSH path (write to a hidden temp file, fsync, rename) so
 * the local file watcher never sees a half-written JSON file.
 *
 * Use this when `machine` resolves to the local host (matches
 * `getLocalMachineName()` or one of `LOCAL_MACHINE_ALIASES`). Cross-machine
 * sends still go through `sendMessage` over SSH.
 */
export function sendLocalMessage(message: BridgeMessage): void {
  if (!message.target || !isValidTarget(message.target)) {
    throw new Error(
      `BridgeMessage.target is required for local delivery (e.g. "claude-code/default", "openclaw/clawdiboi2"). `
      + `Got: ${JSON.stringify(message.target ?? null)}`,
    );
  }

  ensureInboxDirs();

  // 4.0.0 — rolling-upgrade compatibility: when the caller addresses the
  // legacy `claude-code` literal (no persona segment), DO NOT rewrite the
  // wire `target` or the on-disk path. The rolling-upgrade case applies
  // locally too: a v4 tools-only sibling MCP child can coexist with a
  // still-running v3 channel-owner on the same host because tools-only
  // siblings do NOT participate in the channel-owner lease (no eviction).
  // A pre-4.0 receiver only watches `inbox/claude-code/*.json` (flat) and
  // only accepts `target === "claude-code"`; rewriting either field would
  // silently drop the message until the v3 channel-owner is replaced.
  // 4.0+ receivers handle the legacy form natively:
  // `migrateLegacyClaudeCodeInboxFiles` runs on init AND periodically via
  // the watcher tick, and `isTargetForActivePersona` accepts
  // `target === "claude-code"` directly.

  const targetDir = inboxSubdir(message.target);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  const finalPath = join(targetDir, `${message.id}.json`);
  // Atomic write: temp file in the same directory, then rename. This matches
  // sshWriteFile() so the inbox watcher sees a fully-formed JSON file appear
  // in a single rename event — never a partial write.
  const tmpPath = join(targetDir, `.agent-bridge-${randomUUID()}.tmp`);
  const content = JSON.stringify(message, null, 2);

  logInfo(`Sending message ${message.id} locally to target=${message.target}`);
  logEvent({
    event: 'message.local_send_start',
    msg: `Sending message ${message.id} locally to ${message.to}`,
    context: {
      msg_id: message.id,
      to: message.to,
      target: message.target,
      type: message.type,
      content_length: message.content?.length ?? 0,
      reply_to: message.replyTo ?? undefined,
      ttl: message.ttl,
      transport: 'local',
    },
  });

  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the orphan temp file
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Local send failed for ${message.id}: ${errMsg}`);
    logEvent({
      event: 'message.local_send_failed',
      level: 'error',
      msg: `Local send failed for ${message.id}`,
      context: { msg_id: message.id, target: message.target, error: errMsg },
    });
    throw new Error(`Failed to deliver message locally: ${errMsg}`);
  }

  // Save a copy in the local outbox for tracking, mirroring the SSH path.
  try {
    const outboxPath = join(OUTBOX_DIR, `${message.id}.json`);
    writeFileSync(outboxPath, content, { mode: 0o600 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('ENOSPC')) {
      throw new Error(`Disk full: cannot save outbox copy of ${message.id}`);
    }
    logWarn(`Failed to write outbox copy: ${errMsg}`);
  }

  logInfo(`Message ${message.id} delivered locally (target=${message.target})`);
  logEvent({
    event: 'message.delivered',
    msg: `Message ${message.id} delivered locally`,
    context: {
      msg_id: message.id,
      to: message.to,
      target: message.target,
      type: message.type,
      transport: 'local',
    },
  });
}

/**
 * Send a message to a remote machine by writing it to their inbox via SSH.
 * Retries once on failure before throwing.
 *
 * As of mcp-server 3.4.0 the message is written to a per-target subdir of
 * the remote inbox (`inbox/<target>/<id>.json`) so independent listeners
 * (Claude Code channel plugin, openclaw-channel plugin, future harnesses)
 * can watch their own branch without racing for messages that aren't
 * addressed to them. The caller must set `message.target`; messages without
 * one are rejected by `bridge_send_message`.
 */
export async function sendMessage(
  machine: MachineConfig,
  message: BridgeMessage,
): Promise<void> {
  if (!message.target || !isValidTarget(message.target)) {
    throw new Error(
      `BridgeMessage.target is required (e.g. "claude-code/default", "openclaw/clawdiboi2"). `
      + `Got: ${JSON.stringify(message.target ?? null)}`,
    );
  }
  // 4.0.0 — rolling-upgrade compatibility: when the caller addresses the
  // legacy `claude-code` literal (no persona segment), DO NOT rewrite the
  // wire `target` or the on-disk path. A pre-4.0 receiver only watches
  // `inbox/claude-code/*.json` (flat) and only accepts
  // `target === "claude-code"`; rewriting either to `claude-code/default`
  // would silently drop the message on still-3.x peers. A 4.0+ receiver
  // handles the legacy form natively: `migrateLegacyClaudeCodeInboxFiles`
  // (called on init AND periodically by the watcher tick) drains the
  // flat path into `inbox/claude-code/default/`, and
  // `isTargetForActivePersona` accepts `target === "claude-code"` directly.
  // Local sends (`sendLocalMessage`) keep rewriting because both sides
  // are guaranteed same-version on the same machine.
  const remotePath = `~/.agent-bridge/inbox/${message.target}/${message.id}.json`;
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
      target: message.target,
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
 * Read all messages from the local claude-code inbox (batch read).
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
    const filePath = join(getClaudeCodeInboxDir(), fileName);

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
    const filePath = join(getClaudeCodeInboxDir(), `${msg.id}.json`);
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
 * Non-destructive inspection for any target inbox subdir.
 *
 * This is intentionally separate from readInbox()/consumeInbox(), which are
 * scoped to the active Claude Code persona and own that inbox lifecycle. The
 * target peek path is for diagnostics and cross-harness routing checks: it
 * never consumes, archives, quarantines, or mutates another harness's files.
 */
export function peekInboxForTarget(
  target: string,
  opts: TargetInboxPeekOptions = {},
): TargetInboxPeekResult {
  const parseErrors: string[] = [];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50), 500));
  const readOpts = { replyTo: opts.replyTo, parseErrors };

  const pending = readTargetDir(inboxSubdir(target), target, readOpts);
  const pendingAck = opts.includePendingAck
    ? readTargetDir(pendingAckSubdir(target), target, readOpts)
    : [];
  const archived = opts.includeArchived
    ? readTargetDir(archiveSubdir(target), target, readOpts)
    : [];

  const trimNewest = (messages: BridgeMessage[]) => messages.slice(Math.max(0, messages.length - limit));
  return {
    target,
    pending: trimNewest(pending),
    pendingAck: trimNewest(pendingAck),
    archived: trimNewest(archived),
    parseErrors: parseErrors.slice(0, 25),
  };
}

/**
 * Clear all messages from the claude-code inbox.
 */
export function clearInbox(): number {
  ensureInboxDirs();
  let count = 0;
  try {
    const files = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        unlinkSync(join(getClaudeCodeInboxDir(), file));
        count++;
      } catch { /* ignore */ }
    }
    pendingFiles.clear();
    cacheDirty = true;
  } catch {
    // Directory might not exist
  }
  logInfo(`Cleared ${count} message(s) from claude-code inbox`);
  return count;
}

// ── Pruning ──────────────────────────────────────────────────────────────────

/**
 * Run a single prune pass for the claude-code inbox:
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
    files = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }

  // Parse all messages to sort by timestamp
  const entries: { fileName: string; msg: BridgeMessage; filePath: string }[] = [];

  for (const fileName of files) {
    const filePath = join(getClaudeCodeInboxDir(), fileName);
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

function watcherLeasePathForTarget(target: string): string {
  return join(LOCKS_DIR, leaseFileNameForTarget(target));
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

function readSharedWatcherLease(): SharedWatcherLease {
  const empty: SharedWatcherLease = {
    pid: null,
    role: null,
    ageSeconds: null,
    alive: null,
    fresh: null,
  };

  const filePath = watcherLeasePathForTarget(activeClaudeCodeTarget);
  if (!existsSync(filePath)) return empty;

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      target?: unknown;
      role?: unknown;
      updatedAt?: unknown;
    };
    const pid = Number(parsed.pid);
    const role = typeof parsed.role === 'string' ? parsed.role : null;
    if (!Number.isInteger(pid) || pid <= 0 || parsed.target !== activeClaudeCodeTarget) {
      return { ...empty, role };
    }

    const stat = statSync(filePath);
    const updatedAt = Number(parsed.updatedAt);
    const lastUpdated = Math.max(
      Number.isFinite(updatedAt) ? updatedAt : 0,
      stat.mtimeMs,
    );
    const ageMs = Math.max(0, Date.now() - lastUpdated);
    const alive = pidIsAlive(pid);
    const fresh = alive && ageMs <= WATCHER_LEASE_STALE_MS;

    return {
      pid,
      role,
      ageSeconds: Math.floor(ageMs / 1000),
      alive,
      fresh,
    };
  } catch {
    return empty;
  }
}

export function getInboxStats(): InboxStats {
  ensureInboxDirs();

  let pendingCount = 0;
  let oldestAge: number | null = null;
  let totalSize = 0;
  let failedCount = 0;

  const nowMs = Date.now();

  try {
    const files = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
    pendingCount = files.length;

    for (const f of files) {
      const fp = join(getClaudeCodeInboxDir(), f);
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
      failedCount = countJsonFilesRecursive(FAILED_DIR);
    }
  } catch { /* ignore */ }

  const sharedLease = readSharedWatcherLease();
  const sharedWatcherHealthy = sharedLease.fresh === true;

  return {
    pendingCount,
    oldestMessageAge: oldestAge,
    totalSizeBytes: totalSize,
    watcherBackend: _watcherBackend !== 'unknown'
      ? _watcherBackend
      : (sharedWatcherHealthy ? 'polling' : 'unknown'),
    watcherHealthy: _watcherHealthy || sharedWatcherHealthy,
    watcherLeasePid: sharedLease.pid,
    watcherLeaseRole: sharedLease.role,
    watcherLeaseAge: sharedLease.ageSeconds,
    watcherLeaseAlive: sharedLease.alive,
    watcherLeaseFresh: sharedLease.fresh,
    processedIdCount: processedIds.size,
    failedCount,
  };
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the inbox system: load processed IDs, populate cache, start pruning.
 *
 * 4.0.0 — `opts.isChannelOwner` gates persona-coupled side effects so
 * tools-only children (no inbox lease) do NOT mutate default-persona
 * delivery state. Specifically: the legacy
 * `inbox/claude-code/*.json` → `inbox/claude-code/default/` migration is
 * skipped when the caller is tools-only — only the default-persona
 * channel-owner ever drains the legacy dir, preventing a race where two
 * tools-only siblings + the legitimate default-persona owner all race
 * the migration.
 */
export function initInbox(opts: { isChannelOwner?: boolean } = {}): void {
  ensureInboxDirs();
  const migrated = migrateLegacyFlatFiles();
  if (migrated > 0) {
    logWarn(
      `Migrated ${migrated} legacy flat-file message(s) from ${INBOX_DIR} to `
      + `${UNROUTED_DIR}. Senders must set BridgeMessage.target.`,
    );
  }
  // 4.0.0 — drain legacy `inbox/claude-code/<file>.json` (no persona
  // segment) into the active persona's subdir. Only the default-persona
  // channel-owner adopts these; tools-only children and non-default
  // personas leave them alone so the channel-owner is the single
  // authoritative drainer.
  if (opts.isChannelOwner) {
    migrateLegacyClaudeCodeInboxFiles();
  }
  loadProcessedIds();
  loadDeliveredIds();
  refreshCacheIfNeeded();
  startPruneTimer();
  logInfo(`Inbox system initialized (persona="${activePersona}", target="${activeClaudeCodeTarget}")`);
}

/**
 * Clean shutdown of the inbox system.
 */
export function shutdownInbox(): void {
  stopPruneTimer();
  logInfo('Inbox system shut down');
}
