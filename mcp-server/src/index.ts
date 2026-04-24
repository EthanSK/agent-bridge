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
import { ensureDirectories, getLocalMachineName } from './config.js';
import { initInbox, shutdownInbox } from './inbox.js';
import type { BridgeMessage } from './inbox.js';
import { registerTools } from './tools.js';
import { startWatcher, stopWatcher, replayUndeliveredMessages } from './watcher.js';
import { logInfo, logError, logWarn } from './logger.js';
import { logEvent } from './log.js';

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

process.on('unhandledRejection', (err) => {
  if (isBrokenPipe(err)) {
    try { logError(`Unhandled rejection EPIPE — parent pipe closed, exiting`); } catch {}
    process.exit(0);
  }
  logError(`Unhandled rejection: ${err}`);
});
process.on('uncaughtException', (err) => {
  if (isBrokenPipe(err)) {
    try { logError(`Uncaught exception EPIPE — parent pipe closed, exiting`); } catch {}
    process.exit(0);
  }
  logError(`Uncaught exception: ${err}`);
});

// SIGPIPE: Node ignores SIGPIPE by default (converts it to EPIPE errors), but
// be explicit — if something raises SIGPIPE to us, treat it as parent death.
process.on('SIGPIPE', () => process.exit(0));

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
    context: { machineName: localName, version: '3.4.11', pid: process.pid, nodeVersion: process.version },
  });

  // Create MCP server with channel capability
  const server = new McpServer(
    {
      name: 'agent-bridge',
      version: '3.4.11',
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
          logEvent({
            event: 'message.push_failed',
            level: 'error',
            msg: `Failed to push channel notification for ${message.id}`,
            context: { msg_id: message.id, from: message.from, error: String(err) },
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

    // Hard deadline: whatever state async cleanup is in, die within 2s. Matches
    // the Telegram channel plugin's discipline — no MCP server should ever
    // survive its parent.
    const forceExit = setTimeout(() => {
      try { logError('Shutdown timeout exceeded, force-exiting'); } catch {}
      process.exit(0);
    }, 2000);
    forceExit.unref();

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
    // Claude Code may send SIGTERM to plugin MCP children after a tool turn even
    // though the parent channel session remains live. For channel-owner
    // watchers, treat that like the benign stdin end/close path and keep the
    // inbox watcher alive until the parent actually dies. SIGINT/SIGHUP remain
    // explicit shutdown signals.
    if (signal === 'SIGTERM' && watcherStarted && bridgeRole === 'channel-owner' && signalParentAlive()) {
      logWarn(`${signal} observed for channel-owner watcher; keeping watcher alive until parent death/EPIPE`);
      logEvent({
        event: 'signal.ignored_channel_owner',
        level: 'warn',
        msg: `${signal} ignored for channel-owner watcher`,
        context: { pid: process.pid, role: bridgeRole, watcherStarted, parentPid: process.ppid },
      });
      return;
    }
    shutdown(signal);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGHUP', () => handleSignal('SIGHUP'));

  // stdio lifecycle:
  // Tool-only MCP hosts should shut down when stdio closes. Claude Code channel
  // owners are different: Claude may close the request side after a turn while
  // the parent session remains alive and can still receive channel
  // notifications. If we stop the watcher on that benign stdin end, the
  // `claude-code` inbox goes dark between turns. Keep channel-owner watchers
  // alive until the parent PID actually dies or stdout breaks (EPIPE).
  const keepAliveAfterStdioEnd = watcherStarted && bridgeRole === 'channel-owner';
  const onStdioEnded = (reason: string) => {
    if (keepAliveAfterStdioEnd) {
      logWarn(`${reason} observed for channel-owner watcher; keeping watcher alive until parent death/EPIPE`);
      logEvent({
        event: 'stdio.end_ignored_channel_owner',
        level: 'warn',
        msg: `${reason} ignored for channel-owner watcher`,
        context: { pid: process.pid, role: bridgeRole, watcherStarted },
      });
      return;
    }
    shutdown(reason);
  };

  process.stdin.on('end', () => onStdioEnded('stdin end'));
  process.stdin.on('close', () => onStdioEnded('stdin close'));
  process.stdin.on('error', (err) => {
    if (isBrokenPipe(err)) { process.exit(0); }
    shutdown(`stdin error: ${err}`);
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
  const parentCheckDisabled = process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK === '1';
  if (parentCheckDisabled) {
    logInfo('Parent-PID liveness check disabled via AGENT_BRIDGE_DISABLE_PARENT_CHECK=1');
    logEvent({
      event: 'parent.check.disabled',
      msg: 'Parent-PID liveness check disabled via AGENT_BRIDGE_DISABLE_PARENT_CHECK=1',
      context: { pid: process.pid, parentPid: process.ppid },
    });
  } else {
    const parentPid = process.ppid;
    logEvent({
      event: 'parent.detected',
      msg: `Parent process detected (ppid=${parentPid})`,
      context: { parentPid, pid: process.pid },
    });

    parentWatchdog = setInterval(() => {
      if (shuttingDown) return;

      // Liveness check — kill(pid, 0) on a live process is a no-op; on a
      // dead process it throws ESRCH. EPERM means the process exists but we
      // can't signal it, which still tells us it's alive — do nothing. Any
      // other error is unexpected; treat conservatively as "still alive" so
      // we don't false-positive ourselves into shutdown.
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ESRCH') {
          logEvent({
            event: 'parent.dead',
            level: 'warn',
            msg: `Parent process ${parentPid} is gone (ESRCH)`,
            context: { parentPid, pid: process.pid },
          });
          shutdown(`parent dead (pid ${parentPid} gone)`);
          return;
        }
        // EPERM or anything else — parent still exists from our POV, keep running.
      }
    }, 5000);
    // Tool-only MCP children should not keep Node alive once stdio closes.
    // Channel-owner watchers are intentionally different: after Claude Code
    // closes stdin between turns, every watcher/prune timer is unref'ed, so
    // the process can otherwise exit immediately despite ignoring the stdin
    // event. Keep the parent watchdog ref'ed for channel owners; it is the
    // minimal live handle and will still shut us down when the parent dies.
    if (!keepAliveAfterStdioEnd) {
      parentWatchdog.unref();
    }
  }
}

main().catch((err) => {
  logError(`Fatal error: ${err}`);
  process.exit(1);
});
