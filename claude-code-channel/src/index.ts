#!/usr/bin/env node
/**
 * agent-bridge — claude-code-channel plugin (3.6.1).
 *
 * Long-lived, session-scoped MCP server. Owns:
 *   1. The watcher lease for `~/.agent-bridge/inbox/claude-code/`.
 *   2. The polling inbox watcher (2 s interval).
 *   3. The `notifications/claude/channel` push pipe back into the running
 *      Claude Code session (the same shape the Telegram plugin uses).
 *
 * What this plugin does NOT do:
 *   - Outbound `bridge_send_message` / `bridge_run_command` / etc. Those
 *     remain in the agent-bridge `mcp-server` package, which is now a
 *     tools-only MCP host. Tools and channel coordinate exclusively via the
 *     filesystem (inbox subdir + lease file); the two processes do not talk
 *     to each other.
 *
 * Lifecycle posture (mirrors the Telegram channel plugin —
 * `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts`):
 *   - Patch B  — persistent stderr tee → claude-code-channel-stderr.log
 *   - Patch C  — `shutdownWithReason(reason, detail)` funnel
 *   - Patch D  — 60s heartbeat (REFED — must keep the loop alive)
 *   - Patch E  — shutdown handle/request dump
 *   - Patch A  — 3-poll orphan watchdog (ppid != bootPpid OR stdin
 *                destroyed/ended) — 3 polls × 5s = 15s of confirmed orphan
 *                state before exit
 *   - Patch F  — heartbeat-recency guard against parallel subagent spawns
 *                murdering the parent poller (we use the watcher lease's
 *                `updatedAt` instead of an stderr-log mtime; same intent)
 *
 * IMPORTANT: stdout is the JSON-RPC transport for this MCP server's own
 * face — never `console.log`. Use stderr (teed by Patch B) for diagnostics.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CLAUDE_CODE_TARGET,
  LOCKS_DIR,
  LOGS_DIR,
  ensureDirectories,
  getLocalMachineName,
} from './config.js';
import {
  initInbox,
  shutdownInbox,
} from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import {
  replayUndeliveredMessages,
  startWatcher,
  stopWatcher,
} from './watcher.js';
import { logEvent } from './log.js';

const VERSION = '3.6.1';
const SERVER_NAME = 'agent-bridge-channel';

// ─── Patch B — persistent stderr tee ────────────────────────────────────────
// Mirror of Telegram server.ts:31-51. Tee process.stderr to a durable file so
// post-mortem evidence survives even when Claude Code closes the diagnostic
// stderr pipe between turns. Rotate at ~5 MiB → keep last ~2 MiB.
const STDERR_LOG_FILE = join(LOGS_DIR, 'claude-code-channel-stderr.log');
try {
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(STDERR_LOG_FILE) && statSync(STDERR_LOG_FILE).size > 5 * 1024 * 1024) {
    const existing = readFileSync(STDERR_LOG_FILE, 'utf8');
    writeFileSync(STDERR_LOG_FILE, existing.slice(-2 * 1024 * 1024));
  }
} catch { /* best-effort rotation */ }
let stderrLogStream: ReturnType<typeof createWriteStream> | null = null;
try {
  stderrLogStream = createWriteStream(STDERR_LOG_FILE, { flags: 'a' });
  stderrLogStream.on('error', () => { /* never let log tee take us down */ });
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = ((chunk: any, ...args: any[]) => {
    try { stderrLogStream?.write(chunk); } catch { /* ignore */ }
    return (origStderrWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...(args as unknown[]));
  });
  process.on('exit', () => { try { stderrLogStream?.end(); } catch { /* ignore */ } });
} catch { /* keep going without the tee */ }

// ─── Sync exit breadcrumb (logger-independent post-mortem trail) ────────────
function syncExitBreadcrumb(event: string, context: Record<string, unknown> = {}): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(LOGS_DIR, 'claude-code-channel-sync-exit.log'),
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        pid: process.pid,
        ppid: process.ppid,
        uptime_ms: Math.floor(process.uptime() * 1000),
        ...context,
      }) + '\n',
    );
  } catch { /* swallow */ }
}

// ─── Patch F — heartbeat-recency guard against parallel spawn ───────────────
// If the existing watcher lease is held by a different live PID and was
// updated within the last 90 s, this is a healthy peer (3.5.x mcp-server in
// channel-owner mode, OR another claude-code-channel started by a sibling
// session). Back off and exit cleanly so the healthy peer keeps its lease.
//
// The watcher's own tryAcquireWatcherLease() handles this for the lease file
// itself (busy → standby retry). Patch F here is the additional pre-flight
// check that runs BEFORE we install the rest of the lifecycle and try to
// connect MCP; it ensures a stray bun-run / sibling spawn never disturbs the
// healthy parent during heavy concurrent activity.
//
// We use the watcher lease's `updatedAt` field as the recency signal, which
// is what mcp-server's existing 3.5.x code uses too. This is the on-disk
// equivalent of Telegram's mtime-on-server.log check.
{
  const leasePath = join(
    LOCKS_DIR,
    `${CLAUDE_CODE_TARGET.replaceAll('/', '__')}.watcher-lock.json`,
  );
  if (process.env.AGENT_BRIDGE_DISABLE_PATCH_F !== '1') {
    try {
      if (existsSync(leasePath)) {
        const raw = readFileSync(leasePath, 'utf8');
        const meta = JSON.parse(raw) as { pid?: number; updatedAt?: number };
        const holder = Number(meta?.pid);
        const updatedAt = Number(meta?.updatedAt);
        if (
          Number.isInteger(holder)
          && holder > 0
          && holder !== process.pid
          && Number.isFinite(updatedAt)
          && Date.now() - updatedAt < 90_000
        ) {
          // Probe holder liveness — kill(pid, 0) on a live process is a no-op;
          // ESRCH means dead and we should NOT back off (the lease is stale,
          // tryAcquireWatcherLease will steal it). Any other error means the
          // process exists from our POV — back off.
          let holderAlive = false;
          try {
            process.kill(holder, 0);
            holderAlive = true;
          } catch (err) {
            const code = (err as { code?: string }).code;
            holderAlive = code !== 'ESRCH';
          }
          if (holderAlive) {
            process.stderr.write(
              `claude-code-channel: existing watcher pid=${holder} heartbeat fresh (age=${Date.now() - updatedAt}ms); this instance exiting without steal\n`,
            );
            logEvent({
              event: 'patch_f.backoff',
              level: 'warn',
              msg: 'Patch F: backing off because a healthy peer holds the watcher lease',
              context: { holder, age_ms: Date.now() - updatedAt, pid: process.pid },
            });
            syncExitBreadcrumb('patch_f.backoff_exit', { holder, age_ms: Date.now() - updatedAt });
            process.exit(0);
          }
        }
      }
    } catch (err) {
      // Best-effort. A malformed lease file is the watcher's problem and it
      // already handles it on acquire.
      logEvent({
        event: 'patch_f.check_error',
        level: 'warn',
        msg: 'Patch F: error checking existing lease (continuing)',
        context: { error: String(err) },
      });
    }
  }
}

// ─── Broken-pipe / unhandled-error wiring ───────────────────────────────────
function isBrokenPipe(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: string; message?: string };
  if (anyErr.code === 'EPIPE' || anyErr.code === 'ERR_STREAM_DESTROYED') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message : String(err);
  return /write EPIPE|Broken pipe|premature close|ERR_STREAM_DESTROYED/i.test(msg);
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
  try { stopWatcher(); syncExitBreadcrumb('fatal_transport_exit.after_stop_watcher', { transport_event: event }); }
  catch (stopErr) { syncExitBreadcrumb('fatal_transport_exit.stop_watcher_error', { transport_event: event, error: String(stopErr) }); }
  try { shutdownInbox(); syncExitBreadcrumb('fatal_transport_exit.after_shutdown_inbox', { transport_event: event }); }
  catch (shutdownErr) { syncExitBreadcrumb('fatal_transport_exit.shutdown_inbox_error', { transport_event: event, error: String(shutdownErr) }); }
  syncExitBreadcrumb('fatal_transport_exit.before_process_exit', { transport_event: event, code: 0 });
  process.exit(0);
}

process.on('exit', (code) => {
  syncExitBreadcrumb('process.exit_event', { code });
});

process.stderr.on('error', (err) => {
  if (isBrokenPipe(err)) return;
  try { logEvent({ event: 'stderr.error', level: 'warn', msg: `stderr error: ${err}` }); } catch {}
});

process.stdout.on('error', (err) => {
  if (isBrokenPipe(err)) {
    fatalTransportExit('stdout.broken_pipe_exit', 'stdout broken pipe — JSON-RPC/channel transport closed; releasing watcher lease before exit', err);
  }
  try { logEvent({ event: 'stdout.error', level: 'error', msg: `stdout error: ${err}` }); } catch {}
});

process.on('unhandledRejection', (err) => {
  if (isBrokenPipe(err)) {
    fatalTransportExit('unhandled_rejection.broken_pipe_exit', 'Unhandled rejection EPIPE — parent pipe closed; releasing watcher lease before exit', err);
  }
  try { logEvent({ event: 'process.unhandled_rejection', level: 'error', msg: `Unhandled rejection: ${err}` }); } catch {}
});
process.on('uncaughtException', (err) => {
  if (isBrokenPipe(err)) {
    fatalTransportExit('uncaught_exception.broken_pipe_exit', 'Uncaught exception EPIPE — parent pipe closed; releasing watcher lease before exit', err);
  }
  try { logEvent({ event: 'process.uncaught_exception', level: 'error', msg: `Uncaught exception: ${err}` }); } catch {}
});

// SIGPIPE: Node ignores SIGPIPE and surfaces broken pipes as stream EPIPE.
// Keep that behaviour so a stderr pipe flap can never take down the watcher.
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

// ─── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  ensureDirectories();
  initInbox();

  const localName = getLocalMachineName();
  process.stderr.write(
    `claude-code-channel ${VERSION} starting on "${localName}" pid=${process.pid} ppid=${process.ppid}\n`,
  );
  logEvent({
    event: 'channel.starting',
    msg: `agent-bridge claude-code-channel starting on "${localName}"`,
    context: {
      machineName: localName,
      version: VERSION,
      pid: process.pid,
      ppid: process.ppid,
      nodeVersion: process.version,
    },
  });

  const server = new McpServer(
    {
      name: SERVER_NAME,
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
        `You are connected to the agent-bridge channel plugin on machine "${localName}".`,
        'This plugin is the LONG-LIVED channel host for agent-bridge cross-machine communication.',
        'It pushes incoming messages from paired machines into this conversation as:',
        '  <channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>',
        '',
        'You do NOT need to poll — messages arrive in real time when the remote agent sends them.',
        '',
        'To REPLY to a bridged message, use the bridge_send_message tool from the separate',
        'agent-bridge (mcp-server, tools-only) plugin. The two plugins coordinate exclusively',
        'via the filesystem at ~/.agent-bridge/. This split exists because the channel host',
        'must outlive any single tool turn (a session-scoped lifetime) while the tools host',
        'can be respawned freely between turns by the MCP plugin host.',
        '',
        'See docs/3.6.0-channel-plugin-migration.md for the architecture rationale.',
      ].join('\n'),
    },
  );

  // No tools registered on the channel server — outbound MCP tools live in
  // mcp-server. Listing tools returns an empty array so callers don't crash;
  // bridge_* tools come from the sibling agent-bridge plugin.

  // Start the inbox watcher with the channel-notification callback. This is
  // the heart of the plugin: poll inbox/claude-code/ at 2 s, and for each
  // new message, push notifications/claude/channel back to Claude Code via
  // the MCP transport.
  const watcherStarted = await startWatcher(
    (newFiles) => {
      logEvent({
        event: 'watcher.new_messages',
        msg: `New messages detected: ${newFiles.length} file(s)`,
        context: { count: newFiles.length },
      });
    },
    (message: BridgeMessage) => {
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
    { role: 'channel-owner' },
  );

  if (!watcherStarted) {
    // tryAcquireWatcherLease returned 'failed' (not 'busy' — busy schedules
    // standby retry). Without a watcher there's no point bringing the rest
    // of the plugin up; exit and let the plugin host restart us.
    logEvent({
      event: 'channel.watcher_failed',
      level: 'error',
      msg: 'Failed to start watcher; exiting so plugin host can respawn',
    });
    process.exit(1);
  }

  // Connect to MCP stdio transport. From this point on stdout is the
  // JSON-RPC channel — never console.log.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logEvent({
    event: 'channel.ready',
    msg: 'agent-bridge claude-code-channel connected and ready',
    context: { machineName: localName },
  });

  // Replay any messages that arrived while Claude was offline. Must happen
  // AFTER server.connect() so notifications can actually be delivered.
  void replayUndeliveredMessages();

  // ─── Lifecycle: Patches A, C, D, E ────────────────────────────────────────
  let shuttingDown = false;
  function shutdown(reason: string): void {
    syncExitBreadcrumb('shutdown.enter', { reason, already_shutting_down: shuttingDown });
    if (shuttingDown) return;
    shuttingDown = true;

    process.stderr.write(`claude-code-channel: [shutdown] ${reason}\n`);
    try {
      logEvent({
        event: 'channel.shutdown',
        msg: `Shutting down agent-bridge claude-code-channel (${reason})`,
        context: { reason },
      });
    } catch {}

    // Patch E — handle/request dump.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handles = (process as any)._getActiveHandles?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reqs = (process as any)._getActiveRequests?.() ?? [];
      const rssMB = Math.floor(process.memoryUsage().rss / 1024 / 1024);
      const handleTypes = (handles as unknown[]).map((h) =>
        (h && (h as { constructor?: { name?: string } }).constructor?.name) || typeof h,
      );
      process.stderr.write(
        `[shutdown-diag] uptime=${Math.floor(process.uptime())}s handles=${handles.length} requests=${reqs.length} rss=${rssMB}MB\n`,
      );
      logEvent({
        event: 'channel.shutdown_diag',
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

    // Hard 2 s deadline — match Telegram. Watcher lease is released here so
    // the next live owner can pick up undelivered work without waiting.
    const forceExit = setTimeout(() => {
      syncExitBreadcrumb('shutdown.force_exit_timer', { reason, code: 0 });
      process.exit(0);
    }, 2000);
    forceExit.unref();

    // 5 s SIGKILL backstop — kernel-delivered, always terminates.
    const sigkillBackstop = setTimeout(() => {
      syncExitBreadcrumb('shutdown.sigkill_backstop', { reason, signal: 'SIGKILL' });
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* fall through */ }
    }, 5000);
    sigkillBackstop.unref();

    try { stopWatcher(); } catch (err) {
      try { logEvent({ event: 'shutdown.stop_watcher_error', level: 'warn', msg: String(err) }); } catch {}
    }
    try { shutdownInbox(); } catch (err) {
      try { logEvent({ event: 'shutdown.shutdown_inbox_error', level: 'warn', msg: String(err) }); } catch {}
    }

    Promise.resolve()
      .then(() => server.close())
      .catch((err) => {
        try { logEvent({ event: 'shutdown.server_close_error', level: 'warn', msg: String(err) }); } catch {}
      })
      .finally(() => {
        syncExitBreadcrumb('shutdown.before_process_exit', { reason, code: 0 });
        process.exit(0);
      });
  }

  // Patch C — single shutdown funnel.
  function shutdownWithReason(reason: string, detail?: string): void {
    const composed = detail ? `${reason}: ${detail}` : reason;
    shutdown(composed);
  }

  // Stdin lifecycle. Per Patch A, stdin events are observed by the orphan
  // watchdog (3 confirmation polls), NOT acted on directly. We attach
  // listeners so 'error' is captured for the deferred-reason path.
  let stdinErrored: { reason: string } | null = null;
  process.stdin.on('end', () => { /* observed by watchdog */ });
  process.stdin.on('close', () => { /* observed by watchdog */ });
  process.stdin.on('error', (err) => {
    if (isBrokenPipe(err)) {
      fatalTransportExit('stdin.broken_pipe_exit', 'stdin broken pipe — MCP input transport closed; releasing watcher lease before exit', err);
    }
    stdinErrored = { reason: `stdin error: ${err}` };
  });

  process.on('SIGINT', () => shutdownWithReason('SIGINT'));
  process.on('SIGTERM', () => shutdownWithReason('SIGTERM'));
  process.on('SIGHUP', () => shutdownWithReason('SIGHUP'));

  // Patch D — 60 s heartbeat. REFED: we are the long-lived channel-owner,
  // we WANT the loop alive between bursts.
  const heartbeatInterval = setInterval(() => {
    if (shuttingDown) return;
    try {
      const rssMB = Math.floor(process.memoryUsage().rss / 1024 / 1024);
      process.stderr.write(
        `[heartbeat] uptime=${Math.floor(process.uptime())}s ppid=${process.ppid} rss=${rssMB}MB\n`,
      );
      logEvent({
        event: 'channel.heartbeat',
        msg: `heartbeat uptime=${Math.floor(process.uptime())}s ppid=${process.ppid} rss=${rssMB}MB`,
        context: {
          uptime_s: Math.floor(process.uptime()),
          ppid: process.ppid,
          pid: process.pid,
          rss_mb: rssMB,
        },
      });
    } catch { /* never let a heartbeat take us down */ }
  }, 60_000);
  // INTENTIONALLY NOT unref'd — see header comment.
  void heartbeatInterval;

  // Patch A — 3-poll orphan watchdog. ppid != bootPpid OR stdin destroyed
  // OR stdin errored. 3 consecutive orphaned polls (5s × 3 = 15s) → shutdown.
  //
  // 3.6.1 fix (2026-04-21): REMOVED the `stdin.readableEnded === true` check.
  // Claude Code's MCP plugin host writes to the child's stdin once during the
  // JSON-RPC handshake and then leaves the pipe idle. Node's
  // `process.stdin.readableEnded` flips to `true` after the initial messages
  // are consumed by the MCP SDK's `StdioServerTransport`, even though the pipe
  // is still open and we're still receiving JSON-RPC traffic. Treating that as
  // an orphan signal killed the channel plugin within 15 s of every spawn.
  // The Telegram plugin doesn't see this because bun handles stdin lifecycle
  // differently; on Node we have to be stricter about what counts as orphan.
  // An IDLE stdin is not an orphan signal — only an actively-broken
  // (`destroyed`) or actually-errored stdin is. `ppid_changed` still catches
  // true reparenting (the original Claude session dying).
  const ORPHAN_CONFIRMATION_POLLS = 3;
  const bootPpid = process.ppid;
  let orphanedPolls = 0;
  let lastOrphanReason = '';
  const orphanWatchdogDisabled = process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG === '1';
  if (orphanWatchdogDisabled) {
    logEvent({
      event: 'orphan_watchdog.disabled',
      msg: 'Orphan watchdog disabled via AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG=1',
      context: { pid: process.pid, bootPpid },
    });
  } else {
    const watchdog = setInterval(() => {
      if (shuttingDown) return;
      const ppidChanged = process.platform !== 'win32' && process.ppid !== bootPpid;
      const stdinDestroyed = process.stdin.destroyed === true;
      // 3.6.1: stdin.readableEnded is NOT an orphan signal on Node — see comment above.
      const stdinHadError = stdinErrored !== null;
      const orphaned = ppidChanged || stdinDestroyed || stdinHadError;

      if (orphaned) {
        orphanedPolls += 1;
        const reasons: string[] = [];
        if (ppidChanged) reasons.push(`ppid changed (boot=${bootPpid}, now=${process.ppid})`);
        if (stdinDestroyed) reasons.push('stdin destroyed');
        if (stdinHadError && stdinErrored) reasons.push(stdinErrored.reason);
        lastOrphanReason = reasons.join(' | ');

        logEvent({
          event: 'channel.orphan_poll',
          level: 'warn',
          msg: `Orphan watchdog poll ${orphanedPolls}/${ORPHAN_CONFIRMATION_POLLS}: ${lastOrphanReason}`,
          context: {
            bootPpid,
            ppid: process.ppid,
            pid: process.pid,
            poll: orphanedPolls,
            confirmation_polls: ORPHAN_CONFIRMATION_POLLS,
            ppid_changed: ppidChanged,
            stdin_destroyed: stdinDestroyed,
            stdin_ended: process.stdin.readableEnded === true, // diagnostic-only: logged but NOT acted on (3.6.1)
            stdin_errored: stdinHadError,
          },
        });

        if (orphanedPolls >= ORPHAN_CONFIRMATION_POLLS) {
          shutdownWithReason('orphan-watchdog', lastOrphanReason);
          return;
        }
      } else {
        if (orphanedPolls > 0) {
          logEvent({
            event: 'channel.orphan_recovered',
            msg: `Orphan watchdog cleared after ${orphanedPolls} poll(s)`,
            context: { bootPpid, ppid: process.ppid, pid: process.pid, polls_seen: orphanedPolls },
          });
        }
        orphanedPolls = 0;
        lastOrphanReason = '';
      }
    }, 5000);
    // The watchdog is unref'd. The lease heartbeat (5 s in watcher.ts) is
    // refed and is what actually keeps the loop alive — the watchdog only
    // needs to run while there's *other* work pinning the loop.
    watchdog.unref?.();
  }
}

main().catch((err) => {
  syncExitBreadcrumb('main.catch.before_process_exit', { error: String(err), code: 1 });
  try {
    logEvent({
      event: 'channel.fatal_error',
      level: 'error',
      msg: `Fatal error in main: ${err}`,
    });
  } catch {}
  process.stderr.write(`claude-code-channel: fatal error: ${err}\n`);
  process.exit(1);
});
