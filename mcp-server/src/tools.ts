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
  peekInboxForTarget,
  clearInbox,
  getInboxStats,
  getActiveClaudeCodeTargetOrDefault,
} from './inbox.js';
import { subscribeToInboxArrival } from './watcher.js';
import { logInfo, logError } from './logger.js';
import { logEvent } from './log.js';

// 3.8.0 — long-poll bounds for `bridge_receive_messages`. The default 30 s
// keeps pollers reasonably tight while the 60 s cap ensures we never park an
// MCP request beyond the harness's tolerance for an idle JSON-RPC response.
const LONG_POLL_DEFAULT_TIMEOUT_S = 30;
const LONG_POLL_MAX_TIMEOUT_S = 60;

function normalizeRelaySummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

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
        + '  • target="claude-code/default"         — Claude Code channel plugin (default persona; pre-4.0.0 senders may still address "claude-code" and the receiver routes it to "claude-code/default")\n'
        + '  • target="claude-code/<persona>"       — Claude Code channel plugin for a non-default persona (4.0.0+ multi-session support, e.g. "claude-code/yolo")\n'
        + '  • target="openclaw/default"            — example: an OpenClaw running Telegram session (the "default" account)\n'
        + '  • target="<harness>/<account-alias>"   — any other configured harness/per-account session, e.g. "openclaw/<your-account-alias>"\n\n'
        + 'Named-target routing rule: when the user names a specific target alias (a persona, a session, a per-account bot, etc.), match the alias LITERALLY — do NOT silently default to "<harness>/default" when a specific alias was named. Voice transcripts often mis-hear short proper-noun aliases; re-read the source twice if a specific name was mentioned. Canonical rule + rationale: docs/named-target-routing.md.\n\n'
        + '**Recipient relay rule**: when YOU receive an inbound bridge message via the `<channel source="agent-bridge">` block, relay a compact 1-3 sentence summary (source machine + source target + destination machine + destination target + actionable ask) to the user via your harness\'s configured user-facing channel (Telegram, Slack, Discord, native UI, etc.) so the user has live visibility into cross-harness coordination without dumping the full bridge body. When YOU send a bridge message and user-facing visibility matters, pass `relay_summary` / `relaySummary` with a source-authored 1-3 sentence summary; OpenClaw destinations can use that to code-post the visible relay receipt before the destination agent turn. Use the generated relay scaffold when present: it labels both the source endpoint + source agent-bridge version and the destination endpoint + destination agent-bridge version. If composing a fallback manually, read `source_agent_bridge_version` / `destination_agent_bridge_version` from metadata or call `claude_code_channel_status` for the local destination version; do NOT hardcode. If the user asks to expand an OpenClaw `[Agent Bridge relay]` notice by its `expand id`, run `agent-bridge relay-expand <id>` on that same machine and send the retrieved full content subject to normal privacy/channel rules. Reply via bridge first if needed, THEN relay to the user. Don\'t suppress routine messages except pure-noise heartbeats / `bridge_status` polls. See AGENTS.md "Relay inbound bridge messages to the user" + canonical doc docs/relay-to-user.md.\n\n'
        + 'The `machine` parameter accepts either a paired remote machine name OR the local machine name (or one of the aliases "local", "self", "localhost"). Same-machine delivery is first-class (3.5.0+): the message JSON is written directly to ~/.agent-bridge/inbox/<target>/<id>.json with no SSH hop. Useful for routing to embedded agents (e.g. target="<harness>/<account-alias>") on the same host.\n\n'
        + 'The target field is REQUIRED as of agent-bridge 3.4.0 — there is intentionally no default delivery routing. '
        + 'Messages without a target are rejected at the sender. Legacy messages that land at the root of the inbox on the receiver are moved to .failed/_unrouted/ on next startup. '
        + '`from_target` / `fromTarget` defaults to `claude-code/<persona>` (the active persona of THIS Claude Code session) for normal Claude Code sends so the remote agent can reply back into THIS session\'s inbox subdir. Falls back to `claude-code/default` when no persona is bound (for example tools-only/cold-start contexts). '
        + 'Set `one_way=true` only when you intentionally do not want a bridge reply path.',
      inputSchema: {
        machine: z
          .string()
          .describe(
            'Name of the target machine. Pass a paired remote machine name for SSH delivery, OR the local machine name / one of the aliases ("local", "self", "localhost") for same-machine delivery (no SSH).',
          ),
        message: z.string().describe('The message content to send'),
        target: z
          .string()
          .describe(
            'Required. Slash-delimited routing target, e.g. "claude-code/default", "claude-code/<persona>", "<harness>/<account-alias>" (such as "openclaw/default"). Determines which inbox subdir on the remote the message lands in, and which listener picks it up. Senders may still use the legacy "claude-code" literal — the receiver routes it to "claude-code/default" for backward compatibility.',
          ),
        from_target: z
          .string()
          .optional()
          .describe(
            'Sender-side reply target for round-trip routing. Defaults to the active `claude-code/<persona>` for Claude Code sends (so replies land back in THIS session). Set explicitly when sending from another local target such as `<harness>/<account-alias>`.',
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
        relay_summary: z
          .string()
          .optional()
          .describe(
            'Optional source-authored 1-3 sentence summary for the user-facing Agent Bridge relay receipt. Use this when the destination harness should code-post the visible relay notice without asking the destination agent to summarize.',
          ),
        relaySummary: z
          .string()
          .optional()
          .describe('CamelCase alias for `relay_summary`. Same meaning.'),
        ttl: z
          .number()
          .optional()
          .describe(
            `Time-to-live in seconds. 0 = no expiry. Default: ${DEFAULT_TTL_SECONDS}`,
          ),
      },
    },
    async ({
      machine: machineName,
      message,
      target,
      from_target,
      fromTarget,
      one_way,
      reply_to,
      relay_summary,
      relaySummary,
      ttl,
    }) => {
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
      // letting sendMessage throw deep in the SFTP delivery path.
      if (!target || !isValidTarget(target)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Missing/invalid target. The target field is REQUIRED as of agent-bridge 3.4.0 — there is no default routing. `
                + `Use "claude-code/default" for the default Claude Code persona, "claude-code/<persona>" for a named Claude Code persona, or "<harness>/<account-alias>" (e.g. "openclaw/default") for a per-account session. `
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
        // 4.0.0 — Default the sender's return-target to a persona-scoped
        // target ("claude-code/<persona>") rather than the legacy
        // `claude-code` literal. The reply lands back in the active
        // persona's inbox subdir on the receiver. Tools-only children
        // (no persona bound, `getActiveClaudeCodeTarget()` returns null)
        // fall back to `claude-code/default` so the response we send to
        // the caller MATCHES the on-disk `fromTarget` after `sendMessage`
        // applies its CLAUDE_CODE_TARGET → claude-code/default rewrite —
        // we apply the same rewrite up front to avoid disagreement.
        resolvedFromTarget = getActiveClaudeCodeTargetOrDefault();
      }
      if (resolvedFromTarget && !isValidTarget(resolvedFromTarget)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Missing/invalid from_target. When provided it must be a valid target like `
                + `"claude-code/default", "claude-code/<persona>", or "<harness>/<account-alias>". `
                + `Got: ${JSON.stringify(resolvedFromTarget)}.`,
            },
          ],
          isError: true,
        };
      }

      const resolvedRelaySummary = normalizeRelaySummary(relay_summary ?? relaySummary);

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
        undefined,
        resolvedRelaySummary,
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
  //
  // 3.8.0 — long-poll/blocking receive support.
  //
  // Default behaviour (`wait=false`) is unchanged: a single snapshot of the
  // active Claude Code persona inbox, peek or consume per the existing flag.
  //
  // When `wait=true`, the tool blocks until either:
  //   1. The inbox already contains messages at call time (returns
  //      immediately, no `timed_out` flag), OR
  //   2. A new file arrives in the active persona inbox (for example
  //      `~/.agent-bridge/inbox/claude-code/default/`) and the watcher
  //      fires the in-process arrival listener (returns the
  //      now-pending messages, no `timed_out` flag), OR
  //   3. `timeout_seconds` elapses without an arrival (returns `[]` plus
  //      `timed_out: true` in the structured response so the caller can
  //      loop and re-poll).
  //
  // Concurrency: the in-process arrival registry is BROADCAST. Multiple
  // concurrent long-pollers (parent session + N subagents on the same
  // machine) all wake on the same arrival. The shared inbox snapshot
  // (peek/consume) governs whether the file moves to .archive/ or stays
  // pending — `peek` is the idempotent path; `consume` is destructive
  // first-come-first-served and only ONE concurrent caller will see the
  // message returned (the rest will see an empty inbox after the consume
  // wins). For subagent fan-out use `peek: true` so every long-poller
  // sees the same content.
  server.registerTool(
    'bridge_receive_messages',
    {
      title: 'Receive Messages',
      description:
        'Manual active Claude Code persona inbox inspection / long-poll receive. In normal Claude Code channel-owner mode, incoming messages are pushed automatically into the running parent session; channel pushes do NOT reach subagents. Subagents that need to receive a bridge reply should call this tool with `wait: true, timeout_seconds: 30` and loop on `timed_out: true` until the expected message arrives (or use `peek: true` so the parent and other subagents still see the same content). '
        + 'Messages are removed from the active persona inbox (for example ~/.agent-bridge/inbox/claude-code/default/) after reading unless peek=true. Results are chronological, deduplicated, and TTL-expired messages are auto-pruned. '
        + 'When `wait: true` and no message is in the inbox, the tool blocks until either an arrival is detected via the in-process watcher hook or `timeout_seconds` elapses. On timeout the response includes `timed_out: true` (additive flag — pre-3.8.0 callers ignoring it still see the empty result). Server-side cap on `timeout_seconds` is 60. '
        + 'For diagnostics, pass `target` to non-destructively peek another target inbox such as `openclaw/default`; target peeks never consume messages and can include pending-ack/archive files for post-mortem routing checks.',
      inputSchema: {
        peek: z
          .boolean()
          .optional()
          .describe(
            'If true, check messages without consuming them. Default: false (consume).',
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            'If true, block until a message arrives or `timeout_seconds` elapses. Default: false (snapshot the current inbox and return immediately, preserving pre-3.8.0 behaviour).',
          ),
        timeout_seconds: z
          .number()
          .optional()
          .describe(
            `Long-poll duration in seconds when wait=true. Default: ${LONG_POLL_DEFAULT_TIMEOUT_S}. Server caps at ${LONG_POLL_MAX_TIMEOUT_S}.`,
          ),
        target: z
          .string()
          .optional()
          .describe(
            'Optional slash-delimited target to inspect non-destructively, e.g. "openclaw/default", "openclaw/clawdiboi2", or "claude-code/default". Target peeks are diagnostics-only and never consume.',
          ),
        include_archived: z
          .boolean()
          .optional()
          .describe(
            'When target is provided, also search ~/.agent-bridge/inbox/.archive/<target>/ for delivered messages. Default: false.',
          ),
        include_pending_ack: z
          .boolean()
          .optional()
          .describe(
            'When target is provided, also search ~/.agent-bridge/inbox/.pending-ack/<target>/ for messages staged after a channel push. Default: false.',
          ),
        reply_to: z
          .string()
          .optional()
          .describe(
            'When target is provided, filter pending/pending-ack/archive results to a specific replyTo message id.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            'When target is provided, return at most this many newest messages per section. Default: 50, max: 500.',
          ),
      },
    },
    async ({ peek, wait, timeout_seconds, target, include_archived, include_pending_ack, reply_to, limit }) => {
      // -- target diagnostic path ------------------------------------------
      // The default receive path is intentionally Claude-persona scoped. This
      // explicit target peek covers OpenClaw/other harness diagnostics without
      // racing their watchers by consuming or quarantining their files.
      if (target) {
        if (!isValidTarget(target)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid target ${JSON.stringify(target)}. Expected a slash-delimited target like "openclaw/default" or "claude-code/default".`,
              },
            ],
            isError: true,
          };
        }
        if (wait) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'target-specific bridge_receive_messages is diagnostic peek-only and does not support wait=true. '
                  + 'Omit target to long-poll the active Claude Code persona inbox, or repeat a target peek from the caller.',
              },
            ],
            isError: true,
          };
        }

        const result = peekInboxForTarget(target, {
          includeArchived: include_archived === true,
          includePendingAck: include_pending_ack === true,
          replyTo: reply_to,
          limit,
        });
        const total = result.pending.length + result.pendingAck.length + result.archived.length;
        const lines: string[] = [
          total === 0
            ? `No messages found for target=${target}.`
            : `${total} message(s) found for target=${target}:`,
          '',
        ];

        const appendSection = (label: string, messages: typeof result.pending) => {
          if (messages.length === 0) return;
          lines.push(`${label}:`);
          for (const msg of messages) {
            lines.push(
              `- [${msg.timestamp}] ${msg.id} from=${msg.from}`
              + (msg.fromTarget ? ` fromTarget=${msg.fromTarget}` : '')
              + (msg.replyTo ? ` replyTo=${msg.replyTo}` : '')
              + ` content=${JSON.stringify(msg.content.substring(0, 200))}${msg.content.length > 200 ? '...' : ''}`,
            );
          }
          lines.push('');
        };

        appendSection('pending', result.pending);
        appendSection('pending-ack', result.pendingAck);
        appendSection('archived', result.archived);
        if (result.parseErrors.length > 0) {
          lines.push(`parse errors (non-mutating): ${result.parseErrors.length}`);
          for (const err of result.parseErrors.slice(0, 5)) lines.push(`- ${err}`);
          if (result.parseErrors.length > 5) lines.push(`- +${result.parseErrors.length - 5} more`);
          lines.push('');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
          structuredContent: {
            target,
            count: total,
            pending: result.pending,
            pending_ack: result.pendingAck,
            archived: result.archived,
            parse_errors: result.parseErrors,
            peek_only: true,
            timed_out: false,
          },
        };
      }

      // -- 3.8.0 — long-poll helper ----------------------------------------
      // Reads the inbox via peek or consume, returns the formatted result
      // alongside structured metadata. Used both for the immediate-snapshot
      // path and for the post-wake re-read.
      const readSnapshot = (): { count: number; output: { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> } } => {
        if (peek) {
          const { count, messages } = peekInbox();
          if (count === 0) {
            return {
              count: 0,
              output: {
                content: [{ type: 'text' as const, text: 'No messages in inbox.' }],
                structuredContent: { count: 0, messages: [], timed_out: false },
              },
            };
          }
          const lines = [`${count} message(s) in inbox:`, ''];
          for (const msg of messages) {
            lines.push(
              `[${msg.timestamp}] From ${msg.from} (${msg.type}): ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`,
            );
            if (msg.replyTo) lines.push(`  (reply to: ${msg.replyTo})`);
            lines.push(`  ID: ${msg.id}`);
            if (msg.ttl !== undefined) lines.push(`  TTL: ${msg.ttl}s`);
            lines.push('');
          }
          return {
            count,
            output: {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
              structuredContent: { count, messages, timed_out: false },
            },
          };
        }

        const messages = consumeInbox();
        if (messages.length === 0) {
          return {
            count: 0,
            output: {
              content: [{ type: 'text' as const, text: 'No messages in inbox.' }],
              structuredContent: { count: 0, messages: [], timed_out: false },
            },
          };
        }
        const lines = [`Received ${messages.length} message(s):`, ''];
        for (const msg of messages) {
          lines.push(`--- Message from ${msg.from} ---`);
          lines.push(`ID: ${msg.id}`);
          lines.push(`Type: ${msg.type}`);
          lines.push(`Time: ${msg.timestamp}`);
          if (msg.replyTo) lines.push(`Reply to: ${msg.replyTo}`);
          if (msg.ttl !== undefined) lines.push(`TTL: ${msg.ttl}s`);
          lines.push(`Content: ${msg.content}`);
          lines.push('');
        }
        return {
          count: messages.length,
          output: {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            structuredContent: { count: messages.length, messages, timed_out: false },
          },
        };
      };

      // -- non-wait path: original snapshot semantics, untouched -----------
      if (!wait) {
        return readSnapshot().output;
      }

      // -- wait path: long-poll via watcher.subscribeToInboxArrival --------
      // 1. If the inbox is already non-empty, return immediately. This
      //    eliminates a needless 30 s park whenever a caller arrives just
      //    after delivery. Note we use peekInbox here (not the `peek`
      //    arg) — the read-without-consume probe is just for fast-path
      //    detection. The actual return uses readSnapshot which honours
      //    the caller's peek flag.
      const initialPeek = peekInbox();
      if (initialPeek.count > 0) {
        return readSnapshot().output;
      }

      // 2. No messages now. Park until arrival or timeout. Cap timeout
      //    to LONG_POLL_MAX_TIMEOUT_S so a misconfigured caller can't
      //    pin an MCP request indefinitely.
      const requestedTimeout = typeof timeout_seconds === 'number' && Number.isFinite(timeout_seconds)
        ? Math.max(0, timeout_seconds)
        : LONG_POLL_DEFAULT_TIMEOUT_S;
      const timeoutSec = Math.min(requestedTimeout, LONG_POLL_MAX_TIMEOUT_S);
      const timeoutMs = Math.floor(timeoutSec * 1000);

      logEvent({
        event: 'tool.bridge_receive_messages.long_poll_start',
        msg: `bridge_receive_messages long-poll waiting up to ${timeoutSec}s`,
        context: { timeout_s: timeoutSec, peek: peek === true, requested_timeout_s: requestedTimeout },
      });

      const woken = await new Promise<'arrival' | 'timeout'>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const settle = (outcome: 'arrival' | 'timeout') => {
          if (settled) return;
          settled = true;
          if (timer) {
            try { clearTimeout(timer); } catch { /* ignore */ }
            timer = null;
          }
          if (unsubscribe) {
            try { unsubscribe(); } catch { /* ignore */ }
            unsubscribe = null;
          }
          resolve(outcome);
        };

        // Listener fires when watcher detects new file(s). Broadcast — every
        // long-poller wakes on the same arrival; each then reads the inbox
        // independently (peek or consume) per its own flag.
        unsubscribe = subscribeToInboxArrival(() => settle('arrival'));

        // The unsub fn returned by subscribeToInboxArrival is idempotent;
        // calling it after the listener already fired (and was auto-removed
        // from the registry) is a no-op.

        if (timeoutMs <= 0) {
          // Pathological: wait=true, timeout_seconds=0. Behave as a no-wait
          // snapshot — fire 'timeout' on the next microtask so the listener
          // is still cleaned up via settle().
          setImmediate(() => settle('timeout'));
        } else {
          timer = setTimeout(() => settle('timeout'), timeoutMs);
          // Keep the timer ref'd: the outstanding MCP request is real work,
          // and the timeout must be able to resolve even in a quiet tools-only
          // process with no other active handles.
        }
      });

      logEvent({
        event: 'tool.bridge_receive_messages.long_poll_end',
        msg: `bridge_receive_messages long-poll ended (${woken})`,
        context: { outcome: woken, timeout_s: timeoutSec, peek: peek === true },
      });

      if (woken === 'timeout') {
        // No message arrived within the window. Return the empty-inbox
        // text + structured `timed_out: true` so the caller can loop.
        return {
          content: [
            {
              type: 'text' as const,
              text: `No messages in inbox (long-poll timed out after ${timeoutSec}s).`,
            },
          ],
          structuredContent: { count: 0, messages: [], timed_out: true, timeout_seconds: timeoutSec },
        };
      }

      // Arrival path — re-read the inbox now that the watcher has noticed
      // new file(s). The watcher already fired emitChannelNotification
      // before firing the in-process listener, but we still re-read here
      // because the LIST of pending files may include messages the channel
      // notification consumer (parent session) doesn't archive instantly.
      return readSnapshot().output;
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
      description: 'Remove all messages from the local active Claude Code persona inbox subdir.',
    },
    async () => {
      const count = clearInbox();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              count > 0
                ? `Cleared ${count} message(s) from active Claude Code persona inbox.`
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
        'Get active Claude Code persona inbox statistics: pending message count, oldest message age, total size, watcher health, processed ID count, and failed/quarantined count.',
    },
    async () => {
      const stats = getInboxStats();
      const lines = [
        'Claude Code Inbox Statistics:',
        `  Pending active Claude Code persona messages: ${stats.pendingCount}`,
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
