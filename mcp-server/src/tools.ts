/**
 * MCP tool definitions for agent-bridge v2.
 *
 * Tools:
 * - bridge_list_machines: List paired machines and their status
 * - bridge_status: Check if a machine is reachable
 * - bridge_send_message: Send a message to a remote machine's running agent
 * - bridge_receive_messages: Check for and consume incoming messages
 * - bridge_run_command: Run a shell command on a remote machine
 * - bridge_clear_inbox: Clear all messages from the local inbox
 * - bridge_inbox_stats: Get inbox statistics and watcher health
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  loadConfig,
  getMachine,
  getLocalMachineName,
  isLocalMachineName,
  LOCAL_MACHINE_ALIASES,
  CLAUDE_CODE_TARGET,
  DEFAULT_TTL_SECONDS,
  isValidTarget,
} from './config.js';
import { sshExec, sshPingDetailed } from './ssh.js';
import {
  createMessage,
  sendMessage,
  sendLocalMessage,
  consumeInbox,
  peekInbox,
  clearInbox,
  getInboxStats,
} from './inbox.js';
import { logInfo, logError } from './logger.js';
import { logEvent } from './log.js';

/**
 * Register all agent-bridge tools on the MCP server.
 */
export function registerTools(server: McpServer): void {
  // -- bridge_list_machines --------------------------------------------------
  server.registerTool(
    'bridge_list_machines',
    {
      title: 'List Machines',
      description:
        'List all paired machines and their connection details. Shows machine name, host, user, port, and pairing date. The local machine is always listed as a same-machine target (no SSH); send to it by passing its real name or one of the aliases ("local", "self", "localhost").',
    },
    async () => {
      const machines = loadConfig();
      const localName = getLocalMachineName();

      const lines: string[] = [];
      lines.push(
        `Local machine: ${localName} (same-machine target, no SSH; aliases: ${LOCAL_MACHINE_ALIASES.join(', ')})`,
      );
      lines.push('');

      if (machines.length === 0) {
        lines.push(
          'No paired remote machines. Use `agent-bridge pair` to add one. '
          + 'You can still bridge_send_message to this machine by name or alias.',
        );
      } else {
        lines.push('Paired remote machines:');
        for (const m of machines) {
          lines.push(
            `  - ${m.name}: ${m.user}@${m.host}:${m.port} (paired ${m.pairedAt})`,
          );
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // -- bridge_status ---------------------------------------------------------
  server.registerTool(
    'bridge_status',
    {
      title: 'Machine Status',
      description:
        'Check if a paired machine is reachable via SSH. As of 3.4.2, uses a single endpoint per machine: the configured `internet_host` (Tailscale) when set, otherwise the LAN `host`. No fallback. The `probe` flag is accepted for API compatibility but is a no-op. If no machine name is provided, checks all paired machines.',
      inputSchema: {
        machine: z
          .string()
          .optional()
          .describe('Name of the machine to check. Omit to check all.'),
        probe: z
          .boolean()
          .optional()
          .describe(
            'Retained for API compatibility. No-op since 3.4.2 — Tailscale-first policy no longer uses the last-reachable-path cache to select an endpoint.',
          ),
      },
    },
    async ({ machine, probe }) => {
      const machines = loadConfig();
      const localName = getLocalMachineName();

      // Same-machine status: no SSH, always reachable. Reported as
      // "LOCAL (no SSH)" so callers don't confuse it with a Tailscale endpoint.
      if (machine && isLocalMachineName(machine)) {
        const text = `${localName}: LOCAL (no SSH — same-machine delivery via inbox/<target>/)`;
        logEvent({
          event: 'tool.bridge_status',
          msg: `bridge_status: ${localName} is LOCAL (same-machine)`,
          context: { machine: localName, transport: 'local', reachable: true },
        });
        return { content: [{ type: 'text' as const, text }] };
      }

      if (!machine && machines.length === 0) {
        // No paired remotes — still surface the local machine so callers know
        // same-machine delivery is available.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${localName}: LOCAL (no SSH — same-machine delivery via inbox/<target>/)\n`
                + 'No paired remote machines.',
            },
          ],
        };
      }

      if (machines.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No paired machines found.',
            },
          ],
        };
      }

      const toCheck = machine
        ? machines.filter(
            m => m.name.toLowerCase() === machine.toLowerCase(),
          )
        : machines;

      if (toCheck.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Machine "${machine}" not found. Available: ${machines.map(m => m.name).join(', ')}, `
                + `or "${localName}" / one of [${LOCAL_MACHINE_ALIASES.join(', ')}] for the local machine.`,
            },
          ],
          isError: true,
        };
      }

      const results: string[] = [];
      // When checking ALL machines, prepend a local-machine line so users see
      // same-machine delivery is available alongside the SSH peers.
      if (!machine) {
        results.push(`${localName}: LOCAL (no SSH — same-machine delivery via inbox/<target>/)`);
      }
      for (const m of toCheck) {
        const ping = await sshPingDetailed(m, { bypassPathCache: probe === true });
        const pathTag = `via ${ping.label.toLowerCase()}`;
        results.push(
          `${m.name}: ${ping.reachable ? 'ONLINE' : 'OFFLINE'} ` +
          `(${m.user}@${ping.host}:${ping.port} ${pathTag})`,
        );
        logEvent({
          event: 'tool.bridge_status',
          msg: `bridge_status: ${m.name} is ${ping.reachable ? 'ONLINE' : 'OFFLINE'} ${pathTag}`,
          context: {
            machine: m.name,
            host: ping.host,
            port: ping.port,
            path: ping.kind,
            reachable: ping.reachable,
            bypass_cache: probe === true,
          },
        });
      }

      return {
        content: [{ type: 'text' as const, text: results.join('\n') }],
      };
    },
  );

  // -- bridge_send_message ---------------------------------------------------
  server.registerTool(
    'bridge_send_message',
    {
      title: 'Send Message',
      description:
        'Send a message to a running agent on another machine, OR to a same-machine target. Cross-machine sends go via SSH; same-machine sends write directly to the local inbox (no SSH). The receiver picks up the message via their per-target inbox subdir:\n'
        + '  • target="claude-code"           — Claude Code channel plugin (default for cross-machine Claude ↔ Claude)\n'
        + '  • target="openclaw/default"      — OpenClaw @ClawdStationMiniBot running Telegram session\n'
        + '  • target="openclaw/clawdiboi2"   — OpenClaw @Clawdiboi2bot running Telegram session\n'
        + '  • target="openclaw/clordlethird" — OpenClaw @ClordLeThirdBot running Telegram session\n'
        + '  • target="<harness>/<name>"      — any other configured harness\n\n'
        + 'The `machine` parameter accepts either a paired remote machine name OR the local machine name (or one of the aliases "local", "self", "localhost"). Same-machine delivery is first-class (3.5.0+): the message JSON is written directly to ~/.agent-bridge/inbox/<target>/<id>.json with no SSH hop. Useful for routing to OpenClaw embedded agents (target="openclaw/<account>") on the same host.\n\n'
        + 'The target field is REQUIRED as of agent-bridge 3.4.0 — there is intentionally no default delivery routing. '
        + 'Messages without a target are rejected at the sender. Legacy messages that land at the root of the inbox on the receiver are moved to .failed/_unrouted/ on next startup. '
        + '`from_target` / `fromTarget` defaults to `claude-code` for normal Claude Code sends so the remote agent can reply over agent-bridge. '
        + 'Set `one_way=true` only when you intentionally do not want a bridge reply path.',      inputSchema: {
        machine: z
          .string()
          .describe(
            'Name of the target machine. Pass a paired remote machine name for SSH delivery, OR the local machine name / one of the aliases ("local", "self", "localhost") for same-machine delivery (no SSH).',
          ),
        message: z.string().describe('The message content to send'),
        target: z
          .string()
          .describe(
            'Required. Slash-delimited routing target, e.g. "claude-code", "openclaw/clawdiboi2". Determines which inbox subdir on the remote the message lands in, and which listener picks it up.',
          ),
        from_target: z
          .string()
          .optional()
          .describe(
            'Sender-side reply target for round-trip routing. Defaults to `claude-code` for Claude Code sends. Set explicitly when sending from another local target such as `openclaw/default` or `openclaw/clawdiboi2`.',
          ),
        fromTarget: z
          .string()
          .optional()
          .describe(
            'CamelCase alias for `from_target`. Same meaning.',
          ),
        one_way: z
          .boolean()
          .optional()
          .describe(
            'If true, omit fromTarget entirely. Use only for deliberate one-way injection where no bridge reply should be routed back.',
          ),
        reply_to: z
          .string()
          .optional()
          .describe('Message ID this is a reply to'),
        ttl: z
          .number()
          .optional()
          .describe(
            `Time-to-live in seconds. 0 = no expiry. Default: ${DEFAULT_TTL_SECONDS}`,
          ),
      },
    },
    async ({ machine: machineName, message, target, from_target, fromTarget, one_way, reply_to, ttl }) => {
      const localName = getLocalMachineName();
      const isLocal = isLocalMachineName(machineName);
      const machine = isLocal ? null : getMachine(machineName);
      if (!isLocal && !machine) {
        const all = loadConfig();
        const availableNames = [
          localName,
          ...all.map(m => m.name),
          ...LOCAL_MACHINE_ALIASES,
        ].join(', ');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Machine "${machineName}" not found. Available: ${availableNames}. `
                + `(Pass the local machine name or "local"/"self"/"localhost" for same-machine delivery.)`,
            },
          ],
          isError: true,
        };
      }

      // Validate target up-front so we return a helpful error rather than
      // letting sendMessage throw deep in the SCP path.
      if (!target || !isValidTarget(target)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Missing/invalid target. The target field is REQUIRED as of agent-bridge 3.4.0 — there is no default routing. `
                + `Use "claude-code" for Claude Code ↔ Claude Code, or "openclaw/<account>" for an OpenClaw Telegram session. `
                + `Got: ${JSON.stringify(target ?? null)}.`,
            },
          ],
          isError: true,
        };
      }

      let resolvedFromTarget: string | undefined;
      try {
        resolvedFromTarget = resolveFromTargetArg({
          from_target,
          fromTarget,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid from_target/fromTarget: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
      if (one_way && resolvedFromTarget) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid routing: one_way=true cannot be combined with from_target/fromTarget.',
            },
          ],
          isError: true,
        };
      }
      if (!resolvedFromTarget && !one_way) {
        resolvedFromTarget = CLAUDE_CODE_TARGET;
      }
      if (resolvedFromTarget && !isValidTarget(resolvedFromTarget)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Missing/invalid from_target. When provided it must be a valid target like `
                + `"claude-code" or "openclaw/<account>". `
                + `Got: ${JSON.stringify(resolvedFromTarget)}.`,
            },
          ],
          isError: true,
        };
      }

      // Always record the human-readable destination name. For local sends we
      // use the real local machine name even when the caller passed an alias,
      // so receivers (and the outbox copy) see a stable identifier.
      const toName = isLocal ? localName : machineName;
      const msg = createMessage(
        localName,
        toName,
        'message',
        message,
        reply_to ?? null,
        ttl ?? DEFAULT_TTL_SECONDS,
        target,
        resolvedFromTarget,
      );

      try {
        if (isLocal) {
          sendLocalMessage(msg);
        } else {
          await sendMessage(machine!, msg);
        }
        const transportLabel = isLocal ? 'local' : 'ssh';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Message sent to ${toName} target=${target} transport=${transportLabel}`
                + `${resolvedFromTarget ? ` from_target=${resolvedFromTarget}` : ' one_way=true'}`
                + ` (id: ${msg.id})`,
            },
          ],
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(`Failed to send message to ${toName} target=${target}: ${errMsg}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to send message to ${toName} target=${target}: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- bridge_receive_messages -----------------------------------------------
  server.registerTool(
    'bridge_receive_messages',
    {
      title: 'Receive Messages',
      description:
        'Manual claude-code inbox inspection fallback. In normal Claude Code channel-owner mode, incoming messages are pushed automatically; use this tool mainly for diagnostics, tools-only setups, or explicit manual consumption. Messages are removed from ~/.agent-bridge/inbox/claude-code/ after reading unless peek=true. Results are chronological, deduplicated, and TTL-expired messages are auto-pruned.',
      inputSchema: {
        peek: z
          .boolean()
          .optional()
          .describe(
            'If true, check messages without consuming them. Default: false (consume).',
          ),
      },
    },
    async ({ peek }) => {
      if (peek) {
        const { count, messages } = peekInbox();
        if (count === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No messages in inbox.' },
            ],
          };
        }
        const lines = [`${count} message(s) in inbox:`, ''];
        for (const msg of messages) {
          lines.push(
            `[${msg.timestamp}] From ${msg.from} (${msg.type}): ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`,
          );
          if (msg.replyTo) {
            lines.push(`  (reply to: ${msg.replyTo})`);
          }
          lines.push(`  ID: ${msg.id}`);
          if (msg.ttl !== undefined) {
            lines.push(`  TTL: ${msg.ttl}s`);
          }
          lines.push('');
        }
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }

      const messages = consumeInbox();
      if (messages.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No messages in inbox.' },
          ],
        };
      }

      const lines = [`Received ${messages.length} message(s):`, ''];
      for (const msg of messages) {
        lines.push(`--- Message from ${msg.from} ---`);
        lines.push(`ID: ${msg.id}`);
        lines.push(`Type: ${msg.type}`);
        lines.push(`Time: ${msg.timestamp}`);
        if (msg.replyTo) {
          lines.push(`Reply to: ${msg.replyTo}`);
        }
        if (msg.ttl !== undefined) {
          lines.push(`TTL: ${msg.ttl}s`);
        }
        lines.push(`Content: ${msg.content}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // -- bridge_run_command ----------------------------------------------------
  server.registerTool(
    'bridge_run_command',
    {
      title: 'Run Remote Command',
      description:
        'Run a PLAIN shell command on a remote paired machine via SSH. Returns stdout, stderr, and exit code. Use this ONLY for diagnostic/utility shell work (e.g. `git status`, `ls ~/Projects`, `ps aux`, tailing a log). Do NOT use it to invoke an agent CLI (`claude --print`, `codex exec`, `aider`, etc.) — to communicate with the running agent on the remote machine, use bridge_send_message instead. Fresh-spawn agent wrappers are not supported and never will be.',
      inputSchema: {
        machine: z.string().describe('Name of the target machine'),
        command: z.string().describe('Shell command to execute'),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in milliseconds (default: 30000)'),
      },
    },
    async ({ machine: machineName, command, timeout }) => {
      // bridge_run_command is intentionally cross-machine only: there is no
      // SSH-to-self path. For local shell work, the harness has direct shell
      // access already (Bash tool, etc.). Reject local routes loudly so users
      // don't accidentally rely on a non-existent "run on self via SSH" path.
      if (isLocalMachineName(machineName)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `bridge_run_command targets remote machines only. "${machineName}" is the local machine — `
                + 'just run the command directly in your harness shell. There is no SSH loopback in agent-bridge.',
            },
          ],
          isError: true,
        };
      }

      const machine = getMachine(machineName);
      if (!machine) {
        const all = loadConfig();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Machine "${machineName}" not found. Available: ${all.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      logInfo(`Running command on ${machineName}: ${command}`);
      logEvent({
        event: 'tool.bridge_run_command',
        msg: `Running command on ${machineName}`,
        context: { machine: machineName, command, timeout_ms: timeout ?? 30000 },
      });

      try {
        const result = await sshExec(machine, command, timeout ?? 30000);
        const parts: string[] = [];

        if (result.stdout.trim()) {
          parts.push(`stdout:\n${result.stdout}`);
        }
        if (result.stderr.trim()) {
          parts.push(`stderr:\n${result.stderr}`);
        }
        parts.push(`exit code: ${result.exitCode}`);

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(`Command failed on ${machineName}: ${errMsg}`);
        logEvent({
          event: 'tool.bridge_run_command.failed',
          level: 'error',
          msg: `Command failed on ${machineName}`,
          context: { machine: machineName, command, error: errMsg },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to run command on ${machineName}: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- bridge_clear_inbox ----------------------------------------------------
  server.registerTool(
    'bridge_clear_inbox',
    {
      title: 'Clear Inbox',
      description: 'Remove all messages from the local claude-code inbox subdir.',
    },
    async () => {
      const count = clearInbox();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              count > 0
                ? `Cleared ${count} message(s) from claude-code inbox.`
                : 'Inbox was already empty.',
          },
        ],
      };
    },
  );

  // -- bridge_inbox_stats ----------------------------------------------------
  server.registerTool(
    'bridge_inbox_stats',
    {
      title: 'Inbox Stats',
      description:
        'Get claude-code inbox statistics: pending message count, oldest message age, total size, watcher health, processed ID count, and failed/quarantined count.',
    },
    async () => {
      const stats = getInboxStats();
      const lines = [
        'Claude Code Inbox Statistics:',
        `  Pending claude-code messages: ${stats.pendingCount}`,
        `  Oldest message age: ${stats.oldestMessageAge !== null ? `${stats.oldestMessageAge}s` : 'n/a'}`,
        `  Total inbox size: ${formatBytes(stats.totalSizeBytes)}`,
        `  Watcher backend: ${stats.watcherBackend}`,
        `  Watcher healthy: ${stats.watcherHealthy ? 'yes' : 'no'}`,
        `  Watcher lease: ${formatWatcherLease(stats)}`,
        `  Processed IDs tracked: ${stats.processedIdCount}`,
        `  Failed/quarantined: ${stats.failedCount}`,
      ];

      logInfo('Inbox stats requested');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}

function resolveFromTargetArg(params: {
  from_target?: string;
  fromTarget?: string;
}): string | undefined {
  const snake = params.from_target?.trim();
  const camel = params.fromTarget?.trim();

  if (snake && camel && snake !== camel) {
    throw new Error(
      `Conflicting from_target/fromTarget values: ${JSON.stringify(snake)} !== ${JSON.stringify(camel)}`,
    );
  }

  return snake || camel || undefined;
}

function formatWatcherLease(stats: ReturnType<typeof getInboxStats>): string {
  if (stats.watcherLeasePid === null) return 'none';
  const age = stats.watcherLeaseAge !== null ? `${stats.watcherLeaseAge}s` : 'n/a';
  const alive = stats.watcherLeaseAlive === null ? 'unknown' : (stats.watcherLeaseAlive ? 'yes' : 'no');
  const fresh = stats.watcherLeaseFresh === null ? 'unknown' : (stats.watcherLeaseFresh ? 'yes' : 'no');
  const role = stats.watcherLeaseRole ?? 'unknown';
  return `pid=${stats.watcherLeasePid} role=${role} alive=${alive} fresh=${fresh} age=${age}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
