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

Inbound messages are dispatched into the running agent session via
`dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat`. This is
the SAME dispatch primitive the built-in IRC and Nextcloud Talk channels
use, and it drives the same `dispatchReplyFromConfig` path the native
Telegram bot drives for every real incoming message. It synchronously
runs an agent turn for our synthetic `ctxPayload` and routes the reply
back through the live Telegram outbound.

As of **v2.2.0** we no longer use `enqueueSystemEvent`. That function is
pure queueing — it only prepends a `System:` line to the next
naturally-scheduled turn's prompt and does NOT trigger a turn on its own.
See `openclaw-channel/docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md`
§4 for the full analysis.

```js
// runtime = api.runtime (PluginRuntime)
// hostCfg = api.config (OpenClawConfig)

const route = runtime.channel.routing.resolveAgentRoute({
  cfg: hostCfg,
  channel: "telegram",
  accountId: target.account,
  peer: { kind: "direct", id: target.peer_id },
});

const storePath = runtime.channel.session.resolveStorePath(
  hostCfg?.session?.store,
  { agentId: route.agentId },
);

const ctxPayload = runtime.channel.reply.finalizeInboundContext({
  Body: envelopeText,
  RawBody: raw,
  CommandBody: raw,
  From: `telegram:${peerId}`,
  To: `telegram:${peerId}`,
  SessionKey: route.sessionKey,
  AccountId: route.accountId,
  ChatType: "direct",
  Provider: "telegram",
  Surface: "telegram",
  OriginatingChannel: "telegram",       // <-- steers reply routing
  OriginatingTo: `telegram:${peerId}`,  // <-- ditto
  MessageSid: msg.id,
  Timestamp: Date.now(),
});

await dispatchInboundReplyWithBase({
  cfg: hostCfg,
  channel: "telegram",
  accountId: route.accountId,
  route,
  storePath,
  ctxPayload,
  core: runtime,
  deliver: async (payload) => {
    await runtime.channel.telegram.sendMessageTelegram(
      String(peerId), payload.text, { cfg: hostCfg, accountId: route.accountId },
    );
  },
  onRecordError: (err) => log.error(...),
  onDispatchError: (err, info) => log.error(...),
});
```

### Reply routing uses OriginatingChannel, not lastChannel

Replies are routed via `ctx.OriginatingChannel` + `ctx.OriginatingTo`
(see `route-reply-CQe8rYFT.js:17-23` docstring). The session's persisted
`lastChannel` is only a fallback for out-of-band / heartbeat / scheduled
sends — NOT for in-turn replies. This protects us from `lastChannel`
drifting (heartbeat runs set it to `webchat/heartbeat`) and is what every
native channel does.

### Session key resolution is SDK-driven

We no longer hand-construct the session key. `resolveAgentRoute` uses
`cfg.session.dmScope` internally, so the same code works regardless of
whether Ethan's configured dmScope is `main`, `per-peer`,
`per-channel-peer`, or `per-account-channel-peer` (current default —
produces `agent:main:telegram:<account>:direct:<peerId>`).

The envelope is formatted as a `<channel source="agent-bridge" from="..."
to="..." target="..." message_id="..." ts="..." reply_to="...">content</channel>`
block. This is intentional parity with the Claude Code channel plugin so
the agent sees the same message shape on both sides of the bridge.

### Per-target subdir routing

v2.1.0 watches `~/.agent-bridge/inbox/openclaw/<targetName>/*.json` for
each resolved target. Subdir name → target config → session key → running
session. Adding a new Telegram bot usually means adding an entry under
`channels.telegram.accounts` (no `targets` edit required — see auto-
discovery below); the gateway hot-reloads and the watcher starts polling
the new subdir on the next cycle.

Legacy flat-file messages (landing in `inbox/*.json` or `inbox/openclaw/*.json`
with no subdir) are moved to `inbox/.failed/_unrouted/` on every scan —
there is no default routing.

### Target auto-discovery

If `channels["agent-bridge"].config.targets` is absent or empty, the
plugin auto-discovers one target per entry in the OpenClaw global config's
`channels.telegram.accounts` map. Each account name becomes a target
routing to `telegram:<account>`. Peer ID resolution order per target:

1. `targets.<name>.peer_id` (when the explicit override block is present).
2. `channels["agent-bridge"].config.peer_id` (plugin-level default).
3. `meta.user_id` / `meta.owner_id` / `meta.telegram_user_id` on the global config.
4. First numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`.

When none of the above resolves, the target is skipped with a loud warn
log rather than silently routing to the wrong chat.

### Round-trip replies (fromTarget)

`BridgeMessage` carries an optional `fromTarget` field — the sender's own
target-id. When OpenClaw replies over the bridge (cross-harness flows
where the peer isn't a Telegram session), `envelope.buildReply(...)`
populates the outgoing `target` from `incoming.fromTarget` so the reply
lands back in the session that started the conversation. In
`replyVia="agent-bridge"` mode, the OpenClaw peer id encodes both
`msg.from` and `msg.fromTarget`; the return target is part of the session
identity, not just an in-memory hint. That keeps separate sender targets on
the same machine from collapsing onto one session and survives gateway
restarts. The in-memory `replyTargets` map remains a fast-path for the
current dispatch and carries the incoming message id for `replyTo`.

## Outbound replies

When the agent replies in-turn, OpenClaw's reply pipeline calls our
`outbound.sendText(ctx)`. We:

1. Resolve the target machine and return target — decode the persisted
   agent-bridge peer id from `ctx.to`, then merge any current-process
   `replyTargets` hit for the incoming message id.
2. Build a `BridgeMessage` envelope with `type: "reply"` and the correct
   `replyTo` id.
3. Stage it temporarily at `~/.agent-bridge/outbound/<id>.json`.
4. `scp -i ~/.agent-bridge/keys/agent-bridge_<remote> <tmp>
   <user>@<host>:~/.agent-bridge/inbox/<target>/<id>.json`.
5. Remove the local staging file after success or failure. On the receiver,
   the target watcher moves successfully consumed inbox files to its archive
   directory; archive is a processed-message trace, not the live queue.

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
