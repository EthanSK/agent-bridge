# `claude-code-channel` — 3.6.0 design-stage stub

This package is a **design-stage skeleton**. It does not yet implement the
agent-bridge Claude Code channel plugin. The real implementation lands at
agent-bridge 3.6.0.

* Design doc: [`../docs/3.6.0-channel-plugin-migration.md`](../docs/3.6.0-channel-plugin-migration.md)
* Sister channel plugin (reference): [`../openclaw-channel/`](../openclaw-channel/)
* What it'll replace at 3.6.0: the `channel-owner` role inside [`../mcp-server/`](../mcp-server/)

## Why a stub now

Cutting 3.6.0 needs a Phase 1 spike — verifying that Claude Code's plugin
host spawns a `bun run` plugin **once per session** rather than per tool
turn (mirroring the Telegram plugin's multi-day lifetime). The skeleton
exists so that spike has something to point at *without* introducing any
runtime behaviour that could disturb a healthy 3.5.x channel-owner.

## Activation guard

`src/index.ts` exits 0 immediately unless `AGENT_BRIDGE_PLUGIN_STUB=activate`
is set. This is intentional: a stray `bun run` from any developer or
plugin-host warm-up cycle is a no-op. The activation flag is opt-in for
manual spike testing only.

The package is **not** registered in `../.claude-plugin/marketplace.json`.
Claude Code will not auto-load it.

## Layout

```
claude-code-channel/
├── package.json              # version 0.0.0-stub, private:true
├── .claude-plugin/
│   └── plugin.json           # 0.0.0-stub manifest, name carries -stub suffix
├── src/
│   └── index.ts              # inert; imports the SDK/transport surface only
└── README.md                 # ← you are here
```

## What lands at 3.6.0

See [`../docs/3.6.0-channel-plugin-migration.md`](../docs/3.6.0-channel-plugin-migration.md)
for the full plan. Summary:

1. Move the inbox watcher + lease + channel-notification push into this
   package, out of `../mcp-server/src/{watcher,inbox}.ts`.
2. Adopt Telegram patches A–F for lifecycle hardening.
3. Demote `../mcp-server/` to a tools-only host (`bridge_*` MCP tools,
   no watcher, no lease).
4. Maintain the on-disk wire format unchanged so 3.5.x ↔ 3.6.x peers
   interoperate during rollout.
