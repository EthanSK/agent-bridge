# Agent Bridge

You are an AI coding agent with agent-bridge installed. This machine is a **peer** in a bidirectional bridge -- it can both send commands to and receive commands from other paired machines.

## When to activate

Activate when the user says things like:
- "connect to my MacBook" / "talk to the other machine"
- "run X on [machine name]"
- "check if [machine] is online"
- "pair with a new machine" / "add a remote machine"
- "what machines are connected?"
- "set up remote access" / "set up agent-bridge"

## Setup

Run on any machine you want to bridge:
```bash
agent-bridge setup
```

This enables SSH, generates an ED25519 key pair, and displays a pairing screen. Photograph the pairing screen and send it to the agent on the other machine.

## Commands

| Command | Description |
|---------|-------------|
| `agent-bridge list` | List all paired machines |
| `agent-bridge status [machine]` | Check if machine(s) are reachable |
| `agent-bridge run <machine> "cmd"` | Run a PLAIN shell command on a paired machine (diagnostics only — no agent wrapping) |
| `agent-bridge connect <machine>` | Open an interactive SSH session |
| `agent-bridge pair` | Pair with another machine (interactive or flags) |
| `agent-bridge unpair <machine>` | Remove a pairing |

> To communicate with the **running agent** on another machine, use the `bridge_send_message` MCP tool with an explicit `target` (for example `claude-code` or `openclaw/default`). `agent-bridge run` does not spawn or invoke an agent. The `--claude` / `--codex` / `--agent` flags were removed in 3.0.0.

## Pairing from a photo

When the user sends a photo of another machine's pairing screen:
1. Read the image and extract: Machine Name, Username, IP, Port, Token, Public Key
2. Run: `agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"`
3. Test: `agent-bridge status <name>`

## Examples

```bash
# Run a command
agent-bridge run MacBook-Pro "ls -la ~/Projects"

# Deploy
agent-bridge run MacBook-Pro "cd ~/Projects/myapp && git pull && npm install && npm run build"

# Ask remote agent to review code — use the MCP tool, NOT a shell wrapper
#   bridge_send_message({ machine: "MacBook-Pro", message: "review the code in ~/Projects/myapp", target: "claude-code" })

# Check system status
agent-bridge run MacBook-Pro "uptime && df -h"
```

## Security

- SSH key-based auth only (ED25519), no passwords
- Keys stored at `~/.agent-bridge/keys/` (mode 600)
- Config at `~/.agent-bridge/config` (mode 600)
- Direct SSH, no cloud servers
