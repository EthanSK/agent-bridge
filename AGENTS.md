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

### Same-machine delivery (3.5.0+)

`bridge_send_message` accepts the **local machine name** (or one of the reserved aliases `local`, `self`, `localhost`) as its `machine` parameter. The message JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` — no SSH hop, no loopback round-trip:

```
bridge_send_message({ machine: "local",  message: "review the queue", target: "openclaw/clawdiboi2" })
```

Use this when an MCP host needs to talk to another agent harness running on the **same** machine (canonical case: a Claude Code session messaging OpenClaw embedded Telegram sessions in the same gateway). The receiver still needs a watcher running on its inbox subdir — agent-bridge just lands the file. `agent-bridge run <local>` and `agent-bridge connect <local>` are deliberately rejected: there is no SSH loopback.

`agent-bridge list` and `agent-bridge status` always show the local pseudo-machine as `LOCAL — same-machine delivery, no SSH`.

### Talk to the RUNNING remote agent

Use the channel plugin's `bridge_send_message` MCP tool. **As of mcp-server 3.4.0, the `target` parameter is required** — there is no default routing:

```
bridge_send_message({ machine: "MacBook-Pro", message: "review the code in ~/Projects/myapp and suggest improvements", target: "claude-code" })
```

Targets decide which listener on the receiving machine picks up the message:
- `"claude-code"` — Claude Code channel plugin (cross-machine Claude ↔ Claude)
- `"openclaw/<account>"` — injects into the OpenClaw Telegram session for `<account>`. If the openclaw side runs the openclaw-channel plugin ≥ 2.1.0, each account under `channels.telegram.accounts` is auto-discovered as a target, so you can address them directly without an extra `targets` block in `openclaw.json`. With the current MCP tool default, replies can route back over agent-bridge because `from_target` defaults to `claude-code`; use `one_way: true` or target/plugin `replyVia: "telegram"` when you intentionally want a visible Telegram reply.
- `"<harness>/<name>"` — any other configured harness/subdir. Target names may contain Unicode letters / digits plus `_`, `.`, `-`, `/` (no `..`, no leading/trailing `/`, no `//`, ≤256 chars).

For bidirectional flows across harnesses, set `fromTarget` (or MCP tool arg `from_target`) on outbound messages to your own target-id (e.g. `fromTarget: "openclaw/clawdiboi2"`). The Claude Code MCP tool supplies `from_target: "claude-code"` by default unless `one_way: true` is set. The receiver copies that into `reply.target` so the reply round-trips back to the session that originated it. For OpenClaw-originated sends, always use the CURRENT Telegram account's target-id (`openclaw/default`, `openclaw/clawdiboi2`, etc.) so replies stay isolated per account.

The message is pushed into the running Claude session on MacBook-Pro as a `<channel source="agent-bridge" ...>` event. Its reply comes back the same way. This is the only supported agent-to-agent communication path.

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
bridge_send_message({ machine: "MacBook-Pro", message: "review the code in ~/Projects/myapp/src/ and suggest improvements", target: "claude-code" })
```

For `target: "claude-code"`, the running remote Claude Code session receives it in-context and replies via `bridge_send_message` back to this machine. OpenClaw targets use `target: "openclaw/<account>"` and are delivered by the separate OpenClaw channel plugin.

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
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Claude Code channel plugin

When used with Claude Code, the MCP server acts as a **channel plugin**: one stdio JSON-RPC child advertises both the `bridge_*` tools and the experimental `claude/channel` capability. Incoming messages are pushed directly into the conversation as:
```
<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>
```
No polling needed in the normal channel-owner path -- respond using `bridge_send_message`.

### Messaging workflow

For Claude Code push:
1. Machine A's agent calls `bridge_send_message({ machine: "MacBookPro", message: "check the test results", target: "claude-code" })`
2. The message is written to Machine B's `~/.agent-bridge/inbox/claude-code/<id>.json` via SSH
3. Machine B's channel-owner MCP child emits `notifications/claude/channel` into the running Claude session
4. Machine B responds via `bridge_send_message` back to Machine A with an explicit `target`

For OpenClaw push, the gateway loads `openclaw-channel/`, watches `inbox/openclaw/<target>/`, and injects inbound messages into the matching running OpenClaw/Telegram session. Codex/Gemini/Aider inbound receive/reply loops remain scaffolded until tested end-to-end; `bridge_receive_messages` is only a manual Claude Code-target inbox fallback today.

### MCP server setup

```bash
cd ~/Projects/agent-bridge/mcp-server
npm install && npm run build
```

Register in your harness's MCP configuration:
```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/path/to/agent-bridge/mcp-server/build/index.js"],
      "env": { "AGENT_BRIDGE_ROLE": "tools-only" }
    }
  }
}
```

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

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.agent-bridge/keys/` (mode 600)
- Config is stored in `~/.agent-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.agent-bridge/` with restrictive permissions (mode 700)
