#!/usr/bin/env node
/**
 * agent-bridge MCP server — unified tools-and-channel plugin (3.7.1).
 *
 * 3.7.0 — Undo of the 3.6.0 split. The dedicated `claude-code-channel` plugin
 * has been merged BACK into this MCP server. We now host:
 *
 *   1. The 7 user-facing bridge tools (bridge_send_message, bridge_status,
 *      bridge_list_machines, bridge_run_command, bridge_inbox_stats,
 *      bridge_clear_inbox, bridge_receive_messages) — registered by
 *      `tools.ts::registerTools()`.
 *   2. The diagnostic no-op tool `claude_code_channel_status` originally
 *      added by 3.6.3 Patch H. Retained because it doubles as a useful
 *      health probe.
 *   3. The channel watcher itself: persona-scoped lease acquisition for
 *      `~/.agent-bridge/inbox/claude-code/<persona>/`, the 2 s polling loop,
 *      and `notifications/claude/channel` push of incoming BridgeMessages back
 *      into the running Claude Code session.
 *
 * Why we re-merged: the 3.6.0 split assumed Claude Code's plugin host would
 * keep channel-only plugins alive (since they own a long-lived channel
 * capability). The empirical evidence (Mac Mini production, 2026-04-26)
 * showed the host actually decides reapability based on **MCP tool-call
 * frequency on stdio JSON-RPC**. Telegram (also a channel plugin) survives
 * indefinitely because its 4 tools — `reply`, `react`, `download_attachment`,
 * `edit_message` — get called constantly. A channel-only plugin with no tool
 * calls gets reaped after every notification delivery, regardless of:
 *   - Patch G (ignore SIGTERM) — host escalates to uncatchable SIGKILL.
 *   - Patch H (no-op tool registered but rarely called) — registration alone
 *     was insufficient because the host gates on call FREQUENCY, not
 *     registration.
 *   - Heartbeats / file polling — internal, plugin host doesn't see them.
 *
 * The fix: combine everything back into one plugin so every
 * `bridge_send_message` (and other bridge tool) call resets the plugin
 * host's idle counter. Same lifetime guarantees as Telegram.
 *
 * IMPORTANT: stdout is the JSON-RPC transport — never `console.log`. Use
 * `console.error()` or the logger module for diagnostics.
 *
 * 3.7.1 — Patch F race fix + stale-version peer-kill. The 3.7.0 form of
 * Patch F exited the new plugin when a fresh peer held the lease, which
 * created a race during /reload-plugins migrations: the old plugin then
 * died and there was no successor. 3.7.1 changes this so the new plugin
 * either kills an older-version peer (SIGTERM, 2s grace, SIGKILL) or
 * stays in standby+retry instead of exiting. Same-version peers are
 * never killed; unknown-version peers are treated as same-version.
 *
 * Lifecycle posture (all 3.5.x → 3.6.x diagnostic + recovery improvements
 * are retained):
 *   - Patch B  — persistent stderr tee (Telegram pattern)
 *   - Patch F  — heartbeat-recency guard against parallel-spawn from
 *                subagents murdering the parent's poller. 3.7.1 form:
 *                standby+retry on same-version peer; kill+steal on
 *                older-version peer.
 *   - Patch G  — channel-owner SIGTERM ignore (defence-in-depth; tools
 *                that get called regularly will normally avoid the reap
 *                window in the first place)
 *   - 60s heartbeat (refed when channel-owner)
 *   - shutdown_diag with handles dump
 *   - syncExitBreadcrumb to durable log
 *   - 3-poll orphan watchdog (15s confirmation window) — gated on
 *     parent-pid liveness AND stdin destroyed/errored
 *   - sibling-MCP-step-down via lease file
 *   - fatalTransportExit on stdout EPIPE
 */

// MUST be the first import in this file. `bootstrap-ppid` snapshots
// `process.ppid` at the very first opportunity — before any other import
// (zod, MCP SDK, our own modules) gets a chance to execute. ESM resolves
// imports depth-first, so this dependency-free module runs its body
// before any sibling import body. Critical for the orphan-suicide skip
// gate: if the parent dies during a slow dependency load, the snapshot
// MUST already exist with the real parent PID — taking it later would
// see process.ppid===1 and erroneously skip suicide on a true orphan.
// See ./bootstrap-ppid.ts for the full rationale (Codex P2 2026-05-04).
import { STARTUP_PPID } from './bootstrap-ppid.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_BRIDGE_PERSONA_ENV,
  LOCKS_DIR,
  LOGS_DIR,
  MCP_SERVER_VERSION,
  ensureDirectories,
  getLocalMachineName,
  leaseFileNameForTarget,
} from './config.js';
import { initInbox, setActivePersona, shutdownInbox } from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { resolveIdentity } from './persona.js';
import { registerTools } from './tools.js';
import { startWatcher, stopWatcher, replayUndeliveredMessages, registerAliveSignals, subscribeToPromotion, recordHarnessAck, getChannelHealthSnapshot } from './watcher.js';
import { logInfo, logError, logWarn } from './logger.js';
import { logEvent } from './log.js';
import { formatRelayScaffold } from './relay-notice.js';
import { storeRelayExpandMessage } from './relay-expand-store.js';

// 3.7.1 — version is sourced from config.ts (single source of truth shared
// with watcher.ts so lease files carry our build version for Patch F's
// stale-version peer-kill path).
const VERSION = MCP_SERVER_VERSION;

// 4.0.x — STARTUP_PPID is imported from ./bootstrap-ppid above. We keep
// it pinned to module-evaluation order rather than re-snapshotting here,
// because by this point in the file other static imports (zod, MCP SDK)
// have already evaluated and could have given a dying parent time to
// reparent us. The bootstrap-ppid module body runs before all of them.

// 3.5.5 — Patch B (mirror of Telegram plugin server.ts:31-51): persistent
// stderr tee. Claude Code can close diagnostic stderr between tool turns; once
// that happens, anything we write to stderr disappears. Tee process.stderr to
// a durable log file so post-mortem evidence survives even when the harness's
// stderr pipe is gone. Rotate when ~5 MiB to bound disk use; identical pattern
// to the Telegram channel plugin's Patch B.
const STDERR_LOG_FILE = join(LOGS_DIR, 'mcp-server-stderr.log');
try {
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(STDERR_LOG_FILE) && statSync(STDERR_LOG_FILE).size > 5 * 1024 * 1024) {
    const existing = readFileSync(STDERR_LOG_FILE, 'utf8');
    writeFileSync(STDERR_LOG_FILE, existing.slice(-2 * 1024 * 1024));
  }
} catch { /* best-effort rotation */ }
try {
  const stderrLogStream = createWriteStream(STDERR_LOG_FILE, { flags: 'a' });
  // Swallow stream errors so a wedged log file can never crash the watcher.
  stderrLogStream.on('error', () => { /* never let log tee take us down */ });
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = ((chunk: any, ...args: any[]) => {
    try { stderrLogStream.write(chunk); } catch { /* ignore */ }
    return (origStderrWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...(args as unknown[]));
  });
  process.on('exit', () => { try { stderrLogStream.end(); } catch { /* ignore */ } });
} catch { /* if we cannot install the tee, just keep going */ }

// 4.0.0 — Resolve persona + mode ONCE, before Patch F. The shared
// `PersonaResolution` is used by:
//   - Patch F's IIFE below (decides which lease file to inspect, AND
//     whether to skip the kill+standby logic entirely when we are
//     tools-only),
//   - `setActivePersona()` (so all inbox/watcher subdir resolution
//     uses the resolved persona),
//   - `main()` (skips watcher startup when tools-only),
//   - The status tool + epitaph events.
//
// `AGENT_BRIDGE_ROLE`, `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`, and
// `AGENT_BRIDGE_DISABLE_WATCHER` were removed in 4.0.0 — they have NO
// effect. Persona + cmdline-fallback fully supersede them. Setting any
// of them is silently ignored (we do not even read them anywhere).
const identity = resolveIdentity();
if (identity.mode === 'channel-owner' && identity.persona) {
  setActivePersona(identity.persona);
}

// 3.7.1 — Patch F (heartbeat-recency guard against parallel spawn) — REVISED.
//
// The 3.7.0 form of Patch F **exited** when an existing fresh peer held the
// lease. That created a race during version migrations and `/reload-plugins`
// flows: the OLD plugin was about to die, but the NEW plugin saw its still-
// fresh heartbeat, exited, and left no successor. Once the old plugin actually
// terminated, no live process owned channel delivery until the next plugin
// spawn. Live evidence on MBP-Claude (2026-04-26 ~20:29 BST) showed exactly
// this: NEW pids 95679 and 98451 hit `patch_f.backoff_exit` while OLD pid
// 34781 (3.6.1 channel-only) held the lease; OLD got SIGTERM at 20:29:03 and
// MBP was left without a channel-owner.
//
// 3.7.1 replaces the exit with **standby + retry**:
//   - We log `patch_f.standby` and fall through to `main()`.
//   - `startWatcher` returns 'busy', `scheduleStandbyRetry` polls every 2 s.
//   - When the peer's heartbeat goes stale (>15 s old per
//     watcherLeaseIsStale), the standby steals the lease and activates
//     channel delivery. No race window, no orphan period.
//
// 3.7.1 also adds a **stale-version peer-kill**: if the existing lease's
// `version` field is older than our build, send the holder SIGTERM, wait 2 s
// for a clean shutdown, then SIGKILL as a fallback. This forces version
// migrations through `/reload-plugins` without leaving the older peer
// blocking the lease for the full heartbeat-stale window. We never kill a
// same-version peer, and we never kill when the version is unknown (treat as
// same-version — safer default).
//
// Skipped when `identity.mode === 'tools-only'` — tools-only hosts
// (OpenClaw, Codex sidekicks, Claude sessions without the agent-bridge
// channel flag, etc.) do not contend for the inbox lease, so they have
// no reason to back off or kill peers.
function compareSemver(a: string, b: string): number | null {
  // Returns negative if a < b, 0 if equal, positive if a > b. Returns null
  // when either input is not a parseable dotted-numeric semver-ish string —
  // caller treats that as "same-version" for safety.
  const parse = (s: string): number[] | null => {
    const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const av = parse(a);
  const bv = parse(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

{
  // 4.0.0 — Patch F runs only when identity mode is `channel-owner`.
  // Tools-only children never inspect the lease; they would never
  // SIGTERM a peer because they do not contend for the lease in the
  // first place. The `AGENT_BRIDGE_DISABLE_PATCH_F` test escape hatch
  // is preserved.
  if (
    identity.mode === 'channel-owner'
    && identity.target
    && process.env.AGENT_BRIDGE_DISABLE_PATCH_F !== '1'
  ) {
    // 4.0.0 — Build the list of lease paths Patch F should examine.
    // Always check the persona-keyed lease for THIS persona. When the
    // active persona is `default`, ALSO inspect the pre-4.0.0 legacy
    // lease (`claude-code.watcher-lock.json`) so a live v3 watcher
    // is visible to v4 arbitration during a rolling upgrade. Without
    // this, a v3 owner and a v4 default-persona owner would both
    // run, splitting delivery between legacy/default dirs and racing
    // the startup migration.
    const personaLeasePath = join(LOCKS_DIR, leaseFileNameForTarget(identity.target));
    const legacyLeasePath = join(LOCKS_DIR, leaseFileNameForTarget('claude-code'));
    const leasePaths: { path: string; isLegacy: boolean }[] = [
      { path: personaLeasePath, isLegacy: false },
    ];
    if (identity.persona === 'default') {
      leasePaths.push({ path: legacyLeasePath, isLegacy: true });
    }
    for (const { path: leasePath, isLegacy } of leasePaths) {
    try {
      if (existsSync(leasePath)) {
        const raw = readFileSync(leasePath, 'utf8');
        const meta = JSON.parse(raw) as { pid?: number; updatedAt?: number; version?: string };
        const holder = Number(meta?.pid);
        const updatedAt = Number(meta?.updatedAt);
        // 4.0.0 — A holder of the LEGACY `claude-code.watcher-lock.json`
        // lease is by construction a pre-4.0.0 build (v4+ always writes
        // to the persona-keyed lease). If the legacy file lacks a
        // `version` field (3.7.0 and earlier) we still want the kill
        // path to fire so we can take over the inbox/claude-code/
        // delivery surface and finish the rolling upgrade. Synthesize
        // a placeholder strictly-older version when we can't parse one.
        const peerVersion = typeof meta?.version === 'string'
          ? meta.version
          : (isLegacy ? '3.0.0' : undefined);
        if (
          Number.isInteger(holder)
          && holder > 0
          && holder !== process.pid
          && Number.isFinite(updatedAt)
          && Date.now() - updatedAt < 90_000
        ) {
          // Probe holder liveness — kill(pid, 0) on a live process is a
          // no-op; ESRCH means dead and we should NOT enter standby (the
          // lease is stale, tryAcquireWatcherLease will steal it). Any other
          // error means the process exists from our POV — handle below.
          let holderAlive = false;
          try {
            process.kill(holder, 0);
            holderAlive = true;
          } catch (err) {
            const code = (err as { code?: string }).code;
            holderAlive = code !== 'ESRCH';
          }
          if (holderAlive) {
            // ── Stale-version peer-kill ───────────────────────────────────
            // If we know the peer's version and it is strictly older than
            // ours, force migration by SIGTERMing it. Wait 2 s for clean
            // shutdown, then SIGKILL as a fallback. Same- or unknown-version
            // peers are NEVER killed.
            const versionCompare = peerVersion
              ? compareSemver(peerVersion, MCP_SERVER_VERSION)
              : null;
            const peerIsOlder = versionCompare !== null && versionCompare < 0;
            // 4.0.0 — The 3.14.8 non-Claude-channel parent gate was
            // REMOVED here. Its job (preventing openclaw-gateway-spawned
            // MCP children from killing the user's main CC channel-owner)
            // is now handled structurally by persona resolution at
            // module load: non-CC parents without `AGENT_BRIDGE_PERSONA`
            // end up in tools-only mode and never reach this block.
            //
            // Reaching this block at all therefore means the operator
            // EXPLICITLY opted into channel-owner mode (via
            // `AGENT_BRIDGE_PERSONA`), and they expect the kill path to
            // fire to force version migration. Re-introducing a parent-
            // capability check here would silently break that opt-in.
            if (peerIsOlder) {
              // 3.14.4 — Pre-kill warning event. Logged BEFORE the SIGTERM so
              // post-mortem incident reports (`agent-bridge mcp-incident-report`)
              // can show the exact intent right before the kill, not just the
              // mechanical `patch_f.peer_version_kill` line. Includes a
              // human-readable summary so log-spelunking is not required.
              const peerHeartbeatAgeMs = Date.now() - updatedAt;
              const wouldOrphanThisSession =
                peerHeartbeatAgeMs < 30_000; // fresh heartbeat ⇒ likely active session
              const humanSummary =
                `I'm about to kill peer pid=${holder} v=${peerVersion} `
                + `because I'm v=${MCP_SERVER_VERSION} and Patch F prefers newer. `
                + `Peer last heartbeat ${peerHeartbeatAgeMs}ms ago. `
                + (wouldOrphanThisSession
                  ? 'This will likely disconnect the active session attached to that peer.'
                  : 'Peer heartbeat is stale; unlikely to disconnect anyone.');
              try {
                logEvent({
                  event: 'auto_update_runner.kill_will_evict_active_session',
                  level: 'warn',
                  msg: humanSummary,
                  context: {
                    peer_pid: holder,
                    peer_version: peerVersion,
                    our_pid: process.pid,
                    our_version: MCP_SERVER_VERSION,
                    peer_heartbeat_age_ms: peerHeartbeatAgeMs,
                    would_orphan_this_session: wouldOrphanThisSession,
                    human_summary: humanSummary,
                  },
                });
              } catch { /* best-effort */ }
              try {
                process.stderr.write(
                  `agent-bridge: peer pid=${holder} version=${peerVersion} is older than our ${MCP_SERVER_VERSION}; sending SIGTERM to force migration\n`,
                );
              } catch { /* best-effort */ }
              try {
                logEvent({
                  event: 'patch_f.peer_version_kill',
                  level: 'info',
                  msg: 'Patch F: SIGTERM-killing stale-version peer to force migration',
                  context: {
                    peer_pid: holder,
                    peer_version: peerVersion,
                    our_version: MCP_SERVER_VERSION,
                    pid: process.pid,
                    peer_heartbeat_age_ms: peerHeartbeatAgeMs,
                    would_orphan_this_session: wouldOrphanThisSession,
                  },
                });
              } catch { /* best-effort */ }
              try {
                process.kill(holder, 'SIGTERM');
              } catch { /* best-effort — peer may have just died */ }

              // Synchronously wait up to 2 s for the peer to release. Poll
              // its liveness every 100 ms via kill(pid, 0). We use
              // Atomics.wait on a SharedArrayBuffer-backed Int32Array for a
              // truly blocking sleep (no event loop required at module-load
              // time). The poll lets us short-circuit as soon as the peer
              // exits.
              const sab = new SharedArrayBuffer(4);
              const view = new Int32Array(sab);
              const deadline = Date.now() + 2_000;
              let peerStillAlive = true;
              while (Date.now() < deadline) {
                try {
                  process.kill(holder, 0);
                } catch (e) {
                  if ((e as { code?: string }).code === 'ESRCH') {
                    peerStillAlive = false;
                    break;
                  }
                }
                Atomics.wait(view, 0, 0, 100);
              }
              if (peerStillAlive) {
                try {
                  process.stderr.write(
                    `agent-bridge: peer pid=${holder} did not exit within 2s of SIGTERM; sending SIGKILL\n`,
                  );
                } catch { /* best-effort */ }
                try {
                  logEvent({
                    event: 'patch_f.peer_version_sigkill',
                    level: 'info',
                    msg: 'Patch F: SIGKILL fallback after 2s SIGTERM grace expired',
                    context: {
                      peer_pid: holder,
                      peer_version: peerVersion,
                      our_version: MCP_SERVER_VERSION,
                      pid: process.pid,
                    },
                  });
                } catch { /* best-effort */ }
                try {
                  process.kill(holder, 'SIGKILL');
                } catch { /* best-effort */ }
                // Brief grace for the kernel to release the PID. Acquire
                // logic is robust to transient EEXIST anyway.
                Atomics.wait(view, 0, 0, 200);
              }
              // Fall through into main(); startWatcher will steal the lease
              // (the holder is dead and the lease is now stale).
            } else {
              // ── Standby + retry path (3.7.1) ─────────────────────────────
              // Same-version (or unknown-version) healthy peer holds the
              // lease. Do NOT exit. Log evidence and fall through; the
              // normal startWatcher → scheduleStandbyRetry flow will keep
              // this process alive, polling every 2 s, and steal once the
              // peer's heartbeat goes stale (>15 s in
              // watcherLeaseIsStale). This eliminates the orphan-period
              // race that the 3.7.0 backoff_exit form created.
              try {
                process.stderr.write(
                  `agent-bridge: existing watcher pid=${holder} version=${peerVersion ?? 'unknown'} heartbeat fresh (age=${Date.now() - updatedAt}ms); this instance entering standby + retry\n`,
                );
              } catch { /* best-effort */ }
              try {
                logEvent({
                  event: 'patch_f.standby',
                  level: 'info',
                  msg: 'Patch F: peer holds watcher lease — entering standby + retry instead of exit (3.7.1)',
                  context: {
                    holder,
                    age_ms: Date.now() - updatedAt,
                    peer_version: peerVersion,
                    our_version: MCP_SERVER_VERSION,
                    version_compare: versionCompare,
                    pid: process.pid,
                  },
                });
              } catch { /* best-effort */ }
              // Compatibility breadcrumb so existing post-mortem tooling
              // still finds the historical 3.7.0 marker. Note the suffix
              // changed from `_exit` to `_standby` to make the new
              // behaviour searchable.
              try {
                mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
                appendFileSync(
                  join(LOGS_DIR, 'mcp-server-sync-exit.log'),
                  JSON.stringify({
                    ts: new Date().toISOString(),
                    event: 'patch_f.backoff_standby',
                    pid: process.pid,
                    ppid: process.ppid,
                    holder,
                    age_ms: Date.now() - updatedAt,
                    peer_version: peerVersion,
                    our_version: MCP_SERVER_VERSION,
                  }) + '\n',
                );
              } catch { /* best-effort */ }
              // Fall through to main(). DO NOT call process.exit() here.
            }
          }
        }
      }
    } catch (err) {
      // Best-effort. A malformed lease file is the watcher's problem and it
      // already handles it on acquire.
      try {
        logEvent({
          event: 'patch_f.check_error',
          level: 'warn',
          msg: 'Patch F: error checking existing lease (continuing)',
          context: { error: String(err) },
        });
      } catch { /* best-effort */ }
    }
    } // end for (lease paths)
  }
}

// Global error handlers. Most errors are logged and swallowed so the server
// stays up, BUT broken-pipe errors (EPIPE) mean the parent Claude process
// closed our stdout — there is no way to recover and any further write will
// loop forever. Exit immediately in that case to prevent zombie processes
// consuming CPU and rotating gigabytes of logs.
function isBrokenPipe(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: string; message?: string };
  if (anyErr.code === 'EPIPE' || anyErr.code === 'ERR_STREAM_DESTROYED') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : String(err);
  return /write EPIPE|Broken pipe|premature close|ERR_STREAM_DESTROYED/i.test(msg);
}

function syncExitBreadcrumb(event: string, context: Record<string, unknown> = {}): void {
  // Last-ditch post-mortem breadcrumb. This intentionally bypasses logger.ts
  // and log.ts so a transport/logger failure cannot hide the exact death path.
  try {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(LOGS_DIR, 'mcp-server-sync-exit.log'),
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        pid: process.pid,
        ppid: process.ppid,
        uptime_ms: Math.floor(process.uptime() * 1000),
        ...context,
      }) + '\n',
    );
  } catch {
    // No stdout/stderr fallback here: this path is specifically for broken
    // stdio/logging scenarios, and breadcrumbs must never affect liveness.
  }
}

let fatalTransportExitStarted = false;

function fatalTransportExit(event: string, msg: string, err?: unknown): never {
  syncExitBreadcrumb('fatal_transport_exit.enter', {
    transport_event: event,
    error: err ? String(err) : undefined,
    already_started: fatalTransportExitStarted,
  });
  if (fatalTransportExitStarted) {
    syncExitBreadcrumb('fatal_transport_exit.reentrant_exit', { transport_event: event });
    process.exit(0);
  }
  fatalTransportExitStarted = true;

  const anyErr = err as { code?: string; message?: string } | undefined;
  try {
    logError(`${msg}${err ? `: ${String(err)}` : ''}`);
  } catch {}
  try {
    logEvent({
      event,
      level: 'error',
      msg,
      context: {
        pid: process.pid,
        parent_pid: process.ppid,
        error_code: anyErr?.code,
        error_message: anyErr?.message ?? (err ? String(err) : undefined),
      },
    });
  } catch {}

  // Broken stdout means JSON-RPC/channel delivery is gone. Before exiting,
  // release the watcher lease synchronously where possible so bridge_inbox_stats
  // and standby owners do not stare at a stale lock for the full timeout.
  try {
    stopWatcher();
    syncExitBreadcrumb('fatal_transport_exit.after_stop_watcher', { transport_event: event });
  } catch (stopErr) {
    syncExitBreadcrumb('fatal_transport_exit.stop_watcher_error', { transport_event: event, error: String(stopErr) });
    try { logError(`stopWatcher before fatal transport exit failed: ${stopErr}`); } catch {}
  }
  try {
    shutdownInbox();
    syncExitBreadcrumb('fatal_transport_exit.after_shutdown_inbox', { transport_event: event });
  } catch (shutdownErr) {
    syncExitBreadcrumb('fatal_transport_exit.shutdown_inbox_error', { transport_event: event, error: String(shutdownErr) });
    try { logError(`shutdownInbox before fatal transport exit failed: ${shutdownErr}`); } catch {}
  }

  syncExitBreadcrumb('fatal_transport_exit.before_process_exit', { transport_event: event, code: 0 });
  process.exit(0);
}

// 3.14.4 — Post-mortem epitaph. When this MCP child dies, log one final
// `auto_update_runner.epitaph` event capturing WHY we died and which session
// is now MCP-orphaned. `agent-bridge mcp-incident-report` reads this back
// out and prints a human-readable summary. The epitaph runs synchronously
// in the 'exit' phase so the NDJSON line lands in agent-bridge.log even on
// SIGKILL → SIGTERM-handler-aborted exits.
//
// Mutation order:
//   - SIGTERM/SIGINT/SIGHUP arrival sets killReason + killInitiatorPid
//     (best-effort — SIGKILL bypasses every handler so those fields stay
//     undefined and the epitaph reads `kill_reason: "unknown"`, which is
//     itself a useful signal: "this child died via SIGKILL or async error").
//   - process.on('exit') fires once during normal shutdown OR force-exit
//     timer OR SIGKILL backstop. Atomically writes the epitaph.
let epitaphKillReason: string = 'unknown';
let epitaphKillInitiatorPid: number | undefined;
let epitaphLastToolCallTs: number | undefined;
let epitaphWatcherStarted = false;
let epitaphLeaseState: string = 'unknown'; // 'channel-owner' | 'standby' | 'tools-only' | 'unknown'
let epitaphWritten = false;

function writeEpitaph(triggerEvent: string): void {
  if (epitaphWritten) return;
  epitaphWritten = true;
  // Snapshot live channel health at epitaph time. Best-effort — if the
  // watcher module is partially torn down we still want the rest of the
  // epitaph to make it to disk. Today's "dead Dell mcp-server" debug
  // wished it could see "was the channel dead at the moment this child
  // died?" without a separate cross-file correlation.
  let channelHealth: ReturnType<typeof getChannelHealthSnapshot> | null = null;
  try { channelHealth = getChannelHealthSnapshot(); } catch { /* ignore */ }
  const epitaphContext = {
    pid: process.pid,
    parent_pid: process.ppid,
    version: MCP_SERVER_VERSION,
    kill_reason: epitaphKillReason,
    kill_initiator_pid: epitaphKillInitiatorPid,
    last_tool_call_ts: epitaphLastToolCallTs,
    lease_state: epitaphLeaseState,
    watcher_started: epitaphWatcherStarted,
    uptime_s: Math.floor(process.uptime()),
    trigger: triggerEvent,
    channel_dead_at_death: channelHealth?.channel_dead ?? false,
    channel_dead_age_ms_at_death: channelHealth?.channel_dead_age_ms ?? 0,
    pending_count_at_death: channelHealth?.pending_count ?? 0,
  };
  try {
    logEvent({
      event: 'auto_update_runner.epitaph',
      level: 'info',
      msg: `agent-bridge MCP child epitaph: pid=${process.pid} v=${MCP_SERVER_VERSION} reason=${epitaphKillReason}`,
      context: epitaphContext,
    });
  } catch { /* best-effort — epitaph must never throw */ }
  // 4.0.x — also emit a clean `process.epitaph` semantic event. The
  // historical name (`auto_update_runner.epitaph`) is preserved above
  // for back-compat with grep/jq tooling pinned to that string, but the
  // event applies to ANY child death (orphan-suicide, SIGTERM, SIGKILL
  // backstop, fatal_transport_exit, panic), not just auto-update runs.
  // A query for `process.epitaph` is the canonical way to find "when
  // did this MCP child die and why?" going forward.
  try {
    logEvent({
      event: 'process.epitaph',
      level: 'info',
      msg: `agent-bridge MCP child died: pid=${process.pid} v=${MCP_SERVER_VERSION} reason=${epitaphKillReason}`,
      context: epitaphContext,
    });
  } catch { /* best-effort — epitaph must never throw */ }
  // Also breadcrumb-log so post-mortem tooling has it on disk even if
  // logEvent's filesystem path is wedged.
  try {
    syncExitBreadcrumb('auto_update_runner.epitaph', {
      version: MCP_SERVER_VERSION,
      kill_reason: epitaphKillReason,
      kill_initiator_pid: epitaphKillInitiatorPid,
      last_tool_call_ts: epitaphLastToolCallTs,
      lease_state: epitaphLeaseState,
      watcher_started: epitaphWatcherStarted,
      trigger: triggerEvent,
    });
  } catch { /* best-effort */ }
}

process.on('exit', (code) => {
  syncExitBreadcrumb('process.exit_event', { code });
  writeEpitaph(`process.exit_event(code=${code})`);
});

process.stderr.on('error', (err) => {
  // stderr is diagnostic only. Claude Code may close it between tool turns;
  // logger.ts already writes the durable file log first, so swallow stderr
  // broken-pipe errors instead of letting them kill a channel-owner watcher.
  if (isBrokenPipe(err)) return;
  try { logError(`stderr error: ${err}`); } catch {}
});

process.stdout.on('error', (err) => {
  // stdout is the JSON-RPC transport. If that pipe breaks, the MCP connection
  // is gone and channel notifications cannot be delivered to Claude anymore.
  if (isBrokenPipe(err)) {
    fatalTransportExit('stdout.broken_pipe_exit', 'stdout broken pipe — JSON-RPC/channel transport closed; releasing watcher lease before exit', err);
  }
  try { logError(`stdout error: ${err}`); } catch {}
});

process.on('unhandledRejection', (err) => {
  if (isBrokenPipe(err)) {
    fatalTransportExit('unhandled_rejection.broken_pipe_exit', 'Unhandled rejection EPIPE — parent pipe closed; releasing watcher lease before exit', err);
  }
  logError(`Unhandled rejection: ${err}`);
});
process.on('uncaughtException', (err) => {
  if (isBrokenPipe(err)) {
    fatalTransportExit('uncaught_exception.broken_pipe_exit', 'Uncaught exception EPIPE — parent pipe closed; releasing watcher lease before exit', err);
  }
  logError(`Uncaught exception: ${err}`);
});

// SIGPIPE: Node normally ignores SIGPIPE and surfaces broken pipes as stream
// EPIPE errors. Keep that behaviour. Claude Code can close diagnostic pipes
// between tool turns; an undifferentiated SIGPIPE must not kill a channel-owner
// watcher. stdout EPIPE is still handled above by process.stdout.on('error').
process.on('SIGPIPE', () => {
  try {
    logEvent({
      event: 'sigpipe.ignored',
      level: 'warn',
      msg: 'SIGPIPE ignored; stream-specific EPIPE handlers decide liveness',
      context: { pid: process.pid },
    });
  } catch {}
});

// 4.0.0 — `readParentCommandLine` and `parentLooksChannelCapable` now
// live in `persona.ts` so the same helpers can be unit-tested in
// isolation AND so Patch F's IIFE + `main()` agree on the parent
// detection algorithm by construction.

async function main(): Promise<void> {
  // Ensure all directories exist
  ensureDirectories();

  // Initialize the inbox system (dirs, processed IDs, cache, prune timer)
  // 4.0.0 — pass `isChannelOwner` so tools-only children do not run the
  // legacy `inbox/claude-code/` → `inbox/claude-code/default/` migration.
  // That migration is reserved for the legitimate default-persona owner.
  initInbox({ isChannelOwner: identity.mode === 'channel-owner' });

  const localName = getLocalMachineName();
  // 4.0.0 — Identity is resolved at module load (see top of file). Log
  // a banner that reflects the actual mode/persona so post-mortems do
  // not have to grep multiple events to figure out what this child is
  // doing.
  if (identity.mode === 'channel-owner') {
    logInfo(
      `agent-bridge mcp-server starting on "${localName}" `
      + `(unified plugin: tools + channel watcher) — `
      + `persona="${identity.persona}" target="${identity.target}" reason=${identity.reason}`,
    );
  } else {
    logInfo(
      `agent-bridge mcp-server starting on "${localName}" `
      + `(tools-only mode: no inbox lease, no channel watcher) — `
      + `reason=${identity.reason}. Set ${AGENT_BRIDGE_PERSONA_ENV}=<persona> to enable channel mode `
      + `(see README "Personas + Setup").`,
    );
  }
  logEvent({
    event: 'server.starting',
    msg: `agent-bridge MCP server starting on "${localName}"`,
    context: {
      machineName: localName,
      version: VERSION,
      pid: process.pid,
      nodeVersion: process.version,
      persona: identity.persona,
      target: identity.target,
      mode: identity.mode,
      identity_reason: identity.reason,
      raw_persona_env: identity.rawPersonaEnv,
      // Truncate the parent cmdline to keep the log line bounded; the
      // diagnostic value is "is it Claude or not" not the full argv.
      parent_cmdline: identity.parentCommandLine.slice(0, 256),
    },
  });

  // Create MCP server with channel capability + tools capability.
  const server = new McpServer(
    {
      name: 'agent-bridge',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
      instructions: [
        `You are connected to the agent-bridge unified plugin on machine "${localName}".`,
        'This server enables real-time communication between RUNNING AI agent sessions on different machines.',
        'It does NOT spawn new agent processes — it connects existing, already-running sessions.',
        '',
        'CHANNEL MODE (push-based):',
        'Incoming messages from other machines are PUSHED into this conversation automatically.',
        'They appear as: <channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>',
        'You do NOT need to poll — messages arrive in real time when the remote agent sends them.',
        'Respond using the bridge_send_message tool, passing the sender\'s machine name and an explicit target. If the incoming message metadata includes from_target, use that as the reply target. Otherwise bridge_send_message defaults from_target to the active claude-code/<persona> (usually claude-code/default) so the remote agent can reply over agent-bridge; set one_way=true only for deliberate one-way injection.',
        '',
        'AGENT-DRIVEN REPLY ROUTING (unified across Claude Code + OpenClaw, openclaw-channel v3.0+):',
        'When you receive an inbound bridge message, YOU decide where the reply goes — the routing layer never auto-fans out replies on your behalf. Two legs are involved:',
        '  1. Bridge leg (implicit, expected when from_target is set): call bridge_send_message with target=<from_target> and machine=<sender machine> to reply over the bridge to the originating peer.',
        '  2. User-facing leg (additional): if there is also a human user reading this conversation (Telegram, Slack, Discord, etc.), send a compact 1-3 sentence summary of the bridge exchange via the harness\'s configured user-facing reply tool. Use the relay scaffold when present: it already labels the source endpoint + source agent-bridge version and the destination endpoint + destination agent-bridge version so the user can spot fleet-wide version drift without seeing the full bridge body. If you must compose a fallback manually, read source_agent_bridge_version and destination_agent_bridge_version from channel metadata (or call claude_code_channel_status for the local destination version); do NOT hardcode. If the user asks to expand an OpenClaw `[Agent Bridge relay]` notice by its `expand id`, run `agent-bridge relay-expand <id>` on that same machine and send the retrieved full content subject to normal privacy/channel rules. The "Relay inbound bridge messages to the user" rule (canonical doc: docs/relay-to-user.md) covers the wording / triggers.',
        'Both legs are independent tool calls. Pick zero, one, or both depending on context. The same model applies on OpenClaw via openclaw-channel v3.0+: the inbound message is surfaced into the agent\'s session with a [BRIDGE-CONTEXT] block listing from_target + suggested user-facing channels, and the agent calls the appropriate reply tools.',
        '',
        'Available tools:',
        '- bridge_list_machines: List paired machines and their connection details',
        '- bridge_status: Check if a machine is reachable via SSH',
        '- bridge_send_message: Send a message to a running agent on another machine',
        '- bridge_learnings_search: Search the fleet-wide SHARED CONTEXT learnings store (see SHARED CONTEXT below)',
        '- bridge_learnings_add: Record a fleet-wide learning in the shared-context store (replicates to all paired machines)',
        '- bridge_receive_messages: Manually check for messages (usually not needed — channel pushes them)',
        '- bridge_run_command: Run a shell command on a remote machine',
        '- bridge_clear_inbox: Clear all messages from the local inbox',
        '- bridge_inbox_stats: Get inbox statistics and watcher health',
        '- claude_code_channel_status: Diagnostic — returns plugin pid/uptime/lease/version (rarely called directly)',
        '',
        'Communication flow:',
        '1. Machine A\'s Claude calls bridge_send_message to deliver a message to Machine B via SSH',
        '2. Machine B\'s file watcher detects the new message file',
        '3. Machine B\'s plugin pushes the message into the running Claude session',
        '4. Machine B\'s Claude sees it and responds via bridge_send_message back to Machine A using the incoming from_target when present; Claude Code-originated sends include from_target=claude-code/<persona> by default',
        '',
        'All communication is authenticated via SSH keys (managed in ~/.agent-bridge/keys/).',
        'Messages have a TTL (default 1 day). Expired messages are auto-pruned.',
        'Machines are paired using the `agent-bridge pair` CLI command.',
        '',
        'HOW TO TALK TO THE OTHER AGENT:',
        'bridge_send_message is the ONLY supported way to communicate with the running agent on another machine. When your user says "ask Claude on <machine>", "talk to <machine>", "check in with the other agent", "have a conversation", or anything in that spirit — they mean send a NATURAL-LANGUAGE message via bridge_send_message, as if you were speaking to a colleague. NOT a structured ping, status probe, or machine-readable payload. Write the message in English (or whatever language the conversation is in) the same way you would answer the user directly.',
        'As of agent-bridge 3.4.0, bridge_send_message requires target. For round-trip conversations, from_target names the sender\'s local return target. Claude Code defaults this to the active claude-code/<persona> (usually claude-code/default); pass one_way=true only when no bridge reply should be possible.',
        'There is NO other mechanism for agent-to-agent communication in this system. Do not attempt to shell out to `claude --print`, `codex exec`, `agent-bridge run <machine> "..." --claude`, or any other command that spawns a fresh non-interactive agent session on the remote machine. Those fresh-spawn wrappers were intentionally removed in agent-bridge 3.0.0 — they defeat the entire purpose of this plugin, which is to connect EXISTING, already-running agent sessions.',
        'Use bridge_run_command ONLY for plain shell diagnostics (check a process, read a file, look at a log, run `git status`) — never as a substitute for asking the remote agent a question, and never to invoke an agent CLI like `claude`, `codex`, or `aider` on the remote machine.',
        'Use bridge_status / bridge_inbox_stats ONLY when the user is asking about connectivity or queue health — never instead of actually asking the other agent how things are going.',
        'The default interpretation of "ask X" is conversational (via bridge_send_message), not diagnostic.',
        '',
        'SHARED CONTEXT — FLEET-WIDE LEARNINGS (4.9.0+):',
        'The fleet keeps a GLOBAL shared store of learnings/findings at ~/.agent-bridge/shared-context/learnings.ndjson, replicated across every paired machine. Any agent on any machine (Claude Code, OpenClaw, Codex, ...) can search it and contribute to it.',
        'You CAN (and should) search it when debugging or starting unfamiliar work — another agent on another machine may have already solved your exact problem. Use bridge_learnings_search({ query }) or `agent-bridge learnings search <keyword>` before re-deriving a fix from scratch.',
        'You MUST record any learning you make that could apply fleet-wide: OS/tool gotchas, infra fix recipes, auth/API quirks, cross-machine workflows. Use bridge_learnings_add({ title, body, tags }) or `agent-bridge learnings add --title ... --body ... --tags ...`. Write the body in symptom/cause/fix/guard prose when it is bug-shaped.',
        'ADDITIVE ONLY — the shared context NEVER replaces or reroutes your harness-native memory. Keep recording everything exactly where you would have recorded it anyway (your harness memory system, the repo\'s LEARNINGS.md, workspace rules/notes); THEN also add a copy of the fleet-wide-applicable subset here. Never skip or relocate a native memory write because the shared store has (or will have) the content, and never import/migrate existing harness memories into the store as a relocation. If unsure, write both.',
        'Scope discipline: GLOBAL learnings only. Project-local fixes belong in that repo\'s LEARNINGS.md (and stay there); machine- or harness-private notes belong in the harness\'s own memory (and stay there). If it would only ever help an agent inside one repo, it does not go here. The store adds a fleet-wide COPY on top of those systems — it is not a routing destination that takes over from them.',
        'Replication is automatic on add (best-effort push to every paired peer) and self-heals via `agent-bridge learnings sync` when a peer was offline. Entries are deduped by lowercase-uuid id, so replays are harmless.',
        '',
        'RESUME THE USER-FACING THREAD AFTER PROCESSING BRIDGE MESSAGES:',
        'After you finish processing inbound bridge messages — especially flurries / multi-step exchanges with other agents — explicitly check whether you have an unfinished thread with the user on Telegram (or whichever user-facing channel is active) and resume it. Do not go silent on the user just because the bridge work is done. Pick up wherever the human-facing conversation last left off, address any user-asked question that is still pending, and post a status update if the bridge work changed anything user-relevant. Bridge processing is a side-channel; the user thread is the primary thread. Concretely: when a bridge round-trip ends and the most recent message in the user-facing channel was from the user (or from you mid-step), send a follow-up there before considering the turn complete.',
        'Established 2026-05-01 (Ethan voice 5954): repeated incidents where an agent processed a bridge flurry, completed it, and then forgot it was mid-thread with the user on Telegram, leaving the human conversation hanging.',
        '',
        'INVESTIGATING WHO-DID-WHAT (history forensics):',
        'For "which agent on which machine did X" / "who worked on Y" questions, FIRST grep local session storage on every reachable machine before bridging the agent. Bridge round-trips are for live communication ("do this", "what are you thinking"); they are the wrong tool for past-activity forensics. Every agent writes its full session trajectory + tool-call history to local disk on the machine it ran on, which is the canonical record of "what did agent X actually do".',
        'Storage paths to grep:',
        '- Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl (the absence of a project dir for a given cwd is itself strong evidence Claude Code never had cwd there)',
        '- OpenClaw: ~/.openclaw/agents/main/sessions/*.jsonl + ~/.openclaw/workspace/memory/.dreams/events.jsonl (search both)',
        '- Codex: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl (the first JSON record in each file has a `payload.cwd` field — quick way to filter by working directory)',
        'On the LOCAL machine: read these directly via Read/Bash. On a REMOTE paired machine: use bridge_run_command (e.g. `find ~/.openclaw/agents/main/sessions -name "*.jsonl" -mtime -10 | xargs grep -l "<keyword>"`). One bridge_run_command beats N bridge_send_message round-trips because the remote agent does not have to be alive or responsive to answer history questions — the disk does.',
        'Established 2026-05-01 (Ethan voice 1723–1731 incident: investigating who shipped the macos-stats-widget 04-30 commits, MBP-Claude burned ~10 bridge round-trips before finding the answer in 5 local OpenClaw session jsonls referencing the actual commit SHAs).',
      ].join('\n'),
    },
  );

  // 3.9.0 [CONSUME-RACE] — Wrap server.registerTool so EVERY tool invocation
  // (not just claude_code_channel_status) increments toolCallsReceivedCount.
  // The count drives the alive-heuristic in watcher.ts: a fresh tool call
  // since a pending-ack push is positive evidence that the harness is awake
  // and processing, which lets us finalize the pending entry on the
  // early-defer (5 s) path instead of waiting the full 60 s safety net.
  const TOOL_BOOT_TIME_MS = Date.now();
  let toolCallsReceivedCount = 0;
  let channelCallbackRegisteredAt = 0;
  // 4.0.1 [DEAD-FALSE-POSITIVE 2026-05-04] — count of tool handlers
  // currently executing. Bumped in the wrapped shim BEFORE handler(...args),
  // decremented in the finally clause AFTER. Surfaced to the watcher's
  // alive-heuristic so the escape-hatch can distinguish "harness alive but
  // busy on a long tool" from "harness genuinely frozen".
  let toolCallsInFlight = 0;
  // 3.14.4 — track ts of the most recent tool call so the post-mortem
  // epitaph can record "when did this MCP child last serve a tool call"
  // (helps distinguish "mid-session kill" from "idle plugin reaped").
  let lastToolCallTs: number | null = null;
  registerAliveSignals({
    getToolCallsReceivedCount: () => toolCallsReceivedCount,
    getChannelCallbackRegisteredAt: () => channelCallbackRegisteredAt,
    getToolCallsInFlight: () => toolCallsInFlight,
  });
  const origRegisterTool = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, schema: unknown, handler: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async (...args: any[]) => {
      toolCallsReceivedCount += 1;
      toolCallsInFlight += 1;
      lastToolCallTs = Date.now();
      // 4.0.1 [DEAD-FALSE-POSITIVE 2026-05-04] — recovery hook. If the
      // channel was previously marked dead, this fresh tool call proves
      // the harness is responsive and the dead-mark was stale (e.g. a
      // false positive from a burst during a long-running tool, or a
      // legitimate dead-mark followed by reload). Either way, clearing
      // here lets future pushes flow through the normal callback path
      // again — without this, the channel stayed sticky-dead until
      // process restart, which is what the cross-fleet test surfaced.
      // No-op when channel is healthy.
      recordHarnessAck();
      try {
        return await handler(...args);
      } finally {
        toolCallsInFlight -= 1;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origRegisterTool as any)(name, schema, wrapped);
  };

  // Register all 7 user-facing bridge tools.
  registerTools(server);

  // 3.7.0 — `claude_code_channel_status` no-op informational tool.
  // Originally added in 3.6.3 (Patch H) to keep a tool-only channel plugin
  // alive in Claude Code's plugin host. With 3.7.0 unifying tools + channel,
  // the plugin already has 7 user-facing tools that get called frequently —
  // so this is no longer load-bearing for liveness. We keep it because it's
  // a useful diagnostic probe (returns pid, uptime, watcher lease state,
  // version). Not harmful, and the tool-registration test still asserts on
  // it.
  server.registerTool(
    'claude_code_channel_status',
    {
      title: 'Claude Code Channel Status',
      description:
        'Returns the current agent-bridge plugin status (pid, uptime, lease, version). '
        + 'Used internally to verify the channel host is healthy. The bridge_send_message '
        + 'tool is what you actually use to send messages.',
    },
    async () => {
      // 3.9.0 [CONSUME-RACE] — toolCallsReceivedCount is incremented by the
      // server.registerTool shim above, BEFORE the handler runs. We do not
      // double-count here (the shim already covers this tool).
      const leaseTarget = identity.target ?? null;
      const leasePath = leaseTarget
        ? join(LOCKS_DIR, leaseFileNameForTarget(leaseTarget))
        : null;
      let lease: Record<string, unknown> | null = null;
      let watcherActive = false;
      try {
        if (leasePath && existsSync(leasePath)) {
          const raw = readFileSync(leasePath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          lease = parsed;
          watcherActive = Number(parsed?.pid) === process.pid;
        }
      } catch {
        // best-effort — never fail the tool because the lease file is in flux
      }
      const status = {
        pid: process.pid,
        ppid: process.ppid,
        uptime_s: Math.floor(process.uptime()),
        version: VERSION,
        machine: localName,
        // 4.0.0 — surface persona + target so the diagnostic tool can
        // distinguish two channel-owner Claude Code instances on the
        // same machine (e.g. `default` vs `yolo`).
        persona: identity.persona,
        target: identity.target,
        mode: identity.mode,
        identity_reason: identity.reason,
        watcher_active: watcherActive,
        lease,
        tool_boot_time_ms: TOOL_BOOT_TIME_MS,
        tool_calls_received_count: toolCallsReceivedCount,
      };
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(status, null, 2) },
        ],
      };
    },
  );

  // 4.0.0 — Watcher ownership is fully driven by the persona resolution
  // computed at module load. Persona env var set OR cmdline-fallback
  // matched ⇒ `identity.mode === 'channel-owner'` and we attempt to
  // claim the lease. Anything else ⇒ tools-only.
  //
  // Lease arbitration (single owner with stale-lock recovery) lives in
  // watcher.ts:tryAcquireWatcherLease — multiple agent-bridge processes
  // for the SAME persona can start, but only one holds the lease at any
  // moment. Late starters go to standby and retry every 2 s. Distinct
  // personas on the same machine (e.g. `default` vs `yolo`) keep
  // separate lease files keyed by `claude-code/<persona>` so they never
  // contend.
  const bridgeRole = identity.mode; // 'channel-owner' | 'tools-only'
  const watcherDisabled = bridgeRole === 'tools-only';
  let watcherStarted = false;
  // Track the timestamp of the most recent channel push so signal evidence
  // logging can report how recently the channel was active.
  let lastNotificationAtMs: number | null = null;

  // Emit `watcher.role_demoted_non_channel_parent` for backward
  // compatibility with existing log dashboards that grep for it. The
  // condition is now: persona env unset AND cmdline-fallback negative.
  if (
    bridgeRole === 'tools-only'
    && (identity.reason === 'tools_only_no_channel_flag'
      || identity.reason === 'tools_only_no_parent_cmdline')
  ) {
    logWarn(
      `${AGENT_BRIDGE_PERSONA_ENV} unset and parent process does not look channel-capable; `
      + 'this MCP child runs in tools-only mode (no inbox lease, no channel watcher). '
      + 'Set AGENT_BRIDGE_PERSONA=<persona> in your shell alias to enable channel mode.',
    );
    logEvent({
      event: 'watcher.role_demoted_non_channel_parent',
      level: 'warn',
      msg: 'Tools-only mode: persona env unset and parent lacks Claude channel flags',
      context: {
        pid: process.pid,
        parentPid: process.ppid,
        requestedRole: 'channel-owner',
        parentCommandLine: identity.parentCommandLine,
        identity_reason: identity.reason,
      },
    });
  }

  if (watcherDisabled) {
    logInfo(
      `Watcher disabled (tools-only mode, reason=${identity.reason}) `
      + '— this process exposes outbound tools only (no inbox polling, no channel push, no markDelivered).',
    );
    logEvent({
      event: 'watcher.disabled',
      msg: 'Watcher disabled (tools-only mode)',
      context: {
        reason: identity.reason,
        pid: process.pid,
      },
    });
  } else {
    // Start the inbox file watcher with channel notification callback.
    // When new messages arrive, we push them into Claude's conversation
    // via the MCP channel notification protocol.
    // 3.9.0 [CONSUME-RACE] — record the moment the channel callback becomes
    // active. Used by the alive-heuristic in watcher.ts: if the callback was
    // registered AFTER a pending entry's pushedAt, the fresh registration
    // implies a plugin reload / channel-owner change that resets harness
    // state, so we treat it as positive alive evidence (the new owner will
    // pick up replays).
    channelCallbackRegisteredAt = Date.now();
    watcherStarted = await startWatcher(
      (newFiles) => {
        logInfo(`New messages detected: ${newFiles.length} file(s)`);
      },
      (message: BridgeMessage) => {
        // Push the message into the running Claude session via channel notification.
        // This makes it appear as <channel source="agent-bridge" ...>content</channel>
        // in Claude's conversation — no polling needed.
        lastNotificationAtMs = Date.now();
        logInfo(`Pushing channel notification for message ${message.id} from ${message.from}`);
        logEvent({
          event: 'message.pushed_to_channel',
          msg: `Pushing channel notification for message ${message.id} from ${message.from}`,
          context: {
            msg_id: message.id,
            from: message.from,
            to: message.to,
            type: message.type,
            reply_to: message.replyTo,
            content_length: message.content?.length ?? 0,
          },
        });

        // [RELAY-SCAFFOLD 2026-05-09 — agent-bridge 4.2.0]
        // Build the structural relay-notice scaffold via the shared formatter
        // (`lib/relay-notice.js`, also used by openclaw-channel). The scaffold
        // is prepended to the channel content inside `[RELAY-SCAFFOLD-START]`
        // / `[RELAY-SCAFFOLD-END]` fences, with a `{{SUMMARY_PLACEHOLDER}}`
        // sentinel where the agent fills in a 1-3 sentence Summary blockquote
        // before forwarding to the user-facing channel (Telegram on CC).
        // This replaces the previous "agent hand-composes the entire relay
        // from prose guidance" pattern, which drifted from OC's programmatic
        // shape over time. Canonical user-facing format: docs/relay-to-user.md.
        //
        // [RELAY-EXPAND-STORE-CC 2026-05-12 — agent-bridge 4.7.1]
        // Populate the shared relay-expand store under
        // `~/.agent-bridge/relay-expand/` so `agent-bridge relay-expand <id>`
        // can resolve the full inbound BridgeMessage later, then thread the
        // allocated `expandId` into the scaffold so the relay receipt
        // includes `expand id: NN` + `expand: agent-bridge relay-expand NN`
        // lines, byte-identical to OC's emit shape (parity with OpenClaw's
        // `prepareBridgeRelayContext` in openclaw-channel/src/index.js).
        // Failures here are non-fatal: we still emit the scaffold without
        // the expand-id lines so the relay leg keeps working.
        const replyPathDisplay = message.fromTarget ? 'agent-bridge' : '';
        let expandId: string | null = null;
        try {
          const record = storeRelayExpandMessage(
            {
              id: message.id,
              from: message.from,
              to: message.to,
              fromTarget: message.fromTarget,
              target: message.target,
              sourceAgentBridgeVersion: message.sourceAgentBridgeVersion,
              type: message.type,
              content: message.content,
              timestamp: message.timestamp,
              replyTo: message.replyTo,
              ttl: message.ttl,
            },
            {
              replyVia: replyPathDisplay,
              sourceAgentBridgeVersion: message.sourceAgentBridgeVersion,
              destinationAgentBridgeVersion: VERSION,
              agentBridgeVersion: VERSION,
            },
          );
          expandId = record?.expandId ?? null;
        } catch (err) {
          logWarn(
            `relay-expand store failed for ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const relayScaffold = formatRelayScaffold(
          {
            id: message.id,
            from: message.from,
            to: message.to,
            fromTarget: message.fromTarget,
            target: message.target,
            sourceAgentBridgeVersion: message.sourceAgentBridgeVersion,
            relaySummary: message.relaySummary,
          },
          {
            replyVia: message.fromTarget ? 'agent-bridge' : undefined,
            destinationAgentBridgeVersion: VERSION,
            ...(expandId ? { expandId } : {}),
          },
        );
        const contentWithScaffold = `${relayScaffold}\n\n${message.content}`;

        return server.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: contentWithScaffold,
            meta: {
              from: message.from,
              to: message.to,
              message_id: message.id,
              ...(message.target ? { target: message.target } : {}),
              ...(message.fromTarget ? { from_target: message.fromTarget } : {}),
              type: message.type,
              ts: message.timestamp,
              ...(message.replyTo ? { reply_to: message.replyTo } : {}),
              ...(message.ttl !== undefined ? { ttl: String(message.ttl) } : {}),
              authenticated: 'ssh-key',
              // [AGENT-BRIDGE-DUAL-VERSION-RELAY 2026-05-10]
              // Surface both sides of the relay version identity. Older
              // senders omit sourceAgentBridgeVersion, so keep the legacy
              // agent_bridge_version alias as the destination/local version
              // for agents that have not learned the split fields yet.
              ...(message.sourceAgentBridgeVersion
                ? { source_agent_bridge_version: message.sourceAgentBridgeVersion }
                : {}),
              ...(message.relaySummary
                ? { relay_summary: message.relaySummary }
                : {}),
              destination_agent_bridge_version: VERSION,
              agent_bridge_version: VERSION,
              // [RELAY-SCAFFOLD-IN-META 2026-05-09]
              // Same scaffold also exposed as a meta field so harnesses /
              // tooling that prefer parsing meta over scanning content can
              // lift it directly. The content-embedded copy remains the
              // primary delivery path so the agent sees it inline with the
              // bridge body.
              relay_scaffold: relayScaffold,
              // [RELAY-EXPAND-ID-IN-META 2026-05-12 — agent-bridge 4.7.1]
              // Surface the allocated expand id (when the store-write
              // succeeded) so tooling/agents can pre-emptively run
              // `agent-bridge relay-expand <id>` without scraping the
              // scaffold body. Mirrors how `expand id:` appears inline.
              ...(expandId ? { expand_id: expandId } : {}),
            },
          },
        }).catch((err) => {
          logError(`Failed to push channel notification for ${message.id}: ${err}`);
          logEvent({
            event: 'message.push_failed',
            level: 'error',
            msg: `Failed to push channel notification for ${message.id}`,
            context: {
              msg_id: message.id,
              from: message.from,
              error: String(err),
              decision: 'leave_pending_for_next_owner',
            },
          });
          throw err;
        });
      },
      { role: bridgeRole || 'auto' },
    );

    if (!watcherStarted) {
      logWarn(
        'Watcher not started because another process already owns claude-code inbox delivery. '
        + 'This process remains tools-capable but will not push inbound channel messages.',
      );
      logEvent({
        event: 'watcher.standby',
        level: 'warn',
        msg: 'Watcher standby: another process owns claude-code inbox delivery',
        context: { pid: process.pid, role: bridgeRole || 'auto' },
      });
    }
  }

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logInfo('agent-bridge MCP server connected and ready (unified tools + channel)');
  logEvent({
    event: 'server.ready',
    msg: 'agent-bridge MCP server connected and ready (unified tools + channel)',
    context: { machineName: localName },
  });

  const resolveChimeServiceScript = (): string | null => {
    const candidates: string[] = [];
    if (process.env.AGENT_BRIDGE_SOURCE_DIR) {
      candidates.push(process.env.AGENT_BRIDGE_SOURCE_DIR);
    }
    const home = homedir();
    candidates.push(
      join(home, '.openclaw', 'workspace', 'agent-bridge'),
      join(home, 'Projects', 'agent-bridge'),
      join(home, 'projects', 'agent-bridge'),
      join(home, 'agent-bridge'),
      join(home, 'src', 'agent-bridge'),
    );
    for (const dir of candidates) {
      const probe = join(dir, 'chime', 'service.mjs');
      if (existsSync(probe) && existsSync(join(dir, '.git'))) {
        return probe;
      }
    }
    return null;
  };

  if (!watcherDisabled) {
    const chimeServiceScript = resolveChimeServiceScript();
    if (chimeServiceScript) {
      try {
        const child = spawn(process.execPath, [chimeServiceScript, '--ensure'], {
          stdio: 'ignore',
          detached: false,
          env: process.env,
        });
        child.on('error', (err) => {
          logEvent({
            event: 'chime.ensure_failed',
            level: 'warn',
            msg: 'Failed to ensure Agent Bridge chime service',
            context: { error: String(err), script: chimeServiceScript },
          });
        });
      } catch (err) {
        logEvent({
          event: 'chime.ensure_failed',
          level: 'warn',
          msg: 'Failed to spawn Agent Bridge chime service',
          context: { error: String(err), script: chimeServiceScript },
        });
      }
    } else {
      logEvent({
        event: 'chime.ensure_skipped',
        msg: 'Skipped chime service ensure: no source checkout found',
        context: {},
      });
    }
  }

  // Replay any messages that arrived while Claude was offline.
  // This must happen AFTER server.connect() so channel notifications
  // can actually be delivered to the client. Only the active watcher owner
  // may replay; a standby or tools-only process must leave backlog ownership
  // untouched for the real Claude session.
  if (watcherStarted) {
    void replayUndeliveredMessages();
  }

  // [AUTO-UPDATE-CHECK 2026-04-29] / [AUTO-UPDATE-RE-PROBE 2026-04-30] —
  // Fire-and-forget background probe of origin/main. The script
  // (`scripts/check-update.sh` in the source checkout) is silent unless
  // origin is strictly ahead of the local checkout AND the same SHA
  // hasn't already triggered a notification (sentinel at
  // ~/.agent-bridge/.last-update-notified-head). When it does notify, it
  // drops a [BRIDGE-UPDATE-AVAILABLE] message into the local claude-code
  // inbox (and any other harness inbox subdirs), which the channel
  // watcher above pushes into the running session — exactly the delivery
  // path Ethan asked for in voice 327.
  //
  // 3.11.0 — the probe now runs PERIODICALLY (every 3 h) on top of the
  // initial 30 s post-boot probe. The previous one-shot timer left
  // long-lived channel-owner children stuck on a stale checkout if the
  // user didn't `/reload-plugins` between an upstream push and the
  // 30 s window. Voice 5736 spec: re-probe every 3 hours. Standby
  // children that get promoted to channel-owner via the watcher's
  // standby-retry path also (re)arm the probe + interval at promotion
  // time (see `subscribeToPromotion` below) so a process that booted as
  // standby and only later took over the lease still runs the probe.
  //
  // ON by default. Disable with AGENT_BRIDGE_AUTO_UPDATE_CHECK=0
  // (or false / off / no / disabled). Only the channel-owner runs the
  // probe so a single host with multiple bridge MCP children doesn't
  // multi-notify.
  const AUTO_UPDATE_PROBE_INITIAL_DELAY_MS = 30_000;
  const AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS = 3 * 60 * 60 * 1000; // 3 hours
  // 3.11.1 [AUTO-UPDATE-TEST-MODE 2026-04-30] — operator can override the
  // periodic interval via env for live regression tests of the auto-update
  // flow without waiting 3h. Bounds: 30 s ≤ override ≤ 24 h. Out-of-range
  // or unparseable values fall back to the 3 h default with a warn log.
  // Kill switch (AGENT_BRIDGE_AUTO_UPDATE_CHECK) wins over this — if the
  // probe is disabled outright, the override is irrelevant. The initial
  // 30 s delayed first probe is unaffected; only the interval is configurable.
  const AUTO_UPDATE_INTERVAL_MIN_MS = 30_000;
  const AUTO_UPDATE_INTERVAL_MAX_MS = 24 * 60 * 60 * 1000;
  const resolveAutoUpdateIntervalMs = (): { intervalMs: number; source: 'env' | 'default'; rawValue?: string; reason?: string } => {
    const raw = process.env.AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS;
    if (raw === undefined || raw.trim() === '') {
      return { intervalMs: AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS, source: 'default' };
    }
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return {
        intervalMs: AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS,
        source: 'default',
        rawValue: raw,
        reason: 'unparseable_or_non_positive_integer',
      };
    }
    if (parsed < AUTO_UPDATE_INTERVAL_MIN_MS || parsed > AUTO_UPDATE_INTERVAL_MAX_MS) {
      return {
        intervalMs: AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS,
        source: 'default',
        rawValue: raw,
        reason: 'out_of_bounds',
      };
    }
    return { intervalMs: parsed, source: 'env', rawValue: raw };
  };

  let autoUpdateInitialTimer: NodeJS.Timeout | null = null;
  let autoUpdateIntervalTimer: NodeJS.Timeout | null = null;
  let autoUpdateProbeArmed = false;

  const isAutoUpdateDisabled = (): boolean => {
    const killSwitch = (process.env.AGENT_BRIDGE_AUTO_UPDATE_CHECK ?? '1').trim().toLowerCase();
    return ['0', 'false', 'off', 'no', 'disabled'].includes(killSwitch);
  };

  const resolveAutoUpdateScript = (): { scriptPath: string | null; candidates: string[] } => {
    const candidates: string[] = [];
    if (process.env.AGENT_BRIDGE_SOURCE_DIR) {
      candidates.push(process.env.AGENT_BRIDGE_SOURCE_DIR);
    }
    const home = homedir();
    candidates.push(
      join(home, '.openclaw', 'workspace', 'agent-bridge'),
      join(home, 'Projects', 'agent-bridge'),
      join(home, 'projects', 'agent-bridge'),
      join(home, 'agent-bridge'),
      join(home, 'src', 'agent-bridge'),
    );
    for (const dir of candidates) {
      const probe = join(dir, 'scripts', 'check-update.sh');
      if (existsSync(probe) && existsSync(join(dir, '.git'))) {
        return { scriptPath: probe, candidates };
      }
    }
    return { scriptPath: null, candidates };
  };

  const runAutoUpdateProbe = (scriptPath: string, trigger: string): void => {
    // Re-check the kill switch on every fire — operator can flip it via env
    // without restarting the MCP server (interval keeps running but spawns
    // become no-ops when disabled).
    if (isAutoUpdateDisabled()) {
      try {
        logEvent({
          event: 'auto_update_check.skipped_disabled_at_fire',
          msg: 'auto-update-check skipped on fire: disabled via env',
          context: { trigger, value: process.env.AGENT_BRIDGE_AUTO_UPDATE_CHECK },
        });
      } catch { /* best-effort */ }
      return;
    }
    try {
      const child = spawn('bash', [scriptPath], {
        stdio: 'ignore',
        detached: false,
        env: process.env,
      });
      child.on('error', (err) => {
        try {
          logEvent({
            event: 'auto_update_check.spawn_error',
            level: 'warn',
            msg: 'auto-update-check script spawn failed',
            context: { error: String(err), script: scriptPath, trigger },
          });
        } catch { /* best-effort */ }
      });
      child.on('exit', (code) => {
        try {
          logEvent({
            event: 'auto_update_check.exit',
            msg: `auto-update-check exited code=${code}`,
            context: { code, script: scriptPath, trigger },
          });
        } catch { /* best-effort */ }
      });
      child.unref();
    } catch (err) {
      try {
        logEvent({
          event: 'auto_update_check.spawn_threw',
          level: 'warn',
          msg: 'auto-update-check spawn threw',
          context: { error: String(err), trigger },
        });
      } catch { /* best-effort */ }
    }
  };

  const armAutoUpdateProbe = (trigger: string): void => {
    if (autoUpdateProbeArmed) return;
    if (isAutoUpdateDisabled()) {
      try {
        logEvent({
          event: 'auto_update_check.disabled',
          msg: 'auto-update-check disabled via AGENT_BRIDGE_AUTO_UPDATE_CHECK env var',
          context: { value: process.env.AGENT_BRIDGE_AUTO_UPDATE_CHECK, trigger },
        });
      } catch { /* best-effort */ }
      return;
    }
    const { scriptPath, candidates } = resolveAutoUpdateScript();
    if (!scriptPath) {
      try {
        logEvent({
          event: 'auto_update_check.no_source_dir',
          msg: 'auto-update-check skipped: no agent-bridge source checkout found (set AGENT_BRIDGE_SOURCE_DIR to override)',
          context: { candidates_probed: candidates, trigger },
        });
      } catch { /* best-effort */ }
      return;
    }
    autoUpdateProbeArmed = true;
    const intervalDecision = resolveAutoUpdateIntervalMs();
    if (intervalDecision.source === 'default' && intervalDecision.reason) {
      try {
        logEvent({
          event: 'auto_update_check.interval_override_rejected',
          level: 'warn',
          msg: `AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS rejected (${intervalDecision.reason}); falling back to default ${AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS}ms`,
          context: {
            raw_value: intervalDecision.rawValue,
            reason: intervalDecision.reason,
            min_ms: AUTO_UPDATE_INTERVAL_MIN_MS,
            max_ms: AUTO_UPDATE_INTERVAL_MAX_MS,
            default_ms: AUTO_UPDATE_PROBE_INTERVAL_DEFAULT_MS,
            trigger,
          },
        });
      } catch { /* best-effort */ }
    }
    const intervalMs = intervalDecision.intervalMs;
    // Stagger the first probe ~30 s after boot/promotion so we don't slow
    // startup or race with `replayUndeliveredMessages`. unref() lets Node
    // exit cleanly even if the timer hasn't fired yet.
    autoUpdateInitialTimer = setTimeout(() => {
      autoUpdateInitialTimer = null;
      runAutoUpdateProbe(scriptPath, `${trigger}_initial`);
    }, AUTO_UPDATE_PROBE_INITIAL_DELAY_MS);
    autoUpdateInitialTimer.unref?.();
    // Then re-probe every `intervalMs` (default 3 h, overridable via
    // AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS for live tests) so a long-lived
    // channel-owner that never gets a /reload-plugins between upstream
    // pushes still notices.
    autoUpdateIntervalTimer = setInterval(() => {
      runAutoUpdateProbe(scriptPath, `${trigger}_interval`);
    }, intervalMs);
    autoUpdateIntervalTimer.unref?.();
    try {
      logEvent({
        event: 'auto_update_check.armed',
        msg: `auto-update-check armed (initial in ${AUTO_UPDATE_PROBE_INITIAL_DELAY_MS / 1000}s, then every ${intervalMs}ms; source=${intervalDecision.source})`,
        context: {
          intervalMs,
          source: intervalDecision.source,
          script: scriptPath,
          initial_delay_ms: AUTO_UPDATE_PROBE_INITIAL_DELAY_MS,
          trigger,
        },
      });
      // Keep the legacy `scheduled` event too for backwards compat with any
      // log greps / dashboards built against 3.10/3.11.0.
      logEvent({
        event: 'auto_update_check.scheduled',
        msg: `auto-update-check scheduled (initial in 30s, then every ${(intervalMs / 3_600_000).toFixed(3)}h)`,
        context: {
          script: scriptPath,
          initial_delay_ms: AUTO_UPDATE_PROBE_INITIAL_DELAY_MS,
          interval_ms: intervalMs,
          interval_source: intervalDecision.source,
          trigger,
        },
      });
    } catch { /* best-effort */ }
  };

  const stopAutoUpdateProbe = (): void => {
    if (autoUpdateInitialTimer) {
      try { clearTimeout(autoUpdateInitialTimer); } catch { /* best-effort */ }
      autoUpdateInitialTimer = null;
    }
    if (autoUpdateIntervalTimer) {
      try { clearInterval(autoUpdateIntervalTimer); } catch { /* best-effort */ }
      autoUpdateIntervalTimer = null;
    }
    autoUpdateProbeArmed = false;
  };

  if (watcherStarted && bridgeRole === 'channel-owner') {
    armAutoUpdateProbe('boot');
  }

  // 3.11.0 [AUTO-UPDATE-RE-PROBE 2026-04-30] — if this child started as a
  // standby (Patch F: peer held the lease) and later steals the lease
  // because the peer died, fire an immediate probe and arm the 3 h
  // interval. Without this hook the auto-update timer would never run on
  // a standby-promoted process.
  if (bridgeRole === 'channel-owner') {
    subscribeToPromotion(() => {
      if (autoUpdateProbeArmed) return; // already running
      const { scriptPath } = resolveAutoUpdateScript();
      if (scriptPath && !isAutoUpdateDisabled()) {
        // Immediate probe on promotion — channel-owner just changed, so
        // we want a fresh check right now in case origin has moved while
        // the previous owner was wedged. Don't wait the 30 s.
        runAutoUpdateProbe(scriptPath, 'promotion_immediate');
      }
      armAutoUpdateProbe('promotion');
    });
  }

  // Clean shutdown. Triggered by:
  //   - SIGINT / SIGTERM / SIGHUP (explicit signals from parent)
  //   - stdin end / close / error (MCP stdio transport hung up, i.e. parent gone)
  //   - parent-liveness watchdog (parent PID gone — ESRCH on kill-0)
  //   - EPIPE detected in the global error handlers above (exits directly)
  // The force-exit timer below guarantees we die within 2s even if server.close() hangs.
  let shuttingDown = false;
  let parentWatchdog: NodeJS.Timeout | null = null;
  const shutdown = (reason: string) => {
    syncExitBreadcrumb('shutdown.enter', { reason, already_shutting_down: shuttingDown, watcherStarted, bridgeRole });
    if (shuttingDown) return;
    shuttingDown = true;

    // 3.14.4 — Make sure the epitaph carries the most precise reason we
    // know at shutdown time. If a more specific reason was already set in
    // the SIGTERM handler (e.g. patch_f.peer_version_kill_suspected), keep
    // it — the signal handler ran first and captured the cause. Otherwise
    // adopt the shutdown() reason (orphan-watchdog, sibling-takeover, etc.).
    if (epitaphKillReason === 'unknown') {
      epitaphKillReason = `shutdown:${reason}`;
    }
    epitaphLastToolCallTs = lastToolCallTs ?? undefined;
    epitaphWatcherStarted = watcherStarted;
    epitaphLeaseState = bridgeRole;

    // Stop the parent-liveness timer immediately so it can't fire again during
    // async shutdown (would log a spurious second shutdown reason).
    if (parentWatchdog) {
      try { clearInterval(parentWatchdog); } catch {}
      parentWatchdog = null;
    }

    try { logInfo(`Shutting down agent-bridge MCP server (${reason})...`); } catch {}
    try {
      logEvent({
        event: 'server.shutdown',
        msg: `Shutting down agent-bridge MCP server (${reason})`,
        context: { reason },
      });
    } catch {}

    // Pre-shutdown diagnostics dump — logs what kept the event loop alive at
    // teardown time. Mirrors the Telegram channel plugin's [shutdown-diag]
    // pattern (server.ts ~line 675-680). The post-mortem usually reveals one
    // of: a wedged stdout JSON-RPC write, the parent watchdog interval, the
    // file-watcher poll, the prune timer, or an outstanding fs request.
    try {
      const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
      const reqs = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() ?? [];
      const rssMB = Math.floor(process.memoryUsage().rss / 1024 / 1024);
      const handleTypes = handles.map((h) => (h && (h as { constructor?: { name?: string } }).constructor?.name) || typeof h);
      logEvent({
        event: 'server.shutdown_diag',
        msg: `Shutdown diag uptime=${Math.floor(process.uptime())}s handles=${handles.length} requests=${reqs.length} rss=${rssMB}MB`,
        context: {
          uptime_s: Math.floor(process.uptime()),
          handles: handles.length,
          requests: reqs.length,
          rss_mb: rssMB,
          handle_types: handleTypes,
          reason,
          pid: process.pid,
          parent_pid: process.ppid,
        },
      });
    } catch {}

    // Hard deadline: whatever state async cleanup is in, die within 2s. Matches
    // the Telegram channel plugin's discipline — no MCP server should ever
    // survive its parent.
    const forceExit = setTimeout(() => {
      syncExitBreadcrumb('shutdown.force_exit_timer', { reason, code: 0 });
      try { logError('Shutdown timeout exceeded, force-exiting'); } catch {}
      process.exit(0);
    }, 2000);
    forceExit.unref();

    // Kernel-delivered SIGKILL backstop. A Node process whose main thread is
    // stuck in an uninterruptible kernel wait (U state — e.g. stuck in a
    // wedged fetch syscall) can swallow process.exit(0). Self-SIGKILL at 5s
    // is kernel-delivered and ALWAYS terminates. Pairs with the Telegram
    // channel plugin's identical backstop (server.ts ~line 693).
    const sigkillBackstop = setTimeout(() => {
      syncExitBreadcrumb('shutdown.sigkill_backstop', { reason, signal: 'SIGKILL' });
      try { logError('Shutdown sigkill backstop firing — process.exit(0) was swallowed'); } catch {}
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* if even SIGKILL fails, fall through */ }
    }, 5000);
    sigkillBackstop.unref();

    // 1. Stop the file watcher (kills fswatch/inotifywait/polling)
    try { stopWatcher(); } catch (err) { try { logError(`stopWatcher error: ${err}`); } catch {} }

    // 1b. Stop the auto-update re-probe timers (3.11.0). The unref() means
    // they can't keep Node alive on their own, but clearing them releases
    // the event-loop handles immediately so the shutdown_diag dump is
    // accurate.
    try { stopAutoUpdateProbe(); } catch (err) { try { logError(`stopAutoUpdateProbe error: ${err}`); } catch {} }

    // 2. Stop the prune timer and inbox system
    try { shutdownInbox(); } catch (err) { try { logError(`shutdownInbox error: ${err}`); } catch {} }

    // 3. Close the MCP server
    Promise.resolve()
      .then(() => server.close())
      .catch((err) => { try { logError(`Error closing MCP server: ${err}`); } catch {} })
      .finally(() => {
        try { logInfo('agent-bridge MCP server shut down cleanly'); } catch {}
        syncExitBreadcrumb('shutdown.before_process_exit', { reason, code: 0 });
        process.exit(0);
      });
  };

  const signalParentAlive = () => {
    try {
      process.kill(process.ppid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // EPERM still proves the parent exists from our POV. Anything unexpected
      // is treated conservatively as alive to avoid false-positive shutdown.
      return code !== 'ESRCH';
    }
  };

  // 3.7.0 — Patch G (channel-owner SIGTERM ignore) is retained as
  // defence-in-depth. The unified plugin should rarely face the original
  // reaping issue (Claude Code's plugin host gates idle-reaping on tool-call
  // frequency, and this plugin now exposes 7+ frequently-called tools), but
  // keeping Patch G prevents transient host glitches from killing a healthy
  // channel-owner watcher. Override with AGENT_BRIDGE_DISABLE_PATCH_G=1.
  //
  // SIGINT and SIGHUP remain explicit shutdown signals so users can still
  // kill us with Ctrl-C or terminal hangup.
  const handleSignal = (signal: NodeJS.Signals) => {
    const parentAlive = signalParentAlive();
    const stdinDestroyed = process.stdin.destroyed === true;
    const stdinReadableEnded = process.stdin.readableEnded === true;
    const lastNotifAgeMs = lastNotificationAtMs === null
      ? null
      : Date.now() - lastNotificationAtMs;

    // 3.14.4 — Capture the kill reason for the epitaph. If we fall through
    // to shutdown(), the 'exit' handler will write `auto_update_runner.epitaph`
    // with this reason. SIGTERM with stale-version peer-kill from another
    // bridge MCP child is the dominant disconnect path — reflect that.
    if (signal === 'SIGTERM' && parentAlive) {
      // Heuristic: if our parent is alive (so this isn't an orphan-watchdog
      // shutdown) and we're getting a SIGTERM, the most likely sender is
      // another MCP child running Patch F's peer-version-kill path.
      epitaphKillReason = 'patch_f.peer_version_kill_suspected';
    } else {
      epitaphKillReason = `signal_${signal}`;
    }
    epitaphLastToolCallTs = lastToolCallTs ?? undefined;
    epitaphWatcherStarted = watcherStarted;
    epitaphLeaseState = bridgeRole;

    syncExitBreadcrumb('signal.received', {
      signal,
      watcherStarted,
      bridgeRole,
      parent_alive: parentAlive,
      stdin_destroyed: stdinDestroyed,
      stdin_readable_ended: stdinReadableEnded,
      last_notification_at_ms: lastNotificationAtMs,
      last_notification_age_ms: lastNotifAgeMs,
      tool_calls_received_count: toolCallsReceivedCount,
    });

    try {
      logEvent({
        event: 'signal.evidence',
        level: 'warn',
        msg: `${signal} received — capturing evidence`,
        context: {
          signal,
          pid: process.pid,
          ppid: process.ppid,
          parent_alive: parentAlive,
          watcherStarted,
          bridgeRole,
          uptime_s: Math.floor(process.uptime()),
          stdin_destroyed: stdinDestroyed,
          stdin_readable_ended: stdinReadableEnded,
          last_notification_at_ms: lastNotificationAtMs,
          last_notification_age_ms: lastNotifAgeMs,
          tool_calls_received_count: toolCallsReceivedCount,
        },
      });
    } catch { /* never let logging break a signal handler */ }

    if (
      signal === 'SIGTERM'
      && watcherStarted
      && bridgeRole === 'channel-owner'
      && parentAlive
      && process.env.AGENT_BRIDGE_DISABLE_PATCH_G !== '1'
    ) {
      try {
        process.stderr.write(
          `agent-bridge: ${signal} ignored (channel-owner watcher healthy, parent ppid=${process.ppid} alive)\n`,
        );
      } catch { /* best-effort */ }
      try {
        logEvent({
          event: 'signal.ignored_channel_owner',
          level: 'warn',
          msg: `${signal} ignored for channel-owner watcher`,
          context: {
            pid: process.pid,
            parentPid: process.ppid,
            watcherStarted,
            uptime_s: Math.floor(process.uptime()),
            stdin_destroyed: stdinDestroyed,
            stdin_readable_ended: stdinReadableEnded,
            last_notification_at_ms: lastNotificationAtMs,
            last_notification_age_ms: lastNotifAgeMs,
            tool_calls_received_count: toolCallsReceivedCount,
          },
        });
      } catch { /* never let logging break a signal handler */ }
      return;
    }
    shutdown(signal);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGHUP', () => handleSignal('SIGHUP'));

  // stdio lifecycle:
  // Claude Code's plugin host owns MCP child lifetime. EOF/close on stdin means
  // the host has closed the transport and may SIGTERM/SIGKILL shortly after.
  // The desired posture is still "shutdown so the watcher lease is released
  // cleanly and undelivered messages remain pending for the next live
  // channel-owner/replay" — but as of 3.5.5 we no longer trigger that path on
  // a SINGLE stdin-end/close event. Instead we mirror the Telegram channel
  // plugin's Patch A pattern (server.ts:711-737): require 3 consecutive
  // confirmations (15s window at 5s polling) of orphaned state — combined
  // across parent-pid liveness AND stdin destroyed/ended — before calling
  // shutdown. This eats transient stdin/ppid glitches under heavy load while
  // still terminating true orphans within ~15s.
  //
  // Note we deliberately do NOT touch stdout-EPIPE-fatal or stdin-EPIPE-fatal
  // paths: those are real transport-broken signals where keeping the lease
  // alive would mean a deaf-but-live channel-owner silently swallowing
  // messages. The 3-poll gate only protects against false-positive shutdowns
  // on benign lifecycle hiccups.
  const isChannelOwner = watcherStarted && bridgeRole === 'channel-owner';
  let stdinErrored: { reason: string } | null = null;
  const onStdioEnded = (_reason: string) => {
    // Intentionally a no-op for liveness — `process.stdin.readableEnded` and
    // `process.stdin.destroyed` are observed directly by the orphan watchdog
    // below, which gates shutdown behind a 3-poll confirmation. Keeping the
    // event listeners attached avoids unhandled 'error' warnings.
  };

  process.stdin.on('end', () => onStdioEnded('stdin end'));
  process.stdin.on('close', () => onStdioEnded('stdin close'));
  process.stdin.on('error', (err) => {
    if (isBrokenPipe(err)) {
      fatalTransportExit('stdin.broken_pipe_exit', 'stdin broken pipe — MCP input transport closed; releasing watcher lease before exit', err);
    }
    // Non-EPIPE stdin error: defer to the orphan watchdog. Recording the
    // reason lets the eventual shutdown carry the original error string.
    stdinErrored = { reason: `stdin error: ${err}` };
  });

  // Periodic heartbeat (3.5.2+). Writes one line every 60s to the durable
  // mcp-server.log so a post-mortem can see EXACTLY when the process went
  // silent. Without this, a silent reaping leaves the log frozen at the last
  // event (often the prune-pass debug line at 5min boundaries) and we can't
  // tell whether the process died at minute 1 or minute 4 of a gap. Mirrors
  // the Telegram channel plugin's [heartbeat] pattern. Refed for channel
  // owners (must keep Node alive between turns); unref'd for tools-only
  // (must not pin Node alive after stdio closes).
  const heartbeatInterval = setInterval(() => {
    if (shuttingDown) return;
    try {
      const rssMB = Math.floor(process.memoryUsage().rss / 1024 / 1024);
      const lease = watcherStarted ? 'held' : (bridgeRole === 'tools-only' ? 'tools-only' : 'standby');
      // 4.0.x — embed the channel-health snapshot so a `tail -F` of the
      // unified log instantly answers "is the channel currently dead?".
      // Today's 12+ h dead-channel debug had to grep across multiple
      // event names to reconstruct state; the heartbeat is the natural
      // place to surface the live snapshot. Failures fall through with
      // safe defaults — the heartbeat must never crash the server.
      let channelHealth: ReturnType<typeof getChannelHealthSnapshot> | null = null;
      try {
        channelHealth = getChannelHealthSnapshot();
      } catch { /* swallow — heartbeat must never crash */ }
      logEvent({
        event: 'server.heartbeat',
        msg: `heartbeat uptime=${Math.floor(process.uptime())}s ppid=${process.ppid} rss=${rssMB}MB lease=${lease}${channelHealth?.channel_dead ? ` channel=DEAD(${Math.floor(channelHealth.channel_dead_age_ms / 1000)}s)` : ''}`,
        context: {
          uptime_s: Math.floor(process.uptime()),
          ppid: process.ppid,
          pid: process.pid,
          rss_mb: rssMB,
          lease,
          role: bridgeRole || 'auto',
          channel_dead: channelHealth?.channel_dead ?? false,
          channel_dead_age_ms: channelHealth?.channel_dead_age_ms ?? 0,
          pending_count: channelHealth?.pending_count ?? 0,
          pending_escape_hatch_count: channelHealth?.pending_escape_hatch_count ?? 0,
          recent_pushes_in_window: channelHealth?.recent_pushes_in_window ?? 0,
        },
      });
    } catch { /* never let a heartbeat take us down */ }
  }, 60_000);
  if (!isChannelOwner) {
    heartbeatInterval.unref?.();
  }

  const parentCheckDisabled = process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK === '1';
  if (parentCheckDisabled) {
    logInfo('Parent-PID liveness check disabled via AGENT_BRIDGE_DISABLE_PARENT_CHECK=1');
    logEvent({
      event: 'parent.check.disabled',
      msg: 'Parent-PID liveness check disabled via AGENT_BRIDGE_DISABLE_PARENT_CHECK=1',
      context: { pid: process.pid, parentPid: process.ppid },
    });
  }
  {
    const parentPid = process.ppid;
    if (!parentCheckDisabled) {
      logEvent({
        event: 'parent.detected',
        msg: `Parent process detected (ppid=${parentPid})`,
        context: { parentPid, pid: process.pid },
      });
    }

    // 3.5.5 — 3-poll orphan confirmation (mirror of Telegram plugin's Patch A,
    // server.ts:711-737). Under heavy load (Ableton + OBS + many concurrent
    // Claude sessions) a single transient ppid/stdin glitch used to
    // false-trigger shutdown. Now we require 3 consecutive polls (15 s at the
    // 5 s interval) of an orphaned state — across BOTH parent-pid liveness
    // AND stdin destroyed/ended/errored — before calling shutdown. Any clean
    // poll resets the counter, so a true orphan still terminates within ~15s.
    //
    // We keep the orphan watchdog interval running even when
    // AGENT_BRIDGE_DISABLE_PARENT_CHECK=1: only the parent-PID check itself is
    // disabled, the stdio-orphan portion still applies. Tests that want to
    // fully detach should also set AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG=1.
    const ORPHAN_CONFIRMATION_POLLS = 3;
    let orphanedPolls = 0;
    let lastOrphanReason = '';
    const orphanWatchdogDisabled = process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG === '1';
    if (orphanWatchdogDisabled) {
      logEvent({
        event: 'orphan_watchdog.disabled',
        msg: 'Orphan watchdog disabled via AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG=1',
        context: { pid: process.pid, parentPid },
      });
    }

    if (!orphanWatchdogDisabled) parentWatchdog = setInterval(() => {
      if (shuttingDown) return;

      // Liveness check — kill(pid, 0) on a live process is a no-op; on a
      // dead process it throws ESRCH. EPERM means the process exists but we
      // can't signal it, which still tells us it's alive — do nothing. Any
      // other error is unexpected; treat conservatively as "still alive" so
      // we don't false-positive ourselves into shutdown.
      let parentDead = false;
      if (!parentCheckDisabled) {
        try {
          process.kill(parentPid, 0);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'ESRCH') {
            parentDead = true;
          }
          // EPERM or anything else — parent still exists from our POV, keep running.
        }
      }

      // Combined orphan signals — any one of these indicates the parent
      // chain has gone away. We confirm across multiple polls before shutdown.
      //
      // 3.6.1 fix (2026-04-21): REMOVED the `stdin.readableEnded === true`
      // check. Claude Code's MCP plugin host writes to the child's stdin once
      // during the JSON-RPC handshake and then leaves the pipe idle. Node's
      // `process.stdin.readableEnded` flips to `true` once the MCP SDK's
      // `StdioServerTransport` has consumed the buffered handshake bytes —
      // even though the pipe is still open and JSON-RPC traffic continues
      // to flow over it. Treating that as an orphan signal killed the host
      // (channel plugin in particular) within 15 s of every spawn. An IDLE
      // stdin is NOT an orphan signal on Node; only a destroyed or errored
      // stdin is. Parent-PID liveness still catches true reparenting.
      const stdinDestroyed = process.stdin.destroyed === true;
      const stdinHadError = stdinErrored !== null;
      const orphaned = parentDead || stdinDestroyed || stdinHadError;

      if (orphaned) {
        orphanedPolls += 1;
        // Compose a stable reason string for the eventual shutdown / log.
        const reasons: string[] = [];
        if (parentDead) reasons.push(`parent dead (pid ${parentPid} ESRCH)`);
        if (stdinDestroyed) reasons.push('stdin destroyed');
        if (stdinHadError && stdinErrored) reasons.push(stdinErrored.reason);
        lastOrphanReason = reasons.join(' | ');

        logEvent({
          event: 'parent.orphan_poll',
          level: 'warn',
          msg: `Orphan watchdog poll ${orphanedPolls}/${ORPHAN_CONFIRMATION_POLLS}: ${lastOrphanReason}`,
          context: {
            parentPid,
            pid: process.pid,
            poll: orphanedPolls,
            confirmation_polls: ORPHAN_CONFIRMATION_POLLS,
            parent_dead: parentDead,
            stdin_destroyed: stdinDestroyed,
            stdin_ended: process.stdin.readableEnded === true, // diagnostic-only: logged but NOT acted on (3.6.1)
            stdin_errored: stdinHadError,
          },
        });

        if (orphanedPolls >= ORPHAN_CONFIRMATION_POLLS) {
          if (parentDead) {
            logEvent({
              event: 'parent.dead',
              level: 'warn',
              msg: `Parent process ${parentPid} is gone (ESRCH) — confirmed across ${ORPHAN_CONFIRMATION_POLLS} polls`,
              context: { parentPid, pid: process.pid, confirmation_polls: ORPHAN_CONFIRMATION_POLLS },
            });
          }
          shutdown(`orphan-watchdog: ${lastOrphanReason}`);
          return;
        }
      } else {
        // Reset the counter on any clean poll so transient glitches don't
        // accumulate over time.
        if (orphanedPolls > 0) {
          logEvent({
            event: 'parent.orphan_recovered',
            msg: `Orphan watchdog cleared after ${orphanedPolls} poll(s)`,
            context: { parentPid, pid: process.pid, polls_seen: orphanedPolls },
          });
        }
        orphanedPolls = 0;
        lastOrphanReason = '';
      }

      // Sibling-MCP-child detection (3.5.2+). Claude Code may spawn a fresh
      // agent-bridge MCP child for the same parent claude session — for
      // example after `/reload-plugins`, after a transient stdio disconnect,
      // or as a routine recycle. The 3.4.9-3.4.13 patches keep us alive
      // through SIGTERM/stdin-end, but if Claude has already wired its stdio
      // to the new sibling, our heroically-still-alive process is now a
      // zombie: we'll never receive another tool call, our channel
      // notifications go to a closed pipe, and we eventually die silently
      // from EPIPE during a write.
      //
      // When that happens, gracefully step down so the new sibling owns
      // delivery cleanly. Detection: scan for a younger node process that's
      // also running build/index.js with the same parent PID and a higher
      // start time. We use the lease file as the source of truth for "the
      // current owner" and exit if the lease is now held by a different,
      // alive PID — that strictly proves a sibling has taken over.
      try {
        // 4.0.0 — sibling-takeover detection only matters when WE are
        // the lease owner; tools-only children skip this branch (they
        // never set `watcherStarted=true` so the inner guard short-
        // circuits anyway). Resolve the lease path against our own
        // identity target so multi-persona installs key on the right
        // file.
        if (!identity.target) return;
        const leasePath = join(LOCKS_DIR, leaseFileNameForTarget(identity.target));
        if (existsSync(leasePath)) {
          const leaseRaw = readFileSync(leasePath, 'utf8');
          const leaseMeta = JSON.parse(leaseRaw) as { pid?: number; updatedAt?: number };
          if (
            typeof leaseMeta.pid === 'number'
            && leaseMeta.pid > 0
            && leaseMeta.pid !== process.pid
            && watcherStarted // only relevant if WE think we're the owner
          ) {
            // The lease has been taken by a different process. Verify it's
            // alive (ESRCH = dead, leftover lease file). Verify it's also
            // recent (updatedAt within 30s) so we don't false-positive on a
            // stale lease that hasn't been GC'd yet.
            let siblingAlive = false;
            try {
              process.kill(leaseMeta.pid, 0);
              siblingAlive = true;
            } catch (e) {
              if ((e as { code?: string }).code !== 'ESRCH') siblingAlive = true;
            }
            const leaseAge = Date.now() - (leaseMeta.updatedAt ?? 0);
            if (siblingAlive && leaseAge < 30_000) {
              syncExitBreadcrumb('sibling.detected.before_shutdown', {
                sibling_pid: leaseMeta.pid,
                lease_age_ms: leaseAge,
              });
              logEvent({
                event: 'sibling.detected',
                level: 'warn',
                msg: `Sibling MCP child pid=${leaseMeta.pid} owns watcher lease; this process stepping down`,
                context: {
                  pid: process.pid,
                  parent_pid: process.ppid,
                  sibling_pid: leaseMeta.pid,
                  lease_age_ms: leaseAge,
                },
              });
              shutdown(`sibling MCP child (pid ${leaseMeta.pid}) took over watcher`);
              return;
            }
          }
        }
      } catch { /* ignore — best-effort sibling detection */ }
    }, 5000);
    // Tool-only MCP children should not keep Node alive once stdio closes.
    // Channel-owner watchers keep this watchdog ref'ed only while the MCP
    // transport is open; stdin close/SIGTERM now shuts them down cleanly.
    if (parentWatchdog && !isChannelOwner) {
      parentWatchdog.unref();
    }

    // 4.0.x — Orphan-suicide check (separate concern from the 5s 3-poll
    // orphan watchdog above). Catches the launchd-adoption case that the
    // captured-parentPid + kill(0) probe misses when macOS recycles the
    // original parent's PID to an unrelated process: kill(originalParentPid, 0)
    // succeeds against the recycled occupant, so `parentDead` never flips
    // and the 3-poll watchdog never trips. After reparenting, `process.ppid`
    // returns 1 (launchd / init) — that's a permanent state and a definitive
    // orphan signal. Mini observed 6 stale MCP children with ppid=1 running
    // for 10+ hours that the existing watchdog had not killed; this loop
    // closes that gap.
    //
    // Distinct from the 3-poll watchdog: a longer 30s interval with a 60s
    // grace period so we don't false-positive at boot when CC is slow to
    // attach, and we exit on first confirmed detection (ppid=1 cannot be
    // transient — once adopted by launchd, you stay adopted).
    // Defaults: 30s poll, 60s grace. Both are env-tunable for tests so we
    // don't need 60s sleeps in CI; production paths leave the env unset and
    // get the documented defaults.
    const ORPHAN_SUICIDE_INTERVAL_MS = Number.parseInt(
      process.env.AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS ?? '',
      10,
    ) || 30_000;
    const ORPHAN_SUICIDE_GRACE_MS = Number.parseInt(
      process.env.AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS ?? '',
      10,
    ) || 60_000;
    // Independent of AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: the 5s 3-poll
    // watchdog and this 30s suicide check guard against different signals
    // (captured-parent ESRCH vs. live ppid===1). Tests that disable the
    // 3-poll watchdog still want suicide active to exercise this path.
    const orphanSuicideDisabled =
      process.env.AGENT_BRIDGE_DISABLE_ORPHAN_SUICIDE === '1';
    if (orphanSuicideDisabled) {
      logEvent({
        event: 'orphan_suicide.disabled',
        msg: 'Orphan-suicide check disabled (env or watchdog disable)',
        context: { pid: process.pid, parentPid },
      });
    } else if (STARTUP_PPID === 1) {
      // Edge case: we were started directly under launchd/init (LaunchAgent,
      // systemd unit, container PID 1, detached diagnostic run, etc.). In
      // that scenario `process.ppid` is 1 from boot — there is no
      // reparenting event to detect, and tripping suicide would kill a
      // healthy process. Skip the check entirely; parent-liveness is moot
      // when the parent IS init.
      //
      // Critically, this guard uses the MODULE-LOAD-TIME snapshot
      // (STARTUP_PPID), NOT the late `parentPid` capture below. If the host
      // had died during the multi-await main() startup work, the late
      // capture would already be 1 and we'd skip suicide on a true orphan.
      // STARTUP_PPID is sampled before any await, so it always reflects
      // the genuine launch-time parent.
      logEvent({
        event: 'orphan_suicide.skipped_init_parent',
        msg: 'Orphan-suicide check skipped: original parent IS init/launchd (ppid=1 from start)',
        context: { pid: process.pid, startupPpid: STARTUP_PPID, latePpid: parentPid },
      });
    } else {
      const orphanSuicide: NodeJS.Timeout = setInterval(() => {
        if (shuttingDown) return;
        // Grace period — at boot the harness may briefly leave us without a
        // live parent reading our stdout; don't fire during startup.
        if (process.uptime() * 1000 < ORPHAN_SUICIDE_GRACE_MS) return;
        // ppid === 1 (launchd on macOS, init on Linux) means we've been
        // reparented since startup — original parent is gone. Definitive
        // orphan signal. (The init-parent-from-boot case is handled above
        // and short-circuits this branch entirely.)
        if (process.ppid === 1) {
          syncExitBreadcrumb('orphan_suicide.detected', {
            pid: process.pid,
            uptime_s: Math.floor(process.uptime()),
            startupPpid: STARTUP_PPID,
            latePpid: parentPid,
          });
          logEvent({
            event: 'orphan_suicide.detected',
            level: 'warn',
            msg: `Orphan suicide: ppid=1 (reparented to init/launchd) after ${Math.floor(process.uptime())}s — exiting`,
            context: {
              pid: process.pid,
              ppid: 1,
              startupPpid: STARTUP_PPID,
              latePpid: parentPid,
              uptime_s: Math.floor(process.uptime()),
              grace_ms: ORPHAN_SUICIDE_GRACE_MS,
              interval_ms: ORPHAN_SUICIDE_INTERVAL_MS,
            },
          });
          // Route through shutdown() so the watcher lease + inbox are
          // released cleanly; bare process.exit() would leak the lease.
          shutdown('orphan-suicide: ppid=1 (reparented to launchd/init)');
        }
      }, ORPHAN_SUICIDE_INTERVAL_MS);
      // Never let this interval keep the event loop alive on its own.
      orphanSuicide.unref();
    }
  }
}

main().catch((err) => {
  syncExitBreadcrumb('main.catch.before_process_exit', { error: String(err), code: 1 });
  logError(`Fatal error: ${err}`);
  process.exit(1);
});
