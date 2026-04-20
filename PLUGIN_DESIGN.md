# agent-bridge Claude Code plugin — design notes

## Goal

Single `claude plugin install` gives a user BOTH:
1. Outgoing MCP tools (`bridge_send_message`, `bridge_receive_messages`, `bridge_run_command`, `bridge_status`, `bridge_list_machines`, `bridge_clear_inbox`, `bridge_inbox_stats`).
2. Incoming channel push (remote messages arrive as `<channel source="agent-bridge" ...>` events without polling).

Previously these two halves were unbundled — channel side needed `--dangerously-load-development-channels`, MCP side needed hand-edited `.mcp.json`.

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

So no logic refactor was needed. The job was packaging.

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
- The Claude Code plugin (this work) reads from `~/.agent-bridge/inbox/claude-code/` and writes its outbox / keys the same way. As of mcp-server 3.4.0 the inbox is split into per-harness/per-target subdirs (`inbox/claude-code/`, `inbox/openclaw/<target>/`, …) so multiple listeners on the same machine don't race for messages addressed to different harnesses. See the top-level [README](README.md#message-routing--targets).
