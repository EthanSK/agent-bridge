# Architecture — openclaw-channel

This doc captures the SDK research + design choices behind the v2 channel
plugin. If you need to extend it, start here.

## The OpenClaw channel plugin contract

OpenClaw ships a plugin-sdk at
`/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/`. Third-party
plugins register channels via the main plugin API:

```ts
// From plugin-sdk/src/plugins/types.d.ts
export type OpenClawPluginApi = {
  registerChannel: (
    registration: OpenClawPluginChannelRegistration | ChannelPlugin
  ) => void;
  // ...
};

export type OpenClawPluginChannelRegistration = {
  plugin: ChannelPlugin;
};
```

A `ChannelPlugin` (see
`plugin-sdk/src/channels/plugins/types.plugin.d.ts`) is a wide contract —
around 25 optional adapter surfaces. The minimum viable shape we implement:

- `id` — stable channel id (`"agent-bridge"`).
- `meta` — user-facing metadata (label, docsPath, blurb, etc.).
- `capabilities` — advertised chat types; we claim `direct` only.
- `config` — `listAccountIds`, `resolveAccount`, `defaultAccountId`. A single
  implicit `"default"` account is enough for us because per-peer config
  lives in `~/.agent-bridge/config`, not `openclaw.json`.
- `setup.applyAccountConfig` — required by the SDK. Implemented as a no-op
  since the CLI command `agent-bridge pair` owns the real config state.
- `outbound.sendText` — SCPs a `BridgeMessage` reply to the remote machine.
- `reload.configPrefixes` — lets the gateway hot-reload when our config block
  changes instead of requiring a full restart.

Everything else (`security`, `groups`, `pairing`, `threading`, `doctor`,
`status`, `heartbeat`, `gateway*`) is intentionally omitted. The host treats
missing adapters as "use defaults" which is fine for a minimal cross-machine
channel.

## Inbound dispatch

Inbound messages are injected into the running agent session via
`enqueueSystemEvent` from `openclaw/plugin-sdk/channel-core` (or
`/channel-inbound` on older hosts — we try both). This is the same public
API the built-in channels use for out-of-band system injections, and it
lets us push a message without any CLI shell-out.

As of **v2.1.0** the session key is derived from the per-target config, so
bridge messages land in the SAME session the user is already talking to on
Telegram — the agent answers back over Telegram, not back over the bridge.

```js
const { enqueueSystemEvent, requestHeartbeatNow } =
  await import("openclaw/plugin-sdk/infra-runtime");

// Session key format: agent:<agentId>:<channel>:<account>:direct:<peerId>
const sessionKey = `agent:${agentId}:${target.openclaw_channel}:${target.account}:direct:${target.peer_id}`;

enqueueSystemEvent(envelopeText, {
  sessionKey,
  contextKey: fromMachine,
  trusted: false,            // SSH pairing is not a first-party trust boundary
});

// Wake an idle session so the inbound event is processed now instead of
// waiting for the next natural heartbeat. Optional — the helper isn't
// present on every plugin-sdk version.
requestHeartbeatNow?.({ sessionKey, reason: "agent-bridge:inbound" });
```

`deliveryContext` is intentionally omitted — letting the target session's
own `lastChannel` drive reply routing is simpler and means the bridge
message round-trips through Telegram naturally.

The envelope is formatted as a `<channel source="agent-bridge" from="..."
to="..." target="..." message_id="..." ts="..." reply_to="...">content</channel>`
block. This is intentional parity with the Claude Code channel plugin so
the agent sees the same message shape on both sides of the bridge.

### Per-target subdir routing

v2.1.0 watches `~/.agent-bridge/inbox/openclaw/<targetName>/*.json` for
each entry in the `targets` config map. Subdir name → target config →
session key → running session. Adding a new Telegram bot means adding one
entry to `targets` in `openclaw.json`; the gateway hot-reloads and the
watcher starts polling the new subdir on the next cycle.

Legacy flat-file messages (landing in `inbox/*.json` or `inbox/openclaw/*.json`
with no subdir) are moved to `inbox/.failed/_unrouted/` on every scan —
there is no default routing.

## Outbound replies

When the agent replies in-turn, OpenClaw's reply pipeline calls our
`outbound.sendText(ctx)`. We:

1. Resolve the target machine — prefer the `fromMachine` we captured on
   inbound (stored in an in-memory `replyTargets` Map keyed by
   `agent-bridge:<machine>`), fall back to `ctx.to`.
2. Build a `BridgeMessage` envelope with `type: "reply"` and the correct
   `replyTo` id.
3. Write it to `~/.agent-bridge/outbound/<id>.json`.
4. `scp -i ~/.agent-bridge/keys/agent-bridge_<remote> <tmp>
   <user>@<host>:~/.agent-bridge/inbox/<id>.json`.

The remote's file watcher / Claude Code channel plugin picks it up and
pushes it into its running session. Round-trip complete.

## Fan-out (superseded by session injection in v2.1.0)

In v2.0.x the plan was to fan-out replies to BOTH Telegram AND the bridge
sender via OpenClaw's binding rules. v2.1.0 takes a simpler approach:
inject the inbound message directly into the Telegram-bound session so the
reply travels back through Telegram on its own. The `fanOutChannel`/
`fanOutAccount` config keys are still recognised for backward compatibility
but are considered deprecated — use `targets.<name>` with an
`openclaw_channel` of `"telegram"` instead.

## File layout

```
openclaw-channel/
├── package.json            # openclaw.extensions points at src/index.js
├── openclaw.plugin.json    # plugin manifest + configSchema
├── README.md
├── ARCHITECTURE.md         # ← you are here
└── src/
    ├── index.js            # plugin entry: registerChannel + start watcher
    ├── channel-plugin.js   # the ChannelPlugin object (meta, config, outbound)
    ├── inbox-watcher.js    # poll ~/.agent-bridge/inbox/*.json
    ├── outbound.js         # SCP reply BridgeMessages back to sender
    ├── envelope.js         # BridgeMessage parse/build helpers
    └── log.js              # thin logger wrapper over api.logger
```

Zero dependencies — pure Node builtins. `openclaw` itself is a peer /
runtime dep provided by the host.

## Migration from v1.3.0

The previous extension plugin (formerly at `../openclaw-plugin/`) has been
removed from the repo as of v2.0.0. To migrate an existing install:

1. Add this module's path to `plugins.load.paths` in `~/.openclaw/openclaw.json`.
2. Add `channels["agent-bridge"] = { enabled: true }`.
3. Delete any `plugins.entries["agent-bridge"]` block and any path entry
   pointing at the old `openclaw-plugin/` directory.

The gateway hot-reloads on config change.
