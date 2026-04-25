# agent-bridge Claude Code plugin — design notes

## Goal

Single `claude plugin install` packages BOTH Claude Code halves:
1. Outgoing MCP tools (`bridge_send_message`, `bridge_receive_messages`, `bridge_run_command`, `bridge_status`, `bridge_list_machines`, `bridge_clear_inbox`, `bridge_inbox_stats`).
2. Incoming Claude Code channel push (remote messages arrive as `<channel source="agent-bridge" ...>` events without polling).

Because the marketplace is currently a local directory, launching the channel still needs the tagged `--dangerously-load-development-channels plugin:agent-bridge@agent-bridge` flag. The install removes hand-edited `.mcp.json` work; it does not turn Claude Code into a separate always-on daemon.

## Reference: official Telegram plugin

`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.5/server.ts` is the canonical pattern for a unified MCP+channel server:
- Constructs `new Server({ name, version }, { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } })`.
- Advertises tools via `setRequestHandler(ListToolsRequestSchema, ...)`.
- Pushes incoming channel events via `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`.
- One process. One stdio transport. Both halves at once.

Manifest layout:
- `.claude-plugin/plugin.json` — `name`, `description`, `version`, `keywords`.
- `.mcp.json` — `mcpServers.<name>.command` + `args` using `${CLAUDE_PLUGIN_ROOT}`.
- `package.json` `start` script (only used if command points at `bun`/`npm`).

## What's already in place (v2.2.0)

`mcp-server/src/index.ts` was already a unified MCP+channel server:
- `McpServer` advertises `tools: {}` AND `experimental: { 'claude/channel': {} }`.
- `startWatcher(...)` callback emits `server.server.notification({ method: 'notifications/claude/channel', params: { content, meta } })` on every new inbox file.
- Hardening: `isBrokenPipe` EPIPE detector, SIGPIPE/SIGTERM/SIGINT/SIGHUP shutdown, `bootPpid` orphan watchdog, 2-second force-exit deadline.

So no logic refactor was needed. The job was packaging for Claude Code's stdio host model. OpenClaw support is intentionally separate (`openclaw-channel/` + `api.registerChannel()` under the OpenClaw gateway), sharing the SSH/file transport but not the Claude Code lifecycle.

## What this release adds

1. `.claude-plugin/marketplace.json` (repo root) — declares the repo itself as a local Claude Code marketplace listing one plugin (`agent-bridge`) with `source: "./mcp-server"`.
2. `mcp-server/.claude-plugin/plugin.json` — plugin manifest.
3. `mcp-server/.mcp.json` — registers the MCP server using `${CLAUDE_PLUGIN_ROOT}/build/index.js` for path resolution. No hardcoded `/Users/...` paths.

## Install flow

```bash
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

The marketplace can also be added from a GitHub URL once published:
```bash
claude plugin marketplace add EthanSK/agent-bridge
```

## Coexistence

- Bash `agent-bridge` CLI (root of repo) is unchanged except for the 3.0.0 removal of `--claude` / `--codex` / `--agent` from `run`. Still installed via `./install.sh`. Used for pairing, plain remote-shell diagnostics, and SSH transport. Agent-to-agent communication is strictly via `bridge_send_message` (channel mode) — there is no fresh-spawn path.
- OpenClaw channel plugin (`openclaw-channel/`) is unchanged. Different ecosystem, different manifest format.
- The Claude Code plugin (this work) reads from `~/.agent-bridge/inbox/claude-code/` and writes its outbox / keys the same way. Its watcher lives inside the plugin MCP stdio child; current releases harden that child against benign stdin/stderr/SIGTERM closure and replay undelivered messages on startup, but the live push path still depends on a live Claude Code channel-owner. As of mcp-server 3.4.0 the inbox is split into per-harness/per-target subdirs (`inbox/claude-code/`, `inbox/openclaw/<target>/`, …) so multiple listeners on the same machine don't race for messages addressed to different harnesses. See the top-level [README](README.md#message-routing--targets).

## Durability note (v3.5.0)

Claude Code and OpenClaw have different host lifecycles. OpenClaw owns a long-lived gateway process, so its `openclaw-channel` watcher can stand by and retry its lease when another gateway instance owns delivery. Claude Code can start multiple plugin MCP children, close stdin between turns, or send SIGTERM while the channel parent stays alive.

The Claude Code side now copies the useful part of the OpenClaw/Telegram pattern without changing the Claude channel contract: there is still one MCP+channel process per plugin instance and delivery still uses `notifications/claude/channel`, but non-owner channel-capable processes remain as standbys and retry the `claude-code` watcher lease. If the active owner dies or stops heartbeating, a standby promotes itself, replays pending inbox files, and resumes push delivery without a manual plugin reload.

Channel notification writes are also bounded by `AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT_MS` (default 10s). A wedged JSON-RPC/stdout write now leaves the inbox file retryable instead of marking it delivered or pinning it in memory forever.
