/**
 * One bound Codex thread's App Server lifecycle.
 *
 * Owns: thread/resume subscription (exact-thread verified — a missing or
 * mismatched returned id is a FAILURE, never a substitute), turn-activity
 * tracking, schema-exact fail-closed interactive-request handling scoped to
 * THIS thread, delivery via turn/start (queue-by-default) or opt-in guarded
 * turn/steer into a BRIDGE-OWNED turn only, the paginated thread/items/list
 * dedupe probe (with a hit-only thread/read compatibility fallback) for
 * indeterminate deliveries, sticky-settings capture/restore
 * (Codex persists per-turn cwd/approvalPolicy/sandboxPolicy as thread
 * defaults; we restore the pre-bridge values), and thread/unsubscribe on
 * release.
 *
 * Multi-session dispatch: each session registers a request handler with the
 * shared client via addRequestHandler and CLAIMS only requests carrying its
 * own thread context; unclaimed requests fall through to the client's
 * global fail-closed defaults, so nothing is ever approved accidentally and
 * releasing one session never orphans another session's requests.
 *
 * Safety invariants:
 *  - NEVER auto-approves. Command/file approvals answer the exact supported
 *    decision shape { decision: "decline" }; permission requests grant
 *    nothing ({ permissions: {}, scope: "turn" }); user-input requests
 *    answer every question with empty answers; MCP elicitation declines
 *    with the exact schema shape. No hangs.
 *  - Explicit safe defaults on every delivered turn (approvalPolicy +
 *    sandboxPolicy from the binding policy).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileDurable } from "./fsutil.js";
import { normalizeBindingCwd } from "./bindings.js";
import { pendingSettingsPath } from "./paths.js";

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LEGACY_APPROVAL_REQUEST_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
]);
const PERMISSIONS_REQUEST_METHOD = "item/permissions/requestApproval";
const USER_INPUT_REQUEST_METHOD = "item/tool/requestUserInput";
const ELICITATION_REQUEST_METHOD = "mcpServer/elicitation/request";

const APPROVAL_DECLINE_REASON =
  "agent-bridge codex-channel declines interactive approvals during bridge-delivered turns. "
  + "Run privileged actions from a directly supervised Codex session, or loosen this binding's "
  + "sandbox/approval policy explicitly via `agent-bridge codex bind --rebind`.";

/** Wire shapes proven against Codex 0.145.0 (see @openclaw/codex reference). */
export function sandboxPolicyForMode(mode, cwd) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  const writableRoots = cwd ? [cwd] : [];
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: false,
    // Codex otherwise adds $TMPDIR and /tmp as implicit writable roots.
    // Bridge turns promise project-scoped writes, so exclude both ambient
    // temp trees rather than exposing unrelated same-user artifacts.
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

/**
 * Schema-exact empty-answer set for item/tool/requestUserInput: every
 * question id present, each with an empty answers array (a safe decline the
 * schema accepts for all question kinds).
 */
export function buildEmptyUserInputAnswers(params) {
  const answers = {};
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  for (const q of questions) {
    const id = typeof q?.id === "string" ? q.id : (typeof q?.questionId === "string" ? q.questionId : null);
    if (id) answers[id] = { answers: [] };
  }
  return { answers };
}

/** Schema-exact decline for mcpServer/elicitation/request. */
export function buildElicitationDecline() {
  return { action: "decline", content: null, _meta: null };
}

/** Exact ReviewDecision denial used by legacy 0.145 approval requests. */
export function buildLegacyApprovalDecline() {
  return { decision: { denied: { rejection: APPROVAL_DECLINE_REASON } } };
}

/**
 * TYPED App Server rejection check (duck-typed on our own client's
 * CodexRpcError to stay import-cycle-free). Only a JSON-RPC error RESPONSE
 * proves the App Server processed and REFUSED the request — i.e. the turn
 * was provably NOT accepted. Raw transport/process/timeout/write errors
 * (EPIPE, ERR_STREAM_DESTROYED, timeouts, connection closed, …) prove
 * nothing: the request may have been accepted before the failure, so they
 * are AMBIGUOUS and must go through history reconciliation, never a clean
 * retry.
 */
export function isRpcRejection(err) {
  return Boolean(err) && typeof err === "object" && err.name === "CodexRpcError";
}

export function isDispatchFenced(err) {
  return Boolean(err) && typeof err === "object" && err.name === "CodexDispatchFencedError";
}

/**
 * Schema-proven "a turn is already running" rejection. GATED on a typed RPC
 * rejection first: a raw transport error whose message happens to contain
 * "busy"/"active" (e.g. wrapped stream errors) must NEVER be converted into
 * the clean busy/queue path — that would legitimize a resend after a
 * possibly-accepted request.
 */
export function errorLooksTurnActive(err) {
  if (!isRpcRejection(err)) return false;
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return /already|active|busy|in.?progress|running turn|turn.*exists/.test(text);
}

/** Heuristic: does this RPC error mean the params were rejected structurally? */
export function errorLooksInvalidParams(err) {
  if (err && typeof err === "object" && err.code === -32602) return true;
  const text = String(err?.message ?? err ?? "").toLowerCase();
  return /invalid params|unknown field|unknown variant|missing field|deserialize/.test(text);
}

/**
 * Read the crash-safe sticky-settings restoration journal for an alias.
 * Existing malformed journals fail closed: starting another bridge turn
 * could otherwise overwrite the only copy of the user's original settings.
 */
export function readSettingsRestoreJournal(alias, env = process.env) {
  const path = pendingSettingsPath(alias, env);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`cannot read pending Codex settings restore journal ${path}: ${String(err?.message ?? err)}`);
  }
  if (parsed?.version !== 1 || parsed.alias !== alias || typeof parsed.threadId !== "string"
    || !parsed.originalSettings || typeof parsed.originalSettings !== "object"
    || !parsed.expectedOverrides || typeof parsed.expectedOverrides !== "object"
    || typeof parsed.token !== "string"
    || !["pending", "resolved"].includes(parsed.state ?? "pending")) {
    throw new Error(`invalid pending Codex settings restore journal ${path}; refusing new delivery`);
  }
  return parsed;
}

export class ThreadSession {
  /**
   * @param {object} params
   * @param {import('./app-server-client.js').CodexAppServerClient} params.client
   * @param {object} params.binding
   * @param {function} params.logEvent
   * @param {function} [params.onTurnCompleted]  (info) => void — fires for OUR turns
   * @param {function} [params.onIdle]           () => void — thread went idle
   */
  constructor({
    client,
    binding,
    logEvent,
    onTurnCompleted = null,
    onIdle = null,
    env = process.env,
    journalUnlink = unlinkSync,
    journalWrite = writeFileDurable,
    dispatchFence = null,
  }) {
    this.client = client;
    this.binding = binding;
    this.logEvent = logEvent;
    this.onTurnCompleted = onTurnCompleted;
    this.onIdle = onIdle;
    this.env = env;
    this.journalUnlink = journalUnlink;
    this.journalWrite = journalWrite;
    this.dispatchFence = dispatchFence;
    this.threadId = binding.threadId;
    this.subscribed = false;
    this.activeTurnId = null;
    this.activeTurnStartedAt = 0;
    this.activeTurnOurs = false;
    this.approvalDeclineCount = 0;
    this.disposers = [];
    /**
     * Pre-bridge thread settings captured from the thread/resume response
     * (Codex persists per-turn cwd/approvalPolicy/sandboxPolicy as the
     * thread's defaults, so bridge turns must restore what they changed).
     */
    this.originalSettings = null;
    /** true once we have started a turn with bridge overrides. */
    this.sentOverrides = false;
    /** true once settings were restored (or restore was decided against). */
    this.settingsRestored = true;
    /** settings/update succeeded; only durable journal resolution remains. */
    this.restoreRpcSucceeded = false;
    /** turn/start was cleanly rejected, so overrides are known NOT applied. */
    this.overridesRejected = false;
    this.overridesRejectedReason = null;
    /**
     * Foreign turn observed AFTER our overrides were sent: restoring would
     * risk clobbering a legitimate concurrent foreign change — skip with an
     * explicit event (ownership exclusion, documented guarded restoration).
     */
    this.foreignTurnSinceOverrides = false;
    /**
     * Recently-completed turn ids (bounded FIFO). Notifications ride the
     * same stream as RPC responses and are processed synchronously, while
     * response continuations are microtasks — so a completion can be seen
     * BEFORE the turn/start continuation runs. Without this memory the
     * continuation would re-mark a finished turn active forever.
     */
    this.recentlyCompletedTurnIds = [];
    /**
     * Pending turn/start lifecycle correlation. Between issuing turn/start
     * and processing its response, turn/started and even turn/completed for
     * OUR new turn can arrive (same-stream ordering). Ownership is unknown
     * until the response names the turn id, so early events are RECORDED
     * here and attributed when the response resolves: an early completion
     * whose id matches the response is emitted exactly once as OUR
     * completion; mismatching early events are foreign. Only one turn/start
     * is ever in flight per session (the delivery pump serializes).
     */
    this.pendingStart = null;
    /**
     * Resume hydration found thread.status active but no recoverable turn
     * id: a SAFE busy state that queues (never starts or steers) until a
     * completion clears it.
     */
    this.unknownActiveTurn = false;
    /** A journal recovered from an earlier process must be restored first. */
    this.recoveredRestoreJournal = false;
    this.restoreJournalToken = null;
    /** Safe cwd actually sent for workspace-write (bound or resume-derived). */
    this.effectiveCwd = binding.cwd ?? null;
    /** Bridge message ids whose turn RPC outcome is still indeterminate. */
    this.ambiguousOutboundIds = new Set();
    /**
     * Turn id correlated by the most recent authoritative history probe.
     * Kept separate from the boolean return value for compatibility with
     * existing callers. A thread/read fallback deliberately leaves this
     * null because its legacy response cannot always correlate the matching
     * item to the currently-active turn safely.
     */
    this.lastHistoryMatchTurnId = null;
  }

  _rememberCompletedTurn(turnId) {
    if (!turnId) return;
    this.recentlyCompletedTurnIds.push(turnId);
    if (this.recentlyCompletedTurnIds.length > 16) this.recentlyCompletedTurnIds.shift();
  }

  _turnAlreadyCompleted(turnId) {
    return Boolean(turnId) && this.recentlyCompletedTurnIds.includes(turnId);
  }

  /** Mark a turn active unless its completion has already been observed. */
  _markTurnActive(turnId, ours) {
    if (!turnId) return;
    if (this._turnAlreadyCompleted(turnId)) {
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
        this.activeTurnStartedAt = 0;
        this.activeTurnOurs = false;
      }
      return;
    }
    this.activeTurnId = turnId;
    if (this.activeTurnStartedAt === 0) this.activeTurnStartedAt = Date.now();
    if (ours) this.activeTurnOurs = true;
  }

  /**
   * Resume + subscribe the EXACT bound thread. A response without a thread id
   * is a FAILURE (we cannot verify the subscription); a mismatched id is
   * unsubscribed and refused — never a substitute thread.
   */
  async resume({ timeoutMs = 20_000 } = {}) {
    if (this.subscribed) return;
    this._installHandlers();
    let response;
    let returned = null;
    let resumeRpcCompleted = false;
    try {
      response = await this.client.request("thread/resume", {
        threadId: this.threadId,
        // Codex 0.145 rejoins RUNNING threads: request a recent full page so
        // an in-progress turn can be hydrated before we declare the thread
        // idle (legacy `thread.turns` is still read as well).
        initialTurnsPage: { limit: 20, sortDirection: "desc", itemsView: "full" },
      }, { timeoutMs, dispatchFence: this.dispatchFence });
      resumeRpcCompleted = true;
      returned = readThreadIdFromResponse(response);
      if (!returned) {
        throw new Error(
          `thread/resume returned no thread id for ${this.threadId}; cannot verify the subscription — refusing to deliver`,
        );
      }
      if (returned !== this.threadId) {
        throw new Error(
          `thread/resume returned thread ${returned} for requested ${this.threadId}; refusing substitute thread`,
        );
      }
      const {
        restoreSettings: currentSettings,
        observedSettings: currentObservedSettings,
      } = readThreadSettingsFromResume(response);
      this.originalSettings = currentSettings;
      if (this.binding.policy.sandbox === "workspace-write" && !this.effectiveCwd) {
        this.effectiveCwd = normalizeBindingCwd(currentSettings?.cwd, { env: this.env });
        if (!this.effectiveCwd) throw new Error("resume returned no cwd");
      }
      const pendingRestore = readSettingsRestoreJournal(this.binding.alias, this.env);
      if (pendingRestore && (pendingRestore.state ?? "pending") === "pending") {
        if (pendingRestore.threadId !== this.threadId) {
          throw new Error(
            `pending settings restore for alias ${this.binding.alias} belongs to thread ${pendingRestore.threadId}; `
            + `restore that thread before resuming ${this.threadId}`,
          );
        }
        this.restoreJournalToken = pendingRestore.token;
        if (settingsContain(currentObservedSettings, pendingRestore.originalSettings)) {
          // App Server already shows the original values (e.g. restoration
          // completed just before a crash). Resolve without another update.
          this._resolveRestoreJournal("already_original");
          this.originalSettings = currentSettings;
        } else if (!settingsContain(currentObservedSettings, pendingRestore.expectedOverrides)
          || !observedPermissionProfileMatchesOverrides(currentObservedSettings, pendingRestore.expectedOverrides)) {
          // Somebody changed a field controlled by the bridge after the crash.
          // Replaying stale originals would clobber that legitimate change.
          this._resolveRestoreJournal("abandoned_settings_changed");
          this.originalSettings = currentSettings;
          this.logEvent("warn", "codex.settings_restore_skipped",
            "Current thread settings no longer match bridge overrides; stale originals will not be replayed", {
              alias: this.binding.alias,
              thread_id: this.threadId,
              reason: "settings_changed_after_crash",
            });
        } else {
          this.originalSettings = pendingRestore.originalSettings;
          this.sentOverrides = true;
          this.settingsRestored = false;
          this.recoveredRestoreJournal = true;
        }
      } else if (pendingRestore?.state === "resolved") {
        // Settings were already restored/abandoned safely; a leftover file
        // only means best-effort unlink failed. Never replay old settings.
        try { this.journalUnlink(pendingSettingsPath(this.binding.alias, this.env)); } catch { /* harmless resolved tombstone */ }
      }
      this._hydrateActiveTurnFromResume(response);
      this.subscribed = true;
      this.logEvent("info", "codex.thread_resumed", `Resumed Codex thread for ${this.binding.alias}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
        captured_settings: this.originalSettings !== null,
        recovered_settings_restore: this.recoveredRestoreJournal,
        resumed_active_turn: this.activeTurnId ?? null,
        resumed_unknown_active: this.unknownActiveTurn,
      });
    } catch (err) {
      await this._cleanupFailedResume(
        returned ? [returned, this.threadId] : [this.threadId],
        timeoutMs,
        { forceRecycle: !resumeRpcCompleted && !isRpcRejection(err) },
      );
      if (this.binding.policy.sandbox === "workspace-write" && !this.effectiveCwd
          && /(?:cwd|path|directory|root|workspace)/i.test(String(err?.message ?? err))) {
        throw new Error(
          `workspace-write requires a safe project cwd for ${this.threadId}; `
          + `the bound task's persisted cwd was refused (${String(err?.message ?? err)}). `
          + "Rebind with --cwd pointing to an existing project subdirectory.",
        );
      }
      throw err;
    }
  }

  /**
   * A failed/ambiguous resume may already have created a subscription. Unwind
   * every plausible thread id before a retry. If cleanup itself is ambiguous,
   * recycle the shared App Server connection so no orphan subscription can
   * survive without a handler.
   */
  async _cleanupFailedResume(threadIds, timeoutMs, { forceRecycle = false } = {}) {
    this._removeHandlers();
    this.subscribed = false;
    const unique = Array.from(new Set(threadIds.filter((id) => typeof id === "string" && id.length > 0)));
    let cleanupFailed = false;
    for (const threadId of unique) {
      try {
        await this.client.request("thread/unsubscribe", { threadId }, {
          timeoutMs: Math.min(Math.max(Number(timeoutMs) || 5000, 100), 5000),
          dispatchFence: this.dispatchFence,
        });
      } catch (err) {
        cleanupFailed = true;
        this.logEvent("warn", "codex.resume_cleanup_failed", `Could not confirm unsubscribe after failed resume: ${String(err?.message ?? err)}`, {
          alias: this.binding.alias,
          requested_thread_id: this.threadId,
          cleanup_thread_id: threadId,
        });
      }
    }
    if ((cleanupFailed || forceRecycle) && !this.client.closed) {
      this.logEvent("warn", "codex.resume_connection_recycled",
        "Recycling App Server connection because failed-resume subscription state is unknown", {
          alias: this.binding.alias,
          requested_thread_id: this.threadId,
          ambiguous_resume: forceRecycle,
        });
      try { await this.client.close(); } catch { /* connection is already unusable */ }
    }
  }

  /**
   * Hydrate in-progress activity from the resume response BEFORE declaring
   * the thread idle. Sources, in order: legacy `thread.turns` and paginated
   * `initialTurnsPage.data`. A hydrated turn is FOREIGN and unowned (we did
   * not start it and cannot prove otherwise) — it queues, never steers.
   * `thread.status.type === "active"` with no recoverable turn id sets the
   * safe unknown-active busy state; a later completion clears it.
   */
  _hydrateActiveTurnFromResume(response) {
    const thread = response?.thread && typeof response.thread === "object" ? response.thread : {};
    const candidates = [];
    if (Array.isArray(thread.turns)) candidates.push(...thread.turns);
    const page = response?.initialTurnsPage;
    if (page && typeof page === "object" && Array.isArray(page.data)) candidates.push(...page.data);
    for (const turn of candidates) {
      if (!turn || typeof turn !== "object") continue;
      if (turn.status !== "inProgress") continue;
      const turnId = typeof turn.id === "string" ? turn.id : null;
      if (!turnId || this._turnAlreadyCompleted(turnId)) continue;
      this._markTurnActive(turnId, false); // foreign + unowned: queue, never steer
      this.logEvent("info", "codex.turn_observed_active", "Resume hydrated an in-progress turn on the bound thread", {
        alias: this.binding.alias,
        thread_id: this.threadId,
        turn_id: turnId,
        source: "resume_hydration",
      });
      return;
    }
    const status = thread.status;
    const statusType = typeof status === "string" ? status : (status && typeof status === "object" ? status.type : null);
    if (statusType === "active") {
      this.unknownActiveTurn = true;
      this.logEvent("warn", "codex.turn_observed_active", "Thread reports active but no turn id was recoverable; queueing until a completion clears it", {
        alias: this.binding.alias,
        thread_id: this.threadId,
        turn_id: null,
        source: "resume_hydration_unknown_active",
      });
    }
  }

  _installHandlers() {
    this.disposers.push(this.client.onNotification((n) => this._onNotification(n)));
    this.disposers.push(this.client.addRequestHandler(async (req) => this._onServerRequest(req)));
  }

  _removeHandlers() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch { /* ignore */ }
    }
  }

  _onNotification(notification) {
    const params = notification?.params && typeof notification.params === "object" ? notification.params : {};
    const threadId = readNotificationThreadId(params);
    // Codex 0.145 lifecycle notifications require threadId. Missing context
    // is malformed and must not mutate every live session on the connection.
    if (threadId !== this.threadId) return;

    if (notification.method === "thread/status/changed") {
      const status = params.status;
      const statusType = typeof status === "string"
        ? status
        : (status && typeof status === "object" ? status.type : null);
      if (statusType === "idle" && this.unknownActiveTurn && this.activeTurnId === null) {
        this.unknownActiveTurn = false;
        if (this.onIdle) {
          try { this.onIdle(); } catch { /* ignore */ }
        }
      } else if (statusType === "active" && this.activeTurnId === null) {
        this.unknownActiveTurn = true;
      }
      return;
    }

    if (notification.method === "turn/started") {
      const turnId = readNotificationTurnId(params);
      if (turnId && this._turnAlreadyCompleted(turnId)) return; // stale echo
      if (turnId && turnId !== this.activeTurnId && !this.activeTurnId) {
        if (this.pendingStart && this.pendingStart.earlyStartedTurnId === null) {
          // Possibly OUR just-issued turn — ownership unknown until the
          // turn/start response names the id. Record and mark busy WITHOUT
          // deciding foreignness yet (attribution happens at response time).
          this.pendingStart.earlyStartedTurnId = turnId;
          this._markTurnActive(turnId, false);
          return;
        }
        // A turn we verifiably did not start — foreign activity.
        this._markTurnActive(turnId, false);
        if (this.sentOverrides) this.foreignTurnSinceOverrides = true;
        this.logEvent("info", "codex.turn_observed_active", "Observed active turn on bound thread", {
          alias: this.binding.alias,
          thread_id: this.threadId,
          turn_id: turnId,
        });
      }
      return;
    }

    if (notification.method === "turn/completed" || notification.method === "turn/failed") {
      const turnId = readNotificationTurnId(params);
      // Remember the completion FIRST so a late turn/start response
      // continuation (or a stale turn/started echo) cannot resurrect it.
      this._rememberCompletedTurn(turnId ?? this.activeTurnId);
      if (!turnId || turnId === this.activeTurnId || this.activeTurnId === null) {
        const finished = {
          turnId: turnId ?? this.activeTurnId,
          ours: this.activeTurnOurs,
          status: readTurnStatus(params, notification.method),
          errorMessage: readTurnErrorMessage(params),
        };
        this.activeTurnId = null;
        this.activeTurnStartedAt = 0;
        this.activeTurnOurs = false;
        this.unknownActiveTurn = false; // any completion clears the safe-busy state
        if (this.pendingStart && !finished.ours
          && (finished.turnId === this.pendingStart.earlyStartedTurnId || this.pendingStart.earlyStartedTurnId === null)) {
          // Completion raced ahead of the turn/start response: STASH it for
          // attribution instead of dropping ownership. Exactly one of the
          // response paths will emit it as ours (id match) or discard it as
          // foreign (mismatch/failure).
          this.pendingStart.earlyCompletion = finished;
        } else if (finished.ours && this.onTurnCompleted) {
          try { this.onTurnCompleted(finished); } catch { /* ignore */ }
        }
        if (this.onIdle) {
          try { this.onIdle(); } catch { /* ignore */ }
        }
      }
    }
  }

  /**
   * Resolve pending-start attribution once the turn/start response named the
   * turn id. Emits a stashed early completion EXACTLY ONCE as OUR completion
   * when the ids match; classifies mismatching early events as foreign.
   */
  _settlePendingStart(turnId) {
    const pending = this.pendingStart;
    this.pendingStart = null;
    if (!turnId) return;
    if (pending?.earlyCompletion) {
      if (pending.earlyCompletion.turnId === turnId) {
        const finished = { ...pending.earlyCompletion, ours: true };
        if (this.onTurnCompleted) {
          try { this.onTurnCompleted(finished); } catch { /* ignore */ }
        }
        return; // turn already over — never re-mark active
      }
      // The early events belonged to a DIFFERENT (foreign) turn.
      this.foreignTurnSinceOverrides = true;
    } else if (pending?.earlyStartedTurnId && pending.earlyStartedTurnId !== turnId) {
      this.foreignTurnSinceOverrides = true;
    }
    this._markTurnActive(turnId, true);
  }

  /** Pending-start bookkeeping when the turn/start RPC failed/timed out. */
  _abandonPendingStart({ ambiguous = false } = {}) {
    const pending = this.pendingStart;
    this.pendingStart = null;
    if (pending?.earlyCompletion && !ambiguous) {
      // Ownership was never established — conservatively treat the raced
      // turn as foreign (it may have been the user's).
      if (this.sentOverrides) this.foreignTurnSinceOverrides = true;
    }
  }

  /**
   * Server->client request handler. CLAIMS only requests carrying THIS
   * session's thread context; anything else returns null so other sessions
   * (or the client's global fail-closed defaults) answer it.
   */
  async _onServerRequest(request) {
    const method = request?.method ?? "";
    const params = request?.params && typeof request.params === "object" ? request.params : {};
    const requestThreadId = readNotificationThreadId(params);
    if (requestThreadId !== this.threadId) return null; // not ours (incl. missing context)

    if (method === PERMISSIONS_REQUEST_METHOD) {
      this.logEvent("warn", "codex.permissions_denied", "Granted no permissions for bridge-delivered turn", {
        alias: this.binding.alias,
        thread_id: this.threadId,
      });
      return { permissions: {}, scope: "turn" };
    }
    if (LEGACY_APPROVAL_REQUEST_METHODS.has(method)) {
      this.approvalDeclineCount += 1;
      this.logEvent("warn", "codex.approval_declined", `Declined legacy ${method} during bridge-delivered turn`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
        method,
        declines_total: this.approvalDeclineCount,
        local_reason: APPROVAL_DECLINE_REASON,
      });
      return buildLegacyApprovalDecline();
    }
    if (APPROVAL_REQUEST_METHODS.has(method) || /requestApproval$/i.test(method)) {
      this.approvalDeclineCount += 1;
      this.logEvent("warn", "codex.approval_declined", `Declined ${method} during bridge-delivered turn`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
        method,
        declines_total: this.approvalDeclineCount,
        local_reason: APPROVAL_DECLINE_REASON,
      });
      // Exact supported decision shape — no extra fields.
      return { decision: "decline" };
    }
    if (method === USER_INPUT_REQUEST_METHOD || /userinput|user_input/i.test(method)) {
      this.logEvent("warn", "codex.user_input_declined", `Declined ${method} during bridge-delivered turn`, {
        alias: this.binding.alias,
        method,
        questions: Array.isArray(params.questions) ? params.questions.length : 0,
      });
      return buildEmptyUserInputAnswers(params);
    }
    if (method === ELICITATION_REQUEST_METHOD) {
      this.logEvent("warn", "codex.elicitation_declined", "Declined MCP elicitation during bridge-delivered turn", {
        alias: this.binding.alias,
      });
      return buildElicitationDecline();
    }
    if (method === "item/tool/call") {
      return {
        contentItems: [{ type: "inputText", text: "agent-bridge codex-channel does not expose dynamic tools." }],
        success: false,
      };
    }
    // Unknown server request for OUR thread: fall through to the client's
    // global fail-closed handling.
    return null;
  }

  get turnActive() {
    return this.activeTurnId !== null || this.unknownActiveTurn === true;
  }

  markAmbiguousDeliveryPending(messageId) {
    if (messageId) this.ambiguousOutboundIds.add(messageId);
  }

  async confirmAmbiguousDelivery(messageId, matchedTurnId = null) {
    if (messageId) this.ambiguousOutboundIds.delete(messageId);
    // A historical hit proves delivery, but it does NOT prove that some
    // other turn which became active meanwhile is ours. Only reclassify the
    // live turn when the exact paginated entry correlated the bridge id to
    // that same turn id.
    if (matchedTurnId && matchedTurnId === this.activeTurnId) {
      this.activeTurnOurs = true;
      return;
    }
    if (this.activeTurnId === null) {
      await this._refreshActivityAfterHistoryHit(matchedTurnId);
    }
  }

  /** Refresh authoritative turn state after a history-only acceptance hit. */
  async _refreshActivityAfterHistoryHit(matchedTurnId, {
    timeoutMs = 15_000,
    maxPages = 50,
    maxTurns = 5000,
    pageLimit = 100,
  } = {}) {
    let cursor = null;
    let pages = 0;
    let turnsSeen = 0;
    let matchedFound = matchedTurnId === null;
    const seenCursors = new Set();
    try {
      for (;;) {
        const response = await this.client.request("thread/turns/list", {
          threadId: this.threadId,
          ...(cursor !== null ? { cursor } : {}),
          limit: pageLimit,
          sortDirection: "desc",
          itemsView: "summary",
        }, { timeoutMs });
        if (!Array.isArray(response?.data)) throw new Error("thread/turns/list returned no data array");
        for (const turn of response.data) {
          turnsSeen += 1;
          if (turnsSeen > maxTurns) throw new Error("thread/turns/list turn cap reached");
          const turnId = typeof turn?.id === "string" ? turn.id : null;
          if (turnId && turnId === matchedTurnId) matchedFound = true;
          if (turnId && turn?.status === "inProgress") {
            this.unknownActiveTurn = false;
            this._markTurnActive(turnId, turnId === matchedTurnId);
            return;
          }
        }
        const next = response.nextCursor ?? null;
        if (next === null) break;
        if (seenCursors.has(next) || pages >= maxPages - 1) {
          throw new Error("thread/turns/list pagination was not exhaustively resolved");
        }
        seenCursors.add(next);
        cursor = next;
        pages += 1;
      }
      if (!matchedFound) throw new Error("matched history turn was absent from authoritative turn list");
      this.unknownActiveTurn = false;
    } catch (err) {
      this.unknownActiveTurn = true;
      this.logEvent("warn", "codex.turn_activity_refresh_inconclusive",
        "History proved delivery but current turn activity could not be resolved; retaining a safe busy state", {
          alias: this.binding.alias,
          thread_id: this.threadId,
          matched_turn_id: matchedTurnId,
          error: String(err?.message ?? err),
        });
    }
  }

  abandonAmbiguousDelivery(messageId) {
    if (messageId) this.ambiguousOutboundIds.delete(messageId);
  }

  /**
   * Durably preserve the pre-bridge settings before any turn/start can apply
   * sticky overrides. A write failure prevents the RPC from being issued.
   */
  _persistRestoreJournal(expectedOverrides) {
    if (this.sentOverrides && this.restoreJournalToken) return;
    if (!this.originalSettings) {
      throw new Error(
        `thread/resume exposed no restorable settings for ${this.threadId}; refusing a bridge turn that could mutate thread defaults`,
      );
    }
    const missing = [];
    if (Object.hasOwn(expectedOverrides, "cwd")
      && !(typeof this.originalSettings.cwd === "string" && this.originalSettings.cwd)) {
      missing.push("cwd");
    }
    if (Object.hasOwn(expectedOverrides, "approvalPolicy")
      && !Object.hasOwn(this.originalSettings, "approvalPolicy")) {
      missing.push("approvalPolicy");
    }
    if (Object.hasOwn(expectedOverrides, "sandboxPolicy")
      && !Object.hasOwn(this.originalSettings, "sandboxPolicy")
      && !Object.hasOwn(this.originalSettings, "permissions")) {
      missing.push("sandbox/activePermissionProfile");
    }
    if (missing.length > 0) {
      throw new Error(
        `thread/resume omitted restorable original settings (${missing.join(", ")}) for ${this.threadId}; refusing sticky bridge overrides`,
      );
    }
    const path = pendingSettingsPath(this.binding.alias, this.env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    this.journalWrite(path, JSON.stringify({
      version: 1,
      token,
      alias: this.binding.alias,
      threadId: this.threadId,
      originalSettings: this.originalSettings,
      expectedOverrides,
      state: "pending",
      createdAt: new Date().toISOString(),
    }, null, 2));
    this.restoreJournalToken = token;
    this.restoreRpcSucceeded = false;
    this.overridesRejected = false;
    this.overridesRejectedReason = null;
    this.sentOverrides = true;
    this.settingsRestored = false;
  }

  /**
   * Atomically turn the pending journal into a resolved tombstone BEFORE
   * best-effort unlink. If unlink fails, restart sees `state: resolved` and
   * never replays old settings over later user changes.
   */
  _resolveRestoreJournal(resolution) {
    const path = pendingSettingsPath(this.binding.alias, this.env);
    try {
      const current = readSettingsRestoreJournal(this.binding.alias, this.env);
      if (current?.token !== this.restoreJournalToken) return false;
      this.journalWrite(path, JSON.stringify({
        ...current,
        state: "resolved",
        resolution,
        resolvedAt: new Date().toISOString(),
      }, null, 2));
      try { this.journalUnlink(path); } catch { /* resolved tombstone is safe to retain */ }
      this.restoreJournalToken = null;
      return true;
    } catch (err) {
      this.logEvent("warn", "codex.settings_journal_resolve_failed", `Could not resolve settings journal: ${String(err?.message ?? err)}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
        resolution,
      });
      return false;
    }
  }

  /**
   * Deliver text into the bound thread via turn/start with explicit safe
   * policies. `clientUserMessageId` = the BridgeMessage id and is never
   * dropped or retried without that identity. "Already active" errors
   * surface as `{ busy: true }` so the caller re-queues.
   *
   * @returns {{ turnId: string|null }|{ busy: true }}
   */
  async startTurn({ text, clientUserMessageId, timeoutMs = 30_000 }) {
    const turnCwd = this.binding.cwd
      ?? (this.binding.policy.sandbox === "workspace-write" ? this.effectiveCwd : null);
    const params = {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(turnCwd ? { cwd: turnCwd } : {}),
      approvalPolicy: this.binding.policy.approvalPolicy,
      sandboxPolicy: sandboxPolicyForMode(this.binding.policy.sandbox, turnCwd),
      // Durable identity is a reliability invariant on Codex 0.145 (echoed
      // back as userMessage.clientId — the dedupe probe's exact-match key).
      // There is deliberately NO drop-and-retry fallback for this field.
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    };
    // The original thread settings MUST be durable before the RPC. If this
    // throws, no request has left the process.
    const expectedOverrides = {
      ...(turnCwd
        ? { cwd: turnCwd }
        : (this.originalSettings?.cwd ? { cwd: this.originalSettings.cwd } : {})),
      approvalPolicy: params.approvalPolicy,
      sandboxPolicy: params.sandboxPolicy,
    };
    this._persistRestoreJournal(expectedOverrides);
    // Register the pending-start BEFORE the RPC: turn/started and even
    // turn/completed for the new turn can be processed before this
    // continuation resumes; attribution settles at response time.
    this.pendingStart = { earlyStartedTurnId: null, earlyCompletion: null };
    // The journal marks overrides as POSSIBLY APPLIED before response
    // success: an accepted turn whose response is lost still gets restored.
    let response;
    try {
      response = await this.client.request("turn/start", params, { timeoutMs, dispatchFence: this.dispatchFence });
    } catch (err) {
      if (isDispatchFenced(err)) {
        this._abandonPendingStart({ ambiguous: false });
        this.overridesRejected = true;
        this.overridesRejectedReason = "dispatch_fenced_before_send";
        if (this._resolveRestoreJournal("dispatch_fenced_before_send")) {
          this.sentOverrides = false;
          this.settingsRestored = true;
          this.overridesRejected = false;
          this.overridesRejectedReason = null;
        }
        return { fenced: true };
      }
      this._abandonPendingStart({ ambiguous: !isRpcRejection(err) });
      if (!isRpcRejection(err)) this.markAmbiguousDeliveryPending(clientUserMessageId);
      if (isRpcRejection(err)) {
        // A typed JSON-RPC rejection proves the turn (and its sticky
        // overrides) was never applied. Resolve the pre-send journal without
        // issuing settings/update; if resolution itself fails, retain a
        // no-restore state that blocks later delivery until it can be made
        // durable.
        this.overridesRejected = true;
        this.overridesRejectedReason = "turn_start_rejected_no_overrides";
        if (this._resolveRestoreJournal("turn_start_rejected_no_overrides")) {
          this.sentOverrides = false;
          this.settingsRestored = true;
          this.overridesRejected = false;
          this.overridesRejectedReason = null;
        }
      }
      if (errorLooksTurnActive(err)) {
        this.unknownActiveTurn = true;
        this.activeTurnOurs = false;
        return { busy: true };
      }
      throw err;
    }
    const turnId = readTurnIdFromResponse(response);
    if (!turnId) {
      this._abandonPendingStart({ ambiguous: true });
      this.markAmbiguousDeliveryPending(clientUserMessageId);
      throw new Error(
        `turn/start returned no turn id for ${this.threadId}; acceptance is indeterminate and must be reconciled from history`,
      );
    }
    this._settlePendingStart(turnId);
    return { turnId };
  }

  /**
   * Opt-in guarded steer into a BRIDGE-OWNED active turn (the caller must
   * verify activeTurnOurs). Bounded; a timeout is INDETERMINATE.
   */
  async steerTurn({ text, clientUserMessageId, expectedTurnId, timeoutMs = 15_000 }) {
    const params = {
      threadId: this.threadId,
      expectedTurnId,
      input: [{ type: "text", text, text_elements: [] }],
      // Durable identity invariant — never dropped (see startTurn).
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    };
    await this.client.request("turn/steer", params, { timeoutMs, dispatchFence: this.dispatchFence });
    return { steered: true };
  }

  /**
   * Dedupe probe: is `needle` (the bridge message id — sent as
   * `clientUserMessageId`, which Codex 0.145 echoes back as
   * `userMessage.clientId`) already present in the persisted thread?
   *
   * Preferred authoritative path: `thread/items/list` with exact generated
   * 0.145-schema pagination when the runtime enables the method
   * (`threadId`, `cursor`, `limit`, `sortDirection: "desc"`), iterating
   * `response.data` until `nextCursor` is null. Matching is exact structural
   * `userMessage.clientId` equality only; ordinary message content is never
   * treated as identity because a sender can forge it.
   *
   * FAIL-CLOSED semantics:
   *   true  — found (authoritative; safe to finalize).
   *   false — the FULL history was exhausted without a match.
   *   null  — anything less than proof: RPC/schema failure, cursor loop,
   *           page/item cap reached, or the thread/read compatibility
   *           fallback finding nothing (its exhaustiveness is unprovable —
   *           Codex 0.145 rejects includeTurns hydration for paginated
   *           histories, so it can only ever CONFIRM presence).
   *
   * NOTE for callers: even `false` is not permission to blindly resend an
   * AMBIGUOUS send — Codex does not document idempotent duplicate
   * suppression for clientUserMessageId, and a timed-out request could
   * still be accepted later. Delivery applies at-most-once policy on top.
   */
  async threadContains(needle, { timeoutMs = 15_000, maxPages = 50, maxItems = 5000, pageLimit = 100 } = {}) {
    this.lastHistoryMatchTurnId = null;
    let cursor = null;
    const seenCursors = new Set();
    let pages = 0;
    let items = 0;
    for (;;) {
      let response;
      try {
        response = await this.client.request("thread/items/list", {
          threadId: this.threadId,
          ...(cursor !== null ? { cursor } : {}),
          limit: pageLimit,
          sortDirection: "desc",
        }, { timeoutMs });
      } catch (err) {
        if (pages === 0 && err && typeof err === "object" && err.code === -32601) {
          // items/list unsupported on this build: compatibility fallback.
          return this._threadReadFallbackProbe(needle, timeoutMs);
        }
        this.logEvent("warn", "codex.thread_probe_failed", "thread/items/list dedupe probe failed", {
          alias: this.binding.alias,
          pages_seen: pages,
          error: String(err?.message ?? err),
        });
        return null;
      }
      const data = Array.isArray(response?.data) ? response.data : null;
      if (!data) {
        this.logEvent("warn", "codex.thread_probe_failed", "thread/items/list returned no data array (schema mismatch)", {
          alias: this.binding.alias,
          pages_seen: pages,
        });
        return null;
      }
      for (const item of data) {
        items += 1;
        if (items > maxItems) {
          this.logEvent("warn", "codex.thread_probe_capped", "Dedupe probe item cap reached before exhaustion", {
            alias: this.binding.alias, items, pages,
          });
          return null;
        }
        if (itemMatchesBridgeId(item, needle)) {
          this.lastHistoryMatchTurnId = typeof item.turnId === "string" ? item.turnId : null;
          return true;
        }
      }
      const next = response.nextCursor ?? null;
      if (next === null) return false; // exhausted: authoritative absent
      if (seenCursors.has(next)) {
        this.logEvent("warn", "codex.thread_probe_failed", "Dedupe probe detected a pagination cursor loop", {
          alias: this.binding.alias, cursor: String(next).slice(0, 64),
        });
        return null;
      }
      seenCursors.add(next);
      cursor = next;
      pages += 1;
      if (pages >= maxPages) {
        this.logEvent("warn", "codex.thread_probe_capped", "Dedupe probe page cap reached before exhaustion", {
          alias: this.binding.alias, pages,
        });
        return null;
      }
    }
  }

  /**
   * Compatibility fallback when thread/items/list is unsupported: a
   * thread/read(includeTurns) HIT is authoritative (presence proven), but a
   * MISS is only ever `null` — the response's exhaustiveness cannot be
   * proven, and Codex 0.145 rejects includeTurns for paginated histories.
   */
  async _threadReadFallbackProbe(needle, timeoutMs) {
    try {
      const response = await this.client.request("thread/read", {
        threadId: this.threadId,
        includeTurns: true,
      }, { timeoutMs });
      const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
      for (const turn of turns) {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        if (items.some((item) => itemMatchesBridgeId(item, needle))) {
          // Presence is proven, but the legacy response is intentionally not
          // used to claim ownership of whichever turn may currently be live.
          this.lastHistoryMatchTurnId = null;
          return true;
        }
      }
      this.logEvent("warn", "codex.thread_probe_fallback_inconclusive",
        "thread/read fallback found no match; exhaustiveness unprovable — treating as indeterminate", {
          alias: this.binding.alias,
        });
      return null;
    } catch (err) {
      this.logEvent("warn", "codex.thread_probe_failed", "thread/read fallback probe unavailable", {
        alias: this.binding.alias,
        error: String(err?.message ?? err),
      });
      return null;
    }
  }

  /**
   * Restore the pre-bridge thread settings (Codex persists our per-turn
   * cwd/approvalPolicy/sandboxPolicy as thread defaults). Guarded:
   *  - no-op when we never sent overrides or captured nothing;
   *  - SKIPPED (with event) when a foreign turn ran after our overrides —
   *    restoring then could clobber a legitimate concurrent change; exact
   *    compare-and-set is not available, so ownership exclusion is the
   *    documented guard.
   * Best-effort: failures are surfaced as events, never thrown.
   */
  async restoreThreadSettings({ timeoutMs = 10_000 } = {}) {
    if (!this.sentOverrides || this.settingsRestored) return { restored: false, reason: "nothing_to_restore" };
    if (this.overridesRejected) {
      const resolution = this.overridesRejectedReason ?? "turn_start_rejected_no_overrides";
      if (!this._resolveRestoreJournal(resolution)) {
        return { restored: false, reason: "rejected_journal_resolve_failed" };
      }
      this.sentOverrides = false;
      this.settingsRestored = true;
      this.overridesRejected = false;
      this.overridesRejectedReason = null;
      return { restored: false, reason: resolution };
    }
    if (!this.originalSettings) {
      this.settingsRestored = true;
      this.logEvent("warn", "codex.settings_restore_skipped",
        "No pre-bridge settings captured at resume; cannot restore thread defaults", {
          alias: this.binding.alias, thread_id: this.threadId, reason: "no_captured_settings",
        });
      return { restored: false, reason: "no_captured_settings" };
    }
    if (this.turnActive) {
      this.logEvent("info", "codex.settings_restore_deferred",
        "Bridge/unknown turn is still active; retaining the restore journal until the thread is idle", {
          alias: this.binding.alias, thread_id: this.threadId, reason: "turn_active",
        });
      return { restored: false, reason: "turn_active" };
    }
    if (this.restoreRpcSucceeded) {
      if (!this._resolveRestoreJournal("restored")) {
        return { restored: false, reason: "journal_resolve_failed" };
      }
      this.settingsRestored = true;
      this.logEvent("info", "codex.settings_restored", `Finalized restored settings journal for ${this.binding.alias}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
        update_already_succeeded: true,
      });
      return { restored: true, updateAlreadySucceeded: true };
    }
    if (this.foreignTurnSinceOverrides) {
      if (!this._resolveRestoreJournal("abandoned_foreign_activity")) {
        return { restored: false, reason: "journal_resolve_failed" };
      }
      this.settingsRestored = true;
      this.logEvent("warn", "codex.settings_restore_skipped",
        "Foreign turn ran after bridge overrides; skipping restore to avoid clobbering a concurrent change", {
          alias: this.binding.alias, thread_id: this.threadId, reason: "foreign_turn_since_overrides",
        });
      return { restored: false, reason: "foreign_turn_since_overrides" };
    }
    const params = { threadId: this.threadId, ...this.originalSettings };
    try {
      await this.client.request("thread/settings/update", params, { timeoutMs, dispatchFence: this.dispatchFence });
      // From this point onward, retries must NEVER replay the old snapshot:
      // the user can legitimately change settings while journal persistence
      // is unavailable. Retry only the resolved tombstone publication.
      this.restoreRpcSucceeded = true;
      if (!this._resolveRestoreJournal("restored")) {
        // Stay attached and retry only durable journal resolution; otherwise
        // a crash could replay the old pending journal.
        return { restored: false, reason: "journal_resolve_failed" };
      }
      this.settingsRestored = true;
      this.logEvent("info", "codex.settings_restored", `Restored pre-bridge thread settings for ${this.binding.alias}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
      });
      return { restored: true };
    } catch (err) {
      if (isDispatchFenced(err)) {
        return { restored: false, reason: "dispatch_fenced" };
      }
      if (!isRpcRejection(err)) {
        // Timeout/transport loss is indeterminate: the App Server may already
        // have applied the old snapshot. Replaying it from this same stale
        // observation could overwrite a user's later settings change. Tear
        // down the connection and leave the durable journal pending; the next
        // session must resume, compare current==original/expected/foreign,
        // and only then decide whether another update is safe.
        this.logEvent("warn", "codex.settings_restore_ambiguous",
          "thread/settings/update outcome is unknown; recycling App Server and deferring to resume-time reconciliation", {
            alias: this.binding.alias,
            thread_id: this.threadId,
            error: String(err?.message ?? err),
          });
        this.subscribed = false;
        this._removeHandlers();
        try { await this.client.close(); } catch { /* connection is already unusable */ }
        return { restored: false, reason: "update_ambiguous", connectionRecycled: true };
      }
      // A typed RPC rejection proves the update was not applied, so retaining
      // this observed session for a bounded retry is safe.
      this.logEvent("warn", "codex.settings_restore_failed", `thread/settings/update failed: ${String(err?.message ?? err)}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
      });
      return { restored: false, reason: "update_rejected" };
    }
  }

  /**
   * Restore settings (guarded) then unsubscribe + detach. On a transient
   * restore failure the normal service path stays subscribed and retries;
   * shutdown/recovery callers may detach while preserving the durable
   * journal by passing detachOnRestoreFailure.
   */
  async release({ timeoutMs = 5000, detachOnRestoreFailure = false } = {}) {
    if (this.subscribed && this.sentOverrides && !this.settingsRestored) {
      const restore = await this.restoreThreadSettings().catch(() => ({ restored: false, reason: "update_failed" }));
      if (restore.reason === "update_ambiguous") {
        return { released: true, connectionRecycled: true, restorePending: true };
      }
      if (!this.settingsRestored && !detachOnRestoreFailure) {
        return { released: false, reason: restore.reason ?? "restore_pending" };
      }
    }
    if (!this.subscribed) {
      this._removeHandlers();
      return { released: true, alreadyReleased: true };
    }
    try {
      await this.client.request("thread/unsubscribe", { threadId: this.threadId }, {
        timeoutMs,
        dispatchFence: this.dispatchFence,
      });
      this.subscribed = false;
      this._removeHandlers();
      this.logEvent("info", "codex.thread_unsubscribed", `Unsubscribed thread for ${this.binding.alias}`, {
        alias: this.binding.alias,
        thread_id: this.threadId,
      });
    } catch (err) {
      if (isDispatchFenced(err)) {
        return { released: false, reason: "dispatch_fenced" };
      }
      if (isRpcRejection(err)) {
        // A clean rejection means the connection is still usable but the
        // subscription was not confirmed removed. Keep handlers installed
        // and retry instead of creating an unhandled orphan subscription.
        this.logEvent("warn", "codex.thread_unsubscribe_failed", "thread/unsubscribe was rejected; retaining the live session for retry", {
          alias: this.binding.alias,
          error: String(err?.message ?? err),
        });
        return { released: false, reason: "unsubscribe_rejected" };
      }
      // Timeout/transport loss is ambiguous: a delayed unsubscribe can race
      // a later same-thread resume. Recycle the whole connection, which is
      // the only deterministic way to tear down all of its subscriptions.
      this.logEvent("warn", "codex.thread_unsubscribe_ambiguous", "thread/unsubscribe outcome unknown; recycling App Server connection", {
        alias: this.binding.alias,
        error: String(err?.message ?? err),
      });
      try { await this.client.close(); } catch { /* connection is already unusable */ }
      this.subscribed = false;
      this._removeHandlers();
      return {
        released: true,
        connectionRecycled: true,
        restorePending: this.sentOverrides && !this.settingsRestored,
      };
    }
    return { released: true, restorePending: this.sentOverrides && !this.settingsRestored };
  }
}

// ── Response/notification shape readers (tolerant across minor versions) ─────

function readThreadIdFromResponse(response) {
  if (!response || typeof response !== "object") return null;
  if (typeof response.threadId === "string") return response.threadId;
  const thread = response.thread;
  if (thread && typeof thread === "object" && typeof thread.id === "string") return thread.id;
  return null;
}

/**
 * Capture the ORIGINAL thread settings from a thread/resume response.
 * ThreadResumeResponse exposes cwd, approvalPolicy and sandbox (top-level or
 * on the thread object depending on build). Returns null when nothing usable
 * was present (restore is then skipped with an explicit event).
 */
function readThreadSettingsFromResume(response) {
  if (!response || typeof response !== "object") {
    return { restoreSettings: null, observedSettings: null };
  }
  const thread = response.thread && typeof response.thread === "object" ? response.thread : {};
  const pick = (key) => {
    if (response[key] !== undefined) return response[key];
    if (thread[key] !== undefined) return thread[key];
    return undefined;
  };
  const restoreSettings = {};
  const observedSettings = {};
  const cwd = pick("cwd");
  if (typeof cwd === "string" && cwd) {
    restoreSettings.cwd = cwd;
    observedSettings.cwd = cwd;
  }
  const approvalPolicy = pick("approvalPolicy");
  // AskForApproval can be a plain string ("never", "on-request", …) OR a
  // GRANULAR object with per-rule configuration. Preserve any valid non-null
  // JSON shape EXACTLY so restoration cannot silently downgrade a user's
  // granular policy to nothing.
  if (typeof approvalPolicy === "string" && approvalPolicy) {
    restoreSettings.approvalPolicy = approvalPolicy;
    observedSettings.approvalPolicy = approvalPolicy;
  }
  else if (approvalPolicy !== null && approvalPolicy !== undefined && typeof approvalPolicy === "object") {
    restoreSettings.approvalPolicy = approvalPolicy;
    observedSettings.approvalPolicy = approvalPolicy;
  }
  // Codex 0.145 exposes the provenance of named/built-in permission
  // profiles separately from its legacy sandbox approximation. Restoring a
  // profile through `permissions` preserves user-defined policy exactly;
  // `thread/settings/update` forbids combining it with sandboxPolicy.
  const activePermissionProfile = pick("activePermissionProfile");
  if (activePermissionProfile && typeof activePermissionProfile === "object"
    && typeof activePermissionProfile.id === "string" && activePermissionProfile.id) {
    restoreSettings.permissions = activePermissionProfile.id;
    observedSettings.permissions = activePermissionProfile.id;
  }
  // The resume schema always exposes the effective legacy sandbox alongside
  // activePermissionProfile. Keep it in the OBSERVED snapshot even when the
  // restore RPC must use `permissions` instead: crash recovery compares our
  // expected sandbox override against observed reality, while restore never
  // sends the mutually-exclusive permissions+sandboxPolicy pair.
  const sandboxPolicy = pick("sandboxPolicy") ?? pick("sandbox");
  let normalizedSandbox = null;
  if (sandboxPolicy && typeof sandboxPolicy === "object") normalizedSandbox = sandboxPolicy;
  else if (typeof sandboxPolicy === "string" && sandboxPolicy) {
    normalizedSandbox = sandboxPolicyForMode(sandboxPolicy, restoreSettings.cwd ?? null);
  }
  if (normalizedSandbox) {
    observedSettings.sandboxPolicy = normalizedSandbox;
    if (!restoreSettings.permissions) restoreSettings.sandboxPolicy = normalizedSandbox;
  }
  return {
    restoreSettings: Object.keys(restoreSettings).length > 0 ? restoreSettings : null,
    observedSettings: Object.keys(observedSettings).length > 0 ? observedSettings : null,
  };
}

/** Compare only fields the expected snapshot controls; extra fields are fine. */
function settingsContain(actual, expected) {
  if (!actual || typeof actual !== "object" || !expected || typeof expected !== "object") return false;
  return Object.entries(expected).every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(actual, key) && isDeepStrictEqual(actual[key], value)
  ));
}

/**
 * A legacy sandbox override may be reported with its equivalent implicit
 * built-in permission profile. Accept only that built-in (or no profile), so
 * a user-selected named profile with an accidentally similar sandbox is still
 * treated as foreign settings and is never overwritten by stale recovery.
 */
function observedPermissionProfileMatchesOverrides(actual, expected) {
  if (!actual || typeof actual !== "object" || !actual.permissions) return true;
  const sandbox = expected?.sandboxPolicy;
  const type = sandbox && typeof sandbox === "object" ? sandbox.type : null;
  const expectedProfile = type === "workspaceWrite"
    ? ":workspace"
    : type === "readOnly"
      ? ":read-only"
      : type === "dangerFullAccess"
        ? ":danger-full-access"
        : null;
  return expectedProfile !== null && actual.permissions === expectedProfile;
}

function readTurnIdFromResponse(response) {
  if (!response || typeof response !== "object") return null;
  const turn = response.turn;
  if (turn && typeof turn === "object" && typeof turn.id === "string") return turn.id;
  if (typeof response.turnId === "string") return response.turnId;
  return null;
}

function readNotificationThreadId(params) {
  if (typeof params.threadId === "string") return params.threadId;
  if (typeof params.conversationId === "string") return params.conversationId; // legacy approval params
  const thread = params.thread;
  if (thread && typeof thread === "object" && typeof thread.id === "string") return thread.id;
  const turn = params.turn;
  if (turn && typeof turn === "object" && typeof turn.threadId === "string") return turn.threadId;
  return null;
}

function readNotificationTurnId(params) {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn;
  if (turn && typeof turn === "object" && typeof turn.id === "string") return turn.id;
  return null;
}

function readTurnStatus(params, method) {
  const turn = params.turn;
  if (turn && typeof turn === "object" && typeof turn.status === "string") return turn.status;
  return method === "turn/failed" ? "failed" : "completed";
}

function readTurnErrorMessage(params) {
  const turn = params.turn;
  const error = turn && typeof turn === "object" ? turn.error : params.error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return null;
}

/**
 * Match a thread/items/list entry against a bridge message id. Generated
 * 0.145 shape: `{ type: "userMessage", id, clientId, content }` — `clientId`
 * echoes the `clientUserMessageId` we sent. Match ONLY schema-known clientId
 * fields: arbitrary content is attacker-controlled and must never be able to
 * forge a dedupe hit for a later message id.
 */
function itemMatchesBridgeId(entry, needle) {
  if (!entry || typeof entry !== "object") return false;
  // The generated list shape wraps each ThreadItem with its containing turn id.
  const item = entry.item && typeof entry.item === "object" ? entry.item : entry;
  if (item.clientId === needle) return true;
  const nested = item.userMessage;
  if (nested && typeof nested === "object" && nested.clientId === needle) return true;
  return false;
}

export const __testing = { APPROVAL_DECLINE_REASON, itemMatchesBridgeId };
