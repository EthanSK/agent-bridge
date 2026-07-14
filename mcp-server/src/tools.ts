/**
 * MCP tool definitions for agent-bridge v2.
 *
 * Tools:
 * - bridge_list_machines: List paired machines and their status
 * - bridge_status: Check if a machine is reachable
 * - bridge_send_message: Send a message to a remote machine's running agent
 * - bridge_notify: Pop a native macOS notification on a chosen Mac (local or remote)
 * - bridge_learnings_add: Record a fleet-wide learning in the shared-context store (+ replicate to peers)
 * - bridge_learnings_search: Search the fleet-wide shared-context learnings store
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
import { sshExec, sshExecWithEndpointFallback, sshPingDetailed } from './ssh.js';
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
import {
  renderLocalNotification,
  buildRemoteNotifyCommand,
  DEFAULT_NOTIFY_GROUP,
} from './notify.js';
import {
  createLearningEntry,
  appendLearningLocal,
  searchLearnings,
  formatLearning,
  buildRemoteIngestCommand,
  learningsFilePath,
} from './learnings.js';

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

  // -- bridge_notify ---------------------------------------------------------
  //
  // Pop a NATIVE macOS notification banner on a chosen Mac. Primary use: tell
  // the user "the agent finished task X" on whichever Mac they're sitting at.
  //
  // ROUTING (see notify.ts header for the full rationale):
  //   • machine = local (name/alias) → render in-process here via
  //     renderLocalNotification (terminal-notifier, osascript fallback).
  //   • machine = remote             → sshExec(m, "agent-bridge notify --local …")
  //     so the REMOTE machine's own bundled CLI renders natively on THAT Mac.
  //
  // This is a FIRE-AND-FORGET SIDE EFFECT — it does NOT wake/message the remote
  // agent and writes NO inbox file. For agent-to-agent messaging use
  // bridge_send_message. Unlike bridge_run_command, local IS a first-class
  // render path here (we do not reject local-loopback).
  server.registerTool(
    'bridge_notify',
    {
      title: 'Notify (native macOS banner)',
      description:
        'Pops a NATIVE macOS notification on a chosen paired Mac (or this one). '
        + 'Primary use: notify the user that an agent finished a task, on whichever Mac they are sitting at.\n\n'
        + 'The `machine` param accepts a paired remote name OR "local"/"self"/"localhost" (or this machine\'s real name). '
        + 'Local pops directly in-process; remote routes the notification over the bridge (SSH) to the target, which renders it natively there '
        + '(terminal-notifier if installed, otherwise an osascript fallback — decided per-machine by what is installed on the target).\n\n'
        + 'This is a FIRE-AND-FORGET side effect — it does NOT wake or message the remote agent, and writes no inbox file. '
        + 'For agent-to-agent messaging use bridge_send_message instead.\n\n'
        + 'Sound: omit or pass "none" for a silent banner; pass "default" for the system default; pass a named system sound (e.g. "Glass", "Ping") to use it. '
        + 'Subtitle is shown as a second line on terminal-notifier; on the osascript fallback (no subtitle field) it is folded into the title as "title — subtitle".',
      inputSchema: {
        machine: z
          .string()
          .describe(
            'Target machine: a paired remote name (renders natively on that Mac over SSH) OR the local machine name / an alias ("local", "self", "localhost") to pop the banner on THIS Mac.',
          ),
        title: z.string().describe('Notification title (required, bold first line).'),
        message: z.string().describe('Notification body text (required).'),
        subtitle: z
          .string()
          .optional()
          .describe('Optional subtitle (second line). Folded into the title on the osascript fallback.'),
        sound: z
          .string()
          .optional()
          .describe('Optional sound. "none"/omitted = silent; "default" = system default; or a named sound like "Glass"/"Ping".'),
        group: z
          .string()
          .optional()
          .describe(`Optional collapse id so repeat notifications replace instead of stacking. Default "${DEFAULT_NOTIFY_GROUP}".`),
      },
    },
    async ({ machine: machineName, title, message, subtitle, sound, group }) => {
      const isLocal = isLocalMachineName(machineName);

      // -- LOCAL PATH: render in-process, no SSH, no inbox --------------------
      if (isLocal) {
        try {
          renderLocalNotification({ title, message, subtitle, sound, group });
          logEvent({
            event: 'tool.bridge_notify',
            msg: `Notification rendered locally`,
            context: { machine: machineName, transport: 'local' },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `Notification delivered to ${machineName} (transport=local).`,
              },
            ],
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError(`Local notification failed: ${errMsg}`);
          logEvent({
            event: 'tool.bridge_notify.failed',
            level: 'error',
            msg: `Local notification failed`,
            context: { machine: machineName, transport: 'local', error: errMsg },
          });
          return {
            content: [
              { type: 'text' as const, text: `Failed to render local notification: ${errMsg}` },
            ],
            isError: true,
          };
        }
      }

      // -- REMOTE PATH: sshExec the remote's own `agent-bridge notify --local` -
      // Same not-found error shape as bridge_send_message / bridge_run_command.
      const machine = getMachine(machineName);
      if (!machine) {
        const all = loadConfig();
        const availableNames = [
          getLocalMachineName(),
          ...all.map(m => m.name),
          ...LOCAL_MACHINE_ALIASES,
        ].join(', ');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Machine "${machineName}" not found. Available: ${availableNames}. `
                + `(Pass the local machine name or "local"/"self"/"localhost" to notify THIS Mac.)`,
            },
          ],
          isError: true,
        };
      }

      // Build the remote command with every free-form field shell-quoted (the
      // single most important correctness detail — see shellQuoteForSsh).
      const remoteCmd = buildRemoteNotifyCommand({ title, message, subtitle, sound, group });
      logEvent({
        event: 'tool.bridge_notify',
        msg: `Sending notification to ${machineName} over SSH`,
        context: { machine: machineName, transport: 'ssh' },
      });

      try {
        // 15s is plenty for a remote banner pop; reuses the Tailscale-first
        // endpoint selection + key auth + retry/backoff inside sshExec.
        const res = await sshExec(machine, remoteCmd, 15000);
        if (res.exitCode !== 0) {
          logEvent({
            event: 'tool.bridge_notify.failed',
            level: 'error',
            msg: `Remote notification non-zero exit on ${machineName}`,
            context: { machine: machineName, transport: 'ssh', exit_code: res.exitCode },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Notification to ${machineName} failed (exit ${res.exitCode}).`
                  + (res.stderr.trim() ? `\nstderr:\n${res.stderr.trim()}` : ''),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Notification delivered to ${machineName} (transport=ssh).`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError(`Remote notification failed on ${machineName}: ${errMsg}`);
        logEvent({
          event: 'tool.bridge_notify.failed',
          level: 'error',
          msg: `Remote notification failed on ${machineName}`,
          context: { machine: machineName, transport: 'ssh', error: errMsg },
        });
        return {
          content: [
            { type: 'text' as const, text: `Failed to notify ${machineName}: ${errMsg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -- bridge_learnings_add ----------------------------------------------------
  //
  // 4.9.0 — SHARED CONTEXT: fleet-wide learnings store.
  //
  // Records a GLOBALLY-applicable learning (fix recipe, gotcha, "how X really
  // works" finding) into ~/.agent-bridge/shared-context/learnings.ndjson and
  // best-effort replicates it to every paired machine.
  //
  // REPLICATION ROUTING (see learnings.ts header for the full rationale):
  //   • local append — in-process via appendLearningLocal (dedupe by id).
  //   • each paired peer — sshExec(m, "agent-bridge learnings ingest --json …")
  //     so the REMOTE machine's own CLI validates + dedupes + appends into ITS
  //     store. Same side-effect path as bridge_notify: a replica write is NOT
  //     an agent message, so it must not ride the inbox/watcher path (that
  //     would require a live remote channel-owner just to store a line).
  //   • offline peers are reported, not fatal — `agent-bridge learnings sync`
  //     reconciles on next contact, and ingest's dedupe-by-id makes any replay
  //     idempotent.
  server.registerTool(
    'bridge_learnings_add',
    {
      title: 'Add Shared-Context Learning (fleet-wide)',
      description:
        'Record a GLOBALLY-applicable learning in the fleet-wide shared-context store and replicate it to every paired machine. '
        + 'Use for learnings that ANY agent on ANY machine could benefit from: OS/tool gotchas, infra fix recipes, cross-machine workflows, API/auth quirks. '
        + 'Do NOT use for project-local learnings — those belong in the repo\'s LEARNINGS.md — or machine/harness-private notes (harness memory).\n\n'
        + 'ADDITIVE ONLY: this store never replaces or reroutes your harness-native memory. Record everything where you would have recorded it anyway '
        + '(harness memory, repo LEARNINGS.md, workspace rules), THEN also add a copy of the fleet-wide-applicable subset here. '
        + 'Never skip a native memory write because you wrote here. If unsure, write both.\n\n'
        + 'Write the body in symptom/cause/fix/guard prose when the learning is bug-shaped; free-form recipe text is fine otherwise. '
        + 'Replication is best-effort: unreachable peers are listed in the result and will catch up via `agent-bridge learnings sync` (dedupe by id makes replays harmless).',
      inputSchema: {
        title: z.string().describe('Short one-line title (what you would scan for in a list).'),
        body: z
          .string()
          .describe('Full learning text. Symptom/cause/fix/guard style encouraged for bug-shaped learnings.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Lowercase keyword tags for later filtering, e.g. ["macos","vpn","surfshark"].'),
        harness: z
          .string()
          .optional()
          .describe('Which agent is recording this, e.g. "claude-code/default", "openclaw/clawdiboi2", "codex". Defaults to the active claude-code persona target.'),
        no_push: z
          .boolean()
          .optional()
          .describe('Skip replication to paired machines (local append only). Default false — push everywhere.'),
      },
    },
    async ({ title, body, tags, harness, no_push }) => {
      // Default the harness label to the active claude-code persona target so
      // entries recorded via the MCP tool are attributable without the agent
      // having to know its own persona string.
      const harnessLabel =
        harness && harness.trim() !== ''
          ? harness.trim()
          : getActiveClaudeCodeTargetOrDefault();
      const entry = createLearningEntry({ title, body, tags, harness: harnessLabel });

      let appended: boolean;
      try {
        appended = appendLearningLocal(entry);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError(`learnings: local append failed: ${errMsg}`);
        logEvent({
          event: 'tool.bridge_learnings_add.failed',
          level: 'error',
          msg: 'Local learnings append failed',
          context: { learning_id: entry.id, error: errMsg },
        });
        return {
          content: [{ type: 'text' as const, text: `Failed to write learning locally: ${errMsg}` }],
          isError: true,
        };
      }
      logEvent({
        event: 'tool.bridge_learnings_add',
        msg: `Learning recorded locally (${appended ? 'new' : 'duplicate id, no-op'})`,
        context: { learning_id: entry.id, title: entry.title, tags: entry.tags },
      });

      // -- REPLICATION LEG: best-effort push to every paired machine ---------
      // Sequential (not Promise.all) on purpose: peers share the local SSH
      // client and the store is low-write-rate; simple + readable beats a few
      // hundred ms here. Failures collect into `failedPeers`, never throw.
      //
      // 4.9.1 — uses sshExecWithEndpointFallback (NOT plain sshExec): each
      // peer has two addresses (LAN host + Tailscale internet_host) and either
      // can be individually dead (stale LAN IP, flaky tailnet). Replication is
      // an idempotent side-effect write (ingest dedupes by id), so trying the
      // alternate address on a connection failure is strictly safe and fixed
      // the real Mini↔MBP replication failures of 2026-07-14. See the helper's
      // header in ssh.ts for the full rationale.
      const okPeers: string[] = [];
      const failedPeers: string[] = [];
      if (!no_push) {
        const remoteCmd = buildRemoteIngestCommand(entry);
        for (const m of loadConfig()) {
          try {
            const res = await sshExecWithEndpointFallback(m, remoteCmd, 15000);
            if (res.exitCode === 0) {
              okPeers.push(
                res.endpointUsed === 'fallback' ? `${m.name} (via LAN fallback)` : m.name,
              );
            } else {
              failedPeers.push(`${m.name} (exit ${res.exitCode})`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failedPeers.push(`${m.name} (${errMsg})`);
          }
        }
        if (failedPeers.length > 0) {
          logEvent({
            event: 'tool.bridge_learnings_add.push_incomplete',
            level: 'warn',
            msg: 'Learning replicated to some peers only',
            context: { learning_id: entry.id, ok: okPeers, failed: failedPeers },
          });
        }
      }

      const lines = [
        appended
          ? `Learning recorded (id: ${entry.id}) in ${learningsFilePath()}.`
          : `Learning id ${entry.id} already existed locally (no-op).`,
      ];
      if (no_push) {
        lines.push('Replication skipped (no_push=true).');
      } else if (okPeers.length === 0 && failedPeers.length === 0) {
        lines.push('No paired machines to replicate to.');
      } else {
        if (okPeers.length > 0) lines.push(`Replicated to: ${okPeers.join(', ')}.`);
        if (failedPeers.length > 0) {
          lines.push(
            `Could not reach: ${failedPeers.join(', ')}. They will catch up via \`agent-bridge learnings sync\` (idempotent by id).`,
          );
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // -- bridge_learnings_search -------------------------------------------------
  //
  // 4.9.0 — read side of the shared-context store. Pure local read: every
  // machine holds a full replica, so searching never needs the network. This
  // is the tool agents should reach for when starting to debug something —
  // another agent on another machine may have already solved it.
  server.registerTool(
    'bridge_learnings_search',
    {
      title: 'Search Shared-Context Learnings (fleet-wide)',
      description:
        'Search the fleet-wide shared-context learnings store (contributed by agents on ALL paired machines). '
        + 'Case-insensitive substring match across title, body and tags; omit the query to list everything (newest first). '
        + 'Check here when debugging or starting unfamiliar work — another agent on another machine may have already recorded the fix. '
        + 'Reads the local replica only (no network); run `agent-bridge learnings sync` first if you suspect this machine is stale.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Keyword/substring to match (case-insensitive) across title, body and tags. Omit to list all.'),
        tag: z.string().optional().describe('Exact tag filter (lowercase), e.g. "vpn".'),
        limit: z.number().optional().describe('Max entries to return (newest first). Default 20.'),
      },
    },
    async ({ query, tag, limit }) => {
      let results;
      try {
        results = searchLearnings({ query, tag, limit: limit ?? 20 });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to read learnings store: ${errMsg}` }],
          isError: true,
        };
      }
      logEvent({
        event: 'tool.bridge_learnings_search',
        msg: `Learnings search returned ${results.length} entr${results.length === 1 ? 'y' : 'ies'}`,
        context: { query: query ?? '', tag: tag ?? '', count: results.length },
      });
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `No shared-context learnings matched${query ? ` "${query}"` : ''}${tag ? ` (tag: ${tag})` : ''}. `
                + 'If you solve this yourself and the fix could apply fleet-wide, record it with bridge_learnings_add '
                + '(in ADDITION to its normal home — harness memory / repo LEARNINGS.md — never instead of it).',
            },
          ],
        };
      }
      const header = `${results.length} shared-context learning(s)${query ? ` matching "${query}"` : ''}${tag ? ` (tag: ${tag})` : ''}, newest first:\n`;
      return {
        content: [
          {
            type: 'text' as const,
            text: header + '\n' + results.map(formatLearning).join('\n\n'),
          },
        ],
      };
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
