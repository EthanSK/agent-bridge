# agent-bridge

**Bridge Claude Code sessions across machines. Agent-to-agent push comms over SSH.**

> ⚠️ **Tested end-to-end with Claude Code only (as of v3.0.0, 2026-04-14).** Integrations for other harnesses (Codex, Gemini CLI, OpenClaw, Aider) are scaffolded via standard MCP but haven't been exercised yet. Don't assume cross-harness parity.
>
> ⚠️ **Breaking change in 3.0.0:** the `--claude`, `--codex`, and `--agent` flags on `agent-bridge run` have been removed. Agent-to-agent communication is channel-mode only (`bridge_send_message` → inbox drop → running remote agent's context). See [CHANGELOG.md](CHANGELOG.md) for details. The plain-shell `agent-bridge run <machine> "<cmd>"` is still supported for diagnostics.

[![Claude Code](https://img.shields.io/badge/Claude_Code-channel_plugin-blueviolet)](https://github.com/EthanSK/agent-bridge)

[Website](https://ethansk.github.io/agent-bridge/) | [GitHub](https://github.com/EthanSK/agent-bridge)

---

## Quick start

Paste this into your Claude Code session on **each computer** you want to bridge:

```
Read the README at https://github.com/EthanSK/agent-bridge and follow the setup instructions
for this computer. Install agent-bridge, run the setup command, and install the Claude Code
plugin. Do everything automatically -- don't ask me questions.
```

**Prereqs (once per machine):**
- **macOS:** System Settings > General > Sharing > toggle **Remote Login** ON > click **(i)** > set **"Allow access for"** to **All users**. Optionally toggle **"Allow full disk access for remote users"**.
- **Linux:** `sudo systemctl enable --now sshd`

Then photograph the pairing screen on one machine and send it to the Claude Code session on the other. That's the pair step; the agents handle the rest.

---

## What is agent-bridge?

agent-bridge lets Claude Code sessions on different machines talk to each other agent-to-agent, and (optionally) run commands on each other's machines over SSH. Design goals:

- **Peer-to-peer** -- no central server, no cloud, direct SSH between your machines
- **Real-time push** -- remote messages arrive as `<channel source="agent-bridge">` events in the running Claude Code session, no polling needed
- **Zero dependencies** -- just bash, ssh, and node (bundled with Claude Code) -- no Docker, no services
- **MCP-based** -- speaks standard Model Context Protocol, so other agents that consume MCP can in principle use it, but only Claude Code is the day-one confirmed harness

---

## Architecture overview

```
                          agent-bridge architecture

 MACHINE A (e.g. Mac Mini)                    MACHINE B (e.g. MacBook Pro)
 ┌─────────────────────────────────┐         ┌─────────────────────────────────┐
 │                                 │         │                                 │
 │  AI Agent (Claude Code, etc.)   │         │  AI Agent (Claude Code, etc.)   │
 │  ┌───────────────────────────┐  │         │  ┌───────────────────────────┐  │
 │  │ MCP Server / Channel      │  │   SSH   │  │ MCP Server / Channel      │  │
 │  │ ┌───────────────────────┐ │  │◄───────►│  │ ┌───────────────────────┐ │  │
 │  │ │ bridge_send_message   │ │  │messages │  │ │ bridge_send_message   │ │  │
 │  │ │ bridge_run_command    │ │  │         │  │ │ bridge_run_command    │ │  │
 │  │ │ bridge_status         │ │  │         │  │ │ bridge_status         │ │  │
 │  │ │ ...                   │ │  │         │  │ │ ...                   │ │  │
 │  │ └───────────────────────┘ │  │         │  │ └───────────────────────┘ │  │
 │  │ File watcher (inbox)      │  │         │  │ File watcher (inbox)      │  │
 │  └───────────────────────────┘  │         │  └───────────────────────────┘  │
 │                                 │         │                                 │
 │  agent-bridge CLI              │         │  agent-bridge CLI              │
 │  ~/.agent-bridge/              │         │  ~/.agent-bridge/              │
 │    config, keys/, inbox/       │         │    config, keys/, inbox/       │
 └─────────────────────────────────┘         └─────────────────────────────────┘

 Both machines are PEERS -- either can run commands on the other.
 No fixed controller or target.
```

---

## Compatibility

| Agent Harness | Status | Integration |
|---------------|--------|-------------|
| **Claude Code** | ✅ **Tested end-to-end**, both machines confirmed | Channel plugin + MCP server — push-based, `<channel source="agent-bridge">` events auto-surface in the running session |
| OpenClaw | ✅ First-class channel | Native channel plugin in [`openclaw-channel/`](openclaw-channel/README.md) + MCP server |
| Codex CLI (OpenAI) | 🟡 Scaffolded, not exercised yet | MCP server + skill file at `AGENTS.md` — would poll via `bridge_receive_messages` |
| Gemini CLI | 🟡 Scaffolded, not exercised yet | MCP server + skill file at `GEMINI.md` |
| Aider / other MCP hosts | 🟡 Scaffolded, not exercised yet | MCP server + skill file at `INSTRUCTIONS.md` |

"Scaffolded" means the files exist and the MCP server is harness-agnostic by design, but nobody has verified the non-Claude harnesses actually drive it correctly. If you try one of those and it works (or doesn't), open an issue — empirical reports are welcome.

---

## What it looks like

### Step 1: Setup

Run on each machine you want to bridge:

```
$ agent-bridge setup

  +----------------------------------------------+
  |         agent-bridge  .  setup               |
  +----------------------------------------------+

  1. SSH Server
  [ok] SSH (Remote Login) is already enabled.

  2. SSH Key Pair
  Key pair generated.

  3. Pairing Token
  One-time pairing token generated.

  +====================================================================+
  |                    agent-bridge pairing                             |
  +--------------------------------------------------------------------+
  |  Machine:    MacBook-Pro                                           |
  |  User:       ethan                                                 |
  |  Local:      MacBookPro.local                                      |
  |  Local IP:   192.168.1.42                                          |
  |  Public IP:  82.45.123.67                                          |
  |  Port:       22                                                    |
  |  Token:      bridge-a7f3k9                                         |
  +--------------------------------------------------------------------+
  |  Public Key: ssh-ed25519 AAAA...long...key bridge:MacBook-Pro      |
  +====================================================================+

  Photograph this screen and send to Claude on your other machine.
```

### Step 2: Pair

On the other machine, tell the agent the connection details (or paste the manual command). The public key from the setup screen is included -- no password needed:

```
$ agent-bridge pair \
    --name "MacBook-Pro" \
    --host 192.168.1.42 \
    --port 22 \
    --user ethan \
    --token bridge-a7f3k9 \
    --pubkey "ssh-ed25519 AAAA...key bridge:MacBook-Pro"

  1. Local Key Pair
  Using existing key pair for Mac-Mini.

  2. Authorize Remote Key
  [ok] Remote public key added to ~/.ssh/authorized_keys.

  3. Token Verification
  [ok] Token accepted: bridge-a7f3k9

  [ok] Paired with "MacBook-Pro"!
```

### Step 3: Use

**Talking to the running agent on the other machine — from inside an agent session (the main use case):**

```
# From Claude Code on Machine A, the channel plugin gives you:
bridge_send_message("MacBook-Pro", "can you check whether the tests pass in ~/Projects/myapp and tell me what broke?")

# Over on MacBook-Pro, the running Claude session sees, pushed into its context:
<channel source="agent-bridge" from="Mac-Mini" message_id="msg-..." ts="...">
can you check whether the tests pass in ~/Projects/myapp and tell me what broke?
</channel>

# And it replies with bridge_send_message the same way, back to Mac-Mini.
```

**Plain remote shell — from a terminal (diagnostics only):**

```
$ agent-bridge run MacBook-Pro "uname -a"
  Running command on MacBook-Pro...
Darwin MacBookPro.local 25.3.0 Darwin Kernel Version 25.3.0...

  [ok] command completed on MacBook-Pro (exit 0)

$ agent-bridge run MacBook-Pro "cd ~/Projects/agent-bridge && git status"
  ...
```

> **Note:** `agent-bridge run` is a plain-shell utility — it does NOT invoke an agent. To talk to the running agent on the other machine, use the channel plugin's `bridge_send_message` tool (see above). The old `--claude` / `--codex` / `--agent` flags that spawned a fresh non-interactive agent session on the remote machine were removed in 3.0.0.

### Optional: Internet access via Tailscale

For cross-network connectivity (mobile data, coffee-shop wifi, different NAT), use [Tailscale](https://tailscale.com) — a mesh VPN that gives each machine a stable `100.x.y.z` IP reachable from anywhere. The recommended deployment is a **no-sudo, per-user LaunchAgent** in userspace-networking mode; see the [Internet connectivity](#internet-connectivity-tailscale) section below for the full walkthrough (plist template, SSH SOCKS5 config, auth flow).

Quick sketch (full steps below):

```bash
# On each machine:
brew install tailscale
# Create ~/Library/LaunchAgents/com.USERNAME.tailscaled.plist (see full section) and load it:
launchctl load ~/Library/LaunchAgents/com.USERNAME.tailscaled.plist
# Add Host 100.* SOCKS5 ProxyCommand to ~/.ssh/config (see full section)
tailscale --socket="$HOME/.local/share/tailscale/tailscaled.sock" up \
  --auth-key=tskey-auth-xxx --accept-dns=false --hostname=MY-MACHINE
tailscale --socket="$HOME/.local/share/tailscale/tailscaled.sock" ip -4

# Then on the paired machine, point internet_host at that IP:
agent-bridge config MY-MACHINE --internet-host 100.126.23.87
```

---

## Installation

**Zero dependencies.** Just bash, ssh, and ssh-keygen (built into every Mac and Linux).

### Option A: One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.sh | bash
```

### Option B: Clone and symlink

```bash
git clone https://github.com/EthanSK/agent-bridge.git
cd agent-bridge
chmod +x agent-bridge
sudo ln -sf "$(pwd)/agent-bridge" /usr/local/bin/agent-bridge
```

### Option C: Just download the script

```bash
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/agent-bridge -o /usr/local/bin/agent-bridge
chmod +x /usr/local/bin/agent-bridge
```

---

## Setup guide

### On each machine you want to bridge:

```bash
agent-bridge setup
```

This will:
- Enable SSH (Remote Login) if not already on
- Generate an SSH key pair
- Display a pairing screen with connection details

For internet access across networks, use Tailscale (see [Internet connectivity](#internet-connectivity-tailscale) below).

### Pair the machines:

**Option A: Photo pairing (the magic way)**
1. Take a photo of one machine's pairing screen
2. Send it to the agent on the other machine (via Telegram, chat, etc.)
3. The agent reads the image, extracts the details, and runs the pair command

**Option B: Manual pairing**
```bash
agent-bridge pair \
  --name "MacBook-Pro" \
  --host 192.168.1.50 \
  --port 22 \
  --user ethan \
  --token bridge-a7f3k9 \
  --pubkey "ssh-ed25519 AAAA...key bridge:MacBook-Pro"
```

**Option C: Interactive pairing**
```bash
agent-bridge pair
# Follow the prompts
```

### Test the connection:

```bash
agent-bridge status MacBook-Pro
agent-bridge run MacBook-Pro "uname -a"
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `agent-bridge setup` | Enables SSH, generates keys, and displays a pairing screen. |
| `agent-bridge pair` | Interactive or flag-based pairing to connect to another machine. |
| `agent-bridge config <machine>` | View or set machine config (e.g. `--internet-host`, `--internet-port`). |
| `agent-bridge connect <machine>` | Open an interactive SSH session. |
| `agent-bridge status [machine]` | Check if machine(s) are reachable. Uses the [path cache](#path-cache-lan-vs-internet); add `--probe`/`--fresh` to force a LAN-first re-probe. |
| `agent-bridge list` | List all paired machines (shows internet_host if set). |
| `agent-bridge run <machine> "cmd"` | Run a PLAIN shell command on a paired machine (diagnostics only — no agent wrapping). |
| `agent-bridge reset-path <machine>` | Clear the cached LAN/internet path for a machine (or `--all`). See [Path cache](#path-cache-lan-vs-internet). |
| `agent-bridge unpair <machine>` | Remove a pairing. |

> To talk to the **running agent** on the other machine, use the channel plugin's `bridge_send_message` MCP tool. `agent-bridge run` does not spawn agents. The old `--claude` / `--codex` / `--agent` flags were removed in 3.0.0.

### Setup options

```
-n, --name <name>   Machine name (defaults to hostname)
-p, --port <port>   SSH port (default: 22)
```

For internet access across networks, use Tailscale instead of a tunnel in setup — see [Internet connectivity (Tailscale)](#internet-connectivity-tailscale).

### Config options

```
agent-bridge config <machine> [OPTIONS]

--internet-host <host>   Set the internet-reachable hostname or Tailscale IP (e.g. 100.126.23.86)
--internet-port <port>   Set the internet-reachable SSH port (default: 22)
```

### Pair options

```
-n, --name <name>        Machine name (defaults to host)
-H, --host <host>        Hostname or IP of the other machine
-u, --user <user>        SSH username
-p, --port <port>        SSH port (default: 22)
-k, --key <key>          Path to SSH private key (override)
-t, --token <token>      Pairing token from setup screen
    --pubkey <key>       Public key from the other machine's setup screen
```

---

## MCP Server (v2): real-time agent-to-agent communication

v2 adds an MCP server that enables running AI agent sessions to communicate directly with each other across machines. Instead of one-shot CLI commands, agents can send messages back and forth in real time.

**v2.2.0** includes a **channel plugin** for Claude Code. Harnesses that support the `claude/channel` experimental capability receive messages **pushed** into the conversation automatically. All other harnesses use the same MCP tools but **poll** with `bridge_receive_messages`.

### Push vs polling

| Delivery mode | How it works | Harness support |
|---------------|--------------|-----------------|
| **Push** (channel) | Incoming messages are pushed into the conversation as `<channel source="agent-bridge" ...>` tags. No polling needed. | Claude Code (channel plugin), OpenClaw ([channel plugin](openclaw-channel/README.md)) |
| **Polling** | Agent calls `bridge_receive_messages` periodically to check the inbox. | Codex, Gemini CLI, any MCP client |

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH (single or all) |
| `bridge_send_message` | Send a message to a running agent on another machine |
| `bridge_receive_messages` | Check for and consume incoming messages (not needed in push mode) |
| `bridge_run_command` | Run a shell command on a remote machine via SSH |
| `bridge_clear_inbox` | Clear all messages from the local inbox |
| `bridge_inbox_stats` | Get inbox statistics: pending count, oldest message age, watcher health, etc. |

> **Note:** The MCP server does NOT spawn new agent processes. It enables _existing running_ agent sessions to communicate. Machine A's agent sends a message to Machine B's inbox, and Machine B's already-running agent picks it up via channel push (Claude Code) or `bridge_receive_messages` (all other harnesses).

### Building the MCP server

All harness setups below require building the MCP server first:

```bash
cd /path/to/agent-bridge/mcp-server
npm install
npm run build
```

This produces `mcp-server/build/index.js` -- the entry point every harness registration points to.

---

## Per-harness setup

### Claude Code (channel plugin -- full push support)

Claude Code connects to agent-bridge as a single Claude Code **plugin** that bundles BOTH the MCP server (outgoing `bridge_*` tools) AND the channel (incoming push of remote messages). One install gives you both halves — no `.mcp.json` editing needed.

> ⚠️ **You still need `--dangerously-load-development-channels`.** Because the marketplace is a local directory, Claude Code's channel allowlist treats it as a dev channel and will reject it on launch with: `plugin agent-bridge@agent-bridge is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`. The flag is required until the plugin is published through an official marketplace Claude Code's allowlist trusts. Leave it in your launch alias.

**Recommended install (one machine):**

```bash
# 1. Clone the repo and build the MCP server once
git clone https://github.com/EthanSK/agent-bridge.git ~/Projects/agent-bridge
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build

# 2. Add the repo as a local Claude Code marketplace and install the plugin
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

Verify with `claude plugin list` — you should see `agent-bridge@agent-bridge   Status: ✔ enabled`. Restart any running `claude` session to pick up the plugin.

**Launch alias (both halves + dev-channel flag):**

```bash
alias claude-tel='claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels plugin:agent-bridge@agent-bridge'
```

> **Important:** `--dangerously-load-development-channels` takes a **tagged argument** (`plugin:<name>@<marketplace>` for an installed-plugin channel, or `server:<name>` for a raw MCP server) and does **both jobs in one entry**: activates the channel AND marks it as allowlist-exempt. **Do NOT also add `--channels plugin:agent-bridge@agent-bridge`** on top of it — that creates a second entry with `dev:false` that fails the allowlist check and you're back to the original error. Passing the flag bare (no tag) also fails: `--dangerously-load-development-channels entries must be tagged: --channels plugin:<name>@<marketplace> | server:<name>`.

**Why the flag is still required:** Earlier versions of this doc claimed the plugin install removed the need for `--dangerously-load-development-channels`. That was wrong. Claude Code's channel allowlist gates on the marketplace's trust status, not just whether the plugin is installed. A **local directory marketplace** is by definition a dev source, so the allowlist rejects channels from it without the flag. The flag becomes unnecessary only once the plugin is published through an official marketplace Claude Code trusts.

**How it works:**
1. The plugin's `.mcp.json` registers a single `agent-bridge` MCP server.
2. That server declares the `claude/channel` experimental capability AND the `bridge_*` tools.
3. When a message arrives in `~/.agent-bridge/inbox/`, the file watcher pushes it via `notifications/claude/channel`.
4. It appears in the conversation as: `<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>`.
5. Respond using `bridge_send_message` — no need to call `bridge_receive_messages`.

The bash `agent-bridge` CLI (used for `pair`, `list`, `status`, `run`, `connect`) coexists with the plugin and is still installed via `./install.sh`.

**How it works:**
1. The MCP server declares the `claude/channel` experimental capability
2. When a message arrives in the inbox, the file watcher pushes it via `notifications/claude/channel`
3. It appears as: `<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>`
4. Respond using `bridge_send_message` -- no need to call `bridge_receive_messages`

**Install the skill:**
```bash
mkdir -p ~/.claude/skills/agent-bridge
cp skills/bridge/skill.md ~/.claude/skills/agent-bridge/skill.md
```

**For remote-only access** (connecting to a remote machine's MCP server via SSH):

```json
{
  "mcpServers": {
    "remote-macbook": {
      "command": "ssh",
      "args": [
        "-i", "~/.agent-bridge/keys/agent-bridge_Mac-Mini",
        "user@192.168.1.208",
        "node ~/Projects/agent-bridge/mcp-server/build/index.js"
      ]
    }
  }
}
```

### OpenClaw (MCP server + channel plugin -- push support)

OpenClaw connects to agent-bridge as both an MCP server (for tools) and, optionally, an OpenClaw plugin or standalone daemon (for push delivery). Without the plugin/daemon, messages are polled; with it, messages arrive as a new user turn automatically — equivalent to the Claude Code channel plugin.

**Step 1 -- MCP server (gives you bridge tools):**
```bash
openclaw mcp set agent-bridge '{"command":"node","args":["/absolute/path/to/agent-bridge/mcp-server/build/index.js"]}'
```

**Step 2 -- install the skill:**
```bash
cp -r skills/openclaw ~/.openclaw/workspace/skills/agent-bridge
```

**Step 3 -- enable push delivery (pick one):**

Install the native OpenClaw channel plugin (`openclaw-channel/`):
```json
// ~/.openclaw/openclaw.json
{
  "channels": {
    "agent-bridge": { "enabled": true }
  },
  "plugins": {
    "load": {
      "paths": [ "/absolute/path/to/agent-bridge/openclaw-channel" ]
    }
  }
}
```
Registers `agent-bridge` as a first-class OpenClaw channel (same tier as Telegram) via `api.registerChannel()`. Inbound messages dispatch through `enqueueSystemEvent` from the plugin-sdk — no CLI shell-out, no scanner bypass. Outbound replies SCP a `BridgeMessage` back to the sender. See [`openclaw-channel/README.md`](openclaw-channel/README.md) and [`openclaw-channel/ARCHITECTURE.md`](openclaw-channel/ARCHITECTURE.md).

> **Migrating from v1.3.0 (`openclaw-plugin/`)?** That extension plugin has been removed as of v2.0.0. Delete any `plugins.entries["agent-bridge"]` block from your config and point `plugins.load.paths` at the new `openclaw-channel/` directory. The gateway hot-reloads on config change.

**How OpenClaw push delivery works:**
1. Peer's `bridge_send_message` writes a JSON file to `~/.agent-bridge/inbox/` via SSH
2. The channel plugin's file watcher sees the new file
3. The plugin calls `enqueueSystemEvent` to push a `<channel source="agent-bridge" ...>` block into the running agent session
4. When the agent replies via the channel's outbound adapter, the plugin SCPs a reply `BridgeMessage` back to the sender's inbox

### Codex (OpenAI) (MCP server -- polling)

```bash
codex mcp add agent-bridge -- node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Codex automatically reads `AGENTS.md` from the repo root for bridge CLI instructions.

### Gemini CLI (MCP server -- polling)

```bash
gemini mcp add agent-bridge node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Gemini CLI automatically reads `GEMINI.md` from the repo root.

### General (any MCP-compatible agent)

Register the server using your harness's MCP configuration mechanism, pointing to:
```
node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

For **push** notifications, the harness must support the `claude/channel` experimental capability (currently only Claude Code). Without push, agents poll with `bridge_receive_messages`. Reference `INSTRUCTIONS.md` for a plain-English description of all commands.

---

## How messaging works

### Send flow

```
1. Agent calls bridge_send_message("MacBookPro", "check the test results")
2. MCP server creates a JSON message file with UUID, timestamp, TTL
3. The message is delivered to the remote machine's ~/.agent-bridge/inbox/ via SSH
4. A copy is saved locally in ~/.agent-bridge/outbox/ for tracking
```

### Receive flow (push mode -- Claude Code)

```
1. File watcher (fswatch/inotifywait/polling) detects new .json file in inbox/
2. Watcher parses the message and checks the .delivered tracker for dedup
3. Channel notification is pushed via notifications/claude/channel
4. Message appears in Claude's conversation as <channel source="agent-bridge" ...>content</channel>
5. Message ID is recorded in .delivered to prevent re-delivery on restart
```

### Receive flow (push mode -- OpenClaw plugin/daemon, v1.2.0+)

```
1. File watcher (fswatch/inotifywait/polling) detects new .json file in inbox/
2. Watcher parses the message and checks .openclaw-delivered for dedup
3. Plugin resolves per-message routing (msg.route / @@route header / plugin defaults)
4. Plugin dispatches per `deliveryMode`:
   - log-only: parse + archive only
   - message-send: `openclaw message send --channel <ch> --account <acc> --target <chat>`
   - agent-turn: `openclaw agent --agent <id> --message <env> --deliver --reply-channel <ch> --reply-account <acc> --reply-to <chat>`
5. On success, message ID is recorded in .openclaw-delivered and the file is moved to inbox/.openclaw-delivered/ to prevent re-delivery on restart
```

### Receive flow (polling mode -- Codex, Gemini, etc.)

```
1. File watcher detects new .json file in inbox/ and updates internal cache
2. Agent calls bridge_receive_messages at natural breakpoints
3. Messages are returned sorted chronologically, deduplicated, TTL-checked
4. Consumed messages are deleted from inbox/ and their IDs tracked in .processed
```

### Offline recovery

Messages persist in `~/.agent-bridge/inbox/` as JSON files until consumed or expired (default TTL: 1 hour). This means messages are never lost if the agent is temporarily unavailable. On MCP server startup:

1. The inbox is scanned for any messages not yet marked in `.delivered`
2. Undelivered messages are replayed as channel notifications in chronological order
3. This happens after `server.connect()` so notifications can actually be delivered

The `.delivered` tracker file (`~/.agent-bridge/inbox/.delivered`) prevents duplicate notifications across MCP server restarts.

---

## Message format

Messages are JSON files stored in `~/.agent-bridge/inbox/`:

```json
{
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "The tests are passing now. I fixed the import path in utils.ts.",
  "timestamp": "2026-04-13T01:15:00.000Z",
  "replyTo": null,
  "ttl": 3600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID (`msg-` prefix + UUID) |
| `from` | string | Sender machine name |
| `to` | string | Target machine name |
| `type` | `"message"` / `"command"` / `"response"` | Message type |
| `content` | string | The message body |
| `timestamp` | string | ISO 8601 creation time |
| `replyTo` | string or null | Message ID this is a reply to (for threading) |
| `ttl` | number | Time-to-live in seconds. `0` = no expiry. Default: `3600` (1 hour) |

---

## How messaging looks (diagrams)

### Push mode (Claude Code to Claude Code)

```
Machine A (Claude Code)                   Machine B (Claude Code)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  ~/.agent-bridge/inbox/ │
│ ("MacBookPro", "hello") │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│                         │               │ file watcher ──> push   │
│                         │               │ <channel ...>hello      │
│                         │               │                         │
│ <channel ...>hi back    │    SSH        │ bridge_send_message     │
│ (pushed automatically)  │<──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

### Polling mode (Codex/OpenClaw/Gemini to any harness)

```
Machine A (Codex)                         Machine B (any harness)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  ~/.agent-bridge/inbox/ │
│ ("MacBookPro", "hello") │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│ bridge_receive_messages │    SSH        │ bridge_send_message     │
│ -> polls & returns msgs │<──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

---

## Directory structure

```
~/.agent-bridge/
├── config               # Paired machines (INI-style key-value)
├── machine-name         # Optional: override local machine name
├── .pending-token       # One-time pairing token (deleted after use)
├── inbox/               # Incoming messages from other machines
│   ├── msg-uuid.json    # Pending message files
│   ├── .processed       # Consumed message IDs (dedup tracker)
│   ├── .delivered        # Channel-delivered message IDs (push dedup)
│   └── .failed/         # Quarantined malformed messages
├── outbox/              # Copies of sent messages (local tracking)
├── logs/                # MCP server logs
│   └── mcp-server.log
└── keys/                # SSH key pairs (ED25519)
    ├── agent-bridge_MacBook-Pro
    └── agent-bridge_MacBook-Pro.pub
```

### Config format

Simple INI-style flat file -- no JSON, no YAML:

```ini
[MacBook-Pro]
host=192.168.1.50
internet_host=100.126.23.87
internet_port=22
user=ethan
port=22
key=~/.agent-bridge/keys/agent-bridge_MacBook-Pro
paired_at=2026-04-09T12:00:00Z
```

`internet_host` and `internet_port` are optional. When present, SSH/SCP tries `host:port` first (3s timeout), then falls back to `internet_host:internet_port`. The recommended `internet_host` value is a [Tailscale](#internet-connectivity-tailscale) `100.x.y.z` IP.

---

## How pairing works

1. Each machine runs `setup` which generates an ED25519 key pair
2. The public key is added to `~/.ssh/authorized_keys` on that machine
3. A one-time pairing token is generated and displayed on screen
4. The pairing screen displays all connection info (local IP, public IP, token, public key)
5. The other machine reads the pairing info (from photo or manual entry)
6. `pair` adds the other machine's public key to the LOCAL `~/.ssh/authorized_keys`
7. This authorizes the other machine to SSH into this one -- no password needed
8. For bidirectional access, both machines run `pair` with each other's details
9. No SSH connection is made during pairing -- it's pure local key exchange

### How remote execution works

```
Machine A                               Machine B
---------                              ---------
agent-bridge run MacBook "cmd"
  |-> SSH connect (key auth)  --------> sshd
      |-> exec "cmd"         --------> shell
      |-> capture stdout/err  <-------- output
      |-> display result
```

For agent-to-agent communication (channel mode — the only supported path):
```
Claude on Machine A                             Claude on Machine B
-------------------                             -------------------
bridge_send_message("MacBook", "fix the tests")
  |-> SSH writes JSON to ~/.agent-bridge/inbox/ on MacBook
      |-> file watcher on MacBook picks it up
          |-> channel plugin pushes it into MacBook's RUNNING
              Claude session as <channel source="agent-bridge" ...>
              |-> MacBook's Claude reads it in-context and replies via
                  bridge_send_message back to Mac-Mini
```

No fresh agent is spawned on the remote machine — the message lands in the context of the already-running session. This is the whole point of the project. If you want the equivalent of the old `--claude` flag, you don't — use `bridge_send_message` and let the existing remote session handle it.

---

## Message routing / targets

As of **mcp-server 3.4.0** and **openclaw-channel 2.1.0**, every bridge message must be addressed to a specific routing **target**. The target decides which inbox subdir on the receiver the message lands in, and therefore which listener picks it up and which agent session it gets injected into.

```
~/.agent-bridge/inbox/
├── claude-code/              ← Claude Code's channel plugin watches ONLY this
├── openclaw/
│   ├── default/              ← OpenClaw @ClawdStationMiniBot session
│   ├── clawdiboi2/           ← OpenClaw @Clawdiboi2bot session
│   └── clordlethird/         ← OpenClaw @ClordLeThirdBot session
├── .archive/<target>/        ← delivered messages kept for debug tail
├── .failed/<target>/         ← malformed messages, quarantined per target
└── .failed/_unrouted/        ← messages with no `target` or no matching subdir
```

**Calling `bridge_send_message`:**

```jsonc
// Talk to Claude Code on the other machine (cross-machine agent-to-agent):
bridge_send_message({ machine: "Mac-Mini", message: "hi", target: "claude-code" })

// Inject into the OpenClaw @Clawdiboi2bot Telegram session:
// reply goes back to the Telegram chat, NOT over the bridge
bridge_send_message({ machine: "Mac-Mini", message: "what's up?", target: "openclaw/clawdiboi2" })
```

There is **no default routing** — a call without `target` is rejected. Legacy flat files that arrive at the root of `inbox/` (from pre-3.4.0 senders) are moved to `.failed/_unrouted/` on next startup with a deprecation log line. Upgrade your senders.

**OpenClaw target mapping** lives in `openclaw.json`:

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

Each entry resolves to an OpenClaw session key of the form `agent:<agentId>:<openclaw_channel>:<account>:direct:<peer_id>`. The openclaw-channel plugin uses that key with `enqueueSystemEvent(body, { sessionKey, trusted: false })` to inject the message into the already-running agent session. Replies travel over whatever channel the session was last talking on (usually the originating Telegram chat) instead of spawning a new `agent-bridge` channel.

Listeners are independent processes: Claude Code's channel plugin and the OpenClaw gateway watch their own subdirs. One crashing doesn't affect the other.

---

## Inbox management

The MCP server includes production-grade inbox management:

| Feature | Description |
|---------|-------------|
| **TTL expiry** | Messages expire after their TTL (default 1 hour). TTL `0` = no expiry. |
| **Max-age pruning** | Messages older than 24 hours are pruned regardless of TTL (configurable). |
| **Max inbox size** | Inbox is capped at 100 messages; oldest are pruned first (configurable). |
| **Deduplication** | Processed message IDs are tracked in `.processed`; duplicates are skipped. |
| **Malformed quarantine** | Invalid JSON files are moved to `.failed/` instead of blocking the inbox. |
| **Periodic pruning** | A background timer runs every 5 minutes to clean up expired messages. |
| **File rotation** | The `.processed` and `.delivered` tracker files are rotated when they exceed 512 KB. |

### Environment variable overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_DEFAULT_TTL` | `3600` | Default message TTL in seconds |
| `BRIDGE_PRUNE_MAX_AGE_MS` | `86400000` | Max message age in milliseconds (24h) |
| `BRIDGE_PRUNE_MAX_INBOX` | `100` | Max inbox message count |
| `BRIDGE_PRUNE_INTERVAL_MS` | `300000` | Prune interval in milliseconds (5 min) |

---

## Debugging & logs

> **Before investigating any agent-bridge issue, tail the unified event log first.**

agent-bridge ships a single structured event log that every component writes to: the MCP server and the bash CLI. This is the first thing you (or an AI agent debugging a problem) should look at. It replaces the old "grep three different files" dance. (The OpenClaw channel plugin emits through `api.logger`, which lands in the gateway log — see below.)

| Path | Format | Written by |
|---|---|---|
| `~/.agent-bridge/logs/agent-bridge.log` | NDJSON (one JSON object per line) | mcp-server, CLI |
| `~/.agent-bridge/logs/agent-bridge.log.1` | previous rotation (renamed when > 50 MB) | same |
| `~/.agent-bridge/logs/mcp-server.log` | plain-text, very verbose | mcp-server (kept for deep dives) |
| `~/.openclaw/logs/gateway.log` | plain-text | OpenClaw host (including the agent-bridge channel plugin's `api.logger` output) |

Every NDJSON line has this shape:

```json
{
  "ts": "2026-04-19T23:45:00.123Z",
  "component": "mcp-server",
  "machine": "Ethans-MacBook-Pro",
  "event": "message.delivered",
  "level": "info",
  "msg": "Message msg-abc123 delivered to Mac-Mini",
  "context": { "msg_id": "msg-abc123", "to": "Mac-Mini", "host": "100.x.y.z", "type": "message" }
}
```

### Useful `jq` queries

```bash
# Pretty-print the last 50 events
tail -50 ~/.agent-bridge/logs/agent-bridge.log | jq -s '.'

# Only errors / warnings
jq -c 'select(.level == "error" or .level == "warn")' ~/.agent-bridge/logs/agent-bridge.log

# Follow one specific message end-to-end (send → delivered → pushed)
jq -c 'select(.context.msg_id == "msg-abc123")' ~/.agent-bridge/logs/agent-bridge.log

# Just watcher lifecycle
jq -c 'select(.event | startswith("watcher."))' ~/.agent-bridge/logs/agent-bridge.log

# Only this component
jq -c 'select(.component == "mcp-server")' ~/.agent-bridge/logs/agent-bridge.log

# Live tail, formatted
tail -f ~/.agent-bridge/logs/agent-bridge.log | jq -c '"\(.ts) [\(.component)] \(.event) — \(.msg)"'
```

### Event vocabulary (high-signal subset)

| Event | Who emits | When |
|---|---|---|
| `server.starting` / `server.ready` / `server.shutdown` | mcp-server | MCP lifecycle |
| `watcher.started` / `watcher.stopped` | mcp-server | fswatch/inotifywait/polling up or down |
| `message.received` | mcp-server | inbox file picked up by the watcher |
| `message.pushed_to_channel` | mcp-server | message pushed into the running Claude session |
| `message.push_failed` | mcp-server | channel notification failed |
| `message.send_start` / `message.send_retry` / `message.delivered` / `message.send_failed` | mcp-server | outbound SSH delivery to a remote inbox |
| `tool.bridge_status` / `tool.bridge_run_command` | mcp-server | MCP tool invocation |
| `cli.pair.done` / `cli.unpair.done` / `cli.run.start` / `cli.run.done` / `cli.run.failed` / `cli.status.online` / `cli.status.offline` | CLI | bash subcommands |

### Safety

- **Secrets are redacted** on the way in: known OpenAI/Anthropic/Slack/GitHub/AWS/Bearer/JWT patterns become `[REDACTED]`. Message *content* is never put in `context` — only metadata (id, from, to, length).
- Each context string is truncated to ~2000 chars so a single oversized payload can't bloat the log.
- Writes are POSIX `O_APPEND` — multiple processes can write the same log concurrently (mcp-server + plugin both write to it) without corrupting lines, subject to the PIPE_BUF atomic-append guarantee.
- Rotation is simple: file > 50 MB → rename to `.log.1`, start a fresh one. No gzip, no multi-generation history.

See [AGENTS.md](AGENTS.md) for the "first thing an agent does when debugging" checklist.

---

## Security

- **SSH key-based auth only** -- zero passwords in the entire flow
- **ED25519 keys** -- modern, fast, secure
- **Restrictive file permissions** -- config dir is mode 700, keys are mode 600
- **No cloud** -- all communication is direct SSH, no third-party servers
- **Separate config** -- stored in `~/.agent-bridge/`, not in `.claude/` to avoid accidental git commits
- **Base64 transport** -- message content is base64-encoded for SSH delivery to prevent shell injection

### Recommendations

- Use **Tailscale** for cross-network connections (avoids exposing SSH to the internet)
- Enable macOS **Firewall** and only allow SSH
- Regularly rotate keys with `agent-bridge unpair` + re-setup
- Review `~/.ssh/authorized_keys` periodically

---

## Internet connectivity (Tailscale)

When two machines are not on the same LAN (e.g. one is on mobile data, at a coffee shop, or behind a different NAT), use [Tailscale](https://tailscale.com) to give each machine a stable `100.x.y.z` IP that's reachable from anywhere. Agent-bridge stores that IP as the `internet_host` for the paired machine and falls back to it when the LAN address isn't reachable.

### How agent-bridge uses `internet_host`

Each machine can have two endpoints in its config:

```ini
[MacBookPro]
host=192.168.1.208            # LAN address (primary)
internet_host=100.126.23.87   # Tailscale IP (fallback)
internet_port=22
port=22
user=ethansarif-kattan
key=/Users/ethansk/.agent-bridge/keys/agent-bridge_Mac-Mini
paired_at=2026-04-13T00:03:01Z
```

When SSH/SCP connects to a machine, it picks the path to try first based on the [path cache](#path-cache-lan-vs-internet): if a recent successful connection is known, that path is tried first (LAN 3s timeout, internet 10s); otherwise it starts with LAN. On failure, the other path is tried. If both fail, a clear error is reported. This fallback applies to the bash CLI (`run`, `connect`, `status`) and the MCP server (`sshExec`, `sshWriteFile`, `sshPing`).

### Tailscale setup

The recommended deployment is a **no-sudo, per-user LaunchAgent** running `tailscaled` in userspace-networking mode. No root is required on install, start, or teardown — the daemon lives entirely in your user session. This is the recommended agent-bridge setup and what these instructions describe first; you'll build the LaunchAgent by hand using the template below (agent-bridge doesn't bundle or auto-install it).

If you'd rather have tailnet traffic "just work" for every app on the machine (curl, git, browsers all reaching tailnet peers without proxy config), see [Alternative: kernel-TUN mode](#alternative-kernel-tun-mode-sudo) at the end of this section.

#### 1. Install the Tailscale CLI

No GUI needed:

```bash
brew install tailscale
```

This installs `tailscale` and `tailscaled` binaries but does **not** start anything.

#### 2. Start `tailscaled` as a user LaunchAgent (no sudo)

Create `~/Library/LaunchAgents/com.USERNAME.tailscaled.plist` — replace `USERNAME` with your macOS short username (`whoami`) and replace both `/Users/USERNAME/...` paths with your actual `$HOME`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.USERNAME.tailscaled</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/sbin/tailscaled</string>
        <string>--tun=userspace-networking</string>
        <string>--socket=/Users/USERNAME/.local/share/tailscale/tailscaled.sock</string>
        <string>--socks5-server=localhost:1055</string>
        <string>--statedir=/Users/USERNAME/.local/share/tailscale</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/.local/share/tailscale/tailscaled.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/.local/share/tailscale/tailscaled.err.log</string>
</dict>
</plist>
```

On Intel Macs, swap `/opt/homebrew/sbin/tailscaled` for `/usr/local/sbin/tailscaled`. Create the state dir and load the agent:

```bash
mkdir -p "$HOME/.local/share/tailscale"
launchctl load ~/Library/LaunchAgents/com.USERNAME.tailscaled.plist
```

What this gives you:
- `tailscaled` runs under your user — no `sudo`, no root daemon, nothing in `/var/run`.
- **Userspace networking** (`--tun=userspace-networking`) means there's no kernel TUN device. Other peers on your tailnet can still SSH *in* to this machine via its `100.x.y.z` IP (inbound works fine), but outbound tailnet traffic initiated from this machine goes through the built-in SOCKS5 proxy on `localhost:1055` instead of a routing table.
- The daemon's control socket lives at `~/.local/share/tailscale/tailscaled.sock` instead of the default root-owned `/var/run/tailscaled.socket`.

#### 3. Configure `~/.ssh/config` for the SOCKS5 proxy (CRITICAL)

Because this machine uses userspace networking, outbound SSH to any tailnet peer (`100.x.y.z`) has to traverse the SOCKS5 proxy. Without this block, `agent-bridge run` / `agent-bridge connect` / `ssh 100.x.y.z` will hang or fail. Add to `~/.ssh/config`:

```
Host 100.*
    ProxyCommand nc -X 5 -x localhost:1055 %h %p
    ServerAliveInterval 60
```

`nc -X 5 -x localhost:1055 %h %p` tells `ssh` to dial the target host/port through the local SOCKS5 proxy. `ServerAliveInterval 60` keeps the tunnel warm. This applies to every outbound SSH that targets a `100.*` address — including the ones agent-bridge makes.

#### 4. Use the CLI via your user socket

Because `tailscaled` is listening on a user socket (not the default one), every `tailscale` CLI call has to specify `--socket`. Either pass it explicitly:

```bash
tailscale --socket="$HOME/.local/share/tailscale/tailscaled.sock" status
```

…or add a shell alias so you don't have to think about it:

```bash
alias tailscale="tailscale --socket=$HOME/.local/share/tailscale/tailscaled.sock"
```

Put the alias in your `~/.zshrc` (or `~/.bashrc`) so it survives reboot.

#### 5. Authenticate

Visit <https://login.tailscale.com/admin/settings/keys> and click **Generate auth key**. Set **Reusable: true**, **Ephemeral: false**, **Expiry: 90 days**, no tags. Copy the `tskey-auth-...` string.

Then bring the node up — no `sudo`, since the daemon is already running under your user:

```bash
tailscale --socket="$HOME/.local/share/tailscale/tailscaled.sock" up \
  --auth-key=tskey-auth-xxxxxxxxxxxxxxxxxxxxxxxx \
  --accept-dns=false \
  --accept-routes=false \
  --advertise-routes= \
  --hostname=MY-MACHINE
```

Replace `MY-MACHINE` with whatever hostname you want to show up in the Tailscale admin panel (letters, digits, hyphens only). If you set up the alias from step 4, drop the `--socket=...` prefix.

#### 6. Get the assigned IP

```bash
tailscale --socket="$HOME/.local/share/tailscale/tailscaled.sock" ip -4
# e.g. 100.126.23.86
```

### Tell the paired machines

On the *other* machine, point its agent-bridge config at the new Tailscale IP:

```bash
agent-bridge config MacBookPro --internet-host 100.126.23.87
```

Or edit `~/.agent-bridge/config` directly:

```ini
[MacBookPro]
...
internet_host=100.126.23.87
internet_port=22
```

### Verify

```bash
agent-bridge status MacBookPro     # should reach via LAN or fall back to Tailscale
ssh -i ~/.agent-bridge/keys/agent-bridge_Mac-Mini ethansarif-kattan@100.126.23.87
```

The host key you see should be the target machine's real sshd host key — not Tailscale's — since Tailscale routes raw TCP and doesn't proxy SSH. The SOCKS5 proxy from step 3 is doing the work: `ssh` dials `100.126.23.87:22`, `nc -X 5` funnels that through `localhost:1055`, and `tailscaled` routes it across the tailnet to the peer's sshd on the other end.

### Teardown

To stop Tailscale on a machine — no `sudo` needed:

```bash
# Unload the LaunchAgent and remove the plist
launchctl unload ~/Library/LaunchAgents/com.USERNAME.tailscaled.plist
rm ~/Library/LaunchAgents/com.USERNAME.tailscaled.plist

# Optionally remove state
rm -rf "$HOME/.local/share/tailscale"
```

Then remove the machine from the tailnet in the [Tailscale admin panel](https://login.tailscale.com/admin/machines) (select the machine → `…` → **Remove**). That deauthorises it and drops the `100.x.y.z` assignment.

You can also drop the `~/.ssh/config` block from step 3 if this was the only tailnet peer you were reaching.

### Trade-off: userspace vs kernel-TUN

Userspace-networking is agent-bridge-sufficient: the single outbound SSH hop is handled by the `~/.ssh/config` SOCKS5 block, and inbound SSH from other tailnet peers works natively. The trade-off is that **other apps on this machine won't reach tailnet peers unless they're explicitly configured to use the SOCKS5 proxy** (`curl --socks5-hostname localhost:1055`, `git -c http.proxy=socks5h://localhost:1055 …`, browser proxy settings, etc.). If that's fine for your use case — and for most agent-bridge-only deployments it is — stop here.

### Alternative: kernel-TUN mode (sudo)

If you want tailnet to "just work" for every app on the machine without per-app SOCKS5 configuration, run Tailscale the standard way via Homebrew's root-launched service:

```bash
sudo brew services start tailscale                       # launches tailscaled as root on a kernel TUN
sudo tailscale up \
  --auth-key=tskey-auth-xxxxxxxxxxxxxxxxxxxxxxxx \
  --accept-dns=false \
  --accept-routes=false \
  --hostname=MY-MACHINE
tailscale ip -4                                           # note the 100.x.y.z
```

Teardown:

```bash
sudo tailscale down
sudo brew services stop tailscale
```

With kernel-TUN mode, drop the `Host 100.*` block from `~/.ssh/config` (it's unnecessary — the kernel routes `100.x.y.z` natively) and skip the `--socket=...` CLI prefix (the daemon uses the default socket at `/var/run/tailscaled.socket`, which the CLI finds automatically).

---

## Path cache (LAN vs internet)

When a machine has both a LAN `host` and an `internet_host` configured, every SSH/ops call is a race between the two. Historically agent-bridge always tried LAN first (3s timeout) and only fell back to the internet path on failure — fine on the same wifi, but ~3 seconds of wasted time on every off-network call.

As of **v3.1.0**, agent-bridge keeps a tiny per-machine cache of which path last worked:

```json
// ~/.agent-bridge/path-cache.json  (mode 0600)
{
  "Mac-Mini":   { "path": "internet", "ts": 1776473474, "last_success": 1776473474 },
  "MacBookPro": { "path": "lan",      "ts": 1776473400, "last_success": 1776473400 }
}
```

### Behavior

- **Fresh entry (< 1h since `last_success`)** → try the cached path first, fall back to the other on connection failure (SSH exit 255).
- **Stale or missing entry (> 1h or no cache)** → LAN-first probe, like before. LAN is preferred because it's more efficient when available.
- On every successful connection, the cache is updated. On failure of the cached path, the alternate is tried and — if it succeeds — replaces the cached path.

This means if you spend the day tethered to mobile data, every `agent-bridge run …` hits the internet path directly without a 3s LAN probe. Reconnect to your home wifi and, after the 1h TTL elapses (or whenever the cached internet path fails), the next call re-probes LAN-first and switches back.

The cache TTL can be tuned via environment variables:

- Bash CLI: `AGENT_BRIDGE_PATH_CACHE_TTL=<seconds>`
- MCP server: `AGENT_BRIDGE_PATH_CACHE_TTL_MS=<milliseconds>`

### Manually invalidating the cache

Normally the cache is self-managing, but if routing/topology changes in a way agent-bridge can't detect (e.g. a Tailscale IP changed, or a NAT quirk is causing stale cache entries), you can clear it:

```bash
agent-bridge reset-path Mac-Mini     # clear for one machine
agent-bridge reset-path --all        # nuke the whole cache
```

You can also force a single status call to bypass the cache and re-probe LAN-first:

```bash
agent-bridge status --probe Mac-Mini
# or equivalently:
agent-bridge status --fresh Mac-Mini
```

The MCP server's `bridge_status` tool accepts the same `{ probe: true }` option to force a fresh probe.

### File format and corruption handling

The cache lives at `~/.agent-bridge/path-cache.json` with mode `0600`. Writes are atomic (`write-to-tmp` + `rename`) so concurrent callers never see a half-written file. If the file somehow gets corrupted, agent-bridge treats it as empty and rebuilds it on the next successful probe — it won't error out on broken JSON.

You can safely delete `path-cache.json` at any time; agent-bridge will just recreate it.

---

## Agent skills

agent-bridge ships with skill/instruction files that teach each AI agent how to use the bridge:

### Claude Code

```bash
# If you cloned the repo:
mkdir -p ~/.claude/skills/agent-bridge
cp skills/bridge/skill.md ~/.claude/skills/agent-bridge/skill.md

# Or download directly:
curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/skills/bridge/skill.md \
  -o ~/.claude/skills/agent-bridge/skill.md --create-dirs
```

### Codex CLI (OpenAI)

Codex automatically reads `AGENTS.md` from the repo root. No extra setup needed if you clone the repo.

### Gemini CLI

Gemini CLI automatically reads `GEMINI.md` from the repo root. No extra setup needed if you clone the repo.

### OpenClaw

```bash
cp -r skills/openclaw ~/.openclaw/workspace/skills/agent-bridge
```

### Any other agent

Reference `INSTRUCTIONS.md` in your agent's config, or paste its contents into your agent's system prompt.

---

## Examples

### Run a command on the other machine
```bash
agent-bridge run MacBook-Pro "ls -la ~/Projects"
```

### Deploy an app
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"
```

### Ask the remote agent to do work

From inside an agent session with the channel plugin loaded, call:

```
bridge_send_message("MacBook-Pro", "review the code in ~/Projects/myapp and suggest improvements")
```

The message is pushed into the running Claude Code session on MacBook-Pro as a `<channel source="agent-bridge" ...>` event, and its reply comes back the same way. Do NOT shell out to `agent-bridge run ... --claude` — that path was removed in 3.0.0 because it spawned a fresh non-interactive agent instead of using the live session.

### Check system status
```bash
agent-bridge run MacBook-Pro "uptime && df -h && top -l 1 | head -10"
```

### Start a dev server in the background
```bash
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && nohup npm run dev > /tmp/dev.log 2>&1 & echo started"
```

---

## Troubleshooting

### SSH not enabling on macOS

Go to System Settings > General > Sharing > Remote Login and enable it manually. Make sure **"Allow access for"** is set to **All users**.

### Firewall blocking connections

```bash
# Check if firewall is on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Allow SSH through
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/sbin/sshd
```

### Can't find IP address

```bash
# Get local IP (macOS)
ipconfig getifaddr en0    # Wi-Fi
ipconfig getifaddr en1    # Ethernet

# Or use Tailscale
tailscale ip -4
```

### Messages not arriving

1. Check that the MCP server is running: `bridge_inbox_stats` tool or check `~/.agent-bridge/logs/mcp-server.log`
2. Verify SSH connectivity: `agent-bridge status <machine>`
3. Check inbox contents: `ls ~/.agent-bridge/inbox/`
4. Check for quarantined messages: `ls ~/.agent-bridge/inbox/.failed/`
5. On macOS, install `fswatch` for real-time detection: `brew install fswatch` (the server falls back to 2-second polling without it)

### MCP server won't start

1. Ensure Node.js >= 18 is installed: `node --version`
2. Build the server: `cd mcp-server && npm install && npm run build`
3. Check the log file: `~/.agent-bridge/logs/mcp-server.log`

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/EthanSK/agent-bridge.git
cd agent-bridge

# CLI (zero dependencies)
chmod +x agent-bridge
./agent-bridge help

# MCP server
cd mcp-server
npm install
npm run build
npm run watch  # for development
```

### Project structure

```
agent-bridge/
├── agent-bridge         # CLI script (bash, zero dependencies)
├── install.sh           # One-line installer
├── mcp-server/          # MCP server / channel plugin (TypeScript)
│   ├── src/
│   │   ├── index.ts     # Server entry point, channel notification wiring
│   │   ├── tools.ts     # MCP tool definitions (7 tools)
│   │   ├── config.ts    # Config loader (INI parser, directory paths)
│   │   ├── inbox.ts     # Message inbox/outbox management, pruning, dedup
│   │   ├── watcher.ts   # File watcher (fswatch/inotifywait/polling)
│   │   ├── ssh.ts       # SSH execution wrapper
│   │   └── logger.ts    # Logger (file + stderr, auto-rotation)
│   ├── build/           # Compiled JS output
│   └── package.json
├── skills/
│   ├── bridge/          # Claude Code skill
│   └── openclaw/        # OpenClaw skill
├── AGENTS.md            # Codex CLI instructions
├── GEMINI.md            # Gemini CLI instructions
├── INSTRUCTIONS.md      # Generic agent instructions
├── README.md            # This file
└── site/                # GitHub Pages website
```

---

## License

[MIT](LICENSE) -- Ethan SK
