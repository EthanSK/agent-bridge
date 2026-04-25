#!/usr/bin/env node
/**
 * agent-bridge MCP server — channel plugin for real-time bidirectional
 * communication between running AI agent sessions across machines via SSH.
 *
 * This is the v2 component of agent-bridge. It runs as an MCP server /
 * channel plugin that Claude Code (or any MCP-compatible client) connects
 * to, exposing tools for cross-machine messaging and remote command execution.
 *
 * Channel capability: When new messages arrive in the local inbox, they are
 * PUSHED into the running Claude session via `notifications/claude/channel`
 * — no polling required. Messages appear as:
 *   <channel source="agent-bridge" from="MachineName" ...>content</channel>
 *
 * Design philosophy: enable EXISTING running agent sessions to communicate
 * with each other, NOT spawn new agent processes. Machine A's Claude sends
 * a message to Machine B's inbox, and Machine B's already-running Claude
 * receives it automatically via the channel.
 *
 * Communication protocol:
 * - Messages are JSON files written to ~/.agent-bridge/inbox/<target>/ on the target
 * - SSH is used for delivery (reusing v1 key pairs from ~/.agent-bridge/keys/)
 * - A file watcher detects incoming messages and pushes them via channel notifications
 *
 * IMPORTANT: Never use console.log() — stdout is the JSON-RPC transport.
 * Use console.error() or the logger module for diagnostics.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_TARGET, LOCKS_DIR, LOGS_DIR, ensureDirectories, getLocalMachineName } from './config.js';
import { initInbox, shutdownInbox } from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { registerTools } from './tools.js';
import { startWatcher, stopWatcher, replayUndeliveredMessages } from './watcher.js';
import { logInfo, logError, logWarn } from './logger.js';
import { logEvent } from './log.js';

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
  // the channel plugin flags. Plain MCP/tool sessions (including editor helper
  // processes) may start this server from the same plugin manifest, but they do
  // not process notifications/claude/channel. If they win the watcher lease,
  // messages are marked delivered and then disappear from the intended live
  // channel. Treat those parents as tools-only by default.
  return /--channels(?:\s|=|$)/.test(commandLine)
    || /--dangerously-load-development-channels(?:\s|=|$)/.test(commandLine);
}

async function main(): Promise<void> {
  // Ensure all directories exist
  ensureDirectories();

  // Initialize the inbox system (dirs, processed IDs, cache, prune timer)
  initInbox();

  const localName = getLocalMachineName();
  logInfo(`agent-bridge MCP server starting on "${localName}"`);
  logEvent({
    event: 'server.starting',
    msg: `agent-bridge MCP server starting on "${localName}"`,
    context: { machineName: localName, version: '3.5.5', pid: process.pid, nodeVersion: process.version },
  });

  // Create MCP server with channel capability
  const server = new McpServer(
    {
      name: 'agent-bridge',
      version: '3.5.5',
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
        '',
        'Communication flow:',
        '1. Machine A\'s Claude calls bridge_send_message to deliver a message to Machine B via SSH',
        '2. Machine B\'s file watcher detects the new message file',
        '3. Machine B\'s channel plugin pushes the message into the running Claude session',
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
      ].join('\n'),
    },
  );

  // Register all tools
  registerTools(server);

  // Watcher ownership (3.4.4+): only the process that is ACTUALLY meant to
  // push `notifications/claude/channel` should watch `inbox/claude-code/` and
  // call markDelivered(). Tool-only hosts (for example OpenClaw using this MCP
  // server only for outbound bridge_* tools) must disable watching entirely.
  // We now support explicit roles plus a single-owner lease with stale-lock
  // recovery so a crashed/zombie session cannot permanently block the next run.
  const requestedBridgeRole = process.env.AGENT_BRIDGE_ROLE?.trim() || '';
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
    if (!bridgeRole) {
      logWarn(
        'Watcher enabled in legacy auto mode. Prefer AGENT_BRIDGE_ROLE=channel-owner '
        + 'for the real Claude Code plugin and AGENT_BRIDGE_ROLE=tools-only everywhere else.',
      );
      logEvent({
        event: 'watcher.role_implicit',
        level: 'warn',
        msg: 'Watcher running with implicit auto role',
        context: { pid: process.pid },
      });
    }

    // Start the inbox file watcher with channel notification callback.
    // When new messages arrive, we push them into Claude's conversation
    // via the MCP channel notification protocol.
    watcherStarted = await startWatcher(
      (newFiles) => {
        logInfo(`New messages detected: ${newFiles.length} file(s)`);
      },
      (message: BridgeMessage) => {
        // Push the message into the running Claude session via channel notification.
        // This makes it appear as <channel source="agent-bridge" ...>content</channel>
        // in Claude's conversation — no polling needed.
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
          // Kept for backward compatibility with 3.5.4 and earlier log
          // consumers. The deliberate notification.push_failed event with
          // decision=leave_pending_for_next_owner is emitted in watcher.ts
          // (3.5.5+) once this rejection propagates back through the catch
          // around savedChannelCallback().
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

  logInfo('agent-bridge MCP server connected and ready (channel mode)');
  logEvent({
    event: 'server.ready',
    msg: 'agent-bridge MCP server connected and ready (channel mode)',
    context: { machineName: localName },
  });

  // Replay any messages that arrived while Claude was offline.
  // This must happen AFTER server.connect() so channel notifications
  // can actually be delivered to the client. Only the active watcher owner
  // may replay; a standby or tools-only process must leave backlog ownership
  // untouched for the real Claude session.
  if (watcherStarted) {
    void replayUndeliveredMessages();
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

  const handleSignal = (signal: NodeJS.Signals) => {
    syncExitBreadcrumb('signal.received', { signal, watcherStarted, bridgeRole, parent_alive: signalParentAlive() });
    // Claude Code owns the MCP stdio child lifecycle. If it sends SIGTERM,
    // treating that as a host-requested shutdown is the only reliable option:
    // ignoring it causes Claude to escalate to SIGKILL, which cannot release
    // the watcher lease or write diagnostics.
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

  // Parent-PID liveness watchdog.
  //
  // Motivation (2026-04-21 zombie incident): when a Claude Code session exits
  // ungracefully (terminal killed, laptop sleep, crash), stdio 'end'/'close'
  // events don't always fire on the MCP child. The child keeps running
  // indefinitely. If the file watcher is still active, it continues to receive
  // inbox files and markDelivered() them — but there's no Claude to push the
  // channel into. Result: messages silently disappear.
  //
  // Design: check every 5s whether the ORIGINAL parent PID is still alive via
  // kill(pid, 0). On ESRCH (process gone), shutdown. We deliberately DO NOT
  // check for ppid reassignment — that false-positives when a shell wrapper
  // exec-chains into node and the intermediate shell exits (ppid flips to 1
  // even though the real owner is still alive).
  //
  // Opt-out: set AGENT_BRIDGE_DISABLE_PARENT_CHECK=1 for diagnostic scenarios
  // (e.g. intentional detachment, debugging).
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
  if (!(watcherStarted && bridgeRole === 'channel-owner')) {
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
      const stdinDestroyed = process.stdin.destroyed === true;
      const stdinEnded = process.stdin.readableEnded === true;
      const stdinHadError = stdinErrored !== null;
      const orphaned = parentDead || stdinDestroyed || stdinEnded || stdinHadError;

      if (orphaned) {
        orphanedPolls += 1;
        // Compose a stable reason string for the eventual shutdown / log.
        const reasons: string[] = [];
        if (parentDead) reasons.push(`parent dead (pid ${parentPid} ESRCH)`);
        if (stdinDestroyed) reasons.push('stdin destroyed');
        if (stdinEnded) reasons.push('stdin readableEnded');
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
            stdin_ended: stdinEnded,
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
