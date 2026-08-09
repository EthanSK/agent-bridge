# codex-channel — first-class Codex support for Agent Bridge

`codex-channel/` makes Codex tasks first-class Agent Bridge endpoints:

- **Outbound**: any Codex task can send to any paired machine and any target
  (`claude-code/<persona>`, `openclaw/<account>`, `codex/<alias>`, …) via the
  normal `bridge_send_message` MCP tool, or via the dependency-free CLI
  fallback `agent-bridge codex send`.
- **Inbound delivery**: the bound Codex task itself never polls. The
  background codex-channel daemon scans `~/.agent-bridge/inbox/codex/<alias>/`
  (2 s cadence) and wakes the *exact persisted thread* the alias is bound to
  by driving the public Codex App Server API (`thread/resume` → `turn/start`,
  queue-while-active). Precisely stated: this is a daemon-driven inbox scan
  plus explicit turn injection — not a native harness channel push.
- **Replies** route back precisely: every injected message carries a
  `[BRIDGE-CONTEXT]` block naming the exact reply call
  (`bridge_send_message({ machine, target: <fromTarget>, reply_to, from_target: "codex/<alias>" })`).
  Existing Claude Code / OpenClaw receivers need no new transport.

Minimum versions: **Codex 0.145.0+** (enforced at initialize — the channel's
validated floor depends on `initialTurnsPage` resume hydration of running
threads and `clientUserMessageId` echoed as structural
`userMessage.clientId`; no equally safe older path is implemented). The probe
prefers schema-exact paginated `thread/items/list` when a build enables it,
but installed Codex 0.145 can return `-32601 not supported yet`; the
load-bearing fallback uses `thread/read(includeTurns)` only to confirm a
structural hit, and never treats a miss as permission to resend. Agent Bridge
**4.10.0** is required on the
receiving machine. Senders on older agent-bridge versions still work — the
wire format is the canonical `BridgeMessage` envelope, unchanged.

---

## Opting the current Codex task in (the 10-second version)

From **inside the Codex task** (the task's own shell — Codex exports
`CODEX_THREAD_ID` to its shell commands):

```bash
agent-bridge codex bind
```

That:

1. discovers *this exact thread id* and its user-facing task name with the
   read-only App Server `thread/read` method,
2. derives a portable alias (for example, task **Release Review** becomes
   `codex/release-review`; a duplicate name gets a short task-id suffix),
3. reuses that saved alias forever on later runs even if the task is renamed,
   and validates the thread against its persisted rollout under
   `$CODEX_HOME/sessions/`,
4. records the durable binding in `~/.agent-bridge/codex/bindings.json`, and
5. starts (or confirms) the codex-channel daemon.

From then on, any fleet machine can reach the task:

```text
bridge_send_message({ machine: "<this-machine>", target: "codex/release-review", message: "…" })
```

Alternatives:

- `agent-bridge codex bind --alias release-review` — override the automatic
  alias when you want a specific endpoint name.
- `agent-bridge codex bind --alias x --thread-id <uuid>` — bind any persisted
  thread explicitly (thread ids are shown by `codex resume`'s picker and in
  `/status` inside a task).
- Codex aliases are portable ASCII path segments (`A-Z`, `a-z`, digits,
  `_`, `.`, `-`; no punctuation at either end). This deliberately avoids
  APFS/NTFS Unicode case-fold collisions in per-alias queue directories.
- MCP tool `bridge_codex_bind({ thread_id? })` — same automatic-alias flow
  through the agent-bridge MCP server; pass optional `alias` to override it.
  It uses `CODEX_THREAD_ID` from the MCP process env when the Codex host
  exports it there; otherwise pass `thread_id`.

Inspect / manage:

```bash
agent-bridge codex list                  # alias -> thread map
agent-bridge codex status [--json]       # bindings, queues, daemon health
agent-bridge codex doctor                # + environment checks (read-only)
agent-bridge codex rebind x --thread-id <uuid>
agent-bridge codex disable x | enable x  # pause/resume delivery (messages queue)
agent-bridge codex unbind x
agent-bridge codex service run|ensure|stop|status
```

## Outbound identity (`from_target`) for Codex tasks

So replies land back in *your* task, outbound sends must carry
`from_target: "codex/<alias>"`:

- Simplest: pass it explicitly on each `bridge_send_message` (the bind output
  and every inbound `[BRIDGE-CONTEXT]` show the exact value).
- Machine default: set `AGENT_BRIDGE_FROM_TARGET` in the agent-bridge MCP
  entry of `~/.codex/config.toml`:

  ```toml
  [mcp_servers.agent-bridge]
  command = "node"
  args = ["/path/to/agent-bridge/mcp-server/build/index.js"]
  env = { AGENT_BRIDGE_FROM_TARGET = "codex/main" }
  ```

  Precedence: a bound Claude Code persona (never the case inside a Codex
  host) > valid `AGENT_BRIDGE_FROM_TARGET` > legacy `claude-code/default`.
  Machines running several bound Codex tasks should keep passing
  `from_target` per send — the env default is one value per MCP process.
- No MCP available (e.g. the task predates MCP registration — Codex tool
  catalogs are session-scoped): use the CLI, which delivers over the same
  SSH/SFTP transport as every other agent-bridge send:

  ```bash
  agent-bridge codex send --machine Mac-Mini --target claude-code/default \
    --reply-to msg-abc --from-alias release-review --message "done, see notes"
  ```

## How inbound delivery works

```
sender machine                     this machine
──────────────                     ─────────────────────────────────────────
bridge_send_message  ──SSH/SFTP──▶ ~/.agent-bridge/inbox/codex/<alias>/<id>.json
                                        │  codex-channel daemon (single lease)
                                        │  claim = atomic rename into
                                        │  inbox/.pending-ack/codex/<alias>/ + meta
                                        ▼
                                   Codex App Server (spawned `codex app-server`)
                                   thread/resume <bound thread id>  (exact-id verified)
                                   turn/start { input: <channel>+[BRIDGE-CONTEXT]+fenced body,
                                                clientUserMessageId: <BridgeMessage.id>,
                                                approvalPolicy, sandboxPolicy }
```

- **Queue while active**: if the thread has a running turn, messages stay
  claimed and are flushed in strict FIFO (timestamp, id) order when the turn
  completes — a backoff-parked head is waited for, never bypassed (bounded:
  every failure path dead-letters). `turn/steer` is **opt-in per binding**
  (`--steering`), guarded by the expected turn id and a hard timeout, and
  only ever targets a **bridge-owned** turn — never a foreign Desktop/TUI
  turn, whose policies `turn/steer` cannot make safe.
- **Delivered = durably in the thread**: `turn/start` success means Codex has
  persisted the input; the message then receives a non-expiring hashed
  tombstone (`~/.agent-bridge/codex/delivered/<shard>/<hash>.id`) and is
  archived (`inbox/.archive/codex/<alias>/`). Possibly-sent terminal outcomes
  use a separate `_indeterminate/<shard>/<hash>.id` tombstone so the same id
  cannot create a second turn even after dead-lettering or restart. Startup
  validates both retained tombstone trees and fails closed on unreadable or
  corrupt state instead of forgetting an id.
- **Crash/replay safety — AT-MOST-ONCE for ambiguous sends**: every message
  moves through a durable state machine
  (`staged → turn_starting → turn_active → delivered`) with an atomic,
  fsynced meta sidecar; the indeterminate `turn_starting` marker is durably
  written BEFORE any `turn/start` leaves the machine. After a crash,
  `staged` re-queues; `turn_active`/`delivered` finalize; `turn_starting`/
  steer-timeout — and any claimed file with missing/corrupt metadata — are
  **indeterminate** and are *never re-sent*: the daemon probes
  `thread/items/list` when supported (exact generated-schema pagination,
  matching
  `userMessage.clientId` to the bridge message id, iterating to
  `nextCursor: null`; anything short of full exhaustion — caps, cursor
  loops, RPC/schema failures, or the hit-only `thread/read` fallback missing
  — is indeterminate, never "absent"). Found ⇒ finalize. Absent/unresolved
  after bounded probes ⇒ an **explicit indeterminate dead letter for manual
  recovery** — because Codex could still accept the original request later
  and documents no idempotent duplicate suppression, absence is NOT
  permission to send a second turn. Clean pre-acceptance RPC failures (the
  request provably never landed) still retry normally. No message loss —
  every unresolved message is preserved in the dead-letter dir with its
  reason.
- **Retries**: 3 backoff delays (5 s, 30 s, 120 s — each genuinely
  reachable), then dead-letter on the 4th failure to
  `inbox/.failed/.exhausted/` with a `codex.delivery_exhausted` event.
- **Terminal turn outcomes** are recorded: `turn/completed` success logs
  `codex.turn_completed`; a failed/cancelled bridge turn logs
  `codex.turn_failed_terminal` (with the originating message id) and shows
  in `status` as `lastTurnOutcome` — acceptance into the thread is never
  silently conflated with successful completion.
- **Quarantine**: malformed/mis-targeted/oversized (>1 MiB) envelopes, unsafe
  message ids, and tampered reply routing go to `inbox/.failed/codex/<alias>/`.

## Safety model

- **No auto-approval, ever — schema-exact declines.** During a
  bridge-delivered turn: command/file approvals answer `{decision:"decline"}`
  (the exact supported shape), permission requests grant nothing
  (`{permissions:{}, scope:"turn"}`), `item/tool/requestUserInput` answers
  every question with empty answers, and MCP elicitation declines with
  `{action:"decline", content:null, _meta:null}`. Requests without a known
  thread context hit the same fail-closed defaults at the connection level —
  with multiple bound aliases, per-thread dispatch means releasing one
  session never orphans another's requests. Nothing hangs, nothing is ever
  approved implicitly.
- **Explicit safe defaults per turn + restoration**: `approvalPolicy:
  "never"` and sandbox `workspace-write` (`writableRoots` contains the
  canonical binding/effective task cwd, network is off, and both `$TMPDIR`
  and `/tmp` implicit writable roots are excluded) are sent on every
  delivered turn. Codex persists per-turn
  cwd/approval/sandbox as the THREAD's defaults, so the service captures the
  pre-bridge settings at `thread/resume` and restores them via
  `thread/settings/update` after the bridge-owned turn completes (skipped
  with an explicit event if a foreign turn intervened — guarded restoration).
  Before any turn bytes leave the machine, the original settings and exact
  expected bridge overrides are durably journaled. Restart recovery runs even
  if the alias was disabled or removed; it restores only when the current
  values still equal those expected overrides, so a later user change is
  never overwritten by a stale snapshot.
  Supported approval policies: `never` (default) | `on-request` |
  `untrusted` (Codex's `granular` needs per-rule config this surface does
  not expose; the legacy `on-failure` value is not a Codex 0.145 policy —
  inputs are rejected, stored legacy values migrate to `never`).
  Per-binding overrides at bind time; `danger-full-access` requires fresh CLI
  consent with `--allow-danger` on every bind or rebind whose effective policy
  is dangerous (including inheritance from an existing binding). MCP refuses
  both explicit and inherited `danger-full-access`.
- **Prompt boundary labeling, not authority isolation**: the remote body is
  fenced between `BRIDGE-MESSAGE-START/END` markers,
  fence/context/`</channel>` literals inside the body are neutralized, wire
  metadata is control-character stripped, and the context block labels the
  sender and body. Those controls prevent structural/context-block forgery;
  they do **not** make the body inert. A paired sender allowed to address a
  bound alias is injecting a user prompt with the authority to ask the model
  to use tools already exposed to that task. Codex 0.145 has no App Server
  field for a per-turn tool allowlist or tool isolation. `approvalPolicy:
  "never"` and the workspace sandbox prevent new approvals/escalation, but
  they do not remove already-available MCP or other tools. Bind aliases only
  for peers whose prompt/tool authority you accept.
- **Ownership guard — honest scope**: Codex 0.145 thread-store locks are
  **process-local**. A second App Server process CAN resume and write the
  same persisted thread; neither Codex nor this bridge provides a
  cross-process single-writer guarantee, and the bridge cannot prove no
  other App Server exists. What the channel actually provides, by design:
  explicit opt-in binding; recent rollout-activity **deferral** before AND
  after attach (default 120 s window,
  `AGENT_BRIDGE_CODEX_OWNERSHIP_FRESH_MS` — an unexplained rollout advance
  while subscribed releases the session instead of holding a second
  writer); **active-turn hydration on resume** (in-progress or
  unknown-active threads queue, never start); **bridge-owned-only
  steering**; **prompt unsubscribe** once the bridge turn completes and the
  queue drains; and **settings restore** before release. Residual race,
  stated plainly: if you manually drive a bound task in the CLI/Desktop at
  the exact moment the daemon attaches through the quiet window, both
  clients write the thread; avoid using a bound task interactively while
  bridge delivery is in flight. Ambiguous deliveries are **dead-lettered,
  never automatically duplicated**. Codex-side resume errors surface as
  explicit states (`thread_not_found`, `ownership_conflict`,
  `codex_unsupported`); a resume response without a verifiable thread id is
  a failure — the daemon never substitutes a fresh thread. Note that resume
  can replay a thread's pending approval requests — the same fail-closed
  handlers answer them (declines, never grants). Disable the guard per
  binding with `--no-ownership-guard` (not recommended).

## Known limitations (honest list)

- **A live interactive session does not render pushed turns mid-scroll.** If
  the bound task is open in the Codex TUI/Desktop at delivery time, the
  ownership guard defers until it goes quiet; the delivered turn then runs in
  the persisted thread and appears when the task is next resumed. True
  "inject into the open TUI viewport" is not part of the public App Server
  surface for a thread owned by another process.
- **Indeterminate deliveries are dead-lettered, not resent.** The history
  probe prefers `thread/items/list` where implemented and otherwise uses the
  exact-hit-only `thread/read(includeTurns)` fallback (found ⇒ finalize), but
  when the message is absent or the probe cannot be made authoritative, the
  file dead-letters after bounded probes
  (`indeterminate_ambiguous_send_absent_no_resend` /
  `indeterminate_delivery_probe_unavailable`) for manual recovery —
  at-most-once beats a possible double turn. Recover by inspecting
  `inbox/.failed/.exhausted/` and re-sending from the ORIGIN if the turn
  truly never landed.
- **`clientUserMessageId`** correlation is sent on every `turn/start`/
  `turn/steer` and is never dropped — it is the durable identity the dedupe
  probe matches (`userMessage.clientId`), which is part of why the floor is
  0.145.0.
- **One env-level outbound identity per MCP process** (see above).
- The experimental App Server API (`capabilities.experimentalApi`) can change
  between Codex releases; `agent-bridge codex doctor` + the version floor
  catch drift early.

## Operations

- **Daemon**: single instance per machine
  (`~/.agent-bridge/locks/codex-channel.lock.json`; atomic lease writes and
  token-fenced dispatch; the heartbeat runs on its own timer, independent of
  delivery RPCs, so a slow
  20-30 s App Server call can never make a healthy daemon look stale).
  Started by `bind`; re-ensured by the standalone installer after a runtime
  update, by any agent-bridge MCP server boot, and by the periodic updater
  when at least one binding is **enabled** or a
  `codex/pending-settings/*.json` crash-recovery journal exists. A one-off
  `service stop` is therefore temporary while either signal remains: the next
  supervisor run can restart it. For a persistent pause, disable/unbind every
  binding after pending journals have been recovered, or set
  `AGENT_BRIDGE_CODEX_NO_ENSURE=1` in every supervising environment.
- **Process-identity and shutdown safety**: `service stop` and version refresh
  require **live-ownership proof** — the lease heartbeat must advance under
  its own token — then publish a durable control request bound to that exact
  token. The owning daemon performs the shutdown itself; no raw PID signal is
  used, avoiding Unix PID-reuse races and Windows force-termination behavior.
  Safe settings restoration completes before release, or the durable recovery
  journal remains fenced for the next daemon. A live but
  unverified holder blocks takeover instead of risking two daemons. Unexpected
  App Server loss and normal close verify the exact owned process tree (Unix
  process group; Windows `/PID ... /T`) before replacement; an unverified
  teardown leaves a durable poison fence rather than spawning beside a
  possible orphan.
- **Registry**: `~/.agent-bridge/codex/bindings.json` mutations run under an
  interprocess lock (parallel binds never lose records); saves are atomic +
  durable; an existing-but-unreadable registry fails mutations closed and
  corrupt bytes are preserved aside (`bindings.json.corrupt-*`), never
  silently replaced. Rebinding an alias (even to the same thread) with new
  cwd/sandbox/approval settings invalidates the live session so old policies
  can never leak into new deliveries.
- **Stops and upgrades**: an explicit operator `service stop` is abortive: it
  can terminate an in-progress bridge turn after preserving its durable
  settings-recovery journal. Automatic version refresh instead enters drain
  mode, refuses new resume/start/steer dispatch, keeps its lease heartbeat
  advancing, and waits for active turns to finish before settings restore,
  unsubscribe, verified App Server teardown, and lease release. If draining
  cannot finish within the caller's bound, the old daemon remains fenced and
  ensure reports `staleVersion` rather than starting beside it. A newly spawned
  daemon is reported healthy only after its exact lease token publishes and
  advances a heartbeat; concurrent ensure callers reconcile to the one proven
  winner. Re-running `install.sh`
  or `install.ps1` stage-swaps the standalone runtime under the resolved
  `AGENT_BRIDGE_HOME` and ensures from that newly installed snapshot when
  recovery work exists. The periodic updater similarly ensures from its
  freshly updated canonical clone on macOS and Windows.
- **Logs**: unified NDJSON, component `codex-channel`:

  ```bash
  jq -c 'select(.component == "codex-channel")' ~/.agent-bridge/logs/agent-bridge.log
  jq -c 'select(.context.msg_id == "msg-…")'    ~/.agent-bridge/logs/agent-bridge.log
  ```

  Key events: `codex.message_received`, `codex.turn_start`,
  `codex.turn_started`, `codex.delivery_finalized`, `codex.reply_expected`,
  `codex.queue_deferred_active_turn`, `codex.steer_*`,
  `codex.approval_declined`, `codex.ownership_deferred`,
  `codex.delivery_retry|_indeterminate|_exhausted`, `codex.quarantined`,
  `codex.appserver_*`, `codex.service_*`, `codex.lease_*`.
- **Recovery**:
  - Daemon stuck/stale → `agent-bridge codex service stop && agent-bridge codex service ensure`.
  - Dead letters → inspect `inbox/.failed/.exhausted/`, re-send from the
    origin after fixing the cause. For an indeterminate/possibly-sent reason,
    first verify that no turn landed, then send a deliberate NEW message id;
    the original id is permanently suppressed by its indeterminate tombstone.
    A proven-unsent dead letter may be retried after its local cause is fixed.
  - Corrupt bindings registry → preserved as `bindings.json.corrupt-<ts>`;
    re-bind aliases.
  - Uninstall → first set `AGENT_BRIDGE_CODEX_NO_ENSURE=1` in supervising MCP
    and updater environments, then run `agent-bridge codex service stop` and
    `agent-bridge codex unbind <alias>` per alias. Remove the Codex MCP entry
    from `~/.codex/config.toml` and remove
    `<resolved AGENT_BRIDGE_HOME>/runtime/codex-channel/` for a standalone
    install. Delete `<resolved AGENT_BRIDGE_HOME>/codex/` only after every
    pending-settings journal has been recovered or its abandoned settings
    are explicitly accepted; deleting a journal can strand bridge overrides
    on a persisted thread.

## Tests

Zero-dependency `node:test` suites with a scriptable fake App Server
(`test/fake-app-server.mjs`) covering protocol negotiation and unsupported
versions, framing/fragmentation/malformed frames, exact-thread resume,
idle delivery, active-turn queueing, steering timeout/fallback,
approval/user-input handling, claims/ledger/replay/dedupe/quarantine,
TTL while queued, immutable delivered/indeterminate tombstones, lease
exclusivity + token-fenced dispatch, startup heartbeat readiness, version
draining, exact process-tree teardown, durable settings recovery, service
reload/shutdown, ownership guard, status/doctor, CLI flows (subprocess), and
version parity:

```bash
node --test codex-channel/test/*.test.mjs
```
