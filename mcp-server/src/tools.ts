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
  DEFAULT_TTL_SECONDS,
  CLAUDE_CODE_TARGET,
  isValidTarget,
} from './config.js';
import { sshExec, sshPing } from './ssh.js';
import {
  createMessage,
  sendMessage,
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
        'List all paired machines and their connection details. Shows machine name, host, user, port, and pairing date.',
    },
    async () => {
      const machines = loadConfig();
      const localName = getLocalMachineName();

      if (machines.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No paired machines found. This machine is "${localName}". Use \`agent-bridge pair\` to add a remote machine.`,
            },
          ],
        };
      }

      const lines = [`Local machine: ${localName}`, '', 'Paired machines:'];
      for (const m of machines) {
        lines.push(
          `  - ${m.name}: ${m.user}@${m.host}:${m.port} (paired ${m.pairedAt})`,
        );
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
        'Check if a paired machine is reachable via SSH. Uses the last-reachable-path cache so off-network checks stay fast. Pass `probe: true` to force a fresh LAN-first probe. If no machine name is provided, checks all paired machines.',
      inputSchema: {
        machine: z
          .string()
          .optional()
          .describe('Name of the machine to check. Omit to check all.'),
        probe: z
          .boolean()
          .optional()
          .describe(
            'Bypass the last-reachable-path cache and force a fresh LAN-first probe. Useful when network topology just changed.',
          ),
      },
    },
    async ({ machine, probe }) => {
      const machines = loadConfig();

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
              text: `Machine "${machine}" not found. Available: ${machines.map(m => m.name).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const results: string[] = [];
      for (const m of toCheck) {
        const reachable = await sshPing(m, { bypassPathCache: probe === true });
        results.push(
          `${m.name}: ${reachable ? 'ONLINE' : 'OFFLINE'} (${m.user}@${m.host}:${m.port})`,
        );
        logEvent({
          event: 'tool.bridge_status',
          msg: `bridge_status: ${m.name} is ${reachable ? 'ONLINE' : 'OFFLINE'}`,
          context: { machine: m.name, host: m.host, reachable, bypass_cache: probe === true },
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
        'Send a message to a running agent on another machine. The message is delivered to their per-target inbox subdir via SSH and pushed into the matching agent harness:\n'
        + '  • target="claude-code"           — Claude Code channel plugin (default for cross-machine Claude ↔ Claude)\n'
        + '  • target="openclaw/default"      — OpenClaw @ClawdStationMiniBot running Telegram session\n'
        + '  • target="openclaw/clawdiboi2"   — OpenClaw @Clawdiboi2bot running Telegram session\n'
        + '  • target="openclaw/clordlethird" — OpenClaw @ClordLeThirdBot running Telegram session\n'
        + '  • target="<harness>/<name>"      — any other configured harness\n\n'
        + 'The target field is REQUIRED as of agent-bridge 3.4.0 — there is intentionally no default routing. '
        + 'Messages without a target are rejected at the sender. Legacy messages that land at the root of the inbox on the receiver are moved to .failed/_unrouted/ on next startup.',
      inputSchema: {
        machine: z.string().describe('Name of the target machine'),
        message: z.string().describe('The message content to send'),
        target: z
          .string()
          .describe(
            'Required. Slash-delimited routing target, e.g. "claude-code", "openclaw/clawdiboi2". Determines which inbox subdir on the remote the message lands in, and which listener picks it up.',
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
    async ({ machine: machineName, message, target, reply_to, ttl }) => {
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

      const localName = getLocalMachineName();
      const msg = createMessage(
        localName,
        machineName,
        'message',
        message,
        reply_to ?? null,
        ttl ?? DEFAULT_TTL_SECONDS,
        target,
        CLAUDE_CODE_TARGET,
      );

      try {
        await sendMessage(machine, msg);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message sent to ${machineName} target=${target} (id: ${msg.id})`,
            },
          ],
        };
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logError(`Failed to send message to ${machineName} target=${target}: ${errMsg}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to send message to ${machineName} target=${target}: ${errMsg}`,
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
        'Check for and consume incoming messages from other machines. Messages are removed from the inbox after reading. Use peek=true to check without consuming. Messages are returned in chronological order, deduplicated, and TTL-expired messages are auto-pruned.',
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
      description: 'Remove all messages from the local inbox.',
    },
    async () => {
      const count = clearInbox();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              count > 0
                ? `Cleared ${count} message(s) from inbox.`
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
        'Get inbox statistics: pending message count, oldest message age, total size, watcher health, processed ID count, and failed message count.',
    },
    async () => {
      const stats = getInboxStats();
      const lines = [
        'Inbox Statistics:',
        `  Pending messages: ${stats.pendingCount}`,
        `  Oldest message age: ${stats.oldestMessageAge !== null ? `${stats.oldestMessageAge}s` : 'n/a'}`,
        `  Total inbox size: ${formatBytes(stats.totalSizeBytes)}`,
        `  Watcher backend: ${stats.watcherBackend}`,
        `  Watcher healthy: ${stats.watcherHealthy ? 'yes' : 'no'}`,
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
