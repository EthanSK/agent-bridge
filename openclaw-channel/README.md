# @agent-bridge/openclaw-channel

A first-class OpenClaw channel plugin for [agent-bridge](https://github.com/EthanSK/agent-bridge).

Registers `agent-bridge` as a native messaging channel — same tier as the
built-in Telegram / Slack / iMessage channels — so cross-machine messages
flow through OpenClaw's normal inbound/outbound pipelines instead of the
v1.3.0 hack that shelled out to `openclaw agent --to ...` per message.

## Reply routing in v3.0+

**Architectural pivot (2026-05-04, voice 2096):** the plugin no longer
auto-fans-out the agent's reply across multiple outbound channels. Instead
it surfaces the inbound bridge message into the running OC agent's session
and lets tool calls drive the actual reply legs. This unifies the OC
behavior with the Claude Code channel: both surface inbound messages and
trust the agent to pick the right tools.

### Mental model

When a bridge message lands at an OC target, the plugin:

1. Picks ONE primary session to inject into (Telegram if the user wants the
   reply to go to their phone, else the silent agent-bridge back-channel).
2. Builds a synthetic inbound `ctxPayload` whose body is:
   - the original message wrapped in `<channel source="agent-bridge" ...>`
   - followed by a compact `[BRIDGE-CONTEXT]` block listing `from_target`,
     `bridge_reply_target`, `primary_user_channel`, and
     `additional_user_channels`.
3. Runs ONE agent turn via `dispatchInboundReplyWithBase`. The agent's
   natural turn output flows through the primary session-bound outbound
   (e.g. straight into the Telegram chat the user reads).
4. Trusts the agent to ALSO call `bridge_send_message` to reply over the
   bridge to `from_target` (the implicit bridge leg, expected when
   `from_target` is set).

There is no `deliver` fan-out anymore. The agent is in control.

### `additionalReplyChannels` config

Configure which user-facing channel(s) the agent should be HINTED about in
the `[BRIDGE-CONTEXT]` block. Default policy:

- Target with `openclaw_channel: "telegram"` → `["telegram"]`.
- Headless target (`openclaw_channel: "agent-bridge"`) → `[]`.

Override at any of three levels (highest first):

```jsonc
// ~/.openclaw/openclaw.json
{
  "channels": {
    "agent-bridge": {
      "config": {
        "additionalReplyChannels": ["telegram"],   // plugin-level
        "targets": {
          "default": {
            "additionalReplyChannels": ["telegram"] // per-target
          }
        }
      }
    }
  }
}
```

Per-message override is also supported via the BridgeMessage JSON itself
(`additionalReplyChannels` field on the wire).

Special string sentinels accepted at any level:
- `"none"` / `"silent"` / `"off"` — quiet mode (no user-facing leg suggested).
- `"default"` — fall through to the next precedence level.

The plugin does NOT mechanically fan out the reply. It only tells the agent
in the prompt-context which user-facing channels are configured. The agent
decides what to actually do with that hint.

### Migrating from `replyVia` (≤ v2.4.x)

The old per-target / plugin-level / per-message `replyVia` config field is
no longer interpreted as of v3.0.0. The plugin emits a single deprecation
warning at register-time listing every offending key, and proceeds without
crashing.

Migration is config-only:

```jsonc
// before (≤ v2.4.x)
{
  "replyVia": "telegram"            // or "agent-bridge", or an array
}

// after (v3.0+)
{
  "additionalReplyChannels": ["telegram"]   // or [] for quiet mode
}
```

> ⚠️ **Bridge-only targets need an explicit `openclaw_channel`.** If a v2 target
> was previously valid with `replyVia: "agent-bridge"` and NO `peer_id` (peer
> derived from the sender at message time), you MUST also add
> `"openclaw_channel": "agent-bridge"` to that target on upgrade. v3.0 ignores
> `replyVia`, so the only signal that survives is `openclaw_channel`. Without
> it, the upgrade defaults to `"telegram"` and the missing `peer_id` causes
> the target to be skipped at startup. Targets that already had a `peer_id` are
> not affected.

Quick jq recipe — preserves bridge-only targets by stamping
`openclaw_channel: "agent-bridge"` on any target that lacks both `peer_id`
AND `openclaw_channel` (this is the v2 bridge-only shape) BEFORE deleting
`replyVia`:

```bash
jq '
  # 1. Promote bridge-only targets so they keep working after replyVia deletion.
  (.channels["agent-bridge"].config.targets // {}) |= with_entries(
    if (.value.peer_id // empty | not) and (.value.openclaw_channel // empty | not)
    then .value.openclaw_channel = "agent-bridge"
    else .
    end
  )
  # 2. Drop the deprecated replyVia keys.
  | del(.channels["agent-bridge"].config.replyVia)
  | (.channels["agent-bridge"].config.targets // {}) |= with_entries(.value |= del(.replyVia))
' ~/.openclaw/openclaw.json > /tmp/openclaw.json && mv /tmp/openclaw.json ~/.openclaw/openclaw.json
```

Then restart OpenClaw on the affected machine so the new code loads. Watch
the openclaw log for the deprecation warning + any `target "..." missing
peer_id` warnings — those flag bridge-only targets that need
`openclaw_channel: "agent-bridge"` added (the recipe above handles them
automatically; warnings would only fire if a target has a non-bridge-only
shape without a peer_id).

## What's new in v3.1.0

- **Compact relay receipts with expand ids.** `[Agent Bridge relay] 🛰️` notices no longer include the full/large bridge body. They show sender/target metadata, message id, and a short `expand id: NN` plus `expand: agent-bridge relay-expand NN`.
- **Local bounded expand store.** The full inbound BridgeMessage is stored under `~/.agent-bridge/relay-expand/` with a 100-entry rolling id space and 7-day TTL by default. Agents can retrieve recent full content with `agent-bridge relay-expand <id>` when Ethan asks to expand a relay.

## What's new in v3.0.0

- **Breaking: agent-driven reply routing.** The plugin no longer auto-fans-out replies via `replyVia`. It injects the inbound bridge message into one OpenClaw agent turn with a `[BRIDGE-CONTEXT]` block, then the agent chooses whether to reply over the bridge and/or user-facing channels.
- **`additionalReplyChannels` replaces `replyVia`.** Use it only as a hint for user-facing channels (`["telegram"]`, `[]`, or sentinels like `"none"` / `"default"`). The old `replyVia` key is deprecated and ignored after one startup warning.
- **Single-turn dispatch hardening.** Inbound bridge messages now drive exactly one `dispatchInboundReplyWithBase` call, bridge-only array configs are handled explicitly, Windows ESM import paths use `pathToFileURL`, and relay notices include the running agent-bridge version so stale fleet members are visible.

## What's new in v2.4.1

- **Telegram-visible Agent Bridge relay receipts.** Every inbound bridge message to an OpenClaw target now sends a short best-effort notice to the configured chat before the agent turn runs. Since v3.1.0 the notice starts with `[Agent Bridge relay] 🛰️`, then shows `from/fromTarget → target`, reply path, message id, and an `expand id` rather than a body preview. This preserves the old “I can see another harness messaged this OpenClaw” affordance without dumping long bridge content into Telegram/user channels.
- **Config:** receipts are enabled by default. Set `channels["agent-bridge"].config.relayNotice = false` (or per-target `targets.<name>.relayNotice = false`) to silence them. Optional `relayNoticeChannel` / `relayNoticePeerId` override where the receipt is sent; otherwise it uses the target's normal channel + `peer_id`.

## What's new in v2.3.0

- **`replyVia` per-target routing.** Inbound bridge messages can now route their reply either back through the Telegram chat (default — visible on Ethan's phone) or back over agent-bridge as a BridgeMessage to the sender machine (silent peer-to-peer back-channel). Set it plugin-level (`channels["agent-bridge"].config.replyVia`), per-target (`targets.<name>.replyVia`), or per-message (add `replyVia` to the BridgeMessage JSON). Valid modes: `"telegram"` | `"agent-bridge"`. Unknown values fall back to `"telegram"` with a warn log.
  - When `replyVia: "agent-bridge"`, peer identity switches from `<telegram-peer-id>` to an encoded bridge peer id containing both `<sender-machine-name>` and `<sender-fromTarget>`. The session key becomes `agent:main:agent-bridge:<account>:direct:<encoded-peer>`, so multiple Telegram accounts or return targets on the same machine cannot collapse onto one shared back-channel session. Replies come back via the native `agent-bridge` channel's outbound SFTP adapter (channel-plugin.js :: sendText) instead of the Telegram outbound. No Telegram traffic is generated.
  - Use-case: a Claude Code or OpenClaw session asking another bridge-aware session for context without Ethan's phone pinging.

## What's new in v2.2.0

- **Correct dispatch via `dispatchInboundReplyWithBase`.** v2.1.x tried to inject bridge messages with `enqueueSystemEvent`, but that function only prepends a `System:` line to the NEXT naturally-scheduled turn — it does NOT trigger a turn. Every bridge message was silently swallowed unless Ethan happened to DM the real Telegram bot afterwards. v2.2.0 calls `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` — the SAME dispatch primitive the native IRC and Nextcloud Talk channels use — which drives `dispatchReplyFromConfig` exactly like a real Telegram inbound message. Full analysis in [`docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md`](docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md).
- **Session key is SDK-resolved, not hand-built.** Uses `runtime.channel.routing.resolveAgentRoute({cfg, channel, accountId, peer})` so the plugin respects Ethan's `cfg.session.dmScope` (currently `per-account-channel-peer`) without hard-coding the key format.
- **Replies routed via explicit origin metadata, not `lastChannel`.** The synthetic ctxPayload pins reply routing explicitly: Telegram targets use `Provider/OriginatingChannel/OriginatingTo = telegram`, while `replyVia: "agent-bridge"` injects on the native `agent-bridge` channel with an encoded bridge peer id. Dispatch routes every in-turn reply through the chosen outbound, regardless of what the session's persisted `lastChannel` is.

## What's new in v2.1.0

- **Per-target inbox subdirs.** Watches `~/.agent-bridge/inbox/openclaw/<target>/*.json` instead of the single flat `inbox/`. Each subdir name maps to one configured target in `openclaw.json`.
- **Auto-discovery of targets from `channels.telegram.accounts`.** In the common case you don't have to write a `targets` block at all — the plugin inspects the OpenClaw global config's `channels.telegram.accounts` map and creates one bridge target per account, routing to `telegram:<account>`. An explicit `targets` block is still accepted as an advanced override. Peer-id resolution walks `targets.<name>.peer_id` → `config.peer_id` → `meta.user_id` → first numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`.
- **Round-trip bridge replies (`fromTarget`).** Inbound BridgeMessages carry an optional `fromTarget` telling the receiver where to put replies. When the agent answers back over the bridge (cross-harness flows), the OpenClaw session peer id encodes both the sender machine and `fromTarget`, and `buildReply(...)` populates the outgoing `target` from that value. That keeps `MacBookPro/claude-code` separate from `MacBookPro/openclaw/default`; there is no implicit fallback to `claude-code` or any other shared back-channel target.
- **Outbound reply delivery honors `internet_host`.** The native OpenClaw channel's outbound SFTP adapter now mirrors the CLI / MCP transport rule: if a paired machine has `internet_host` configured, replies go there instead of getting stuck on a stale LAN `host`.

## How it works

| | This module (v3.0+) |
| --- | --- |
| Registration | `ChannelPlugin` via `api.registerChannel()` |
| Inbound dispatch | One `dispatchInboundReplyWithBase` call per inbound bridge message, using the same primitive as native OpenClaw channels. The injected body contains the original `<channel source="agent-bridge" ...>` block plus `[BRIDGE-CONTEXT]`. |
| Session key | Resolved through OpenClaw's routing helpers for the chosen primary channel/account/peer. Telegram-bound targets use their configured `peer_id`; bridge-only targets should set `openclaw_channel: "agent-bridge"`. |
| Routing | Per-target subdir `~/.agent-bridge/inbox/openclaw/<target>/` — each target maps to one configured OpenClaw account/session target. |
| Reply path | Agent-driven. Natural turn output goes through the primary session-bound outbound; `additionalReplyChannels` only hints which user-facing channels the agent should consider. Bridge replies use `bridge_send_message` / `fromTarget` rather than legacy `replyVia` fan-out. |
| Cross-harness reply | The inbound `[BRIDGE-CONTEXT]` exposes the sender machine and return target so the agent can send a bridge reply back to the originating harness. |

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
  3. Store the full BridgeMessage in the local relay-expand store (`~/.agent-bridge/relay-expand/`) and best-effort send a Telegram-visible compact relay receipt beginning `[Agent Bridge relay] 🛰️` unless `relayNotice` is disabled. The receipt includes `expand id: NN` and `expand: agent-bridge relay-expand NN` instead of the full message body.
  4. Resolve the canonical session route via `runtime.channel.routing.resolveAgentRoute(...)`.
  5. Build a synthetic inbound `ctxPayload` via `runtime.channel.reply.finalizeInboundContext({...})`, pinned either to Telegram (`Provider/OriginatingChannel/OriginatingTo = telegram`) or to the native `agent-bridge` channel with an encoded bridge peer id according to the selected primary channel.
  6. `await dispatchInboundReplyWithBase({cfg, channel, accountId, route, storePath, ctxPayload, core: runtime, deliver, onRecordError, onDispatchError})`. This runs a synchronous agent turn in the target session.
  7. Replies are agent-driven: the natural turn output goes through the selected primary channel, and the agent calls bridge/user-facing tools explicitly for any additional legs.
- After successful dispatch, the consumed inbox file is moved to `~/.agent-bridge/archive/openclaw/<target>/`. Seeing a message there means it was delivered to OpenClaw; pending messages remain in `~/.agent-bridge/inbox/openclaw/<target>/`.
- Legacy messages at `~/.agent-bridge/inbox/*.json` (no subdir, no `target` field) are quarantined to `~/.agent-bridge/inbox/.failed/_unrouted/` with a deprecation log line.
- The outbound `ChannelOutboundAdapter.sendText` adapter is preserved for cross-harness bridge replies — if the paired peer is another agent-bridge-aware agent (not a Telegram session), the reply can still SFTP back via the bridge instead of landing in Telegram.

## No dependencies

Node builtins only (`fs`, `path`, `os`, `child_process`, `crypto`). Uses the
host's bundled SSH and SFTP for outbound delivery.
