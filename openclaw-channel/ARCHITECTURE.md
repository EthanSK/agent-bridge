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

```js
const { enqueueSystemEvent } = await import("openclaw/plugin-sdk/channel-core");
enqueueSystemEvent(envelopeText, {
  sessionKey: `agent-bridge:${fromMachine}`,
  contextKey: fromMachine,
  trusted: true,
});
```

The envelope is formatted as a `<channel source="agent-bridge" from="..."
to="..." message_id="..." ts="..." reply_to="...">content</channel>` block.
This is intentional parity with the Claude Code channel plugin so the agent
sees the same message shape on both sides of the bridge.

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

## Fan-out (future work)

The task brief mentioned fan-out to BOTH telegram AND the bridge sender.
OpenClaw's reply pipeline already supports routing a single reply to
multiple channels via binding rules — the right way to fan out is a binding
rule, not a custom adapter. Config shape (not yet wired):

```json
"bindings": [
  {
    "agentId": "main",
    "match": { "channel": "agent-bridge" },
    "announce": { "channels": ["telegram:default"] }
  }
]
```

The `fanOutChannel`/`fanOutAccount` config keys are scaffolded in
`openclaw.plugin.json` so they can be wired once the binding pipeline is
exposed to channel plugins directly.

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
