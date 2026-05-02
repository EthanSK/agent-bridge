# Changelog

## agent-bridge 3.14.1 — 2026-05-02

### Codex-review fixes for the v3.14.0 plugin-registry-rewire step

Ethan voice 6064 (2026-05-01): "Can you ask Codex to review your changes and fix anything you find?" Codex flagged 2 high + 3 medium concrete bugs in `scripts/plugin-registry-rewire.mjs`. All five are addressed in this patch release. No public API change to the CLI verb, the script's flags, or the audit-log event names.

- **HIGH (atomicity)** — `backupAndWrite()` now writes to a side-file (`<file>.tmp.<unique>`), validates by re-parsing the temp file, and `rename()`s it into place atomically. Previously the function did `copyFileSync(backup) + writeFileSync(real)` in place, which a concurrent reader could observe truncated. Backup filenames now use a `<ms>-<pid>-<crypto-hex>` suffix instead of 1-second resolution, eliminating collisions when two rewire runs land in the same second.
- **HIGH (error swallowing)** — when a phase throws (read-only file, unparseable JSON, write failure), the run now emits `auto_update_runner.plugin_registry_done` at level `error` with an `errors[]` array and exits non-zero. Previously phase errors were caught + logged but the script still finished as a "clean / idempotent" no-op, defeating the warn path in `scripts/update.sh`.
- **MEDIUM (JSONC tolerance)** — `~/.claude/settings.json` and `~/.openclaw/openclaw.json` are now parsed with line-comment, block-comment, and trailing-comma tolerance (after a strict `JSON.parse()` first attempt). Strings are skipped during stripping so `// inside string` and `,` inside string literals are preserved.
- **MEDIUM (cross-platform path equality)** — `pathsEqual()` now canonicalizes via `realpathSync.native()` when paths exist (resolves symlinks on macOS) and lowercases on Windows (case-insensitive filesystem). Idempotent re-runs no longer false-positive as "stale" when symlinks or case differ.
- **MEDIUM (registry shape drift)** — when `data.plugins["agent-bridge@<marketplace>"]` is a single object instead of an array, the script normalizes it to a one-element array and proceeds, logging a warn. Previously the malformed entry was silently skipped — for the very plugin this script owns.

**Tests:** 5 new regression tests (now 17/17 in the rewire suite, full repo 83/83) cover JSONC tolerance, exit-code-on-error, sub-second backup uniqueness, atomic-write code-shape grep, and object→array normalization. All run in isolated sandbox HOME directories.

## agent-bridge 3.14.0 — 2026-05-02

### [PLUGIN-REGISTRY-REWIRE 2026-05-01] Self-healing harness-side plugin registry

Auto-update used to do `git pull && npm run build` and stop there. It never validated whether the harness-side plugin registry entries actually pointed at a path that existed on disk. After a manual rewire from a `~/.claude/plugins/cache/<...>/<old-version>/` cache path to a `~/Projects/agent-bridge/mcp-server` dev-clone path, stale cache-path entries persisted indefinitely — silently causing `/reload-plugins` errors and "stuck on old version" failures across the fleet. Manually-edited fixes had to be re-applied every time the same drift recurred.

Ethan's voice 6059 (2026-05-01): "Doesn't [agent-bridge] auto-update? Does the auto-update not reinstall the plugin on the Claude path? It should, and OpenClaw if it's a different path to the repo. When we reinstall, it should make sure — add that rule. That's very important because this keeps happening."

3.14.0 adds a new step (Step 3 of 7) to `scripts/update.sh` that runs after the npm rebuild and before the cache archive/sync. The step is implemented as a portable Node script (`scripts/plugin-registry-rewire.mjs`) so it works the same on macOS, Linux, and Windows. Three phases of validation, all targeting ONLY the agent-bridge plugin:

- **Phase 1 — Claude Code registry** (`~/.claude/plugins/installed_plugins.json`): for each entry under any `agent-bridge@*` key, check `installPath`. If it does not exist OR points at a stale Claude-plugins cache path while the dev-clone is what's actually running, take action:
  - **Strategy B (preferred)**: REMOVE the entry when a directory-source `extraKnownMarketplaces["agent-bridge"]` entry exists in `~/.claude/settings.json`. The marketplace handles registration on its own.
  - **Strategy A (fallback)**: REWIRE `installPath` to `<repo-root>/mcp-server`, refresh `version` and `lastUpdated`, when the entry is the only registration channel.
- **Phase 2 — OpenClaw registry** (`~/.openclaw/openclaw.json`): walk `plugins.load.paths[]` and rewire any agent-bridge-owned path that doesn't exist. Existing-but-different paths are deliberately left alone (Ethan may run an alt clone). Unrelated entries (Repost-with-agent, agent-completion-chime, etc.) are NEVER touched.
- **Phase 3 — Marketplace registration** (`~/.claude/settings.json`): if `extraKnownMarketplaces["agent-bridge"].source.path` doesn't exist, rewire to current repo root. Existing-but-different paths are left alone.

**Safety:**
- Backup before every JSON edit (`<file>.bak.<unix-ts>`).
- Re-validate JSON post-edit; rollback from backup on parse failure.
- Idempotent — re-running with no stale state is a clean no-op.
- Failure of this step does NOT abort the rest of the auto-update flow. The original update still landed; the registry mismatch is logged loudly and the rest of update.sh continues.
- Strict ownership — only paths matching agent-bridge naming conventions are touched.

**NDJSON events** added to `~/.claude/logs/skills.log` (`component: "agent-bridge"`, `skill: "auto-update-runner"`):
- `auto_update_runner.plugin_registry_start`
- `auto_update_runner.plugin_registry_rewired` (one per mutation, with action/before/after/reason)
- `auto_update_runner.plugin_registry_clean` (one per phase that finds nothing to do)
- `auto_update_runner.plugin_registry_skip` (deliberate leave-alone, e.g. alt clone)
- `auto_update_runner.plugin_registry_backup`
- `auto_update_runner.plugin_registry_error`
- `auto_update_runner.plugin_registry_done`

**Manual operator lever** — new CLI verb for retro-fixing existing fleet machines without waiting 3 hours for the probe:

```bash
agent-bridge plugin-registry-rewire           # apply
agent-bridge plugin-registry-rewire --dry-run # preview
agent-bridge plugin-registry-rewire --verbose # log to stderr
```

Same code path as the auto-update flow's Step 3.

**Tests:** 12 new unit tests at `mcp-server/test/plugin-registry-rewire.test.mjs` cover Strategy A vs B selection, multi-entry handling, OpenClaw `plugins.load.paths` rewire, idempotent re-run, backup creation, alt-clone safety (existing-but-different path is NEVER overwritten), don't-touch-unrelated-plugins, dry-run, and stale cache-path detection. All run in isolated sandbox HOME directories so they never touch real user state.

**Docs:** new `docs/auto-update.md` documents the full sequence end-to-end (probe + runner + rewire) plus operator levers, debugging recipe, and event reference. README's update-flow section gained a Step 3 bullet pointing at the new doc.

Files touched: `scripts/plugin-registry-rewire.mjs` (new), `scripts/update.sh`, `agent-bridge` CLI (new `plugin-registry-rewire` verb + help text), `mcp-server/test/plugin-registry-rewire.test.mjs` (new), `docs/auto-update.md` (new), `README.md`, version bumps in `agent-bridge`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/src/config.ts`, `mcp-server/.claude-plugin/plugin.json`, `mcp-server/test/heartbeat-shutdown-diag.test.mjs`, `mcp-server/test/unified-channel.test.mjs`, `CHANGELOG.md`.

## agent-bridge 3.13.0 — 2026-05-01

### [FLEET-CHIME 2026-05-01] Fleet-aware completion chimes inside Agent Bridge

The old standalone `agent-completion-chime` proof of concept established the sound set, the local active-run state machine, and the OpenClaw `runs.json` fallback watcher, but it was the wrong home for the real feature. Ethan's voice 5990 direction was explicit: the all-complete chime only makes sense with a fleet-wide view across Claude Code and OpenClaw on every paired machine, so the feature now lives inside Agent Bridge itself.

3.13.0 adds a bridge-native chime module under `chime/`:

- **Dedicated Agent Bridge target:** chime traffic uses `target="agent-bridge/chime"` over the existing SSH/Tailscale file transport. No separate network path, daemon repo, or external broker.
- **Per-source distributed state, not one fragile counter:** each machine-local lifecycle emitter owns a `machine + sourceId` snapshot. OpenClaw subagents publish through the documented plugin hooks `subagent_spawning` and `subagent_ended`; Claude Code remains hook-driven via the new `agent-bridge chime ...` CLI helpers.
- **Leased single-owner local service:** one process per machine owns playback + reconciliation using `~/.agent-bridge/locks/agent-bridge-chime.lock.json`, so machines with both Claude Code and OpenClaw active do not double-play sounds or race state updates.
- **Zero-transition Hero logic:** the fleet sound fires only on a strict transition from non-zero to zero, subject to cooldown. Re-observing zero does not replay it.
- **Stale-peer safety:** remote sources that go stale while still advertising active agents stay blocking briefly, then expire after the configurable active-lock TTL (default 30 minutes) so a crashed harness cannot suppress all-complete forever. Stale zero-count peers are ignored.
- **Config + operator surface:** `agent-bridge chime status`, `test`, `config get|set`, and `reset`; config lives in `~/.agent-bridge/chime/config.json` because the existing `~/.agent-bridge/config` file is still an INI-style pairing registry, not a general nested config store.
- **Docs/design note:** README now documents the feature plus suggested Claude Code hook commands, and `docs/agent-bridge-chime-design.md` records the architecture answers and preserves Ethan's verbatim source transcript.

Files touched: `chime/`, `openclaw-channel/src/index.js`, `mcp-server/src/index.ts`, `README.md`, `docs/agent-bridge-chime-design.md`, version bumps in `agent-bridge`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/src/config.ts`, `openclaw-channel/package.json`, `CHANGELOG.md`.

## agent-bridge 3.12.1 — 2026-04-30

### [DEDUP-RECEIVE-INJECT 2026-04-30] Halve duplicate channel pushes for slow-thinking receivers

The hybrid AC delivery flow (3.9.0) re-injects a pending message back into `inbox/` whenever 60s pass with no positive alive-evidence (new tool calls, long-poll listeners, channel-callback re-registration, or later successful channel push). Each re-inject also re-emits the channel notification — meaning the same `<channel source="agent-bridge" ...>` block can be pushed up to 4 times (initial + 3 reinjects) for a single message over ~4 minutes.

In practice this fired whenever the receiver was in a long-thinking state. **Mini agent-bridge.log evidence (2026-04-30 12:26–12:29 UTC):** `msg-0196018e-5fe9-4b80-a5fa-016f8edeebaa` was channel-pushed 4 times with `tool_calls_at_push` stuck at 11 across all pushes — the harness was alive but reasoning, not invoking tools, so the heuristic's tool-call gate stayed false. Ethan reported visible duplicate `<channel>` blocks on the Dell side; same root cause, just amplified by Windows-side workloads with longer pre-tool-call think times.

3.12.1 reduces the maximum duplicate count from **4 to 2** by tuning the two windows in `mcp-server/src/watcher.ts`:

- **`PENDING_REINJECT_MS`: 60_000 → 180_000.** Wait three minutes before assuming the harness silently dropped the push. Reasoning-heavy tasks routinely take 60–120 s before producing a tool call.
- **`PENDING_REINJECT_MAX_RETRIES`: 3 → 1.** A single retry is enough for the legitimate dead-channel scenarios; the dead-channel escape-hatch (5+ pushes in 30 s with no alive-evidence) and handover-on-restart paths still recover any genuinely-lost messages.

Trade-off: a truly-dead receiver wastes 3 minutes before the single reinject (vs 1 minute previously). That is the right tradeoff against the dominant pattern (slow-thinking but alive receiver getting visibly duplicated messages). The escape-hatch + handover-replay paths cover the catastrophic-loss case without requiring multiple reinjects per message.

Test updates: `mcp-server/test/consume-race.test.mjs` cases A, C, D, G updated for the new windows. Case D now exhausts on the 2nd reinject attempt, case G drops from 4 cycles to 2, all 8 tests pass under the new tuning.

Files touched: `mcp-server/src/watcher.ts`, `mcp-server/src/config.ts`, `mcp-server/package.json`, `mcp-server/.claude-plugin/plugin.json`, `mcp-server/test/consume-race.test.mjs`, `agent-bridge` (bash CLI VERSION), `CHANGELOG.md`.

## agent-bridge 3.12.0 — 2026-04-30

### [AUTO-UPDATE-COORD-LOCK 2026-04-30] Same-host receiver coordination lock

3.12.0 formalizes the auto-update receiver coordination contract so multi-target notification fan-out no longer causes same-host Claude Code/OpenClaw receivers to race each other on the shared checkout, npm install, or plugin-cache writes.

- **New `scripts/auto-update-coord.sh` helper.** Provides `run`, `acquire`, `release`, and `status` commands. The preferred receiver path is `./scripts/auto-update-coord.sh run --source-dir "$PWD" --cycle <origin-sha> -- ./scripts/update.sh --auto`, which holds the host-local checkout lock while the updater pulls, builds, syncs plugin cache, and triggers reload.
- **Checkout-scoped lock + state files.** Coordination lives under `~/.agent-bridge/locks/auto-update.<sha256(realpath(source-dir))>.lock` with a sibling `.state` file, so different clones coordinate independently and symlinked paths collapse to the same real checkout.
- **Stale-lock and retry gates.** Locks older than 1800000 ms / 30 minutes (override: `AGENT_BRIDGE_AUTO_UPDATE_STALE_LOCK_MS`) may be reclaimed. Repeated attempts for the same origin SHA are gated for 300000 ms / 5 minutes (override: `AGENT_BRIDGE_AUTO_UPDATE_MIN_RETRY_MS`) so receivers do not spin if a lock is released/reclaimed quickly. Skip exit codes are deterministic: `73` = another receiver holds the lock, `75` = minimum interval active. Legacy second-based aliases remain accepted for compatibility, but the millisecond env vars are the documented contract.
- **Unified coord observability.** The helper writes `auto_update_coord.acquired`, `.released`, `.skipped_locked`, `.skipped_retry_gate`, and `.reclaimed_stale` events to `~/.agent-bridge/logs/agent-bridge.log` with checkout path, cycle SHA, lock/state paths, effective thresholds, and holder/exit metadata.
- **Notification + README contract updates.** `scripts/check-update.sh` now includes the coordinated receiver command and current coord lock/state summary in `[BRIDGE-UPDATE-AVAILABLE]` messages. README documents same-host-only semantics, lock paths, env overrides, unified-log events, exit codes, and the new receiver step 1.5 for both Claude Code and OpenClaw receivers.

Files touched: `scripts/auto-update-coord.sh`, `scripts/check-update.sh`, `README.md`, `CHANGELOG.md`, version bumps in `agent-bridge`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/src/config.ts`, `mcp-server/.claude-plugin/plugin.json`, and version-expectation tests.

## agent-bridge 3.11.1 — 2026-04-30

### [AUTO-UPDATE-TEST-MODE 2026-04-30] Configurable interval env var + live-test recipe

3.11.0 wired the periodic re-probe but left the cadence hard-coded at 3 hours, which made live-testing the auto-update flow practically impossible — you had to either wait the full window or hand-craft a fake `[BRIDGE-UPDATE-AVAILABLE]` BridgeMessage to exercise the receiver path. 3.11.1 adds a small env-var override so the same flow can be validated end-to-end in ~90 seconds, and saves the procedure as a reusable regression-check recipe.

- **`AGENT_BRIDGE_AUTO_UPDATE_INTERVAL_MS` env var.** Override the default 3 h `setInterval` cadence in `armAutoUpdateProbe()`. Bounds: min `30000` (30 s — guards against runaway probes) ≤ value ≤ max `86400000` (24 h). Unparseable / non-positive-integer / out-of-range values fall back to the 3 h default with a `auto_update_check.interval_override_rejected` warn-level log carrying the rejected raw value and the rejection reason. The kill switch (`AGENT_BRIDGE_AUTO_UPDATE_CHECK`) wins over this — if the probe is disabled outright, the override is irrelevant. The initial 30 s delayed first probe is **unaffected**; only the periodic interval is configurable.
- **`auto_update_check.armed` log event.** New unified-log event emitted at arm time with `{intervalMs, source: "env" | "default", script, initial_delay_ms, trigger}` so future debugs can read which interval was actually active without inferring it from elapsed time. The legacy `auto_update_check.scheduled` event is preserved for backwards compat with any log greps / dashboards built against 3.10/3.11.0.
- **README live-test recipe.** New "Live-test recipe" subsection inside "Auto-update receiver behavior" walks through the full validation: set the override in the test peer's MCP env, reload plugins, push a benign commit from another peer, watch the receiver subagent flow kick in, then unset the env to return to the 3 h cadence. Also documents `bash scripts/check-update.sh --force` as the synchronous immediate-trigger when you want to iterate on the receiver path itself without waiting at all.

Files touched: `mcp-server/src/index.ts`, `mcp-server/src/config.ts`, `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/.claude-plugin/plugin.json`, `agent-bridge` (bash CLI VERSION), `mcp-server/test/heartbeat-shutdown-diag.test.mjs`, `mcp-server/test/unified-channel.test.mjs`, `README.md`, `CHANGELOG.md`.

## agent-bridge 3.11.0 — 2026-04-30

### [AUTO-UPDATE-RE-PROBE 2026-04-30] Periodic re-probe + standby-promotion probe

The auto-update probe added in 3.10.0 was a one-shot timer fired ~30 s after MCP server boot, only on `watcherStarted && bridgeRole === 'channel-owner'`. That meant a long-lived channel-owner child outliving the gap between an upstream push and the user's next `/reload-plugins` would never re-probe — it'd sit on a stale checkout indefinitely. Standby children skipped the probe entirely, so a process that booted as standby and only later took over the lease never ran the check at all.

3.11.0 fixes both:

- **Periodic 3-hour re-probe.** The single 30 s `setTimeout` in `mcp-server/src/index.ts` is replaced with an initial 30 s timer plus a `setInterval(probe, 3 * 60 * 60 * 1000)`. Both timers are `unref()`'d so they don't hold the process alive on shutdown, and both are explicitly cleared via the new `stopAutoUpdateProbe()` call wired into the existing shutdown teardown next to `stopWatcher()`. The kill switch (`AGENT_BRIDGE_AUTO_UPDATE_CHECK=0/false/off/no/disabled`) is honoured both at arm time AND on every fire — flipping the env var on a running server makes subsequent fires no-op without restarting.
- **Standby → channel-owner promotion probe.** New `subscribeToPromotion()` hook in `mcp-server/src/watcher.ts` — fires inside the existing `scheduleStandbyRetry()` success path when this child steals the lease from a dead peer. `index.ts` registers a listener that runs an immediate probe (no 30 s wait — the old owner was probably wedged) and arms the 3 h interval at promotion time. So a process that booted as standby, watched its peer die 5 minutes later, and got promoted now correctly enters the auto-update cadence.
- **README documents the receiver subagent-dispatch convention.** New "Auto-update receiver behavior" section in README.md tells receiving agents (Claude Code or OpenClaw) NOT to pull-and-rebuild directly in their main thread — instead dispatch a subagent that does `git fetch && git pull --ff-only` (with `--rebase` fallback), `cd mcp-server && npm install && npm run build`, then `/reload-plugins` (Claude Code) or the OpenClaw equivalent. Claude Code dispatch path is documented (`Agent` tool with `subagent_type: "general-purpose"`, `run_in_background: true`); OpenClaw is marked TBD pending discovery of the equivalent dispatch mechanism.

`scripts/check-update.sh` is unchanged — it still drops a `[BRIDGE-UPDATE-AVAILABLE]` BridgeMessage and writes the sentinel; the pull/build is the receiver's job, exactly as before.

Files touched: `mcp-server/src/index.ts`, `mcp-server/src/watcher.ts`, `README.md`, version bumps in `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/src/config.ts`, `mcp-server/.claude-plugin/plugin.json`, `agent-bridge` (bash CLI VERSION), `mcp-server/test/heartbeat-shutdown-diag.test.mjs`, `mcp-server/test/unified-channel.test.mjs`.

## agent-bridge 3.10.1 — 2026-04-30

### [CONSUME-RACE] Follow-up: no-tool reply alive evidence

Agent Bridge now treats a later successfully-resolved channel notification as alive evidence for older pending-ack entries. This covers the no-tool reply path where Claude receives and answers a bridge message but does not call any Agent Bridge MCP tool before the 60 s safety-net window. Older entries can now finalize after the early-defer window once later channel traffic proves the notification pipe is still moving, instead of being re-injected and duplicated.

- Added `successfulChannelPushCount` bookkeeping in `mcp-server/src/watcher.ts`.
- Pending entries snapshot the successful-push counter when staged, so their own push does not ack itself.
- Added consume-race case H to prove a later push finalizes the older entry without tool-call or reload evidence.

### OpenClaw plugin manifest metadata

The OpenClaw channel plugin manifest now declares `channelConfigs.agent-bridge` with a permissive schema for `channels.agent-bridge`, including the existing nested `config` object. This removes the cold-path manifest warning while preserving current user config compatibility.

## agent-bridge 3.10.0 — 2026-04-29

### Auto-update notifications

[AUTO-UPDATE-CHECK 2026-04-29] — agent-bridge can now notify a running
harness when its source checkout is behind `origin/main`, so the agent
sees an explicit `[BRIDGE-UPDATE-AVAILABLE]` channel message instead of
silently drifting from upstream.

- New script: `scripts/check-update.sh`. Runs `git fetch --quiet`,
  compares `HEAD` to `origin/main`, and — if origin is strictly
  ahead — drops a `BridgeMessage` JSON file into the local
  `~/.agent-bridge/inbox/<target>/` subdir(s). The channel watcher
  picks it up and pushes it into the live Claude Code (or other
  harness) session via the existing `notifications/claude/channel`
  path, so no new transport is introduced.
- Idempotent. The last notified `origin/main` SHA is recorded at
  `~/.agent-bridge/.last-update-notified-head`; subsequent runs skip
  silently until origin advances. Pass `--force` to re-notify.
- Multi-target fan-out by default: drops one message into every
  leaf inbox subdir under `~/.agent-bridge/inbox/` (e.g. `claude-code`,
  `openclaw/<account>`), so any harness on the host that watches its
  own inbox sees the notification. Override with `--target=<name>`.
- MCP server runs the probe automatically ~30 s after `server.connect`
  on the channel-owner only (no multi-notify across sibling MCP
  children). The probe locates the source checkout via
  `AGENT_BRIDGE_SOURCE_DIR` env var, falling back to common locations
  under `$HOME` (`.openclaw/workspace/agent-bridge`,
  `Projects/agent-bridge`, `agent-bridge`, etc.). If no source
  checkout is found the probe is skipped silently.
- Kill switch: set `AGENT_BRIDGE_AUTO_UPDATE_CHECK=0` (or
  `false` / `off` / `no` / `disabled`) to disable the check entirely.
  Default is enabled.

The check is intentionally cheap: just `git fetch` plus a couple of
`rev-parse` calls, no `git pull`, no rebuild. Applying the update
remains an explicit decision (run `scripts/update.sh` from the
harness, or via cron / SessionStart hook).

Verified end-to-end on Windows / Mac mini / MacBook Pro on 2026-04-29:
local self-drop → channel push round-trips through the existing
`notifications/claude/channel` path, and the boot-time probe arms
on `server.connect()` for the channel-owner only.

## agent-bridge 3.9.4 — 2026-04-29

### Update helper: quiet auto mode + stale plugin cache archive

- Added `scripts/update.sh --auto` for Claude Code `SessionStart` hooks. Auto mode implies `--yes --skip-openclaw`, suppresses prompts, and exits silently when no commits were pulled and no rebuild is needed.
- Added stale Claude Code plugin cache cleanup after successful pull + rebuild. Older inactive cache version directories under `~/.claude/plugins/cache/agent-bridge/agent-bridge/` are archived to `.archive/<version>-<timestamp>/`; cache versions still used by a running `build/index.js` process are kept.
- Archive activity is recorded via `skill_log info "agent-bridge.update.archive"` when `~/.claude/scripts/skill-log.sh` is available, with stderr fallback for machines without the Claude skill log helper.
- Documented the current Claude Code `SessionStart` hook syntax for running `scripts/update.sh --auto` on startup/resume, and updated the stale-plugin-cache docs so the manual `mv` cleanup is now the fallback path.

No protocol, SFTP delivery, or message envelope changes.

## agent-bridge 3.9.3 — 2026-04-29

### Fix: recognise current Claude Code channel-capable parents

Claude Code 2.1.x desktop / VS Code hosts advertise `notifications/claude/channel` through the MCP handshake rather than the older `--channels` command-line flags. The 3.9.2 parent-command heuristic therefore demoted legitimate Claude Code plugin starts to `tools-only`, leaving stale `claude-code` watcher leases unreclaimed and pending inbox files unread.

**Fix.** Treat the current Claude Code desktop and VS Code native-binary parent command signatures as channel-capable, while keeping the explicit `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT=1` escape hatch in the plugin MCP env for compatibility.

### Fix: OpenClaw outbound replies use SFTP for Windows targets

The OpenClaw channel adapter still used a POSIX remote-shell sequence for cross-machine replies: `ssh mkdir -p`, `scp` to a temp path, then `ssh mv`. That failed against Windows OpenSSH hosts whose default remote shell is `cmd.exe`; `cmd` treats `-p` as a directory name and does not expand `$HOME`, so OpenClaw-generated Agent Bridge replies could arrive from Windows but fail on the return leg.

**Fix.** `openclaw-channel/src/outbound.js` now mirrors the MCP server send path: build an SFTP batch, create parent directories with `-mkdir`, `put` to a hidden temp file, then `rename` atomically to the final JSON inbox path. `~/` is normalized to a home-relative SFTP path so the same batch works on macOS, Linux, and Windows OpenSSH. Added OpenClaw-channel SFTP path/batch tests.

### Follow-up: remove remaining remote-shell file helpers/docs drift

A full scan found the runtime delivery paths were SFTP, but two exported MCP helper functions still used POSIX remote-shell commands (`cat` / `ls`) even though they are not used by the current send/receive path. They now use SFTP `get` / `ls -1` batches through the same preferred endpoint and retry wrapper as `sshWriteFile`, so future file-read/list call sites cannot accidentally reintroduce Windows `cmd.exe` shell assumptions. Current README/site/OpenClaw-channel wording now says SFTP, not SCP, for Agent Bridge message delivery.

## agent-bridge 3.9.1 — 2026-04-28

### [CONSUME-RACE] Fix — re-inject retry counter never incremented past 1

The 3.9.0 hybrid-AC path had a critical bug: `reinjectPending` deleted
the entry from `pendingDeliveries` after moving the file back to
`inbox/`. The watcher's next poll detected the file as "new" and
`emitChannelNotification` called `stagePendingAck(fileName, msg.id, 0)`
— passing literal `0` for retries. The fresh entry forgot it had
already been re-injected. Each 60s safety-net tick computed
`newRetries = 0 + 1 = 1`, never exceeded the cap of 3, and the file
ping-ponged forever between `inbox/` and `.pending-ack/`.

Real-world impact: Mac Mini observed the same channel push 5+ times
because `.failed/.exhausted/` was never reached. Logs verbatim showed
"retry 1/3" on every cycle, indefinitely.

**Fix.** Added an in-memory `retriesByMsgId` map in `watcher.ts` that
persists ACROSS the `pendingDeliveries.delete()` →
`stagePendingAck()` boundary. `stagePendingAck` consults the map first
and uses the persisted count instead of the param when present.
`finalizePending` and the exhausted-path branch of `reinjectPending`
GC the entry. Process restart resets the map, but that's fine — the
safety-net replay window resets too, and handover replay bounds it.

### Test coverage

- `consume-race.test.mjs` adds case G: drives reinject 4 times in a row
  with `_processPendingDeliveriesForTesting` and asserts the file lands
  in `.failed/.exhausted/` after retries=3 (cap exceeded).

## agent-bridge 3.9.0 — 2026-04-28

### [CONSUME-RACE] Hybrid AC pending-ack delivery — fixes silent message drops

Pre-3.9 the channel watcher called `markDelivered` + `archiveDeliveredMessage`
the moment `savedChannelCallback` resolved. The promise resolves when the
JSON-RPC notification has been written to the MCP server's stdout — but
**stdout-write success is NOT proof the receiving Claude harness rendered
the message** into its conversation context. Windows reproduced 6 silent
drops in one session under that model: each message was happily moved to
`.archive/`, the `.delivered` ledger grew, and the Claude session never saw
any of them.

3.9.0 implements **Option AC (hybrid)**: every push goes through a
`.pending-ack/<target>/` staging area, and a per-poll-cycle tick decides
whether to finalize (early-defer + alive-evidence) or re-inject (safety-net
+ no alive-evidence) for retry.

#### What changed

- **Pending-deliveries map** in `mcp-server/src/watcher.ts`. Each entry
  carries `{id, fileName, pendingPath, metaPath, pushedAt, retries, target,
  listenersAtPushTime, toolCallsAtPushTime, hadError, escapeHatch}`.
- **Replaced optimistic markDelivered**. After `savedChannelCallback(msg)`
  resolves, the inbox file moves to `.pending-ack/<target>/<id>.json` with
  a `<id>.meta.json` sidecar. `markDelivered` and archive happen only after
  positive confirmation.
- **`processPendingDeliveries` tick**, run every poll cycle (~2 s):
  - **C-style early defer (5 s window)** — if `pushedAt < now - 5000`,
    watcher still owns the lease, no error was seen, AND alive-heuristic
    returns TRUE → finalize: archive + markDelivered + drop entry.
  - **A-style safety net (60 s window)** — if `pushedAt < now - 60000`
    AND alive-heuristic returns FALSE → re-inject: move file from
    `.pending-ack/` back to `inbox/`, increment retries.
  - **Retry cap (3)** — fourth re-inject attempt moves the file to
    `.failed/.exhausted/` and emits a fatal-level
    `channel.pending_exhausted` event.
  - **Escape-hatch** — 5+ pushes within 30 s with no new tool calls AND
    no long-poll listeners flips the channel dead. Future emissions skip
    the callback and stage straight to `.pending-ack/` for the next
    plugin reload to replay (`channel.dead_escape_hatch` /
    `channel.dead_escape_hatch_skip` events).
- **Alive-heuristic** — returns TRUE when ANY of:
  1. `toolCallsReceivedCount > pending.toolCallsAtPushTime`
  2. `inboxArrivalListenerCount() > 0` (a `bridge_receive_messages` long-poll
     is currently parked, proving the harness is alive and waiting).
  3. `savedChannelCallbackRegisteredAt > pending.pushedAt` (a plugin
     reload happened mid-flight; the new owner gets a clean retry).
- **Lease-handover compatibility** — files left in `.pending-ack/` after a
  lease loss are recovered by `replayUndeliveredMessages`. Sidecars are
  cleaned up; pushedAt is reconstructed from file mtime; anything older
  than 30 s gets re-injected back into `inbox/`.
- **`server.registerTool` shim** in `index.ts` — every tool invocation
  (not just `claude_code_channel_status`) increments
  `toolCallsReceivedCount` so the alive-heuristic sees ALL Claude tool
  traffic as positive evidence.

#### Tests

- `mcp-server/test/consume-race.test.mjs` — 6 new cases: silent-drop
  reinject, early-defer finalize, 60 s safety-net reinject, retry-cap
  exhaustion, lease-handover replay, escape-hatch.
- `mcp-server/test/unified-channel.test.mjs` — end-to-end delivery test
  updated to assert the new `.pending-ack/` staging behaviour and the
  `channel.pending_staged` event.
- 48 existing + 6 new = **54 tests, 0 failures.**

#### Compatibility

The `.delivered` ledger format and the `.archive/<target>/` layout are
unchanged. The new `.pending-ack/<target>/` and `.failed/.exhausted/`
subdirs are created on first run by `ensureDirectories` —
no migration required. Senders see no behaviour change.

## agent-bridge 3.8.2 — 2026-04-26

### Fix: drop unsupported `-E` flag from sftp args (macOS)

3.8.1's new SFTP send path passed `-E <clientLog>` to `sftp(1)` to capture
client-side diagnostics. Modern Linux/Windows OpenSSH-portable 8.6+ supports
that flag on sftp, but **macOS ships an older OpenSSH fork whose sftp does
not accept `-E`** — every cross-machine `bridge_send_message` from a macOS
host failed with:

```
sftp: illegal option -- E
```

making 3.8.1 effectively unusable for Mac→anywhere delivery.

3.8.2 removes `-E clientLog` (and the paired `-o LogLevel=INFO`) from the
`sftpExecSingle` arg list in `mcp-server/src/ssh.ts`. The spawn stdout/stderr
capture already surfaces sftp errors, so no diagnostics are lost in practice
— only the verbose per-connection client log file is gone. If verbose
logging is needed for ad-hoc debugging, add `-v` (universally supported)
instead. The ssh path (`sshExec` / `buildSSHArgs`) is unchanged because
`ssh -E` is fine on every platform.

## agent-bridge 3.8.1 — 2026-04-26

### Cross-platform send path (`bridge_send_message` works against Windows targets)

`sshWriteFile` previously delivered messages by piping a POSIX shell pipeline
(`dest=...; mkdir -p "$dir"; ... mv -f "$tmp" "$dest"`) over `ssh`. That broke
against Windows OpenSSH-server because cmd.exe doesn't know `dest=`, `mkdir
-p`, `mv`, or `$dest` syntax — every Windows-target send failed before any
bytes hit the disk:

```
Failed to deliver message to SHITTYWINDOWS:
  'dest' is not recognized as an internal or external command,
  operable program or batch file.
```

3.8.1 switches the send path to the **SFTP subsystem**:

- New helpers in `mcp-server/src/ssh.ts`: `normalizeSftpPath`,
  `sftpParentDirs`, `buildSftpBatch`, plus an `sftpExecSingle` runner that
  pipes a batch script into `sftp -b -`.
- `sshWriteFile` now stages the message JSON in a local temp file, then
  invokes `sftp` with `-mkdir <ancestor>`, `put localTmp remote.tmp.<uuid>`,
  `rename remote.tmp.<uuid> remote.json`. Atomic delivery survives because
  the inbox watcher only fires on the rename, never on a partial `*.json`.
- No remote shell involved, so cmd.exe can't choke on the command. The SFTP
  subsystem ships with Windows OpenSSH (`sftp-server.exe`) the same way it
  ships with macOS / Linux OpenSSH. Forward-slash paths normalize to
  backslashes server-side; leading `~/` is stripped because Windows
  OpenSSH-sftp does not expand it.
- Same retry / transient-failure handling as the old SSH path
  (`isConnectionFailure` + `isTransientClientFailure`).

#### Why SFTP and not "SCP-only"?

Both are shell-free. SFTP wins because it has a native `rename` operation,
so we keep atomic temp+rename delivery without needing a cross-platform
`mv`/`move` shim. The watcher's "malformed JSON → quarantine to .failed/"
code path makes non-atomic delivery dangerous; SFTP gives us atomicity for
free on every platform.

#### Tests

- `mcp-server/test/sftp-write-file.test.mjs` — pins `normalizeSftpPath`,
  `sftpParentDirs`, and `buildSftpBatch` (10 new cases, including a
  regression guard that the batch script never contains `$`, `&&`, `mv -f`,
  `mkdir -p`, `cat `, `echo `, or `base64`).
- Existing version-pinned tests bumped to `3.8.1`.

48 tests / 48 passing.

## Unreleased

### Windows install path (cross-platform CLI)

The `agent-bridge` bash script already runs unmodified on Windows under Git Bash — all required tools (`ssh`, `ssh-keygen`, `scp`, `ssh-keyscan`, `tar`, `base64`, `openssl`) ship with Git for Windows or Windows OpenSSH, and the script's existing `command -v jq` checks fall through cleanly when `jq` isn't present. Two new files make that usable from any Windows shell:

- `agent-bridge.cmd` — thin shim at the repo root that detects Git Bash and invokes `bash agent-bridge "$@"`. Lets users call `agent-bridge` from PowerShell or Command Prompt, not just Git Bash.
- `install.ps1` — PowerShell 5.1+ installer that downloads `agent-bridge` + `agent-bridge.cmd` into `%LOCALAPPDATA%\agent-bridge\bin\` and adds the directory to the user PATH. No administrator privileges required.

Quick install on Windows:

```powershell
winget install --id Git.Git -e   # one-time, if Git Bash isn't present
irm https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.ps1 | iex
```

Removes the previous "Windows side doesn't run the agent-bridge CLI itself" caveat — it now does. Pairing flows can be driven from either side.

## agent-bridge 3.8.0 — 2026-04-26

### Long-poll / blocking receive (`bridge_receive_messages`)

`bridge_receive_messages` now accepts two optional parameters:

- `wait: boolean` (default `false`) — when `true`, the tool blocks until a
  message arrives or `timeout_seconds` elapses.
- `timeout_seconds: number` (default `30`, server-capped at `60`) — long-poll
  duration when `wait=true`.

When `wait=true` and the inbox already contains messages, the tool returns
immediately. Otherwise it registers a one-shot listener with the watcher's
in-process arrival registry and races the listener against `setTimeout`. On
timeout the response carries `timed_out: true` in `structuredContent` plus an
empty messages array — additive, so pre-3.8.0 callers (or anyone reading the
text content) are unaffected.

#### Why

Channel pushes (`notifications/claude/channel`) only land in the parent
session that owns the MCP transport — subagents on the same machine do NOT
receive them. Pre-3.8.0, a subagent that needed to wait for a bridge reply
had to busy-poll `bridge_receive_messages` (cost: tokens per poll) or skip
receive entirely. Long-poll is the subagent escape hatch: one MCP call
parks for up to 60 s and returns the moment a message lands.

#### Concurrency / broadcast semantics

Multiple concurrent long-pollers (parent session + N subagents) all wake on
the same arrival — the in-process registry uses **broadcast**, not queue,
semantics. `bridge_receive_messages` is supposed to be idempotent (it
returns the inbox as a snapshot), so broadcast keeps the contract intact.
Whether the file is moved to `.archive/` or stays pending is governed by
the existing `peek` flag: `peek: true` is the safe fan-out path; `peek:
false` (consume) is destructive first-come-first-served and only one
caller will see the message.

For agents that genuinely want one-receiver-only semantics, use a unique
`from_target` per subagent and route replies to that target so they land
in a per-subagent inbox subdir — that's a separate facility, NOT
`bridge_receive_messages`.

#### Implementation

- `mcp-server/src/watcher.ts` — added an `inboxArrivalListeners` Set, a
  `subscribeToInboxArrival(listener)` export that returns an `unsubscribe`
  fn, and `inboxArrivalListenerCount()` for tests. The polling pass in
  `checkForNewFiles` calls `fireInboxArrivalListeners()` after the
  per-file `emitChannelNotification` calls so the channel-push parent
  path runs first.
- `mcp-server/src/tools.ts` — extended the `bridge_receive_messages` Zod
  inputSchema with `wait` + `timeout_seconds`, factored snapshot-reading
  into a local `readSnapshot()` helper, and added the long-poll body
  that races `subscribeToInboxArrival` against a `setTimeout` clamp.
- `mcp-server/test/long-poll-receive.test.mjs` — new test covering all 6
  scenarios from the spec.

#### Test count

37 tests pass (was 31 in 3.7.1 — added 6 long-poll cases).

---

## agent-bridge 3.7.1 — 2026-04-26

### Patch F race fix (standby+retry) + stale-version peer kill

Two follow-on fixes to 3.7.0's lifecycle posture, both observed live during the
3.6.1 → 3.7.0 migration on MBP-Claude (2026-04-26 ~20:29 BST).

#### Bug 1 — Patch F race during version migrations

3.7.0's Patch F exited cleanly when a fresh peer held the watcher lease. That
created a race during `/reload-plugins` and version migrations: a NEW plugin
spawned, saw the OLD plugin's still-fresh heartbeat, and exited; the OLD
plugin then died moments later (Claude Code reaping it as part of the reload),
leaving no successor. Until the next plugin spawn, the machine had **no
channel-owner**.

Live evidence: NEW pids 95679 and 98451 (both 3.7.0) hit
`patch_f.backoff_exit` while OLD pid 34781 (3.6.1 channel-only) held the
lease. OLD got SIGTERM at 20:29:03 and released the lease — but no successor
existed because both NEW plugins had already exited. MBP was left without a
channel-owner.

**Fix.** Replace `process.exit(0)` in Patch F with a "standby + retry" path.
The new plugin:

- Logs `patch_f.standby` (not `patch_f.backoff_exit`) and falls through to
  `main()`.
- `startWatcher` returns `'busy'` and `scheduleStandbyRetry` polls the lease
  every 2 s.
- When the peer's heartbeat goes stale (>15 s old, per
  `watcherLeaseIsStale`), the standby plugin steals the lease and activates
  channel delivery. No race window, no orphan period.

The standby+retry machinery itself is reused from `watcher.ts` —
`scheduleStandbyRetry` was already present for the `tryAcquireWatcherLease`
busy path. 3.7.1 just stops short-circuiting through it.

A compatibility breadcrumb at `~/.agent-bridge/logs/mcp-server-sync-exit.log`
now writes `patch_f.backoff_standby` (suffix changed from `_exit` to
`_standby` so post-mortem tooling can tell new behaviour from old).

#### Bug 2 — Stale-version peers blocking the lease

When a NEW plugin starts and detects that the lease is held by a peer running
an OLDER version, it now actively forces migration:

1. Reads the peer's `version` field from the lock file.
2. If `peer.version < our.version` (semver compare), sends `SIGTERM` to the
   peer pid.
3. Synchronously waits up to 2 s for the peer to exit (polling
   `kill(pid, 0)` every 100 ms via `Atomics.wait` on a SharedArrayBuffer
   `Int32Array` — module-load context, no event loop yet).
4. If the peer is still alive after 2 s, sends `SIGKILL` as a fallback, waits
   200 ms for the kernel to release the pid, and falls through.
5. `main()` runs normally; `tryAcquireWatcherLease` steals the now-stale lease
   and channel delivery activates immediately.

Same-version peers and unknown-version peers are **never killed** — Patch F
respects same/newer and treats unknown-version (lease written by 3.7.0 or
earlier, no `version` field) as same-version for safety. New events for
post-mortem visibility:

- `patch_f.peer_version_kill` — `peer_pid`, `peer_version`, `our_version`.
- `patch_f.peer_version_sigkill` — emitted when the 2 s SIGTERM grace expires.

Lock file format: a new `version: string` field is now written by
`tryAcquireWatcherLease` (sourced from a single `MCP_SERVER_VERSION` constant
in `config.ts`). Older readers that don't know the field simply ignore it
(JSON), so this is forward-compatible with 3.7.0 watchers in the rare case
where a 3.7.1 lease is read by a 3.7.0 sibling.

#### What this changes

- `mcp-server/src/index.ts` — Patch F refactored from `backoff_exit` to a
  branch that either kills (older peer) or stands by (same/unknown
  version). `compareSemver` helper added.
- `mcp-server/src/watcher.ts` — lock file `WatcherLeaseFile` gains an
  optional `version` field; `tryAcquireWatcherLease` writes
  `MCP_SERVER_VERSION`; `readWatcherLease` exposes it.
- `mcp-server/src/config.ts` — new `MCP_SERVER_VERSION` constant (single
  source of truth for tools/index/lease).
- `mcp-server/test/unified-channel.test.mjs` — old `patch_f.backoff` exit
  test rewritten as a standby test; new tests cover (a) standby plugin
  acquiring the lease after the peer's heartbeat goes stale and (b) the
  stale-version peer-kill path end-to-end.

#### Compatibility

- Wire format unchanged — channel notifications, BridgeMessage JSON, and
  the SSH transport are all identical to 3.7.0.
- Lock file format gained one optional field. Forward- and backward-
  compatible with 3.7.0 readers.
- All 8 lifecycle patches (A–H) remain in place. 3.7.1 only replaces
  Patch F's exit path; G and H are untouched.

---

## agent-bridge 3.7.0 — 2026-04-26

### Undo 3.6.0 split: combine tools + channel into one plugin (Telegram pattern)

3.7.0 reverses the 3.6.0 plugin split. The dedicated `claude-code-channel`
plugin is **deleted** and its responsibilities (long-lived inbox watcher +
channel push) are merged BACK into the `agent-bridge` MCP server. There is
now exactly one Claude Code plugin: `agent-bridge`, hosting both the 7
user-facing `bridge_*` tools and the `notifications/claude/channel`
push pipeline in a single process.

#### Why we're doing this — 3.6.0 was based on incomplete root-cause analysis

3.6.0 split the channel watcher out of the MCP server into its own plugin
(`claude-code-channel`) on the assumption that "channel-only plugins survive
longer in Claude Code's plugin host than tool MCP children." That assumption
proved empirically wrong:

- 3.6.0: split shipped. Channel plugin still got reaped within minutes.
- 3.6.1: stopped treating idle stdin as an orphan signal. Reaping continued.
- 3.6.2: Patch G — channel-owner ignores SIGTERM when parent is alive. Host
  escalated to uncatchable SIGKILL ~2 s later (Mac Mini production evidence,
  2026-04-26 12:26 BST: pid 89205 SIGTERM-ignored at 12:26:36Z, gone by next
  poll). Patch G survives the first stage of two-stage termination but not
  the second.
- 3.6.3: Patch H — register a no-op MCP tool (`claude_code_channel_status`)
  on the assumption that tool registration alone tells the host "I'm
  interactive, don't reap me." Reaping continued. Production logs showed the
  no-op tool was never called by the running session, so registration alone
  did NOT cross whatever liveness threshold the host actually checks.

The Mac Mini deployment continued to lose channel delivery roughly every
session-internal idle window, regardless of patches.

#### What the host actually gates on

Telegram (also a channel plugin) survives 21+ hours indefinitely. Telegram
registers four MCP tools (`reply`, `react`, `download_attachment`,
`edit_message`) — and crucially, **those tools get called constantly** during
normal Telegram use. Every reaction, reply, voice-note download, and edit is
an MCP tool call on stdio JSON-RPC. The plugin host's idle-reaper is gated
on **MCP tool-call frequency**, not on tool registration alone. A registered
tool that's never called is functionally invisible to the host.

3.6.3's `claude_code_channel_status` tool was almost never called (Claude
Code agents prefer `bridge_send_message` for actual work), so the channel
plugin still presented as idle to the host. Patches G and H bought a few
seconds at best before the SIGKILL escalation.

#### The fix: one plugin, frequently-called tools

Merge everything back. With the unified plugin:

- Every `bridge_send_message` an agent sends resets the host's idle counter.
- Every `bridge_status` / `bridge_inbox_stats` poll resets the counter.
- The channel watcher and channel push live in the same process, so
  inbound messages are delivered without a second plugin lifecycle to manage.

This is precisely how Telegram works. Same pattern, same lifetime
guarantees. The channel-only architecture was a wrong turn.

#### Architecture changes

- **One plugin.** `agent-bridge` (the existing tools-only plugin name).
  Hosts BOTH the 7 user-facing tools AND the channel watcher. Channel
  capability is declared via `experimental.claude/channel`. Default
  `AGENT_BRIDGE_ROLE` is now `channel-owner` (acquires the inbox lease at
  startup and pushes channel notifications). `tools-only` remains supported
  for non-Claude hosts (OpenClaw / Codex / Gemini-CLI sidekicks that just
  want outbound bridge_* tools without contending for the lease).
- **Lifecycle improvements retained from 3.5.x → 3.6.x.** Persistent stderr
  tee (Patch B), 60s heartbeat (refed when channel-owner), shutdown_diag
  with handles dump, syncExitBreadcrumb to durable log, 3-poll orphan
  watchdog (15s confirmation across `parent dead` OR `stdin destroyed` OR
  `stdin errored`), Patch F (heartbeat-recency guard against parallel
  subagent spawn), Patch G (channel-owner SIGTERM ignore — kept as
  defence-in-depth even though tool-call frequency now does the heavy
  lifting), sibling-MCP step-down via lease file, fatalTransportExit on
  stdout EPIPE.
- **`claude_code_channel_status` no-op tool retained.** From 3.6.3. No
  longer load-bearing for liveness, but useful as a status diagnostic — it
  returns `pid`, `ppid`, `uptime_s`, `version`, `machine`, `watcher_active`,
  `lease`, `tool_calls_received_count`, `tool_boot_time_ms`. The
  `signal.evidence` event from 3.6.3 is also retained, with the same
  forensic fields.
- **Lease heartbeat refed for channel-owner.** `mcp-server/src/watcher.ts`'s
  lease-renewal interval is now refed when `role === 'channel-owner'`
  (previously always unref'd). The unified plugin must keep the event loop
  alive across idle gaps — same posture as the 3.6.0 channel plugin had.

#### Migration steps

After updating to 3.7.0:

1. `claude plugin uninstall agent-bridge-channel@agent-bridge` — drops the
   now-deleted plugin from your install.
2. `claude plugin install agent-bridge@agent-bridge` — reinstalls the
   unified plugin so the cache reflects 3.7.0.
3. **Update your launch alias.** Remove
   `--dangerously-load-development-channels plugin:agent-bridge-channel@agent-bridge`
   from your `claude-tel` (or equivalent) alias. Only
   `--dangerously-load-development-channels plugin:agent-bridge@agent-bridge`
   is needed now.
4. Restart your Claude session. The unified plugin spawns once and stays
   alive throughout (same lifetime as Telegram).

The on-disk wire format is unchanged — `BridgeMessage` JSON shape, the
per-target inbox subdir layout, the `.delivered` / `.processed` ledgers,
the watcher lease path/format, and the SCP outbound path all match
3.6.x byte-for-byte. A 3.6.x peer (running both plugins) and a 3.7.0 peer
(running the unified plugin) interoperate fully — the lease file mediates
ownership when both are present transiently on the same machine.
**Per-machine rollout is supported**: upgrade Mac Mini to 3.7.0 while MBP
stays on 3.6.x and messages flow both ways throughout.

#### Files touched

- **Deleted:** `claude-code-channel/` (the entire package — `src/`, `test/`,
  `package.json`, `package-lock.json`, `.mcp.json`, `.claude-plugin/`,
  `README.md`, `tsconfig.json`, `build/`, `node_modules/`).
- **Updated:** `mcp-server/src/index.ts` — combined channel-owner and
  tools-only paths into one entry point. Default role flipped to
  `channel-owner`. Patches F, G, and H ported in. Heartbeat refed for
  channel-owner. `claude_code_channel_status` tool registered. `signal.evidence`
  event emitted on every signal arrival.
- **Updated:** `mcp-server/src/watcher.ts` — lease heartbeat refed for
  channel-owner role.
- **Updated:** `mcp-server/.mcp.json` — removed `AGENT_BRIDGE_ROLE=tools-only`
  env block (default is now `channel-owner`).
- **Updated:** `mcp-server/package.json`,
  `mcp-server/.claude-plugin/plugin.json` — version bumped to 3.7.0,
  description updated to reflect unified posture.
- **Updated:** `.claude-plugin/marketplace.json` — removed
  `agent-bridge-channel` entry; updated `agent-bridge` description.
- **Updated:** `agent-bridge` (bash CLI) — `VERSION="3.7.0"`.
- **Updated:** `scripts/update.sh` — dropped step 3 (rebuild
  claude-code-channel); renumbered remaining steps.
- **Updated:** `README.md`, `INSTRUCTIONS.md`, `AGENTS.md` — replaced
  3.6.0 split docs with 3.7.0 unified plugin docs and migration notes.
- **Updated:** `mcp-server/test/heartbeat-shutdown-diag.test.mjs`,
  `mcp-server/test/three-poll-watchdog.test.mjs` — version assertions bumped
  to 3.7.0; channel-owner SIGTERM tests opt out of Patch G.
- **New:** `mcp-server/test/unified-channel.test.mjs` — Patch F backoff,
  Patch G SIGTERM ignore, Patch H tool registration + tools/list / tools/call,
  end-to-end inbox delivery via the unified watcher.

## agent-bridge 3.6.3 — 2026-04-26

### Register no-op MCP tool to prevent channel-plugin reaping

3.6.2 added Patch G: when SIGTERM lands on the channel plugin and the parent
Claude Code session is still alive, ignore the signal. The Mac Mini restart
that followed proved Patch G works as designed — `signal.ignored_channel_owner`
fires reliably — but production then revealed the next layer: Claude Code's
plugin host escalates to **uncatchable SIGKILL ~2 s after** the ignored
SIGTERM. The plugin disappears regardless of any in-process resistance.

#### Empirical evidence (Mac Mini, 2026-04-26 12:26 BST)

- pid 89205 received an inbound notification at 12:26:34Z, pushed to channel
  successfully (heartbeats and watcher healthy throughout).
- 12:26:36Z: SIGTERM landed; Patch G logged `signal.ignored_channel_owner`
  and returned without shutting down.
- 12:26:36Z: process gone (no exit breadcrumb, no shutdown log) — only the
  stale lease file remained. Process uptime at death: 172 s.

The host was clearly using two-stage termination (SIGTERM → SIGKILL) on
plugins it considers reapable. Patch G can survive the first stage but not
the second.

#### Why Telegram (also a channel plugin) does not get reaped

Telegram registers four MCP tools (`reply`, `react`, `download_attachment`,
`edit_message`) via the standard `tools/list` handler. The plugin host
classifies tool-capable plugins as **active / interactive** and excludes
them from the idle reaper sweep entirely. Channel-only plugins (no tools
registered) are classified as **disposable** — and even when they ignore
SIGTERM, the host follows through with SIGKILL.

3.6.2's `claude-code-channel` plugin registered zero tools. That's why the
host kept reaping it.

#### Patch H — register a no-op informational tool

`claude-code-channel/src/index.ts` now registers a single MCP tool,
`claude_code_channel_status`, that returns a small JSON status object
(`pid`, `ppid`, `uptime_s`, `version`, `machine`, `watcher_active`,
`lease`, `tool_calls_received_count`, `tool_boot_time_ms`). The tool's
description discourages calling it for normal use — agents should use
`bridge_send_message` from the sibling agent-bridge plugin — but its
existence registers the channel plugin as tool-capable in the host's
classification, mirroring Telegram's effective behaviour.

Patch G is retained as defence-in-depth for the SIGTERM-only escape window
before any future host-side classification change.

#### Patch H evidence logging

To distinguish "Patch H prevented reaping" from "different failure mode" if
the issue resurfaces, every signal arrival now logs a `signal.evidence`
event with: `parent_alive`, `stdin_destroyed`, `stdin_readable_ended`,
`last_notification_at_ms`, `last_notification_age_ms`,
`tool_calls_received_count`, `uptime_s`. The same fields are added to the
existing `signal.ignored_channel_owner` event and to the
`signal.received` sync exit breadcrumb.

#### Files touched

- `claude-code-channel/src/index.ts` — register
  `claude_code_channel_status`; track `lastNotificationAtMs` and
  `toolCallsReceivedCount`; emit `signal.evidence` on every signal arrival;
  bump VERSION constant.
- `claude-code-channel/test/tool-registration.test.mjs` — new test file:
  source-level guard + behavioural test that initiates an MCP handshake,
  calls `tools/list`, calls `tools/call`, and asserts on the returned
  status shape.
- `claude-code-channel/{package.json, package-lock.json, .claude-plugin/plugin.json}` — 3.6.3.
- `mcp-server/{package.json, package-lock.json, .claude-plugin/plugin.json, src/index.ts}` — 3.6.3 in lockstep.
- `agent-bridge` (bash CLI) — `VERSION="3.6.3"`.
- `claude-code-channel/test/lifecycle.test.mjs`, `mcp-server/test/heartbeat-shutdown-diag.test.mjs` — version assertions bumped to 3.6.3.

## agent-bridge 3.6.2 — 2026-04-26

### Fix channel plugin not respawning after Claude Code SIGTERMs it

3.6.0 split the channel-owner watcher into a dedicated `agent-bridge-channel`
plugin modeled on the official Telegram plugin. 3.6.1 fixed the orphan
watchdog killing it within 15 s of every spawn. Production usage on Mac Mini
then revealed a deeper, longer-cycle problem: after ~10 hours of healthy
operation Claude Code's plugin host SIGTERMs the channel plugin, the plugin
shuts down cleanly via `shutdownWithReason('SIGTERM')` — and Claude Code
**does not respawn it within the same session**. Inbound channel messages
stop being delivered until the user manually `/reload-plugins` or restarts.

#### Empirical evidence (Mac Mini, 2026-04-25 23:46:31 BST)

- `claude-code-channel` pid 40537 had 35,875 s (~9.95 h) of clean uptime,
  60 s heartbeats, no errors.
- Single SIGTERM landed; plugin honored it, dumped shutdown diagnostics,
  released the watcher lease.
- No subsequent `channel.starting` event in the unified log. 13 messages
  piled up undelivered in `~/.agent-bridge/inbox/claude-code/`.
- The Telegram plugin (pid 36753, same parent ppid=36734, started in the
  same session) had been running 21h+ at the same point — never SIGTERM'd.

#### Root cause

Claude Code's plugin host periodically reaps MCP children that look idle
from its tool-activity heuristic. The Telegram plugin survives because it
registers four tools (`reply`, `react`, `download_attachment`,
`edit_message`) — every tool call counts as activity. Our channel plugin
registers only the `experimental.claude/channel` capability with **zero
tools** (deliberately — outbound bridge tools live in the separate
`agent-bridge` mcp-server plugin so the tools host can be respawned freely
between turns). With nothing to mark us "active", the host's idle reaper
sweeps us and does not restart channel-only plugins within a session.

The pre-3.5.4 `mcp-server` had a `signal.ignored_channel_owner` SIGTERM
handler (commit `7611bfeb`, 2026-04-24) that addressed exactly this. When
the channel-owner role moved out of `mcp-server` in 3.6.0 the SIGTERM
ignore did not move with it.

#### Fix (Patch G)

`claude-code-channel/src/index.ts` now installs a `handleSignal` wrapper
that ignores `SIGTERM` IFF the watcher started successfully AND the parent
(Claude Code session) pid is still alive. The orphan watchdog (Patch A)
still terminates us within ~15 s on true reparenting, the
stdout/stdin EPIPE handlers still terminate us on broken transport, and
SIGINT/SIGHUP remain explicit shutdown signals. So the only thing
suppressed is Claude's idle reaper killing a healthy long-lived watcher.

The handler logs `signal.ignored_channel_owner` (level: warn) to the
unified log every time it absorbs a SIGTERM, so we can see post-mortem
how often the host attempts to reap us. `AGENT_BRIDGE_DISABLE_PATCH_G=1`
disables Patch G (used by tests so SIGTERM can still terminate the test
plugin — the test runner is the parent and is alive).

#### Tests

- New `3.6.2: source-level — Patch G channel-owner SIGTERM ignore wired`
  asserts the build artifact contains the `signal.ignored_channel_owner`
  event and `signalParentAlive` helper, and that the ignore is gated on
  `signal === 'SIGTERM'` (SIGINT/SIGHUP must still shut down).
- New `3.6.2: SIGTERM is ignored when parent is alive and watcher is
  healthy (Patch G)` boots the plugin, sends SIGTERM with Patch G enabled,
  asserts the plugin is still alive after 3.5 s and that
  `signal.ignored_channel_owner` was emitted with `parentPid === test
  runner pid`. Then sends SIGINT and asserts the plugin shuts down
  cleanly — proving Patch G is SIGTERM-only.
- Existing SIGTERM-shutdown tests still pass because the test harness now
  sets `AGENT_BRIDGE_DISABLE_PATCH_G=1` by default.

#### Files touched

- `claude-code-channel/src/index.ts` — Patch G handler, `bootPpid`
  hoisted to enclosing scope, header comment + VERSION bump.
- `claude-code-channel/package.json` + `package-lock.json` — 3.6.2.
- `claude-code-channel/.claude-plugin/plugin.json` — 3.6.2.
- `claude-code-channel/test/lifecycle.test.mjs` — Patch G regression
  tests, harness opt-out env var, version assertion bump.
- `mcp-server/package.json` + `package-lock.json` — 3.6.2 (lockstep
  bump, no behaviour change).
- `mcp-server/.claude-plugin/plugin.json` — 3.6.2.
- `mcp-server/src/index.ts` — version-string bump in startup event.
- `mcp-server/test/heartbeat-shutdown-diag.test.mjs` — version assertion.
- `agent-bridge` (CLI) — `VERSION="3.6.2"`.

## agent-bridge 3.6.1 — 2026-04-21

### Fix orphan-watchdog killing channel plugin within 15s of spawn

3.6.0 shipped the new `agent-bridge-channel` Claude Code plugin with the Telegram-pattern lifecycle posture (Patches A-F). The 3-poll orphan watchdog (Patch A) was supposed to require 15 s of confirmed orphan state before shutdown, but it always tripped within 15 s of every spawn and killed the plugin before it could deliver a single message. Production logs (`~/.agent-bridge/logs/agent-bridge.log`):

```
channel.orphan_poll: poll 1/3, stdin_ended: true,  ppid_changed: false, stdin_destroyed: false, stdin_errored: false
channel.orphan_poll: poll 2/3, stdin_ended: true,  ...
channel.orphan_poll: poll 3/3, stdin_ended: true,  ...
channel.shutdown reason="orphan-watchdog: stdin readableEnded"
```

#### Root cause

Claude Code's MCP plugin host writes JSON-RPC messages to the child's stdin during the initial handshake and then leaves the pipe idle (it stays open — JSON-RPC continues to flow over it for as long as the host wants to talk to the child). On Node, the MCP SDK's `StdioServerTransport` consumes those buffered handshake bytes via the readable interface, which causes `process.stdin.readableEnded` to flip to `true` even though the pipe is still open. The orphan watchdog treated `readableEnded === true` as a sign the parent had gone away and shut down within 15 s of every spawn.

The Telegram channel plugin uses the same Patch A logic and doesn't die because it runs under bun, which handles stdin lifecycle differently — `readableEnded` doesn't transition the same way. On Node we have to be stricter about what counts as orphan.

#### Fix (Option A — simplest)

Drop `stdin.readableEnded === true` from the orphan check in BOTH `claude-code-channel/src/index.ts` and `mcp-server/src/index.ts`. The remaining orphan signals — `ppid !== bootPpid`, `stdin.destroyed === true`, `stdin` had an `'error'` event — are sufficient to detect true reparenting / pipe failure. An IDLE stdin is not an orphan signal on Node; only an actively-broken or actually-destroyed stdin is.

`stdin_ended` is still logged in the orphan_poll context for diagnostics, but it no longer contributes to the orphan decision.

#### Tests

- New regression test `3.6.1: stdin.readableEnded alone must NOT trigger shutdown` (`mcp-server/test/three-poll-watchdog.test.mjs`) — calls `server.stdin.end()`, waits 20 s, asserts the server is still alive.
- New regression test `3.6.1: plugin survives idle stdin` (`claude-code-channel/test/lifecycle.test.mjs`) — same shape for the channel plugin.
- Updated `3.6.1: channel-owner survives idle stdin` (`mcp-server/test/heartbeat-shutdown-diag.test.mjs`) — the previous version of this test asserted that `stdin.end()` triggered shutdown after 25 s. That assertion was the bug; the new test asserts survival on idle stdin and clean shutdown on SIGTERM.
- Bumped version assertions in lifecycle and heartbeat-shutdown-diag tests to `3.6.1`.

#### Files touched

- `claude-code-channel/src/index.ts` — orphan check fix, VERSION bump, header comment update.
- `mcp-server/src/index.ts` — orphan check fix, VERSION bump.
- `claude-code-channel/package.json` + `package-lock.json` — 3.6.1.
- `mcp-server/package.json` + `package-lock.json` — 3.6.1.
- `claude-code-channel/.claude-plugin/plugin.json` — 3.6.1.
- `mcp-server/.claude-plugin/plugin.json` — 3.6.1.
- `agent-bridge` (CLI) — `VERSION="3.6.1"`.
- `claude-code-channel/test/lifecycle.test.mjs` — version assertion + new survival test.
- `mcp-server/test/three-poll-watchdog.test.mjs` — rewrote stdin-end test to assert survival.
- `mcp-server/test/heartbeat-shutdown-diag.test.mjs` — version assertion + rewrote channel-owner stdin-close test.

## agent-bridge 3.6.0 — 2026-04-21

### Structural fix: split the channel host into its own Claude Code plugin

The 3.5.x patch series (heartbeat, sibling-MCP step-down, SIGPIPE swallow, watcher lease, broken-pipe diagnostics, "obey Claude MCP lifecycle shutdown", 3-poll orphan watchdog, persistent stderr tee, push-failed decision) all worked around the same root cause: **the channel watcher was living inside an MCP stdio child whose lifetime is governed by Claude Code's plugin host**. Each patch closed one race; the next one opened. 3.6.0 fixes the structural problem rather than adding another patch on top.

#### What's new

- **New plugin: `agent-bridge-channel`** (sourced from `claude-code-channel/`). Long-lived, session-scoped MCP server modeled on the official Telegram plugin's `~/.claude/plugins/cache/.../telegram/0.0.6/server.ts`. Owns the watcher lease, polls `~/.agent-bridge/inbox/claude-code/` at 2 s, and emits `notifications/claude/channel` back into the running Claude Code session. Survives `/reload-plugins`, sibling-MCP spawns, and idle reaping the way the Telegram channel does.
- **`agent-bridge` plugin (the existing MCP server) is now tools-only by default.** Exposes the same 7 `bridge_*` tools (`bridge_send_message`, `bridge_status`, `bridge_list_machines`, `bridge_run_command`, `bridge_inbox_stats`, `bridge_clear_inbox`, `bridge_receive_messages`). The plugin host can respawn this child between turns without affecting the watcher. `bridge_inbox_stats` reads the shared lease file (`~/.agent-bridge/locks/claude-code.watcher-lock.json`) to report the live channel-owner's PID/role/freshness even though the watcher itself runs in another process. The 3.5.3 lease-read implementation already did this correctly.
- **Telegram patches A–F adopted verbatim in `claude-code-channel/src/index.ts`.** Persistent stderr tee → `~/.agent-bridge/logs/claude-code-channel-stderr.log` (5 MiB rotation), `shutdownWithReason` funnel, 60 s heartbeat (refed — channel host MUST keep the loop alive), shutdown handle/request dump, 3-poll orphan watchdog (15 s confirmation across `ppid != bootPpid` OR `stdin.destroyed` OR `stdin.readableEnded`), and Patch F (heartbeat-recency guard against parallel subagent spawn — uses the lease file's `updatedAt` instead of an stderr-log mtime, same intent).
- **Marketplace updated** to expose both plugins side by side. Install both:
  ```bash
  claude plugin install agent-bridge@agent-bridge          # tools
  claude plugin install agent-bridge-channel@agent-bridge  # channel host
  ```

#### Wire-format compatibility

The on-disk wire format is unchanged. `BridgeMessage` JSON shape, the per-target inbox subdir layout (`inbox/claude-code/`, `inbox/openclaw/<acct>/`), the `.delivered` / `.processed` ledgers, the watcher lease path/format, and the SCP outbound path all match 3.5.x byte-for-byte. A 3.5.x peer (running mcp-server in legacy `channel-owner` mode) and a 3.6.x peer (running `claude-code-channel` plugin) interoperate fully — the lease file mediates ownership when both are present transiently on the same machine. **Per-machine rollout is supported**: upgrade Mac-Mini to 3.6.0 while MBP stays on 3.5.x and messages flow both ways throughout.

#### What's NOT changing

- **Tool surface is identical.** Callers using `bridge_send_message` etc. see no API change.
- **OpenClaw** is unaffected. `openclaw-channel/` keeps watching `inbox/openclaw/<target>/` and pairs with the tools-only MCP server exactly as before.
- **Same-machine delivery (3.5.0+)** is unchanged. `bridge_send_message` to the local machine still writes directly to `~/.agent-bridge/inbox/<target>/<id>.json` without going through SSH.
- **`AGENT_BRIDGE_ROLE=channel-owner`** is retained as a legacy opt-in for non-Claude hosts (Codex, Gemini-CLI, plain MCP experimentation). Most users don't need it.

#### Lifecycle posture

Pre-3.6.0:
```
Claude Code session ──spawns──> [single MCP child]
                                   ├── bridge_* tools (per-turn)
                                   ├── inbox watcher (long-lived — but child dies between turns)
                                   └── notifications/claude/channel push
```
The child's lifetime was governed by Claude Code's MCP host. When the host reaped or recycled the child between turns, the watcher died with it. Each 3.5.x patch tried to keep the child alive across one more reap path; the structural mismatch never went away.

3.6.0:
```
Claude Code session ──spawns──> [agent-bridge-channel plugin]   (session-scoped, REFED)
                       │           ├── inbox watcher
                       │           └── notifications/claude/channel push
                       │
                       └─spawns──> [agent-bridge MCP child]      (per-turn, free to recycle)
                                   └── bridge_* tools
```
Tools and channel coordinate exclusively via the filesystem. The MCP plugin host can freely respawn the tools child; the watcher in the channel plugin is undisturbed.

#### Tests

- Existing `mcp-server` tests still pass (some had a hardcoded `version: '3.5.5'` assertion that was bumped to `3.6.0`).
- New `claude-code-channel` test suite verifies plugin lifecycle, watcher lease arbitration, channel-notification push, shutdown_diag emission, and 3-poll watchdog behaviour.

#### Files touched

- `claude-code-channel/` — new package. Replaces the inert 3.6.0 stub. Contains: `package.json`, `package-lock.json`, `tsconfig.json`, `.claude-plugin/plugin.json`, `.mcp.json`, `.gitignore`, `README.md`, `src/index.ts`, `src/config.ts`, `src/log.ts`, `src/inbox.ts`, `src/watcher.ts`, `test/*.test.mjs`, `build/` (committed).
- `mcp-server/src/index.ts` — `AGENT_BRIDGE_ROLE` defaults to `tools-only`; legacy `channel-owner` opt-in retained; version strings bumped to 3.6.0; clearer startup banner.
- `mcp-server/.mcp.json` — env block now sets `AGENT_BRIDGE_ROLE=tools-only` (was `channel-owner`).
- `mcp-server/.claude-plugin/plugin.json`, `mcp-server/package.json`, `mcp-server/package-lock.json` — version 3.6.0.
- `mcp-server/test/heartbeat-shutdown-diag.test.mjs` — version assertion 3.5.5 → 3.6.0.
- `agent-bridge` (top-level CLI) — `VERSION="3.6.0"`.
- `.claude-plugin/marketplace.json` — registers both `agent-bridge` (tools) and `agent-bridge-channel` (channel host).
- `README.md`, `INSTRUCTIONS.md`, `AGENTS.md` — explain the new architecture.
- `scripts/update.sh` — also rebuilds `claude-code-channel/`.
- `CHANGELOG.md` — this entry.

#### Pre-commit codex review

Skipped — Codex CLI auth is broken (`refresh_token_reused 401`). Manual review carried out instead. Per `~/.claude/CLAUDE.md`, the global rule says skip pre-commit-codex-review when codex auth is broken.

## agent-bridge 3.5.5 — 2026-04-25

### Telegram-pattern lifecycle polish (diagnostics-only)

3.5.4 nailed the correct lifecycle posture: when Claude Code closes the MCP stdio transport (stdin EOF, SIGTERM) or stdout EPIPE makes the channel transport unusable, the channel-owner exits and releases the watcher lease so the next live owner picks up pending work. 3.5.5 keeps that semantic boundary intact and adds Telegram-style robustness around it — the four changes below are strictly diagnostic / lifecycle polish; no message-delivery semantics change.

#### Changes

1. **3-poll orphan-watchdog confirmation** (mirror of Telegram channel plugin's Patch A — `plugins/cache/.../telegram/0.0.6/server.ts:711-737`).
   - Pre-3.5.5: the parent-watchdog `setInterval` shut down on a single `kill(parentPid, 0)` ESRCH, and `process.stdin.on('end' | 'close')` shut down immediately.
   - 3.5.5: a unified orphan watchdog now requires **3 consecutive failed polls (≈15s at 5s polling)** across parent-PID liveness AND stdin destroyed/readableEnded/errored before calling `shutdown()`. Any clean poll resets the counter, so transient ppid/stdin glitches under heavy load no longer false-trigger shutdown. True reparenting still terminates within ~15s.
   - Stdin-end / stdin-close listeners no longer call `shutdown()` directly — they're observed by the watchdog via `process.stdin.readableEnded` / `process.stdin.destroyed`. Stdin-error listener still records a deferred reason that the watchdog observes. Stdin EPIPE remains immediate-fatal (3.5.4 baseline) — a broken transport must not be tolerated.
   - New events: `parent.orphan_poll`, `parent.orphan_recovered`. `parent.dead` now fires only at the 3-poll confirmation boundary, not on the first ESRCH.
   - New env opt-out: `AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG=1` for diagnostic / detached scenarios. The existing `AGENT_BRIDGE_DISABLE_PARENT_CHECK=1` now disables only the parent-PID portion; the stdio-orphan portion still runs.

2. **Persistent stderr tee** (mirror of Telegram channel plugin's Patch B — `server.ts:31-51`).
   - All process stderr writes are now teed to `~/.agent-bridge/logs/mcp-server-stderr.log` so post-mortem evidence survives even when Claude closes the diagnostic stderr pipe between turns. The `process.stderr.write` override falls back to the original write so stderr → harness piping continues to work when the pipe is healthy.
   - 5 MiB rotation: when the file exceeds 5 MiB at startup, the last 2 MiB is retained.

3. **Shared `bridge_inbox_stats` correctness verified.** The 3.5.3 shared-lease read in `getInboxStats` was already correct: tools-only children read the lock file and probe the holder's PID via `kill(pid, 0)`, then derive `watcherBackend` and `watcherHealthy` from that shared signal when their own watcher state is unknown. 3.5.5 adds an explicit regression assertion (already present from 3.5.3 — kept) and confirms behaviour by source review. No code change in this area; verified-only.

4. **Explicit `notification.push_failed` event** with `decision="leave_pending_for_next_owner"`.
   - Before: the channel-notification rejection path in `watcher.ts` only called `logError(...)` and reused `message.push_failed` from `index.ts`; the post-mortem chain didn't say WHY the file was left pending.
   - 3.5.5: `watcher.ts` now emits a deliberate `notification.push_failed` event (level `error`) carrying `msg_id`, `from`, `to`, `target`, `reply_to`, `error`, `error_code`, `decision: 'leave_pending_for_next_owner'`, and `file_name`. The legacy `message.push_failed` in `index.ts` is retained for backward compatibility with existing log consumers and now also carries `decision: 'leave_pending_for_next_owner'`.

#### What this does NOT change

- Stdout-EPIPE-fatal semantics are unchanged. A broken JSON-RPC/channel transport remains fatal — this is intentional. Tolerating EPIPE would create a live-but-deaf channel-owner that silently swallows messages.
- Stdin-end shutdown semantics are unchanged in posture — the channel-owner still exits on transport teardown, releases the lease, and leaves pending work for the next live owner. Only the *trigger condition* tightens to require 3-poll confirmation, eating false positives without weakening the eventual outcome.
- Wire format unchanged. Cross-machine SSH and same-machine local delivery paths unchanged. `openclaw-channel` is not touched (same-machine routing parity already shipped in 3.5.1).

#### Bonus note: 3.5.4 baseline

3.5.4 is the canonical lifecycle-obey baseline: a Claude MCP channel-owner exits / relinquishes the lease on lifecycle / transport teardown, and pending messages replay on the next owner. The earlier "keep the channel-owner alive across SIGTERM/stdin-end" patches (3.4.9–3.4.13) were a dead-end because they fought Claude's plugin host instead of cooperating with it. Do not keep a deaf stdout-broken owner alive.

#### Tests

- All 16 existing tests still pass.
- 6 new tests added (22 total):
  - 3-poll watchdog wiring guard.
  - Live behavioural test: single stdin-end does NOT shut down within 5s; 3-poll confirmation does within ~15s, and the `parent.orphan_poll` event progression is observed in the log.
  - Persistent stderr tee creates a durable file with the startup banner.
  - Stderr tee wiring guard.
  - `notification.push_failed` event-shape and decision-field source guards (watcher.ts + index.ts back-compat).
- The pre-existing `channel-owner treats stdin close as host lifecycle shutdown` test was updated to expect the new `orphan-watchdog: ...` reason and the 3-poll progression.

#### Files touched

- `mcp-server/src/index.ts` — persistent stderr tee, 3-poll orphan watchdog, deferred stdin-end/stdin-close handling, version bump, decision field on legacy push-failed event.
- `mcp-server/src/watcher.ts` — explicit `notification.push_failed` event with `decision=leave_pending_for_next_owner`.
- `mcp-server/package.json`, `mcp-server/package-lock.json`, `mcp-server/.claude-plugin/plugin.json` — 3.5.5.
- `agent-bridge` (top-level CLI) — `VERSION="3.5.5"`.
- `mcp-server/test/heartbeat-shutdown-diag.test.mjs` — updated stdin-close test for 3-poll behaviour; switched the shutdown-diag test to SIGTERM trigger; bumped version assertion to 3.5.5.
- `mcp-server/test/three-poll-watchdog.test.mjs` (new).
- `mcp-server/test/stderr-tee.test.mjs` (new).
- `mcp-server/test/notification-push-failed.test.mjs` (new).
- `CHANGELOG.md`.

## agent-bridge 3.5.4 — 2026-04-25

### Fix: obey Claude Code MCP child lifecycle instead of fighting SIGTERM

Live Mini evidence showed Claude Code closed the MCP stdin transport immediately after channel delivery and then sent SIGTERM two seconds later. The process died before its next 5s lease heartbeat, leaving a stale lock. That timing strongly indicates Claude's plugin host was intentionally reaping/recycling the stdio child and escalating when the child ignored SIGTERM.

3.5.4 removes the previous channel-owner keepalive hack: channel-owner MCP children now treat stdin EOF/close and SIGTERM as host-requested shutdown, mirroring the official Telegram plugin's lifecycle. Shutdown releases the watcher lease and leaves undelivered messages pending for the next live channel-owner/replay instead of trying to outlive Claude's transport and getting hard-killed.

This is the real boundary: a Claude-managed stdio MCP child cannot be a reliable always-on daemon after Claude closes the transport. Reliable always-on delivery needs a separate architecture; this patch makes the current architecture honest and non-stale.

## agent-bridge 3.5.3 — 2026-04-25

### Fix: make stdout/EPIPE watcher exits visible and clear stale leases

Live Mini evidence after 3.5.2 showed the remaining Claude Code channel-owner death path: a watcher could successfully push a channel notification, then see Claude close stdin/SIGTERM, and then disappear with no `server.shutdown`, no `shutdown_diag`, no `parent.dead`, and a stale `claude-code.watcher-lock.json`. The missing path was the stdout/JSON-RPC broken-pipe handler: stdout is the channel transport, so EPIPE is fatal, but the old handler called `process.exit(0)` without durable logging or lease cleanup.

3.5.3 keeps the correct semantic boundary — if stdout is gone, Claude cannot receive channel notifications from that MCP child — but removes the silent/stale failure mode:

- Logs `stdout.broken_pipe_exit`, `stdin.broken_pipe_exit`, `unhandled_rejection.broken_pipe_exit`, or `uncaught_exception.broken_pipe_exit` before exiting.
- Releases the watcher lease via `stopWatcher()` and stops inbox/prune state via `shutdownInbox()` before fatal transport exit when JS still has a chance to clean up.
- `bridge_inbox_stats` now reads the shared watcher lease file, so tools-only MCP children can report the real channel-owner PID/role/alive/fresh state instead of only their own process-local `unknown/no` watcher state.
- Adds regression coverage for shared-lease stats and source-level guards that broken-pipe handlers no longer silently `process.exit(0)`. A separate logger-independent sync breadcrumb file now records fatal-transport/shutdown/signal/process-exit progress for the next live reproduction.

#### Root-cause implication

This does not pretend Claude Code delivery is a separate always-on daemon. The root architectural issue is still that the `claude-code` watcher lives inside a Claude-managed MCP stdio child. When Claude closes/reaps that stdout transport, live push from that child is impossible; the correct behaviour is now to make the next death path provable, release ownership when JS still has a chance, and let the next live channel-owner/replay recover instead of leaving a ghost lock and no evidence. A true always-on Claude route would need a larger 3.6.x architecture change.

## agent-bridge 3.5.2 — 2026-04-25

### Fix: post-mortem visibility + sibling-MCP step-down + SIGKILL backstop

3.4.9–3.4.13 patched a series of channel-owner death paths (stdin-end, SIGTERM, SIGPIPE, stderr-EPIPE), and 3.5.0 added watcher standby promotion. Real-world MBP behaviour today shows those patches working: the current channel-owner MCP child has been alive 9+ hours through the same idle-then-traffic pattern that previously killed older builds. The remaining gap was diagnostic: when a channel-owner DOES die between heartbeat-spaced events (5-minute prune-pass cadence), the on-disk log goes silent for minutes at a time and we can't tell whether the death was at minute 1 or minute 4, or which handle/request was wedged at teardown. The other gap: a fresh sibling MCP child spawned by the same Claude parent (e.g. after `/reload-plugins`) leaves the older sibling alive but stdio-orphaned, eventually dying silently from EPIPE during a channel notification.

3.5.2 closes both gaps without touching the watcher's well-tested signal-survival logic:

- **Periodic heartbeat (60s).** Mirrors the Telegram channel plugin's `[heartbeat]` cadence (`plugins/cache/.../telegram/0.0.6/server.ts` ~line 743). Emits `server.heartbeat` to the unified NDJSON log every minute with `uptime_s`, `ppid`, `pid`, `rss_mb`, `lease`, and `role`. A dead channel-owner is now detectable to the minute instead of guessable to the 5-minute prune window. Refed for channel-owner watchers (must keep Node alive between turns); unref'ed for tools-only and standby (must not pin Node alive after stdio closes).
- **Shutdown diagnostics dump.** When `shutdown()` runs, emits `server.shutdown_diag` with `handles` count, `requests` count, `rss_mb`, `handle_types[]` (constructor names — usually `Timeout`, `Pipe`, `WriteWrap`), `reason`, `pid`, `parent_pid`. Mirrors the Telegram plugin's `[shutdown-diag]` line (server.ts ~line 675). The post-mortem reveals what kept the event loop alive at teardown — typically the parent watchdog interval, the file-watcher poll, or a wedged JSON-RPC stdout write.
- **SIGKILL self-destruct backstop (5s).** The existing 2s force-exit timer used `process.exit(0)`, which can be swallowed by a Node main thread stuck in an uninterruptible kernel wait (U state — e.g. wedged fetch or fs syscall). 3.5.2 adds a 5s self-SIGKILL via `process.kill(process.pid, 'SIGKILL')`, which is kernel-delivered and ALWAYS terminates. Mirrors the Telegram plugin's identical backstop (server.ts ~line 693). No semantic change to clean shutdown — only changes hung-shutdown timeline from "leaks until OOM" to "guaranteed dead within 5 seconds".
- **Sibling-MCP step-down.** Inside the parent-watchdog interval, when a different alive PID holds our `claude-code` watcher lease and that lease is fresh (`updatedAt` within 30s), we treat it as proof that Claude Code spawned a fresh sibling MCP child for the same parent and cleanly transferred ownership. We log `sibling.detected` and shut down. Without this, the older sibling stayed alive ignoring SIGTERM (correctly per 3.4.11) but without a stdin reader, eventually dying silently from EPIPE during a channel notification. The new behaviour makes the handoff visible and immediate, instead of trickling out through a silent EPIPE later.

#### Changes

- `mcp-server/src/index.ts`:
  - Imports `existsSync`/`readFileSync` from `node:fs`, `join` from `node:path`, and `CLAUDE_CODE_TARGET`/`LOCKS_DIR` from `./config.js`.
  - Bumped server name and starting-event version metadata to 3.5.2.
  - Inserted `server.shutdown_diag` emission before the force-exit timer in `shutdown()`.
  - Added 5s SIGKILL backstop after the existing 2s force-exit timer.
  - Added 60s heartbeat interval refed for channel-owner watchers.
  - Added sibling-MCP detection block inside `parentWatchdog`.
- `mcp-server/test/heartbeat-shutdown-diag.test.mjs`: new file. 3 tests covering the shutdown_diag fields, error-free first-second startup, and source-level wiring of `sibling.detected` + `watcher-lock.json` + `SIGKILL`.
- Version bumps: `mcp-server/package.json`, `mcp-server/.claude-plugin/plugin.json`, `mcp-server/src/index.ts` server version + startup log, `agent-bridge` bash CLI `VERSION`, `mcp-server/package-lock.json`.

#### Compatibility

- Wire format unchanged. Cross-machine SSH and same-machine local delivery paths unchanged. Watcher behaviour unchanged. The new instrumentation only ADDS log events; no existing event was renamed or removed.
- Heartbeat lifecycle: the heartbeat is `unref()`-ed for tools-only and standby modes, so it can never keep a tool-only MCP child alive past stdio close. For channel-owner watchers it is intentionally refed (the parent watchdog is also refed for the same reason — keepalive is the whole point of a channel-owner).
- Sibling detection only fires when a DIFFERENT alive PID holds a FRESH lease (`updatedAt` < 30s). A stale lease left by a dead sibling triggers the existing `lease_stolen` recovery path in `tryAcquireWatcherLease`, not the new step-down.

#### Forward plan

If the soak test reveals a future death despite 3.5.2's instrumentation, the new logs will pinpoint the exact failure mode and the followup is then targeted (instead of speculative). The longer-term architectural option — lifting the watcher into a separate long-lived channel plugin process à la the Telegram bun process — is queued as 3.6.0 but explicitly NOT shipped in 3.5.2 because (a) the existing patches demonstrably work for the current MBP session, (b) the migration is a multi-day refactor, and (c) the diagnostic instrumentation in 3.5.2 is a strict prerequisite for evaluating whether the migration is even necessary.

## agent-bridge 3.5.1 — 2026-04-21

### Fix: openclaw-channel outbound now handles same-machine routing without SSH

3.5.0 added first-class same-machine delivery to the **mcp-server** package, but the **openclaw-channel** outbound path (`deliverReply` in `openclaw-channel/src/outbound.js`) still went straight to the paired-machine SSH lookup. When an OpenClaw embedded agent tried to reply over agent-bridge to a same-machine sender (e.g. Mini-Claude → Mini-OpenClaw → reply back to Mini-Claude), the dispatch failed with `paired machine "<local-name>" not found in ~/.agent-bridge/config` because the local machine is never in the SSH-paired config.

3.5.1 brings the openclaw-channel outbound path to parity with `mcp-server`'s `sendLocalMessage`: when the reply target resolves to the local host (matches `localMachineName()` or one of the reserved aliases `local` / `self` / `localhost`), the BridgeMessage JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` using the same atomic temp-file + rename pattern. No SSH hop, no paired-machine lookup, identical wire format.

#### Changes

- `openclaw-channel/src/outbound.js`:
  - New `LOCAL_MACHINE_ALIASES` export and `isLocalMachineName(name, opts?)` helper, kept as a mirror of `mcp-server/src/config.ts` (documented as "keep in sync").
  - New `deliverReplyLocal({ message, toMachine, inboxDir?, outboxDir?, logger? })` — performs the inbox write directly on disk with atomic rename, mirroring `sendLocalMessage` semantics including the best-effort outbox copy.
  - `deliverReply()` now short-circuits to `deliverReplyLocal` when `toMachine` is the local machine. Cross-machine SSH path is untouched.
- `openclaw-channel/test/outbound-local.test.js`: 11 new cases covering local-name and alias detection, atomic-write cleanup, malformed-target rejection, alias routing through `deliverReply`, the unchanged remote-throw behaviour, and the mixed local-send + paired-remote scenario.
- Version bumps: `mcp-server/package.json` 3.5.0 → 3.5.1, `mcp-server/.claude-plugin/plugin.json` 3.5.0 → 3.5.1, `mcp-server/src/index.ts` server version + startup log to 3.5.1, `agent-bridge` bash CLI `VERSION` 3.5.0 → 3.5.1, `mcp-server/package-lock.json` to match. `openclaw-channel/package.json` bumped 2.3.4 → 2.3.5 (independent semver track).

#### Compatibility

- Cross-machine SSH delivery is unchanged.
- Wire format is unchanged. `deliverReplyLocal` produces the identical JSON file layout `sendLocalMessage` produces, so any inbox watcher (Claude Code channel plugin, openclaw-channel, standalone CLI) picks it up the same way.
- The `isLocalMachineName` helper in openclaw-channel is a documented mirror of the mcp-server version. If the alias list grows in `mcp-server/src/config.ts`, update both.

## agent-bridge 3.5.0 — 2026-04-25

### Feature: first-class same-machine delivery (no SSH loopback)

`bridge_send_message` now accepts the **local machine name** (or one of the reserved aliases `local` / `self` / `localhost`) as the `machine` parameter. When the target resolves to the local host, the BridgeMessage JSON is written directly to `~/.agent-bridge/inbox/<target>/<id>.json` using the same atomic write pattern as the SSH path — no SSH hop, no loopback round-trip.

Motivation: an MCP host such as Claude Code on Mac-mini routinely needs to fan messages out to OpenClaw embedded agents (`openclaw/default`, `openclaw/clawdiboi2`, `openclaw/clordlethird`) that watch the same `~/.agent-bridge/inbox/` directory tree on the same physical machine. Pre-3.5.0 this required either a brittle `cp` hack or pretending the same machine was a paired remote and SSH-ing into yourself. Same-machine delivery makes that route a first-class API, validated, atomic, and visible in `bridge_status` / `bridge_list_machines`.

#### Changes

- `mcp-server/src/config.ts`: new `LOCAL_MACHINE_ALIASES` constant (`['local', 'self', 'localhost']`) and `isLocalMachineName()` helper. `getMachine()` now returns `undefined` for the local name and aliases so cross-machine code paths cannot accidentally route to "self via SSH".
- `mcp-server/src/inbox.ts`: new `sendLocalMessage()` that performs the inbox write directly on disk, mirroring `sshWriteFile`'s atomic temp-file-then-rename pattern (so file watchers never see partial JSON).
- `mcp-server/src/tools.ts`:
  - `bridge_send_message` accepts the local machine name and routes via `sendLocalMessage` when it does. The success message reports `transport=local|ssh` so callers can verify the path taken.
  - `bridge_status` reports the local pseudo-machine as `LOCAL (no SSH — same-machine delivery via inbox/<target>/)` when no machine is given, and as the same single line when explicitly asked about the local name. SSH probing is skipped.
  - `bridge_list_machines` always lists the local pseudo-machine first, with the alias list, even when no remotes are paired.
  - `bridge_run_command` rejects the local machine name with a clear "use your shell directly — there is no SSH loopback" error.
- `agent-bridge` (bash CLI):
  - New `is_local_machine` helper, kept in sync with the TS aliases list.
  - `agent-bridge status [<local-name>|local|self|localhost]` reports `LOCAL — same-machine delivery, no SSH` and exits 0 without invoking `ssh`.
  - `agent-bridge status` (all machines) prepends a local-machine line.
  - `agent-bridge run <local>` and `agent-bridge connect <local>` exit non-zero with a helpful message.
  - `agent-bridge pair --name <local>|local|self|localhost` is rejected up-front so a remote cannot shadow the local-machine route.
  - `get_machine_name` now honours `AGENT_BRIDGE_MACHINE_NAME` and `~/.agent-bridge/machine-name`, matching the TS resolver.
- Tests:
  - New `mcp-server/test/local-delivery.test.js` (9 cases) covering alias detection, target subdir routing, OpenClaw routing, atomic-write cleanup, malformed-target rejection, and the mixed local + paired-remote scenario.
  - New `test/cli-local-status.sh` covering `status local`, `status <hostname>`, `run local` rejection, `connect local` rejection, and `pair --name local` rejection.
  - Updated `test/cli-status-stdin.sh` to match the new "remote machines reachable (plus … local)" wording and assert the LOCAL line is present.
  - `npm run test` runs the TS build then the node:test suite.
- Docs: `INSTRUCTIONS.md`, `README.md`, `AGENTS.md` gained a "Same-machine delivery" section explaining when to use it, the alias list, and the receiver-side requirement (a watcher — Claude Code channel plugin or `openclaw-channel` — must be running for the inbox subdir on the local machine).


### Fix: Claude Code watcher standby recovery

- Channel-capable standby processes now retry the `claude-code` watcher lease and promote themselves when the active owner becomes stale, matching the resilient OpenClaw watcher pattern instead of requiring a manual Claude/plugin restart.
- Channel notification writes are bounded by `AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT_MS` (default 10s), so a wedged stdout/JSON-RPC write leaves the inbox file retryable instead of pinning it forever in memory.
- Claude plugin manifest version is aligned with the MCP/CLI runtime.

#### Compatibility

- Cross-machine SSH delivery is unchanged. Existing pairings continue to work.
- The wire format is unchanged — same BridgeMessage schema, same per-target inbox layout, same delivered/processed-ID dedup. The only difference is whether the file gets there via SSH or a local atomic-rename.
- Pairing under a name that collides with the local machine or one of the reserved aliases is now rejected. If you have an existing pairing with such a name (extremely unusual), `agent-bridge unpair <name>` and re-pair under a different label.

## agent-bridge 3.4.13 — 2026-04-24

- Fixed the remaining channel-owner death path after 3.4.12: an explicit SIGPIPE handler was still exiting the process after Claude Code closed a pipe. SIGPIPE is now ignored and stream-specific EPIPE handlers decide liveness, so diagnostic-pipe closure cannot kill a live `claude-code` watcher while stdout/JSON-RPC failure remains fatal.

## agent-bridge 3.4.12 — 2026-04-24

- Fixed channel-owner survival when Claude Code closes the diagnostic stderr pipe between turns: stderr EPIPE is now swallowed after durable file logging, while stdout/JSON-RPC EPIPE still exits because channel delivery would be impossible. This addresses 3.4.11 watchers dying after ignored stdin/SIGTERM despite the parent Claude process staying alive.

## agent-bridge 3.4.11 — 2026-04-24

- Fixed the follow-up Claude Code durability gap: Claude can send SIGTERM to plugin MCP children after a tool turn even when the parent channel session stays alive. Channel-owner watchers now ignore that benign SIGTERM while the parent process is alive, relying on the parent watchdog/EPIPE path for real shutdown.

## agent-bridge 3.4.10 — 2026-04-24

- Fixed the 3.4.9 channel-owner keepalive: ignoring Claude Code stdin end was not enough because all watcher timers were unref'ed, so Node could still exit between turns. Channel-owner MCP servers now keep the parent-liveness watchdog ref'ed after stdio closes, preserving the `claude-code` watcher until parent death/EPIPE.

## agent-bridge 3.4.9 — 2026-04-24

### Fix: keep Claude Code channel watcher alive between turns

- Claude Code may close the MCP stdin/request side after a turn while the parent channel session remains alive. Previous builds treated that as full parent disconnect and stopped the `claude-code` watcher.
- Channel-owner watchers now ignore benign stdin `end`/`close` events and stay alive until the parent PID dies or stdout breaks with EPIPE, so `claude-code` inbox delivery remains available between turns.

## agent-bridge 3.4.8 — 2026-04-24

### Fix: channel-parent detection regex

- Fixed the 3.4.7 watcher-owner guard so Claude channel parents with `--channels ...` or `--dangerously-load-development-channels ...` are recognized correctly.
- This repairs the accidental tools-only demotion caused by a literal backspace character in the generated regex and lets the real Claude Code channel plugin acquire the `claude-code` watcher lease again.

## agent-bridge 3.4.7 — 2026-04-24

### Fix: prevent tool-only Claude helpers stealing `claude-code` watcher ownership

- `mcp-server/src/index.ts`: when `AGENT_BRIDGE_ROLE=channel-owner` is requested but the parent process does not look channel-capable (no Claude `--channels` / `--dangerously-load-development-channels` flags), demote the server to tools-only by default.
- This prevents editor helper / hidden MCP-only Claude processes from winning the `claude-code` inbox watcher lease, marking bridge messages as delivered, and then never surfacing them in the intended live channel.
- Set `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT=1` only for an unusual host that genuinely supports `notifications/claude/channel` without those flags.
- After a successful Claude Code channel push or startup replay, delivered files now move out of `inbox/claude-code/` into `inbox/.archive/claude-code/`; stale already-delivered files are swept there too. This makes a non-empty `inbox/claude-code/` mean genuinely pending work again.
- Malformed or misrouted files found under `inbox/claude-code/` now quarantine to `inbox/.failed/claude-code/`; legacy flat files at the root still move to `inbox/.failed/_unrouted/`.
- README/CLI help now describe the current 3.4.2+ endpoint rule correctly: `internet_host` when configured, otherwise LAN `host`; `--probe`, `--fresh`, and `reset-path` are compatibility no-ops for endpoint selection.

## agent-bridge 3.4.6 — 2026-04-24

### Docs/site: align public docs with the current bridge behavior

- Update the README compatibility warning now that OpenClaw channel delivery
  and agent-bridge reply round trips have been tested end-to-end.
- Refresh the public site version labels, TTL copy, compatibility copy, and
  changelog highlights so they match the 3.4.x per-target routing behavior
  and the 1-day default message TTL.

## agent-bridge 3.4.5 / openclaw-channel 2.3.4 — 2026-04-24

### Fix: OpenClaw bridge replies after delivery recovery

- Decode OpenClaw route ids with the channel prefix (`agent-bridge:bridge-v1...`)
  instead of treating them as legacy machine names. This fixes recovered
  replies that already contained a valid encoded return target but still
  failed with “cannot resolve return target”.
- Preserve `legacy_session` in explicit OpenClaw target config.
- Add a cross-process OpenClaw inbox watcher lease so overlapping gateway
  starts do not race the same inbox file.

### Fix: Claude Code bridge return routing

- `bridge_send_message` now defaults `from_target` to `claude-code` for
  normal Claude Code sends. Use `one_way=true` only when intentionally
  omitting a bridge reply path.
- Empty message bodies (`content: ""`) are valid and are no longer skipped
  by live push or startup replay.
- Watcher lease heartbeat write failures now flip watcher health to unhealthy
  and stop polling after repeated failures.

### Fix: CLI status over multiple machines

- `agent-bridge status` detaches SSH probe stdin, so checking all machines no
  longer stops after the first configured peer.

## openclaw-channel 2.3.1 — 2026-04-21

Sender-derived replyVia default — reply on the channel the message arrived
on (agent-bridge if `fromTarget` present, else telegram). Still overridable
per-message / per-target / plugin-level.

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

### Simplify: polling-only watcher + default TTL bumped to 1 day

- Removed fswatch and inotifywait watcher backends — polling-only (2s interval). No external dependencies.
- Default message TTL bumped from 3600s (1h) to 86400s (1d) to tolerate transient bridge outages.

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
