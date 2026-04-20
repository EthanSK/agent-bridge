# @agent-bridge/openclaw-channel

A first-class OpenClaw channel plugin for [agent-bridge](https://github.com/EthanSK/agent-bridge).

Registers `agent-bridge` as a native messaging channel — same tier as the
built-in Telegram / Slack / iMessage channels — so cross-machine messages
flow through OpenClaw's normal inbound/outbound pipelines instead of the
v1.3.0 hack that shelled out to `openclaw agent --to ...` per message.

## How it works

| | This module (v2) |
| --- | --- |
| Registration | `ChannelPlugin` via `api.registerChannel()` |
| Inbound delivery | `enqueueSystemEvent(...)` from the plugin-sdk |
| Outbound replies | Native `ChannelOutboundAdapter.sendText` that SCPs a reply BridgeMessage back to the sender |
| Appears in `openclaw channels list` | Yes |
| Fan-out to Telegram + bridge sender | Core routing handles it |

This module supersedes the pre-2.0 extension-plugin approach (which shelled
out to `openclaw agent --to ... --message ...` per message). The v1 plugin
has been removed from the repo; if you're migrating, delete any
`plugins.entries["agent-bridge"]` block from your `openclaw.json` and
point `plugins.load.paths` at this directory instead.

## Install

```bash
# In ~/.openclaw/openclaw.json:
{
  "channels": {
    "agent-bridge": { "enabled": true }
  },
  "plugins": {
    "load": {
      "paths": [
        "/path/to/agent-bridge/openclaw-channel"
      ]
    }
  }
}
```

The gateway auto-reloads on config change — no restart required.

## Runtime

- Watches `~/.agent-bridge/inbox/*.json` every 2000ms.
- Parses each `BridgeMessage`, formats it as a `<channel source="agent-bridge" ...>` block (parity with the Claude Code channel plugin), and injects it into the running agent session via `enqueueSystemEvent`.
- When the agent replies, the outbound adapter SCPs a reply `BridgeMessage` to `<remote>:~/.agent-bridge/inbox/<id>.json` using the pairing's SSH key at `~/.agent-bridge/keys/agent-bridge_<remote-name>`.

## No dependencies

Node builtins only (`fs`, `path`, `os`, `child_process`, `crypto`). Uses the
host's bundled SSH and SCP for outbound delivery.
