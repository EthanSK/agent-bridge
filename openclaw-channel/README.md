# @agent-bridge/openclaw-channel

A first-class OpenClaw channel plugin for [agent-bridge](https://github.com/EthanSK/agent-bridge).

Registers `agent-bridge` as a native messaging channel — same tier as the
built-in Telegram / Slack / iMessage channels — so cross-machine messages
flow through OpenClaw's normal inbound/outbound pipelines instead of the
v1.3.0 hack that shelled out to `openclaw agent --to ...` per message.

## What's new in v2.3.0

- **`replyVia` per-target routing.** Inbound bridge messages can now route their reply either back through the Telegram chat (default — visible on Ethan's phone) or back over agent-bridge as a BridgeMessage to the sender machine (silent peer-to-peer back-channel). Set it plugin-level (`channels["agent-bridge"].config.replyVia`), per-target (`targets.<name>.replyVia`), or per-message (add `replyVia` to the BridgeMessage JSON). Valid modes: `"telegram"` | `"agent-bridge"`. Unknown values fall back to `"telegram"` with a warn log.
  - When `replyVia: "agent-bridge"`, peer identity switches from `<telegram-peer-id>` to an encoded bridge peer id containing both `<sender-machine-name>` and `<sender-fromTarget>`. The session key becomes `agent:main:agent-bridge:<account>:direct:<encoded-peer>`, so multiple Telegram accounts or return targets on the same machine cannot collapse onto one shared back-channel session. Replies come back via the native `agent-bridge` channel's outbound SCP adapter (channel-plugin.js :: sendText) instead of the Telegram outbound. No Telegram traffic is generated.
  - Use-case: a Claude Code or OpenClaw session asking another bridge-aware session for context without Ethan's phone pinging.

## What's new in v2.2.0

- **Correct dispatch via `dispatchInboundReplyWithBase`.** v2.1.x tried to inject bridge messages with `enqueueSystemEvent`, but that function only prepends a `System:` line to the NEXT naturally-scheduled turn — it does NOT trigger a turn. Every bridge message was silently swallowed unless Ethan happened to DM the real Telegram bot afterwards. v2.2.0 calls `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` — the SAME dispatch primitive the native IRC and Nextcloud Talk channels use — which drives `dispatchReplyFromConfig` exactly like a real Telegram inbound message. Full analysis in [`docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md`](docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md).
- **Session key is SDK-resolved, not hand-built.** Uses `runtime.channel.routing.resolveAgentRoute({cfg, channel, accountId, peer})` so the plugin respects Ethan's `cfg.session.dmScope` (currently `per-account-channel-peer`) without hard-coding the key format.
- **Replies routed via explicit origin metadata, not `lastChannel`.** The synthetic ctxPayload pins reply routing explicitly: Telegram targets use `Provider/OriginatingChannel/OriginatingTo = telegram`, while `replyVia: "agent-bridge"` injects on the native `agent-bridge` channel with an encoded bridge peer id. Dispatch routes every in-turn reply through the chosen outbound, regardless of what the session's persisted `lastChannel` is.

## What's new in v2.1.0

- **Per-target inbox subdirs.** Watches `~/.agent-bridge/inbox/openclaw/<target>/*.json` instead of the single flat `inbox/`. Each subdir name maps to one configured target in `openclaw.json`.
- **Auto-discovery of targets from `channels.telegram.accounts`.** In the common case you don't have to write a `targets` block at all — the plugin inspects the OpenClaw global config's `channels.telegram.accounts` map and creates one bridge target per account, routing to `telegram:<account>`. An explicit `targets` block is still accepted as an advanced override. Peer-id resolution walks `targets.<name>.peer_id` → `config.peer_id` → `meta.user_id` → first numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`.
- **Round-trip bridge replies (`fromTarget`).** Inbound BridgeMessages carry an optional `fromTarget` telling the receiver where to put replies. When the agent answers back over the bridge (cross-harness flows), the OpenClaw session peer id encodes both the sender machine and `fromTarget`, and `buildReply(...)` populates the outgoing `target` from that value. That keeps `MacBookPro/claude-code` separate from `MacBookPro/openclaw/default`; there is no implicit fallback to `claude-code` or any other shared back-channel target.
- **Outbound reply delivery honors `internet_host`.** The native OpenClaw channel's outbound SCP adapter now mirrors the CLI / MCP transport rule: if a paired machine has `internet_host` configured, replies go there instead of getting stuck on a stale LAN `host`.

## How it works

| | This module (v2.2.0) |
| --- | --- |
| Registration | `ChannelPlugin` via `api.registerChannel()` |
| Inbound dispatch | `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` (same primitive used by native IRC / Nextcloud Talk channels) |
| Session key | Resolved via `runtime.channel.routing.resolveAgentRoute({cfg, channel: "telegram", accountId, peer: {kind: "direct", id: peer_id}})` — respects `cfg.session.dmScope` |
| Routing | Per-target subdir `~/.agent-bridge/inbox/openclaw/<target>/` — each target maps to one Telegram bot / account session |
| Reply path | `replyVia="telegram"` keeps `OriginatingChannel="telegram"` + `OriginatingTo="telegram:<peerId>"`; `replyVia="agent-bridge"` injects on the native `agent-bridge` channel with an encoded bridge peer id, so in-turn replies SCP back over agent-bridge instead of Telegram |
| Cross-harness reply | Outbound `ChannelOutboundAdapter.sendText` on the native `agent-bridge` channel is still available for the rare case where the peer is an agent-bridge-aware harness |

## Install

### Minimal (auto-discovery — recommended)

```json
// In ~/.openclaw/openclaw.json:
{
  "channels": {
    "agent-bridge": {
      "enabled": true,
      "config": {
        "agentId": "main",
        "peer_id": "6164541473"
      }
    },
    "telegram": {
      "accounts": {
        "default":      { "token": "...", "allowFrom": ["6164541473"] },
        "clawdiboi2":   { "token": "...", "allowFrom": ["6164541473"] },
        "clordlethird": { "token": "...", "allowFrom": ["6164541473"] }
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

The plugin auto-discovers one bridge target per `channels.telegram.accounts` entry — you don't need to repeat them under `targets`. Peer ID resolution walks `targets.<name>.peer_id` → `channels["agent-bridge"].config.peer_id` → `meta.user_id` → first numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`.

### Explicit overrides (advanced)

Add a `targets` block only when you need to override auto-discovery (different peer per bot, custom session mapping, extra non-Telegram targets, etc.):

```json
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
  3. Resolve the canonical session route via `runtime.channel.routing.resolveAgentRoute(...)`.
  4. Build a synthetic inbound `ctxPayload` via `runtime.channel.reply.finalizeInboundContext({...})`, pinned either to Telegram (`Provider/OriginatingChannel/OriginatingTo = telegram`) or to the native `agent-bridge` channel with an encoded bridge peer id, depending on `replyVia`.
  5. `await dispatchInboundReplyWithBase({cfg, channel, accountId, route, storePath, ctxPayload, core: runtime, deliver, onRecordError, onDispatchError})`. This runs a synchronous agent turn in the target session.
  6. The `deliver` callback forwards each reply payload through the matching outbound adapter, so Telegram-bound targets land in the chat and `replyVia="agent-bridge"` targets SCP back to the sender machine.
- After successful dispatch, the consumed inbox file is moved to `~/.agent-bridge/archive/openclaw/<target>/`. Seeing a message there means it was delivered to OpenClaw; pending messages remain in `~/.agent-bridge/inbox/openclaw/<target>/`.
- Legacy messages at `~/.agent-bridge/inbox/*.json` (no subdir, no `target` field) are quarantined to `~/.agent-bridge/inbox/.failed/_unrouted/` with a deprecation log line.
- The outbound `ChannelOutboundAdapter.sendText` adapter is preserved for cross-harness bridge replies — if the paired peer is another agent-bridge-aware agent (not a Telegram session), the reply can still SCP back via the bridge instead of landing in Telegram.

## No dependencies

Node builtins only (`fs`, `path`, `os`, `child_process`, `crypto`). Uses the
host's bundled SSH and SCP for outbound delivery.
