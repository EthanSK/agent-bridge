#!/usr/bin/env bun
/**
 * agent-bridge — claude-code-channel (3.6.0 design-stage stub)
 * ============================================================
 *
 * THIS FILE INTENTIONALLY CONTAINS NO RUNTIME LOGIC.
 *
 * It is the design-stage skeleton tracked by
 * `docs/3.6.0-channel-plugin-migration.md`. The real implementation will:
 *
 *   1. Adopt Telegram's session-scoped plugin shape (`bun run` start
 *      script, channel-host process whose lifetime equals the Claude Code
 *      session — not the per-tool-turn MCP child lifetime).
 *   2. Host the inbox watcher + lease + `notifications/claude/channel`
 *      push for `~/.agent-bridge/inbox/claude-code/`, factored out of the
 *      current `mcp-server` package.
 *   3. Carry the five Telegram patches verbatim:
 *        Patch B — stderr tee to `~/.agent-bridge/logs/claude-code-channel.log`
 *        Patch C — `shutdownWithReason(reason, detail)` funnel
 *        Patch D — 60s heartbeat (refed for the channel-owner process)
 *        Patch E — shutdown handle/request dump
 *        Patch A — 3-poll confirmation orphan watchdog (ppid + stdin)
 *      …plus Telegram's Patch F (heartbeat-recency guard against parallel
 *      subagent spawns murdering the parent poller).
 *
 * The `mcp-server` package will be demoted to a tools-only host
 * (`bridge_*` MCP tools, no watcher, no lease, no channel push).
 *
 * Until 3.6.0 ships, this file is a no-op guarded by an explicit env
 * activation flag. Booting it accidentally cannot disturb a healthy
 * 3.5.x channel-owner: it exits 0 immediately.
 *
 * Inert-stub guard: if you reach the real `bun run start` invocation,
 * the runtime exits cleanly. Any path that would touch the inbox, the
 * lease, or `notifications/claude/channel` is INTENTIONALLY ABSENT.
 */

// Imports below are kept ONLY to lock in the SDK / transport surface we
// will need for the real implementation. They are intentionally not
// referenced — `tsc` may flag them as unused; that is by design until the
// 3.6.0 implementation lands and consumes them.

// MCP SDK — tools registration + stdio transport for the channel host's
// own MCP face (push side). Mirrors what mcp-server/src/index.ts uses.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Server as _McpServer } from '@modelcontextprotocol/sdk/server/index.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { StdioServerTransport as _StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Node builtins the lifecycle patches will need.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  createWriteStream as _createWriteStream,
  existsSync as _existsSync,
  mkdirSync as _mkdirSync,
  readFileSync as _readFileSync,
  statSync as _statSync,
  writeFileSync as _writeFileSync,
} from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { homedir as _homedir } from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { join as _join } from 'node:path';

// ---------------------------------------------------------------------------
// Inert-stub guard.
//
// In design-stage we MUST NOT participate in:
//   - the watcher lease at ~/.agent-bridge/locks/claude-code.watcher-lock.json
//   - the inbox at ~/.agent-bridge/inbox/claude-code/
//   - the notifications/claude/channel push pipe
//
// A stray `bun run` (developer experimentation, plugin host warm-up,
// curious test) MUST be a no-op so a healthy 3.5.x mcp-server channel-
// owner is never disturbed. The activation env flag exists ONLY so that
// the Phase 1 spike test described in docs/3.6.0-channel-plugin-migration.md
// §5.1 can verify the plugin host's session-scoped spawn shape against
// this skeleton. That spike is a manual, opt-in activity.
// ---------------------------------------------------------------------------

const STUB_ACTIVATION_FLAG = 'AGENT_BRIDGE_PLUGIN_STUB';

if (process.env[STUB_ACTIVATION_FLAG] !== 'activate') {
  // Silent no-op exit. Stderr would be teed by Patch B in the real impl;
  // here we deliberately print nothing so the plugin host treats us as
  // "started cleanly" without spamming a stderr log that does not yet
  // exist.
  process.exit(0);
}

// If you got here, you set AGENT_BRIDGE_PLUGIN_STUB=activate. This branch
// is reserved for the Phase 1 spike: confirm the plugin host keeps a
// `bun run` child alive across multiple Claude Code tool turns, mirroring
// Telegram's pid-7511-for-3-days behaviour. The spike does NOT touch the
// inbox, lease, or push — it only proves lifetime parity.
process.stderr.write(
  `[claude-code-channel stub] activated for Phase 1 spike — pid=${process.pid} ppid=${process.ppid}\n` +
  '  No inbox / lease / push handlers are wired. See docs/3.6.0-channel-plugin-migration.md §5.1.\n',
);

// Keep the process alive for the spike. NO-OP heartbeat to stderr so the
// observer can confirm the plugin host did not respawn us between tool
// turns. We deliberately do NOT touch the lease file or any inbox path.
const SPIKE_HEARTBEAT_MS = 60_000;
setInterval(() => {
  process.stderr.write(
    `[claude-code-channel stub] heartbeat uptime=${Math.floor(process.uptime())}s ppid=${process.ppid}\n`,
  );
}, SPIKE_HEARTBEAT_MS).unref();

// Honour stdin EOF so the spike doesn't outlive its parent — mirrors what
// Patch C will do in the real implementation, but without the lease/diag
// machinery.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
