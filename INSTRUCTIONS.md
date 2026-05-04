# Agent Bridge -- Instructions for AI Agents

agent-bridge lets running agents send messages between paired machines over SSH, and optionally run plain diagnostic shell commands. Claude Code and OpenClaw are both tested, but they use different host models: Claude Code uses a unified MCP + experimental `claude/channel` stdio plugin; OpenClaw uses a separate native `openclaw-channel/` plugin under the OpenClaw gateway. Codex, Gemini CLI, Aider, and other MCP hosts are scaffolded until their receive/reply loops are verified.

## Quick reference

```bash
agent-bridge setup                              # Enable SSH, generate keys, show pairing screen
agent-bridge pair --name "X" --host IP --port 22 --user U --token T --pubkey "ssh-ed25519 ..."
agent-bridge list                               # List paired machines
agent-bridge status [machine]                   # Check reachability
agent-bridge run <machine> "command"            # Run a PLAIN shell command remotely (diagnostics only)
agent-bridge connect <machine>                  # Open interactive SSH session
agent-bridge unpair <machine>                   # Remove a pairing
```

> **Agent-to-agent communication is channel-mode only.** To talk to the running agent on another machine, use the `bridge_send_message` MCP tool — NOT a shell wrapper. The `--claude` / `--codex` / `--agent` flags on `agent-bridge run` were removed in 3.0.0 because they spawned a fresh non-interactive agent session on the remote machine, which defeats the whole point of this project (bridging EXISTING live sessions).

## Setup flow

1. Run `agent-bridge setup` on each machine. It enables SSH, generates an ED25519 key pair, and displays a pairing screen with connection details (IP, port, token, public key).
2. Share the pairing screen with the other machine's agent (e.g., photograph it and send the photo). The agent reads the image, extracts the details, and runs the pair command.
3. For bidirectional access, run pair on both machines with each other's details.

### Windows pairing (Win 10/11)

Windows is a supported pairing target but doesn't ship with OpenSSH Server enabled and has several non-obvious defaults. The pairing-side `agent-bridge` CLI is unchanged — what you do differently is on the Windows host:

- Install OpenSSH Server: `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic` (elevated PowerShell).
- Make sure the network profile is `Private` and the firewall rule is enabled on it: `Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private; Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Private`. With a `Public` profile, port 22 listens but is firewalled — the symptom is `Connection refused` from the LAN despite `Get-Service sshd` showing `Running`.
- **Admin-user gotcha:** if the Windows account is in the `Administrators` group, OpenSSH ignores `C:\Users\<user>\.ssh\authorized_keys` and reads `C:\ProgramData\ssh\administrators_authorized_keys` instead. Always install the pairing pubkey there for admin users, and lock the ACL to `Administrators` + `SYSTEM` only with `icacls $path /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`. OpenSSH refuses to read keys from a file with looser permissions and fails silently as `Permission denied (publickey)`.
- Optional: enable ICMP echo for ping diagnostics: `Get-NetFirewallRule -Name FPS-ICMP4-ERQ-In,CoreNet-Diag-ICMP4-EchoRequest-In -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -Profile Private`.
- Off-LAN access: install Tailscale via `winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements`, then `tailscale up` and authenticate. Use the resulting `100.x.y.z` tailnet IP as `internet_host` when pairing.

The full consolidated setup script lives in `README.md` under the `Windows setup` section. After the Windows side is reachable on `user@<ip>:22`, run the standard `agent-bridge pair` from the macOS/Linux peer. The Windows machine itself doesn't need the `agent-bridge` CLI — it only needs to be an SSH endpoint with the pairing pubkey installed.

## Pairing from a photo

When given a photo of a pairing screen, extract these fields:
- Machine Name
- Username
- IP address (Local IP or Public IP)
- Port
- Token
- Public Key

Then run:
```bash
agent-bridge pair --name "<name>" --host "<ip>" --port <port> --user "<user>" --token "<token>" --pubkey "<pubkey>"
```

## Talking to the running remote agent

Use `bridge_send_message` from the MCP server. **As of mcp-server 3.4.0 the `target` parameter is REQUIRED** — there is no default routing:

```
bridge_send_message({ machine: "MacBook", message: "fix the failing tests", target: "claude-code/default" })
bridge_send_message({ machine: "MacBook", message: "what's up?",            target: "openclaw/<account-alias>" })
```

Each target maps to a subdir under `~/.agent-bridge/inbox/` on the remote (`inbox/claude-code/default/`, `inbox/claude-code/<persona>/`, `inbox/openclaw/<account-alias>/`, …) and a specific listener picks it up:

- `target: "claude-code/default"` → default Claude Code persona; the plugin pushes the message into the running Claude session as a `<channel source="agent-bridge" ...>` event. Legacy `target: "claude-code"` remains accepted for rolling upgrades and v4 receivers route it to the default persona.
- `target: "claude-code/<persona>"` → named Claude Code persona on the receiving machine, e.g. `claude-code/yolo`.
- `target: "<harness>/<account-alias>"` (e.g. `openclaw/<account-alias>`) → the harness's channel plugin dispatches the message into the per-account session for `<account-alias>`. For OpenClaw specifically, this is `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` — a synchronous agent turn runs and the reply is sent through the live Telegram outbound for the registered bot account because the synthetic ctxPayload pins `OriginatingChannel: "telegram"`.

Calls without `target` are rejected. Legacy flat-file messages that land at the root of `inbox/` are moved to `inbox/.failed/_unrouted/` on next startup.

There is no fresh-spawn / `--print` equivalent. The old `agent-bridge run ... --claude` flag was removed in 3.0.0.

## Same-machine delivery (3.5.0+)

`bridge_send_message` accepts the **local machine name** (or one of the reserved aliases `local`, `self`, `localhost`) as its `machine` parameter. When the target is local, the message JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` using the same atomic write pattern as the SSH path — no SSH hop, no loopback round-trip.

```
bridge_send_message({ machine: "local",     message: "...", target: "openclaw/<account-alias>" })
bridge_send_message({ machine: "Mac-Mini",  message: "...", target: "claude-code/default" })
```

Use it when one MCP host on a machine needs to fan a message out to another agent harness on the **same** machine — the canonical case is a Claude Code session sending to OpenClaw embedded Telegram sessions running in the same OpenClaw gateway. The receiver still needs a watcher running on its own per-target subdir: Claude Code persona watchers watch `inbox/claude-code/<persona>/`, and `openclaw-channel` watches `inbox/openclaw/<account>/`. agent-bridge does not push the message into the receiver itself; it just lands the file atomically.

Design notes:

- The local machine is identified by either its real name (matched case-insensitively against `getLocalMachineName()`) or one of the reserved aliases. There is no per-machine `local = true` config flag — the local route is implicit and always available.
- Pairing a remote machine under one of those names is rejected up-front (CLI and MCP) so the local route cannot be shadowed.
- `bridge_status` reports the local pseudo-machine as `LOCAL (no SSH — same-machine delivery via inbox/<target>/)`. `bridge_list_machines` always lists it first.
- `bridge_run_command` and `agent-bridge run` reject local routing with a clear error — there is no SSH loopback. For local shell work, use the harness's regular shell tool.
- The success message returned by `bridge_send_message` includes `transport=local` for same-machine sends and `transport=ssh` for cross-machine sends, so callers can verify which path was taken.

## Architecture

- Config directory: `~/.agent-bridge/`
- Config file: `~/.agent-bridge/config` (INI-style, one `[section]` per machine)
- Keys: `~/.agent-bridge/keys/` (ED25519, mode 600)
- Inbox: `~/.agent-bridge/inbox/` — per-harness/per-target subdirs (3.4.0+; Claude Code personas in 4.0.0+):
  - `inbox/claude-code/default/` — watched by the default Claude Code persona
  - `inbox/claude-code/<persona>/` — watched by a named Claude Code persona
  - `inbox/claude-code/<id>.json` — legacy flat file from `target: "claude-code"`; v4 receivers migrate it to `default/`
  - `inbox/openclaw/<target>/` — watched by the openclaw-channel plugin
  - `inbox/.archive/claude-code/<persona>/` — delivered Claude Code messages retained for debug
  - `inbox/.failed/claude-code/<persona>/` — malformed/misrouted Claude Code-target files
  - `inbox/.failed/_unrouted/` — legacy flat messages with no routable target, quarantined
  - `archive/openclaw/<target>/` — delivered OpenClaw messages retained for debug
  - `.openclaw-v2-delivered` — OpenClaw delivered-ID ledger
- Outbox: `~/.agent-bridge/outbox/` (copies of sent messages)
- Logs: `~/.agent-bridge/logs/` (MCP server logs, auto-rotated)
- No cloud -- SSH file transport, with Node-based MCP/channel plugins for agent integration

## MCP Server (agent-to-agent messaging)

The MCP server provides the shared `bridge_*` tools for EXISTING running agent sessions. Push delivery is host-specific: Claude Code uses the MCP server's `claude/channel` stdio path, while OpenClaw uses `openclaw-channel/`. It does NOT spawn new agent processes.

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and connection details |
| `bridge_status` | Check if a machine is reachable via SSH |
| `bridge_send_message` | Send a message to another machine's running agent |
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox. 3.8.0+ supports long-poll via `wait: true, timeout_seconds: 30` (capped at 60 s) for subagents that can't receive parent-only channel pushes. |
| `bridge_run_command` | Run a shell command on a remote machine |
| `bridge_clear_inbox` | Clear the local inbox |
| `bridge_inbox_stats` | Get inbox statistics and watcher health |

### Claude Code unified plugin (3.7.0+)

When used with Claude Code, agent-bridge ships **one unified plugin** at [`mcp-server/`](mcp-server/). It hosts both:

1. The 7 user-facing `bridge_*` tools (and the diagnostic `claude_code_channel_status` no-op tool).
2. The long-lived inbox watcher that owns a persona-scoped lease such as `~/.agent-bridge/locks/claude-code__default.watcher-lock.json`, polls `~/.agent-bridge/inbox/claude-code/<persona>/` at 2 s, and emits `notifications/claude/channel` back to the running session as:

```
<channel source="agent-bridge" from="MachineName" message_id="msg-xxx" ts="2026-01-01T00:00:00Z">
Message content here
</channel>
```

The agent responds using the `bridge_send_message` tool. In 4.0.0, `AGENT_BRIDGE_PERSONA=<persona>` is the explicit Claude Code identity. If it is unset, a channel-capable Claude Code parent falls back to `default`; a non-Claude/tool-only parent does not claim any Claude inbox lease. The old role env vars (`AGENT_BRIDGE_ROLE`, `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`, `AGENT_BRIDGE_DISABLE_WATCHER`) were removed and have no effect.

**Why one plugin?** The 3.6.0 split into a separate `claude-code-channel` plugin was based on the assumption that "channel-only plugins survive longer in Claude Code's plugin host." Production evidence (Mac Mini, 2026-04-26) showed that was wrong — the host actually gates idle reaping on **MCP tool-call frequency on stdio JSON-RPC**. Telegram (also a channel plugin) survives indefinitely because its 4 tools (`reply`, `react`, `download_attachment`, `edit_message`) get called constantly during normal use. A channel-only plugin with no tool calls gets reaped after every notification delivery, regardless of Patches G/H (SIGTERM ignore + no-op tool registered). 3.7.0 re-merges everything into one plugin so every `bridge_send_message` call resets the host's idle counter — same lifetime guarantees as Telegram. See `CHANGELOG.md` 3.7.0 entry for the full rationale.

### OpenClaw native channel plugin

OpenClaw push delivery is **not** Claude's `claude/channel` protocol. Keep the MCP server in tools-only mode for `bridge_*` tools, and load `openclaw-channel/` as a native OpenClaw plugin. That plugin watches `inbox/openclaw/<target>/`, resolves an OpenClaw route, and dispatches a real OpenClaw turn via `dispatchInboundReplyWithBase`.

### Manual/polling fallback (unverified MCP hosts)

`bridge_receive_messages` currently inspects/consumes the active local Claude Code persona inbox (for example `inbox/claude-code/default/`). Use it for diagnostics, tools-only/manual setups, future harness-specific polling experiments, or — most importantly as of 3.8.0 — **subagent receive**.

**Long-poll mode (3.8.0+).** Channel-push notifications (`<channel source="agent-bridge" ...>`) only reach the parent session. A subagent that needs to wait for a bridge reply should call:

```json
{ "wait": true, "timeout_seconds": 30, "peek": true }
```

The MCP tool registers a one-shot listener with the watcher's in-process arrival registry and races it against `setTimeout`. If the inbox is already non-empty when called, returns immediately. On arrival within the window, returns the new messages. On timeout, returns `{ count: 0, messages: [], timed_out: true }` in `structuredContent` so the caller can re-poll. Server caps `timeout_seconds` at 60.

Multiple concurrent long-pollers (parent + N subagents) all wake on the same arrival — broadcast semantics. Use `peek: true` so the parent's channel-push consumer (and other subagents) still see the same content. `peek: false` (consume) is destructive first-come-first-served and only one caller will see the message returned. For genuine one-receiver-only fan-out, use unique `from_target` values per subagent so replies route to per-subagent inbox subdirs.

Do not assume Codex, Gemini CLI, Aider, or arbitrary MCP hosts have the same push lifecycle as Claude Code or OpenClaw until their target and receive loop are tested end-to-end.

### Channel setup

**Claude Code (recommended, 3.7.0+):** Install as a Claude Code plugin. The repo's local marketplace ships the unified plugin:

```bash
cd ~/Projects/agent-bridge/mcp-server && npm install && npm run build
claude plugin marketplace add ~/Projects/agent-bridge
claude plugin install agent-bridge@agent-bridge   # unified tools + channel
```

> **Migrating from 3.6.x?** Run `claude plugin uninstall agent-bridge-channel@agent-bridge` first to drop the now-deleted channel plugin, then reinstall `agent-bridge` to pick up 3.7.0. Also remove `--dangerously-load-development-channels plugin:agent-bridge-channel@agent-bridge` from your launch alias — only `plugin:agent-bridge@agent-bridge` is needed.

Verify with `claude plugin list`. The plugin manifests live at `.claude-plugin/marketplace.json` (repo root) and `mcp-server/.claude-plugin/plugin.json` + `mcp-server/.mcp.json`.

> ⚠️ **You still need `--dangerously-load-development-channels`.** An earlier version of this doc claimed the plugin install removes that requirement — it does not. Because the marketplace is a **local directory** (`claude plugin marketplace add ~/Projects/agent-bridge`), Claude Code treats it as a dev channel and its built-in allowlist will reject it on launch with:
>
> ```
> plugin agent-bridge@agent-bridge is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)
> ```
>
> The flag is required **until the plugin is published through an official GitHub marketplace** Claude Code's allowlist trusts. Add it to your launch alias, e.g.:
>
> ```bash
> alias claude-tel='AGENT_BRIDGE_PERSONA=default claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels plugin:agent-bridge@agent-bridge'
> alias claude-yolo='AGENT_BRIDGE_PERSONA=yolo claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels plugin:agent-bridge@agent-bridge'
> ```
>
> **Note:** `--dangerously-load-development-channels` takes a **tagged argument** (`plugin:<name>@<marketplace>` for an installed plugin's channel, or `server:<name>` for a raw MCP server) and does **both jobs in one entry**: activates the channel AND marks it as allowlist-exempt. Do NOT also add `--channels plugin:agent-bridge@agent-bridge` — that creates a second entry with `dev:false` that fails the allowlist check. Running the flag bare (no tag) also fails: `--dangerously-load-development-channels entries must be tagged: --channels plugin:<name>@<marketplace> | server:<name>`.

**OpenClaw MCP tools:** add the MCP server for tools without `AGENT_BRIDGE_PERSONA`, then load the native channel plugin separately through OpenClaw config:
```bash
openclaw mcp set agent-bridge '{"command":"node","args":["/absolute/path/to/agent-bridge/mcp-server/build/index.js"]}'
```

**Other MCP hosts (Codex, Gemini CLI, Aider):** add the server to the harness's MCP config for tools. Inbound receive/reply remains scaffolded until tested:
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

### Legacy: manual channel launch

If you load the MCP server outside of the plugin system (for example with `server:agent-bridge` pointing at a hand-edited `.mcp.json`), Claude Code's channel allowlist still requires the dev-channel flag. The flag takes a tagged argument and both activates the channel and marks it allowlist-exempt:

```bash
claude --dangerously-load-development-channels server:agent-bridge
```

Prefer the plugin install path above for normal use, but a local-directory marketplace still needs the tagged `--dangerously-load-development-channels plugin:agent-bridge@agent-bridge` launch flag until the plugin is published through a trusted marketplace.

### Message flow

1. Machine A's agent calls `bridge_send_message({ machine: "MacBook", message: "check the test results", target: "claude-code/default" })`, a named persona target like `target: "claude-code/yolo"`, or an OpenClaw target like `target: "openclaw/default"`.
2. The message is written to Machine B's target-specific inbox subdir via SSH, e.g. `~/.agent-bridge/inbox/claude-code/default/<id>.json`, `~/.agent-bridge/inbox/claude-code/yolo/<id>.json`, or `~/.agent-bridge/inbox/openclaw/default/<id>.json`.
3. The target's listener detects the new file.
4. **Claude Code push:** the channel-owner MCP child emits `notifications/claude/channel` into the running Claude session.
5. **OpenClaw push:** the native OpenClaw plugin dispatches via `dispatchInboundReplyWithBase` into the resolved OpenClaw session.
6. **Manual fallback:** a tools-only/manual agent can call `bridge_receive_messages()` for the Claude Code-target inbox.
7. Machine B's agent responds via `bridge_send_message` back to Machine A, using `fromTarget` when present.

### Offline recovery

Pending messages persist in their per-target inbox subdir until delivered, consumed, expired, or quarantined (default TTL: 1 day). On MCP server startup, undelivered Claude Code messages in the active persona inbox (for example `inbox/claude-code/default/`) are replayed as channel notifications in chronological order; successfully delivered files are archived to `inbox/.archive/claude-code/<persona>/`. Legacy `inbox/claude-code/*.json` files from `target: "claude-code"` are migrated into `default/` by v4 receivers. A `.delivered` tracker prevents duplicate Claude Code notifications across restarts. This is replay-on-spawn durability, not a separate always-on Claude daemon. OpenClaw uses `~/.agent-bridge/.openclaw-v2-delivered` and archives under `~/.agent-bridge/archive/openclaw/<target>/`.

### Authentication

All messages are delivered via SSH with key-based authentication. The `authenticated: ssh-key` metadata in channel notifications confirms the sender was verified by the SSH transport layer.

### Message format

```json
{
  "id": "msg-uuid",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "The tests are passing now.",
  "timestamp": "2026-04-13T01:15:00Z",
  "replyTo": null,
  "ttl": 86400,
  "target": "claude-code/default",
  "fromTarget": "claude-code/yolo"
}
```

The `target` field (added in 3.4.0) decides which inbox subdir on the receiver the message lands in, and therefore which listener consumes it. For Claude Code, prefer `claude-code/default` or `claude-code/<persona>`; legacy `claude-code` is accepted for rolling upgrades and routes to the default persona on v4 receivers. `fromTarget` is the sender's return target for bridge replies; Claude Code defaults it to the active `claude-code/<persona>` (usually `claude-code/default`), while OpenClaw senders should pass their own target such as `openclaw/default`.
