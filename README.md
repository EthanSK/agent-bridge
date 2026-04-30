# agent-bridge

**Bridge running Claude Code and OpenClaw sessions across machines. Agent-to-agent push comms over SSH.**

> 🚨 **First diagnostic: make sure every machine is actually running the current Agent Bridge code.** A common cause of confusing failures is stale runtime code: the repo may have been pulled, but the installed `agent-bridge` CLI, `mcp-server/build/` bundle, Claude Code plugin process, OpenClaw channel plugin, or long-running agent session may still be on an older version. Before debugging deeper, pull the repo on both sides, rebuild/reinstall where needed, restart or resume the affected host/plugin, and verify the live version/commit from that machine.
>
> ✅ **Tested end-to-end with Claude Code and OpenClaw.** They use different host models over the same SSH/file transport: Claude Code uses a unified MCP + experimental `claude/channel` plugin over stdio; OpenClaw uses the separate native `openclaw-channel/` plugin plus the MCP server, including cross-machine `replyVia: "agent-bridge"` round trips. Codex CLI, Gemini CLI, Aider, and other MCP hosts remain scaffolded/manual-polling integrations until verified in their own harnesses.
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
- **Windows 10/11:** OpenSSH Server is an optional feature, not on by default. See the [Windows setup](#windows-setup) section below for the consolidated install + firewall + admin-key script.

Then photograph the pairing screen on one machine and send it to the Claude Code session on the other. That's the pair step; the agents handle the rest.

---

## What is agent-bridge?

agent-bridge lets running Claude Code and OpenClaw sessions on different machines talk to each other agent-to-agent, and (optionally) run commands on each other's machines over SSH. Design goals:

- **Peer-to-peer** -- no central server, no cloud, direct SSH between your machines
- **Real-time push where the host supports it** -- Claude Code receives `<channel source="agent-bridge">` events; OpenClaw receives native channel turns through `openclaw-channel/`
- **Small transport surface** -- just bash/ssh for pairing and delivery, plus Node for the MCP/channel plugins; no Docker, no central service
- **MCP tools + harness-specific receivers** -- `bridge_*` tools are shared, but Claude Code's `claude/channel` stdio lifecycle and OpenClaw's `registerChannel()` gateway lifecycle are deliberately different

---

## Architecture overview

```
                          agent-bridge architecture

 MACHINE A (e.g. Mac Mini)                    MACHINE B (e.g. MacBook Pro)
 ┌─────────────────────────────────┐         ┌─────────────────────────────────┐
 │                                 │         │                                 │
 │  AI Agent (Claude/OpenClaw)     │         │  AI Agent (Claude/OpenClaw)     │
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

The diagram shows the shared transport shape, not one identical host lifecycle. As of 3.7.0, the Claude Code integration uses **one unified plugin** at [`mcp-server/`](mcp-server/) that hosts both:

- The 7 user-facing `bridge_*` tools (and a diagnostic `claude_code_channel_status` no-op tool).
- The long-lived inbox watcher that holds the `~/.agent-bridge/locks/claude-code.watcher-lock.json` lease, polls `~/.agent-bridge/inbox/claude-code/` at 2 s, and pushes incoming messages back to Claude as `notifications/claude/channel`.

3.6.0 had split these into two plugins (an `agent-bridge` tools server + a separate `agent-bridge-channel` channel host). Production evidence showed Claude Code's plugin host actually gates idle-reaping on **MCP tool-call frequency on stdio JSON-RPC**, not channel registration — a channel-only plugin gets reaped after every notification regardless of Patches G/H. 3.7.0 re-merges everything so frequent `bridge_*` tool calls keep the plugin alive (same lifetime guarantees as Telegram). See [`CHANGELOG.md`](CHANGELOG.md) 3.7.0 entry. OpenClaw still ships its own native channel plugin in [`openclaw-channel/`](openclaw-channel/) — unaffected by the consolidation.

---

## Compatibility

| Agent Harness | Status | Integration |
|---------------|--------|-------------|
| **Claude Code** | ✅ **Tested end-to-end**, both machines confirmed | One unified plugin as of 3.7.0: the `agent-bridge` plugin (MCP server in [`mcp-server/`](mcp-server/)) exposes `bridge_*` tools AND owns the watcher lease that pushes inbound messages via `notifications/claude/channel`. The frequent tool calls keep the plugin alive — same lifetime model as Telegram |
| OpenClaw | ✅ **Tested end-to-end**, first-class channel | Separate native plugin in [`openclaw-channel/`](openclaw-channel/README.md) registers with OpenClaw via `api.registerChannel()`; the MCP server is used for tools and runs `tools-only` |
| Codex CLI (OpenAI) | 🟡 Scaffolded, not exercised yet | MCP server + skill file at `AGENTS.md`; inbound receive/polling flow still needs harness-specific verification |
| Gemini CLI | 🟡 Scaffolded, not exercised yet | MCP server + skill file at `GEMINI.md`; inbound receive/polling flow still needs harness-specific verification |
| Aider / other MCP hosts | 🟡 Scaffolded, not exercised yet | MCP server + generic instructions at `INSTRUCTIONS.md`; inbound receive/polling flow still needs harness-specific verification |

"Scaffolded" means the files exist and the MCP server is harness-agnostic for tools, but nobody has verified the non-Claude/non-OpenClaw harnesses actually drive a complete receive/reply loop correctly. If you try one of those and it works (or doesn't), open an issue — empirical reports are welcome.

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
bridge_send_message({
  machine: "MacBook-Pro",
  message: "can you check whether the tests pass in ~/Projects/myapp and tell me what broke?",
  target: "claude-code"
})

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

**CLI transport dependencies.** The bash CLI uses only bash, ssh, and ssh-keygen (built into every Mac and Linux). Push integrations also need Node for the MCP/channel plugins.

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

## Updating

agent-bridge has three moving parts on each machine (3.7.0+):

| Part                              | Where                                                                 | How it updates              |
|-----------------------------------|-----------------------------------------------------------------------|-----------------------------|
| `agent-bridge` CLI script         | Either `/usr/local/bin/agent-bridge` (one-line install, re-run it)    | Re-run `install.sh`         |
|                                   | OR a symlink into the checked-out repo (Option B)                     | `git pull` in the repo      |
| Unified MCP server (tools + channel) | `<repo>/mcp-server/build/`                                         | `git pull` + rebuild        |
| OpenClaw channel plugin           | `<repo>/openclaw-channel/` (loaded from the repo path by the gateway) | `git pull` + gateway restart |

The unified MCP server is loaded by Claude Code's plugin host as a single plugin. It hosts both the `bridge_*` tools and the long-lived inbox watcher in one process; frequent tool calls keep it alive across the whole session (same lifetime model as Telegram). `/reload-plugins` reconnects to the new build — no terminal restart needed.

The OpenClaw channel plugin is loaded once when the gateway starts, so you DO need to restart the gateway to pick up plugin changes.

### One-shot helper: `scripts/update.sh`

From a cloned repo checkout:

```bash
cd ~/Projects/agent-bridge       # or wherever you cloned it
./scripts/update.sh              # safe mode — prompts before anything risky
./scripts/update.sh --yes        # unattended (still warns, but no prompts)
./scripts/update.sh --skip-openclaw   # skip the gateway-restart step
./scripts/update.sh --auto       # SessionStart-safe: quiet no-op, no prompts, skips OpenClaw restart
```

What it does:
1. `git fetch origin && git pull --ff-only origin main`
2. `(cd mcp-server && npm install && npm run build)` to rebuild the unified MCP server (tools + channel)
3. Archives older inactive Claude Code plugin cache version directories under `~/.claude/plugins/cache/agent-bridge/agent-bridge/.archive/`
4. Syncs remaining Claude Code plugin cache copies to the rebuilt MCP server
5. (Optional) Restart the OpenClaw gateway via `openclaw gateway restart` if the `openclaw` CLI is on `$PATH`. Gated behind a Y/n prompt so you can say no during a live session. Skipped entirely with `--skip-openclaw`
6. Attempts to trigger `/reload-plugins` in the running Claude Code terminal via the `self-reload-plugins` skill (only if that skill is installed in `~/.claude/skills/self-reload-plugins/`)

The script is idempotent — if `mcp-server/build/` is already up-to-date the npm build is a fast no-op. `--auto` is intended for Claude Code startup hooks: it implies `--yes --skip-openclaw`, suppresses prompts, and exits silently when no commits were pulled and no rebuild is needed.

To run the updater automatically when Claude Code starts or resumes, paste one hook group like this into `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/Projects/agent-bridge/scripts/update.sh --auto",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Claude Code's current hook schema uses an outer matcher group and an inner `hooks` array. `timeout` is in seconds.

### Auto-update notifications (3.10.0+, periodic re-probe in 3.11.0+, receiver coord in 3.12.0+)

agent-bridge can also tell the running harness when its source checkout has fallen behind `origin/main`, so the agent itself sees a `[BRIDGE-UPDATE-AVAILABLE]` channel message instead of silently drifting. The notification is **on by default** — the MCP server fires `scripts/check-update.sh` ~30 seconds after `server.connect()` (channel-owner only) **and then re-probes every 3 hours** (3.11.0+, addresses the bug where long-lived channel-owner children booted before an upstream push never noticed the new commit). The script runs `git fetch --quiet`, compares `HEAD` to `origin/main`, and — if origin is strictly ahead — drops a `BridgeMessage` JSON file into `~/.agent-bridge/inbox/<target>/`. The existing channel watcher pushes it into the live session via `notifications/claude/channel`, just like a remote message. Idempotent: the last-notified `origin/main` SHA is recorded at `~/.agent-bridge/.last-update-notified-head`, so the same SHA does not re-notify.

If a child boots as standby (Patch F: another peer holds the watcher lease) and is later promoted to channel-owner because the lease holder died, the auto-update probe is (re)armed at promotion time — fresh probe immediately, plus the 3-hour interval starting then — so a process that only became channel-owner mid-session still runs the check.

```bash
# Manual probe (safe to run anywhere, anytime):
./scripts/check-update.sh                   # silent unless update available
./scripts/check-update.sh --verbose         # always print status to stderr
./scripts/check-update.sh --force           # ignore the sentinel and re-notify
./scripts/check-update.sh --dry-run         # show what would be written, don't write
./scripts/check-update.sh --target=claude-code   # drop only into a specific inbox
```

By default the script fans out to every leaf inbox subdir under `~/.agent-bridge/inbox/` (e.g. `claude-code`, `openclaw/<account>`), so any harness on this host that watches its own subdir sees the notification. Override via `--target=<name>`.

The MCP server locates the source checkout in this order:

1. `AGENT_BRIDGE_SOURCE_DIR` env var (highest priority — set this to skip the probe)
2. `~/.openclaw/workspace/agent-bridge`
3. `~/Projects/agent-bridge`
4. `~/projects/agent-bridge`
5. `~/agent-bridge`
6. `~/src/agent-bridge`

If none exist (e.g. the host installed agent-bridge from the plugin marketplace and never cloned the source), the probe is skipped silently.

To **disable** auto-update notifications, set `AGENT_BRIDGE_AUTO_UPDATE_CHECK=0` (also accepts `false` / `off` / `no` / `disabled`) in the MCP server's environment — for example, via the plugin's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/build/index.js"],
      "env": {
        "AGENT_BRIDGE_AUTO_UPDATE_CHECK": "0"
      }
    }
  }
}
```

You can also wire `scripts/check-update.sh` to cron / launchd / Task Scheduler / a SessionStart hook for periodic re-checks; the same kill switch applies because the script honours `AGENT_BRIDGE_AUTO_UPDATE_CHECK` directly. Applying the update is still an explicit decision: when the harness sees `[BRIDGE-UPDATE-AVAILABLE]` it can decide whether to run `scripts/update.sh`, ask the operator, or ignore.

### Auto-update receiver behavior

When a `[BRIDGE-UPDATE-AVAILABLE]` channel message lands in a Claude Code or OpenClaw session, the receiving agent **should not pull-and-rebuild directly in its main thread**. Doing the pull, `npm install`, and `npm run build` synchronously in the main thread:

- Blocks the user's session for tens of seconds while npm churns.
- Forces conflict resolution to happen inside whatever the agent was doing (mid-Telegram-thread, mid-debug, etc.) instead of in an isolated context.
- Loses the natural "report back commit hash and any conflicts" handoff a subagent provides.

The recommended pattern is **dispatch a subagent to do the upgrade**, then surface its result back to the user. As of **3.12.0** ([AUTO-UPDATE-COORD-LOCK 2026-04-30]), every receiver subagent must pass through the shared coordination helper before it touches git/npm/plugin-cache state:

1. Receiver sees the `[BRIDGE-UPDATE-AVAILABLE]` channel block.
2. Receiver dispatches a subagent (see harness-specific guidance below) with instructions to:
   - `cd <agent-bridge source checkout>`
   - **Step 1.5: acquire the same-host coordination gate** and run the updater through it:

     ```bash
     ./scripts/auto-update-coord.sh run \
       --source-dir "$PWD" \
       --cycle <origin-main-sha-from-the-notification> \
       -- ./scripts/update.sh --auto
     ```

     `run` acquires the lock, records the attempt timestamp, executes the command, and releases the lock via `trap` when the command exits. Harnesses that cannot wrap the whole command may use `acquire` + `release` manually, but they must keep the token and release only their own lock:

     ```bash
     eval "$(./scripts/auto-update-coord.sh acquire --source-dir "$PWD" --cycle <origin-sha>)"
     trap './scripts/auto-update-coord.sh release --source-dir "$PWD" --cycle <origin-sha> --token "$AGENT_BRIDGE_AUTO_UPDATE_TOKEN" --exit-code "$?"' EXIT
     ./scripts/update.sh --auto
     ```

   - If the helper exits `73`, another local receiver already owns the update for this checkout. Do **not** pull/build; observe/report that the host-level update is already in progress.
   - If the helper exits `75`, the same origin SHA is inside the minimum retry interval. Do **not** retry immediately; report that the retry gate is active.
   - If the helper exits `0` from `run`, the update command succeeded. Report the final commit hash, incoming subjects, and reload result.
   - If the wrapped updater exits non-zero, surface the git/build/reload error to the user rather than retrying in a loop.
3. Main agent surfaces the subagent's report to the user. **The receiver agent MUST notify the user when the auto-update completes or is skipped by coordination** — for this rig, that means a Telegram message containing the new commit hash or the coordination skip reason, a one-line summary of what changed (subjects of incoming commits), and any conflicts / non-FF / build errors. Notification at start ("dispatching subagent to apply X→Y agent-bridge update") and at end ("update complete on disk, now at <hash> — RESTART CLAUDE CODE to load it" or "another local receiver is handling it") is the right cadence. **Important — do NOT claim the runtime swap succeeded.** As of 2026-04-30 we have empirical evidence that `/reload-plugins` re-reads plugin descriptors but does NOT respawn long-running MCP child processes when a healthy channel-owner exists; Patch F's lease coordination keeps the existing owner alive and demotes /reload-plugins-spawned children to standby. So **a full Claude Code session restart is the only deterministic way to load the new plugin code** after an auto-update on the disk. The receiver subagent should announce "agent-bridge update applied to disk; please restart Claude Code to load it" rather than implying the running plugin is now upgraded. If the subagent reports a non-FF condition, the main agent asks the user what to do rather than auto-rebasing through unknown developer state.

**Coordination contract.** The helper is intentionally **same-host only**. Different hosts have different source checkouts, npm installs, plugin caches, and reload lifecycles, so one host's update does not protect or complete another host's update. The lock path is derived from the canonical source checkout path:

```text
~/.agent-bridge/locks/auto-update.<sha256(realpath(source-dir))>.lock
~/.agent-bridge/locks/auto-update.<sha256(realpath(source-dir))>.state
```

That means `~/Projects/agent-bridge` and `~/.openclaw/workspace/agent-bridge` coordinate separately unless they resolve to the same real path/symlink target. Any number of Claude Code sessions and OpenClaw personas on the same machine can call the helper concurrently; exactly one holder proceeds for a given checkout, and the rest receive a deterministic skip code.

Defaults are deliberately conservative:

- Stale lock: **1800000 ms / 30 minutes** (`AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS`). If a lock is older than this, the next receiver may reclaim it because the holder likely died.
- Minimum retry interval: **300000 ms / 5 minutes** for the same `--cycle` (`AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS`). This prevents tight receiver loops if a lock is released quickly or repeatedly reclaimed. A newer origin SHA is a new cycle and may proceed immediately.
- Lock dir: `~/.agent-bridge/locks` (`AGENT_BRIDGE_LOCK_DIR`).

For live tests, shorten the two millisecond env vars above just like `AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS` (for example `AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS=5000` and `AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS=5000`). The helper also accepts CLI equivalents (`--stale-lock-ms`, `--min-retry-ms`) and legacy second-based aliases (`AGENT_BRIDGE_AUTO_UPDATE_STALE_AFTER_SEC`, `AGENT_BRIDGE_AUTO_UPDATE_MIN_INTERVAL_SEC`) for compatibility, but the millisecond env vars are the documented contract.

The helper writes unified log breadcrumbs to `~/.agent-bridge/logs/agent-bridge.log`: `auto_update_coord.acquired`, `auto_update_coord.released`, `auto_update_coord.skipped_locked`, `auto_update_coord.skipped_retry_gate`, and `auto_update_coord.reclaimed_stale`. Those events include the checkout path, cycle SHA, lock/state paths, effective stale/min-retry values, and relevant holder/exit metadata so future debugs can answer "did it run?" without scraping subagent transcripts.

**Claude Code specifics.** Use the built-in subagent dispatch (the `Agent` tool with `subagent_type: "general-purpose"`). `run_in_background: true` is appropriate here so the user's session remains responsive during the npm install/build; the subagent posts back asynchronously. The receiver agent should announce "dispatching a subagent to apply the agent-bridge update" so the user knows what's happening, and then send a follow-up Telegram (or whichever channel) message when the subagent finishes.

**About the post-build reload step.** Historical guidance pointed at `self-reload-plugins` / `/reload-plugins` as the trigger, and `scripts/update.sh --auto` invokes it when available. Empirical evidence from 2026-04-30 shows this is **insufficient** for refreshing the running MCP child process: `/reload-plugins` reloads plugin descriptors / skills / hooks but does NOT kill and respawn long-running MCP servers when a healthy channel-owner exists (Patch F demotes the new spawn to standby). So `/reload-plugins` after pull+build leaves the agent-bridge MCP child running its OLD code regardless of how many times you fire it. The receiver subagent should issue `/reload-plugins` for completeness (it covers descriptor refreshes for OTHER plugins that may have updated alongside), but the actual cache-refresh requires a **full Claude Code restart** by the operator. The receiver's Telegram notification at end should reflect that: "update on disk to <hash>; restart Claude Code to load." Future work: expose an explicit `bridge_force_respawn` MCP tool that releases the channel-owner lease so /reload-plugins-spawned children can take over, eliminating the manual-restart requirement.

**OpenClaw specifics.** OpenClaw receivers should use the same helper and lock directory. If the running OpenClaw version exposes background subagents/sessions, dispatch one and wrap `./scripts/update.sh --auto` with `auto-update-coord.sh run` exactly as above. If no safe background-dispatch primitive is available in that harness version, print the notification and the coordination command to the operator instead of running pull/build/reload in the foreground. Cross-machine update propagation is unaffected: bridge delivery can notify every host, but coordination remains local to each host's checkout.

#### Live-test recipe

The default 3-hour cadence is intentional for production but useless when you're trying to validate a code change to the auto-update flow itself. As of **3.11.1** ([AUTO-UPDATE-TEST-MODE 2026-04-30]) the periodic interval is configurable via `AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS`, so you can drive the full receiver path end-to-end in roughly a minute and a half instead of waiting 3 hours.

The override accepts an integer millisecond value, bounded **30000 (30 s)** ≤ value ≤ **86400000 (24 h)**. Out-of-range or unparseable values fall back to the 3 h default with a `auto_update_check.interval_override_rejected` warn-level log. The `AGENT_BRIDGE_AUTO_UPDATE_CHECK` kill switch still wins — if the probe is disabled outright, the override is irrelevant. The initial 30 s delayed first probe is unaffected; only the periodic interval is configurable. At arm time the chosen interval is logged as a `auto_update_check.armed` event with `{intervalMs, source: "env" | "default"}` so you can verify which one is active.

**Steps:**

1. **On the test peer**, set the override in the harness's MCP environment so the new MCP child boots with the short interval. For Claude Code that's the `env` block under the agent-bridge plugin entry in `~/.claude/settings.json`:

   ```jsonc
   {
     "plugins": {
       "agent-bridge": {
         "env": {
           "AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS": "60000"
         }
       }
     }
   }
   ```

   Alternatively, wrap the plugin spawn in a small shell shim that exports the env var before launching `node build/index.js`. (For OpenClaw, set the env var in the gateway's launchd plist or however you launch the workspace.)

2. **Reload plugins** so the new MCP child picks up the env. In Claude Code: `/reload-plugins` (or invoke the `self-reload-plugins` skill). Confirm the override took effect by checking the unified log for an `auto_update_check.armed` event with `source: "env"` and `intervalMs: 60000`:

   ```bash
   grep '"event":"auto_update_check.armed"' ~/.agent-bridge/logs/skills.log* 2>/dev/null \
     | tail -3 | jq '.context'
   ```

3. **From any other peer**, push a small benign commit to `EthanSK/agent-bridge` `main` — a CHANGELOG nudge, a docs typo fix, anything that bumps `origin/main` past the test peer's `HEAD`. Note the new SHA.

4. Within roughly **30 s + 60 s** (initial-delay window + first periodic interval), the test peer's MCP probe should fire and `scripts/check-update.sh` should drop a `[BRIDGE-UPDATE-AVAILABLE]` BridgeMessage into `~/.agent-bridge/inbox/<target>/`. The channel watcher then pushes it into the running session, exactly as it would with a remote-originated message.

5. The receiver subagent flow documented above (Claude Code: `Agent` tool with `subagent_type: "general-purpose"`, `run_in_background: true`; OpenClaw: use its background session/subagent primitive when available) should kick in: dispatch a subagent to run `./scripts/auto-update-coord.sh run --source-dir "$PWD" --cycle <origin-sha> -- ./scripts/update.sh --auto`, then surface the new commit hash or coordination skip reason and a one-line summary back via the harness's normal channel (Telegram, console, etc.). This is the part you're actually validating.

6. **After validating, unset the env var and reload** to return to the production 3 h cadence:

   ```jsonc
   // remove the AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS line from settings.json
   ```

   Then `/reload-plugins` again. The next `auto_update_check.armed` event should report `source: "default"` and `intervalMs: 10800000`.

**Synchronous immediate-trigger.** If you don't want to wait at all — useful when iterating on the receiver dispatch path itself — run the probe script synchronously:

```bash
bash scripts/check-update.sh --force
```

The `--force` flag bypasses the last-notified-SHA sentinel so the same `origin/main` SHA re-notifies, which is exactly what you want when you're triggering the receiver flow repeatedly without pushing fresh upstream commits each time. This is the same script the periodic timer fires; only the cadence differs.

### Manual update path

If you'd rather do it by hand:

```bash
cd ~/Projects/agent-bridge
git pull --ff-only origin main
(cd mcp-server && npm install && npm run build)
# then, on the machine running OpenClaw:
openclaw gateway restart
# and if you're in Claude Code right now, reload plugins so MCP + channel reconnect to the new build:
# /reload-plugins
```

Do this on **both** paired machines so they stay in sync — the SFTP-delivered BridgeMessage envelope format occasionally changes between minor versions.

### Stale plugin caches

A separate gotcha when long-running Claude Code/Desktop sessions are involved: the live MCP plugin path is whatever your Claude session was launched with. If your session was launched with a stale `--plugin-dir ~/.claude/plugins/cache/agent-bridge/agent-bridge/X.Y.Z/` flag (older marketplace fetch), `/reload-plugins` reconnects to that *cached* version, not the latest repo build. Symptoms: `claude mcp list` shows ✓ Connected but features from the latest version aren't there, `bridge_*` tools intermittently disappear, version mismatch between `mcp-server/build/` and the running plugin process.

**Diagnose:**
```bash
# What plugin path is the live MCP server running?
claude mcp list | grep agent-bridge
# Should be ~/Projects/agent-bridge/mcp-server/build/index.js, NOT ~/.claude/plugins/cache/agent-bridge/agent-bridge/X.Y.Z/build/index.js

# What plugin cache versions are on disk?
ls -1 ~/.claude/plugins/cache/agent-bridge/agent-bridge/

# Are any node processes still bound to old cache versions?
pgrep -fl 'agent-bridge/[0-9].*build/index.js' | grep -v grep
```

`scripts/update.sh` now handles the normal cleanup path automatically after a successful pull + rebuild: it archives any older cache version directory that is not being used by a running `build/index.js` process. Active stale cache directories are kept in place and logged so the live process is not disrupted.

**Fallback manual cleanup:**
```bash
# Kill any stale node MCP children (safe — they just respawn from the active plugin path on next tool call):
pkill -f 'agent-bridge/3\.[0-8]\.'   # adjust the regex to your old versions

# If the updater could not archive a directory automatically, archive (don't delete; recoverable) old cache dirs:
mkdir -p ~/.claude/plugins/cache/agent-bridge/agent-bridge/.archive
mv ~/.claude/plugins/cache/agent-bridge/agent-bridge/3.7.1 \
   ~/.claude/plugins/cache/agent-bridge/agent-bridge/.archive/
# repeat per stale version

# In your live Claude session: /reload-plugins (or use the self-reload-plugins skill)
```

**Why does this happen?** Claude Desktop sessions cache the plugin path in their launch args at startup. If your machine fetched the marketplace plugin at version 3.7.1 first, every Desktop session started from that point on uses 3.7.1's path until the marketplace serves a newer version AND the session restarts. `/reload-plugins` reloads the BUILD at that path, but doesn't change which path is loaded. To pick up the latest cache version, quit and reopen Claude Desktop. To pick up the latest **repo** version, keep using the symlinked `~/Projects/agent-bridge/mcp-server/build/` path that `agent-bridge install`/`setup` configures (that's what `~/.claude/.mcp.json` will point at if you used Option B / setup).

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

### Document the staleness rules in your harness CLAUDE.md / AGENTS.md

After install, copy the following two debug-first rules into your `~/.claude/CLAUDE.md` (or your harness's equivalent global agent instructions file — `AGENTS.md` for Codex, `USER.md` for some OpenClaw setups). These rules surface the most common silent failure modes for agent-bridge specifically and channel-plugin MCPs in general. Without them, future debugging sessions waste hours chasing "why isn't the new version loading" instead of checking the loading path first.

**Rule 1: Stale / out-of-date plugin install — check first**
> When an MCP plugin / agent-bridge / channel plugin "isn't picking up changes" or "is missing features it should have", verify the actually-loaded plugin version BEFORE assuming a code bug. Run `ps -axww -o pid,command | grep -E "<plugin-name>.*build/index"` (or `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "<plugin>.*build" }` on Windows) to see the path the running MCP child was spawned from. Plugins can be loaded from a **dev clone** path (where `git pull` + `npm run build` updates the file on disk) or a **frozen plugin-cache install** path under `~/.claude/plugins/cache/<name>/<name>/<version>/build/index.js` (which doesn't auto-refresh for directory-source marketplaces). If installed_plugins.json's installPath references a missing or archived dir, the plugin will silently fail to spawn — a `[ -e "$installPath/build/index.js" ]` (bash) or `Test-Path "$installPath/build/index.js"` (PS) preflight check catches this. Fix by editing `~/.claude/plugins/installed_plugins.json` to point installPath at the dev clone's plugin-root subdir (the dir containing `.mcp.json` + `package.json`, e.g. `~/Projects/agent-bridge/mcp-server`), then full Claude Code restart.

**Rule 2: `/reload-plugins` is NOT a hot-reload for MCP child processes**
> `/reload-plugins` re-reads plugin descriptors / skills / hooks but does NOT reliably kill and respawn long-running MCP child processes. Patch F's lease coordination keeps healthy channel-owners alive and demotes /reload-plugins-spawned children to standby. Result: the running plugin keeps its OLD code regardless of how many times you fire /reload-plugins. **Full Claude Code session restart is the only deterministic way to load new MCP code.** The `self-reload-plugins` skill triggers /reload-plugins but does NOT do what its name implies for MCP-child code refreshes — useful for descriptor refreshes only.

These rules are mirrored in [EthanSK/dot-claude](https://github.com/EthanSK/dot-claude)'s `CLAUDE.md` (commits `aefd7bb` and `2017f8f`) and [EthanSK/dot-claude-dell](https://github.com/EthanSK/dot-claude-dell) (`92d1ae6`). Established 2026-04-30 after a multi-hour debug where an MBP agent-bridge MCP child silently died for 2-3 days because its cache install dir was archived; the runtime had no `node ...build/index.js` process at all and 6 bridge messages stacked in the inbox queue waiting forever.

---

## Windows setup

Pairing into a Windows 10/11 machine works fine over `agent-bridge`'s standard SSH transport, but Windows ships with several non-obvious defaults that silently break the pairing flow. Hit them once, save yourself an hour next time.

### Gotchas (and the one-line fix for each)

1. **OpenSSH Server isn't installed by default** (only the client is).
   - Fix: `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic`
2. **The OpenSSH firewall rule only opens port 22 on the `Private` profile.** If your Wi-Fi is classified as `Public`, sshd listens but is firewalled.
   - Fix: `Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private; Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Private`
3. **ICMP echo (ping) is blocked by default**, which makes diagnostics misleading.
   - Fix: `Get-NetFirewallRule -Name FPS-ICMP4-ERQ-In,CoreNet-Diag-ICMP4-EchoRequest-In -ErrorAction SilentlyContinue | Set-NetFirewallRule -Enabled True -Profile Private`
4. **Admins use a different `authorized_keys` file.** For any user in the `Administrators` group, OpenSSH ignores `C:\Users\<user>\.ssh\authorized_keys` and reads `C:\ProgramData\ssh\administrators_authorized_keys` instead. Putting the pairing pubkey in the user's home directory fails silently with `Permission denied (publickey)`.
   - Fix: append the pubkey to `C:\ProgramData\ssh\administrators_authorized_keys` and lock its ACL: `icacls $path /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"` (OpenSSH refuses to read the file if its ACL is broader than that).
5. **Off-LAN reachability needs Tailscale.** Standard residential NAT won't give you a stable WAN IP. Tailscale provides a `100.x.y.z` tailnet IP usable as `internet_host`.
   - Fix: `winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements`, then `tailscale up` and authenticate in the browser.

### Consolidated PowerShell setup script

Run this in an **elevated PowerShell** (Run as Administrator). It performs the full happy-path setup and prints what to send to the pairing agent. Replace the `$PairingPubKey` value with the public key from the *other* machine's `agent-bridge setup` screen before running.

```powershell
# agent-bridge: Windows pairing setup (run as Administrator)
$ErrorActionPreference = 'Stop'

# --- 1. Pubkey from the OTHER machine's `agent-bridge setup` screen ---
$PairingPubKey = 'ssh-ed25519 AAAA...REPLACE_ME bridge:OtherMachine'

# --- 2. Install + start OpenSSH Server ---
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Start-Service sshd
Set-Service  sshd -StartupType Automatic

# --- 3. Set Wi-Fi profile to Private + enable firewall rule on Private ---
Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } |
    ForEach-Object { Set-NetConnectionProfile -InterfaceAlias $_.InterfaceAlias -NetworkCategory Private }
Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Private

# --- 4. Enable ICMP echo for diagnostics ---
Get-NetFirewallRule -Name FPS-ICMP4-ERQ-In,CoreNet-Diag-ICMP4-EchoRequest-In,CoreNet-Diag-ICMP4-EchoRequest-In-NoScope -ErrorAction SilentlyContinue |
    Set-NetFirewallRule -Enabled True -Profile Private

# --- 5. Install pairing pubkey to the ADMIN authorized_keys file ---
$AdminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
if (-not (Test-Path $AdminKeys)) { New-Item -ItemType File -Path $AdminKeys -Force | Out-Null }
if (-not (Select-String -Path $AdminKeys -SimpleMatch $PairingPubKey -Quiet)) {
    Add-Content -Path $AdminKeys -Value $PairingPubKey
}
icacls $AdminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

# --- 6. Tailscale (off-LAN access) ---
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements
}
# After install: run `tailscale up` in a fresh shell and complete browser auth.

# --- 7. Report ---
$LanIP = (Get-NetIPAddress -AddressFamily IPv4 |
          Where-Object { $_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual' } |
          Where-Object { $_.IPAddress -notlike '169.*' } |
          Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "=== agent-bridge Windows setup complete ==="
Write-Host "User:    $env:USERNAME"
Write-Host "LAN IP:  $LanIP"
Write-Host "Port:    22"
Write-Host "Send these (plus the pairing token from the other machine) back to the pairing agent."
Write-Host "If using Tailscale, also share your tailnet IP after `tailscale up`: tailscale ip -4"
```

After this completes, share `user@LAN_IP:22` (or `user@TAILSCALE_IP:22`) with the agent on the other machine and let it run `agent-bridge pair --name "<windows-machine-name>" --host <ip> --port 22 --user <user> --token <token-from-other-side> --pubkey "<windows-side-pubkey>"`.

### Running the `agent-bridge` CLI on Windows

Pairing/messaging can be driven from either side. The Windows machine can be a passive SSH endpoint (the path above) **or** run the `agent-bridge` CLI itself via Git Bash:

```powershell
# 1. Install Git for Windows (provides Git Bash + bundled SSH tools)
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements

# 2. Install agent-bridge (no admin needed — installs to %LOCALAPPDATA%\agent-bridge\bin)
irm https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.ps1 | iex

# 3. Open a NEW PowerShell window (PATH update only applies to new shells)
agent-bridge --version
agent-bridge setup
```

The installer drops the bash `agent-bridge` script and an `agent-bridge.cmd` shim (which invokes Git Bash) into `%LOCALAPPDATA%\agent-bridge\bin\` and adds that directory to the user PATH. After install, `agent-bridge` works from PowerShell, Command Prompt, or Git Bash itself.

> **Important:** the PATH update is written to the **User** environment scope. New shells pick it up automatically; the shell you ran `install.ps1` from will *not* see it until you close and reopen it. If `agent-bridge` is "not found" right after install, this is almost always why.

### `cmd.exe` semantics — what breaks when piping shell commands to a Windows host

Windows OpenSSH-server uses `cmd.exe` as the default login shell. Several things that work transparently on macOS/Linux silently break across the SSH boundary:

- **`;` is not a command separator in cmd.exe.** Shell pipelines like `cd dir; ls` are interpreted as a single token. Use `&&` (success-chained) or `&` (unconditional) instead. agent-bridge avoids this entirely by using the SFTP subsystem for delivery (3.8.1+) — no remote shell evaluates the command.
- **No POSIX heredocs, no `cat > $dest`, no `mkdir -p`, no `mv -f`, no `$VAR` expansion.** `dest=...` is read as a command name (`'dest' is not recognized...`). The 3.4.x → 3.8.0 send path used a POSIX shell pipeline and was 100% broken against Windows targets — see lifecycle-history `3.8.1` for the migration story.
- **PowerShell is NOT the SSH default shell** unless you explicitly set the registry `HKLM:\SOFTWARE\OpenSSH\DefaultShell`. If you do, the cmd.exe quirks above go away but you inherit a different set of quoting/escaping issues. agent-bridge does not require either — the SFTP-only delivery path is shell-agnostic.

If you find yourself wanting to `agent-bridge run <windows-machine> "...command..."` for diagnostics, prefer single-token PowerShell calls invoked via `powershell.exe -NoProfile -Command "..."` — that gives you a real shell on the remote side without the cmd.exe gotchas.

### Node `os.homedir()` reads `USERPROFILE` on Windows, not `HOME`

Subtle test-isolation footgun discovered while debugging the 3.9.0 spawn tests on Windows. Node's `os.homedir()`:

| Platform | Reads | Falls back to |
|----------|-------|---------------|
| macOS/Linux | `$HOME` | `getpwuid` lookup |
| Windows | `%USERPROFILE%` | `%HOMEDRIVE%%HOMEPATH%` |

A test that does `process.env.HOME = tempDir; spawn(child)` to sandbox a child's home directory works on macOS but **leaks the real home into the child on Windows** — the child's `os.homedir()` ignores `HOME` and reads the unmodified `USERPROFILE`. agent-bridge writes lock files and inbox dirs under `os.homedir()`, so a leaked-home test pollutes the *real* `~/.agent-bridge/` instead of the sandbox.

The fix in 3.9.0's spawn tests (`e397839`, `9d9e585`): override BOTH `HOME` and `USERPROFILE` when sandboxing:

```js
spawn(node, [scriptPath], {
  env: {
    ...process.env,
    HOME: tempDir,
    USERPROFILE: tempDir,   // Windows
  },
});
```

Apply the same pattern to any external test or harness that wraps an agent-bridge process. The same applies to `HOMEDRIVE`/`HOMEPATH` if you really want to be airtight, but `USERPROFILE` is what Node actually reads.

### Stricter ACL on the admin keys file

The earlier gotcha lists `icacls $path /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"` as the fix. That is the **only** acceptable ACL — sshd silently rejects keys if anything else has rights. To verify a known-good state:

```powershell
$acl = Get-Acl C:\ProgramData\ssh\administrators_authorized_keys
$acl.AreAccessRulesProtected   # must be True (inheritance disabled)
$acl.Access | Format-Table IdentityReference, FileSystemRights, AccessControlType
# Expect EXACTLY two entries, both Allow + FullControl:
#   NT AUTHORITY\SYSTEM
#   BUILTIN\Administrators
```

If anything else appears (e.g. `BUILTIN\Users`, `Authenticated Users`, the local user's own SID, or any inherited entry), re-run `icacls` to reset.

### Pubkey rotation — explicitly REMOVE before append

When the peer regenerates its keypair (e.g. after `agent-bridge unpair` + `agent-bridge pair` on the *other* side, or a clean reinstall), the new line must be added to `administrators_authorized_keys` **and the old line must be deleted**. sshd happily reads the file top-to-bottom; a stale matching line just means the old, no-longer-trusted key would still authenticate if the corresponding private key ever leaked. Worse, when debugging, two lines with the same `agent-bridge:<peer-name>` comment make it ambiguous which one actually matched.

A regex-based rewrite via `(Get-Content ... | Where-Object ...)` has a subtle pipeline bug: if the file is *empty* after filtering, `Set-Content` writes nothing and the next `Add-Content` still appends — but Ethan has hit cases where the regex didn't match the line he expected (whitespace, trailing comment differences) and the stale line survived. Use a literal `-Contains` check on the trimmed lines instead:

```powershell
$AdminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$NewKey    = 'ssh-ed25519 AAAA...NEW... agent-bridge:OtherMachine'
$OldKey    = 'ssh-ed25519 AAAA...OLD... agent-bridge:OtherMachine'   # exact line to remove

# 1. Read existing lines, drop the OLD key (literal match, not regex).
$lines = @()
if (Test-Path $AdminKeys) {
    $lines = Get-Content $AdminKeys | Where-Object { $_.Trim() -ne $OldKey.Trim() }
}

# 2. Add the new key only if it's not already present.
if (-not ($lines -contains $NewKey)) {
    $lines += $NewKey
}

# 3. Atomic rewrite (no Add-Content, which can append CRLF surprises).
Set-Content -Path $AdminKeys -Value $lines -Encoding ascii

# 4. Reassert the strict ACL — Set-Content can flip inheritance back on.
icacls $AdminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

# 5. Restart sshd so it re-reads the file (it re-reads on every connection
#    in modern OpenSSH, but a bounce removes any doubt during debugging).
Restart-Service sshd
```

### VPN address gotcha

If a VPN client like Surfshark, Mullvad, or NordVPN is active, `ipconfig`, `Test-NetConnection -InformationLevel Detailed`, and naive "what's my IP" probes can return a tunnel-side address (Surfshark uses `10.x.x.x`). Pairing peers across the LAN need the **physical interface's** IP, not the tunnel's.

```powershell
# Show all profiles and their categories (each NIC, including VPN, is its own profile).
Get-NetConnectionProfile | Format-List Name, InterfaceAlias, NetworkCategory, IPv4Connectivity

# Read the LAN address explicitly off the Wi-Fi (or Ethernet) NIC.
Get-NetIPConfiguration -InterfaceAlias 'Wi-Fi' | Format-List InterfaceAlias, IPv4Address, IPv4DefaultGateway
```

The `NetworkCategory` of the **VPN** profile being `Public` is fine and expected; what matters is that the LAN NIC profile is `Private`. Profile-scoped firewall rules (including `OpenSSH-Server-In-TCP`) only apply on the matching profile.

### Pending-token persistence

`~/.agent-bridge/.pending-token` is created the first time `agent-bridge setup` runs and survives across sessions and reboots. `agent-bridge setup` is idempotent — running it again on an already-configured machine reuses the existing keypair and token rather than rotating them. If you want a fresh token, delete `.pending-token` before re-running setup, or use `agent-bridge unpair` to fully tear down.

### Quick test commands

```powershell
# Is sshd actually listening on 22 (both IPv4 and IPv6)?
Get-NetTCPConnection -LocalPort 22 -State Listen | Format-Table LocalAddress, LocalPort, State, OwningProcess

# Reach the Windows host from itself (sanity) or from another LAN machine (real test).
Test-NetConnection 192.168.1.133 -Port 22

# Verify the firewall rule is enabled on the right profile.
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Format-List Name, Enabled, Profile, Direction, Action

# Confirm the admin keys file content matches expectations.
Get-Content C:\ProgramData\ssh\administrators_authorized_keys
```

### Persistence checklist (post-setup audit)

After running the consolidated setup script, verify each of these is reboot-safe. The whole stack should be persistent: services, firewall rules, ACLs, and keys all live in registry/disk that survives across boots. The one item that can silently break is the **DHCP-assigned LAN IP** — see below.

| # | Item | Verify command | Expected |
|---|------|----------------|----------|
| 1 | sshd service auto-start | `Get-Service sshd \| Format-List Name, Status, StartType` | `Running` + `Automatic` |
| 2 | OpenSSH.Server capability installed | `Get-WindowsCapability -Online -Name OpenSSH.Server*` | `State : Installed` |
| 3 | Firewall rule TCP 22 inbound | `Get-NetFirewallRule -Name OpenSSH-Server-In-TCP \| Format-List Enabled, Profile, Action` | `Enabled : True`, `Profile : Private`, `Action : Allow` |
| 4 | ICMPv4 echo allow on Private | `Get-NetFirewallRule -DisplayName '*ICMPv4*' \| Where-Object {$_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True'}` | At least one of `FPS-ICMP4-ERQ-In`, `CoreNet-Diag-ICMP4-EchoRequest-In`, `CoreNet-Diag-ICMP4-EchoRequest-In-NoScope` enabled on Private |
| 5 | `administrators_authorized_keys` ACL strict | `(Get-Acl C:\ProgramData\ssh\administrators_authorized_keys).Access` | Exactly `NT AUTHORITY\SYSTEM` + `BUILTIN\Administrators` Allow FullControl, no inherited entries (`AreAccessRulesProtected = True`) |
| 6 | Admin keys file content | `Get-Content C:\ProgramData\ssh\administrators_authorized_keys` | One line per peer, no duplicates, no stale rotated keys |
| 7 | Agent-bridge config + keys | `ls ~/.agent-bridge`, `ls ~/.agent-bridge/keys` | `config` (or `.identity`/`machine-name`/`.pending-token`), `agent-bridge_<host>` + `.pub` |
| 8 | Network profile is Private | `Get-NetConnectionProfile` | LAN NIC `NetworkCategory : Private` |
| 9 | LAN IP is static or DHCP-reserved | `Get-NetIPInterface -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4` → `Dhcp` field | If `Dhcp : Enabled`, set a DHCP reservation on the router for this MAC, or convert to a static config — otherwise lease renewal can change the IP and break paired peers' `host` field |

For item 9, if the IP changes, fix it on the **other** machine: `agent-bridge config <windows-machine-name> --host <new-ip>` (or unpair + repair). The Windows side itself doesn't store its own IP anywhere agent-bridge cares about.

### When pairing breaks after a Windows update

Windows feature updates (e.g. 23H2 → 24H2) occasionally:
- Reset the `OpenSSH-Server-In-TCP` rule's profile binding.
- Reclassify the network as `Public` (especially if the SSID was forgotten).
- Reset `administrators_authorized_keys` ACL to defaults.

If `agent-bridge status <windows-machine>` starts failing after an update, re-run the consolidated setup script — it's idempotent and will only fix what's actually broken.

### MCP server registration (Claude Code plugin)

`install.ps1` (and `install.sh` on macOS/Linux) **automatically registers the Claude Code plugin** in `~/.claude/settings.json` when it detects a local clone of this repo. After install + a Claude Code restart, the `bridge_send_message` MCP tool plus the inbound `<channel source="agent-bridge" ...>` push are loaded for every session — no manual settings edit required.

The auto-register step is idempotent (re-running the installer is safe), and silently skips if `~/.claude/` does not exist (non-Claude-Code users) or if no local clone with `.claude-plugin/marketplace.json` is reachable (e.g. installed via the `irm | iex` one-liner — clone the repo and re-run to enable it).

#### Manual registration (if you skipped install.ps1)

Both Mac and Windows use a **directory-source plugin marketplace** rather than a raw `mcpServers` entry, because the same flow exposes both the outbound `bridge_*` tools AND the inbound Claude Code channel push from a single MCP child. Add to `~/.claude/settings.json`:

```jsonc
{
  "extraKnownMarketplaces": {
    "agent-bridge": {
      "source": {
        "source": "directory",
        "path": "C:\\Users\\<you>\\path\\to\\agent-bridge"   // or "/Users/<you>/Projects/agent-bridge" on Mac
      }
    }
  },
  "enabledPlugins": {
    "agent-bridge@agent-bridge": true
  }
}
```

Restart Claude Code (full exit + relaunch — `/reload-plugins` alone may not respawn the MCP child holding the in-memory module). On next session start the plugin loader reads the marketplace's `.claude-plugin/marketplace.json`, resolves the `mcp-server/.claude-plugin/plugin.json`, and spawns `node mcp-server/build/index.js` over stdio.

#### Fallback: raw `mcpServers` entry

If you don't want the plugin marketplace machinery — e.g. on a non-Claude-Code MCP host — register the server directly:

```jsonc
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\path\\to\\agent-bridge\\mcp-server\\build\\index.js"]
    }
  }
}
```

Note: this exposes the `bridge_*` tools but does **not** wire up the Claude Code channel push (the `claude/channel` capability is only emitted when the same process is loaded as a plugin in a Claude Code session). For agent-to-agent push semantics, prefer the plugin route.

#### `extraKnownMarketplaces` alone is NOT enough

A subtle gotcha: declaring the marketplace in `settings.json` is necessary but **not sufficient**. Claude Code's plugin loader requires the plugin to actually be *installed* (registered + cached), not just declared. If only the `extraKnownMarketplaces` block is present, `claude /doctor` reports:

```
Plugin Agent Bridge not found in Marketplace
```

…and the MCP child never spawns. The full registration takes two CLI steps:

```powershell
# Run in a regular shell (not Claude Code itself)
claude plugin marketplace add C:\Users\<you>\path\to\agent-bridge
claude plugin install agent-bridge@agent-bridge
```

Both `install.ps1` and `install.sh` perform these steps automatically when run from a local clone (commit `50c560f`+). If you installed via the `irm | iex` one-liner from a non-cloned location, clone the repo and re-run the installer to trigger plugin registration — the one-liner alone cannot register the marketplace because it has no source path to point at.

#### Plugin cache directory naming

After `claude plugin install`, Claude Code copies the plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and **loads the MCP server from THERE, not from the marketplace source path**. The `<version>` directory name is captured from the plugin manifest at install time — version bumps in the source repo do **not** auto-rename the cache dir. This causes confusion when, for example, a `git pull` brings in 3.9.0 source but the cache dir is still named `3.8.0/` and contains a mix of old + new files (or stale `build/` output).

To force a clean cache refresh after pulling new versions:

```powershell
claude plugin update agent-bridge@agent-bridge
```

This re-copies the source into a fresh cache dir matching the new manifest version. Combine with a full Claude Code restart to ensure the running MCP child is actually the new code (the previous `node mcp-server/build/index.js` process keeps the old module loaded in memory until it dies).

### Stale watcher-lease recovery

The MCP child that owns channel-push has a self-recorded PID in `~/.agent-bridge/locks/claude-code.watcher-lock.json`. If that PID dies abnormally without releasing the lease (Claude Code crash, force-kill, OS reboot mid-session), the next MCP child to start will:

1. Detect the recorded PID is dead via `process.kill(pid, 0)` returning ESRCH.
2. Notice the heartbeat `updatedAt` is stale (> 90 s old).
3. Reap the stale lease and claim channel-owner role.

That auto-recovery covers the clean case. The pathological case is when the recorded PID is still alive but it isn't the actual channel-owner — e.g. an old MCP child orphaned by a previous Claude Code session, or a `bun`/`node` process surviving past its parent. In that case the new spawn falls back to **tools-only** role: `bridge_send_message` works, but inbound messages stage in `inbox/.pending-ack/<target>/` forever and never reach the running Claude session.

Symptoms:
- `bridge_send_message` succeeds in the sender, the file lands on the receiver's disk under `~/.agent-bridge/inbox/.pending-ack/claude-code/<id>.json`.
- The receiver's Claude session never sees a `<channel source="agent-bridge" ...>` block.
- `bridge_inbox_stats` reports a non-zero pending count that never drains.

Recovery:

```powershell
# 1. Find and inspect the recorded lease
Get-Content $env:USERPROFILE\.agent-bridge\locks\claude-code.watcher-lock.json

# 2. Look for orphaned bun/node processes whose parent is no longer Claude
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'bun|node' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine |
  Format-List

# 3. Restart Claude Code FULLY (exit + relaunch).
#    /reload-plugins alone does NOT respawn the MCP child holding the
#    in-memory module — only a full session bounce will.
```

Do **not** manually kill the suspected orphan with `Stop-Process` mid-session — on Claude Code that severs the MCP transport for any *other* plugins (Telegram, etc.) connected through the same parent, requiring a Claude Code restart anyway. Just restart the whole session.

### Pending-ack delivery model (3.9.0+)

Pre-3.9.0, the watcher archived every inbound message the moment `notifications/claude/channel` was written to stdout. Stdout-write success is **not** proof the receiving Claude harness rendered the message into its conversation context, and a crashing/dying child silently dropped messages — Windows reproduced 6 silent drops in one session under that model.

3.9.0 introduces a hybrid pending-ack scheme. Every push goes through a per-target staging dir before archive:

| Directory | Purpose |
|-----------|---------|
| `~/.agent-bridge/inbox/<target>/<id>.json` | Inbound, not yet pushed. |
| `~/.agent-bridge/inbox/.pending-ack/<target>/<id>.json` | Pushed to stdout, awaiting render confirmation. Sidecar `<id>.meta.json` carries `pushedAt`, retry count, listener-count snapshot. |
| `~/.agent-bridge/inbox/.archive/<target>/<id>.json` | Confirmed delivered (alive-evidence + ≥ 5 s elapsed). |
| `~/.agent-bridge/inbox/.failed/.exhausted/<id>.json` | Retry cap (3) exceeded — channel is presumed dead. |

A poll-cycle tick (~2 s cadence) decides between three actions per pending entry:

- **Finalize** if `pushedAt > 5 s` ago AND alive-evidence is present (a tool call landed after `pushedAt`, OR a `bridge_receive_messages` long-poll listener is currently parked, OR the channel-callback was re-registered post-push). Move file to `.archive/`.
- **Re-inject** if `pushedAt > 60 s` ago AND no alive-evidence. Move file back to `inbox/<target>/` for another push attempt; increment retries.
- **Exhaust** if retries hit 3. Move file to `.failed/.exhausted/` and emit `channel.pending_exhausted`.

An additional **escape-hatch** trips when 5+ pushes within 30 s yield zero alive-evidence: the channel is flagged dead, future emissions skip the JSON-RPC notification entirely and stage straight to `.pending-ack/` for the next plugin reload to replay (`channel.dead_escape_hatch` event).

This means a crashed/zombie MCP child or a rendering-broken Claude session no longer silently drops messages — they accumulate in `.pending-ack/` and replay on the next clean watcher startup. Senders see no behavior change. **Versions 3.8.0 and 3.8.1 contained an unrelated SFTP `-E` flag bug** that broke cross-platform sends on macOS and older Windows OpenSSH; if you're still on 3.8.x, upgrade to ≥ 3.8.2 (`b08160c`).

### Surfshark / VPN DNS hijack vs Tailscale

Surfshark (and similar consumer VPNs that ship their own DNS resolvers) hijacks DNS for `controlplane.tailscale.com`, returning sinkhole IPs in the `192.200.0.0/16` range. The Tailscale daemon's first task on `tailscale up` is to reach `controlplane.tailscale.com` to register the device — when DNS returns a sinkhole IP, the connection silently times out and the browser auth URL never opens. Symptoms:

- `tailscale up` hangs without printing a login URL.
- `Resolve-DnsName controlplane.tailscale.com` returns `192.200.0.x` instead of a real `*.tailscale.com` AAAA/A record.
- `tailscale status` shows `NoState` indefinitely.

Two workarounds:

1. **Disconnect Surfshark for the auth step.** Run `tailscale up`, complete the browser auth, wait for `tailscale status` to show `Logged in` and an assigned `100.x.y.z` IP, then re-enable Surfshark. The persistent auth state survives the VPN reconnect.
2. **Surfshark Bypasser exemption.** Add `tailscaled.exe` (the daemon binary, typically `C:\Program Files\Tailscale\tailscaled.exe`) plus the hostnames `controlplane.tailscale.com` and `login.tailscale.com` to Surfshark's Bypasser list. This routes Tailscale traffic outside the VPN tunnel.

Mullvad and other DNS-hijacking VPNs exhibit identical symptoms — same workaround applies.

### Cold-bootstrap (one manual auth click)

Tailscale's CLI does not include a subcommand to mint auth keys — that operation lives behind the admin API (PAT or OAuth client). Without preconfigured credentials, a brand-new device joining the tailnet for the first time **must** complete one browser-based auth click. There is no fully-zero-touch flow available from `tailscale up` alone.

For repeat-friendly automated provisioning, generate a one-time Personal Access Token from the Tailscale admin console (`https://login.tailscale.com/admin/settings/keys`), then mint reusable auth keys via the API:

```powershell
$pat = '<your-pat>'
$tailnet = '<your-tailnet>'
$body = @{
  capabilities = @{
    devices = @{
      create = @{
        reusable = $true
        ephemeral = $false
        preauthorized = $true
        tags = @('tag:bridge')
      }
    }
  }
  expirySeconds = 7776000  # 90 days
} | ConvertTo-Json -Depth 5

$auth = "Bearer $pat"
$resp = Invoke-RestMethod -Method Post `
  -Uri "https://api.tailscale.com/api/v2/tailnet/$tailnet/keys" `
  -Headers @{ Authorization = $auth } `
  -ContentType 'application/json' `
  -Body $body

$resp.key  # tskey-auth-... — feed this to `tailscale up --auth-key=...`
```

Subsequent devices can join with `tailscale up --auth-key=$key --hostname=<name>` and skip the browser entirely. The PAT itself still requires a one-time click in the admin console to create.

---

## CLI reference

| Command | Description |
|---------|-------------|
| `agent-bridge setup` | Enables SSH, generates keys, and displays a pairing screen. |
| `agent-bridge pair` | Interactive or flag-based pairing to connect to another machine. |
| `agent-bridge config <machine>` | View or set machine config (e.g. `--internet-host`, `--internet-port`). |
| `agent-bridge connect <machine>` | Open an interactive SSH session. |
| `agent-bridge status [machine]` | Check whether machine(s) are reachable on the configured endpoint: `internet_host` when present, otherwise LAN `host`. `--probe`/`--fresh` are compatibility no-ops in 3.4.2+. |
| `agent-bridge list` | List all paired machines (shows internet_host if set). |
| `agent-bridge run <machine> "cmd"` | Run a PLAIN shell command on a paired machine (diagnostics only — no agent wrapping). |
| `agent-bridge reset-path <machine>` | Compatibility command for clearing old path-cache files. It no longer changes endpoint selection in 3.4.2+. |
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

**v2.2.0** added Claude Code push by advertising the experimental `claude/channel` capability from the same MCP stdio server that exposes the `bridge_*` tools. OpenClaw push is a different integration: the native `openclaw-channel/` plugin runs under the OpenClaw gateway and dispatches inbound bridge files through OpenClaw's channel runtime. Other MCP hosts can use the tools, but complete inbound polling flows are still scaffolded/unverified until a harness-specific target is proven.

### Push vs polling

| Delivery mode | How it works | Harness support |
|---------------|--------------|-----------------|
| **Claude Code push** | MCP child watches `inbox/claude-code/` and emits `notifications/claude/channel`; messages appear as `<channel source="agent-bridge" ...>` tags. | Claude Code plugin (`claude/channel` over stdio) |
| **OpenClaw push** | OpenClaw gateway loads [`openclaw-channel/`](openclaw-channel/README.md), watches `inbox/openclaw/<target>/`, and dispatches a real OpenClaw turn via `dispatchInboundReplyWithBase`. | OpenClaw native channel plugin |
| **Manual/polling fallback** | Agent calls `bridge_receive_messages` to inspect/consume the local Claude Code-target inbox. | Diagnostics and unverified MCP-host scaffolding |
| **Long-poll (3.8.0+)** | Subagent calls `bridge_receive_messages({ wait: true, timeout_seconds: 30, peek: true })` and the MCP child blocks until a message arrives or the timeout fires (cap 60 s). | Subagents on either machine that can't see channel pushes |

### MCP tools

| Tool | Description |
|------|-------------|
| `bridge_list_machines` | List paired machines and their connection details |
| `bridge_status` | Check if a machine is reachable via SSH (single or all) |
| `bridge_send_message` | Send a message to a running agent on another machine |
| `bridge_receive_messages` | Manual inspection/consumption of the local Claude Code-target inbox (not needed in normal push mode). 3.8.0+ supports long-poll: pass `wait: true` to block until a new message arrives, `timeout_seconds` (default 30, server cap 60) to bound the wait. On timeout the tool returns `{ count: 0, messages: [], timed_out: true }`. See ["Subagent receive pattern"](#subagent-receive-pattern-380) below. |
| `bridge_run_command` | Run a shell command on a remote machine via SSH |
| `bridge_clear_inbox` | Clear all messages from the local inbox |
| `bridge_inbox_stats` | Get inbox statistics: pending count, oldest message age, watcher health, etc. |

> **Note:** The MCP server does NOT spawn new agent processes. It enables _existing running_ agent sessions to communicate. Machine A's agent sends a message to Machine B's inbox, and Machine B's already-running agent picks it up via Claude Code channel push, the OpenClaw native channel plugin, or a manual `bridge_receive_messages` fallback where that harness has been explicitly wired and tested.

### Subagent usage

All agent-bridge MCP tools (`bridge_send_message`, `bridge_status`, `bridge_run_command`, `bridge_inbox_stats`, `bridge_list_machines`, `claude_code_channel_status`, `bridge_clear_inbox`, `bridge_receive_messages`) ARE accessible to Claude Code subagents and OpenClaw subagents. The earlier-circulating belief "subagents can't access bridge MCP tools" is incorrect.

**For sending:** subagents call `bridge_send_message` directly. Note that subagents in Claude Code load tools as DEFERRED SCHEMAS — they must run `ToolSearch select:mcp__plugin_agent-bridge_agent-bridge__bridge_send_message` (or the broader bridge selection) before invoking, otherwise they'll hit `InputValidationError`. This is just a one-line schema-fetch, not a real limitation.

**For receiving:** the channel-push stream (inbound `<channel source="agent-bridge" ...>` blocks) only lands in the running parent Claude Code session — the watcher pushes via the parent's conversation transport, not the subagent's. Subagents that need to receive a bridge reply call `bridge_receive_messages(wait: true)` to actively poll. This is documented intentional design (see ["Subagent receive pattern"](#subagent-receive-pattern-380) below).

**Workflow that works in subagents:**

```text
ToolSearch select:mcp__plugin_agent-bridge_agent-bridge__bridge_send_message,...
bridge_send_message(machine="...", target="...", message="...")
bridge_receive_messages(wait: true, timeout_ms: 60000)  # for replies
```

File-drop workarounds (writing JSON directly into peer's `~/.agent-bridge/inbox/<target>/<id>.json` via SCP) are NOT needed and should not be used — they bypass the watcher's validation/lease guarantees.

### Subagent receive pattern (3.8.0+)

Channel-push notifications (`<channel source="agent-bridge" ...>`) reach the **parent** Claude Code session, not subagents spawned by the Task tool. A subagent that needs to wait for a bridge reply should long-poll `bridge_receive_messages`:

```js
// In a subagent that needs to receive replies:
while (true) {
  const res = await bridge_receive_messages({ wait: true, timeout_seconds: 30, peek: true });
  if (res.timed_out) continue;  // re-poll
  // process res.messages...
  break;
}
```

`wait: true` makes the MCP tool block until a new message arrives in `inbox/claude-code/` or the timeout fires (server caps `timeout_seconds` at 60). On timeout, the response is `{ count: 0, messages: [], timed_out: true }`. The watcher's in-process arrival registry broadcasts to every concurrent waiter (parent + N subagents), so use `peek: true` to leave the file in place for the parent's channel-push consumer to also see; `peek: false` is destructive first-come-first-served. For real fan-out to a specific subagent, send each subagent a unique `from_target` so replies route to per-subagent inbox subdirs.

### Same-machine delivery (3.5.0+)

`bridge_send_message` accepts the **local machine name** (or one of the reserved aliases `local`, `self`, `localhost`) and writes the BridgeMessage JSON directly to `~/.agent-bridge/inbox/<target>/<id>.json` with no SSH hop:

```text
bridge_send_message({ machine: "local", message: "review the queue", target: "openclaw/clawdiboi2" })
```

The atomic write pattern matches the SSH path, so the receiver's file watcher never sees a partial JSON file. Use this when one MCP host needs to fan a message out to another agent harness on the **same** machine — for example, a Claude Code session messaging the OpenClaw embedded Telegram sessions running in the same OpenClaw gateway. The receiver still needs a watcher on its inbox subdir (Claude Code channel plugin, `openclaw-channel`, etc.); agent-bridge just lands the file.

`bridge_run_command` and `agent-bridge run` reject the local machine name — there is no SSH loopback. `bridge_status` and `bridge_list_machines` always show the local pseudo-machine as `LOCAL — same-machine delivery, no SSH`.

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
1. The plugin's `.mcp.json` registers a single `agent-bridge` MCP server and sets `AGENT_BRIDGE_ROLE=channel-owner`.
2. That same stdio server declares the `claude/channel` experimental capability AND the `bridge_*` tools.
3. When a message arrives in `~/.agent-bridge/inbox/claude-code/`, the watcher-owner pushes it via `notifications/claude/channel`.
4. It appears in the conversation as: `<channel source="agent-bridge" from="MachineName" message_id="..." ts="...">content</channel>`.
5. Respond using `bridge_send_message` — no need to call `bridge_receive_messages` unless you are debugging a tools-only/manual setup.

**Lifecycle caveat:** the Claude Code watcher is not a separate always-on daemon. It lives inside Claude Code's plugin MCP child on the same stdio/JSON-RPC transport used for tools. Current releases keep the active watcher alive across benign stdin/stderr/SIGTERM closure, keep channel-capable non-owners as standbys that can promote when the active owner goes stale, and replay undelivered messages on startup. If Claude fully reaps all plugin children, delivery still waits for the next live channel-owner/replay. This is intentionally different from OpenClaw's gateway-hosted `registerChannel()` plugin.

The bash `agent-bridge` CLI (used for `pair`, `list`, `status`, `run`, `connect`) coexists with the plugin and is still installed via `./install.sh`.

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

OpenClaw connects to agent-bridge in two separate pieces: the MCP server provides outbound `bridge_*` tools, and the native `openclaw-channel/` plugin provides push delivery. Without the channel plugin, OpenClaw can still use the MCP tools but inbound delivery is only a manual/scaffolded polling path; with the plugin, messages arrive as real OpenClaw inbound turns. This reaches the same product goal as Claude Code push, but through OpenClaw's gateway/plugin lifecycle rather than Claude's MCP stdio channel lifecycle.

**Step 1 -- MCP server (gives you bridge tools):**
```bash
openclaw mcp set agent-bridge '{"command":"node","args":["/absolute/path/to/agent-bridge/mcp-server/build/index.js"],"env":{"AGENT_BRIDGE_ROLE":"tools-only"}}'
```

**Step 2 -- install the skill:**
```bash
cp -r skills/openclaw ~/.openclaw/workspace/skills/agent-bridge
```

**Step 3 -- enable push delivery:**

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
Registers `agent-bridge` as a first-class OpenClaw channel (same tier as Telegram) via `api.registerChannel()`. Inbound messages dispatch through `dispatchInboundReplyWithBase` from `openclaw/plugin-sdk/compat` — the same dispatch primitive used by the native IRC / Nextcloud Talk channels — so a bridge message arriving for a Telegram-bound target runs a real agent turn and the reply lands in the Telegram chat. No CLI shell-out, no scanner bypass. Cross-harness outbound replies SFTP-deliver a `BridgeMessage` back to the sender. Keep the MCP server in `tools-only` mode on OpenClaw, so only the real Claude Code plugin owns `inbox/claude-code/` delivery. See [`openclaw-channel/README.md`](openclaw-channel/README.md) and [`openclaw-channel/ARCHITECTURE.md`](openclaw-channel/ARCHITECTURE.md).

> **Migrating from v1.3.0 (`openclaw-plugin/`)?** That extension plugin has been removed as of v2.0.0. Delete any `plugins.entries["agent-bridge"]` block from your config and point `plugins.load.paths` at the new `openclaw-channel/` directory. The gateway hot-reloads on config change.

**How OpenClaw push delivery works:**
1. Peer's `bridge_send_message` writes a JSON file to `~/.agent-bridge/inbox/openclaw/<target>/` via SFTP over SSH
2. The channel plugin's file watcher sees the new file
3. The plugin resolves the canonical session route via `runtime.channel.routing.resolveAgentRoute(...)`, builds a synthetic inbound ctxPayload with `Provider: "telegram"` + `OriginatingChannel: "telegram"` + `OriginatingTo: "telegram:<peerId>"`, and calls `dispatchInboundReplyWithBase` — a synchronous agent turn runs in the target session and the agent's reply is sent out through `runtime.channel.telegram.sendMessageTelegram(...)`, landing in the matching Telegram chat
4. For cross-harness replies (peer is ALSO agent-bridge-aware), the plugin SFTP-delivers a reply `BridgeMessage` back to the sender's inbox via the native `agent-bridge` channel's outbound adapter

### Codex (OpenAI) (MCP server -- tools-only / manual fallback)

```bash
codex mcp add agent-bridge -- node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Codex automatically reads `AGENTS.md` from the repo root for bridge CLI instructions.

### Gemini CLI (MCP server -- tools-only / manual fallback)

```bash
gemini mcp add agent-bridge node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

Gemini CLI automatically reads `GEMINI.md` from the repo root.

### General (any MCP-compatible agent)

Register the server using your harness's MCP configuration mechanism, pointing to:
```
node /absolute/path/to/agent-bridge/mcp-server/build/index.js
```

For **push** notifications, Claude Code uses the `claude/channel` experimental capability and OpenClaw uses the native `openclaw-channel/` plugin. Without a verified push integration, MCP-only hosts are tools-only by default; set `AGENT_BRIDGE_ROLE=tools-only` in the MCP server environment when your harness supports it. `bridge_receive_messages` is a manual Claude Code-target inbox fallback, not a proven complete receive loop for Codex/Gemini/Aider. Reference `INSTRUCTIONS.md` for a plain-English description of all commands.

---

## How messaging works

### Send flow

```
1. Agent calls bridge_send_message({ machine: "MacBookPro", message: "check the test results", target: "claude-code" })
2. MCP server creates a JSON message file with UUID, timestamp, TTL, target, and fromTarget
3. The message is delivered to the remote machine's per-target inbox subdir via SSH
   (for example ~/.agent-bridge/inbox/claude-code/<id>.json)
4. A copy is saved locally in ~/.agent-bridge/outbox/ for tracking
```

### Receive flow (push mode -- Claude Code)

```
1. The Claude Code plugin's MCP child owns the claude-code watcher lease
2. Its polling watcher (2s interval) detects a new .json file in inbox/claude-code/
3. Watcher parses the message and checks the .delivered tracker for dedup
4. Channel notification is pushed over stdio via notifications/claude/channel
5. Message appears in Claude's conversation as <channel source="agent-bridge" ...>content</channel>
6. Message ID is recorded in .delivered to prevent re-delivery on restart
7. The delivered file is moved to inbox/.archive/claude-code/ for debug tailing
```

### Receive flow (push mode -- OpenClaw channel plugin, v2.3+)

```
1. Polling watcher (2s interval) detects a new .json file in inbox/openclaw/<target>/
2. Watcher parses the message and checks ~/.agent-bridge/.openclaw-v2-delivered for dedup
3. Plugin resolves the target to an OpenClaw route (auto-discovered Telegram account or explicit targets block)
4. Plugin dispatches via dispatchInboundReplyWithBase, so a real agent turn runs in the resolved session
5. Replies route via agent-bridge when fromTarget is present, or via Telegram when configured/one-way
6. On success, the file is archived under ~/.agent-bridge/archive/openclaw/<target>/ and the ID is ledgered
```

### Receive flow (manual/polling fallback -- unverified MCP hosts)

```
1. Message is written to a target inbox subdir
2. A tools-only/manual agent calls bridge_receive_messages at natural breakpoints
3. Today that tool inspects the local Claude Code-target inbox (inbox/claude-code/)
4. Messages are returned sorted chronologically, deduplicated, and TTL-checked
5. Consumed Claude Code-target messages are deleted from inbox/claude-code/ and their IDs tracked in .processed
```

Codex/Gemini/Aider support remains scaffolded until a harness-specific target and receive loop are tested end-to-end. Do not assume they have the same push lifecycle as Claude Code or OpenClaw.

### Offline recovery

Pending messages remain as JSON files in their per-target inbox subdir until delivered, consumed, expired, or quarantined. For Claude Code push mode, delivered files are archived after a successful channel push, so `inbox/claude-code/` should normally contain only genuinely pending work. On MCP server startup:

1. `inbox/claude-code/` is scanned for messages not yet marked in `.delivered`
2. Undelivered messages are replayed as channel notifications in chronological order
3. Already-delivered stragglers are moved to `inbox/.archive/claude-code/`
4. Replay happens after `server.connect()` so notifications can actually be delivered

The `.delivered` tracker file (`~/.agent-bridge/inbox/.delivered`) prevents duplicate Claude Code notifications across MCP server restarts. This is replay-on-spawn durability, not proof of a separate always-on Claude daemon; the channel path still depends on a live channel-owner MCP child. OpenClaw uses its own `~/.agent-bridge/.openclaw-v2-delivered` ledger inside the gateway-hosted plugin.

---

## Message format

Messages are JSON files stored in the receiver's target-specific inbox subdir, e.g. `~/.agent-bridge/inbox/claude-code/<id>.json`:

```json
{
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "from": "Mac-Mini",
  "to": "MacBookPro",
  "type": "message",
  "content": "The tests are passing now. I fixed the import path in utils.ts.",
  "timestamp": "2026-04-13T01:15:00.000Z",
  "replyTo": null,
  "ttl": 86400,
  "target": "claude-code",
  "fromTarget": "claude-code"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID (`msg-` prefix + UUID) |
| `from` | string | Sender machine name |
| `to` | string | Target machine name |
| `type` | `"message"` / `"command"` / `"response"` / `"reply"` | Message type |
| `content` | string | The message body |
| `timestamp` | string | ISO 8601 creation time |
| `replyTo` | string or null | Message ID this is a reply to (for threading) |
| `ttl` | number | Time-to-live in seconds. `0` = no expiry. Default: `86400` (1 day) |

---

## How messaging looks (diagrams)

### Push mode (Claude Code to Claude Code)

```
Machine A (Claude Code)                   Machine B (Claude Code)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  inbox/claude-code/     │
│ target="claude-code"   │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│                         │               │ file watcher ──> push   │
│                         │               │ <channel ...>hello      │
│                         │               │                         │
│ <channel ...>hi back    │    SSH        │ bridge_send_message     │
│ (pushed automatically)  │<──────────────│ ("Mac-Mini", "hi back") │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

### Manual receive fallback (Claude Code-target inbox)

```
Machine A (MCP client)                    Machine B (manual MCP client)
┌─────────────────────────┐               ┌─────────────────────────┐
│                         │               │                         │
│ bridge_send_message     │    SSH        │  target inbox subdir    │
│ target="claude-code"   │──────────────>│  msg-uuid.json          │
│                         │               │                         │
│ bridge_receive_messages │    SSH        │ bridge_send_message     │
│ -> polls & returns msgs │<──────────────│ target="..."            │
│                         │               │                         │
└─────────────────────────┘               └─────────────────────────┘
```

---

## Directory structure

```
~/.agent-bridge/
├── config                         # Paired machines (INI-style key-value)
├── machine-name                   # Optional: override local machine name
├── .pending-token                 # One-time pairing token (deleted after use)
├── .openclaw-v2-delivered         # OpenClaw delivered-ID ledger
├── inbox/                         # Incoming fan-out root
│   ├── claude-code/               # Claude Code target; pending <id>.json files
│   ├── openclaw/<target>/         # OpenClaw targets; pending <id>.json files
│   ├── .processed                 # Manual-consume dedup tracker
│   ├── .delivered                 # Claude Code channel-delivery dedup tracker
│   ├── .archive/claude-code/      # Claude Code delivered-message archive
│   └── .failed/                   # Quarantine root
│       ├── claude-code/           # Malformed/misrouted files from claude-code/
│       └── _unrouted/             # Legacy flat files with no target
├── archive/openclaw/<target>/     # OpenClaw delivered-message archives
├── outbox/                        # Copies of sent messages (local tracking)
├── logs/                          # MCP server logs
│   └── mcp-server.log
└── keys/                          # SSH key pairs (ED25519)
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

`internet_host` and `internet_port` are optional. When present, current agent-bridge transport paths use `internet_host:internet_port` as the active endpoint instead of the LAN `host:port`. If `internet_host` is absent, LAN is used. The recommended `internet_host` value is a [Tailscale](#internet-connectivity-tailscale) `100.x.y.z` IP.

### Hostname variants (`.lan` / MagicDNS) and safe aliases

The config section name must match the machine label used by the route. If replies are routed to `MacBookPro.lan` but your config only has `[MacBookPro]`, delivery fails with:

```text
paired machine "MacBookPro.lan" not found in ~/.agent-bridge/config
```

Safe fix: keep your canonical section, then add mirrored alias sections for any routed variants (`.lan`, MagicDNS hostname, etc.). Mirror `host`, `user`, `port`, `key`, and `internet_host` (if present).

```ini
[MacBookPro]
host=192.168.1.208
user=ethan
port=22
key=~/.agent-bridge/keys/agent-bridge_MacBookPro
internet_host=100.115.165.121

[MacBookPro.lan]
host=192.168.1.208
user=ethan
port=22
key=~/.agent-bridge/keys/agent-bridge_MacBookPro
internet_host=100.115.165.121
```

Once the alias exists, reply routing resolves again and back-and-forth bridge messaging resumes.

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

For Claude Code ↔ Claude Code agent-to-agent communication:
```
Claude on Machine A                             Claude on Machine B
-------------------                             -------------------
bridge_send_message({ machine: "MacBook", message: "fix the tests", target: "claude-code" })
  |-> SSH writes JSON to ~/.agent-bridge/inbox/claude-code/<id>.json on MacBook
      |-> Claude Code watcher on MacBook picks it up
          |-> channel plugin pushes it into MacBook's RUNNING
              Claude session as <channel source="agent-bridge" ...>
              |-> MacBook's Claude reads it in-context and replies via
                  bridge_send_message back to Mac-Mini
```

No fresh agent is spawned on the remote machine — the message lands in the context of the already-running session. This is the whole point of the project. OpenClaw reaches the same product goal through `openclaw-channel/` and `target: "openclaw/<account>"`. If you want the equivalent of the old `--claude` flag, you don't — use `bridge_send_message` and let the existing remote session handle it.

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
├── .archive/claude-code/     ← Claude Code delivered messages kept for debug tail
├── .failed/claude-code/      ← malformed/misrouted Claude Code-target files
└── .failed/_unrouted/        ← legacy flat files with no routable target

~/.agent-bridge/archive/openclaw/<target>/  ← OpenClaw delivered-message archives
```

**Calling `bridge_send_message`:**

```jsonc
// Talk to Claude Code on the other machine (cross-machine agent-to-agent).
// fromTarget defaults to "claude-code", so replies can route back.
bridge_send_message({ machine: "Mac-Mini", message: "hi", target: "claude-code" })

// Inject into the OpenClaw @Clawdiboi2bot session and let it reply over the bridge:
bridge_send_message({ machine: "Mac-Mini", message: "what's up?", target: "openclaw/clawdiboi2" })

// Deliberate one-way injection: omit fromTarget so OpenClaw can fall back to
// its configured/default visible route instead of a bridge back-channel.
bridge_send_message({ machine: "Mac-Mini", message: "FYI", target: "openclaw/clawdiboi2", one_way: true })
```

There is **no default routing** — a call without `target` is rejected. Legacy flat files that arrive at the root of `inbox/` (from pre-3.4.0 senders) are moved to `.failed/_unrouted/` on next startup with a deprecation log line. Upgrade your senders.

Target strings accept Unicode letters/digits plus `_`, `.`, `-`, `/` (no `..`, no leading/trailing `/`, no `//`, ≤256 chars) so multilingual harness names are allowed.

**OpenClaw target mapping** — the happy path is now **auto-discovery** in `openclaw.json`: each entry under `channels.telegram.accounts` is automatically registered as a bridge target of the same name, routing to `telegram:<account>`. You only need a `targets` block if you want to override that (different peer per bot, non-Telegram target, etc.).

```json
// Auto-discovery (recommended): no `targets` block needed.
"channels": {
  "agent-bridge": {
    "enabled": true,
    "config": {
      "agentId": "main",
      "peer_id": "6164541473"
    }
  },
  "telegram": {
    "accounts": {
      "default":      { "token": "...", "allowFrom": ["6164541473"] },
      "clawdiboi2":   { "token": "...", "allowFrom": ["6164541473"] },
      "clordlethird": { "token": "...", "allowFrom": ["6164541473"] }
    }
  }
}
```

Peer ID is resolved per target from (in order): explicit `targets.<name>.peer_id` → plugin-level `channels["agent-bridge"].config.peer_id` → `meta.user_id` on the global config → first numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`. When no peer can be resolved, the target is skipped with a loud warn log rather than injected to the wrong chat.

Explicit `targets` blocks (advanced override, still fully supported):

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

Each entry resolves to an OpenClaw session route via `runtime.channel.routing.resolveAgentRoute({cfg, channel, accountId, peer})` — for Ethan's `dmScope=per-account-channel-peer` that produces keys of the form `agent:main:telegram:<account>:direct:<peer_id>`. The openclaw-channel plugin calls `dispatchInboundReplyWithBase` (from `openclaw/plugin-sdk/compat`) with a synthetic `ctxPayload` pinned to `Provider: "telegram"` + `OriginatingChannel: "telegram"` + `OriginatingTo: "telegram:<peer_id>"`, which runs a real agent turn and sends the agent's reply back via the live Telegram outbound — same dispatch path a native Telegram DM would take.

**Round-trip bridge replies.** `BridgeMessage` carries an optional `fromTarget` field — the sender's OWN target-id. When an agent replies back over the bridge (cross-harness agent ↔ agent flows), `fromTarget` is copied into the reply's `target` field so the reply lands back in the session that started the conversation. The Claude Code MCP tool now defaults `fromTarget` to `claude-code`; pass `from_target` / `fromTarget` explicitly when sending from another local target (for example `openclaw/default` or `openclaw/clawdiboi2`), and pass `one_way: true` when no bridge reply path should be included.

Listeners are separated by target and lifecycle: Claude Code's channel-owner MCP child watches only `inbox/claude-code/`, while the OpenClaw gateway plugin watches only its configured `inbox/openclaw/<target>/` subdirs. Tool-only MCP hosts should not watch `claude-code` at all. The leases prevent duplicate watchers inside each path, but they do not make Claude Code and OpenClaw the same kind of host process. After a successful push, Claude Code-target files are archived to `inbox/.archive/claude-code/`; OpenClaw files are archived to `~/.agent-bridge/archive/openclaw/<target>/`.

---

## Inbox management

The MCP server includes production-grade inbox management:

| Feature | Description |
|---------|-------------|
| **TTL expiry** | Messages expire after their TTL (default 1 day). TTL `0` = no expiry. |
| **Max-age pruning** | Messages older than 24 hours are pruned regardless of TTL (configurable). |
| **Max inbox size** | Inbox is capped at 100 messages; oldest are pruned first (configurable). |
| **Deduplication** | Processed message IDs are tracked in `.processed`; duplicates are skipped. |
| **Malformed quarantine** | Invalid Claude Code-target JSON files are moved to `inbox/.failed/claude-code/`; legacy flat files go to `inbox/.failed/_unrouted/`. |
| **Delivered archive** | Successfully pushed Claude Code files move to `inbox/.archive/claude-code/`; OpenClaw archives under `~/.agent-bridge/archive/openclaw/<target>/`. |
| **Periodic pruning** | A background timer runs every 5 minutes to clean up expired messages. |
| **File rotation** | The `.processed` and `.delivered` tracker files are rotated when they exceed 512 KB. |

### Environment variable overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_DEFAULT_TTL` | `86400` | Default message TTL in seconds |
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
| `watcher.started` / `watcher.stopped` | mcp-server | polling watcher (2s) up or down |
| `message.received` | mcp-server | inbox file picked up by the watcher |
| `message.pushed_to_channel` | mcp-server | message pushed into the running Claude session |
| `message.push_failed` | mcp-server | channel notification failed |
| `message.send_start` / `message.send_retry` / `message.delivered` / `message.send_failed` | mcp-server | outbound SSH delivery to a remote inbox |
| `tool.bridge_status` / `tool.bridge_run_command` | mcp-server | MCP tool invocation |
| `cli.pair.done` / `cli.unpair.done` / `cli.run.start` / `cli.run.done` / `cli.run.failed` / `cli.status.online` / `cli.status.offline` | CLI | bash subcommands |

### Safety

- **Secrets are redacted** on the way in: known OpenAI/Anthropic/Slack/GitHub/AWS/Bearer/JWT patterns become `[REDACTED]`. Message *content* is never put in `context` — only metadata (id, from, to, length).
- Each context string is truncated to ~2000 chars so a single oversized payload can't bloat the log.
- Writes are POSIX `O_APPEND` — multiple MCP/CLI processes can write the same agent-bridge log concurrently without corrupting lines, subject to the PIPE_BUF atomic-append guarantee. The OpenClaw channel plugin logs through the OpenClaw gateway log.
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

When two machines are not on the same LAN (e.g. one is on mobile data, at a coffee shop, or behind a different NAT), use [Tailscale](https://tailscale.com) to give each machine a stable `100.x.y.z` IP that's reachable from anywhere. Agent-bridge stores that IP as the `internet_host` for the paired machine and, when configured, uses it as the active endpoint for transport instead of the LAN address.

### How agent-bridge uses `internet_host`

Each machine can have two endpoints in its config:

```ini
[MacBookPro]
host=192.168.1.208            # LAN address
internet_host=100.126.23.87   # Tailscale IP (preferred when configured)
internet_port=22
port=22
user=ethansarif-kattan
key=/Users/ethansk/.agent-bridge/keys/agent-bridge_Mac-Mini
paired_at=2026-04-13T00:03:01Z
```

As of 3.4.2, the transport rule is simple: if `internet_host` is configured, agent-bridge dials `internet_host:internet_port` directly. If `internet_host` is absent, it dials `host:port`. This applies to the bash CLI, the MCP server, and the OpenClaw channel plugin outbound reply path.

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

Historical note: older agent-bridge builds raced LAN vs `internet_host` and used a per-machine cache to remember which path last worked. As of **3.4.2**, endpoint selection itself is no longer cache-driven: if `internet_host` is configured we dial it directly, otherwise we use the LAN `host`. The path-cache details below are retained for older logs/notes and compatibility context.

As of **v3.1.0**, agent-bridge kept a tiny per-machine cache of which path last worked:

```json
// ~/.agent-bridge/path-cache.json  (mode 0600)
{
  "Mac-Mini":   { "path": "internet", "ts": 1776473474, "last_success": 1776473474 },
  "MacBookPro": { "path": "lan",      "ts": 1776473400, "last_success": 1776473400 }
}
```

### Current behavior (3.4.2+)

Endpoint selection is deterministic now:

- If the machine config has `internet_host`, agent-bridge dials `internet_host:internet_port` directly.
- If `internet_host` is absent, agent-bridge dials the LAN `host:port`.
- There is no LAN-first probe, no internet fallback, and no cache-based endpoint choice.

This applies to the bash CLI, the MCP server, and the OpenClaw channel plugin reply path. The simple rule avoids stale-cache surprises and avoids wasting a LAN timeout when a machine is off-network.

### Historical cache compatibility

The legacy cache file may still exist at `~/.agent-bridge/path-cache.json`, and the CLI still accepts these commands for compatibility:

```bash
agent-bridge reset-path Mac-Mini
agent-bridge reset-path --all
agent-bridge status --probe Mac-Mini
agent-bridge status --fresh Mac-Mini
```

In 3.4.2+ these commands do **not** change endpoint selection. If a Tailscale IP changes, update the machine's `internet_host` with `agent-bridge config <machine> --internet-host <100.x.y.z>`.

The MCP server's `bridge_status` tool still accepts `{ probe: true }` for API compatibility, but it is a no-op in 3.4.2+.

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

#### Claude Code watcher ownership

Only one process may own `~/.agent-bridge/inbox/claude-code/` at a time. In 3.4.7+, the MCP server refuses to act as that owner when it is launched by a plain tool-only parent that lacks Claude channel flags. This prevents editor helper processes or hidden MCP-only sessions from stealing the `claude-code` watcher lease and silently swallowing bridge messages. The legitimate owner is still a Claude Code plugin MCP child, not an external daemon.

For the real Claude Code channel process, launch Claude with the channel plugin flags (for example `--channels ... --dangerously-load-development-channels plugin:agent-bridge@agent-bridge`). For tool-only hosts, set `AGENT_BRIDGE_ROLE=tools-only` or `AGENT_BRIDGE_DISABLE_WATCHER=1`.

If messages pile up in `~/.agent-bridge/inbox/claude-code/`, inspect the owner first:

```bash
cat ~/.agent-bridge/locks/claude-code.watcher-lock.json
ps -p <pid-from-lock> -o pid,ppid,stat,etime,command
```

A channel-capable owner should have Claude channel flags in its parent command line. If it does not, restart that stale MCP server/parent after upgrading to 3.4.7 so the real channel session can acquire the lease.

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
bridge_send_message({
  machine: "MacBook-Pro",
  message: "review the code in ~/Projects/myapp and suggest improvements",
  target: "claude-code"
})
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
3. Check the target-specific inbox, e.g. `ls ~/.agent-bridge/inbox/claude-code/` or `ls ~/.agent-bridge/inbox/openclaw/default/`
4. Check delivered archives: `ls ~/.agent-bridge/inbox/.archive/claude-code/` and `ls ~/.agent-bridge/archive/openclaw/`
5. Check for quarantined messages: `find ~/.agent-bridge/inbox/.failed -maxdepth 3 -type f -name '*.json'`
6. The watcher polls the inbox every 2 s — no external dependencies (fswatch/inotifywait removed in 3.4.3)

### `paired machine "..." not found` (label mismatch)

This usually means the sender routed to a hostname variant (for example `MacBookPro.lan` or a MagicDNS name), but that exact label is missing in `~/.agent-bridge/config`.

```bash
# On the receiving machine
BASE="MacBookPro"
ALIAS="MacBookPro.lan"

# Confirm the error in OpenClaw logs (if using openclaw-channel)
tail -200 ~/.openclaw/logs/gateway.log | grep -E "$ALIAS|paired machine|agent-bridge/v2"

# Check config sections + connection fields
grep -nE "^\[$BASE\]$|^\[$ALIAS\]$|^(host|user|port|key|internet_host)=" ~/.agent-bridge/config
```

If the alias section is missing, add it and mirror the canonical entry fields. Use the same pattern for MagicDNS hostnames too (for example `[macbookpro.tail52aa3c.ts.net]`). After adding the alias, resend the message and replies should flow both directions again.

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
│   │   ├── tools.ts     # MCP tool definitions (8 tools — 7 user-facing + claude_code_channel_status diagnostic)
│   │   ├── config.ts    # Config loader (INI parser, directory paths)
│   │   ├── inbox.ts     # Message inbox/outbox management, pruning, dedup
│   │   ├── watcher.ts   # File watcher (2s polling, no external deps)
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
