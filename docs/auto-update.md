# agent-bridge auto-update flow

[AUTO-UPDATE-CHECK 2026-04-29] · [PLUGIN-REGISTRY-REWIRE 2026-05-01] · [PERIODIC-UPDATE 2026-05-04]

This doc describes the full auto-update sequence — from the periodic origin
probe down to the post-build self-healing of harness-side plugin registry
entries — and the operator levers for tuning, debugging, and forcing it.

## Overview

Auto-update has **two independent layers**:

- **Layer 1 — In-process probe + receiver-driven runner** (harness-DEPENDENT).
  Runs every 3 hours from inside the running mcp-server process. Notifies all
  local harnesses via `[BRIDGE-UPDATE-AVAILABLE]` bridge messages; one of
  them runs the build under a same-host coord lock.
- **Layer 2 — OS-level periodic updater** (harness-INDEPENDENT). Runs every
  10 minutes via launchd LaunchAgent (macOS) or Scheduled Task (Windows).
  Fires whether or not any Claude Code / OpenClaw harness is alive, so
  unattended Macs and freshly-booted machines still pick up new code.
  See [Periodic update LaunchAgent / Scheduled Task](#periodic-update-launchagent--scheduled-task) below.

Within Layer 1, auto-update has two halves:

1. **Probe** (`scripts/check-update.sh`)
   - Runs every 3 hours from `armAutoUpdateProbe()` in
     `mcp-server/src/index.ts` (initial fire after 30 s, then every interval).
   - `git fetch` against the local checkout's origin/main.
   - If origin is strictly ahead of HEAD, drop a `[BRIDGE-UPDATE-AVAILABLE]`
     bridge message into every harness inbox subdir on this host
     (`~/.agent-bridge/inbox/<target>/...`). Sentinel-based dedup prevents
     re-notifying about the same SHA.
   - The probe NEVER pulls or builds — that's the receiver's job.

2. **Runner** (`scripts/update.sh`)
   - Triggered by a harness receiver (Claude Code or OpenClaw subagent) that
     consumes the bridge message and runs the coord-locked updater.
   - Single-receiver guarantee enforced by `scripts/auto-update-coord.sh`.
   - Steps:
     1. `git fetch` + `git pull --ff-only origin main`
     2. `npm install && npm run build` in `mcp-server/`
     3. **plugin-registry-rewire** (3.14.0+) — see below
     4. Stale Claude plugin cache archive
     5. Claude plugin cache sync
     6. (Optional) OpenClaw gateway restart
     7. `/reload-plugins` automation via `self-reload-plugins` skill

## Plugin-registry-rewire step (3.14.0+)

[PLUGIN-REGISTRY-REWIRE 2026-05-01]

### Why this exists

Before 3.14.0, the auto-update flow only did `git pull && npm run build`. It
did NOT validate that the harness-side plugin registry entries
(`~/.claude/plugins/installed_plugins.json`,
`~/.openclaw/openclaw.json`) actually pointed at a path that exists on disk.

After a manual rewire from a `~/.claude/plugins/cache/<...>/<old-version>/`
path to a `~/Projects/agent-bridge/mcp-server` dev-clone path, the stale
cache-path entry would persist for months. Symptoms: `/reload-plugins` errors,
runtime stuck on an older version even though `git pull` showed the dev clone
on tip-of-main, and confused multi-hour debug sessions trying to figure out
why the rebuild "isn't taking effect."

Ethan's voice 6059 (2026-05-01) spec:

> "Doesn't [agent-bridge] auto-update? Does the auto-update not reinstall the
> plugin on the Claude path? It should, and OpenClaw if it's a different path
> to the repo. When we reinstall, it should make sure — add that rule. That's
> very important because this keeps happening."

### What it does

`scripts/plugin-registry-rewire.mjs` runs three phases of validation. Every
phase targets ONLY the agent-bridge plugin — entries for unrelated plugins
(Repost-with-agent, agent-completion-chime, telegram, etc.) are NEVER
modified.

#### Phase 1 — Claude Code registry

Reads `~/.claude/plugins/installed_plugins.json`. For each entry under any
key matching `agent-bridge@*`:

- If `installPath` does not exist on disk → action triggered (reason
  `missing_install_path`).
- If `installPath` is a Claude-plugins cache path (`~/.claude/plugins/cache/...`)
  AND it doesn't match the current dev-clone plugin-root → action triggered
  (reason `stale_cache_path_dev_clone_active`).

Decision tree:

```
If action triggered:
  If extraKnownMarketplaces.agent-bridge exists (directory-source) in settings.json:
    Strategy B — REMOVE the entry. The marketplace handles registration.
  Else:
    Strategy A — REWIRE installPath to <repo-root>/mcp-server, refresh
    version + lastUpdated.
```

#### Phase 2 — OpenClaw registry

Reads `~/.openclaw/openclaw.json`. For each path in `plugins.load.paths[]`
that BELONGS to agent-bridge (path contains `agent-bridge` AND ends with
`openclaw-channel`):

- If path does not exist → rewire to `<repo-root>/openclaw-channel`.
- If path exists but doesn't match current dev-clone → log warn, leave alone
  (Ethan may be deliberately running an alternate clone).

`plugins.entries["agent-bridge"]` is config-only and has no path field, so
nothing to validate there.

#### Phase 3 — Marketplace registration

Reads `~/.claude/settings.json`. Validates
`extraKnownMarketplaces["agent-bridge"].source.path`:

- If path does not exist → rewire to current repo root.
- If path exists but doesn't match current repo root → log warn, leave alone.

### Safety guarantees

- **Backup before every JSON edit** to `<file>.bak.<unix-ts>`.
- **Re-validate JSON post-edit**; rollback from backup on parse failure.
- **Idempotent** — re-running with no stale state is a clean no-op (single
  `auto_update_runner.plugin_registry_clean` event per harness).
- **Failure does NOT abort the rest of the auto-update flow**. The original
  update still landed; the registry mismatch is a follow-up problem worth
  logging loudly but not blocking on.
- **Cross-platform** — pure Node.js + `node:path`, no shell quoting, no
  `jq -i`. Works on macOS, Linux, and Windows (Git-Bash and native cmd).

### Logging

NDJSON events emitted to `~/.claude/logs/skills.log`, `component:
"agent-bridge"`, `skill: "auto-update-runner"`. Event names:

- `auto_update_runner.plugin_registry_start` — entry, with repo paths and
  dry-run flag.
- `auto_update_runner.plugin_registry_rewired` — one event per registry
  mutation, with `harness`, `action: "removed"|"rewired"`, `before_path`,
  `after_path` (rewired only), `reason`.
- `auto_update_runner.plugin_registry_clean` — emitted when a phase finds
  nothing to do (idempotent path).
- `auto_update_runner.plugin_registry_skip` — emitted when a phase
  deliberately leaves a state alone (e.g. existing-but-different alt clone).
- `auto_update_runner.plugin_registry_backup` — one event per backup file
  created, with `path` and `backup` paths.
- `auto_update_runner.plugin_registry_error` — internal failures (read,
  parse, post-write validation, etc.).
- `auto_update_runner.plugin_registry_done` — terminal event with `changed:
  true|false` summary plus per-harness change flags.

### Manual invocation

For retro-fixing existing fleet machines without waiting 3 hours for the
probe:

```bash
agent-bridge plugin-registry-rewire           # apply
agent-bridge plugin-registry-rewire --dry-run # preview
agent-bridge plugin-registry-rewire --verbose # log to stderr
```

This is the same code path as the auto-update flow's Step 3.

## Periodic update LaunchAgent / Scheduled Task

[PERIODIC-UPDATE 2026-05-04]

### Why this exists

Layer 1's in-process probe only runs while a harness is alive. If Ethan logs
out, kills Claude Code, or boots a Mac that's been off for 12 hours, no
auto-update fires until he relaunches the harness — and at that point the
harness boots from stale code. The historical mitigation was an ad-hoc
LaunchAgent dropped onto MBP and Dell from a 2026-04-29 OpenClaw session,
but Mini was never targeted in that session, leaving Mini's auto-update
strictly harness-dependent.

Layer 2 fixes that by bundling the LaunchAgent / Scheduled Task definitions
INTO the agent-bridge repo. `install.sh` and `install.ps1` provision them on
fresh installs; the `agent-bridge install-periodic-update` CLI verb is the
self-heal lever for retro-fixing existing fleet machines.

### What it does

`scripts/agent-bridge-periodic-update.sh` (macOS / Linux) and
`scripts/agent-bridge-periodic-update.ps1` (Windows) run every 10 minutes
under a per-checkout lock. Each invocation:

1. `git fetch origin --prune`.
2. If origin/main is ahead of HEAD AND working tree is clean →
   `git pull --ff-only origin main`.
3. If pulled OR `mcp-server/build/index.js` is missing OR HEAD changed since
   the last recorded build → `npm install && npm run build` inside
   `mcp-server/`.
4. `agent-bridge plugin-registry-rewire` to self-heal harness-side registry
   drift (idempotent no-op on clean state).
5. **(Optional, when invoked with `--with-openclaw-mcp-repair`)** re-assert
   the OpenClaw `agent-bridge` MCP server entry against the dev clone's
   `mcp-server/build/index.js`. Preserves MBP's pre-2026-05-04 behaviour
   where one OS-level job both updates the bridge and keeps OC's MCP wiring
   fresh.

The body deliberately does NOT restart the OpenClaw gateway and does NOT
type `/reload-plugins` into the user's Claude Code terminal. Both are
interactive / runtime actions outside the scope of a 10-min background job.
Ethan's CLAUDE.md `/reload-plugins is NOT a hot-reload` rule still applies:
to actually load a new mcp-server build, fully restart Claude Code at the
user's own cadence.

### Files

- `scripts/agent-bridge-periodic-update.sh` — macOS / Linux body.
- `scripts/agent-bridge-periodic-update.ps1` — Windows body.
- `scripts/install-periodic-update.sh` — macOS provisioner. Generates
  `~/Library/LaunchAgents/com.ethansk.agent-bridge.periodic-update.plist`,
  bootouts any prior agent under that label, then `launchctl bootstrap
  gui/$UID`. Idempotent.
- `scripts/install-periodic-update.ps1` — Windows provisioner. Registers the
  `AgentBridge Periodic Update` Scheduled Task with a 10-min repeating
  trigger plus a logon trigger. Idempotent.

The launchd Label is `com.ethansk.agent-bridge.periodic-update` (NEW
namespace as of 2026-05-04, renamed from the historical
`ai.openclaw.agentbridge-self-update` since the job now lives in the bridge
repo and is no longer OC-coupled).

### CLI verb

```bash
agent-bridge install-periodic-update                          # plain provision
agent-bridge install-periodic-update --with-openclaw-mcp-repair  # MBP-style: also keep OC MCP wiring fresh
```

Same code path as the `install.sh` / `install.ps1` step. Run this on any
existing fleet machine that was installed before 2026-05-04 to lay down the
new LaunchAgent / Scheduled Task without re-running the full installer.

### Opt-out

Set `AGENT_BRIDGE_NO_PERIODIC_UPDATE=1` in the environment when running
`install.sh` / `install.ps1` to skip the provisioner. The CLI verb itself
ignores the env var — Ethan's explicit invocation always wins.

### Logs

- `~/.agent-bridge/logs/periodic-update.log` — per-run human-readable log
  (also captures launchd's stdout/stderr).
- `~/.claude/logs/skills.log` — NDJSON events under
  `skill: "agent-bridge-periodic-update"` when the
  `~/.claude/scripts/skill-log.sh` helper exists. Same convention as every
  other unified-log skill.

### Migration from the legacy `ai.openclaw.agentbridge-self-update` job

On MBP and Dell the legacy LaunchAgent (`ai.openclaw.agentbridge-self-update`)
remains active alongside the new `com.ethansk.agent-bridge.periodic-update`.
Both run every 10 min so updates happen twice as often during the migration
window — harmless, just slightly noisier in the log. To clean up:

```bash
# macOS
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.agentbridge-self-update.plist
rm -i ~/Library/LaunchAgents/ai.openclaw.agentbridge-self-update.plist
```

On Windows the legacy job (if any) is `AgentBridge Self-Update`:

```powershell
Unregister-ScheduledTask -TaskName 'AgentBridge Self-Update' -Confirm:$false
```

## Operator levers

### Probe

| Env var                                     | Effect |
| ------------------------------------------- | ------ |
| `AGENT_BRIDGE_AUTO_UPDATE_CHECK=0`          | Disable the probe entirely (silent exit 0). |
| `AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS=...`  | Override the 3 h periodic interval. Bounds: 30 s ≤ x ≤ 24 h. Out-of-range values fall back to default with a warn log. |
| `AGENT_BRIDGE_SOURCE_DIR=...`               | Override the dev-clone path the probe runs against. |

### Runner

`scripts/update.sh` flags:

| Flag             | Effect |
| ---------------- | ------ |
| `--auto`         | SessionStart-safe mode — implies `--yes --skip-openclaw`, silent unless real changes. |
| `--yes`          | Answer yes to all interactive prompts. |
| `--skip-openclaw`| Skip the OpenClaw gateway restart. |
| `--skip-reload`  | Skip the `/reload-plugins` automation. |

### Coord lock

`scripts/auto-update-coord.sh` ensures only one same-host receiver runs the
update at a time:

| Env var                                    | Effect |
| ------------------------------------------ | ------ |
| `AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS`   | How long until a held lock is considered stale (default 30 min). |
| `AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS`    | Minimum interval between retries for the same origin SHA (default 5 min). |
| `AGENT_BRIDGE_LOCK_DIR`                    | Override the lock directory (default `~/.agent-bridge/locks`). |

## Debugging

When an auto-update "isn't taking effect", check in this order:

1. **The unified log first.**
   ```bash
   grep '"skill":"auto-update-runner"' ~/.claude/logs/skills.log | tail -50 | jq -s '.'
   grep '"event":"auto_update_runner.plugin_registry_' ~/.claude/logs/skills.log | tail -50 | jq -s '.'
   ```

2. **Is the probe running?** `claude_code_channel_status` reports the loaded
   PID + version. If the version is older than tip-of-main, the running
   process is on stale code and `/reload-plugins` won't fix it (see CLAUDE.md
   "/reload-plugins is NOT a hot-reload" rule). Restart Claude Code.

3. **Is the registry stale?** Run `agent-bridge plugin-registry-rewire
   --dry-run --verbose` to preview what would change. If it reports stale
   entries, run without `--dry-run` to fix them, then restart Claude Code so
   the MCP child boots from the corrected path.

4. **Is the dev clone in the wrong place?** If
   `extraKnownMarketplaces["agent-bridge"].source.path` in
   `~/.claude/settings.json` points at a path that exists but isn't where
   you've been doing dev work, fix it manually — the rewire script
   intentionally won't overwrite an existing-but-different path because that
   could be a legitimate alt-clone.

## Tests

Unit tests for the rewire step live at
`mcp-server/test/plugin-registry-rewire.test.mjs`. Run via:

```bash
cd mcp-server && npm test
```

Coverage: stale-detection (both reasons), Strategy A (rewire) and Strategy B
(remove), multi-entry per-key handling, OpenClaw load.paths rewire, idempotent
re-run, backup creation, alt-clone safety (existing-but-different path is
NEVER overwritten), don't-touch-unrelated-plugins, dry-run.
