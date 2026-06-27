# Agent Bridge

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## Debugging agent-bridge: read this FIRST

**Before investigating any agent-bridge issue — a dropped message, an unreachable machine, a silent OpenClaw, anything — the first thing you do is:**

```bash
tail -200 ~/.agent-bridge/logs/agent-bridge.log | jq -s '.'
```

That file is the unified NDJSON event log. Every component — the MCP server, the OpenClaw plugin, the standalone daemon, and the bash CLI — appends to it. Each line has `ts`, `component`, `machine`, `event`, `level`, `msg`, and an optional `context` object.

You can follow a single message end-to-end (send → inbox pickup → delivery → push) by filtering on its `msg_id`:

```bash
jq -c 'select(.context.msg_id == "msg-abc123")' ~/.agent-bridge/logs/agent-bridge.log
```

Errors only:

```bash
jq -c 'select(.level == "error" or .level == "warn")' ~/.agent-bridge/logs/agent-bridge.log
```

Both machines keep their own copies — when debugging a bidirectional issue, look at the log on **both** sides.

### Common event types and what they mean

- `server.starting` / `server.ready` — the MCP server is coming up on this machine
- `watcher.started` (backend=polling) — the 2-second polling inbox watcher is active
- `message.send_start` / `message.delivered` — outbound SSH write to the remote inbox succeeded
- `message.send_retry` / `message.send_failed` — the first SSH attempt failed; if you see `send_failed` without a follow-up success, the message never left this machine
- `message.received` — the local watcher saw a new inbox file
- `message.pushed_to_channel` — Claude's running session received the message
- `message.push_failed` — MCP channel notification failed (usually means Claude's session closed the pipe)
- `cli.pair.done`, `cli.unpair.done`, `cli.run.start`/`done`/`failed`, `cli.status.online`/`offline` — bash CLI activity

The OpenClaw channel plugin (`openclaw-channel/`) logs via the host's
`api.logger`, which lands in `~/.openclaw/logs/gateway.log` rather than the
NDJSON unified log above.

If the unified log is silent for a component you expect, that component either isn't running or never emitted a startup event — check `ps` and the older per-component logs (`~/.agent-bridge/logs/mcp-server.log`, `~/.openclaw/logs/gateway.log`) for bootstrap errors.

### What NOT to do

- **Don't grep three files.** The whole point of this unified log is you don't need to.
- **Don't assume the log has been created.** On a fresh install it materializes on the first event. Run `bridge_status` from the MCP (or `agent-bridge status`) once to force an entry.
- **Don't trust `mcp-server.log` as the single source of truth anymore.** It's the pre-v3.3 verbose log, still useful for deep dives but the unified log is the ground truth for structured event analysis.

See the "Debugging & logs" section of the top-level [README](README.md) for full `jq` recipe list.

---

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up agent-bridge"
- "enable SSH for remote access"
- "let the other agent control this machine"
- Sends a photo of an agent-bridge pairing screen

## Setup (run on any machine you want to bridge)

```bash
agent-bridge setup
```

Options:
```bash
agent-bridge setup --name "MacBook-Pro"   # Custom machine name
agent-bridge setup --port 2222             # Custom SSH port
```

For off-LAN access, use [Tailscale](https://tailscale.com) and point the paired machine's `internet_host` at its `100.x.y.z` IP (see README).

### What setup does

1. **Enables SSH** (Remote Login on macOS) if not already on
2. **Generates an ED25519 key pair** at `~/.agent-bridge/keys/`
3. **Adds the public key** to `~/.ssh/authorized_keys`
4. **Displays a pairing screen** with all connection details
5. **Auto-adds agent-bridge instructions** to detected AI harness files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.openclaw/AGENTS.md`, `~/.gemini/GEMINI.md`) so every new session knows about the bridge. This also runs during `pair`.

### After setup

Tell the user to:
1. **Photograph the pairing screen** displayed in the terminal
2. **Send the photo** to the agent on the other machine (e.g., via Telegram)
3. The other agent will read the photo and complete the pairing

## Available commands

All commands use the `agent-bridge` CLI:

### Check paired machines
```bash
agent-bridge list
```

### Check machine status
```bash
agent-bridge status              # All machines
agent-bridge status MacBook-Pro  # Specific machine
```

### Run a plain shell command remotely (diagnostics only)
```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git status"
agent-bridge run MacBook-Pro "brew update && brew upgrade"
```

> `agent-bridge run` is a plain remote-shell utility. It does NOT spawn or invoke an agent. The `--claude`, `--codex`, and `--agent` flags were removed in 3.0.0 — they ran a fresh non-interactive agent session (`claude --print` etc.) on the remote machine, which is the opposite of what this project is for.

### Pop a native macOS notification on any Mac (4.8.0+)

Pop a native macOS banner on **this** Mac or on a paired remote Mac. Primary use: tell the user an agent finished a task, on whichever Mac they are sitting at.

```bash
# Local — pops on THIS Mac immediately (terminal-notifier, osascript fallback):
agent-bridge notify --local --title "Build done" --message "all tests green" --subtitle "from MBP"

# Remote — SSHes to the target and runs ITS own `agent-bridge notify --local`,
# so the banner renders natively on that Mac:
agent-bridge notify Ethans-Mac-mini --title "Done" --message "task finished" --sound default
```

MCP tool form (`bridge_notify`):

```text
bridge_notify({ machine: "local",           title: "Build done", message: "all green", subtitle: "from MBP" })
bridge_notify({ machine: "Ethans-Mac-mini", title: "Done",       message: "task finished", sound: "default" })
```

> **This is a fire-and-forget side effect — it does NOT wake or message the remote agent and writes NO inbox file.** For agent-to-agent messaging use `bridge_send_message`. Routing: a *local* machine renders in-process; a *remote* machine is reached via `sshExec` running the remote's own `agent-bridge notify --local …`, so each machine decides terminal-notifier-vs-osascript by what it has installed. Sound: omit or `none` = silent; `default` = system default; a named sound (e.g. `Glass`, `Ping`) passes through. On the osascript fallback (no subtitle field) the subtitle is folded into the title as `"title — subtitle"`.

### Same-machine delivery (3.5.0+)

`bridge_send_message` accepts the **local machine name** (or one of the reserved aliases `local`, `self`, `localhost`) as its `machine` parameter. The message JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` — no SSH hop, no loopback round-trip:

```
bridge_send_message({ machine: "local",  message: "review the queue", target: "openclaw/<account-alias>" })
```

Use this when an MCP host needs to talk to another agent harness running on the **same** machine (canonical case: a Claude Code session messaging OpenClaw embedded Telegram sessions in the same gateway). The receiver still needs a watcher running on its inbox subdir — agent-bridge just lands the file. `agent-bridge run <local>` and `agent-bridge connect <local>` are deliberately rejected: there is no SSH loopback.

`agent-bridge list` and `agent-bridge status` always show the local pseudo-machine as `LOCAL — same-machine delivery, no SSH`.

### Talk to the RUNNING remote agent

Use the channel plugin's `bridge_send_message` MCP tool. **As of mcp-server 3.4.0, the `target` parameter is required** — there is no default routing:

```
bridge_send_message({ machine: "MacBook-Pro", message: "review the code in ~/Projects/myapp and suggest improvements", target: "claude-code/default" })
```

Targets decide which listener on the receiving machine picks up the message:
- `"claude-code/default"` — the default Claude Code persona. Pre-4.0 senders may still address legacy `"claude-code"`; v4 receivers migrate that flat path into `claude-code/default/`.
- `"claude-code/<persona>"` — a named Claude Code persona on the receiving machine, e.g. `"claude-code/yolo"`.
- `"openclaw/<account>"` — injects into the OpenClaw Telegram session for `<account>`. If the openclaw side runs the openclaw-channel plugin ≥ 2.1.0, each account under `channels.telegram.accounts` is auto-discovered as a target, so you can address them directly without an extra `targets` block in `openclaw.json`. As of openclaw-channel v3.0+, the receiving OC agent decides where to reply via tool calls (`bridge_send_message` for the implicit bridge leg, plus the user-facing channel of its choice). Configure the user-facing hint via `channels["agent-bridge"].config.additionalReplyChannels` (default `["telegram"]` for telegram-bound targets, `[]` for headless targets). Pass `one_way: true` to suppress the bridge-reply expectation entirely.
- `"<harness>/<name>"` — any other configured harness/subdir. Target names may contain Unicode letters / digits plus `_`, `.`, `-`, `/` (no `..`, no leading/trailing `/`, no `//`, ≤256 chars).

For bidirectional flows across harnesses, set `fromTarget` (or MCP tool arg `from_target`) on outbound messages to your own target-id (e.g. `fromTarget: "<harness>/<account-alias>"`). The Claude Code MCP tool supplies the sender's active `from_target: "claude-code/<persona>"` by default (usually `claude-code/default`) unless `one_way: true` is set. The receiver copies that into `reply.target` so the reply round-trips back to the session that originated it. For OpenClaw-originated sends, always use the CURRENT Telegram account's target-id (e.g. `openclaw/default`, `openclaw/<your-account-alias>`, etc.) so replies stay isolated per account.

The message is pushed into the running Claude session on MacBook-Pro as a `<channel source="agent-bridge" ...>` event. Its reply comes back the same way. This is the only supported agent-to-agent communication path.

### Named target routing

When the user names a specific target alias (a persona, a session, a per-account bot, etc.), route to the matching `target` literally — **don't default to `<harness>/default` when a specific alias was named**. That's a routing bug, not a fallback.

The convention is `<harness>/<account-alias>`:

| Spoken / written name(s)                              | `target`                          |
|-------------------------------------------------------|-----------------------------------|
| `Bot Alpha` / `bot-alpha` / `alpha`                   | `<harness>/bot-alpha`             |
| `Bot Beta` / `bot-beta` / `beta`                      | `<harness>/bot-beta`              |
| `<harness> default` / `default` / unspecified         | `<harness>/default`               |

Voice transcripts often mis-hear short proper-noun aliases. Re-read the transcript twice if a specific name is involved; prefer the explicit-alias reading over the default. Canonical rule + full rationale: [`docs/named-target-routing.md`](docs/named-target-routing.md).

### Relay inbound bridge messages to the user

**Relay every inbound bridge message to the user via your harness's configured user-facing channel** (Telegram, Slack, Discord, native UI, etc.) as a brief 1-3 sentence summary (sender machine + source target + destination machine + destination target + the actionable ask), with **both source-side and destination-side agent-bridge versions** shown when available, so the user has live visibility into what other harnesses are asking AND which builds produced/received the message. Keep it compact: do **not** paste the full bridge body into Telegram/user channels by default. Reply via bridge first if a response is needed; THEN relay to the user. Don't suppress the relay just because the message looks like routine internal coordination — the user generally wants to see all of it.

Format example (Telegram-style, adapt to your channel):

> 🛰️ Bridge from <sender-machine>/<source-target> (source v<X.Y.Z|unknown>) to <destination-machine>/<destination-target> (destination v<A.B.C|unknown>): <compact 1-3 sentence summary of the actionable ask>. Replied via bridge with <action>.

The 1-3 sentence band lets you keep trivial pings short while letting denser coordination context (multi-step plans, decisions, errors) flow as a paragraph block when warranted. Prefer the generated relay scaffold: it includes `source:` and `destination:` endpoint/version lines. If composing manually, read `source_agent_bridge_version` and `destination_agent_bridge_version` from BRIDGE-CONTEXT/channel metadata; legacy `agent_bridge_version` is a destination/local alias. Don't hardcode.

OpenClaw v3.1+ relay receipts show `expand id: NN` plus `expand: agent-bridge relay-expand NN` instead of a long `message:` preview. If the user says “expand Agent Bridge relay message NN”, run `agent-bridge relay-expand NN` on the same machine that produced the notice and send the retrieved full content, subject only to normal privacy/channel rules.

Exception: pure-noise heartbeats / liveness pings with no actionable content (e.g. `bridge_status` polls). Those can be silent.

Canonical rule + full rationale (format guidance, what counts as relayable, order of operations): [`docs/relay-to-user.md`](docs/relay-to-user.md).

### Open an interactive SSH session
```bash
agent-bridge connect MacBook-Pro
```

### Pair a new machine
```bash
# With flags:
agent-bridge pair --name "MacBook-Pro" --host 192.168.1.50 --port 22 --user ethan --token bridge-a7f3k9 --pubkey "ssh-ed25519 AAAA..."

# Interactive:
agent-bridge pair
```

### Remove a pairing
```bash
agent-bridge unpair MacBook-Pro
```

## Pairing from a photo

When the user sends a photo of another machine's pairing screen:

1. Read the image (you can see images natively)
2. Extract these fields from the pairing screen:
   - Machine Name
   - Username
   - Local IP (or Public IP if connecting over the internet)
   - Port
   - Token
   - Public Key
3. Run the pair command:
```bash
agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"
```
4. Then test: `agent-bridge status <name>`

## Typical workflows

### "Deploy my app on the MacBook"
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### "Ask the remote agent to review my code"

From inside your agent session (with the agent-bridge MCP tools available):

```
bridge_send_message({ machine: "MacBook-Pro", message: "review the code in ~/Projects/myapp/src/ and suggest improvements", target: "claude-code/default" })
```

For `target: "claude-code/default"` (or `"claude-code/<persona>"`), the running remote Claude Code persona receives it in-context and replies via `bridge_send_message` back to this machine. Legacy `target: "claude-code"` remains accepted only for rolling upgrades. OpenClaw targets use `target: "openclaw/<account>"` and are delivered by the separate OpenClaw channel plugin.

### "Check what's running on my other machine"
```bash
agent-bridge run MacBook-Pro "ps aux | head -20 && df -h && free -h 2>/dev/null"
```

## v2: MCP Server (running agent-to-agent communication)

If the agent-bridge MCP server is configured, you have direct access to these tools without needing the CLI. The MCP server provides the shared `bridge_*` tools for EXISTING running agent sessions -- it does NOT spawn new agent processes. Push delivery is host-specific: Claude Code uses the MCP server's experimental `claude/channel` stdio path, while OpenClaw uses the separate native `openclaw-channel/` plugin.

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox. Supports long-poll via `wait: true, timeout_seconds: 30` for subagents that need to receive bridge replies (channel push only reaches the parent session). |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Claude Code unified plugin (3.7.0+)

For Claude Code, agent-bridge ships **one unified plugin** at `mcp-server/`. It hosts both:

- The 7 user-facing `bridge_*` tools (and the diagnostic `claude_code_channel_status` no-op tool).
- The long-lived inbox watcher that owns a persona-scoped lease such as `~/.agent-bridge/locks/claude-code__default.watcher-lock.json`, polls `inbox/claude-code/<persona>/`, and emits `notifications/claude/channel` back to the running session.

Incoming messages are pushed directly into the conversation as:
```
<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>
```
No polling needed — respond using `bridge_send_message`.

**Why one plugin?** 3.6.0 split the channel host into a separate `claude-code-channel` plugin assuming "channel-only plugins survive longer in Claude's plugin host." That was empirically wrong — the host gates idle reaping on **MCP tool-call frequency on stdio JSON-RPC**. Telegram (also a channel plugin) survives indefinitely because its 4 tools (`reply`, `react`, `download_attachment`, `edit_message`) get called constantly. A channel-only plugin gets reaped after every notification delivery, and Patches G/H (SIGTERM ignore + no-op tool) didn't fix the root cause. 3.7.0 re-merged everything into one plugin so every `bridge_send_message` call resets the host's idle counter — same lifetime guarantees as Telegram. See `CHANGELOG.md` for the full rationale.

### Messaging workflow

For Claude Code push:
1. Machine A's agent calls `bridge_send_message({ machine: "MacBookPro", message: "check the test results", target: "claude-code/default" })`
2. The message is written to Machine B's `~/.agent-bridge/inbox/claude-code/default/<id>.json` via SSH
3. Machine B's `agent-bridge` plugin watcher detects the new file and emits `notifications/claude/channel` into the running Claude session
4. Machine B responds via `bridge_send_message` back to Machine A with an explicit `target`

For OpenClaw push, the gateway loads `openclaw-channel/`, watches `inbox/openclaw/<target>/`, and injects inbound messages into the matching running OpenClaw/Telegram session. Codex/Gemini/Aider inbound receive/reply loops remain scaffolded until tested end-to-end; `bridge_receive_messages` is the manual Claude Code-target inbox fallback (now with long-poll support, 3.8.0+) — see "Subagent receive (long-poll)" below.

### Subagent receive (long-poll, 3.8.0+)

Channel push (`<channel source="agent-bridge" ...>`) only lands in the parent session. Subagents on either machine that need to receive a bridge reply should call `bridge_receive_messages` with:

```json
{ "wait": true, "timeout_seconds": 30, "peek": true }
```

Loop on the response: if `structuredContent.timed_out === true`, re-issue the call; otherwise inspect `structuredContent.messages` for the reply. Use `peek: true` so the parent's channel-push consumer (and any other subagents) still see the same content — `peek: false` consumes destructively and only one caller wins. Server-side timeout is capped at 60 s.

### MCP server setup

```bash
cd ~/Projects/agent-bridge/mcp-server
npm install && npm run build
```

Register in your harness's MCP configuration. For Claude Code, install the unified `agent-bridge` plugin from the local marketplace. Named Claude Code sessions set `AGENT_BRIDGE_PERSONA=<persona>`; otherwise the channel-capable Claude Code parent falls back to the `default` persona. For non-Claude harnesses (Codex, Gemini-CLI, Aider, OpenClaw), register the same MCP server without `AGENT_BRIDGE_PERSONA` so it stays tools-only and does not contend for a Claude Code persona lease:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/path/to/agent-bridge/mcp-server/build/index.js"]
    }
  }
}
```

The v3 role env vars (`AGENT_BRIDGE_ROLE`, `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`, `AGENT_BRIDGE_DISABLE_WATCHER`) were removed in 4.0.0 and have no effect. A Claude Code plugin child with `AGENT_BRIDGE_PERSONA` claims `claude-code/<persona>`; a channel-capable Claude parent without the env var claims `claude-code/default`; non-Claude/tool-only parents do not claim any Claude inbox lease.

## Troubleshooting

### SSH not enabling
On macOS, go to System Settings > General > Sharing > Remote Login and enable it manually.

### Firewall blocking connections
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Using Tailscale
If both machines are on Tailscale, use the Tailscale hostname or IP instead of the local IP. This works across networks.

### Stale chime daemon — kill all but the most recent

The fleet-aware chime service (`chime/service.mjs`) is a long-running daemon that holds a lease at `~/.agent-bridge/locks/agent-bridge-chime.lock.json`. **Only one instance should ever be running per machine.** When debugging chime issues — sounds firing twice, sounds not firing, "where is the chime even coming from?" — the first thing to check is whether multiple `service.mjs` processes are alive.

```bash
ps -axww -o pid,etime,command | grep 'agent-bridge/chime/service.mjs' | grep -v grep
```

If you see more than one PID, you have a stale duplicate. The daemon has a lease/heartbeat coordination mechanism (`acquireLease()` in `service.mjs`), but a daemon that lost the race for the lease can sit alive in a zombie state — internal Node handles keep the process from exiting cleanly even after `runService()` returns. Symptoms:

- `~/.agent-bridge/chime/chime.log` and `state.json` mtimes lag far behind real time even though `ps` says the process exists
- The unified `~/.agent-bridge/logs/agent-bridge.log` shows `chime.snapshot_sent` events from a different PID than the one currently in `ps`
- `~/.agent-bridge/locks/agent-bridge-chime.lock.json` is missing or holds a different PID than the running process

**Recovery:** kill all chime daemons but the one currently holding the lease (or kill them all and let `--ensure` respawn cleanly):

```bash
# 1. Identify the lease-holder (if any)
cat ~/.agent-bridge/locks/agent-bridge-chime.lock.json 2>/dev/null

# 2. List all running chime daemons
ps -axww -o pid,etime,command | grep 'agent-bridge/chime/service.mjs' | grep -v grep

# 3. Kill every PID that is NOT the current lease-holder. SIGTERM first; if it
#    survives 2 seconds, SIGKILL.
kill <pid>
sleep 2; ps -p <pid> 2>/dev/null && kill -9 <pid>

# 4. If you killed everything, respawn cleanly:
node ~/Projects/agent-bridge/chime/service.mjs --ensure

# 5. Verify exactly one daemon and a fresh lease:
ps -axww -o pid,command | grep 'agent-bridge/chime/service.mjs' | grep -v grep
cat ~/.agent-bridge/locks/agent-bridge-chime.lock.json
```

Do not reuse the older PID — `--ensure` checks the lease and either no-ops (if a healthy daemon is running) or spawns a fresh detached child. After respawn, `tail -f ~/.agent-bridge/logs/agent-bridge.log | jq -c 'select(.event | startswith("chime."))'` should immediately show `chime.started` followed by periodic `chime.snapshot_sent` heartbeats.

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.agent-bridge/keys/` (mode 600)
- Config is stored in `~/.agent-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.agent-bridge/` with restrictive permissions (mode 700)
