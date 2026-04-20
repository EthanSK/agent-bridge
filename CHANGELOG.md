# Changelog

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
