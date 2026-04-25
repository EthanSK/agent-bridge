# Agent Bridge Skill

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

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

For off-LAN access, use [Tailscale](https://tailscale.com) and point the paired machine's `internet_host` at its `100.x.y.z` IP (see README "Internet connectivity (Tailscale)").

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

Alternatively, they can:
- Copy the manual pairing command shown on screen
- Copy the private key file to the other machine: `scp ~/.agent-bridge/keys/agent-bridge_<name> other-machine:~/.agent-bridge/keys/`

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

> `agent-bridge run` is a plain remote-shell utility. It does NOT spawn or invoke an agent. The `--claude`, `--codex`, and `--agent` flags were removed in 3.0.0 — they ran a fresh non-interactive agent session on the remote machine, which is the opposite of what this project is for.

### Talk to the RUNNING remote agent (agent-to-agent)

Use the `bridge_send_message` MCP tool from the channel plugin:

```
bridge_send_message({
  machine: "MacBook-Pro",
  message: "fix the failing tests in ~/Projects/myapp",
  target: "claude-code"
})
```

For `target: "claude-code"`, the message is pushed into the live Claude Code session on MacBook-Pro as a `<channel source="agent-bridge" ...>` event, and the reply comes back the same way. OpenClaw targets use `target: "openclaw/<account>"` and are delivered by the separate `openclaw-channel/` plugin. In all cases, use `bridge_send_message` for agent-to-agent work — do not shell out to fresh agent wrappers.

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

## Transferring the private key

Setup generates a key pair on each machine. The private key must be on the connecting machine to authenticate. Options:
1. **Manual copy**: `scp other-machine:~/.agent-bridge/keys/agent-bridge_<name> ~/.agent-bridge/keys/`
2. **Use existing SSH keys**: If you already have SSH access, skip the key step

## Typical workflows

### "Deploy my app on the MacBook"
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### "Ask the remote agent to review my code"

From inside your agent session (with the channel plugin loaded):

```
bridge_send_message({
  machine: "MacBook-Pro",
  message: "review the code in ~/Projects/myapp/src/ and suggest improvements",
  target: "claude-code"
})
```

The running remote agent receives it in-context and replies via `bridge_send_message` back to this machine.

### "Check what's running on my other machine"
```bash
agent-bridge run MacBook-Pro "ps aux | head -20 && df -h && free -h 2>/dev/null"
```

### "Start a dev server on the MacBook"
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 &"
```

## v2: MCP Server & Channel Plugin (running agent-to-agent communication)

If the agent-bridge MCP server is configured, you have direct access to these tools without needing the CLI. The MCP server provides the shared `bridge_*` tools for EXISTING running agent sessions -- it does NOT spawn new agent processes. Claude Code push uses this MCP server's experimental `claude/channel` stdio path; OpenClaw push uses the separate native `openclaw-channel/` plugin.

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox (not needed in normal channel mode) |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Channel plugin (push mode -- Claude Code)

When used with Claude Code, the MCP server acts as a **channel plugin**: one stdio JSON-RPC child advertises both the `bridge_*` tools and the experimental `claude/channel` capability. Incoming messages from other machines are **pushed** directly into the conversation as:
```
<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>
```
No polling needed in the normal channel-owner path -- respond using `bridge_send_message`.

On startup, pending Claude Code-target messages are replayed in chronological order. This is replay-on-spawn durability, not a separate always-on daemon; live push still depends on a running Claude Code channel-owner MCP child.

### MCP server setup

```bash
cd ~/Projects/agent-bridge/mcp-server
npm install && npm run build
```

Recommended Claude Code setup is the plugin/marketplace flow in the README. If you are using a tools-only/manual MCP config, set `AGENT_BRIDGE_ROLE=tools-only`:
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

### Messaging workflow (channel mode)

1. Machine A's Claude calls `bridge_send_message({ machine: "MacBookPro", message: "check the test results", target: "claude-code" })`
2. The message is written to Machine B's `~/.agent-bridge/inbox/claude-code/<id>.json` via SSH
3. Machine B's file watcher detects the new file
4. Machine B's channel-owner MCP child pushes the message into the running Claude session
5. Machine B's Claude sees `<channel source="agent-bridge" ...>` and responds via `bridge_send_message`

All messages are authenticated via SSH keys. The channel notification includes `authenticated: ssh-key` metadata confirming the sender was verified by the SSH transport.

Messages include sender name, timestamp, content, optional reply-to ID for threading, and TTL (default 1 day, 0 = no expiry).

## Troubleshooting

### SSH not enabling
On macOS, go to System Settings > General > Sharing > Remote Login and enable it manually.

### Firewall blocking connections
```bash
# Check if firewall is on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Allow SSH through
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Can't find IP address
```bash
# Get local IP
ipconfig getifaddr en0    # Wi-Fi
ipconfig getifaddr en1    # Ethernet (or en0 on some Macs)

# Or use Tailscale
tailscale ip -4
```

### Using Tailscale
If both machines are on Tailscale, use the Tailscale hostname or IP instead of the local IP. This works across networks.

### Messages not arriving
1. Check watcher health: use `bridge_inbox_stats` tool (Claude Code target)
2. Verify SSH connectivity: `agent-bridge status <machine>`
3. Check the target inbox: `ls ~/.agent-bridge/inbox/claude-code/` or `ls ~/.agent-bridge/inbox/openclaw/default/`
4. Check archives/quarantine: `ls ~/.agent-bridge/inbox/.archive/claude-code/`, `ls ~/.agent-bridge/archive/openclaw/`, and `find ~/.agent-bridge/inbox/.failed -maxdepth 3 -type f -name '*.json'`
5. Check logs: `~/.agent-bridge/logs/mcp-server.log` (Claude Code) or `~/.openclaw/logs/gateway.log` (OpenClaw)
6. Watchers poll every 2 s — no dependencies (fswatch/inotifywait removed in 3.4.3)

## Security notes

- All communication uses SSH with key-based authentication
- Private keys are stored in `~/.agent-bridge/keys/` (mode 600)
- Config is stored in `~/.agent-bridge/config` (mode 600)
- No passwords are stored or transmitted
- All files are stored in `~/.agent-bridge/` with restrictive permissions (mode 700)
- Message content is base64-encoded for SSH transport to prevent shell injection
