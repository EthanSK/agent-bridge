# Changelog

## agent-bridge 3.4.2 — 2026-04-21

### Fix: prefer `internet_host` (Tailscale) over LAN when configured — no fallback

Previously, `agent-bridge status`, `agent-bridge run`, `bridge_send_message`,
`bridge_run_command`, `bridge_status`, etc. all probed the LAN `host` first
and only fell back to `internet_host` on SSH exit 255. On a foreign Wi-Fi
network the LAN probe to (e.g.) `192.168.1.58` would time out, the fallback
mechanism would kick in, but `agent-bridge status` still reported the peer
as unreachable when what it actually meant was "LAN is unreachable (and we
already know it will be, because I'm not at home)."

As of 3.4.2: **if `internet_host` is configured in `~/.agent-bridge/config`
for a peer, the CLI and MCP server ALWAYS use it and do NOT fall back to
LAN.** The LAN `host` field is only used when `internet_host` is absent.
Tailscale works from any network; LAN only works from home — preferring
Tailscale unconditionally is simpler and removes a whole class of
"reports unreachable despite peer being online" bugs.

Changed:

- `mcp-server/src/ssh.ts`: `sshExec` now picks a single endpoint
  (`internetHost` when set, else LAN) and does not fall back on exit 255.
  Transient client-side retries (`Address already in use` etc.) still happen
  on the same endpoint.
- `mcp-server/src/ssh.ts`: new `sshPingDetailed()` returns which path was
  used so callers can surface it. `sshPing()` is a thin boolean wrapper kept
  for compatibility.
- `mcp-server/src/pathCache.ts`: `pathOrder()` now returns a single entry
  based on the new policy. The path cache is still written for
  observability, but no longer drives endpoint selection.
- `mcp-server/src/tools.ts`: `bridge_status` output includes `via lan` /
  `via internet` so the chosen path is obvious. The `probe` flag is now a
  no-op (kept for compatibility).
- `agent-bridge` (bash CLI): `status`, `connect`, `run`, and
  `ssh_exec_with_fallback` now pick a single endpoint with no retry loop.
  `status` output clearly shows `via LAN` or `via internet`.
- `agent-bridge reset-path` and the `--probe/--fresh` status flags are
  retained as no-ops for backwards compatibility.
- Versions: CLI `3.3.0 → 3.4.2`, `mcp-server 3.4.1 → 3.4.2`.

### Fix: parent-PID liveness check — exit when Claude dies (prevents zombie MCPs)

When a Claude Code session exits ungracefully (terminal killed, laptop
sleep, crash), the MCP child can get reparented to launchd (`ppid=1`)
while still holding a live file watcher. It keeps receiving inbox files
and calling `markDelivered()` on them — but there's no Claude to push
the channel into. Result: messages silently disappear into the zombie.
On 2026-04-21 a 10-hour-old zombie (Claude PID 29834 → child MCP 29854)
ate every inbound bridge push on MBP.

3.4.2 adds a 5-second parent-liveness watchdog on top of the existing
stdio-close shutdown path:

- Captures `process.ppid` at boot and logs `parent.detected`.
- Every 5s: if `process.ppid !== parentPid` (reparent), log
  `parent.orphaned` and shut down; if `process.kill(parentPid, 0)`
  throws `ESRCH` (parent gone), log `parent.dead` and shut down.
  `EPERM` is treated as "still alive" — we just can't signal it.
- `clearInterval` is called in every shutdown path so the timer can't
  fire a stale tick mid-teardown (no race with `stdin end` / SIGTERM).
- Opt-out: `AGENT_BRIDGE_DISABLE_PARENT_CHECK=1` skips the check and
  logs `parent.check.disabled` — for diagnostic detachment scenarios.

Changed:

- `mcp-server/src/index.ts`: replaced the old orphan-watchdog with the
  new parent-liveness check + structured events.

## mcp-server 3.4.1 — 2026-04-20

### Fix: orphan mcp-server instances race on `inbox/claude-code/` causing delivery starvation

When multiple mcp-server processes run on the same machine (Claude Code's
stdio child + one instance per OpenClaw agent session that lists
`agent-bridge` under `mcp.servers`), they all start the file watcher in
`watcher.ts :: startWatcher`, all detect new files in
`~/.agent-bridge/inbox/claude-code/`, and all race to call
`markDelivered(msg.id)`. Whichever orphan wins flips the shared
`.delivered` bookkeeping to `true`, after which the instance actually
wired to the running Claude Code session hits the `isDelivered`
short-circuit at `watcher.ts:113` and skips the channel notification
entirely. User-visible symptom: bridge messages never surface in Claude
Code's conversation (or only after the process restarts and drops the
in-memory delivered set).

Fix: new `AGENT_BRIDGE_DISABLE_WATCHER=1` /
`AGENT_BRIDGE_ROLE=tools-only` env var. Hosts that only need the
outbound tools (send, run_command, status) and do NOT consume the
channel notification stream should set this. Typical usage — add to the
OpenClaw or any non-Claude-Code mcp.json:

```json
"mcp": { "servers": { "agent-bridge": {
    "command": "node",
    "args": ["/Users/ethansk/Projects/agent-bridge/mcp-server/build/index.js"],
    "env":  { "AGENT_BRIDGE_DISABLE_WATCHER": "1" }
} } }
```

Also skips `replayUndeliveredMessages()` in tools-only mode (otherwise
startup replay would markDelivered the entire backlog and starve the
real Claude Code instance).

Claude Code's own mcp.json leaves the env unset so its single instance
keeps watching `inbox/claude-code/` and owns delivery exclusively.

## openclaw-channel 2.3.0 — 2026-04-20

### `replyVia` mode — agent-bridge back-channel for silent agent-to-agent replies

Previously every inbound bridge message that injected into an OpenClaw
session had its reply routed back through Telegram (so Ethan's phone
pinged on every agent-to-agent exchange). v2.3.0 introduces a `replyVia`
routing option that also supports agent-bridge itself as the return
channel — useful for back-channel conversations that should stay
invisible to Telegram.

**Config.** Three layers, precedence top-down:

1. Per-message: `BridgeMessage.replyVia = "telegram" | "agent-bridge"`.
2. Per-target: `channels["agent-bridge"].config.targets.<name>.replyVia`.
3. Plugin-level default: `channels["agent-bridge"].config.replyVia`.
4. Fallback: `"telegram"` (preserves v2.2.x semantics exactly).

Unknown `replyVia` values fall back to `"telegram"` with a warn log.

**`replyVia: "telegram"` (default)** — unchanged from v2.2.x. Inbound
message injects into `agent:main:telegram:<account>:direct:<peerId>`;
reply flows through the live Telegram outbound; Ethan's phone pings.

**`replyVia: "agent-bridge"`** — inbound message injects into
`agent:main:agent-bridge:default:direct:<senderMachine>` with
`Provider`/`OriginatingChannel = "agent-bridge"`. The reply is routed
through the native `agent-bridge` channel's `sendText` outbound
(channel-plugin.js), which SCPs a BridgeMessage back to the sender
machine's inbox. No Telegram traffic is generated.

- `peer_id` becomes optional on agent-bridge-only targets — peer identity
  comes from `msg.from` at message time, not from config. Telegram-mode
  targets still require `peer_id`.
- The registered `replyTargets` hint map already indexes by
  `sessionKey`, `fromMachine`, and target name, so outbound delivery via
  our own channel finds the right `{fromMachine}` hit without any extra
  wiring.

**No changes to `channel-plugin.js`, `outbound.js`, or `envelope.js`
(beyond docstring updates noting the optional per-message `replyVia`
field).** The dispatch primitive (`dispatchInboundReplyWithBase`) does
the heavy lifting by switching the `channel` + `accountId` parameters
— the rest of the pipeline doesn't need to know which mode it's in.

## agent-bridge repo — 2026-04-20 (infra)

- Added top-level `scripts/update.sh` one-shot updater (git pull → rebuild
  mcp-server → optional OpenClaw gateway restart → optional Claude Code
  `/reload-plugins` via the `self-reload-plugins` skill). Idempotent,
  prompt-guarded, safe to re-run.
- Added "Updating" section to the top-level `README.md` documenting the
  three moving parts (CLI script, MCP server, OpenClaw plugin), the helper
  script, and the manual update path.

## openclaw-channel 2.2.0 — 2026-04-20

### Architectural correction — replace `enqueueSystemEvent` with `dispatchInboundReplyWithBase`

**Root cause of "injection works but agent never responds":** v2.1.x used
`enqueueSystemEvent` to push bridge messages into the target telegram
session. That function is pure queueing — it prepends a `System:` line
to the NEXT naturally-scheduled turn's prompt but does NOT trigger a turn.
So every bridge message sat in the queue until Ethan happened to send a
real Telegram message, at which point our queued text surfaced as a
`System: ...` line on an unrelated turn. End-to-end delivery appeared
broken.

Full analysis: `openclaw-channel/docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md`
— read-the-source study of OpenClaw's channel dispatch path with citations.

**Fix:** switch `src/index.js` to call `dispatchInboundReplyWithBase` from
`openclaw/plugin-sdk/compat`. This is the SAME primitive the native IRC
and Nextcloud Talk channels use, and it drives the same
`dispatchReplyFromConfig` path the built-in Telegram bot drives for every
real incoming message. It synchronously runs an agent turn for our
synthetic `ctxPayload` and routes the reply back through the live Telegram
outbound because we set `Provider: "telegram"` + `OriginatingChannel:
"telegram"` + `OriginatingTo: "telegram:<peerId>"` on the ctxPayload.

**Session-key resolution** now goes through
`runtime.channel.routing.resolveAgentRoute({ cfg, channel, accountId, peer })`
instead of being hand-constructed. This respects Ethan's `cfg.session.dmScope`
(currently `per-account-channel-peer`, producing
`agent:main:telegram:<account>:direct:<peerId>`) and keeps working if he
ever changes it.

**Reply routing** is now driven by `ctx.OriginatingChannel` +
`ctx.OriginatingTo` (see `route-reply-CQe8rYFT.js:17-23`), not the session's
persisted `lastChannel`. This is what the native channels do and it
protects us from `lastChannel` drifting (heartbeat runs set it to
`webchat/heartbeat`).

**Removed:** `enqueueSystemEvent` import, `probeSession` helper (SDK
doesn't expose session lookup), the hand-built sessionKey
(`buildSessionKey`), and the `trusted: false` option (not a real flag on
`SystemEventOptions`).

**Added:** `loadDispatchRuntime` helper that imports the compat module
using the same host-resolver walk as v2.1.x used for infra-runtime. A
`resolveProviderDeliver({runtime, targetChannel})` adapter delegates
outbound text to `runtime.channel.telegram.sendMessageTelegram(...)`;
adding discord/slack/etc. is a one-line extension there.

**Version bump:** 2.1.1 → 2.2.0.

## openclaw-channel 2.1.1 — 2026-04-20

### Logger fix — restore visibility of plugin log bodies

OpenClaw's logger sink renders only the first positional argument and drops
the rest. `src/log.js` was passing `"[agent-bridge/v2]"` as arg[0] and the
real message body as arg[1+], so every plugin log line showed up in
`gateway.log` as just `[plugins] [agent-bridge/v2]` with no content.
Concatenate the tag INTO the message string so the body is always visible.

This unblocks debugging of the session-injection path — `watching N target(s)`,
`session-injection mode`, `inbox: dispatch failed`, etc. now actually render.

### Inbox file archival after successful dispatch

`inbox-watcher.js` now moves processed files to
`~/.agent-bridge/archive/openclaw/<target>/` on successful dispatch
(ledger-marked afterwards) and to `~/.agent-bridge/inbox/.failed/openclaw__<target>/`
if `onMessage` throws. Previously files stayed in the target subdir forever;
only the delivery ledger prevented re-processing, and any ledger reset led
to duplicate injections. Archived filenames are prefixed with an ISO-ish
timestamp to avoid collisions after ledger rotation.

### Pre-inject diagnostics + hardened try/catch around enqueueSystemEvent

Before calling `enqueueSystemEvent` we now log the resolved `sessionKey`
and a best-effort probe result (exists / missing(will-create) /
unknown(no-lookup-api)) using any session-lookup helper the plugin-sdk
happens to expose. The try/catch around `enqueueSystemEvent` now logs
`err.message` and `err.stack` explicitly, then re-throws so the watcher
quarantines the file to `.failed/` instead of re-processing it on every
poll. Messages rejected with `ok === false` (no active session) are
likewise quarantined with a clear reason.

## mcp-server 3.4.0 + openclaw-channel 2.1.0 — 2026-04-20

### Per-target inbox routing + OpenClaw session injection

The single global `~/.agent-bridge/inbox/` directory has been split into
per-harness-per-target subdirs, and the OpenClaw channel plugin now injects
bridge messages into the already-running Telegram-bound agent session so
replies land in the SAME Telegram chat the user was already talking in.

**New inbox layout:**

```
~/.agent-bridge/inbox/
├── claude-code/              ← Claude Code channel plugin watches this
├── openclaw/
│   ├── default/              ← OpenClaw @ClawdStationMiniBot session
│   ├── clawdiboi2/           ← OpenClaw @Clawdiboi2bot session
│   └── clordlethird/         ← OpenClaw @ClordLeThirdBot session
├── .archive/<target>/
└── .failed/
    ├── <target>/             ← malformed per target
    └── _unrouted/            ← legacy / no-target messages, quarantined
```

**`bridge_send_message` gains a required `target` parameter:**

```jsonc
bridge_send_message({ machine: "Mac-Mini", message: "hi", target: "claude-code" })
bridge_send_message({ machine: "Mac-Mini", message: "hi", target: "openclaw/clawdiboi2" })
```

There is intentionally **no default routing**. Calls without `target` are
rejected at the sender. Legacy flat files at `inbox/*.json` (pre-3.4.0
senders) are moved to `inbox/.failed/_unrouted/` on next startup with a
deprecation log line.

**OpenClaw session injection (v2.1.0):**

The openclaw-channel plugin now watches `inbox/openclaw/<target>/` for each
configured target. On each inbound message it builds a session key —
`agent:<agentId>:<openclaw_channel>:<account>:direct:<peer_id>` — and calls
`enqueueSystemEvent(body, { sessionKey, trusted: false })` to inject the
message into the matching running session. The session's own `lastChannel`
drives reply routing, so bridge messages naturally round-trip through
Telegram instead of spawning a separate "agent-bridge" channel.

`trusted: false` — SSH pairing is not a first-party trust boundary.
`requestHeartbeatNow` is called after injection when the plugin-sdk exports
it, to wake idle sessions promptly.

**Config (`openclaw.json`):**

```json
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
```

Listeners are independent processes: each harness (Claude Code, OpenClaw,
future agents) watches only its own subdir. One crashing doesn't affect
the others.

**Version bumps:**

- `mcp-server`: 3.3.0 → **3.4.0** (new `target` field on BridgeMessage + tool arg; per-target subdir layout; legacy-file migration)
- `openclaw-channel`: 2.0.0 → **2.1.0** (multi-target watcher; session-injection; `trusted: false`; heartbeat wake)

**Upgrade notes:**

1. Pull the repo on both machines and `npm run build` in `mcp-server/`.
2. Add the `targets` map to the `channels["agent-bridge"].config` block in
   `~/.openclaw/openclaw.json` on the machine(s) running OpenClaw.
3. Update any scripts / alias that call `bridge_send_message` to pass `target`.
4. Old messages sitting in `inbox/*.json` (pre-upgrade) will auto-migrate
   to `.failed/_unrouted/` on first startup of the new mcp-server.

See [docs/PLAN-INBOX-SUBDIRS-AND-SESSION-INJECTION-2026-04-20.md](docs/PLAN-INBOX-SUBDIRS-AND-SESSION-INJECTION-2026-04-20.md) for the design + decision log.

## 3.0.0 — 2026-04-14

### BREAKING: remove fresh-spawn agent wrappers — channel mode only

The `--claude`, `--codex`, and `--agent` flags have been removed from
`agent-bridge run`. These flags wrapped the user's prompt in a remote
`claude --print` / `codex exec` / custom agent CLI invocation, spawning a
NEW non-interactive agent session on the remote machine. That's the exact
opposite of what this project is for.

Agent-to-agent communication is now EXCLUSIVELY via channel mode:

    bridge_send_message (MCP tool)
      -> inbox file drop over SSH
      -> remote file watcher
      -> pushed into the RUNNING agent's conversation context
         as <channel source="agent-bridge" ...>content</channel>

The whole point of agent-bridge is to connect EXISTING, already-running
agent sessions — not to spawn fresh ones.

**What was removed:**

- `agent-bridge run <machine> "..." --claude` (shorthand for `claude --print`)
- `agent-bridge run <machine> "..." --codex` (shorthand for `codex exec`)
- `agent-bridge run <machine> "..." --agent "<cli>"` (arbitrary wrapper)
- All doc examples, help text, site copy, and skill/plugin instructions
  referencing the above.

**What was kept:**

- `agent-bridge run <machine> "<shell cmd>"` — plain SSH remote-shell
  utility, useful for diagnostics (`git pull`, `ls ~/Projects`, `ps aux`,
  checking file paths, tailing a log). No agent wrapper.
- `bridge_send_message`, `bridge_receive_messages`, and the rest of the
  channel-mode machinery — unchanged and still the core of the project.
- `setup` / `pair` / `list` / `status` / `unpair` / `connect` / `version` /
  `help` — unchanged.

**Migration:**

| Before | After |
|--------|-------|
| `agent-bridge run MacBook-Pro "fix the tests" --claude` | From an agent: use `bridge_send_message("MacBook-Pro", "fix the tests")` so the running remote agent picks it up on its channel. |
| `agent-bridge run MacBook-Pro "..." --codex` | Same — send via `bridge_send_message`; the remote agent (whichever harness it is) receives the message in its live session. |
| `agent-bridge run MacBook-Pro "..." --agent "<cli>"` | Same. |
| `agent-bridge run MacBook-Pro "uname -a"` | Unchanged — plain shell still works. |

Running any of the removed flags now prints an explicit error pointing at
`bridge_send_message`.

**Version alignment:**

- CLI (`agent-bridge`): `VERSION="3.0.0"` (previously `5.0.0`).
- MCP server (`mcp-server/package.json`, plugin manifest, server
  `McpServer` version string): `3.0.0` (previously `2.3.x`).

## 2.3.2 — 2026-04-14

### fix(mcp-server): tilde not expanded in remote inbox path — messages land in literal `~` directory

**Bug:** Every message sent via `bridge_send_message` wrote to a literal `~/.agent-bridge/inbox/`
directory on the remote machine instead of the user's real `$HOME/.agent-bridge/inbox/`. This
caused messages to accumulate silently in the shadow dir while the file watcher watched the real
inbox, so no messages were delivered.

**Root cause:** `sshWriteFile` in `src/ssh.ts` single-quoted the remote path:
```
mkdir -p "$(dirname '~/.agent-bridge/inbox/msg-XXX.json')" && ... > '~/.agent-bridge/inbox/msg-XXX.json'
```
Single quotes prevent shell tilde expansion — the shell treats `~` as a literal directory name.

**Fix:** Before building the remote command, replace a leading `~/` in the path with `$HOME/`
and wrap the path in double quotes so the remote shell expands `$HOME` correctly. The base64
payload remains single-quoted (safe, as it only contains `[A-Za-z0-9+/=]`).

**Files changed:** `mcp-server/src/ssh.ts` (8 lines added/changed in `sshWriteFile`).

## 2.3.1 — 2026-04-14

### OpenClaw companion — parity pass

Audited `openclaw-plugin/` against the v2.3.0 Claude Code plugin-ification
to confirm the OpenClaw side is in a coherent, installable state.

No code changes were needed. The OpenClaw plugin was already:
- Loading correctly on OpenClaw 2026.4.12 (`Status: loaded`).
- Free of hardcoded `/Users/<user>/...` paths (uses `$HOME` / `os.homedir()`
  throughout `src/` and `bin/`).
- Hardened identically to the Claude Code MCP server — `SIGINT` / `SIGTERM` /
  `SIGHUP` / `SIGPIPE` handlers, `stdin` end/close/error handlers, an orphan
  watchdog on `process.ppid`, and an `EPIPE` / `Broken pipe` detector on
  `uncaughtException` / `unhandledRejection`. All verbatim from `a88d614`.

Doc-only changes:
- `openclaw-plugin/README.md` — replaced the `/Users/USERNAME/...` launchd
  placeholder with a shell heredoc template that expands `$HOME` and
  `command -v node` / `command -v openclaw` before writing the plist (launchd
  does not expand `$HOME` inside `ProgramArguments`).
- `openclaw-plugin/PARITY_REPORT.md` — new. Documents the audit, the
  architectural differences between the two sides, the one cosmetic
  `reload registration missing prefixes` warning, and the install procedure
  on a fresh machine.

## 2.3.0 — 2026-04-14

### Plugin-ification

agent-bridge can now be installed as a single Claude Code **plugin** that bundles BOTH halves of the integration:

- The MCP server (outgoing tools: `bridge_send_message`, `bridge_receive_messages`, `bridge_run_command`, `bridge_status`, `bridge_list_machines`, `bridge_clear_inbox`, `bridge_inbox_stats`).
- The channel (incoming push of remote messages as `<channel source="agent-bridge" ...>` events).

Previously the channel side required launching Claude with `--dangerously-load-development-channels --channels server:agent-bridge`, and the MCP-tools side required hand-editing `.mcp.json`. The two halves were never wired up together, so users routinely had one without the other.

**Install:**
```bash
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

**New files:**
- `.claude-plugin/marketplace.json` — declares the repo as a local Claude Code marketplace.
- `mcp-server/.claude-plugin/plugin.json` — plugin manifest.
- `mcp-server/.mcp.json` — registers the unified MCP+channel server with `${CLAUDE_PLUGIN_ROOT}` path resolution.

The bash `agent-bridge` CLI is unchanged and still installed via `./install.sh` for pairing and SSH transport. The plugin and the CLI coexist.

> **Historical note (3.0.0):** this release originally documented `agent-bridge run … --claude` as an agent-to-agent prompt path. That mechanism was removed in 3.0.0 — see the 3.0.0 entry above. Channel mode (`bridge_send_message`) is the only supported agent-to-agent path.

The unified server logic (single Node process advertising MCP tools AND emitting `notifications/claude/channel`) was already in place from v2.2.0; this release wires it into the Claude Code plugin system. All EPIPE / SIGHUP / orphan-watchdog hardening from `a88d614` is preserved verbatim.
