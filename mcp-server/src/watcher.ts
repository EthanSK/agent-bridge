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
  EXHAUSTED_DIR,
  LOCKS_DIR,
  MCP_SERVER_VERSION,
  inboxSubdir,
  archiveSubdir,
  failedSubdir,
  pendingAckSubdir,
  isValidTarget,
  leaseFileNameForTarget,
} from './config.js';

/**
 * 4.0.0 — Persona-scoped subdir getters. Watcher resolves these every
 * read because `index.ts` calls `setActivePersona()` AFTER this module
 * is imported but BEFORE any inbox path is touched. Pre-4.0.0 the
 * watcher captured the dir paths once at module load; that broke the
 * persona model (every persona's watcher would look at the SAME
 * `inbox/claude-code/` dir).
 */
import {
  invalidateCache,
  notifyNewFiles,
  setWatcherStatus,
  isDelivered,
  markDelivered,
  getActiveClaudeCodeTargetOrDefault,
  getActivePersona,
  getClaudeCodeInboxDir,
  getClaudeCodeArchiveDir,
  getClaudeCodeFailedDir,
  migrateLegacyClaudeCodeInboxFiles,
} from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { logInfo, logError, logDebug, logWarn } from './logger.js';
import { logEvent } from './log.js';

/** Pending-ack staging area for the active persona. */
function getClaudeCodePendingAckDir(): string {
  return pendingAckSubdir(getActiveClaudeCodeTargetOrDefault());
}

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
  /**
   * 3.7.1 — semver string of the agent-bridge MCP server build that wrote the
   * lease (e.g. "3.7.1"). Optional for backward compatibility: leases written
   * by 3.7.0 and earlier do not include this field, and Patch F's stale-version
   * peer-kill treats absent/unparseable versions as "same-version" (safe
   * default — no kill).
   */
  version?: string;
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

/**
 * 3.11.0 [AUTO-UPDATE-RE-PROBE 2026-04-30] — Promotion listeners.
 *
 * Fires when a standby watcher successfully steals the lease from a dead
 * peer (`scheduleStandbyRetry` → `tryAcquireWatcherLease === 'acquired'`).
 * Used by index.ts to (re)arm the auto-update probe + 3h interval the
 * moment this child becomes channel-owner — without that hook, a process
 * that booted as standby and only later took over the lease would never
 * run the probe at all.
 */
type PromotionListener = () => void;
const promotionListeners = new Set<PromotionListener>();

/**
 * Register a callback to fire when this process is promoted from standby
 * to channel-owner (i.e. it acquires the watcher lease after originally
 * starting in standby). Returns an unsubscribe function. The callback is
 * called synchronously inside the standby retry loop; it MUST be cheap
 * and must not throw.
 */
export function subscribeToPromotion(listener: PromotionListener): () => void {
  promotionListeners.add(listener);
  return () => { promotionListeners.delete(listener); };
}

function firePromotionListeners(): void {
  for (const listener of promotionListeners) {
    try {
      listener();
    } catch (err) {
      try {
        logWarn(`promotion listener threw: ${err}`);
      } catch { /* best-effort */ }
    }
  }
}

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

// ── 3.8.0 — In-process inbox-arrival subscriber registry ────────────────────
//
// `bridge_receive_messages` (with `wait: true`) registers a one-shot listener
// here so it can long-poll inside the MCP tool handler without burning tokens
// on a busy re-poll loop. The listener resolves when:
//   1. A new inbox file arrives (detected by `checkForNewFiles`), OR
//   2. A channel notification is emitted (also indicates inbox arrival,
//      covered by `emitChannelNotification` which is invoked inside
//      `checkForNewFiles`), OR
//   3. The caller's timeout fires (caller side — not this module's concern).
//
// Semantics: BROADCAST. Every subscriber gets fired on every arrival, so
// multiple concurrent long-pollers (e.g. parent session + N subagents) all
// wake up. The `bridge_receive_messages` tool is supposed to be idempotent —
// it returns inbox content as a snapshot. Whether the file moves to
// .archive/ or stays in inbox/ is governed by the existing `peek` flag, NOT
// by which subscriber woke first.
//
// Why broadcast and not queue: forcing one-subscriber-per-arrival semantics
// would mean the second long-poller never sees the message even though it
// is sitting in the inbox. That breaks the existing "snapshot of pending"
// contract. Broadcast keeps `bridge_receive_messages` semantically the
// same regardless of how many concurrent callers are waiting.
type InboxArrivalListener = () => void;
const inboxArrivalListeners = new Set<InboxArrivalListener>();

/**
 * Register a one-shot listener that fires on the next inbox arrival.
 * Returns an `unsubscribe` function the caller MUST invoke on timeout
 * (otherwise the registry leaks). Calling the listener itself does NOT
 * auto-unsubscribe — the registry owns lifecycle, not the listener.
 *
 * Exported for `tools.ts::bridge_receive_messages` long-poll handler.
 */
export function subscribeToInboxArrival(listener: InboxArrivalListener): () => void {
  inboxArrivalListeners.add(listener);
  return () => {
    inboxArrivalListeners.delete(listener);
  };
}

/**
 * Fire all currently-registered inbox-arrival listeners. Listeners are
 * removed AFTER firing (one-shot semantics), but errors are isolated so a
 * misbehaving listener can't take out the whole registry. We snapshot the
 * set first so a listener that re-subscribes during its own callback (rare,
 * but legal) doesn't get fired twice in the same tick.
 *
 * Called from `checkForNewFiles` whenever the polling pass discovers at
 * least one new file.
 */
function fireInboxArrivalListeners(): void {
  if (inboxArrivalListeners.size === 0) return;
  const snapshot = Array.from(inboxArrivalListeners);
  inboxArrivalListeners.clear();
  for (const fn of snapshot) {
    try {
      fn();
    } catch (err) {
      logWarn(`Watcher: inbox-arrival listener threw: ${err}`);
    }
  }
}

/**
 * Test/diagnostic helper: returns the count of currently-registered
 * inbox-arrival listeners. Not part of the public MCP surface.
 */
export function inboxArrivalListenerCount(): number {
  return inboxArrivalListeners.size;
}

// ── 3.9.0 [CONSUME-RACE] — Pending-ack delivery (Hybrid AC) ─────────────────
//
// Pre-3.9 (`b08160c` and earlier) the watcher called markDelivered + archive
// the moment savedChannelCallback's promise resolved. The promise resolves
// when the JSON-RPC notification has been written to the MCP server's stdout
// — but stdout-write success is NOT proof that the receiving Claude harness
// rendered the message into its conversation context. The Windows side
// reproduced 6 silent drops in one session: the plugin happily moved each
// message to .archive/, the .delivered ledger grew, but the running Claude
// session never saw any of them.
//
// Hybrid AC: every push goes through a pending-ack staging area:
//
//   1. Push   — savedChannelCallback resolves → file moves to
//               `.pending-ack/<target>/<id>.json` + sidecar `<id>.meta.json`
//               with pushedAt timestamp, listeners count, tool-call count.
//   2. Tick   — every poll cycle (~2 s), `processPendingDeliveries` decides:
//      - Early-defer (5 s + alive-evidence + still own lease): finalize
//        (archive + markDelivered, drop entry).
//      - Safety-net (60 s + no alive-evidence): re-inject back into
//        inbox/<target>/, increment retries (cap 3 → .failed/.exhausted/).
//   3. Handover — files left in `.pending-ack/` after a lease loss are
//      recovered by `replayUndeliveredMessages` on the new owner: anything
//      older than 30 s gets re-injected.
//   4. Escape-hatch — if the channel itself looks dead (5+ pushes in 30 s
//      with no tool calls and no long-poll listeners), mark dead and
//      bypass the callback for new files (they still queue to .pending-ack/
//      so a future plugin reload picks them up). Emits fatal-level log.

type PendingEntry = {
  id: string;
  fileName: string;          // basename, e.g. "msg-abcd.json"
  pendingPath: string;       // .pending-ack/<target>/<id>.json
  metaPath: string;          // .pending-ack/<target>/<id>.meta.json
  pushedAt: number;
  retries: number;
  target: string;
  listenersAtPushTime: number;
  toolCallsAtPushTime: number;
  successfulPushesAtStageTime: number;
  hadError: boolean;
  /**
   * 3.9.0 [CONSUME-RACE] — set TRUE when the entry was staged during the
   * escape-hatch (channel marked dead). The hybrid AC tick must NOT
   * finalize OR re-inject these — they sit until a plugin reload triggers
   * handover-replay, which moves them back to inbox/ for a fresh channel.
   */
  escapeHatch: boolean;
};

const pendingDeliveries = new Map<string, PendingEntry>();

/**
 * 3.9.1 [CONSUME-RACE] — Persist re-inject retry counts ACROSS the
 * stage→reinject→re-stage cycle.
 *
 * Bug in 3.9.0: when `reinjectPending` moves a file back to inbox/, it
 * calls `pendingDeliveries.delete(entry.id)`. The watcher's next poll
 * sees the file as "new" and `emitChannelNotification` calls
 * `stagePendingAck(fileName, msg.id, 0)` — passing the literal `0` for
 * retries. The fresh entry forgets it has already been re-injected. Each
 * 60s tick computes `newRetries = 0 + 1 = 1`, never exceeds the cap of 3,
 * and the message ping-pongs forever between inbox/ and .pending-ack/.
 *
 * Fix: keep a separate map keyed by msg id whose value persists across
 * the delete()→stagePendingAck() boundary. `stagePendingAck` consults
 * this map first when a re-stage of the same id occurs; `finalizePending`
 * and the exhausted-path branch of `reinjectPending` GC the entry.
 *
 * Process restart resets this map, but that's fine — restart implies
 * the watcher has new state and the safety-net replay window resets too.
 * Bounded by handover replay regardless.
 */
const retriesByMsgId = new Map<string, number>();

/**
 * 3.10.1 [CONSUME-RACE] — Count channel notifications whose callback
 * resolved successfully. A later successful push is useful alive-evidence for
 * older pending entries even when Claude replies without invoking any
 * agent-bridge tool: it proves the MCP notification pipe continued accepting
 * channel traffic after the older push was staged.
 */
let successfulChannelPushCount = 0;

/** 3.9.0 [CONSUME-RACE] — windows for the hybrid AC tick.
 *
 * 3.12.1 [DEDUP-RECEIVE-INJECT 2026-04-30] — bumped the safety-net window
 * 60 s → 180 s and lowered the retry cap 3 → 1.
 *
 * Why: the receiver-side code re-emits a `<channel>` notification on every
 * reinject. With 60 s + 3 retries the same message could be pushed up to
 * 4 times to the running Claude session over 4 minutes. In practice this
 * fired whenever the receiver was in a long-thinking state and made no
 * tool calls within 60 s — a normal pattern for reasoning-heavy tasks.
 *
 * Evidence (Mini agent-bridge.log 2026-04-30 12:26–12:29 UTC):
 *   msg-0196018e was channel-pushed 4 times (initial + 3 reinjects),
 *   tool_calls_at_push stayed at 11 across ALL pushes — the harness was
 *   alive but not invoking tools, so the alive-heuristic returned false.
 *   That's the duplicate Ethan sees in the running session.
 *
 * Trade-off: a genuinely-dead receiver now wastes 3 minutes before the
 * single reinject fires (vs 60 s). That's acceptable — the dead-channel
 * escape-hatch + handover-on-restart paths still recover lost messages.
 * What we trade off is one duplicate worst-case (vs three) for slow-
 * thinking receivers, which is the dominant pattern. */
const PENDING_EARLY_DEFER_MS = 5_000;
const PENDING_REINJECT_MS = 180_000;
const PENDING_REINJECT_MAX_RETRIES = 1;
const PENDING_HANDOVER_REINJECT_MS = 30_000;

/**
 * Escape-hatch state. If 5+ pushes happen within ESCAPE_HATCH_WINDOW_MS with
 * no tool calls and no long-poll listeners, the channel is declared dead and
 * subsequent emits skip the callback (file still moves into pending-ack/ so
 * the next live plugin can replay it).
 */
const ESCAPE_HATCH_WINDOW_MS = 30_000;
const ESCAPE_HATCH_PUSH_THRESHOLD = 5;
const recentPushes: number[] = [];        // pushedAt timestamps within window
let channelMarkedDead = false;
let channelMarkedDeadAt = 0;

// ── Alive-heuristic plumbing ────────────────────────────────────────────────
//
// The alive-heuristic is the gate for the safety-net re-injection path.
// It returns TRUE if there is positive evidence the receiving Claude harness
// is still alive since the message was pushed:
//   (a) any tool call has been received since pushedAt;
//   (b) at least one long-poll listener is currently registered (the
//       harness is parked inside `bridge_receive_messages` waiting for us);
//   (c) the channel callback itself was registered AFTER pushedAt
//       (a plugin reload happened — likely the harness is restarting and
//       will pick up replays).
//   (d) a later channel notification callback resolved successfully after
//       this entry was staged (the JSON-RPC channel is still moving traffic,
//       even if Claude's reply does not call any agent-bridge tool).
//
// `index.ts` owns `toolCallsReceivedCount` and the channel-callback
// registration timestamp. It pushes them in via the setter below.
type AliveSignals = {
  getToolCallsReceivedCount: () => number;
  getChannelCallbackRegisteredAt: () => number;
};

let aliveSignals: AliveSignals = {
  getToolCallsReceivedCount: () => 0,
  getChannelCallbackRegisteredAt: () => 0,
};

/**
 * 3.9.0 [CONSUME-RACE] — register accessors for alive-heuristic signals.
 * Called by `index.ts::main()` after it sets up the toolCallsReceivedCount
 * counter and channel-callback registration timestamp.
 */
export function registerAliveSignals(signals: AliveSignals): void {
  aliveSignals = signals;
}

function isHarnessAliveSincePush(pending: PendingEntry): boolean {
  // (a) any new tool call since push?
  const tc = aliveSignals.getToolCallsReceivedCount();
  if (tc > pending.toolCallsAtPushTime) return true;
  // (b) any active long-poll listeners currently waiting?
  if (inboxArrivalListenerCount() > 0) return true;
  // (c) channel-callback freshness: was it registered AFTER pushedAt?
  const regAt = aliveSignals.getChannelCallbackRegisteredAt();
  if (regAt > pending.pushedAt) return true;
  // (d) has any later channel notification resolved successfully?
  if (successfulChannelPushCount > pending.successfulPushesAtStageTime) return true;
  return false;
}

function ensurePendingAckDir(): void {
  if (!existsSync(getClaudeCodePendingAckDir())) {
    mkdirSync(getClaudeCodePendingAckDir(), { recursive: true, mode: 0o700 });
  }
}

function ensureExhaustedDir(): void {
  if (!existsSync(EXHAUSTED_DIR)) {
    mkdirSync(EXHAUSTED_DIR, { recursive: true, mode: 0o700 });
  }
}

function readPersistedRetryCount(metaPath: string, id: string, fileName: string): number | null {
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      id?: unknown;
      fileName?: unknown;
      retries?: unknown;
    };
    if (parsed.id !== id || parsed.fileName !== fileName) return null;
    const retries = Number(parsed.retries);
    if (!Number.isInteger(retries) || retries < 0) return null;
    return retries;
  } catch {
    return null;
  }
}

/**
 * Test/diagnostic helper: peek at the current pending-deliveries map.
 * Returns a shallow snapshot — callers must not mutate.
 */
export function _getPendingDeliveriesForTesting(): PendingEntry[] {
  return Array.from(pendingDeliveries.values());
}

/**
 * Test/diagnostic helper: returns whether the escape-hatch has been triggered.
 */
export function _isChannelMarkedDeadForTesting(): boolean {
  return channelMarkedDead;
}

/**
 * Test-only: drive one polling tick of the hybrid AC pipeline (process
 * pending entries + evaluate escape-hatch). Production code path is the
 * 2 s polling loop in `startPolling`. Tests use this to assert state
 * transitions without depending on the polling interval.
 */
export function _processPendingDeliveriesForTesting(): void {
  processPendingDeliveries();
  maybeMarkChannelDead();
}

/**
 * Test-only: reset escape-hatch state. The state is intentionally process-
 * scoped sticky in production (a dead channel stays dead until next process),
 * but tests need to interleave dead/healthy scenarios cleanly.
 */
export function _resetChannelDeadStateForTesting(): void {
  channelMarkedDead = false;
  channelMarkedDeadAt = 0;
  recentPushes.length = 0;
}

/**
 * Test-only: reset pending-deliveries map in addition to the dead-channel
 * state. Used by the consume-race tests to start each scenario from a clean
 * pending-ack ledger.
 */
export function _resetPendingDeliveriesForTesting(): void {
  pendingDeliveries.clear();
  // 3.9.1 [CONSUME-RACE] — also clear cross-reinject retry map so tests
  // start each scenario from a clean slate (otherwise a prior scenario's
  // retry count could leak into a later scenario reusing the same id).
  retriesByMsgId.clear();
  successfulChannelPushCount = 0;
  _resetChannelDeadStateForTesting();
}

function trimRecentPushes(now: number): void {
  while (recentPushes.length > 0 && now - recentPushes[0] > ESCAPE_HATCH_WINDOW_MS) {
    recentPushes.shift();
  }
}

function maybeMarkChannelDead(): void {
  if (channelMarkedDead) return;
  const now = Date.now();
  trimRecentPushes(now);
  if (recentPushes.length < ESCAPE_HATCH_PUSH_THRESHOLD) return;
  // Threshold met. Check alive-evidence across the window: any tool calls,
  // any long-poll listeners. If both are zero, declare dead.
  // NOTE: we approximate "no NEW tool calls in the window" as "no tool calls
  // since the FIRST push in the window happened" (we don't snapshot per
  // window-entry to keep state small). Listeners-count is sampled live.
  // The first entry's toolCalls snapshot is not directly available here;
  // instead, we cross-reference the oldest pending entry pushed within the
  // window. If none, fall back to the conservative path (do not mark dead).
  const windowStart = recentPushes[0];
  let firstSnapshot: number | null = null;
  for (const entry of pendingDeliveries.values()) {
    if (entry.pushedAt >= windowStart) {
      if (firstSnapshot === null || entry.toolCallsAtPushTime < firstSnapshot) {
        firstSnapshot = entry.toolCallsAtPushTime;
      }
    }
  }
  if (firstSnapshot === null) return;
  const tcNow = aliveSignals.getToolCallsReceivedCount();
  const noNewToolCalls = tcNow <= firstSnapshot;
  const noListeners = inboxArrivalListenerCount() === 0;
  if (noNewToolCalls && noListeners) {
    channelMarkedDead = true;
    channelMarkedDeadAt = now;
    logError(
      'Channel: ESCAPE-HATCH triggered — '
      + `${recentPushes.length} pushes within ${ESCAPE_HATCH_WINDOW_MS}ms, `
      + 'no new tool calls, no long-poll listeners. Channel marked dead. '
      + 'Future pushes will queue to .pending-ack/ without invoking the callback. '
      + 'Next plugin reload / channel-owner takeover will replay them.',
    );
    logEvent({
      event: 'channel.dead_escape_hatch',
      level: 'error',
      msg: 'ESCAPE-HATCH: channel marked dead (no acks within window)',
      context: {
        recent_pushes: recentPushes.length,
        window_ms: ESCAPE_HATCH_WINDOW_MS,
        tool_calls_at_window_start: firstSnapshot,
        tool_calls_now: tcNow,
        listeners_now: 0,
        marked_dead_at_ms: now,
      },
    });
  }
}

/**
 * Test-only: fire all registered inbox-arrival listeners. The production
 * code path drives this via the polling pass in `checkForNewFiles`; tests
 * need a synchronous trigger so they can verify wake-up behaviour without
 * depending on the 2 s poll interval. Underscore prefix marks it as not
 * a public stable API — used only by `test/long-poll-receive.test.mjs`.
 */
export function _fireInboxArrivalListenersForTesting(): void {
  fireInboxArrivalListeners();
}

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
  return join(LOCKS_DIR, leaseFileNameForTarget(target));
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
    const version = typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : undefined;
    return {
      pid,
      target: parsed.target,
      role: parsed.role,
      token: parsed.token,
      startedAt,
      updatedAt,
      ...(version ? { version } : {}),
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
    msg: `Watcher lease lost for ${getActiveClaudeCodeTargetOrDefault()}`,
    context: { reason, pid: process.pid, target: getActiveClaudeCodeTargetOrDefault() },
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
      msg: `Watcher lease heartbeat failed for ${getActiveClaudeCodeTargetOrDefault()}`,
      context: {
        target: getActiveClaudeCodeTargetOrDefault(),
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
  const filePath = watcherLeasePath(getActiveClaudeCodeTargetOrDefault());
  const now = Date.now();
  const meta: WatcherLeaseFile = {
    pid: process.pid,
    target: getActiveClaudeCodeTargetOrDefault(),
    role,
    token: `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: now,
    updatedAt: now,
    // 3.7.1 — write our build version so newer peers can detect a
    // stale-version owner and force migration via SIGTERM (see Patch F's
    // stale-version peer-kill path in index.ts).
    version: MCP_SERVER_VERSION,
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
      // 3.7.0 — refed for channel-owner mode (long-lived, must keep the
      // event loop alive across idle gaps), unref'd for tools-only / auto
      // mode (must NOT pin Node alive after stdio closes).
      if (role !== 'channel-owner') {
        heartbeat.unref?.();
      }
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
          `Watcher standby: ${getActiveClaudeCodeTargetOrDefault()} lease already held by pid=${existing.pid} role=${existing.role}`,
        );
        logEvent({
          event: 'watcher.lease_busy',
          level: 'warn',
          msg: `Watcher lease busy for ${getActiveClaudeCodeTargetOrDefault()}`,
          context: {
            target: getActiveClaudeCodeTargetOrDefault(),
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
          `Watcher: removed stale lease for ${getActiveClaudeCodeTargetOrDefault()} held by pid=${existing.pid} role=${existing.role}`,
        );
        logEvent({
          event: 'watcher.lease_stolen',
          level: 'info',
          msg: `Removed stale watcher lease for ${getActiveClaudeCodeTargetOrDefault()}`,
          context: {
            target: getActiveClaudeCodeTargetOrDefault(),
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
      logWarn(`Watcher standby: promoted to active owner for ${getActiveClaudeCodeTargetOrDefault()}`);
      logEvent({
        event: 'watcher.standby_promoted',
        level: 'warn',
        msg: `Watcher standby promoted for ${getActiveClaudeCodeTargetOrDefault()}`,
        context: { target: getActiveClaudeCodeTargetOrDefault(), pid: process.pid, role: savedWatcherRole },
      });
      activateWatcher(callback);
      void replayUndeliveredMessages();
      // 3.11.0 [AUTO-UPDATE-RE-PROBE 2026-04-30] — notify subscribers that
      // this process just became the channel-owner. index.ts uses this to
      // (re)arm the auto-update probe + 3h interval.
      firePromotionListeners();
      return;
    }

    if (result === 'failed') {
      logWarn(
        `Watcher standby: lease acquisition failed for ${getActiveClaudeCodeTargetOrDefault()}; `
        + `will retry in ${WATCHER_STANDBY_RETRY_MS}ms`,
      );
    }

    standbyRetryTimer = setTimeout(retry, WATCHER_STANDBY_RETRY_MS);
    standbyRetryTimer.unref?.();
  };

  logWarn(
    `Watcher standby: will retry ${getActiveClaudeCodeTargetOrDefault()} lease every `
    + `${WATCHER_STANDBY_RETRY_MS}ms`,
  );
  logEvent({
    event: 'watcher.standby_retry_scheduled',
    level: 'warn',
    msg: `Watcher standby retry scheduled for ${getActiveClaudeCodeTargetOrDefault()}`,
    context: { target: getActiveClaudeCodeTargetOrDefault(), pid: process.pid, role },
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
  const filePath = join(getClaudeCodeInboxDir(), fileName);
  try {
    if (!existsSync(getClaudeCodeFailedDir())) {
      mkdirSync(getClaudeCodeFailedDir(), { recursive: true, mode: 0o700 });
    }
    renameSync(filePath, join(getClaudeCodeFailedDir(), fileName));
    knownFiles.delete(fileName);
    invalidateCache();
    logWarn(`Channel: moved ${fileName} to .failed/${getActiveClaudeCodeTargetOrDefault()}/: ${reason}`);
  } catch (err) {
    logError(`Channel: failed to quarantine ${fileName}: ${err}`);
  }
}

function archiveDeliveredMessage(fileName: string, id: string, reason: string): void {
  archiveDeliveredMessageFrom(join(getClaudeCodeInboxDir(), fileName), fileName, id, reason);
}

/**
 * 3.9.0 [CONSUME-RACE] — archive from an arbitrary source path. Used to
 * finalize files that were staged in `.pending-ack/<target>/` after the
 * early-defer window expires. Mirrors `archiveDeliveredMessage` but does
 * not assume the file lives in getClaudeCodeInboxDir().
 */
function archiveDeliveredMessageFrom(
  sourcePath: string,
  fileName: string,
  id: string,
  reason: string,
): void {
  try {
    if (!existsSync(sourcePath)) {
      knownFiles.delete(fileName);
      invalidateCache();
      return;
    }
    if (!existsSync(getClaudeCodeArchiveDir())) {
      mkdirSync(getClaudeCodeArchiveDir(), { recursive: true, mode: 0o700 });
    }
    const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${fileName}`;
    renameSync(sourcePath, join(getClaudeCodeArchiveDir(), stamped));
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

/**
 * 3.9.0 [CONSUME-RACE] — Move a fully-parsed inbox file into .pending-ack/
 * staging and write a sidecar metadata file. Returns the new pending entry,
 * or null if the move failed (in which case the caller should leave the
 * file in inbox/ for the next poll).
 */
function stagePendingAck(
  fileName: string,
  id: string,
  retries: number,
  escapeHatch = false,
): PendingEntry | null {
  ensurePendingAckDir();
  const sourcePath = join(getClaudeCodeInboxDir(), fileName);
  const pendingPath = join(getClaudeCodePendingAckDir(), fileName);
  const metaPath = join(getClaudeCodePendingAckDir(), `${id}.meta.json`);
  const pushedAt = Date.now();
  // 3.9.1 [CONSUME-RACE] — if this id has already gone through a
  // reinject cycle, restore the persisted retry count so the cap of
  // PENDING_REINJECT_MAX_RETRIES actually fires. Without this the caller
  // path (emitChannelNotification → stagePendingAck(..., 0)) would reset
  // retries to 0 every time the watcher re-detected the re-injected file.
  const persistedRetries = retriesByMsgId.get(id);
  const sidecarRetries = readPersistedRetryCount(metaPath, id, fileName);
  const effectiveRetries = Math.max(retries, persistedRetries ?? 0, sidecarRetries ?? 0);
  const entry: PendingEntry = {
    id,
    fileName,
    pendingPath,
    metaPath,
    pushedAt,
    retries: effectiveRetries,
    target: getActiveClaudeCodeTargetOrDefault(),
    listenersAtPushTime: inboxArrivalListenerCount(),
    toolCallsAtPushTime: aliveSignals.getToolCallsReceivedCount(),
    successfulPushesAtStageTime: successfulChannelPushCount,
    hadError: false,
    escapeHatch,
  };
  try {
    renameSync(sourcePath, pendingPath);
  } catch (err) {
    logWarn(`Channel: failed to stage ${fileName} into .pending-ack/: ${err}`);
    return null;
  }
  try {
    writeFileSync(metaPath, JSON.stringify({
      id,
      fileName,
      pushedAt,
      retries: effectiveRetries,
      target: getActiveClaudeCodeTargetOrDefault(),
      listenersAtPushTime: entry.listenersAtPushTime,
      toolCallsAtPushTime: entry.toolCallsAtPushTime,
      successfulPushesAtStageTime: entry.successfulPushesAtStageTime,
      mcpServerVersion: MCP_SERVER_VERSION,
    }, null, 2), { mode: 0o600 });
  } catch (err) {
    // Sidecar is a recovery aid only; missing sidecar means handover-replay
    // can't read the original pushedAt (we use file mtime as a fallback).
    logWarn(`Channel: failed to write meta sidecar ${metaPath}: ${err}`);
  }
  pendingDeliveries.set(id, entry);
  knownFiles.delete(fileName);
  invalidateCache();
  return entry;
}

function logPendingStaged(entry: PendingEntry): void {
  logEvent({
    event: 'channel.pending_staged',
    msg: `Staged ${entry.id} to .pending-ack/ awaiting harness ack`,
    context: {
      msg_id: entry.id,
      pushed_at_ms: entry.pushedAt,
      retries: entry.retries,
      tool_calls_at_push: entry.toolCallsAtPushTime,
      listeners_at_push: entry.listenersAtPushTime,
    },
  });
}

function leavePendingAfterStageFailure(fileName: string, id: string, context: string): void {
  knownFiles.delete(fileName);
  invalidateCache();
  logError(
    `Channel: failed to stage ${id} into .pending-ack/ after ${context}; `
    + 'leaving file pending for retry',
  );
  logEvent({
    event: 'channel.pending_stage_failed',
    level: 'error',
    msg: `Failed to stage ${id} into .pending-ack/`,
    context: {
      msg_id: id,
      file_name: fileName,
      after: context,
      decision: 'leave_pending_for_retry',
    },
  });
}

/**
 * 3.9.0 [CONSUME-RACE] — Finalize a pending entry: archive the file,
 * mark the message delivered in the dedup ledger, drop the entry from
 * the pending map, and remove the sidecar.
 */
function finalizePending(entry: PendingEntry, reason: string): void {
  archiveDeliveredMessageFrom(entry.pendingPath, entry.fileName, entry.id, reason);
  markDelivered(entry.id);
  try {
    if (existsSync(entry.metaPath)) unlinkSync(entry.metaPath);
  } catch { /* best-effort */ }
  pendingDeliveries.delete(entry.id);
  // 3.9.1 [CONSUME-RACE] — GC retry-persistence map on successful finalize.
  retriesByMsgId.delete(entry.id);
  logEvent({
    event: 'channel.pending_finalized',
    msg: `Pending-ack finalized for ${entry.id} (${reason})`,
    context: {
      msg_id: entry.id,
      reason,
      retries: entry.retries,
      age_ms: Date.now() - entry.pushedAt,
    },
  });
}

/**
 * 3.9.0 [CONSUME-RACE] — Re-inject a pending entry back into the inbox so
 * the watcher picks it up on the next poll. Increments retries; if the
 * cap is exceeded, move to `.failed/.exhausted/` instead and emit a
 * fatal-level log event.
 */
function reinjectPending(entry: PendingEntry, reason: string): void {
  const newRetries = entry.retries + 1;
  if (newRetries > PENDING_REINJECT_MAX_RETRIES) {
    ensureExhaustedDir();
    const stamped = `${new Date().toISOString().replace(/[:.]/g, '-')}_${entry.fileName}`;
    try {
      renameSync(entry.pendingPath, join(EXHAUSTED_DIR, stamped));
    } catch (err) {
      logError(`Channel: failed to move ${entry.fileName} to .exhausted/: ${err}`);
    }
    try {
      if (existsSync(entry.metaPath)) unlinkSync(entry.metaPath);
    } catch { /* best-effort */ }
    pendingDeliveries.delete(entry.id);
    // 3.9.1 [CONSUME-RACE] — GC retry-persistence map on terminal exhaustion.
    retriesByMsgId.delete(entry.id);
    logError(
      `Channel: pending-ack RETRY-EXHAUSTED for ${entry.id} after `
      + `${PENDING_REINJECT_MAX_RETRIES} re-injections (${reason}); moved to .failed/.exhausted/`,
    );
    logEvent({
      event: 'channel.pending_exhausted',
      level: 'error',
      msg: `Pending-ack retries exhausted for ${entry.id}`,
      context: {
        msg_id: entry.id,
        retries: entry.retries,
        max_retries: PENDING_REINJECT_MAX_RETRIES,
        reason,
        age_ms: Date.now() - entry.pushedAt,
      },
    });
    return;
  }

  const inboxPath = join(getClaudeCodeInboxDir(), entry.fileName);
  try {
    if (!existsSync(getClaudeCodeInboxDir())) mkdirSync(getClaudeCodeInboxDir(), { recursive: true, mode: 0o700 });
    renameSync(entry.pendingPath, inboxPath);
  } catch (err) {
    logError(`Channel: failed to re-inject ${entry.fileName} → inbox: ${err}`);
    return;
  }
  // 3.9.1 [CONSUME-RACE] — persist newRetries BEFORE dropping from the
  // map so the next stagePendingAck (driven by the watcher re-picking
  // up the file from inbox/) restores the count instead of resetting
  // to 0. Without this, the cap of PENDING_REINJECT_MAX_RETRIES never
  // fires and the file ping-pongs forever.
  retriesByMsgId.set(entry.id, newRetries);
  try {
    writeFileSync(entry.metaPath, JSON.stringify({
      id: entry.id,
      fileName: entry.fileName,
      pushedAt: entry.pushedAt,
      retries: newRetries,
      target: entry.target,
      listenersAtPushTime: entry.listenersAtPushTime,
      toolCallsAtPushTime: entry.toolCallsAtPushTime,
      successfulPushesAtStageTime: entry.successfulPushesAtStageTime,
      mcpServerVersion: MCP_SERVER_VERSION,
    }, null, 2), { mode: 0o600 });
  } catch (err) {
    logWarn(`Channel: failed to persist retry sidecar for ${entry.id}: ${err}`);
  }
  pendingDeliveries.delete(entry.id);
  // Force a re-emit on the next poll: drop from knownFiles so the
  // checkForNewFiles diff includes it again.
  knownFiles.delete(entry.fileName);
  invalidateCache();
  logWarn(`Channel: re-injected ${entry.id} (retry ${newRetries}/${PENDING_REINJECT_MAX_RETRIES}) — ${reason}`);
  logEvent({
    event: 'channel.pending_reinjected',
    level: 'warn',
    msg: `Re-injected pending message ${entry.id} for retry ${newRetries}`,
    context: {
      msg_id: entry.id,
      retries: newRetries,
      max_retries: PENDING_REINJECT_MAX_RETRIES,
      reason,
      age_ms: Date.now() - entry.pushedAt,
    },
  });
}

/**
 * 3.9.0 [CONSUME-RACE] — Hybrid AC tick. Runs every poll cycle (~2 s).
 * Walks the pending-deliveries map and decides for each entry whether to
 * finalize (early-defer + alive-evidence) or re-inject (safety-net + no
 * alive-evidence).
 *
 * The two windows are NOT overlapping early-defer rules — they are
 * complementary:
 *   - 5 s + alive   → finalize. Trust the channel push because the
 *                     harness is demonstrably alive AND the stdout write
 *                     succeeded; further waiting buys nothing.
 *   - 60 s + ¬alive → reinject. After a full minute with zero positive
 *                     evidence the harness saw it, treat the push as lost
 *                     and put it back in the inbox for another try.
 *   - Between 5–60 s — keep waiting (alive evidence may yet appear; if
 *                     it doesn't by 60 s, reinject path triggers).
 */
function processPendingDeliveries(): void {
  if (pendingDeliveries.size === 0) return;
  const now = Date.now();
  // Snapshot — finalize/reinject mutate the map.
  const entries = Array.from(pendingDeliveries.values());
  for (const entry of entries) {
    // Escape-hatch entries are parked indefinitely — only handover replay
    // (next plugin reload) recovers them, never the in-process tick.
    if (entry.escapeHatch) continue;
    if (entry.hadError) {
      // The notification path saw an error AFTER stdout-write resolved
      // (rare — typically logged in a downstream catch). Reinject ASAP
      // rather than wait the full safety-net window.
      reinjectPending(entry, 'callback_post_resolve_error');
      continue;
    }
    const age = now - entry.pushedAt;

    // Safety-net: oldest goes to reinject if no alive evidence at 60 s.
    if (age >= PENDING_REINJECT_MS) {
      if (!isHarnessAliveSincePush(entry)) {
        reinjectPending(entry, `safety_net_${PENDING_REINJECT_MS}ms_no_alive_evidence`);
      } else {
        // Alive evidence appeared late (>60 s). Honour it and finalize.
        finalizePending(entry, `safety_net_alive_after_${age}ms`);
      }
      continue;
    }

    // Early-defer: at 5+ s, IF the watcher still owns the lease AND we have
    // positive alive-evidence, finalize. Without alive-evidence we keep the
    // entry parked — the safety-net branch above handles the long tail.
    if (age >= PENDING_EARLY_DEFER_MS && watcherLease !== null && isHarnessAliveSincePush(entry)) {
      finalizePending(entry, `early_defer_alive_at_${age}ms`);
    }
  }
}

function emitChannelNotification(fileName: string): void {
  if (!savedChannelCallback) return;

  const filePath = join(getClaudeCodeInboxDir(), fileName);
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
    // 4.0.0 — Accept BOTH the persona-scoped target AND the legacy
    // `claude-code` literal. Pre-4.0.0 senders address `claude-code` and
    // their files are routed here either by `migrateLegacyClaudeCodeInboxFiles`
    // at boot or by the sender-side normalization in `sendMessage` /
    // `sendLocalMessage`. Quarantining them as "wrong target" would break
    // the upgrade path for any peer still running 3.x.
    const acceptedTargets = new Set<string>([getActiveClaudeCodeTargetOrDefault(), CLAUDE_CODE_TARGET]);
    if (!acceptedTargets.has(msg.target)) {
      quarantineFailed(
        fileName,
        `target ${JSON.stringify(msg.target)} does not match ${getActiveClaudeCodeTargetOrDefault()} `
        + `(or legacy ${JSON.stringify(CLAUDE_CODE_TARGET)})`,
      );
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

    // 3.9.0 [CONSUME-RACE] — Escape-hatch short-circuit. If the channel was
    // declared dead (5+ pushes within 30 s with no alive evidence), we
    // immediately stage to .pending-ack/ WITHOUT calling the callback. The
    // file is preserved for the next plugin reload / channel-owner takeover
    // to replay. We deliberately stop the bleeding: callback invocation may
    // be wedging the JSON-RPC pipe in some pathological state, and pumping
    // more notifications at it just amplifies the silent drops.
    if (channelMarkedDead) {
      logWarn(`Channel: ESCAPE-HATCH active — staging ${msg.id} to .pending-ack/ without callback`);
      logEvent({
        event: 'channel.dead_escape_hatch_skip',
        level: 'warn',
        msg: `Skipping callback for ${msg.id}; channel marked dead`,
        context: {
          msg_id: msg.id,
          marked_dead_at_ms: channelMarkedDeadAt,
          age_ms: Date.now() - channelMarkedDeadAt,
        },
      });
      // Stage the file but mark it as an escape-hatch entry so the
      // hybrid AC tick leaves it alone. Escape-hatch entries sit in
      // `.pending-ack/<target>/` indefinitely so the next plugin reload's
      // handover-replay can pump them through a fresh channel. Reinjecting
      // them here would just re-trigger the same dead callback.
      stagePendingAck(fileName, msg.id, 0, true);
      return;
    }

    // 3.9.0 [CONSUME-RACE] — Track pushes for escape-hatch detection BEFORE
    // invoking the callback. The push timestamp goes into the recent-pushes
    // ring; if 5+ accumulate in 30 s with no alive evidence, the next call
    // to maybeMarkChannelDead() (driven from processPendingDeliveries) will
    // flip channelMarkedDead.
    const pushAt = Date.now();
    recentPushes.push(pushAt);
    trimRecentPushes(pushAt);

    withChannelNotifyTimeout(Promise.resolve(savedChannelCallback(msg)), msg.id)
      .then(() => {
        successfulChannelPushCount += 1;
        // 3.9.0 [CONSUME-RACE] — DO NOT markDelivered + archive optimistically.
        // The promise resolved when the JSON-RPC notification was written to
        // stdout; that is NOT proof the receiving Claude harness rendered it.
        // Stage to .pending-ack/ instead and let the hybrid AC tick decide
        // (early-defer + alive-evidence → finalize; safety-net + no
        // alive-evidence → re-inject).
        const entry = stagePendingAck(fileName, msg.id, 0);
        if (!entry) {
          leavePendingAfterStageFailure(fileName, msg.id, 'channel_callback_resolve');
          return;
        }
        logPendingStaged(entry);
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
    if (existsSync(getClaudeCodeInboxDir())) {
      const files = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
      for (const f of files) {
        knownFiles.add(f);
      }
    }
  } catch {
    // Ignore errors
  }
}

// ── Polling implementation ───────────────────────────────────────────────────

// 4.0.0 — periodically drain legacy `inbox/claude-code/<file>.json`
// (pre-4.0.0 senders that still address `target=claude-code` after THIS
// child started). Without this, files written between startup migration
// and persona-aware sender adoption would sit forever in the legacy dir.
// `migrateLegacyClaudeCodeInboxFiles()` itself is gated on
// `activePersona === 'default'`, so non-default personas no-op cheaply.
let legacyDrainTickCount = 0;
const LEGACY_DRAIN_EVERY_N_TICKS = 15; // ~30 s at 2 s poll cadence

function maybeDrainLegacyClaudeCodeInbox(): void {
  legacyDrainTickCount += 1;
  if (legacyDrainTickCount % LEGACY_DRAIN_EVERY_N_TICKS !== 0) return;
  if (getActivePersona() !== 'default') return;
  try {
    migrateLegacyClaudeCodeInboxFiles();
  } catch (err) {
    logError(`Watcher: legacy claude-code drain failed: ${err}`);
  }
}

function checkForNewFiles(callback: MessageCallback): void {
  try {
    // 4.0.0 — drain legacy `inbox/claude-code/*.json` first so any
    // pre-4.0.0 sender's writes since the last poll are migrated into
    // the persona subdir BEFORE we read it. Otherwise the file would be
    // detected as "new" only on the next poll after migration.
    maybeDrainLegacyClaudeCodeInbox();
    if (!existsSync(getClaudeCodeInboxDir())) return;
    const currentFiles = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
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

      // 3.8.0 — wake any in-process long-poll subscribers (broadcast).
      // Fired AFTER the per-file emitChannelNotification calls so the
      // channel-push parent path runs first; subagent long-pollers
      // (which read the inbox via peek/consume after waking) see the
      // file by the time their handler runs. Errors are isolated by
      // fireInboxArrivalListeners — a misbehaving subscriber cannot
      // take down the watcher poll loop.
      fireInboxArrivalListeners();

      callback(newFiles.map(f => join(getClaudeCodeInboxDir(), f)));
    }

    // 3.9.0 [CONSUME-RACE] — drive the hybrid AC tick on every poll cycle.
    // This finalizes pending entries that have aged past the early-defer
    // window (with alive evidence) and re-injects any that have gone past
    // the safety-net window without alive evidence. Also evaluates the
    // escape-hatch trigger condition.
    try {
      processPendingDeliveries();
      maybeMarkChannelDead();
    } catch (err) {
      logError(`Watcher: processPendingDeliveries failed: ${err}`);
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
  if (!existsSync(getClaudeCodeInboxDir())) {
    mkdirSync(getClaudeCodeInboxDir(), { recursive: true, mode: 0o700 });
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

  // 3.9.0 [CONSUME-RACE] — recover files left in `.pending-ack/<target>/`
  // by a previous lease holder. Anything older than the handover-reinject
  // window goes back into inbox/ so this fresh owner gets a clean retry.
  // Sidecar `<id>.meta.json` files (if present) are removed; pushedAt is
  // not needed once the file is back in inbox/.
  try {
    if (existsSync(getClaudeCodePendingAckDir())) {
      const ackEntries = readdirSync(getClaudeCodePendingAckDir());
      const nowMs = Date.now();
      for (const ackName of ackEntries) {
        if (!ackName.endsWith('.json')) continue;
        if (ackName.endsWith('.meta.json')) continue;
        const ackPath = join(getClaudeCodePendingAckDir(), ackName);
        let mtimeMs = 0;
        try { mtimeMs = statSync(ackPath).mtimeMs; } catch { mtimeMs = 0; }
        const age = nowMs - mtimeMs;
        if (mtimeMs > 0 && age < PENDING_HANDOVER_REINJECT_MS) {
          // Too fresh — leave it in pending-ack/. The previous owner may
          // still be running (lease handover happens during /reload-plugins
          // and the old peer can briefly co-exist) and the hybrid AC tick
          // there is still authoritative for this entry.
          continue;
        }
        const inboxTargetPath = join(getClaudeCodeInboxDir(), ackName);
        try {
          if (!existsSync(getClaudeCodeInboxDir())) mkdirSync(getClaudeCodeInboxDir(), { recursive: true, mode: 0o700 });
          renameSync(ackPath, inboxTargetPath);
          // Keep the meta sidecar in place: it carries the retry counter
          // across lease handover and process restart. stagePendingAck()
          // reads it before overwriting fresh push metadata.
          knownFiles.delete(ackName);
          logWarn(`Replay: re-injected handover-pending file ${ackName} (age=${age}ms)`);
          logEvent({
            event: 'channel.pending_handover_reinjected',
            level: 'warn',
            msg: `Handover replay re-injected ${ackName}`,
            context: { file_name: ackName, age_ms: age },
          });
        } catch (err) {
          logError(`Replay: failed to re-inject handover-pending ${ackName}: ${err}`);
        }
      }
    }
  } catch (err) {
    logWarn(`Replay: failed to scan .pending-ack/${getActiveClaudeCodeTargetOrDefault()}/: ${err}`);
  }

  try {
    if (!existsSync(getClaudeCodeInboxDir())) return;

    const files = readdirSync(getClaudeCodeInboxDir()).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // Parse all valid messages, filter to undelivered, sort by timestamp
    const undelivered: { fileName: string; msg: BridgeMessage }[] = [];

    for (const fileName of files) {
      const filePath = join(getClaudeCodeInboxDir(), fileName);
      try {
        const raw = readFileSync(filePath, 'utf8');
        const msg = JSON.parse(raw) as BridgeMessage;
        if (!msg.id || !msg.timestamp || typeof msg.content !== 'string') {
          quarantineFailed(fileName, 'replay missing required fields: id, timestamp, content');
          continue;
        }
        if (
          !msg.target
          || !isValidTarget(msg.target)
          || (msg.target !== getActiveClaudeCodeTargetOrDefault() && msg.target !== CLAUDE_CODE_TARGET)
        ) {
          quarantineFailed(
            fileName,
            `replay target ${JSON.stringify(msg.target ?? null)} is not ${getActiveClaudeCodeTargetOrDefault()} `
            + `(or legacy ${JSON.stringify(CLAUDE_CODE_TARGET)})`,
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
        const entry = stagePendingAck(fileName, msg.id, 0);
        if (!entry) {
          leavePendingAfterStageFailure(fileName, msg.id, 'replay_channel_callback_resolve');
          continue;
        }
        logPendingStaged(entry);
      } catch (err) {
        knownFiles.delete(fileName);
        invalidateCache();
        logError(`Replay: failed to push ${fileName}: ${err}; will retry on next poll`);
      }
    }

    logInfo(`Replay: completed, ${undelivered.length} message(s) pushed/staged`);
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
