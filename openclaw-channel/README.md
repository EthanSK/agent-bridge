# @agent-bridge/openclaw-channel

A first-class OpenClaw channel plugin for [agent-bridge](https://github.com/EthanSK/agent-bridge).

Registers `agent-bridge` as a native messaging channel — same tier as the
built-in Telegram / Slack / iMessage channels — so cross-machine messages
flow through OpenClaw's normal inbound/outbound pipelines instead of the
v1.3.0 hack that shelled out to `openclaw agent --to ...` per message.

## What's new in v2.1.0

- **Per-target inbox subdirs.** Watches `~/.agent-bridge/inbox/openclaw/<target>/*.json` instead of the single flat `inbox/`. Each subdir name maps to one configured target in `openclaw.json`.
- **Running-session injection.** Builds an OpenClaw session key of the form `agent:<agentId>:<channel>:<account>:direct:<peer_id>` and injects with `enqueueSystemEvent(body, { sessionKey, trusted: false })` so a bridge message arriving for a specific Telegram bot lands in the SAME chat session the user was already talking in. Replies go back to Telegram via the session's own `lastChannel`, not over the bridge.
- **`trusted: false` on injection.** SSH pairing is not a first-party trust boundary — inbound bridge content is third-party input.
- **Optional heartbeat wake.** When the plugin-sdk exports `requestHeartbeatNow`, the watcher wakes an idle session after injection.

## How it works

| | This module (v2.1.0) |
| --- | --- |
| Registration | `ChannelPlugin` via `api.registerChannel()` |
| Inbound delivery | `enqueueSystemEvent(body, { sessionKey, trusted: false })` from the plugin-sdk |
| Session key | `agent:<agentId>:<openclaw_channel>:<account>:direct:<peer_id>` |
| Routing | Per-target subdir `~/.agent-bridge/inbox/openclaw/<target>/` — each target maps to one Telegram bot / account session |
| Reply path | The target session's `lastChannel` (Telegram) drives reply routing — messages don't bounce back over agent-bridge automatically |
| Cross-harness reply | Outbound `ChannelOutboundAdapter.sendText` is still available for the rare case where the peer is an agent-bridge-aware harness |

## Install

```json
// In ~/.openclaw/openclaw.json:
{
  "channels": {
    "agent-bridge": {
      "enabled": true,
      "config": {
        "agentId": "main",
        "targets": {
          "default":      { "openclaw_channel": "telegram", "account": "default",      "peer_id": "6164541473" },
          "clawdiboi2":   { "openclaw_channel": "telegram", "account": "clawdiboi2",   "peer_id": "6164541473" },
          "clordlethird": { "openclaw_channel": "telegram", "account": "clordlethird", "peer_id": "6164541473" }
        }
      }
    }
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

Senders on the other machine address a specific target with the new `target` field on `bridge_send_message`, e.g. `target: "openclaw/clawdiboi2"`. See the top-level [README](../README.md#message-routing--targets) for the full routing story.

## Runtime

- Watches each configured target subdir under `~/.agent-bridge/inbox/openclaw/<target>/*.json` every 2000ms.
- On each new `BridgeMessage`:
  1. Parse + dedup against `~/.agent-bridge/.openclaw-v2-delivered`.
  2. Format as `<channel source="agent-bridge" from=... to=... target=... ts=...>content</channel>` (parity with the Claude Code channel plugin).
  3. Resolve the target's OpenClaw session key.
  4. Call `enqueueSystemEvent(body, { sessionKey, contextKey, trusted: false })`.
  5. Call `requestHeartbeatNow({ sessionKey, reason: 'agent-bridge:inbound' })` if the plugin-sdk exports it (silent noop otherwise).
- Legacy messages at `~/.agent-bridge/inbox/*.json` (no subdir, no `target` field) are quarantined to `~/.agent-bridge/inbox/.failed/_unrouted/` with a deprecation log line.
- The outbound `ChannelOutboundAdapter.sendText` adapter is preserved for cross-harness bridge replies — if the paired peer is another agent-bridge-aware agent (not a Telegram session), the reply can still SCP back via the bridge instead of landing in Telegram.

## No dependencies

Node builtins only (`fs`, `path`, `os`, `child_process`, `crypto`). Uses the
host's bundled SSH and SCP for outbound delivery.
