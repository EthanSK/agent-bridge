# Channel Plugin Lifecycle History (3.4.x → 3.7.0)

**Status:** post-mortem  ·  **Date:** 2026-04-26  ·  **Range:** `25a82c3` → `c23feae`

> A retrospective on the multi-week effort to keep the agent-bridge channel
> watcher alive inside Claude Code's MCP plugin host. This document walks
> through every shipped patch from 3.4.6 through 3.7.0, explains the
> empirical findings that triggered each iteration, names the wrong model
> we held about the host's lifecycle in 3.6.0, and pins down what we now
> believe Claude Code's plugin host actually gates reapability on.

---

## TL;DR

We hit a long-running bug where the `claude-code` inbox watcher kept being
killed by Claude Code's plugin host. From 3.4.6 onward we shipped a long
sequence of progressively more invasive fixes — SIGPIPE swallowing
(3.4.13), parent-PID liveness watchdog (3.4.2 backport), channel-owner
SIGTERM ignore (3.4.11), watcher lease + sibling step-down (3.5.2), 3-poll
orphan-watchdog confirmation (3.5.5), and finally a structural split into
a dedicated `agent-bridge-channel` plugin (3.6.0). The split was based on
the assumption that channel-only plugins survive longer in Claude Code's
host because they declare a long-lived channel capability. Production
evidence on Mac Mini disproved that: the dedicated plugin still got reaped,
SIGTERM-ignored (3.6.2 / Patch G), then SIGKILL'd ~2 s later, and even
registering a no-op MCP tool (3.6.3 / Patch H) didn't save it.

The root cause we landed on: **Claude Code's plugin host gates idle-reaping
on `tools/call` *frequency* on the stdio JSON-RPC channel, not on tool
*registration* and not on channel notifications.** Telegram's channel
plugin survives 21+ hours indefinitely because its four tools (`reply`,
`react`, `download_attachment`, `edit_message`) are called constantly
during normal use. A channel-only plugin presents as idle to the host
even while pushing notifications, and gets reaped after every quiet
window.

3.7.0 is the correction: undo the 3.6.0 split, merge channel + tools back
into a single `agent-bridge` plugin, keep all eight lifecycle patches
(A–H) as defence-in-depth, and rely on the high tool-call frequency of
`bridge_send_message` / `bridge_status` / `bridge_inbox_stats` etc. to
keep the host's idle counter reset. Same lifetime guarantees as Telegram.

---

## The fundamental issue

Claude Code's plugin host (the harness process that spawns and supervises
plugin children) periodically reaps MCP children that look "idle". For
weeks we treated reapability as governed by signals we could observe in
the child — stdin-state, parent-PID liveness, signal handlers — and
patched defensively against each death path. None of those patches
addressed the actual classifier the host uses.

What the host appears to actually do:

- **Watch `tools/call` frequency on stdio JSON-RPC.** Each `tools/call`
  request from Claude → plugin resets an internal idle counter for that
  child. No tool-call traffic for some window → child is classified
  reapable.
- **Channel notifications (`notifications/claude/channel`) flow plugin →
  host and do NOT reset the counter.** They are server-pushed events,
  not client-initiated tool invocations. From the host's plumbing
  perspective, a channel-only plugin that pushes notifications constantly
  still presents as "no client traffic, idle" because the request side of
  the JSON-RPC pipe is silent.
- **Tool *registration* alone is not enough.** A plugin can list a tool
  in `tools/list` and never receive a `tools/call` for it; the host's
  classification is based on actual call traffic, not the registered
  surface area.
- **After a notification delivery, the host evaluates "still useful?"**
  The reaping window seems to align with notification activity — every
  delivery is an opportunity for the host to decide the plugin has
  served its purpose. Mac Mini production logs (2026-04-26 12:26 BST,
  pid 89205) show the channel plugin pushed a notification at 12:26:34Z,
  ate a SIGTERM at 12:26:36Z, and was gone before the next 5 s poll.
- **Two-stage termination.** SIGTERM first; if the child ignores it, the
  host escalates to uncatchable SIGKILL within ~2 s. Patch G survives
  the first stage but cannot survive the second.
- **Long-poll network activity (Telegram's grammy long-polling) is
  invisible to the host.** Telegram doesn't survive because of
  long-polling — it survives because every Telegram message you send,
  edit, react to, or download triggers an MCP `tools/call` on the
  stdio pipe.
- **Internal heartbeats / file-watcher polls don't help.** They're
  process-internal; the host sees nothing of them.
- **Stdin destroy/close from the host side is a "transport done"
  signal.** Patch A's 3-poll orphan watchdog correctly distinguishes
  transient stdin glitches from real reparenting.

The empirical fingerprint, captured by the `signal.evidence` event we
added in 3.6.3 and retained in 3.7.0:

```
{
  "event": "signal.evidence",
  "signal": "SIGTERM",
  "stdin_destroyed": true,        // host has closed the request side
  "stdin_readable_ended": true,
  "last_notification_age_ms": ~2000,   // we just pushed a channel msg
  "parent_alive": true,                // parent Claude session still up
  "tool_calls_received_count": 0       // we never got a tools/call
}
```

That fingerprint is invariant across every channel-only-plugin death we
captured: the host sends SIGTERM ~2 s after the most recent channel push,
parent is still alive, and the running session has never invoked any of
our tools. That's the smoking gun for the tool-call-frequency hypothesis.

---

## Patch glossary (A–H)

All eight patches survive into 3.7.0 (`mcp-server/src/index.ts`,
HEAD `c23feae`). Each was added in response to a specific observed
death path. They are documented inline at the line refs below.

| Patch | File:line | What it does | Added |
|-------|-----------|--------------|-------|
| **A** | `mcp-server/src/index.ts:851`, `:932` | 3-poll orphan watchdog (15 s confirmation across `parent dead` OR `stdin destroyed` OR `stdin errored`) before calling `shutdown()`. Replaces the pre-3.5.5 "shutdown on first stdin-end" behaviour. Mirror of Telegram channel plugin's `server.ts:711-737`. | 3.5.5 (`c832653`) |
| **B** | `mcp-server/src/index.ts:73-98` | Persistent stderr tee → `~/.agent-bridge/logs/mcp-server-stderr.log` with 5 MiB rotation. Survives Claude Code closing the diagnostic stderr pipe between turns, so post-mortem evidence isn't lost. Mirror of Telegram `server.ts:31-51`. | 3.5.5 (`c832653`) |
| **C** | `mcp-server/src/index.ts:656` (`shutdown(reason: string)`) | Shutdown funnel — every shutdown path calls `shutdown(reason)` so we get a single attribution string and a single teardown sequence (clear watchdog, log, stop watcher, stop inbox, close MCP server, force-exit). Originally referred to as `shutdownWithReason`. | 3.5.2 (`cfaf950`) |
| **D** | `mcp-server/src/index.ts:890` | 60 s `server.heartbeat` interval logging `uptime_s`, `ppid`, `pid`, `rss_mb`, `lease`, `role`. Refed for channel-owner role; unref'd for tools-only and standby. Mirror of Telegram's `[heartbeat]` cadence. Without this, silent reaping leaves a 5-minute gap (the prune-pass cadence) and we can't pinpoint death-time. | 3.5.2 (`cfaf950`) |
| **E** | `mcp-server/src/index.ts:687` (`server.shutdown_diag`) | At shutdown time, dumps active handles count, active requests count, RSS, and the constructor names of every active handle (`Timeout`, `Pipe`, `WriteWrap`, etc.). Mirror of Telegram `[shutdown-diag]` (server.ts:675). Reveals what kept the event loop alive at teardown. | 3.5.2 (`cfaf950`) |
| **F** | `mcp-server/src/index.ts:100-190` | Heartbeat-recency guard against parallel-spawn from subagents murdering the parent's poller. Before any watcher work, check `~/.agent-bridge/locks/claude-code.watcher-lock.json` — if a different live PID owns it and `updatedAt` is < 90 s old, log `patch_f.backoff` and `process.exit(0)` cleanly. Skipped under `AGENT_BRIDGE_ROLE=tools-only`. | 3.5.2 / refined 3.7.0 |
| **G** | `mcp-server/src/index.ts:754-836` | Channel-owner SIGTERM ignore. When SIGTERM lands AND the watcher started AND `bridgeRole === 'channel-owner'` AND `signalParentAlive()` returns true, log `signal.ignored_channel_owner` and return without shutting down. SIGINT / SIGHUP still shut down. Override with `AGENT_BRIDGE_DISABLE_PATCH_G=1`. | 3.6.2 (`d4a2cdb`) |
| **H** | `mcp-server/src/index.ts:437-491` | Register the no-op MCP tool `claude_code_channel_status` returning `{pid, ppid, uptime_s, version, machine, watcher_active, lease, tool_calls_received_count, tool_boot_time_ms}`. In 3.6.3 this was load-bearing for liveness; in 3.7.0 it's retained as a useful diagnostic but no longer load-bearing because the seven `bridge_*` tools dominate tool-call traffic. | 3.6.3 (`3640f03`) |

Two related mechanisms not numbered as patches but worth naming:

- **`syncExitBreadcrumb`** — synchronous, logger-independent NDJSON
  appender writing to `~/.agent-bridge/logs/mcp-server-sync-exit.log`.
  Records `shutdown.enter`, `shutdown.before_process_exit`,
  `shutdown.force_exit_timer`, `shutdown.sigkill_backstop`,
  `signal.received`, `patch_f.backoff_exit`. Survives even when the
  async logger has been torn down. Added 3.5.3 (`01ca9b4`).
- **SIGKILL self-destruct backstop (5 s)** — `process.kill(process.pid,
  'SIGKILL')` 5 s after `shutdown()` is entered, in case `process.exit(0)`
  is swallowed by a wedged kernel syscall. Mirror of Telegram channel
  plugin's identical backstop. Added 3.5.2 (`cfaf950`).
- **Sibling-MCP step-down** — when the parent watchdog observes a
  *different* live PID holding our lease with a fresh `updatedAt`, we
  log `sibling.detected` and shut down. Catches the `/reload-plugins`
  re-spawn case where the older sibling is stdio-orphaned but still
  ignoring SIGTERM. Added 3.5.2 (`cfaf950`).

---

## Timeline

### 3.4.6 → 3.4.13: signal-handling patches

The 3.4.x sub-versions formed the first wave of "keep the channel-owner
alive" patches. Each one closed exactly one observed death path and ran
into the next.

#### 3.4.6 (`efbdd9a`) — site/docs alignment

Docs-only — public site labels, TTL copy, compatibility text aligned with
3.4.x per-target routing and the 1-day default TTL. No runtime change.

#### 3.4.7 (`bec6ce0`) — prevent tool-only Claude helpers stealing the lease

Source: `bec6ce0` ("fix: harden bridge routing and watcher ownership"),
`mcp-server/src/index.ts`. When `AGENT_BRIDGE_ROLE=channel-owner` is
requested but the parent process command-line lacks the Claude `--channels`
or `--dangerously-load-development-channels` flags, demote the server to
tools-only. Stops editor-helper / hidden MCP-only Claude processes from
winning the inbox watcher lease, marking files as delivered, and never
surfacing them in the intended live channel. Override with
`AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT=1`.

Also archived delivered files to `inbox/.archive/claude-code/` and
quarantined malformed files to `inbox/.failed/claude-code/` so a non-empty
`inbox/claude-code/` means real pending work.

#### 3.4.8 (`781bba1`) — channel-parent detection regex

Fixed a literal backspace character that snuck into the parent-detection
regex in 3.4.7, which was demoting real Claude Code channel parents to
tools-only and breaking the lease win path. Repaired the regex; channel
plugins acquired the `claude-code` lease again.

#### 3.4.9 (`c681324`) — keep watcher alive between turns

Source: `c681324` ("Keep Claude Code watcher alive between turns").
Empirical observation: Claude Code closes the MCP stdin/request side
after a tool turn while the parent channel session remains alive.
Pre-3.4.9 builds treated stdin EOF as full parent disconnect and stopped
the `claude-code` watcher between turns.

3.4.9: channel-owner watchers ignore benign stdin `end`/`close` events
and stay alive until the parent PID dies or stdout breaks with EPIPE.
This was the first patch where we explicitly chose to fight the host's
lifecycle rather than cooperate with it.

#### 3.4.10 (`b519d33`) — keep parent watchdog refed

Ignoring stdin end was not enough because all watcher timers were
unref'd, so Node could still exit between turns even with the stdin-end
listener installed. 3.4.10: keep the parent-liveness watchdog interval
refed after stdio closes for channel-owner watchers, preserving the
`claude-code` watcher until parent death or EPIPE.

#### 3.4.11 (`7611bfe`) — channel-owner ignores benign SIGTERM

Source: `7611bfe` ("Keep Claude watcher alive through SIGTERM").
Live evidence showed Claude Code can send SIGTERM to plugin MCP children
after a tool turn even when the parent channel session stays alive.
Channel-owner watchers now ignore that benign SIGTERM while the parent
process is alive, relying on the parent watchdog / EPIPE path for real
shutdown. (This is the original spiritual ancestor of Patch G — the same
ignore logic, in the unsplit pre-3.6.0 codebase.)

#### 3.4.12 (`50e561c`) — swallow stderr EPIPE

Source: `50e561c`. After 3.4.11's SIGTERM ignore, channel-owner watchers
were still dying — this time from stderr EPIPE. Claude Code closes the
diagnostic stderr pipe between turns. The default Node behaviour is to
treat stderr write failures as fatal. 3.4.12: swallow stderr EPIPE after
durable file logging, while stdout/JSON-RPC EPIPE remains fatal because
the channel transport would be useless without it.

#### 3.4.13 (`7da713e`) — ignore SIGPIPE

Source: `7da713e` ("Ignore SIGPIPE for channel watcher durability").
The remaining channel-owner death path: an explicit SIGPIPE handler was
still exiting the process after Claude Code closed a pipe. SIGPIPE is
now ignored at the process level, and stream-specific EPIPE handlers
decide liveness. Diagnostic-pipe closure cannot kill a live `claude-code`
watcher; stdout/JSON-RPC failure is still fatal.

By 3.4.13 the death-path whack-a-mole had reached its peak. Every signal
or pipe event the host could throw at us was either ignored, swallowed,
or routed through the parent watchdog. The fact that we still hit fresh
deaths in 3.5.x (see below) was the first sign that signal-level patches
were treating symptoms, not the cause.

### 3.5.0 → 3.5.5: lifecycle and lease hardening

3.5.x shifted focus from "ignore each death path" to "make ownership
explicit and provable, instrument every transition, and survive transient
host glitches without false-positive shutdowns."

#### 3.5.0 (`652370b`) — local delivery + watcher standby recovery

Source: `652370b` ("Add local delivery and Claude watcher standby
recovery"). Two changes:

1. **First-class same-machine delivery.** `bridge_send_message` accepts
   the local machine name (or aliases `local`/`self`/`localhost`) and
   writes directly to `~/.agent-bridge/inbox/<target>/<id>.json` without
   SSH loopback. Atomic temp-file + rename mirrors the SCP pattern.
2. **Channel-capable standby recovery.** Channel-capable processes that
   lost the lease race now retry every 2 s and promote themselves when
   the active owner becomes stale, matching the resilient OpenClaw
   watcher pattern. Channel notification writes are bounded by
   `AGENT_BRIDGE_CHANNEL_NOTIFY_TIMEOUT_MS` (default 10 s) so a wedged
   stdout JSON-RPC write leaves the inbox file retryable instead of
   pinning it forever.

Watcher lease arbitration via `~/.agent-bridge/locks/claude-code.watcher-lock.json`
becomes the canonical ownership signal that everything else builds on.

#### 3.5.1 (`4553b01`) — openclaw-channel local-routing parity

Source: `4553b01` ("Route same-machine replies through local inbox in
openclaw-channel"). 3.5.0 added local delivery to mcp-server but the
openclaw-channel outbound path (`deliverReply` in
`openclaw-channel/src/outbound.js`) still went through SSH. Mini-Claude
→ Mini-OpenClaw → reply back to Mini-Claude failed with "paired machine
not found in `~/.agent-bridge/config`" because the local machine is never
in SSH config. 3.5.1: parity with `sendLocalMessage` — `deliverReplyLocal`
writes directly to `~/.agent-bridge/inbox/<target>/<id>.json`.

#### 3.5.2 (`cfaf950`) — heartbeat + shutdown_diag + sibling-MCP step-down + SIGKILL backstop

Source: `cfaf950` ("3.5.2: heartbeat + shutdown_diag + sibling-MCP
step-down + SIGKILL backstop"). The pivotal instrumentation patch. Pre-3.5.2
the on-disk log went silent for minutes between events (the prune-pass
cadence is 5 minutes), so when a channel-owner died we couldn't tell
whether it died at minute 1 or minute 4 of any given gap. 3.5.2 adds:

- **Patch D (60 s heartbeat).** `server.heartbeat` event with `uptime_s`,
  `ppid`, `pid`, `rss_mb`, `lease`, `role`. Refed for channel-owner.
- **Patch E (`server.shutdown_diag`).** Active handles count, requests
  count, RSS, handle constructor names — captures what kept the event
  loop alive at teardown.
- **5 s SIGKILL backstop.** `process.kill(process.pid, 'SIGKILL')` 5 s
  after `shutdown()` enters, in case `process.exit(0)` is swallowed by a
  Node main thread stuck in an uninterruptible kernel wait.
- **Sibling-MCP step-down.** Inside the parent watchdog, when a different
  alive PID holds our `claude-code` watcher lease and that lease is
  fresh (`updatedAt` within 30 s), treat it as proof Claude Code spawned
  a fresh sibling MCP child and cleanly transferred ownership. Log
  `sibling.detected` and shut down. Without this, the older sibling
  stayed alive ignoring SIGTERM (correctly per 3.4.11) but without a
  stdin reader, eventually dying silently from EPIPE during a channel
  notification.

#### 3.5.3 (`01ca9b4`) — fatal-transport visibility + shared-lease stats

Source: `01ca9b4` ("3.5.3: log fatal transport exits and shared watcher
stats"). Live Mini evidence after 3.5.2 showed the remaining
channel-owner death path: a watcher could push a channel notification,
then see Claude close stdin / SIGTERM, and then disappear with no
`server.shutdown`, no `shutdown_diag`, no `parent.dead`, and a stale
`claude-code.watcher-lock.json`. The missing path was the stdout
JSON-RPC broken-pipe handler — stdout is the channel transport, so EPIPE
is fatal, but the old handler called `process.exit(0)` without durable
logging or lease cleanup.

3.5.3:

- Logs `stdout.broken_pipe_exit`, `stdin.broken_pipe_exit`,
  `unhandled_rejection.broken_pipe_exit`, `uncaught_exception.broken_pipe_exit`
  before exiting via the new `fatalTransportExit()` helper.
- Releases the watcher lease via `stopWatcher()` and stops inbox /
  prune state via `shutdownInbox()` before the fatal exit, when JS
  still has a chance.
- `bridge_inbox_stats` reads the shared watcher lease file so tools-only
  MCP children can report the real channel-owner PID/role/alive/fresh
  state, not just their own process-local "unknown" state.
- New `~/.agent-bridge/logs/mcp-server-sync-exit.log` — synchronous,
  logger-independent NDJSON breadcrumb. Records every
  `shutdown.enter` / `shutdown.before_process_exit` /
  `shutdown.force_exit_timer` / `shutdown.sigkill_backstop` /
  `signal.received` / `patch_f.backoff_exit`. Survives even when the
  async logger has been torn down.

This is also the first version that explicitly named the architectural
limit: "the `claude-code` watcher lives inside a Claude-managed MCP
stdio child. When Claude closes/reaps that stdout transport, live push
from that child is impossible." 3.6.0 was queued but explicitly not
shipped because the diagnostic instrumentation in 3.5.2/3.5.3 was a
strict prerequisite for evaluating whether the migration was even
necessary.

#### 3.5.4 (`99daaf0`) — obey Claude MCP lifecycle shutdown

Source: `99daaf0` ("3.5.4: obey Claude MCP lifecycle shutdown"). Live
Mini evidence showed Claude Code closed the MCP stdin transport
immediately after channel delivery and then sent SIGTERM two seconds
later. The process died before its next 5 s lease heartbeat, leaving a
stale lock. That timing strongly indicated Claude's plugin host was
intentionally reaping/recycling the stdio child and escalating when the
child ignored SIGTERM.

3.5.4 *removes* the previous channel-owner keepalive hack. Channel-owner
MCP children now treat stdin EOF/close and SIGTERM as host-requested
shutdown, mirroring the official Telegram plugin's lifecycle. Shutdown
releases the watcher lease and leaves undelivered messages pending for
the next live channel-owner / replay, instead of trying to outlive
Claude's transport and getting hard-killed.

This is the first version that explicitly says the boundary out loud: a
Claude-managed stdio MCP child cannot be a reliable always-on daemon
after Claude closes the transport. Reliable always-on delivery needs a
separate architecture. 3.5.4 made the existing architecture honest and
non-stale.

(The 3.4.9 → 3.4.13 keep-alive patches were retroactively classified as
"a dead-end because they fought Claude's plugin host instead of
cooperating with it.")

#### 3.5.5 (`c832653`) — Telegram-pattern lifecycle polish

Source: `c832653` ("3.5.5: Telegram-pattern lifecycle polish
(diagnostics-only)"). Adds Patch A (3-poll orphan watchdog) and Patch B
(persistent stderr tee) — both verbatim mirrors of the Telegram channel
plugin patches.

- **Patch A (3-poll orphan-watchdog confirmation).** Pre-3.5.5: the
  parent watchdog `setInterval` shut down on a single
  `kill(parentPid, 0)` ESRCH, and `process.stdin.on('end' | 'close')`
  shut down immediately. 3.5.5: the orphan watchdog now requires 3
  consecutive failed polls (≈15 s at 5 s polling) across parent-PID
  liveness AND stdin destroyed/readableEnded/errored before calling
  `shutdown()`. Any clean poll resets the counter, so transient ppid /
  stdin glitches under heavy load no longer false-trigger shutdown.
  True reparenting still terminates within ~15 s. New events:
  `parent.orphan_poll`, `parent.orphan_recovered`. `parent.dead` now
  fires only at the 3-poll confirmation boundary.
- **Patch B (persistent stderr tee).** `process.stderr.write` is teed
  to `~/.agent-bridge/logs/mcp-server-stderr.log` so post-mortem evidence
  survives Claude closing the diagnostic stderr pipe between turns.
  5 MiB rotation on startup.
- **Explicit `notification.push_failed` event** in `watcher.ts` carrying
  `decision: 'leave_pending_for_next_owner'` — distinguishes "we logged
  the rejection" from "we left the file pending for replay".

3.5.5 is the canonical 3.5.x baseline: a Claude MCP channel-owner
*cooperates* with lifecycle teardown but defends itself against transient
glitches that would have caused false-positive shutdowns under heavy
load.

### 3.6.0: the SPLIT (architectural mistake)

Source: `5715699` ("3.6.0: split channel host into dedicated Claude Code
plugin"). Design doc: `docs/3.6.0-channel-plugin-migration.md` (committed
as `52dca96`).

#### The reasoning at the time

After the 3.5.x diagnostic instrumentation we could see clearly that the
remaining death path was structural: the watcher lived inside an MCP
stdio child whose lifetime was governed by Claude Code's plugin host.
Each patch closed one race; the next one opened. The natural conclusion
was that the watcher needed to live in a process whose lifetime matched
the Claude *session*, not the tool *turn*.

Telegram was held up as the existence proof. The Telegram channel plugin
(`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/`) is
declared as an MCP-style server (`bun run start` spawning `server.ts`)
but Claude Code's plugin host launches it once per session, gives it a
stable stdin/stdout pair, and only tears it down when the session ends.
The Mac Mini Telegram plugin had been alive 21 hours+ at the time of
writing, with `[heartbeat]` lines marching once per minute.

The *wrong assumption* (the one that took six weeks to disprove): the
plugin host treated Telegram differently because it declared a long-lived
*channel capability*. We assumed: ship a peer plugin (`agent-bridge-channel`)
that declared the same `experimental.claude/channel` capability, kept the
watcher in there, demoted `mcp-server` to tools-only, and the channel
plugin would inherit Telegram's lifetime guarantees.

#### What 3.6.0 shipped

- **New plugin: `agent-bridge-channel`** (sourced from
  `claude-code-channel/`). Long-lived, session-scoped MCP server modeled
  on the Telegram plugin's `server.ts`. Owned the watcher lease, polled
  `~/.agent-bridge/inbox/claude-code/` at 2 s, emitted
  `notifications/claude/channel` back to the running session.
  Declared `experimental.claude/channel` capability with **zero MCP
  tools** (deliberately — outbound bridge tools lived in the separate
  `agent-bridge` mcp-server plugin).
- **`mcp-server` plugin demoted to tools-only by default.** Same 7
  user-facing `bridge_*` tools, no inbox watcher. The plugin host could
  freely respawn this child between turns without affecting the
  watcher.
- **Patches A–F adopted verbatim** in
  `claude-code-channel/src/index.ts`. Same persistent stderr tee, same
  `shutdownWithReason` funnel, same 60 s heartbeat (refed), same
  `shutdown_diag`, same 3-poll orphan watchdog (15 s confirmation
  across `ppid != bootPpid` OR `stdin.destroyed` OR
  `stdin.readableEnded`), same Patch F (heartbeat-recency guard against
  parallel subagent spawn — using the lease file's `updatedAt` instead
  of an stderr-log mtime, same intent).
- **Marketplace updated** to expose both plugins side by side.
- **Wire format unchanged.** 3.5.x ↔ 3.6.x peers fully interoperable
  during rollout because `BridgeMessage` JSON shape, per-target inbox
  layout, `.delivered` / `.processed` ledgers, watcher lease format, and
  SCP outbound path all matched 3.5.x byte-for-byte. Per-machine rollout
  was supported.

The lifecycle posture diagram in the 3.6.0 design doc:

```
Claude Code session ──spawns──> [agent-bridge-channel plugin]   (session-scoped, REFED)
                       │           ├── inbox watcher
                       │           └── notifications/claude/channel push
                       │
                       └─spawns──> [agent-bridge MCP child]      (per-turn, free to recycle)
                                   └── bridge_* tools
```

Tools and channel coordinated exclusively via the filesystem (the lease
file). The MCP plugin host could freely respawn the tools child; the
watcher in the channel plugin was supposed to be undisturbed.

#### Why this was wrong

The split fixed the wrong layer. The host's reaping decision is *not*
based on which plugin manifest declares which capability, and it's
*not* based on whether the plugin is "channel-only" or "tools+channel."
It's based on `tools/call` traffic on the JSON-RPC pipe. A plugin with
zero tools registered, and zero `tools/call` requests received, presents
as completely idle to the host's reaper. The host classified our brand
new "session-lifetime" channel plugin as immediately reapable.

We didn't yet know that. So 3.6.1 → 3.6.3 spent the next five days
piling on patches trying to save the split.

### 3.6.1 → 3.6.3: trying to save the split

#### 3.6.1 (`bba1808`) — `readableEnded` is not orphan signal on Node

Source: `bba1808` ("3.6.1: Fix orphan-watchdog killing channel plugin
within 15s of spawn"). The 3.6.0 channel plugin shipped with the
3-poll orphan watchdog but it always tripped within 15 s of every spawn.
Production logs:

```
channel.orphan_poll: poll 1/3, stdin_ended: true,  ppid_changed: false, stdin_destroyed: false, stdin_errored: false
channel.orphan_poll: poll 2/3, stdin_ended: true,  ...
channel.orphan_poll: poll 3/3, stdin_ended: true,  ...
channel.shutdown reason="orphan-watchdog: stdin readableEnded"
```

**Root cause.** Claude Code's MCP plugin host writes JSON-RPC messages
to the child's stdin during the initial handshake and then leaves the
pipe idle (it stays open — JSON-RPC continues to flow over it for as
long as the host wants to talk to the child). On Node, the MCP SDK's
`StdioServerTransport` consumes those buffered handshake bytes via the
readable interface, which causes `process.stdin.readableEnded` to flip
to `true` even though the pipe is still open. The orphan watchdog
treated `readableEnded === true` as a sign the parent had gone away
and shut down within 15 s of every spawn.

The Telegram channel plugin uses the same Patch A logic and doesn't die
because it runs under bun, which handles stdin lifecycle differently —
`readableEnded` doesn't transition the same way. On Node we have to be
stricter about what counts as orphan.

**Fix.** Drop `stdin.readableEnded === true` from the orphan check in
both `claude-code-channel/src/index.ts` and `mcp-server/src/index.ts`.
The remaining orphan signals — `ppid !== bootPpid`,
`stdin.destroyed === true`, `stdin` had an `'error'` event — are
sufficient to detect true reparenting / pipe failure. An IDLE stdin is
not an orphan signal on Node; only an actively-broken or actually-destroyed
stdin is. `stdin_ended` is still logged in the orphan_poll context for
diagnostics, but it no longer contributes to the orphan decision.

This kept the channel plugin alive past spawn but didn't save it from
the longer-cycle reaping that surfaced next.

#### 3.6.2 (`d4a2cdb`) — Patch G: channel-owner ignores SIGTERM

Source: `d4a2cdb` ("3.6.2: Patch G — channel-owner ignores SIGTERM
while parent alive"). 3.6.1 fixed the orphan watchdog killing the plugin
within 15 s of every spawn. Production usage on Mac Mini then revealed a
deeper, longer-cycle problem: after ~10 hours of healthy operation
Claude Code's plugin host SIGTERMs the channel plugin, the plugin shuts
down cleanly via `shutdownWithReason('SIGTERM')` — and Claude Code
**does not respawn it within the same session**. Inbound channel
messages stop being delivered until manual `/reload-plugins` or restart.

**Empirical evidence (Mac Mini, 2026-04-25 23:46:31 BST).**

- `claude-code-channel` pid 40537 had 35,875 s (~9.95 h) of clean
  uptime, 60 s heartbeats, no errors.
- Single SIGTERM landed; plugin honored it, dumped shutdown
  diagnostics, released the watcher lease.
- No subsequent `channel.starting` event in the unified log. 13 messages
  piled up undelivered in `~/.agent-bridge/inbox/claude-code/`.
- The Telegram plugin (pid 36753, same parent ppid=36734, started in
  the same session) had been running 21 h+ at the same point — never
  SIGTERM'd.

**Root cause hypothesis at the time.** Claude Code's plugin host
periodically reaps MCP children that look idle from its tool-activity
heuristic. The Telegram plugin survives because it registers four
tools (`reply`, `react`, `download_attachment`, `edit_message`) — every
tool call counts as activity. Our channel plugin registered only the
`experimental.claude/channel` capability with **zero tools**
(deliberately). With nothing to mark it "active", the host's idle
reaper swept it and did not restart channel-only plugins within a
session.

(This was the *first* version where we explicitly named tool-activity as
the gating heuristic. The mistake then was assuming the gate was
"register a tool" rather than "have tools called frequently.")

**Fix (Patch G).** `claude-code-channel/src/index.ts` installs a
`handleSignal` wrapper that ignores SIGTERM IFF the watcher started
successfully AND the parent (Claude Code session) pid is still alive.
The orphan watchdog (Patch A) still terminates within ~15 s on true
reparenting; the stdout/stdin EPIPE handlers still terminate on broken
transport; SIGINT/SIGHUP remain explicit shutdown signals. So the only
thing suppressed is Claude's idle reaper killing a healthy long-lived
watcher. `AGENT_BRIDGE_DISABLE_PATCH_G=1` overrides for tests.

**Why Patch G alone wasn't enough.** Mac Mini production evidence,
2026-04-26 12:26 BST, pid 89205:

- 12:26:34Z: pushed an inbound notification successfully (heartbeats
  and watcher healthy throughout).
- 12:26:36Z: SIGTERM landed; Patch G logged
  `signal.ignored_channel_owner` and returned without shutting down.
- 12:26:36Z: process gone. No exit breadcrumb, no shutdown log — only
  the stale lease file remained. Process uptime at death: 172 s.

The host was using two-stage termination (SIGTERM → SIGKILL) on plugins
it considered reapable. Patch G survived the first stage but not the
second.

#### 3.6.3 (`3640f03`) — Patch H: register a no-op MCP tool

Source: `3640f03` ("3.6.3: Patch H — register no-op MCP tool to prevent
channel-plugin reaping"). The 3.6.2 evidence pointed clearly at
two-stage SIGTERM → SIGKILL. The next refinement of the hypothesis: the
host classifies tool-capable plugins as "active / interactive" and
*excludes them from the idle reaper sweep entirely*. Channel-only
plugins (no tools registered) are classified as "disposable" — and even
when they ignore SIGTERM, the host follows through with SIGKILL.

**Patch H.** Register a single no-op MCP tool —
`claude_code_channel_status` — returning a small JSON status object:
`pid`, `ppid`, `uptime_s`, `version`, `machine`, `watcher_active`,
`lease`, `tool_calls_received_count`, `tool_boot_time_ms`. The tool's
description discouraged calling it for normal use (agents should use
`bridge_send_message`), but its existence registered the channel plugin
as tool-capable in the host's classification. Patch G was retained as
defence-in-depth.

**Patch H evidence logging.** To distinguish "Patch H prevented reaping"
from "different failure mode" if the issue resurfaced, every signal
arrival now logs a `signal.evidence` event with: `parent_alive`,
`stdin_destroyed`, `stdin_readable_ended`, `last_notification_at_ms`,
`last_notification_age_ms`, `tool_calls_received_count`, `uptime_s`.
Same fields added to the existing `signal.ignored_channel_owner` event
and the `signal.received` sync exit breadcrumb.

**Why Patch H still wasn't enough.** Production logs after 3.6.3 showed
the no-op tool was almost never called — `tool_calls_received_count`
stayed at 0 across the entire pre-SIGTERM lifetime of every reaped
instance. Claude Code agents prefer `bridge_send_message` (which lives
in the *sibling* `agent-bridge` plugin) for actual work, and the no-op
tool's description specifically told them not to call it. Registration
alone was not enough; the host gates on actual call traffic. Each
instance died at a different uptime — 102 s, 172 s, 15519 s — which fits
"reaping after a quiet window past the last `tools/call`" rather than
any deterministic timer.

The Mac Mini deployment continued to lose channel delivery roughly every
session-internal idle window, regardless of patches. By 2026-04-26
afternoon the cumulative evidence pointed unambiguously at tool-call
*frequency*, not tool *registration*.

### 3.7.0: the UNIFICATION (correct fix)

Source: `c23feae` ("3.7.0: undo 3.6.0 split — combine tools + channel
into one plugin"). The fix was to unwind the split entirely. With the
unified plugin:

- Every `bridge_send_message` an agent sends resets the host's idle
  counter. (Frequent call — primary inter-machine communication.)
- Every `bridge_status` / `bridge_inbox_stats` poll resets the counter.
- Every `bridge_list_machines`, `bridge_run_command`,
  `bridge_clear_inbox`, `bridge_receive_messages` invocation also
  resets it.
- The channel watcher and channel push live in the same process, so
  inbound messages are delivered without a second plugin lifecycle to
  manage.

This is precisely how Telegram works. Same pattern, same lifetime
guarantees. The channel-only architecture was a wrong turn.

#### Architecture changes

- **One plugin.** `agent-bridge` (the existing tools-only plugin name),
  hosting BOTH the 7 user-facing tools AND the channel watcher. Channel
  capability declared via `experimental.claude/channel`. Default
  `AGENT_BRIDGE_ROLE` is now `channel-owner` (acquires the inbox lease
  at startup and pushes channel notifications). `tools-only` remains
  supported for non-Claude hosts (OpenClaw / Codex / Gemini-CLI
  sidekicks that just want outbound `bridge_*` tools without contending
  for the lease).
- **All eight patches retained.** Patch A (3-poll watchdog) at
  `mcp-server/src/index.ts:851`, `:932`. Patch B (stderr tee) at
  `mcp-server/src/index.ts:73-98`. Patch C (`shutdown(reason)` funnel)
  at `mcp-server/src/index.ts:656`. Patch D (60 s heartbeat) at
  `mcp-server/src/index.ts:890`. Patch E (`shutdown_diag`) at
  `mcp-server/src/index.ts:687`. Patch F (heartbeat-recency
  parallel-spawn guard) at `mcp-server/src/index.ts:100-190`. Patch G
  (channel-owner SIGTERM ignore + parent-alive check) at
  `mcp-server/src/index.ts:754-836`. Patch H (no-op
  `claude_code_channel_status` MCP tool registration) at
  `mcp-server/src/index.ts:437-491`.
- **`claude_code_channel_status` retained.** No longer load-bearing for
  liveness, but useful as a status diagnostic — returns `pid`, `ppid`,
  `uptime_s`, `version`, `machine`, `watcher_active`, `lease`,
  `tool_calls_received_count`, `tool_boot_time_ms`. The
  `signal.evidence` event from 3.6.3 is also retained, with the same
  forensic fields.
- **Lease heartbeat refed for channel-owner.**
  `mcp-server/src/watcher.ts`'s lease-renewal interval is refed when
  `role === 'channel-owner'` (previously always unref'd). The unified
  plugin must keep the event loop alive across idle gaps — same
  posture as the 3.6.0 channel plugin had.
- **Deleted.** The entire `claude-code-channel/` package — `src/`,
  `test/`, `package.json`, `package-lock.json`, `.mcp.json`,
  `.claude-plugin/`, `README.md`, `tsconfig.json`, `build/`,
  `node_modules/`.
- **Marketplace updated.** Removed `agent-bridge-channel` entry;
  updated `agent-bridge` description to reflect unified posture.

#### Migration steps for existing 3.6.x users

1. `claude plugin uninstall agent-bridge-channel@agent-bridge` — drops
   the now-deleted plugin.
2. `claude plugin install agent-bridge@agent-bridge` — reinstalls the
   unified plugin so the cache reflects 3.7.0.
3. Update launch alias. Remove
   `--dangerously-load-development-channels plugin:agent-bridge-channel@agent-bridge`
   from the `claude-tel` alias. Only
   `--dangerously-load-development-channels plugin:agent-bridge@agent-bridge`
   is needed now.
4. Restart Claude session. The unified plugin spawns once and stays
   alive throughout (same lifetime as Telegram).

The on-disk wire format is unchanged. A 3.6.x peer (running both
plugins) and a 3.7.0 peer (running the unified plugin) interoperate
fully — the lease file mediates ownership when both are present
transiently on the same machine. Per-machine rollout is supported.

---

## What we learned about Claude Code's plugin host

Empirically observed behaviours, ordered roughly by confidence:

- **Plugin host monitors `tools/call` requests on stdio for activity
  tracking.** This is the gating signal for idle-reaping. Frequency,
  not registration, is what matters.
- **Channel notifications (`server.notification` → `notifications/claude/channel`)
  flow plugin → host and do NOT count as activity.** They are
  server-pushed events, not client-initiated tool invocations. From the
  host's plumbing perspective the request side of the JSON-RPC pipe is
  silent during pure channel push.
- **Tool registration alone (in `tools/list`) is not sufficient.**
  3.6.3 / Patch H was a counterexample: registered the
  `claude_code_channel_status` tool, never received a `tools/call` for
  it, still got reaped.
- **After a notification delivery, the plugin host appears to evaluate
  "still useful?"** If no recent `tools/call` traffic, sends SIGTERM.
  If SIGTERM is ignored, escalates to uncatchable SIGKILL within ~2 s.
  This is *two-stage termination*; Patch G survives the first stage but
  not the second.
- **Long-poll network activity (Telegram's grammy long-polling against
  the Bot API) is irrelevant from the plugin host's view.** Telegram
  doesn't survive because it long-polls; it survives because every
  user message you reply to / react to / download / edit causes an MCP
  `tools/call` on the stdio pipe.
- **File-system polling, internal heartbeats, watchdog timers — all
  internal to the process.** The plugin host doesn't see them; they
  cannot affect reapability.
- **Sibling-spawn during `/reload-plugins`.** A new child spawns; the
  old child should yield via the sibling-MCP step-down (3.5.2). If it
  doesn't, the old child stays alive without a stdin reader and
  eventually dies silently from EPIPE during a channel notification.
  3.5.2's `sibling.detected` event makes the handoff visible.
- **Stdin destroy/close from the host side is a "transport done"
  signal.** It is *not* a "shutdown immediately" command. The 3-poll
  orphan watchdog (Patch A) correctly distinguishes transient stdin
  glitches under heavy load from real reparenting.
- **Stdin `readableEnded` on Node is not a reliable orphan signal.**
  The MCP SDK's `StdioServerTransport` consumes the buffered handshake
  bytes via the readable interface, which flips `readableEnded` to
  `true` even though the pipe is still open. This was 3.6.1's specific
  fix. Telegram doesn't hit this because bun handles stdin lifecycle
  differently.
- **`process.exit(0)` can be swallowed by a Node main thread stuck in
  an uninterruptible kernel wait** (U state — wedged fetch syscall,
  hung fs operation). 3.5.2's 5 s SIGKILL self-destruct backstop
  (`process.kill(process.pid, 'SIGKILL')`) is the only kernel-delivered
  guarantee.
- **Reap windows have high variance.** Across captured Mac Mini
  evidence: 102 s, 172 s, 15519 s. This rules out a deterministic
  reaper interval; the reaper appears to evaluate at notification-delivery
  time and/or quiet-window boundaries.

---

## How to debug channel/plugin issues going forward

Practical guidance for the next person (or future Claude session) hitting
a similar issue.

1. **Check for zombie/stale processes first.** Per the global Claude
   instructions: many "weird plugin behaviour" sessions turn out to be
   zombie process interference, not actual logic bugs. Run
   `ps -axo pid,ppid,etime,stat,command | grep -E "agent-bridge|mcp-server" | grep -v grep`
   before anything else. SIGTERM stale ones, SIGKILL if stuck.
2. **Read `~/.agent-bridge/logs/agent-bridge.log` (the unified NDJSON
   log)** with `jq -s '.'`. Filter for `event` values like
   `server.heartbeat`, `server.shutdown`, `server.shutdown_diag`,
   `signal.evidence`, `signal.ignored_channel_owner`, `parent.dead`,
   `parent.orphan_poll`, `sibling.detected`, `patch_f.backoff`,
   `message.pushed_to_channel`, `message.push_failed`,
   `notification.push_failed`.
3. **Read `~/.agent-bridge/logs/mcp-server-stderr.log`** (Patch B's
   persistent stderr tee) for anything that didn't make it into the
   structured log — Node warnings, throw-trace dumps, MCP SDK errors.
4. **Read `~/.agent-bridge/logs/mcp-server-sync-exit.log`** (the sync
   exit breadcrumb). Each line is one of `shutdown.enter`,
   `shutdown.before_process_exit`, `shutdown.force_exit_timer`,
   `shutdown.sigkill_backstop`, `signal.received`, `patch_f.backoff_exit`.
   Survives even when the async logger is torn down — this is your
   only reliable signal for the absolute final moments of a death.
5. **The `signal.evidence` event is gold for post-mortem.** Fields:
   `signal`, `parent_alive`, `stdin_destroyed`, `stdin_readable_ended`,
   `last_notification_at_ms`, `last_notification_age_ms`,
   `tool_calls_received_count`, `uptime_s`. The combination
   `parent_alive=true`, `stdin_destroyed=true`,
   `last_notification_age_ms ~2000`, `tool_calls_received_count=0`
   is the classic "host reaped me after a notification delivery"
   fingerprint.
6. **Watcher lease state.**
   `~/.agent-bridge/locks/claude-code.watcher-lock.json` — `pid`,
   `updatedAt`, `role`. `kill -0 <pid>` to check liveness. If a
   different live PID owns it with fresh `updatedAt` (< 90 s), Patch F
   should have already backed us off; if we're still spawning, that's a
   bug.
7. **Compare against Telegram.** If Telegram is healthy and agent-bridge
   isn't, the difference is almost certainly tool-call frequency. Run
   `claude_code_channel_status` from the running session and check
   `tool_calls_received_count`. If it's near zero, the unified plugin
   isn't getting tool-call traffic and is at risk of reaping despite
   the unification.
8. **Don't reach for `/reload-plugins` to fix a reaped channel
   plugin.** Once Claude Code has classified the plugin as "completed"
   in the current session, that classification persists. Restart the
   session.

---

## What NOT to do

Lessons from six weeks of this:

- **DON'T split plugins to "make the channel survive longer."** The
  3.6.0 split was based on a wrong model of what the host gates on. A
  channel-only plugin presents as more idle to the host, not less.
- **DON'T rely on `/reload-plugins` to respawn a plugin Claude has
  classified as "completed."** That classification persists for the
  session.
- **DON'T assume registration of a tool is enough.** Claude must
  actually CALL it. Registered-but-never-called is functionally
  invisible to the host's idle classifier (3.6.3 / Patch H proved this
  the hard way).
- **DON'T add a SIGKILL self-destruct backstop for normal operation.**
  It's only useful for genuine uninterruptible-wait pathology
  (`process.exit(0)` swallowed by a stuck kernel syscall). For normal
  shutdown, the 2 s force-exit timer with `process.exit(0)` is the
  right hammer.
- **DON'T fight Claude Code's MCP child lifecycle with keepalive
  hacks.** 3.4.9 → 3.4.13 was a five-patch dead-end of "ignore stdin
  end / SIGTERM / SIGPIPE / stderr EPIPE." 3.5.4 explicitly reversed
  course: cooperate with lifecycle teardown, release the lease, leave
  pending messages for the next live owner / replay. The 3.7.0 fix is
  to make sure the host doesn't *want* to tear us down in the first
  place — by getting tool-call traffic.
- **DON'T treat `process.stdin.readableEnded` on Node as an orphan
  signal.** The MCP SDK consumes handshake bytes via the readable
  interface, which flips it to `true` even on a healthy live pipe.
  Use `stdin.destroyed` and `stdin` `'error'` events instead.
- **DON'T assume long-poll network traffic counts as activity.**
  Telegram is misleading evidence — its grammy long-polling is
  irrelevant; it's the user-driven `tools/call` traffic that keeps it
  alive.

---

## Architecture invariants (post-3.7.0)

Things that should stay consistent moving forward, encoded so a future
patch doesn't accidentally regress.

- **One plugin.** `agent-bridge`. Channel + tools live together. Do not
  re-split unless the host's classifier semantics change in a way that
  makes a tool-less channel plugin viable.
- **Default `AGENT_BRIDGE_ROLE=channel-owner`.** `tools-only` is opt-in
  only for non-Claude hosts (OpenClaw, Codex, Gemini-CLI). Documented in
  `mcp-server/.mcp.json`.
- **Wire format unchanged from 3.4.x → 3.7.0.** `BridgeMessage` JSON
  shape, per-target inbox subdir layout
  (`inbox/claude-code/`, `inbox/openclaw/<acct>/`),
  `.delivered` / `.processed` ledgers, watcher lease path/format,
  SCP outbound path. Any cross-version peer combo interoperates.
- **Watcher lease at
  `~/.agent-bridge/locks/claude-code.watcher-lock.json`** is the single
  source of truth for ownership. Patch F (heartbeat-recency guard) and
  the sibling-MCP step-down both consult it; the lease's `updatedAt`
  is the recency signal.
- **Lease heartbeat refed for channel-owner role.** Tools-only and
  standby keep it unref'd so they can't pin Node alive past stdio
  close.
- **All eight patches (A–H) stay in.** Each one has a documented
  failure mode it prevents. Even ones that are no longer
  load-bearing in 3.7.0 (Patch G, Patch H) are kept as
  defence-in-depth.
- **`signal.evidence` event format is stable.** Future patches can add
  fields, but must not rename the existing ones — post-mortem tooling
  depends on them.
- **`mcp-server-sync-exit.log` format is stable.** Same reasoning.
- **No `console.log` to stdout — ever.** Stdout is the JSON-RPC
  transport. Use `console.error()` or the structured logger.
- **Stdout EPIPE is fatal.** A broken JSON-RPC transport means channel
  delivery is impossible; tolerating it would create a deaf-but-live
  channel-owner silently swallowing messages. Stderr EPIPE is *not*
  fatal (Patch B / 3.4.12).
- **OpenClaw is unaffected by any of this.** The `openclaw-channel/`
  package is structurally separate and was never part of the 3.6.0
  split or the 3.7.0 unification. Watches `inbox/openclaw/<target>/`,
  pairs with the unified `agent-bridge` plugin's outbound tools
  exactly as before.

---

## References

- **Source files (HEAD `c23feae`).**
  - `mcp-server/src/index.ts` — main entrypoint with all eight patches.
  - `mcp-server/src/watcher.ts` — inbox poller, lease, channel push,
    `notification.push_failed` event.
  - `mcp-server/src/tools.ts` — 7 user-facing `bridge_*` tools.
  - `mcp-server/.mcp.json` — env block with default
    `AGENT_BRIDGE_ROLE`.
  - `.claude-plugin/marketplace.json` — single-plugin manifest after
    the 3.7.0 unification.
- **Key commits.**
  - `25a82c3` "Stabilize agent-bridge watcher and channel runtime"
    (3.4.6 baseline).
  - `bec6ce0` (3.4.7 channel-parent guard), `781bba1` (3.4.8
    detection-regex fix), `c681324` (3.4.9 keep watcher alive
    between turns), `b519d33` (3.4.10 keep parent watchdog refed),
    `7611bfe` (3.4.11 channel-owner ignores benign SIGTERM),
    `50e561c` (3.4.12 swallow stderr EPIPE), `7da713e` (3.4.13
    ignore SIGPIPE).
  - `652370b` (3.5.0 local-delivery + standby), `4553b01` (3.5.1
    openclaw parity), `cfaf950` (3.5.2 heartbeat + shutdown_diag +
    sibling step-down + SIGKILL backstop), `01ca9b4` (3.5.3
    fatal-transport visibility), `99daaf0` (3.5.4 obey lifecycle),
    `c832653` (3.5.5 Telegram-pattern polish, Patches A + B).
  - `52dca96` "Design: 3.6.0 claude-code-channel plugin migration"
    (the design doc that codified the wrong assumption).
  - `5715699` (3.6.0 split), `bba1808` (3.6.1 readableEnded fix),
    `d4a2cdb` (3.6.2 Patch G), `3640f03` (3.6.3 Patch H).
  - `c23feae` (3.7.0 unification).
- **Related files.**
  - `CHANGELOG.md` — version-by-version narrative.
  - `docs/3.6.0-channel-plugin-migration.md` — the original design
    doc, kept for reference. Read with hindsight: the assumption
    that a session-lifetime channel plugin would inherit Telegram's
    lifetime guarantees was wrong.
  - `~/.agent-bridge/logs/agent-bridge.log` (unified NDJSON),
    `~/.agent-bridge/logs/mcp-server-stderr.log` (Patch B tee),
    `~/.agent-bridge/logs/mcp-server-sync-exit.log` (sync breadcrumb)
    — runtime evidence for any future post-mortem.

---

## 3.7.1 — Patch F race fix (standby+retry) + stale-version peer kill (2026-04-26)

3.7.0 shipped earlier the same day with the unified-plugin design and all
eight A–H patches kept as defence-in-depth. Within hours of deployment the
MBP `/reload-plugins` migration from 3.6.1 → 3.7.0 surfaced two distinct
failure modes that the 3.7.0 form of Patch F could not handle. 3.7.1 patches
both.

### Bug 1 — Patch F exit-vs-reload race

The 3.7.0 form of Patch F was: "if a peer holds the lease and its heartbeat
is fresh, exit cleanly so the peer keeps running." That assumed the peer was
about to keep running. During a `/reload-plugins`-driven version migration
the assumption is wrong: the peer is the OLD plugin and is being actively
reaped. The NEW plugin sees a fresh heartbeat, exits, and leaves no successor
once the OLD plugin actually dies.

**Live evidence (2026-04-26 ~20:29 BST, MBP):**

- 20:28:?? — `/reload-plugins` triggered, NEW pid 95679 spawned (3.7.0).
- 20:28:?? — pid 95679 reads OLD pid 34781's lease (3.6.1, fresh heartbeat),
  emits `patch_f.backoff_exit`, exits 0.
- 20:28:?? — NEW pid 98451 spawned, same path, same result.
- 20:29:03 — OLD pid 34781 receives SIGTERM, releases lease, exits.
- 20:29:03 → indefinitely — no live channel-owner on MBP. Channel delivery
  silently broken until the next plugin spawn.

**Fix.** Replace the `process.exit(0)` in Patch F with a fall-through into
`main()` so the normal `startWatcher` → `scheduleStandbyRetry` machinery
(already present in `watcher.ts` for the `tryAcquireWatcherLease` busy path)
takes over. The new plugin stays alive in standby, polls the lease every
2 s, and steals it as soon as the peer's heartbeat goes stale per
`watcherLeaseIsStale` (>15 s old). Net behaviour: no exit, no race window,
no orphan period.

Compatibility breadcrumb in `mcp-server-sync-exit.log` now writes
`patch_f.backoff_standby` (suffix changed from `_exit` to `_standby`) so
post-mortem tooling can distinguish new from old behaviour.

### Bug 2 — Stale-version peers blocking the lease

Even with Bug 1 fixed, a stale-version peer (e.g. 3.6.1 still running while
the host has already loaded 3.7.1's manifest) would block the lease for the
full 15 s heartbeat-stale window before the standby could steal. During
version migrations that's 15 s of channel-delivery downtime per spawn.

**Fix.** When the existing lease's `version` field is strictly older than
our build's version, force migration:

1. Send `SIGTERM` to the peer pid.
2. Synchronously wait up to 2 s for the peer to exit (poll `kill(pid, 0)`
   every 100 ms via `Atomics.wait` on a SharedArrayBuffer `Int32Array` —
   the Patch F block runs at module-load time, before the event loop is
   doing real work, so a synchronous wait is safe and concise).
3. If still alive after 2 s, `SIGKILL`.
4. Fall through to `main()`. The lease is now stale and `startWatcher`
   steals it.

Same-version peers are never killed (Patch F respects same/newer).
Unknown-version peers (lease written by 3.7.0 or earlier, no `version`
field) are treated as same-version for safety — no kill.

### Lock file format change

`WatcherLeaseFile` gains one optional field:

```ts
type WatcherLeaseFile = {
  // ... existing fields ...
  /** Optional, 3.7.1+. semver string. Absent on leases written by 3.7.0
   *  or earlier; treated as "same-version" by Patch F's peer-kill path. */
  version?: string;
};
```

`tryAcquireWatcherLease` now writes `MCP_SERVER_VERSION` (a single constant
in `config.ts` shared with `index.ts`). Forward- and backward-compatible
with 3.7.0 watchers — the field is JSON-extra, so older readers ignore it.

### New events

- `patch_f.standby` — emitted when a same- or unknown-version healthy peer
  holds the lease and we enter standby+retry instead of exiting.
- `patch_f.peer_version_kill` — emitted when we SIGTERM an older peer.
  Context: `peer_pid`, `peer_version`, `our_version`, `pid`.
- `patch_f.peer_version_sigkill` — emitted when the 2 s SIGTERM grace
  expires and we escalate to SIGKILL.

The legacy `patch_f.backoff` and `patch_f.backoff_exit` events are gone.
`patch_f.check_error` is unchanged.

### What this changes

- `mcp-server/src/index.ts` — Patch F block (`index.ts:100-190` in 3.7.0)
  refactored. Old form: probe fresh peer → `process.exit(0)`. New form:
  probe fresh peer → branch on `compareSemver(peer.version, our.version)`
  → either kill+steal (older) or fall through to standby (same/unknown).
- `mcp-server/src/watcher.ts` — `WatcherLeaseFile` extended with optional
  `version`; `readWatcherLease` exposes it; `tryAcquireWatcherLease`
  writes it from `MCP_SERVER_VERSION`.
- `mcp-server/src/config.ts` — new `MCP_SERVER_VERSION = '3.7.1'`
  constant; both `index.ts` and `watcher.ts` import from here.
- `mcp-server/test/unified-channel.test.mjs` — replaces the 3.7.0 exit-on-
  backoff test with a standby test, adds a "standby promotes after stale
  heartbeat" test, and adds an end-to-end stale-version peer-kill test.

### Compatibility

- Wire format unchanged. Channel notifications, BridgeMessage JSON, and
  SSH transport are all identical to 3.7.0.
- Lock file format gained one optional field. Forward- and backward-
  compatible with 3.7.0 readers.
- Patches G and H untouched. 3.7.1 only changes Patch F's behaviour
  inside the `holderAlive === true` branch.

### Migration story (live, MBP, 2026-04-26)

- Pre-3.7.1: NEW plugins exited via `patch_f.backoff_exit`, OLD plugin
  died unannounced, MBP had no channel-owner until next spawn.
- Post-3.7.1: NEW plugin sees OLD's older `version` in the lease,
  `SIGTERM`s OLD, waits 2 s, OLD has exited cleanly, NEW steals the
  lease via `tryAcquireWatcherLease`. Channel delivery has zero
  observable downtime.
- If a 3.7.1 NEW plugin sees a SAME-version 3.7.1 peer, it standbys
  + retries. The peer keeps owning delivery; the standby is ready to
  take over within 2 s of the peer dying.

---

## 3.8.0 — long-poll receive

**Date:** 2026-04-26  ·  **Scope:** new feature, no lifecycle regression risk.

3.8.0 is the first release in the 3.x series that does NOT touch the channel
plugin's lifecycle posture. All eight lifecycle patches (A–H) and the 3.7.1
standby+retry / stale-version peer-kill paths are preserved verbatim. The
release adds **long-poll receive** to `bridge_receive_messages`.

### The problem

Channel-push delivery (`notifications/claude/channel`) is parent-session-only.
When the agent-bridge MCP plugin pushes an inbound BridgeMessage into Claude
Code, the notification flows through the stdio JSON-RPC pipe of the **parent
Claude session** that owns the plugin transport. **Subagents do not see
channel pushes** — they have their own conversation context, and the SDK
notification plumbing terminates at the parent.

Pre-3.8.0 workarounds for "subagent needs to receive a bridge reply":

1. **Busy-poll `bridge_receive_messages`** — works, but every poll is one
   MCP request = several tokens. Five-second polling for 60 s = 12 wasted
   round-trips.
2. **Don't receive at all** — subagent fires off a `bridge_send_message`
   and the parent reports back. Adds a hop and a dependency on the parent
   reading the channel push and forwarding it.
3. **Spawn a fresh Claude session** for the subagent — works, but expensive
   and defeats the in-context advantages of being a subagent.

### The fix

`bridge_receive_messages` now accepts:

- `wait: boolean` (default `false`)
- `timeout_seconds: number` (default `30`, capped at `60`)

When `wait=true`, the MCP tool handler:

1. Peeks the inbox once. If non-empty, returns immediately (fast path).
2. Otherwise registers a one-shot listener with the watcher's in-process
   arrival registry (`subscribeToInboxArrival`).
3. Races the listener against `setTimeout(timeout_seconds * 1000)`.
4. On wake (file arrival), re-reads the inbox via peek/consume and returns.
5. On timeout, returns `[]` plus `timed_out: true` in `structuredContent`.

The listener registry is BROADCAST: every concurrent long-poller wakes on
every arrival. The peek/consume flag governs whether the file is archived
after read — broadcast + idempotent peek = parent and N subagents all see
the same content; broadcast + consume = first caller wins (use unique
`from_target` per subagent for true one-receiver semantics).

### Relationship to channel-push routing

Channel push is NOT replaced. The parent session still receives `<channel
source="agent-bridge" ...>` blocks for every inbound message. Long-poll is
**additive** — a per-call subagent escape hatch that reads the same inbox
the channel watcher reads. Because both paths go through the same
`inbox/claude-code/` directory and the same `markDelivered` ledger, you
cannot lose a message: either the channel-push fires (parent gets it) or
the long-poll fires (subagent gets it), and both consult the same
`pendingFiles` cache.

### Why no lifecycle changes were needed

The long-poll listener is a `setTimeout` + a Set entry. Both are tiny and
have no effect on the MCP plugin host's idle classifier — the host still
sees `tools/call` traffic from `bridge_receive_messages` itself, which is
exactly what 3.7.0's "merge channel + tools" design relies on for
liveness. If anything, 3.8.0 *increases* `tools/call` frequency for
subagent-heavy workloads (each long-poll is a fresh tool call).

### Test coverage

`mcp-server/test/long-poll-receive.test.mjs` — 6 tests covering: default
no-wait behaviour, wait+immediate-arrival, wait+arrival-mid-window,
wait+timeout, wait+two-concurrent-pollers (broadcast), and the
`timeout_seconds=9999 → 60` cap.

---

## 3.8.1 — Cross-platform send path via SFTP (2026-04-26)

3.8.0 added long-poll receive but kept the legacy 3.4.x SSH heredoc for the
send path:

```ts
// mcp-server/src/ssh.ts (≤3.8.0)
const command = [
  `dest=${destExpr}`,
  'dir="$(dirname "$dest")"',
  `tmp="$dir/${tmpName}"`,
  'mkdir -p "$dir"',
  'trap \'rm -f "$tmp"\' EXIT',
  `echo '${b64}' | base64 -d > "$tmp"`,
  'mv -f "$tmp" "$dest"',
].join(' && ');
return sshExec(machine, command, timeoutMs);
```

This worked fine cross-machine when both ends were Unix (macOS ↔ macOS,
macOS ↔ Linux). After 3.8.0 added Windows install support (`install.ps1`,
`agent-bridge.cmd`), Mac Mini tried to send to a freshly-paired Windows
target and hit:

```
Failed to deliver message to SHITTYWINDOWS:
  'dest' is not recognized as an internal or external command,
  operable program or batch file.
```

Windows OpenSSH-server defaults to `cmd.exe` as the login shell.
`dest=...` looks like a command name to cmd.exe (the `=` is not a
separator), so the parser splits on the first space and tries to execute
`dest=...` as a program. None of `mkdir -p`, `mv`, `cat`, `echo '<b64>'
| base64 -d`, or `trap` exist on a default Windows install either, so
even if the first command had run, every subsequent one would have
failed.

### The fix

Switch the send path to the **SFTP subsystem**. SFTP runs `sftp-server`
(`sftp-server.exe` on Windows) directly via the SSH `subsystem` channel,
bypassing the login shell entirely. SFTP has native `put`, `rename`, and
`mkdir` operations — so we can keep atomic temp+rename delivery without a
remote `mv`/`move` shim.

New helpers in `mcp-server/src/ssh.ts`:

| Function | Role |
| --- | --- |
| `normalizeSftpPath(path)` | Strips leading `~/` (Windows OpenSSH-sftp does not expand it; SFTP's session cwd is the user's home dir on every platform). |
| `sftpParentDirs(path)` | Walks the directory chain so we can `-mkdir` each ancestor in turn (sftp's `mkdir` is single-level, not recursive). |
| `buildSftpBatch(local, remoteTmp, remoteFinal)` | Emits `-mkdir <ancestor>` ✕ N, `put <local> <remoteTmp>`, `rename <remoteTmp> <remoteFinal>`, `bye`. |
| `sftpExecSingle(...)` | Runs `sftp -i <key> -o ... -P <port> -b - user@host`, piping the batch script on stdin. Same endpoint selection (Tailscale-first, no fallback) and transient-retry handling as `sshExecSingle`. |

`sshWriteFile` itself becomes:

1. Stage `content` in a local temp file.
2. Compute `normalized = normalizeSftpPath(remotePath)` and
   `remoteTmp = ${normalized}.tmp.${randomUUID()}`.
3. `buildSftpBatch(localFile, remoteTmp, normalized)`.
4. `sftpExecSingle(...)` with the same retry loop the SSH path used.
5. `rmSync(localTmpDir)` in `finally` so we don't leak payloads on disk.

The watcher contract is preserved — it still only fires on `*.json`
creation, the `.tmp.<uuid>` file is invisible to its glob, and the
`rename` is what surfaces the message. No partial-JSON quarantine path
can fire under load.

### Why not "SCP-only" or per-platform branches?

- **SCP-only:** would need a separate cross-platform rename to land
  atomically (scp can only transfer, not rename remote files). Adding a
  rename shim means another SSH hop with shell-flavor detection — the
  exact thing we're trying to delete.
- **Per-platform branches:** would need the sender to know whether the
  remote is Unix or Windows. That state has to be discovered (a
  test-and-cache dance) and invalidated (what if the user re-pairs the
  same machine name as a different OS?). SFTP makes the question
  irrelevant.

### Wire-compatibility

`BridgeMessage` JSON, file naming, and inbox layout are unchanged. A
3.8.1 sender talks to any 3.4.x → 3.8.0 receiver — the receiver never
knew or cared whether the bytes arrived via `cat > $dest` vs `sftp put`.

### Test coverage

`mcp-server/test/sftp-write-file.test.mjs` — 10 tests covering
`normalizeSftpPath` (4 cases), `sftpParentDirs` (4 cases including
multi-segment `openclaw/<account>` targets), and `buildSftpBatch` (3
cases including a regression guard that the script never contains `$`,
`&&`, `mv -f`, `mkdir -p`, `cat `, `echo `, or `base64`).

48 tests / 48 passing.

---

## 3.9.0 — [CONSUME-RACE] consume-race fix (2026-04-28)

### The bug

3.4.x → 3.8.x marked messages delivered the moment
`savedChannelCallback`'s Promise resolved. The promise resolves when the
JSON-RPC `notifications/claude/channel` packet has been written to the
MCP server's stdout — but **stdout-write success is not proof the
receiving Claude harness rendered the message** into its conversation
context. Production Windows reproduced 6 silent drops in one session
(2026-04-28): each message was happily moved to `.archive/`, the
`.delivered` ledger grew, and the running Claude session never saw any
of them. No process churn, no stderr breadcrumbs — purely an optimistic-
ack failure.

The fingerprint:

```
{
  "event": "message.pushed_to_channel",   // we wrote stdout — succeeded
  "msg_id": "msg-…",
}
… (no further evidence the harness saw it) …
{
  "event": "message.delivered",           // we marked it delivered anyway
  "msg_id": "msg-…",                      // file moved to .archive/
}
```

### The fix — Option AC (hybrid)

Splits delivery into two phases with positive-confirmation finalize and
timeout-bounded reinject:

```
push  → stage to .pending-ack/<target>/<id>.json + sidecar meta
        (file leaves inbox/<target>/ — no double-fire on next poll)

tick (every ~2 s in the watcher polling loop):
  ┌──────────── early-defer (5 s + alive-evidence + lease) ───┐
  │ → archive + markDelivered + drop entry                    │
  ├──────────── safety-net (60 s + no alive-evidence) ────────┤
  │ → re-inject back into inbox/<target>/, retries++          │
  │ → if retries > 3, move to .failed/.exhausted/             │
  ├──────────── escape-hatch (5+ pushes/30 s, no acks) ───────┤
  │ → channelMarkedDead = true                                │
  │ → future emits stage straight to .pending-ack/, no callback │
  │   (next plugin reload's handover-replay picks them up)    │
  └────────────────────────────────────────────────────────────┘

handover (replayUndeliveredMessages on new lease holder):
  scan .pending-ack/<target>/ for files older than 30 s
  → move back to inbox/<target>/ for a fresh retry
```

### Alive-heuristic

The gate for early-defer (and the inverse gate for safety-net) is
`isHarnessAliveSincePush(pending: PendingEntry): boolean`. Returns TRUE
when ANY of:

1. `toolCallsReceivedCount > pending.toolCallsAtPushTime` — the harness
   has invoked an MCP tool since the push, proving the JSON-RPC pipe is
   still live and being read.
2. `inboxArrivalListenerCount() > 0` — at least one
   `bridge_receive_messages` long-poll subscriber is parked inside the
   plugin, proving the harness is in normal request/response cadence.
3. `savedChannelCallbackRegisteredAt > pushedAt` — a plugin reload
   happened after the push; the new owner's handover-replay will pump
   the message through cleanly.

Notably absent: notification.push_failed events, stderr breadcrumbs, or
file-watcher poll counts. Those are all internal to the plugin and tell
us nothing about whether the harness rendered the message.

### What's preserved

- `.delivered` ledger format unchanged.
- `.archive/<target>/` and `.failed/<target>/` layouts unchanged.
- `notification.push_failed` event (3.5.5) and the
  `decision: 'leave_pending_for_next_owner'` contract retained for the
  callback-rejected path. The pending-ack flow is layered on top of that
  pre-existing failure path, not a replacement.
- `BridgeMessage` JSON wire format unchanged. A 3.9 receiver consumes
  3.4.x → 3.8.x sender output identically.

### What's new on disk

- `~/.agent-bridge/inbox/.pending-ack/<target>/<id>.json` — staged file
- `~/.agent-bridge/inbox/.pending-ack/<target>/<id>.meta.json` — sidecar
  with `{id, fileName, pushedAt, retries, target, listenersAtPushTime,
  toolCallsAtPushTime, mcpServerVersion}`
- `~/.agent-bridge/inbox/.failed/.exhausted/<ts>_<id>.json` — files that
  exceeded the 3-reinject cap

### Code map

- `mcp-server/src/watcher.ts:200+` — `pendingDeliveries: Map<id, PendingEntry>`
  + `processPendingDeliveries` tick + `maybeMarkChannelDead` escape-hatch.
- `mcp-server/src/watcher.ts:660+` — refactored `emitChannelNotification`
  with the staging path on resolve and the existing `notification.push_failed`
  path on reject.
- `mcp-server/src/watcher.ts:1316+` — `replayUndeliveredMessages` now
  scans `.pending-ack/<target>/` first, recovering files older than 30 s.
- `mcp-server/src/index.ts` — `server.registerTool` shim wraps every tool
  handler so EVERY tool invocation (not just `claude_code_channel_status`)
  increments `toolCallsReceivedCount` for the alive-heuristic.
- `mcp-server/src/config.ts` — `PENDING_ACK_DIR`, `EXHAUSTED_DIR`,
  `pendingAckSubdir(target)`. Added to `ensureDirectories`.
- `mcp-server/test/consume-race.test.mjs` — 6 new regression tests
  (cases A–F per the implementation spec).

### Test coverage

54 tests / 54 passing (48 pre-3.9 carried forward unchanged, except the
end-to-end `unified plugin` test which now asserts pending-ack staging
+ `channel.pending_staged` event instead of immediate archive).

---

## 3.9.1 — Retry-counter persistence across re-inject (2026-04-28)

### The bug

3.9.0 had the retry-cap *intent* right (3 re-injects → `.failed/.exhausted/`)
but the *bookkeeping* wrong. `reinjectPending` deleted the entry from
`pendingDeliveries` after moving the file back into `inbox/<target>/` so
the watcher's next poll would see it as "new" and re-stage. But the
re-stage path (`emitChannelNotification` → `stagePendingAck(fileName,
msg.id, retries=0)`) hardcoded `0` for the retries argument. So every
fresh stage had retries=0, every safety-net tick computed `newRetries =
0 + 1 = 1`, and the cap of 3 was never reached.

Real-world fingerprint: Mac Mini observed the same channel push 5+
times. Logs verbatim showed `"retry 1/3"` on every cycle, indefinitely.
The file ping-ponged forever between `inbox/` and `.pending-ack/`.

### The fix

Introduced `retriesByMsgId: Map<string, number>` in `watcher.ts`. The
map persists ACROSS the `pendingDeliveries.delete()` →
`stagePendingAck()` boundary. `stagePendingAck` consults the map first
and uses the persisted count instead of the param when present.
`finalizePending` and the `.exhausted/` branch of `reinjectPending`
GC their entries.

Process restart resets the map, but that's fine — the safety-net replay
window resets too, and `replayUndeliveredMessages` (handover replay)
bounds the worst-case duplication via the 30 s `pushedAt` floor.

### Test coverage

`consume-race.test.mjs` — case G: drives `_processPendingDeliveriesForTesting`
through 4 reinjects and asserts the file lands in `.failed/.exhausted/`
once retries=3 is exceeded. Pre-fix this test ping-ponged forever; post-fix
it terminates on attempt 4 as expected.

### Code map

- `mcp-server/src/watcher.ts:200+` — `retriesByMsgId` declaration.
- `mcp-server/src/watcher.ts` — `stagePendingAck` consults the map first.
- `mcp-server/src/watcher.ts` — `reinjectPending` writes the new count
  into the map *before* deleting the in-memory entry.
- `mcp-server/test/consume-race.test.mjs` — case G regression.

Commit: `ecdf69b`.

---

## 3.9.2 — Lease-binding + `AGENT_BRIDGE_ROLE` env-pin (2026-04-29)

### The bug — env leak from sibling MCP children

Claude Code's plugin host can spawn multiple MCP children for distinct
plugins under the same parent Claude session, and child processes inherit
their environment from the spawning context. In an OpenClaw + Claude Code
shared-machine setup (Mac Mini), the OpenClaw gateway sets
`AGENT_BRIDGE_ROLE=tools-only` for *its* agent-bridge MCP child (correctly,
because OpenClaw owns the channel-push lease via `openclaw-channel/`). When
the *Claude Code* agent-bridge child spawned next, it inherited
`AGENT_BRIDGE_ROLE=tools-only` from the sibling's environment.

`mcp-server/src/index.ts:711` short-circuits the watcher entirely when role
is `tools-only`. Result:

- `~/.agent-bridge/locks/claude-code.watcher-lock.json` was never written.
- Inbound messages staged in `inbox/claude-code/<id>.json` and never
  channel-pushed into the running Claude session.
- `bridge_send_message` from Claude *worked* (tools-only sends fine).
- Inbound `<channel source="agent-bridge" ...>` blocks never appeared.

This is a tools-only-everywhere zombie state — outbound works, inbound dies
silently. Diagnostic signature: lock file absent, `bridge_inbox_stats` shows
non-zero pending count, `claude_code_channel_status` reports
`role: "tools-only"`.

### The fix

`mcp-server/.mcp.json` now explicitly pins
`"AGENT_BRIDGE_ROLE": "channel-owner"` in the env block. Plugin-loaded
spawns under Claude Code therefore always start as channel-owner regardless
of inherited environment. The earlier "auto-demote when not channel-capable"
fallback (CHANGELOG ref: `1008`) still applies as a safety net for
non-Claude-Code MCP hosts that happen to spawn this same `.mcp.json`.

For OpenClaw-side MCP children, the `tools-only` role is set explicitly via
`openclaw mcp set agent-bridge ...` with an `env: { AGENT_BRIDGE_ROLE:
"tools-only" }` block — i.e. tools-only is opt-in per host configuration,
not opt-in per environment leak.

Commit: `fdb3125` (`fix(mcp): pin AGENT_BRIDGE_ROLE=channel-owner in
.mcp.json`).

Diagnostic marker for future grep: `[OC-FIX-CODEX-LEASE 2026-04-29]`.

### Wire-compat

No on-disk schema changes. No tests added (the bug only reproduces under a
specific Claude+OpenClaw co-tenancy and is mitigated by explicit env in
config rather than by code logic).

### What this does NOT cover

The pin solves *config-leak* into Claude-Code spawns. It does **not** solve
the related class of problems where two distinct Claude Code sessions on
the same machine race to claim the channel-owner lease (sibling-spawn race
— see "MCP plugin lifecycle failure modes" below). For that, Patch F's
heartbeat-recency guard (3.5.2/3.7.0) plus 3.7.1's standby-retry remain
the load-bearing defenses.

---

## 3.9.3 — Deferred: relax alive-heuristic to count cross-channel evidence

### Status: open issue, not yet implemented

The 3.9.0 alive-heuristic in `isHarnessAliveSincePush` returns TRUE on
three signals:

1. `toolCallsReceivedCount > pending.toolCallsAtPushTime` — MCP tool call
   landed since push.
2. `inboxArrivalListenerCount() > 0` — an active long-poll listener.
3. `savedChannelCallbackRegisteredAt > pushedAt` — plugin reload mid-flight.

All three are *internal to the agent-bridge MCP server*. None of them fire
when the running Claude harness is alive but is busy doing work that
doesn't touch agent-bridge tools — e.g. responding to a Telegram message,
running a build, executing a different MCP plugin's tools.

In that scenario the harness *did* receive the channel push (because
`notifications/claude/channel` was successfully written to its stdin and
the harness rendered it into context), but agent-bridge's heuristic has
no way to tell. The 60 s safety-net then re-injects, the harness sees the
same `<channel ...>` block twice, and Ethan reads the same answer twice.

### Option (b) — the deferred fix

Treat **subsequent channel-push events for later messages** as alive-
evidence too. If the watcher successfully push-completed message Y at
`tY > pendingX.pushedAt`, that is positive proof the JSON-RPC pipe to the
harness is alive (the harness's stdin is the only consumer of those
notifications). So: if any newer push has resolved successfully since
`pendingX.pushedAt`, mark X alive without needing tool-call evidence.

This is option (b) from the original design discussion (the others were
(a) make the watcher emit a synthetic ping the harness could ack, and (c)
require explicit ack tools the harness must call back through). Option (b)
needs no harness cooperation — it's pure server-side bookkeeping.

### Why deferred

3.9.2 stopped the bleeding for the most common case (the env-leak that
killed channel-owner entirely on Mac Mini). The remaining duplicate-push
case is a UX papercut, not a correctness failure: messages still get
delivered, they just get delivered twice. Implementing option (b) needs:

- A `lastSuccessfulPushAt: number | null` field on the watcher.
- An update path from `emitChannelNotification`'s resolve branch.
- `isHarnessAliveSincePush` checks `lastSuccessfulPushAt > pending.pushedAt`.
- Tests that drive two pushes back-to-back and assert the first finalizes
  on the second's resolve, not on its own 60 s safety-net.

Tracked in the project's TODO. No commits yet.

---

## MCP plugin lifecycle failure modes (cross-version)

These are not bugs in any one version but recurring failure-shapes that
have shown up in 3.5 → 3.9. Document them here so the next "channel is
dead, why?" investigation doesn't have to rediscover them.

### 1. `/reload-plugins` does NOT always respawn the MCP child

`/reload-plugins` re-reads the marketplace manifest and re-registers the
plugin's tools, but Claude Code's plugin host sometimes keeps the
existing MCP child process alive and just rebinds the tool definitions
to it. The in-memory module state (loaded JS, lock-holder pid, watcher
intervals, pending-ack map) survives the reload.

Symptom: edited `mcp-server/build/index.js`, ran `/reload-plugins`, and
the new code is not running. `claude_code_channel_status` still reports
the old pid + uptime.

When this matters:

- Migrating between version dirs in `~/.claude/plugins/cache/` after a
  `claude plugin update` (the cache dir name changes but the running
  child is still loaded from the previous dir).
- Investigating a wedged channel-owner — `/reload-plugins` cannot
  exorcise a hung child; only SIGKILL + a full session can.

Recovery (no clean automation; ask Ethan):

1. `claude_code_channel_status` to identify the child pid + version
   it's running.
2. SIGKILL the child explicitly (`kill -9 <pid>`).
3. `/reload-plugins` — now Claude has no MCP child for agent-bridge and
   must spawn a fresh one from the cache dir's `build/index.js`.
4. If the watcher-lock points at the killed pid, the new spawn detects
   ESRCH and reaps it. If something stale is still holding the lock,
   delete `~/.agent-bridge/locks/claude-code.watcher-lock.json` manually.

### 2. Stale-binding zombie: lock-pid alive, owning session dead

`~/.agent-bridge/locks/claude-code.watcher-lock.json` records the pid
that owns the channel-owner lease. When the lease-holder is the MCP
child of a Claude Code session that has since exited (cmd-Q, terminal
crash, OS reboot interrupted teardown), that pid can sometimes remain
alive as an orphaned `node`/`bun` process — its parent died without
sending SIGTERM, and Node's default behavior is to keep running.

The pathology:

- Live Claude session at pid Y has agent-bridge MCP child at pid B.
- Old (dead) Claude session's MCP child at pid A is still alive,
  orphaned, and holds the watcher-lock.
- Pid B starts up, sees pid A is alive (`process.kill(A, 0)` returns 0),
  treats the lease as held, and falls back to tools-only or standby.
- Inbound messages stage in `inbox/.pending-ack/claude-code/` forever.
- Outbound `bridge_send_message` works (pid B handles tools fine).

Diagnostic signature:

```
ps -p <lock-holder-pid> -o pid,ppid,etime,command
# A very old etime, ppid=1 (re-parented to launchd/init), command path
# under ~/.claude/plugins/cache/.../<old-version>/mcp-server/build/index.js
```

Recovery: SIGKILL the orphan, delete the lock file, `/reload-plugins`
in the live session.

### 3. Sibling-spawn race (multiple Claude Code instances)

Launching two Claude Code instances on the same machine creates two MCP
children competing for the same `claude-code.watcher-lock.json`. Patch F
(3.5.2 / 3.7.0) handles this with the heartbeat-recency guard: a child
that loses the race exits cleanly with `process.exit(0)` and a
`patch_f.backoff` log line. 3.7.1's standby-retry adds a re-acquisition
attempt for cases where the original holder dies shortly after.

The 3.9.2 `AGENT_BRIDGE_ROLE=channel-owner` env-pin reduces but does
NOT eliminate this. Both children boot as channel-owner; the lock is
the tiebreaker. The pin solves the *adjacent* problem — sibling
*plugins* (e.g. OpenClaw + Claude Code) leaking `tools-only` into each
other's child env.

Multiple-Claude on one machine is a supported configuration (Ethan
runs Mac Mini with Claude inside the MBP-paired session AND a spawned
local sub-session), but only ONE can win the channel-owner lease at a
time. The losers are tools-only and cannot push inbound. This is by
design.

---

## Auth / pairing failure modes (cross-version)

### 1. macOS sftp does not support `-E logfile`

3.8.1 added the SFTP-only send path with `-E <clientLog>` so client-side
sftp diagnostics could be captured to a per-call log file. Modern Linux
and Windows OpenSSH-portable 8.6+ accept `-E` on `sftp(1)`. macOS ships
an older Apple OpenSSH fork whose `sftp` command does NOT accept `-E`,
and every Mac→anywhere `bridge_send_message` failed with:

```
sftp: illegal option -- E
```

3.8.2 (`b08160c`) dropped `-E` and the paired `-o LogLevel=INFO`. The
spawn stdout/stderr capture already surfaces sftp errors, so no
practical diagnostic is lost. Use `-v` for verbose ad-hoc debugging
(universally supported).

The `ssh` codepath (`sshExec` / `buildSSHArgs`) was untouched — `ssh -E`
is fine on every platform. Only `sftp -E` is the gotcha.

Lesson: any flag added to platform-specific helpers needs a "does macOS
ship the same OpenSSH version" check before merge. macOS lags Linux/Win
by 2–3 OpenSSH minor versions and is the most likely platform-feature
mismatch.

### 2. SCP file-drops MUST land in `inbox/<target>/`, not the inbox root

When the MCP `bridge_send_message` tool is unavailable (other side's
plugin not loaded, Claude harness not running, mid-migration), the
fallback is to SCP a `BridgeMessage` JSON directly to the remote's
`~/.agent-bridge/inbox/<target>/<id>.json`. **The target subdir is
mandatory.** Files placed at the inbox root (`~/.agent-bridge/inbox/<id>.json`)
are auto-routed to `inbox/.failed/_unrouted/<id>.json` on the watcher's
next startup pass and never delivered.

The watcher's `_unrouted` quarantine was added when targets became
required (3.4.0). Pre-3.4.0 senders that wrote flat-file messages to
inbox root would have their messages silently lost — `_unrouted/` is
both safety net and breadcrumb trail.

For Claude Code targets, the subdir is literally `claude-code/`. For
OpenClaw, it's `openclaw/<account-name>/`. The local target dir on the
sender side does not need to exist in advance — the receiver's watcher
creates it on first use.

Correct file drop:

```
scp -i ~/.agent-bridge/keys/agent-bridge_<remote> \
    /tmp/msg.json \
    user@host:.agent-bridge/inbox/claude-code/<id>.json
```

Wrong (will be quarantined):

```
scp ... user@host:.agent-bridge/inbox/<id>.json
```

This is also documented in `~/.claude/projects/.../memory/feedback_codex_for_agent_bridge.md`
and `reference_bridge_scp_target_subdir.md`.

### 3. Tailscale auto-mint via OpenClaw default's CDP browser

Tailscale's CLI cannot mint auth keys — that operation lives behind the
admin API (PAT or OAuth client). For zero-touch provisioning across a
fleet you need to drive the browser at `login.tailscale.com` once to
generate a Personal Access Token, then use the API to mint reusable
auth keys.

Documented here as "this pattern works end-to-end" rather than as a
required path — agent-bridge does not depend on it. Two mechanisms had
to be discovered to make the OpenClaw default's CDP browser actually
work for this flow:

1. **Google account chooser button needs `Input.dispatchMouseEvent`,
   not `el.click()`.** Google's `data-jsaction` attribute installs a
   capturing-phase listener on `mousedown` that the synthetic click
   from `element.click()` does NOT fire. CDP's
   `Input.dispatchMouseEvent` issues a real OS-level mouse event that
   propagates through the jsaction handler. This is generic Google-OAuth
   advice — applies to every "click the right account in this list"
   moment.
2. **WS handshake to internal CDP needs `Origin` header suppression.**
   The default CDP endpoint expects no `Origin` header (or, on some
   builds, a specific allowlist). Python `websocket-client` defaults to
   sending the requesting host as `Origin`, which Chromium rejects with
   a 403. Pass `suppress_origin=True` on the `WebSocketApp` constructor
   (or the lower-level `create_connection`).

Reference snippet (used in the 2026-04-28 setup):

```python
import websocket
ws = websocket.create_connection(cdp_ws_url, suppress_origin=True)
ws.send(json.dumps({
    "id": 1, "method": "Input.dispatchMouseEvent",
    "params": {"type": "mousePressed", "button": "left", "x": 600, "y": 320, "clickCount": 1}
}))
```

Provided here as a "this is possible" reference. Future tooling that
wants programmatic Tailscale provisioning without a human-in-the-loop
click can lean on this pattern; agent-bridge itself stays human-mediated
for the cold-bootstrap step (one click) since the alternative requires
storing a long-lived PAT.

---

*End of lifecycle history.*
