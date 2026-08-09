# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-08-08T23:38:00Z
**Trigger:** Real four-participant Agent Bridge chain: Codex -> Claude Code -> OpenClaw clawdiboi2 -> OpenClaw clordlethird -> Codex
**Symptom:** Claude Code 2.1.226 first missed an offline replay because the MCP child emitted it before Claude registered its channel handler. After delaying replay, Claude accepted the notification transport but disconnected it with a Zod error because `params.meta.ts` was a number. Claude's directory marketplace also existed while the installed plugin registry entry had been removed, so a healthy watcher process alone was not evidence of a usable channel.
**Root cause:** Startup replay was coupled to watcher acquisition rather than host notification readiness; the runtime trusted the TypeScript `BridgeMessage.timestamp: string` despite legacy senders persisting epoch numbers; and registry repair treated a directory marketplace as a reason to delete, rather than restore, the current installed-cache registration.
**Fix:** Arm initial offline replay five seconds after MCP connect, normalize numeric channel timestamps to canonical ISO strings at the Claude notification boundary, and preserve/restore the enabled installed-plugin entry while preferring the current versioned cache. The Mini startup hook now runs the canonical rewire after its legacy updater so stale updater code cannot delete the registration again.
**Commit:** feat/codex-channel worktree (uncommitted live four-way QA fixes)
**Guard:** The unified-channel regression captures the exact JSON-RPC notification frame from a numeric sender timestamp and requires string ISO `meta.ts`; startup replay and registry-rewire regressions pin readiness delay and cache preference. Live chain `msg-332a022a-ef11-4fc2-adad-8944ac1d5648` -> `msg-2b00679e-8ad1-40c0-92c5-ab9bdd21632b` -> `msg-179093d6-f272-4ff0-9c88-32c97913dc10` -> `msg-ea55b508-dfe0-4e9a-9764-30359526c542` completed with exact `fromTarget`/`replyTo` metadata; the final reply is durably staged for the active Codex alias. Rule: prove host handler registration and exact notification-schema acceptance, not merely process/lease health.
---

---
**Date:** 2026-08-08T21:19:14Z
**Trigger:** Live 4.10 automatic-alias rollout and a real MacBook-to-Mac-mini agent QA conversation
**Symptom:** The source Codex status showed no pending inbox message after the Mac mini agent replied, while the remote Claude Code channel had a healthy watcher lease but never consumed its QA message.
**Root cause:** A reply for a currently active non-steerable Codex task is durably staged rather than left in the inbox, so polling only `pendingInbox` misses it. Separately, a healthy Claude watcher process does not prove that the resumed Claude session registered a channel listener; the retained message metadata recorded `listeners_at_push: 0`.
**Fix:** Live-installed 4.10, bound this task through the zero-argument automatic-alias flow as `codex/coex-agent-bridge`, and verified a complete Agent Bridge QA round trip through `openclaw/clawdiboi2`. Treat `staged` as a valid received state while the target turn is active, and diagnose Claude delivery from `.pending-ack` metadata plus listener counts rather than watcher liveness alone. Do not overwrite or blindly upgrade a remote checkout that is dirty or diverged; recover its listener and reconcile its checkout explicitly.
**Commit:** feat/codex-channel worktree (uncommitted live-rollout verification)
**Guard:** Outbound QA `msg-1f0f8de8-1b41-441b-a449-96e9cca36a81` was consumed by the Mac mini OpenClaw target, which replied to the exact Codex alias as `msg-9059dc6f-118b-406d-85c5-edc6ed475ad9`; local status reported the reply staged with zero pending inbox messages. The separate Claude QA `msg-f64192bd-3e84-40f4-bdcf-f2c8edcd0140` remains retained with `listeners_at_push: 0`, preventing a false success claim.
---

---
**Date:** 2026-08-08T17:22:12Z
**Trigger:** Zero-argument Codex binding UX plus a settled full-suite verification after interrupted test runs
**Symptom:** Saying “use Agent Bridge” still required a user-invented alias even though Codex already stores a task title. Separately, the real-process singleton test could hang or time out under full-suite load, and a legacy-migration test could sample the audit log in the scheduling gap immediately after observing the migrated file.
**Root cause:** The bind flow knew only the thread ID and never made the official read-only metadata request. The lease test resolved its coordination promises only from child stdout and used the production five-second mutex bound under 32-process test contention. The migration assertion treated a file rename and the following synchronous log append as one atomic externally observed action.
**Fix:** `thread/read(includeTurns:false)` now supplies a title for a portable alias slug, with stable registry reuse, deterministic collision suffixes, cwd/thread-ID fallbacks, and an explicit-alias override; CLI and MCP bindings may omit the alias. The singleton test resolves child-exit fallbacks, always releases its winner before assertions, and requests a bounded 30-second test mutex wait. The migration test waits for the complete file-plus-audit contract.
**Commit:** feat/codex-channel worktree (uncommitted automatic-alias implementation)
**Guard:** The real installed Codex 0.145 metadata smoke resolved this task to `codex/coex-agent-bridge` without resume/subscription or live binding. `auto-alias.test.mjs`, CLI, MCP tool, and packaging regressions pin stable reuse, collision/fallback behavior, and the optional schema. Settled suites: Codex 285 total with zero failures (one Windows-only skip); MCP 201 total with zero failures (two platform-only skips); MCP TypeScript build and vendor parity passed.
---

---
**Date:** 2026-08-08T03:05:00Z
**Trigger:** Authenticated headless E2E against the installed Codex 0.145.0 App Server
**Symptom:** The generated protocol exposes `thread/items/list`, but the installed 0.145 runtime returned JSON-RPC `-32601: thread/items/list is not supported yet` after a real turn completed.
**Root cause:** Generated schema availability was mistaken for enabled runtime implementation. Compatibility must be established from live method behavior as well as types.
**Fix:** Keep paginated `thread/items/list` as the preferred exhaustive path when enabled, but treat method-not-found as expected compatibility behavior and use `thread/read(includeTurns)` only for structural `userMessage.clientId` hit confirmation. A fallback miss remains indeterminate and can never authorize resend. Documentation no longer claims the method is universally active in 0.145.
**Commit:** feat/codex-channel worktree (4.10.0 live-protocol correction)
**Guard:** The deterministic method-not-found fallback test requires hit=true, miss=null, and no content-derived identity; `scripts/real-app-server-e2e.mjs` exercises the installed runtime and verifies the fallback plus exact resume/start/completion/settings restore/unsubscribe/archive lifecycle.
---

---
**Date:** 2026-08-08T02:45:00Z
**Trigger:** Final daemon-readiness, version-refresh, and lock-publication release pass
**Symptom:** A detached child could be reported healthy before it acquired the singleton lease, concurrent ensure callers could falsely report the losing child as a startup failure even though a peer won, an automatic version refresh could abort an accepted active turn, and a fixed lock file was briefly visible before its owner identity was completely durable. Under full-suite load, 24 legitimate fsyncing registry mutations could also exhaust the old five-second acquisition bound.
**Root cause:** Treating process spawn as service readiness, treating every control request as an immediate stop, publishing identity after exclusivity, and sizing a durable serialized-write bound for an idle host rather than a loaded one.
**Fix:** Startup success now requires one exact same-token lease heartbeat advance and reconciles a concurrently proven peer winner. Version refresh drains active turns while continuing the lease heartbeat and fencing new resume/start/steer dispatch; explicit operator stop remains intentionally abortive. Registry/lease mutex identity is fully written and fsynced to a unique file before an atomic hard link publishes exclusivity, and the registry acquisition bound is 15 seconds while live owners remain unstealable.
**Commit:** feat/codex-channel worktree (4.10.0 final supervision hardening)
**Guard:** `service.test.mjs` pins exact-child and peer-winner heartbeat readiness, active-turn version drain, token-fenced dispatch, and singleton contention; `fsutil.test.mjs` pins complete identity publication; `registry-concurrency.test.mjs` exercises 24 real processes under the full-suite load; `stale-lock-recovery.test.mjs` exercises both stale-recovery paths with 24 synchronized processes plus a crashed-election fail-closed case. Final Codex suite: 277 total, 276 passed on macOS, one Windows-only junction skip, zero failures.
---

---
**Date:** 2026-08-08T02:40:00Z
**Trigger:** Final workspace-capability, danger-consent, and App Server process-ownership review
**Symptom:** Codex workspace-write could still grant implicit `$TMPDIR` and `/tmp` writes beyond the bound project, a policy-only rebind could inherit prior CLI danger without fresh consent, and terminating only a shell/wrapper PID could leave its App Server descendant subscribed while a replacement attached.
**Root cause:** Relying on writable roots without opting out of Codex's special temp roots, validating only explicitly supplied policy fields, and equating wrapper exit with owned process-tree exit.
**Fix:** Bridge workspace-write sends both temp-root exclusions, validates/canonicalizes the effective cwd, and restores sticky settings through the durable journal. Every effective-danger CLI bind/rebind requires `--allow-danger`, MCP rejects explicit or inherited danger, and App Server clients own/verify a Unix process group or exact Windows task tree; uncertain teardown persists a poison fence and blocks replacement.
**Commit:** feat/codex-channel worktree (4.10.0 final safety hardening)
**Guard:** Session wire-shape/cwd tests, CLI+MCP inherited-danger regressions, Unix wrapper-descendant/pre-exited-wrapper tests, Windows exact-tree/failure tests, and service poison/replacement tests pin the complete boundary. Real Windows process-tree E2E remains a fleet verification requirement.
---

---
**Date:** 2026-08-07T22:38:38Z
**Trigger:** Final delivery-durability review exercised queued TTL expiry and same-id replay after an indeterminate terminal outcome
**Symptom:** A valid message could expire while waiting behind a busy turn or clean-retry backoff and still be sent, while moving an ambiguous delivery to `.exhausted/` removed its only active durable state and allowed a later same-id envelope under another filename or restart to create a second turn.
**Root cause:** TTL was checked only during inbox scan, and terminal indeterminate delivery retained neither a non-delivered id tombstone nor body-id-based replay suppression after removing the staged payload and sidecar.
**Fix:** Proven-unsent `staged` entries now re-check TTL immediately before any send and terminally move expired work without an RPC; `turn_starting` and `steering` remain probe-only regardless of TTL. Possibly-sent terminal entries publish a separate immutable hashed tombstone before dead-letter removal, and inbox/reconcile suppression keys on the validated envelope id rather than its filename. Clean pre-acceptance failures remain retryable and never acquire this tombstone.
**Commit:** feat/codex-channel worktree (delivery TTL and indeterminate replay durability)
**Guard:** `delivery.test.mjs` covers busy-then-expired, restart-recovered staged expiry, clean-retry expiry, expired indeterminate probing, failed terminal moves, inbox duplicates, restart/renamed staged duplicates, and clean retry semantics; focused delivery tests pass 56/56 and the full Codex suite passes all 247 runnable tests (248 total, with one Windows-only junction test skipped on macOS).
---

---
**Date:** 2026-08-07T22:35:00Z
**Trigger:** Cross-platform workspace-root review followed symlinks and Windows junctions through `realpath`
**Symptom:** A safe-looking binding cwd could canonicalize to a broad Windows directory after the Windows-only pre-check, while macOS canonicalized `/tmp` and `/etc` to `/private/tmp` and `/private/etc` but compared them only with the unresolved literals.
**Root cause:** Broad-root policy was applied to user spelling instead of both user and canonical identities, and native deny candidates were never canonicalized themselves.
**Fix:** The exact Windows broad-root predicate now evaluates both raw and canonical cwd paths (including extended-length drive paths), while native broad-root candidates retain literal forms and add every available `realpath` form before comparison.
**Commit:** feat/codex-channel worktree (workspace-root canonicalization hardening)
**Guard:** A host-independent Windows path table pins case, separators, configured roots, extended paths, and project subdirectories; POSIX tests cover direct and symlinked `/tmp`/`/etc`; a Windows-only junction test exercises canonical-target rejection where junction creation is available.
---

---
**Date:** 2026-08-07T22:20:00Z
**Trigger:** Final pairing and custom-state-root trust review
**Symptom:** Documentation described key-based pairing without stating that its `authorized_keys` entry permits a full SSH shell, while relative `AGENT_BRIDGE_HOME` values could resolve to different state/lease directories in processes with different working directories.
**Root cause:** The bridge transport's message-level safety was conflated with the underlying unrestricted SSH credential, and independently implemented path normalizers accepted cwd-relative, drive-relative, or incomplete UNC roots.
**Fix:** Pairing docs now state the full local-account SSH authority and the protect/revoke/rotate boundary, including that message-only trust needs a manually restricted account or forced command. Every CLI, installer, updater, MCP, and Codex runtime resolver rejects non-absolute state roots and incomplete UNC paths.
**Commit:** feat/codex-channel worktree (4.10.0 final integration trust hardening)
**Guard:** Matching runtime/MCP/Unix/CLI/PowerShell matrices cover accepted absolute and rejected relative forms; keep the unrestricted-key warning beside both the pairing mechanism and Security recommendations.
---

---
**Date:** 2026-08-07T22:09:07Z
**Trigger:** Final lifecycle and durable-queue review found orphan-subscription and false-dead-letter-success windows
**Symptom:** A timed-out or malformed `thread/resume` could leave a live subscription with no handlers; an ambiguous `thread/unsubscribe` could race a later same-thread resume; and a failed rename into `.exhausted/` was logged as success while its sidecar/queue entry was discarded.
**Root cause:** Treating request timeout as equivalent to server rejection, treating unsubscribe as best-effort despite shared connection state, and making the terminal queue transition only an in-memory/logging decision instead of a durable state.
**Fix:** Failed resumes best-effort unsubscribe every plausible thread id and always recycle the App Server after an ambiguous resume; clean unsubscribe rejection keeps the subscribed session+handlers for retry, while ambiguous unsubscribe recycles the connection. Dead letters first persist `dead_lettering`; failed moves retain payload, sidecar, and queue state, and restart retries only the local move with zero additional turn RPCs.
**Commit:** feat/codex-channel worktree (4.10.0 final lifecycle hardening)
**Guard:** `session.test.mjs` covers missing/mismatched/dropped/delayed resume cleanup plus rejected/ambiguous unsubscribe; `delivery.test.mjs` forces an exhausted move failure, restarts, and requires exactly zero new start/steer calls during recovery.
---

---
**Date:** 2026-08-07T22:09:30Z
**Trigger:** Transport-failure review ended App Server stdout without a child exit event
**Symptom:** The logical client closed and the service opened a replacement, but the old App Server process remained alive with its thread subscriptions; repeated stream/framing failures could accumulate invisible concurrent owners.
**Root cause:** Fatal stream/framing paths called only `_closeWith`, which rejected requests and handlers but never ended/killed/reaped the underlying child. Explicit `close()` owned the only teardown implementation.
**Fix:** Every unexpected transport/protocol-fatal close now preserves its original error and immediately enters the same idempotent bounded child teardown as explicit close (stdin end, TERM, bounded KILL/reap). The service cannot reuse a deaf client, and its old child is already being terminated before a fresh client handles work.
**Commit:** feat/codex-channel worktree (4.10.0 final transport hardening)
**Guard:** App Server client tests require stdout loss and both oversized-frame forms to kill the fake child; the service stdout-only-loss regression waits for old-child termination before allowing the replacement to deliver.
---

---
**Date:** 2026-08-07T22:10:00Z
**Trigger:** Windows App Server teardown review followed the common npm `codex.cmd` launch path
**Symptom:** Killing only Node's `shell:true` child can terminate `cmd.exe` while leaving its Codex App Server descendant alive with subscriptions.
**Root cause:** On Windows, `ChildProcess.kill()` does not promise process-tree termination for shell wrappers.
**Fix:** App Server teardown ends stdin and, on Windows, invokes `taskkill /PID <exact-owned-child-pid> /T /F`; the PID comes only from the child this client spawned, and no image-name/global kill is used. Unix launches into an owned process group and verifies the group is gone rather than trusting wrapper exit.
**Commit:** feat/codex-channel worktree (4.10.0 Windows lifecycle hardening)
**Guard:** A platform-injected unit test asserts the exact `taskkill` command and `/T` scope. A real Windows `.cmd` process-tree E2E remains required before claiming fleet-verified Windows runtime behavior.
---

---
**Date:** 2026-08-07T22:10:30Z
**Trigger:** Entrypoint review exercised `ensureService` outcomes where version refresh or ownership proof failed
**Symptom:** Standalone/nested CLIs and the MCP bind tool inferred "already running" from a PID and treated caught ensure errors as benign skips, causing installers or bind output to claim a newly installed runtime was active when an old/uncertain daemon still held the lease. MCP startup also ignored a successfully spawned `service.mjs --ensure` child that later exited nonzero.
**Root cause:** User-facing entrypoints branched only on `spawned`/`pid`, ignored the rest of the structured ensure result, and observed spawn errors without observing child exit status.
**Fix:** A shared `describeEnsureResult` classifies every outcome; stale-version and unverified ownership are explicit non-success states and exit/render as warnings, while spawned/already-running/kill-switch-skipped remain truthful successes. MCP bind preserves ensure exceptions with explicit `healthy`/`message`/`error` fields, and MCP startup logs nonzero ensure child exits.
**Commit:** feat/codex-channel worktree (4.10.0 supervision reporting hardening)
**Guard:** Service unit coverage pins all structured outcomes; CLI and MCP bind consume the same helper, MCP rendering tests never infer health from a PID, and an isolated startup artifact forces exit 7 and requires a `codex.ensure_failed` log record.
---

---
**Date:** 2026-08-07T22:05:00Z
**Trigger:** Final integration review challenged the claim that fencing an inbound bridge body "contains" prompt injection
**Symptom:** Safety docs could be read as though paired messages were inert untrusted data and `approvalPolicy=never` plus `workspace-write` isolated all tools for the injected turn.
**Root cause:** Conflating structural prompt-boundary integrity with model/tool authority. Fence neutralization prevents a body from forging the channel/context wrapper, but the body is still delivered as user input; Codex 0.145 exposes no per-turn tool allowlist or tool-isolation field.
**Fix:** Documentation now says plainly that binding an alias grants a paired sender user-prompt authority, including asking the model to use tools already exposed to the task. Approval declines and the workspace sandbox prevent new escalation but do not remove existing MCP/other tools; operators must bind only peers whose prompt/tool authority they accept.
**Commit:** feat/codex-channel worktree (4.10.0 trust-boundary correction)
**Guard:** Keep "prompt boundary labeling, not authority isolation" adjacent to the no-auto-approval claim in the root README, Codex operations docs, harness instructions, MCP server instructions, and changelog; do not describe fencing as prompt-injection containment.
---

---
**Date:** 2026-08-07T21:45:00Z
**Trigger:** Standalone-install and supervision review found split `AGENT_BRIDGE_HOME` roots plus journal-blind restart gates
**Symptom:** A one-line install with a custom bridge home put the Codex runtime under the default profile, so the installed dispatcher could not find it; on Windows, an `install.ps1`-style `C:\...` override was not a usable path inside the Git Bash CLI; re-running an installer replaced runtime files without refreshing an older live daemon; MCP/updater gates ignored pending sticky-settings journals after disable/unbind; docs incorrectly promised that a manual stop would persist.
**Root cause:** Installers, updater bodies, updater provisioners, and the Git Bash dispatcher each reimplemented state-path normalization or supervision policy, and only tested for the bindings file / enabled bindings. Pending settings restoration is actionable daemon work independent of whether a binding still exists.
**Fix:** Normalize either accepted `AGENT_BRIDGE_HOME` form everywhere, including `~`, `~/`, `~\`, both trailing separators, and case-insensitive terminal `.agent-bridge` matching on Windows. Use `cygpath -u` for Windows-native overrides inside Git Bash without changing the env inherited by normal CLI subprocesses; when an installer invokes the newly installed Node runtime, explicitly pass the normalized state dir and then restore the caller's env. Preserve explicit overrides in launchd/Scheduled Task jobs, and use one recovery-work rule: enabled binding OR `codex/pending-settings/*.json`. Installers stage-swap the runtime and invoke the newly installed version-aware ensure; every automatic ensure honors `AGENT_BRIDGE_CODEX_NO_ENSURE=1`. Lifecycle docs now call manual stop temporary while recovery work remains.
**Commit:** feat/codex-channel worktree (4.10.0 integration-hardening pass)
**Guard:** Hermetic real-`install.sh` tests cover parent/state-dir and tilde/backslash overrides, enabled-binding and journal-only ensure, installed-CLI discovery, and NO_ENSURE; `cli-sandboxed-home.sh` stubs cygpath for Windows parent/state forms and case-insensitive state-dir matching; matching MCP/runtime matrices pin tilde expansion, both trailing separators, and Windows casing. MCP and periodic-updater tests also pin the journal gate, preserved supervisor env, tool discovery/help, and PowerShell structure.
---

---
**Date:** 2026-08-07T21:37:34Z
**Trigger:** App Server framing review requested exact split-UTF-8 handling and a bound on newline-terminated frames
**Symptom:** A multibyte Unicode character split across stdout chunks was decoded independently into replacement characters, corrupting otherwise valid JSON; separately, a frame larger than 1 MB bypassed the limit whenever its terminating newline arrived in the same chunk.
**Root cause:** `Buffer.toString("utf8")` is stateless across chunks, and the size guard checked the accumulated string only when it contained no newline.
**Fix:** `CodexAppServerClient` now uses one incremental `StringDecoder`, finishes it on stdout end, and enforces `LINE_BUFFER_MAX` by UTF-8 byte length on every complete newline-delimited frame and on the residual buffer before parsing.
**Commit:** feat/codex-channel worktree (4.10.0 framing-hardening pass)
**Guard:** `app-server-client.test.mjs` splits one four-byte character after bytes 1, 2, and 3 and requires exact round-trip text; a separate valid JSON frame over 1 MB with a newline must close before JSON parsing. Focused suite 18/18 and full codex-channel suite 199/199 passed.
---

---
**Date:** 2026-08-08T01:30:00Z
**Trigger:** Final protocol review of the dedupe probe + ambiguous-send policy against installed Codex 0.145 types
**Symptom:** Three stacked correctness gaps: (1) `thread/read includeTurns:true` (the previous fix) is REJECTED by 0.145 for paginated histories, so the probe could error or silently under-read; (2) a negative history probe after a timed-out RPC was treated as permission to resend — but a timed-out `turn/start` can still be accepted later, and Codex documents no idempotent duplicate suppression for `clientUserMessageId`; (3) resume left `activeTurnId` null even when the thread was mid-turn, so the daemon could `turn/start` against an already-running task.
**Root cause:** Treating point-in-time absence as a permanent fact, and treating resume as a subscription-only operation when 0.145 rejoins RUNNING threads (thread.status active, inProgress turns in `thread.turns` / `initialTurnsPage.data`).
**Fix:** (1) Preferred exhaustive probe = `thread/items/list` with exact generated-schema pagination (cursor/limit/sortDirection desc), matching `userMessage.clientId`, iterating to `nextCursor:null` with loop detection + bounded caps; installed 0.145 can report the method unsupported, so the `thread/read` fallback can only ever CONFIRM presence. (2) AT-MOST-ONCE: after an ambiguous send, absent ⇒ bounded late-acceptance probes then an explicit indeterminate dead letter — never a second turn; only provably pre-acceptance failures retry. (3) Resume requests `initialTurnsPage {limit, sortDirection:"desc", itemsView:"full"}`, hydrates inProgress turns as foreign/unowned busy, and active-without-id enters a queue-only busy state cleared by the next completion. MIN_CODEX_VERSION raised to 0.145.0 (the only validated floor) and the identity-dropping clientUserMessageId retry removed.
**Commit:** feat/codex-channel worktree (4.10.0 protocol-review pass)
**Guard:** session tests: pagination/caps/cursor-loop/fallback fail-closed matrix, resume-hydration (legacy + paginated + unknown-active), identity-never-dropped; delivery tests: at-most-once absent-no-resend dead-letter + clean-failure-retries; service test: recovered accepted message finalizes via items/list with zero new turn/start. Rules recorded: point-in-time absence is not permanence; fakes must mirror what the real protocol REJECTS and OMITS, not just its happy shapes; resume is a state-transfer operation, not just a subscription.
---

---
**Date:** 2026-08-08T01:20:00Z
**Trigger:** One residual codex-suite failure: own-turn completion attribution lost when turn/started+turn/completed arrived before the turn/start response continuation
**Symptom:** `onTurnCompleted` never fired for fast turns (completions.length 0): the recently-completed memory correctly blocked resurrection but the completion had been classified before ownership was knowable.
**Root cause:** Ownership of a turn is only established by the turn/start RESPONSE naming the id, yet started/completed notifications for that very turn can be PROCESSED first (same-stream frames are synchronous; response continuations are microtasks). Any design that classifies completions eagerly must otherwise drop or misattribute this window.
**Fix:** Pending-start lifecycle correlation: register a pending-start record before the RPC; early started/completed events are recorded (not classified); the response settles attribution — matching early completion ⇒ emitted exactly once as OURS; mismatching early events ⇒ foreign (and block blind settings restore); response failure ⇒ conservative foreign classification. No delays, no double callbacks (recently-completed memory still dedupes stale echoes).
**Commit:** feat/codex-channel worktree (4.10.0 protocol-review pass)
**Guard:** session lifecycle-ordering tests: early-completion-attributed-exactly-once, stale-duplicate-no-double-fire, foreign-race-not-attributed; the previously failing onIdle+onTurnCompleted test.
---

---
**Date:** 2026-08-08T01:10:00Z
**Trigger:** Review correction on ownership wording: Codex 0.145 thread-store locks are process-local
**Symptom:** Docs claimed "current Codex enforces single-writer thread history", implying a cross-process guarantee neither Codex nor the bridge provides — a second App Server can resume and write the same persisted thread.
**Root cause:** Repeating an earlier research simplification instead of the verified lock scope.
**Fix:** Swept README/AGENTS/INSTRUCTIONS/codex-channel README to state the EXACT protections (opt-in binding, rollout quiet-window deferral pre+post attach, active-turn hydration + queueing, bridge-owned-only steering, prompt unsubscribe, settings restore) and the honest residual race (no cross-process lock between independent Codex clients; avoid manually driving a bound task during delivery; ambiguous deliveries dead-letter rather than duplicate).
**Commit:** feat/codex-channel worktree (4.10.0 protocol-review pass)
**Guard:** wording is test-adjacent only; the behavioral guards are the ownership/hydration/at-most-once suites. Rule recorded: safety documentation must name the mechanism's actual scope, never upgrade a heuristic into a guarantee.
---

---
**Date:** 2026-08-07T23:40:00Z
**Trigger:** Review reproduced 40 parallel `codex bind` processes ending with only 29-31 registry records
**Symptom:** Every bind reported success, but concurrent load-modify-save on `bindings.json` silently dropped winners of earlier writes; separately, a read error path returned an EMPTY registry object that a later save would happily persist — turning a transient EPERM into total data loss.
**Root cause:** Cross-process mutations without an interprocess lock, plus fail-open reads feeding fail-open writes.
**Fix:** All registry mutations acquire `bindings.lock` (fully write+fsync a unique owner record, atomically hard-link it into the fixed lock path, ownership token, bounded stale recovery that never steals a young/live lock; synchronous bounded retry via Atomics.wait so the sync mutator API survives), re-load INSIDE the lock, and save atomically+durably. Existing-but-unreadable registries now ABORT mutations; corrupt bytes are preserved aside only under the lock — read-only status calls never mutate the file. The default 15-second bound accommodates serialized durable writes during legitimate contention.
**Commit:** feat/codex-channel worktree (4.10.0 hardening)
**Guard:** `registry-concurrency.test.mjs` (24-way real-process parallel binds must all survive; mixed bind/disable/rebind), `bindings.test.mjs` live-lock-not-stolen, stale-lock recovery, and unreadable-fails-closed tests.
---

---
**Date:** 2026-08-07T23:35:00Z
**Trigger:** Review flagged three related daemon-identity hazards: 15s lease staleness vs 20-30s RPC budgets, heartbeats only between awaited ticks, and `stop`/refresh killing whatever PID a lease named
**Symptom:** A healthy daemon mid-RPC could be declared stale (second daemon spawns); worse, a stale lease whose PID the OS reused could get an unrelated process SIGTERMed.
**Root cause:** Coupling the heartbeat to the delivery loop, and treating "lease names PID + PID alive" as sufficient identity evidence.
**Fix:** Heartbeat moved to its own timer (atomic lease writes); every stop/refresh path now demands LIVE-OWNERSHIP PROOF — the lease's `updatedAt` must ADVANCE under the same token within a bounded window. Only the true owner heartbeats that token, so PID reuse can never pass; without proof nothing is signaled or started beside a live uncertain owner. Stop uses token-bound control IPC rather than a raw PID signal. This proof is platform-neutral, and "refuse to kill or replace an uncertain owner" is the designed outcome.
**Commit:** feat/codex-channel worktree (4.10.0 hardening)
**Guard:** `service.test.mjs`: unrelated-disposable-process-not-signaled tests (ensure + stop), heartbeating-old-daemon version-refresh kill test, `verifyLiveDaemon` advancing/frozen unit tests, real-daemon independent-heartbeat test.
---

---
**Date:** 2026-08-07T23:30:00Z
**Trigger:** Review: the Claude marketplace/cache artifact (mcp-server dir alone) failed to START because tools.ts statically imported the ../../codex-channel chain
**Symptom:** One missing optional feature took down every existing bridge tool in isolated plugin installs; the same class of break existed latently for the `../../lib/` relay shims and for codex-channel's `../../openclaw-channel/` imports in any packed artifact.
**Root cause:** Cross-package relative imports assume the full-repo layout; packaged artifacts are single directories.
**Fix:** Two patterns, both parity-fenced: (1) LAZY candidate-resolving loader for optional integrations (codex support resolves at call time from AGENT_BRIDGE_SOURCE_DIR > repo layout > installed `~/.agent-bridge/runtime/`; handlers degrade with actionable errors; tool catalog stays stable), and (2) VENDORED byte-identical snapshots for hard dependencies (codex-channel vendors openclaw envelope/outbound; mcp-server vendors lib/ relay modules via npm `prebuild` sync + `scripts/sync-codex-vendor.mjs`), with drift caught by `vendor-parity` tests. Isolated-artifact tests copy the exact payloads into empty directories and exercise them for real (MCP initialize/tools-list over stdio; CLI verbs without a checkout).
**Commit:** feat/codex-channel worktree (4.10.0 hardening)
**Guard:** `mcp-server/test/packaging-isolated.test.mjs`, `codex-channel/test/packaging.test.mjs`, `codex-channel/test/vendor-parity.test.mjs`; rule recorded: any repo-relative import in a shippable package is a packaging bug unless a parity-fenced vendor copy or lazy loader backs it.
---

---
**Date:** 2026-08-07T23:25:00Z
**Trigger:** Review of TurnStartParams semantics: per-turn cwd/approvalPolicy/sandboxPolicy "affect this turn AND subsequent turns"
**Symptom:** Every bridge-delivered turn silently rewrote the user's task defaults (e.g. their on-request approvals became `never`, their cwd became the binding cwd) — permanently, from the Desktop user's perspective. A same-thread rebind also kept delivering under the OLD session's policies (danger-full-access survived a rebind to read-only).
**Root cause:** Treating turn overrides as turn-scoped when Codex persists them as thread settings, and reusing a live session object across binding changes keyed only on threadId.
**Fix:** Capture original settings from the `thread/resume` response, restore via `thread/settings/update` after the bridge-owned turn completes (guarded: skipped with an event when a foreign turn intervened; crash-before-restore is a documented, logged fail-safe gap). Sessions are invalidated whenever ANY behavior-affecting binding property changes, not just threadId.
**Commit:** feat/codex-channel worktree (4.10.0 hardening)
**Guard:** `session.test.mjs` restore-after-success/failure + foreign-turn-skip tests; `service.test.mjs` danger→read-only same-thread rebind regression and prompt-release-with-restore test.
---

---
**Date:** 2026-08-07T21:30:00Z
**Trigger:** Building the 4.10.0 codex-channel: session tests deterministically showed a bound thread stuck "turn active" forever after its turn had completed
**Symptom:** `ThreadSession.turnActive` stayed true after `turn/completed`, so the delivery queue never flushed and idle-close never fired — even though every notification was delivered and parsed correctly.
**Root cause:** JSON-RPC stream ordering vs promise scheduling. The App Server's `turn/started`/`turn/completed` notifications ride the SAME stdout stream as the `turn/start` response and are handled synchronously by the frame loop, while the `await client.request("turn/start")` continuation is a microtask that runs LATER. So the completion can be fully processed BEFORE the continuation runs; the continuation then re-marks the finished turn as active and nothing ever clears it. This is a protocol-integration property, not a test artifact — the installed `@openclaw/codex` reference solves the same race with per-turn notification buffering.
**Fix:** `session.js` keeps a bounded FIFO of recently-completed turn ids; `_markTurnActive()` is a no-op for a turn whose completion was already observed, and `turn/completed` records the id BEFORE clearing state so late continuations and stale `turn/started` echoes cannot resurrect it.
**Commit:** feat/codex-channel worktree (4.10.0)
**Guard:** `codex-channel/test/session.test.mjs` ("turn completion notification clears activity and fires onIdle") + `service.test.mjs` idle-close test — both run the fake App Server in synchronous-emission mode, which reproduces the race deterministically.
---

---
**Date:** 2026-08-07T21:20:00Z
**Trigger:** codex-channel test runs cancelled mid-suite: "the event loop resolved while its promise remained pending"
**Symptom:** node:test cancelled a pending test (and all siblings after it) instead of failing it; nothing ever timed out.
**Root cause:** Two liveness bugs of the same family. (1) The RPC client's per-request timeout timer was `unref()`d, so an outstanding request held NO live handle — when nothing else was scheduled, Node exited with the promise pending. (2) A fake-server "send request, await response" helper registered its resolver AFTER writing the frame; with a flowing PassThrough the peer's response is delivered SYNCHRONOUSLY inside the write call, so the response arrived before the resolver existed and was dropped, again leaving a handle-less pending promise.
**Fix:** (1) Every RPC request now carries a REF'd, bounded timer (default 30 s, hard cap 10 min) cleared on settle — an outstanding RPC is real work and must keep the loop alive until it deterministically settles; `close()` timers stay ref'd too but are bounded (~2.2 s). (2) The fake registers resolvers BEFORE writing and gives every server-request promise its own ref'd timeout that rejects loudly.
**Commit:** feat/codex-channel worktree (4.10.0)
**Guard:** `app-server-client.test.mjs` request-timeout + server-request tests; rule of thumb recorded here: never `unref` a timer that is the only thing standing between a pending promise and process exit, and always register response handlers before emitting on same-process streams (delivery can be synchronous).
---

---
**Date:** 2026-08-07T21:10:00Z
**Trigger:** Designing crash/replay safety for codex-channel delivery ("no message loss, no double turn")
**Symptom:** A crash between issuing `turn/start` and observing its response is inherently indeterminate: the message may or may not already be in the thread. Naive retry double-delivers; naive drop loses the message.
**Root cause:** `turn/start` is not idempotent and has no server-side dedupe contract we can rely on across restarts.
**Fix:** Initial design, superseded by the 2026-08-08 protocol-review and live-E2E entries above: (a) the composed turn input carries the unique BridgeMessage id as `clientUserMessageId`, (b) delivery state is durable (`staged` → `turn_starting` → `turn_active` meta sidecars; `turn/start` success == durably delivered because Codex persists the input immediately), and (c) ambiguous entries are probed before any disposition. The original `thread/read`-miss ⇒ retry conclusion was wrong: point-in-time absence after an ambiguous RPC never proves that a late acceptance cannot occur. Current policy is structural hit ⇒ finalize; absent/unavailable after bounded probes ⇒ explicit indeterminate dead letter, never an automatic second turn.
**Commit:** feat/codex-channel worktree (4.10.0)
**Guard:** `session.test.mjs` paginated/capped/cursor-loop probe matrix plus `delivery.test.mjs` indeterminate/probe/reconcile suite (probe-found finalize, ambiguous-absent no-resend dead letter, probe-unavailable dead letter, `turn_active` crash finalize, attempts persistence across restart). Never restore the superseded "negative probe means safe retry" behavior.
---

---
**Date:** 2026-08-07T17:58:19Z
**Trigger:** Ethan asked Codex to use the Dell directly and give itself a dedicated Agent Bridge target instead of relying on a resident Dell Claude courier
**Symptom:** Dell replies had been routed to a Claude-owned target, so the active Codex task could not see them and Agent Bridge appeared not to work for this workflow.
**Root cause:** Transport and SSH delivery were healthy; the mismatch was at the receiver boundary. Codex must use its own explicit `codex/<task-alias>` inbox target. The tools-only MCP is session-scoped, so a newly registered MCP may not appear in an already-running Codex task's static tool catalog, and target-specific reads are bounded non-consuming peeks rather than push delivery.
**Fix:** Registered the local Agent Bridge stdio MCP globally for Codex without `AGENT_BRIDGE_PERSONA`, then sent a direct Dell-originated test message to `codex/razer-naga-setup` by invoking Agent Bridge's built inbox/config modules on the Dell. The message was delivered into the matching Mac inbox and verified with `peekInboxForTarget`; no Dell Claude session participated and no Agent Bridge source code changed.
**Commit:** none (configuration and live routing proof only)
**Guard:** Prove all three surfaces when commissioning a Codex target: sender reports delivered, the receiver file names the exact `codex/<task-alias>` target, and a target-specific peek returns that message. Never start a Claude watcher or set `AGENT_BRIDGE_PERSONA` for Codex. Repeat bounded peeks at goal checkpoints; true unsolicited turn injection still requires the separate `codex-channel` companion described below.
---

---
**Date:** 2026-08-07T17:27:16Z
**Trigger:** Ethan asked whether current Codex support now exposes the push events Agent Bridge needs for first-class inbox delivery
**Symptom:** Agent Bridge documents Codex as MCP/tools-only and unverified, but it was unclear whether current Codex can receive an unsolicited bridge message in a live conversation or only poll `bridge_receive_messages`.
**Root cause:** Codex App Server is now a bidirectional JSON-RPC host surface, but its directions must not be conflated. `thread/*`, `turn/*`, and `item/*` notifications are Codex-to-client output; Agent Bridge-to-Codex delivery must be an explicit client request (`turn/start` while idle, or guarded `turn/steer` for an active turn). A normal MCP server or portable Agent Plugin cannot emit a Claude-style channel notification that starts a Codex turn. The installed Codex 0.145.0 schema and an ephemeral handshake proved `thread/started` push delivery, and installed `@openclaw/codex` 2026.7.1 provides a working reference for stdio/WebSocket transport, `thread/resume` subscription ownership, event collection, timeouts, and approval handling.
**Fix:** Investigation only at the time; the separate `codex-channel` companion shape was subsequently implemented. Correction from the later source/protocol review: Codex's thread-store lock is process-local, not a cross-process single-writer guarantee. A second App Server can resume the same persisted task, so the shipped channel reduces the race with explicit binding, rollout quiet-window deferral before/after attach, active-turn hydration, bridge-owned-only steering, prompt unsubscribe, and guarded settings restoration; docs explicitly tell operators not to drive a bound task manually during delivery.
**Commit:** none (investigation only)
**Guard:** The codex-channel suite covers protocol negotiation, exact resume, active-turn queueing/hydration, restart/replay and paginated structural-client-id dedupe, schema-exact approval/input declines, timeout/connection cleanup, reply correlation, and ownership deferral; the real 0.145 App Server E2E covers exact resume/start/completion/history/settings restore/unsubscribe. Treat `turn/steer` as optional and bridge-owned-only, and never describe rollout heuristics as proof of cross-process ownership.
---

---
**Date:** 2026-07-14T20:43:06Z
**Trigger:** Ethan voice via coordinator, 2026-07-14: brain is an ADDITION, not a replacement — agents must not put memories there instead of their original location
**Symptom:** Shipped 4.9.0 shared-context wording could be misread as memory ROUTING (either shared store OR native memory) — Ethan flagged the danger: agents might skip harness-native memory writes because they wrote to the shared store
**Root cause:** The scope-discipline line ('project-local fixes belong in LEARNINGS.md; harness-private notes belong in harness memory') framed destinations as either/or without stating the store is strictly additive. Nothing anywhere said 'never skip the native write'.
**Fix:** 4.9.2 (PR #7): explicit ADDITIVE-ONLY paragraph on every instruction surface — mcp-server/src/index.ts SHARED CONTEXT section (right after the MUST-record line), bridge_learnings_add/search tool text, CLI learnings help, README callout, INSTRUCTIONS.md, AGENTS.md, skills/bridge, skills/openclaw, site card. Scope lines rephrased from routing to copy-on-top ('stays there; the store adds a fleet-wide COPY on top'). Principle also seeded INTO the shared store itself (id 0192270c). Wording-only, no code paths.
**Commit:** a872f20
**Guard:** The rule now lives in the MCP instructions every connected agent reads at session start + the store entry 0192270c that any agent searching 'memory' will hit; future wording edits should preserve the ADDITIVE ONLY paragraph verbatim
---

---
**Date:** 2026-07-14T20:06:33Z
**Trigger:** Coordinator relay of Mini Claude bridge msg-932bde33, 2026-07-14
**Symptom:** learnings replication intermittently failed between Mini and MBP while bridge messaging worked across the same pair (Mini bridge report msg-932bde33, right after the 4.9.0 rollout)
**Root cause:** Peer configs carry TWO addresses (LAN host= + Tailscale internet_host=) and either can be individually dead — stale LAN IP (NO self-heal exists for stale host= values; only manual 'agent-bridge config <m> --internet-host') or a flaky tailnet path. Replication picked ONE address (Tailscale-first, 3.4.2 no-fallback policy) and stranded when that address was down. Diagnostic wrinkle: an .lan alias section without internet_host is LAN-only forever, which is what made replication look 'LAN-only' in the Mini's investigation.
**Fix:** 4.9.1: shared endpoint-fallback helper, mirrored bash/TS — sshExecWithEndpointFallback (mcp-server/src/ssh.ts) + fallback inside _learnings_remote_exec (bash), inherited by add push-on-write / sync / remove --fleet / bridge_learnings_add. Falls back internet→LAN ONLY on ssh connection-layer failure (exit 255; TS also sniffs stderr phrases), never on remote-command failure. Single-endpoint policy deliberately unchanged for status probes. PR #6, merge 4f3c157. E2E: Mini post-upgrade add auto-landed on MBP with no manual sync (garnet-77-meridian probe).
**Commit:** 4f3c157
**Guard:** mcp-server/test/ssh-endpoint-fallback.test.mjs (PATH-stubbed ssh: fallback on dead tailnet, no fallback on remote-cmd failure or healthy preferred, both-dead diagnostics) + test/cli-learnings.sh cases 11-12; meta-learning also recorded IN the shared store itself (id 3aea6717)
---

---
**Date:** 2026-07-14T19:34:44Z
**Trigger:** Ethan voice: global agent bridge shared context feature build 2026-07-14
**Symptom:** Needed a fleet-wide SHARED CONTEXT store: learnings/findings any agent on any paired machine can search + must contribute globally-applicable learnings to (the missing layer above per-repo LEARNINGS.md and per-harness memory)
**Root cause:** N/A new feature (4.9.0). KEY DESIGN: replication rides the sshExec SIDE-EFFECT path (like bridge_notify), NEVER the inbox/watcher path — a replica write must not depend on a live remote channel-owner. Store = append-only NDJSON full replica per machine (~/.agent-bridge/shared-context/learnings.ndjson), deduped by LOWERCASE-uuid id so push-on-write + sync reconciliation + replays are all idempotent. remove is local-only by design (no tombstones); remove --fleet repeats it everywhere.
**Fix:** mcp-server/src/learnings.ts (store ops + buildRemoteIngestCommand) + bridge_learnings_add/search in tools.ts + SHARED CONTEXT section in index.ts server instructions; cmd_learnings verbs (add/search/list/show/ingest/sync/remove) in the bash CLI — mirrored bash/TS pair like the notify renderer. GOTCHAS HIT: (1) bash add was not deduping tags while TS was — caught by parity tests; (2) test/cli-learnings.sh MUST pin AGENT_BRIDGE_HOME because the 4.4.0 sandboxed-HOME fallback silently repoints an empty $TMP sandbox at the REAL user store (it wrote 2 test entries into the live store before the pin); (3) jq-in-assignment under set -e/pipefail needs '|| true' guards (head -1 SIGPIPEs jq); (4) grep for printf-%q-escaped ssh argv with grep -qF 'learnings\ ingest' not plain spaces; (5) Mini→MBP push failed because Mini cannot SSH to MBP (LAN 192.168.1.208 timeout, pre-existing asymmetry) — sync FROM the reachable side is the designed workaround and worked. E2E verified both directions across MBP/Mac-Mini/OldMacBookPro; SHITTYWINDOWS is an SSH-endpoint-only peer with no agent-bridge CLI so learnings replication to it always no-ops gracefully. PR #5, merge commit 17723d9.
**Commit:** 17723d9
**Guard:** mcp-server/test/learnings-store.test.mjs (real-shell hostile-body round-trip vs stubbed remote CLI, dedupe idempotency, corrupt-line resilience) + test/cli-learnings.sh (10 cases incl. push-on-write over stubbed ssh, uppercase-id normalization)
---

---
**Date:** 2026-06-27T22:05:13Z
**Trigger:** alexa-bridge callback refinement (teammate session) 2026-06-27
**Symptom:** Alexa fire-and-forget result callback should not depend on the fragile unofficial Echo speak-back
**Root cause:** Design refinement. Echo speak-back (alexa_remote_control.sh) is unofficial + cookie expires ~2wk. The reliable replacement is agent-bridge v4.8.0's notify verb (native macOS banner, SSHes to target Mac) + a Telegram message. Both are official/reliable paths.
**Fix:** src/server.mjs: NOTIFY_TARGET env (default MacBookPro) baked into buildInjectContent prompt -> agent runs 'agent-bridge notify <target> --title ... --message ... --sound default' AND Telegram, with speak.sh Echo demoted to optional. inject.mjs CLI mirrors it; speak.sh + README reframed (Echo optional, cookie auth not a blocker).
**Commit:** da567a7
**Guard:** Boot log prints notify target; injected prompt verified on Mini to carry notify+telegram-required + speak.sh-optional; agent-bridge notify confirmed present (v4.8.0). NOTE: a parallel teammate session pushed da567a7 on top of my 0f0f81a (which had the real source changes) — da567a7 only touched package-lock; final origin/main state correct. Watch for fast-forward races when two sessions ship the same refinement.
---

---
**Date:** 2026-06-27T21:48:27Z
**Trigger:** alexa fire-and-forget agent loop build 2026-06-27
**Symptom:** Want to speak a freeform task to an Amazon Echo and have an agent do it + report back, but Alexa custom skills must respond within ~8s while agent work takes minutes
**Root cause:** N/A new feature. KEY DESIGN: fire-and-forget split — the Alexa request can ONLY ack (8s deadline), so inject the task via agent-bridge sendLocalMessage (fast atomic file write, does NOT await agent work) and return the ack immediately; the long result comes back on a SEPARATE leg (speak.sh) not bound by 8s. speak-back uses Amazon's UNOFFICIAL API (alexa_remote_control.sh) which is fragile (cookie expires ~2wk, Amazon can break it) so Telegram fallback is the guarantee. AMAZON.SearchQuery slots cannot be the entire utterance — need carrier words in samples.
**Fix:** extensions/alexa-bridge: src/server.mjs (Node-stdlib HTTP receiver, POST /alexa fire-and-forget inject + fast ack, GET /health, optional ?secret= gate); src/inject.mjs (reuses build/inbox.js sendLocalMessage, robust path resolution, never raw-writes inbox); speak.sh (alexa_remote_control.sh -e speak: with auth-lapse detection + Telegram fallback); skill.json (interaction model); launchd KeepAlive agent + install.sh
**Commit:** dcd645c
**Guard:** Verified locally: /health 200, mock IntentRequest returns ack AND writes msg into inbox/claude-code/default via sendLocalMessage (log: delivered locally), speak.sh falls back to Telegram when arc.sh absent. inject failures caught -> graceful ack never an Alexa error. README documents speak-back fragility + Ethan-only Amazon cookie auth.
---

---
**Date:** 2026-06-27T20:00:00Z
**Trigger:** bridge_notify macOS-notify design build 2026-06-27
**Symptom:** Needed a way to pop a native macOS notification on any paired Mac (tell the user an agent finished a task on whichever Mac they're at)
**Root cause:** N/A (new feature). Key DESIGN DECISION worth remembering: a notification is a FIRE-AND-FORGET SIDE EFFECT, not an agent message — do NOT route it through the inbox/watcher path (that needs a live remote channel-owner and is async). The inbox path is the wrong tool for banners.
**Fix:** New `bridge_notify` MCP tool + `agent-bridge notify` CLI verb. Routing: machine=local renders in-process (terminal-notifier, osascript fallback); machine=remote runs `sshExec(m, "agent-bridge notify --local …")` so the REMOTE machine's own CLI renders natively there (decides terminal-notifier-vs-osascript by what IT has installed — fallback is load-bearing, Mini may lack terminal-notifier). Renderer lives in TWO mirrored places that must stay byte-identical: `_render_local_notification` (bash) + `renderLocalNotification` (mcp-server/src/notify.ts). Free-form notification text MUST be shell-quoted before entering the SSH command string — `qq()` = `printf '%q'` in bash, `shellQuoteForSsh()` in TS — this is the one place it breaks if done naively. osascript has no subtitle field so subtitle folds into title as "title — subtitle". Files: mcp-server/src/notify.ts (new), mcp-server/src/tools.ts (bridge_notify), agent-bridge (cmd_notify + _render_local_notification + qq). CLI is testable immediately (no MCP restart); the MCP tool calls the same code paths so passing CLI tests imply a working tool.
**Commit:** <see PR>
**Guard:** mcp-server/test/notify-quoting.test.mjs (shellQuoteForSsh round-trips hostile strings through a real shell; buildRemoteNotifyCommand word-split parity) + test/cli-notify.sh (notify --local renders via stubbed terminal-notifier; --sound none silent; missing flags die; osascript fallback when terminal-notifier absent). Version-pin test in unified-channel.test.mjs now references EXPECTED_VERSION constant so future bumps only touch one line.
---
**Date:** 2026-06-27T19:23:01Z
**Trigger:** Nest-to-Mini build task 2026-06-27
**Symptom:** Want a Google Nest / Gemini-for-Home speaker to control a machine's Claude Code by voice; emulated Hue does not work with Google Home
**Root cause:** Google removed local Hue/SSDP discovery in 2017 (emulated Hue is Alexa-only). Google-native local control in 2026 is Matter. Also: matter.js @matter/main 0.17.x StorageService.location is read-only (set env var storage.path instead), and a Matter 'bridge' is built as deviceType.with(BridgedDeviceBasicInformationServer) added to an AggregatorEndpoint — NOT BridgedNodeEndpoint.with(deviceType) (that throws 'Behavior type has no ID')
**Fix:** extensions/google-home-matter: matter.js virtual Matter bridge (Aggregator + BridgedNode per device, OnOff + optional dimmer). On state change, inject() reuses agent-bridge's own build/inbox.js sendLocalMessage() (same as bridge_send_message machine:local) to atomically write inbox/<target>/<id>.json — never raw-drop into inbox roots (quarantined to _unrouted). Brightness 0-254 -> 0-100% -> configurable presets. Config-driven via devices.json; LaunchAgent keeps it alive; persistent storage dir keeps commissioning across reboots
**Commit:** 79a348d
**Guard:** Pinned commissioning passcode/discriminator = stable pairing code; robust build/inbox.js path resolution (env -> repo-relative -> Mini path -> /Users/ethansk symlink); inject failures logged not fatal; README documents finite-vocabulary ceiling
---
