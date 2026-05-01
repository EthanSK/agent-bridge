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
 *   3. The channel watcher itself: lease acquisition for
 *      `~/.agent-bridge/inbox/claude-code/`, the 2 s polling loop, and
 *      `notifications/claude/channel` push of incoming BridgeMessages back
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CODE_TARGET, LOCKS_DIR, LOGS_DIR, MCP_SERVER_VERSION, ensureDirectories, getLocalMachineName } from './config.js';
import { initInbox, shutdownInbox } from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { registerTools } from './tools.js';
import { startWatcher, stopWatcher, replayUndeliveredMessages, registerAliveSignals, subscribeToPromotion } from './watcher.js';
import { logInfo, logError, logWarn } from './logger.js';
import { logEvent } from './log.js';

// 3.7.1 — version is sourced from config.ts (single source of truth shared
// with watcher.ts so lease files carry our build version for Patch F's
// stale-version peer-kill path).
const VERSION = MCP_SERVER_VERSION;

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
// Skipped when AGENT_BRIDGE_ROLE=tools-only — tools-only hosts (OpenClaw,
// Codex sidekicks) do not contend for the inbox lease, so they have no
// reason to back off or kill peers.
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
  const requestedRole = process.env.AGENT_BRIDGE_ROLE?.trim() || 'channel-owner';
  if (
    requestedRole !== 'tools-only'
    && process.env.AGENT_BRIDGE_DISABLE_PATCH_F !== '1'
  ) {
    const leasePath = join(
      LOCKS_DIR,
      `${CLAUDE_CODE_TARGET.replaceAll('/', '__')}.watcher-lock.json`,
    );
    try {
      if (existsSync(leasePath)) {
        const raw = readFileSync(leasePath, 'utf8');
        const meta = JSON.parse(raw) as { pid?: number; updatedAt?: number; version?: string };
        const holder = Number(meta?.pid);
        const updatedAt = Number(meta?.updatedAt);
        const peerVersion = typeof meta?.version === 'string' ? meta.version : undefined;
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
            if (peerIsOlder) {
              try {
                process.stderr.write(
                  `agent-bridge: peer pid=${holder} version=${peerVersion} is older than our ${MCP_SERVER_VERSION}; sending SIGTERM to force migration\n`,
                );
              } catch { /* best-effort */ }
              try {
                logEvent({
                  event: 'patch_f.peer_version_kill',
                  level: 'warn',
                  msg: 'Patch F: SIGTERM-killing stale-version peer to force migration',
                  context: {
                    peer_pid: holder,
                    peer_version: peerVersion,
                    our_version: MCP_SERVER_VERSION,
                    pid: process.pid,
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
                    level: 'warn',
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
                  level: 'warn',
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

process.on('exit', (code) => {
  syncExitBreadcrumb('process.exit_event', { code });
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

function readParentCommandLine(): string {
  // Best-effort diagnostic guard for POSIX hosts. If this fails (for example
  // on Windows), return an empty string and leave the explicit role alone.
  try {
    return execFileSync('ps', ['-p', String(process.ppid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function parentLooksChannelCapable(commandLine: string): boolean {
  // Claude channel notifications are only delivered to sessions launched with
  // channel-capable Claude Code hosts. Older experimental builds advertised
  // that via CLI flags; current Claude Code 2.1.x desktop/VS Code builds expose
  // it through the MCP handshake instead, so their parent command line no longer
  // contains a `--channels` flag. Plain MCP/tool sessions may still start this
  // server from the same plugin manifest but cannot process
  // notifications/claude/channel. If they win the watcher lease, messages are
  // marked delivered and then disappear from the intended live channel. Treat
  // only known Claude Code channel host signatures as channel-capable.
  return /--channels(?:\s|=|$)/.test(commandLine)
    || /--dangerously-load-development-channels(?:\s|=|$)/.test(commandLine)
    || /\/claude\.app\/Contents\/MacOS\/claude(?:\s|$)/i.test(commandLine)
    || /\/anthropic\.claude-code-[^\s/]+\/resources\/native-binary\/claude(?:\s|$)/i.test(commandLine);
}

async function main(): Promise<void> {
  // Ensure all directories exist
  ensureDirectories();

  // Initialize the inbox system (dirs, processed IDs, cache, prune timer)
  initInbox();

  const localName = getLocalMachineName();
  // 3.7.0 default flip: this MCP server is now channel-owner by default
  // again (re-merging the 3.6.0 split). Set AGENT_BRIDGE_ROLE=tools-only
  // explicitly to opt out — only useful for non-Claude hosts (OpenClaw,
  // Codex, etc.) that want the bridge_* tools but DO NOT need to own the
  // inbox watcher.
  logInfo(
    `agent-bridge mcp-server starting on "${localName}" `
    + '(unified plugin: tools + channel watcher) '
    + '— set AGENT_BRIDGE_ROLE=tools-only to disable the watcher for tools-only hosts',
  );
  logEvent({
    event: 'server.starting',
    msg: `agent-bridge MCP server starting on "${localName}"`,
    context: { machineName: localName, version: VERSION, pid: process.pid, nodeVersion: process.version },
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
        'Respond using the bridge_send_message tool, passing the sender\'s machine name and an explicit target. If the incoming message metadata includes from_target, use that as the reply target. Otherwise bridge_send_message defaults from_target to claude-code for Claude Code sessions so the remote agent can reply over agent-bridge; set one_way=true only for deliberate one-way injection.',
        '',
        'Available tools:',
        '- bridge_list_machines: List paired machines and their connection details',
        '- bridge_status: Check if a machine is reachable via SSH',
        '- bridge_send_message: Send a message to a running agent on another machine',
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
        '4. Machine B\'s Claude sees it and responds via bridge_send_message back to Machine A using the incoming from_target when present; Claude Code-originated sends include from_target=claude-code by default',
        '',
        'All communication is authenticated via SSH keys (managed in ~/.agent-bridge/keys/).',
        'Messages have a TTL (default 1 day). Expired messages are auto-pruned.',
        'Machines are paired using the `agent-bridge pair` CLI command.',
        '',
        'HOW TO TALK TO THE OTHER AGENT:',
        'bridge_send_message is the ONLY supported way to communicate with the running agent on another machine. When your user says "ask Claude on <machine>", "talk to <machine>", "check in with the other agent", "have a conversation", or anything in that spirit — they mean send a NATURAL-LANGUAGE message via bridge_send_message, as if you were speaking to a colleague. NOT a structured ping, status probe, or machine-readable payload. Write the message in English (or whatever language the conversation is in) the same way you would answer the user directly.',
        'As of agent-bridge 3.4.0, bridge_send_message requires target. For round-trip conversations, from_target names the sender\'s local return target. Claude Code sends default this to claude-code; pass one_way=true only when no bridge reply should be possible.',
        'There is NO other mechanism for agent-to-agent communication in this system. Do not attempt to shell out to `claude --print`, `codex exec`, `agent-bridge run <machine> "..." --claude`, or any other command that spawns a fresh non-interactive agent session on the remote machine. Those fresh-spawn wrappers were intentionally removed in agent-bridge 3.0.0 — they defeat the entire purpose of this plugin, which is to connect EXISTING, already-running agent sessions.',
        'Use bridge_run_command ONLY for plain shell diagnostics (check a process, read a file, look at a log, run `git status`) — never as a substitute for asking the remote agent a question, and never to invoke an agent CLI like `claude`, `codex`, or `aider` on the remote machine.',
        'Use bridge_status / bridge_inbox_stats ONLY when the user is asking about connectivity or queue health — never instead of actually asking the other agent how things are going.',
        'The default interpretation of "ask X" is conversational (via bridge_send_message), not diagnostic.',
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
  registerAliveSignals({
    getToolCallsReceivedCount: () => toolCallsReceivedCount,
    getChannelCallbackRegisteredAt: () => channelCallbackRegisteredAt,
  });
  const origRegisterTool = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, schema: unknown, handler: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async (...args: any[]) => {
      toolCallsReceivedCount += 1;
      return handler(...args);
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
      const leasePath = join(
        LOCKS_DIR,
        `${CLAUDE_CODE_TARGET.replaceAll('/', '__')}.watcher-lock.json`,
      );
      let lease: Record<string, unknown> | null = null;
      let watcherActive = false;
      try {
        if (existsSync(leasePath)) {
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

  // Watcher ownership.
  //
  // 3.7.0: AGENT_BRIDGE_ROLE defaults to 'channel-owner' (re-merge of the
  // 3.6.0 split). Setting AGENT_BRIDGE_ROLE=tools-only opts out — only
  // useful for non-Claude hosts that want bridge_* tools but do NOT want to
  // contend for the claude-code inbox lease.
  //
  // Lease arbitration (single owner with stale-lock recovery) lives in
  // watcher.ts:tryAcquireWatcherLease — multiple agent-bridge processes can
  // start, but only one holds the lease at any moment. Late starters go to
  // standby and retry every 2 s.
  const requestedBridgeRole = process.env.AGENT_BRIDGE_ROLE?.trim() || 'channel-owner';
  const parentCommandLine = readParentCommandLine();
  let bridgeRole = requestedBridgeRole;
  if (
    bridgeRole === 'channel-owner'
    && process.env.AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT !== '1'
    && parentCommandLine
    && !parentLooksChannelCapable(parentCommandLine)
  ) {
    logWarn(
      'AGENT_BRIDGE_ROLE=channel-owner requested, but parent process does not look channel-capable; '
      + 'demoting this MCP server to tools-only so it cannot steal claude-code inbox delivery.',
    );
    logEvent({
      event: 'watcher.role_demoted_non_channel_parent',
      level: 'warn',
      msg: 'Demoted channel-owner to tools-only because parent lacks Claude channel flags',
      context: {
        pid: process.pid,
        parentPid: process.ppid,
        requestedRole: requestedBridgeRole,
        parentCommandLine,
      },
    });
    bridgeRole = 'tools-only';
  }
  const watcherDisabled =
    process.env.AGENT_BRIDGE_DISABLE_WATCHER === '1'
    || bridgeRole === 'tools-only';
  let watcherStarted = false;
  // Track the timestamp of the most recent channel push so signal evidence
  // logging can report how recently the channel was active.
  let lastNotificationAtMs: number | null = null;

  if (watcherDisabled) {
    logInfo(
      'Watcher disabled via AGENT_BRIDGE_DISABLE_WATCHER / AGENT_BRIDGE_ROLE=tools-only '
      + '— this process exposes outbound tools only (no inbox polling, no channel push, no markDelivered).',
    );
    logEvent({
      event: 'watcher.disabled',
      msg: 'Watcher disabled (tools-only mode)',
      context: {
        reason: bridgeRole === 'tools-only' ? 'role=tools-only' : 'disable_watcher=1',
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

        return server.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: message.content,
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
      logEvent({
        event: 'server.heartbeat',
        msg: `heartbeat uptime=${Math.floor(process.uptime())}s ppid=${process.ppid} rss=${rssMB}MB lease=${lease}`,
        context: {
          uptime_s: Math.floor(process.uptime()),
          ppid: process.ppid,
          pid: process.pid,
          rss_mb: rssMB,
          lease,
          role: bridgeRole || 'auto',
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
        const leasePath = join(LOCKS_DIR, `${CLAUDE_CODE_TARGET.replaceAll('/', '__')}.watcher-lock.json`);
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
  }
}

main().catch((err) => {
  syncExitBreadcrumb('main.catch.before_process_exit', { error: String(err), code: 1 });
  logError(`Fatal error: ${err}`);
  process.exit(1);
});
