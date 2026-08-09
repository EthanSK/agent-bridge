/**
 * codex-channel service core: the long-running push companion that watches
 * bound `inbox/codex/<alias>/` targets and delivers into the exact bound
 * Codex threads via the App Server.
 *
 * Singleton per machine via a lease at
 * `~/.agent-bridge/locks/codex-channel.lock.json`:
 *  - lease writes are ATOMIC (temp + rename) and carry pid + random token +
 *    version + process identity (execPath, process start hint);
 *  - the heartbeat runs on its OWN timer, independent of the delivery pump,
 *    so a slow App Server RPC (20-30 s) can never make a healthy daemon look
 *    stale (stale threshold 15 s);
 *  - stop/version refresh first require LIVE-OWNERSHIP PROOF: the lease's
 *    `updatedAt` must ADVANCE under the same token (only the true owner
 *    heartbeats that file). They then publish a durable, token-bound control
 *    request which the daemon acknowledges only after normal shutdown and
 *    lease release. No raw PID signal is used, avoiding both Unix PID-reuse
 *    TOCTOU and Windows force-termination semantics.
 *
 * Ownership & lifecycle per alias:
 *  - foreign rollout writes defer delivery BEFORE attach, and RELEASE the
 *    session when detected AFTER attach (we never hold a second writer
 *    against a live foreign owner);
 *  - steering only ever targets a bridge-owned turn (enforced in delivery);
 *  - a session stays subscribed only while needed: after the bridge-owned
 *    turn completes and no actionable queued work remains, thread settings
 *    are restored and the session releases promptly;
 *  - terminal turn outcomes (completed/failed) are logged and surfaced in
 *    status with message attribution.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CodexAppServerClient, CodexVersionError, compareVersions } from "./app-server-client.js";
import { ThreadSession, readSettingsRestoreJournal } from "./session.js";
import { AliasDelivery, loadRetainedDeliveryState } from "./delivery.js";
import { isValidAlias, listEnabledBindings } from "./bindings.js";
import { findRolloutForThread, rolloutMtimeMs } from "./rollout.js";
import { pidIsAlive, publishExclusiveFile, sleepSync, writeFileDurable } from "./fsutil.js";
import {
  CODEX_HARNESS_PREFIX,
  identityFilePath,
  inboxRoot,
  machineNameFilePath,
  pendingSettingsDir,
  pendingSettingsPath,
  serviceControlPath,
  serviceLeasePath,
  serviceTeardownPoisonPath,
  unroutedDir,
} from "./paths.js";
import { makeEventLogger } from "./log.js";
// Vendor copy for packaging self-containment (parity test-enforced).
import { localMachineName } from "./vendor/openclaw-outbound.js";
import { CHANNEL_VERSION } from "./version.js";

export const POLL_MS = 2000;
const LEASE_STALE_MS = 15_000;
const LEASE_HEARTBEAT_MS = 2_500;
const STARTUP_READY_TIMEOUT_MS = 10_000;
const STARTUP_READY_POLL_MS = 100;
const RESUME_RETRY_MS = 30_000;
const VERSION_RETRY_MS = 10 * 60_000;
const DEFAULT_IDLE_CLOSE_MS = 5 * 60_000;
const DEFAULT_OWNERSHIP_FRESH_MS = 120_000;
const TEARDOWN_POISON_RETRY_MS = 1_000;
/** How long verifyLiveDaemon waits for heartbeat advancement. */
const LIVE_PROOF_WINDOW_MS = 6_000;
const GRACEFUL_STOP_TIMEOUT_MS = 45_000;
const LEASE_MUTEX_RETRY_MS = 10;
const LEASE_MUTEX_TIMEOUT_MS = 5_000;
const LEASE_MUTEX_STALE_MS = 10_000;

// ── Lease ───────────────────────────────────────────────────────────────────

/**
 * A teardown poison is intentionally operator-cleared only. It means an
 * owned App Server process tree could not be proven dead; automatically
 * starting another daemon would recreate the split-brain we failed to rule
 * out. The file survives daemon exit/restart and carries the exact evidence.
 */
export function readTeardownPoison(env = process.env) {
  const path = serviceTeardownPoisonPath(env);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { version: 0, unreadable: true, path };
  } catch {
    return existsSync(path) ? { version: 0, unreadable: true, path } : null;
  }
}

function persistTeardownPoison(client, error, context, env) {
  const path = serviceTeardownPoisonPath(env);
  const existing = readTeardownPoison(env);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const poison = {
    version: 1,
    path,
    pid: Number.isInteger(client?.child?.pid) ? client.child.pid : null,
    context,
    error: String(error?.message ?? error),
    serviceVersion: CHANNEL_VERSION,
    createdAt: new Date().toISOString(),
    recovery: "Verify/reboot the host so the old Codex App Server tree is gone, then remove this poison file explicitly.",
  };
  writeFileDurable(path, JSON.stringify(poison, null, 2));
  return poison;
}

export function readLease(env = process.env) {
  const path = serviceLeasePath(env);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object"
      || !Number.isInteger(parsed.pid) || parsed.pid <= 0
      || typeof parsed.token !== "string" || parsed.token.length === 0
      || !Number.isFinite(Number(parsed.updatedAt))) {
      return { unreadable: true, path, error: "invalid lease shape" };
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { unreadable: true, path, error: String(error?.message ?? error) };
  }
}

export { pidIsAlive };

export function leaseFresh(lease, nowMs = Date.now()) {
  return Boolean(
    lease
    && Number.isInteger(lease.pid)
    && pidIsAlive(lease.pid)
    && nowMs - Number(lease.updatedAt ?? 0) < LEASE_STALE_MS,
  );
}

function writeLeaseAtomic(lease, env) {
  writeFileDurable(serviceLeasePath(env), JSON.stringify(lease, null, 2));
}

function leaseMutexPath(env) {
  return `${serviceLeasePath(env)}.acquire`;
}

function readLeaseMutex(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return { pid: null, token: null, startedAt: 0, unreadable: true, error: "invalid mutex record" };
    }
    return {
      pid: Number(parsed?.pid),
      token: typeof parsed?.token === "string" ? parsed.token : null,
      startedAt: Number(parsed?.startedAt) || 0,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {
      pid: null,
      token: null,
      startedAt: 0,
      unreadable: true,
      error: String(error?.message ?? error),
    };
  }
}

function leaseMutexIsStale(path, lock, nowMs) {
  let ageMs = nowMs - (lock?.startedAt || 0);
  try {
    ageMs = Math.min(ageMs, nowMs - statSync(path).mtimeMs);
  } catch {
    return false;
  }
  if (ageMs < LEASE_MUTEX_STALE_MS) return false;
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (!pidIsAlive(lock.pid)) return true;
  return false; // never steal a critical section from a suspended live owner
}

/** Serialize lease mutations with a complete hard-link-published mutex. */
function acquireLeaseMutex(env, timeoutMs = LEASE_MUTEX_TIMEOUT_MS) {
  const path = leaseMutexPath(env);
  const recoveryPath = `${path}.recovery`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const owner = { pid: process.pid, token, startedAt: Date.now() };
  const recoveryToken = `${process.pid}-${randomUUID()}`;
  const recoveryOwner = { pid: process.pid, token: recoveryToken, startedAt: Date.now() };
  const deadline = Date.now() + timeoutMs;
  const waitOrThrow = (existing, recovering = false) => {
    if (Date.now() >= deadline) {
      throw new Error(
        `codex-channel lease mutation ${recovering ? "stale-lock recovery" : "is locked"} by pid `
        + `${existing?.pid ?? "?"} (${recovering ? recoveryPath : path})`,
      );
    }
    sleepSync(LEASE_MUTEX_RETRY_MS);
  };
  const releaseIfToken = (lockPath, ownedToken) => {
    const current = readLeaseMutex(lockPath);
    if (current?.token === ownedToken) {
      try { unlinkSync(lockPath); } catch { /* fail closed on a later acquisition */ }
    }
  };
  for (;;) {
    const recovery = readLeaseMutex(recoveryPath);
    if (recovery) {
      waitOrThrow(recovery, true);
      continue;
    }
    try {
      publishExclusiveFile(path, JSON.stringify(owner));
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const existing = readLeaseMutex(path);
      if (leaseMutexIsStale(path, existing, Date.now())) {
        let recoveryOwned = false;
        try {
          publishExclusiveFile(recoveryPath, JSON.stringify(recoveryOwner));
          recoveryOwned = true;
        } catch (recoveryError) {
          if (recoveryError?.code !== "EEXIST") throw recoveryError;
          waitOrThrow(readLeaseMutex(recoveryPath), true);
        }
        if (!recoveryOwned) continue;
        try {
          const current = readLeaseMutex(path);
          if (!leaseMutexIsStale(path, current, Date.now())) continue;
          const aside = `${path}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
          renameSync(path, aside);
          try { unlinkSync(aside); } catch { /* forensic leftover is harmless */ }
          for (;;) {
            try {
              publishExclusiveFile(path, JSON.stringify(owner));
              return { path, token };
            } catch (publishError) {
              if (publishError?.code !== "EEXIST") throw publishError;
              waitOrThrow(readLeaseMutex(path));
            }
          }
        } finally {
          releaseIfToken(recoveryPath, recoveryToken);
        }
      }
      if (!leaseMutexIsStale(path, existing, Date.now())) {
        waitOrThrow(existing);
      }
      continue;
    }

    const recoveryAfterPublish = readLeaseMutex(recoveryPath);
    if (recoveryAfterPublish) {
      releaseIfToken(path, token);
      waitOrThrow(recoveryAfterPublish, true);
      continue;
    }
    return { path, token };
  }
}

function releaseLeaseMutex(lock) {
  const current = readLeaseMutex(lock?.path);
  if (current?.token === lock?.token) {
    try { unlinkSync(lock.path); } catch { /* ignore */ }
  }
}

export function withLeaseMutex(env, fn, { timeoutMs = LEASE_MUTEX_TIMEOUT_MS } = {}) {
  const lock = acquireLeaseMutex(env, timeoutMs);
  try {
    return fn();
  } finally {
    releaseLeaseMutex(lock);
  }
}

/** Token-CAS removal: never unlink a lease another process replaced. */
function removeLeaseIfToken(env, token) {
  if (!token) return false;
  return withLeaseMutex(env, () => {
    const current = readLease(env);
    if (current?.token !== token) return false;
    try {
      unlinkSync(serviceLeasePath(env));
      return true;
    } catch {
      return false;
    }
  });
}

export function acquireLease(env = process.env, { mutexTimeoutMs = LEASE_MUTEX_TIMEOUT_MS } = {}) {
  if (readTeardownPoison(env)) return null;
  const path = serviceLeasePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLeaseMutex(env, () => {
    const existing = readLease(env);
    if (existing?.unreadable) return null;
    // Heartbeat age is not authority to replace a live process: a suspended
    // daemon can resume an already-running delivery after a stale takeover.
    // A live PID therefore blocks acquisition until an explicit, verified
    // handoff stops it (or it exits).
    if (Number.isInteger(existing?.pid) && pidIsAlive(existing.pid)) return null;
    const lease = {
      pid: process.pid,
      token: randomUUID(),
      version: CHANNEL_VERSION,
      execPath: process.execPath,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeLeaseAtomic(lease, env);
    const confirmed = readLease(env);
    return !confirmed?.unreadable && confirmed?.token === lease.token ? lease : null;
  }, { timeoutMs: mutexTimeoutMs });
}

export function heartbeatLease(lease, env = process.env) {
  try {
    return withLeaseMutex(env, () => {
      const current = readLease(env);
      if (!current || current.token !== lease.token) return false;
      lease.updatedAt = Date.now();
      writeLeaseAtomic(lease, env);
      return true;
    });
  } catch {
    return false;
  }
}

export function releaseLease(lease, env = process.env) {
  try { removeLeaseIfToken(env, lease?.token); } catch { /* ignore */ }
}

function readControlRequest(env) {
  try {
    const parsed = JSON.parse(readFileSync(serviceControlPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function clearControlRequestIfToken(env, token) {
  const current = readControlRequest(env);
  if (current?.leaseToken !== token) return false;
  try {
    unlinkSync(serviceControlPath(env));
    return true;
  } catch {
    return false;
  }
}

/** Cross-platform graceful-stop IPC; unlike process.kill it is safe on Windows. */
async function requestGracefulDaemonStop(lease, reason, env, { timeoutMs = GRACEFUL_STOP_TIMEOUT_MS } = {}) {
  if (!lease?.token) return false;
  mkdirSync(dirname(serviceControlPath(env)), { recursive: true, mode: 0o700 });
  writeFileDurable(serviceControlPath(env), JSON.stringify({
    version: 1,
    requestId: randomUUID(),
    leaseToken: lease.token,
    reason,
    requestedAt: new Date().toISOString(),
  }, null, 2));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readLease(env);
    if (current?.unreadable) return false;
    if (!current || current.token !== lease.token) {
      clearControlRequestIfToken(env, lease.token);
      return true;
    }
    if (!pidIsAlive(lease.pid)) {
      removeLeaseIfToken(env, lease.token);
      clearControlRequestIfToken(env, lease.token);
      return true;
    }
    await sleep(200);
  }
  return false;
}

/**
 * Linearize a protocol write with lease takeover: the token check and the
 * synchronous child.stdin.write dispatch run under the same interprocess
 * mutex used by acquireLease(). A replacement can happen either before the
 * check (write refused) or after the bytes were dispatched, never between.
 */
export function makeLeaseDispatchFence(lease, env = process.env) {
  return (dispatch) => withLeaseMutex(env, () => {
    if (readLease(env)?.token !== lease?.token) return false;
    dispatch();
    return true;
  });
}

/**
 * LIVE-OWNERSHIP PROOF before any control request: the lease's updatedAt must ADVANCE
 * under the SAME token within the proof window. Only the true daemon
 * heartbeats that token, so a stale lease pointing at a reused/unrelated PID
 * can never pass. Returns { live, lease } with the latest lease read.
 *
 * `sleepImpl` is injectable for tests.
 */
export async function verifyLiveDaemon(env = process.env, {
  windowMs = LIVE_PROOF_WINDOW_MS,
  sleepImpl = null,
} = {}) {
  const first = readLease(env);
  if (!first || !Number.isInteger(first.pid) || !first.token) return { live: false, lease: first };
  if (!pidIsAlive(first.pid)) return { live: false, lease: first };
  const deadline = Date.now() + windowMs;
  const doSleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadline) {
    await doSleep(250);
    const current = readLease(env);
    if (!current || current.token !== first.token) {
      // Lease replaced/removed mid-check: whatever holds it now is the
      // authority; the ORIGINAL identity was not confirmed.
      return { live: false, lease: current };
    }
    if (Number(current.updatedAt) > Number(first.updatedAt)) {
      return { live: true, lease: current };
    }
  }
  return { live: false, lease: readLease(env) };
}

/**
 * Stop the daemon SAFELY: after live-ownership proof, publish a token-bound
 * control request and wait for normal shutdown + lease release. A stale lease
 * is cleaned up without addressing a process; a live but unverified holder is
 * left alone. Raw PID signaling is deliberately absent on every platform.
 */
export async function stopService({ env = process.env, logEvent = null } = {}) {
  const log = logEvent ?? makeEventLogger({ env });
  const poison = readTeardownPoison(env);
  if (poison) {
    return { stopped: false, reason: "teardown_poisoned", poison };
  }
  const lease = readLease(env);
  if (!lease) return { stopped: false, reason: "not_running" };
  if (lease.unreadable) return { stopped: false, reason: "lease_unreadable", lease };
  const { live, lease: verified } = await verifyLiveDaemon(env);
  if (!live) {
    if (Number.isInteger(lease.pid) && pidIsAlive(lease.pid)) {
      log("warn", "codex.stop_owner_unverified", "Lease PID is alive but did not prove ownership; refusing both control request and takeover", {
        lease_pid: lease.pid,
      });
      return { stopped: false, reason: "live_pid_unverified" };
    }
    // No live-ownership proof: address NO process. Remove the stale lease so the
    // next ensure/run can start cleanly.
    const removed = removeLeaseIfToken(env, lease.token);
    if (!removed) {
      return { stopped: false, reason: "lease_changed" };
    }
    log("warn", "codex.stop_stale_lease", "Lease had no advancing heartbeat; cleaned up without addressing any process", {
      lease_pid: lease.pid ?? null,
    });
    return { stopped: false, reason: "stale_lease_cleaned" };
  }
  try {
    const stopped = await requestGracefulDaemonStop(verified, "explicit_stop", env);
    if (!stopped) return { stopped: false, reason: "graceful_stop_timeout", pid: verified.pid };
    log("info", "codex.stop_requested", `Verified codex-channel daemon pid ${verified.pid} shut down via control request`, {
      pid: verified.pid,
    });
    return { stopped: true, pid: verified.pid };
  } catch (err) {
    return { stopped: false, reason: `stop_request_failed: ${String(err?.message ?? err)}` };
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createService({
  env = process.env,
  logEvent = null,
  clientFactory = null,
  machineName = null,
  sendFence = null,
  dispatchFence = null,
  teardownPoisonWriter = persistTeardownPoison,
  teardownPoisonRetrySleep = sleep,
} = {}) {
  const log = logEvent ?? makeEventLogger({ env });
  const localMachine = machineName ?? safeLocalMachineName(env);
  const idleCloseMs = positiveEnvInt(env.AGENT_BRIDGE_CODEX_IDLE_CLOSE_MS, DEFAULT_IDLE_CLOSE_MS);
  const ownershipFreshMs = positiveEnvInt(env.AGENT_BRIDGE_CODEX_OWNERSHIP_FRESH_MS, DEFAULT_OWNERSHIP_FRESH_MS);

  const retainedDeliveryState = loadRetainedDeliveryState(env);
  const ledger = retainedDeliveryState.delivered;
  const indeterminateLedger = retainedDeliveryState.indeterminate;
  /** @type {Map<string, AliasDelivery>} */
  const deliveries = new Map();
  /** @type {Map<string, ThreadSession>} */
  const sessions = new Map();
  /** @type {Map<string, object>} alias -> runtime state for status */
  const runtime = new Map();
  let client = null;
  let clientClosedReason = null;
  let versionBlockedUntil = 0;
  let lastActivityAt = Date.now();
  /** alias -> last time WE touched the thread (delivery / session activity) */
  const ourActivityAt = new Map();
  /** alias -> exact thread+rollout mtime last observed after our activity. */
  const rolloutBaselines = new Map();
  const restoreRetryAt = new Map();

  async function closeClientVerified(target, context) {
    try {
      await target.close();
    } catch (err) {
      let poison;
      let poisonWriteAttempts = 0;
      // An unverified process tree plus a failed poison write is the one
      // state in which returning would make a later dead-PID lease takeover
      // unsafe. Keep this process (and therefore its live-PID lease fence)
      // alive until the durable poison is published. Normal service calls
      // keep the independent heartbeat running; shutdown still cannot exit.
      for (;;) {
        poisonWriteAttempts += 1;
        try {
          poison = teardownPoisonWriter(target, err, context, env);
          break;
        } catch (poisonErr) {
          log("error", "codex.appserver_teardown_poison_write_failed",
            "App Server teardown was unverified and its durable poison fence could not be written; retaining the live daemon fence and retrying", {
              context,
              attempt: poisonWriteAttempts,
              teardown_error: String(err?.message ?? err),
              poison_error: String(poisonErr?.message ?? poisonErr),
            });
          await teardownPoisonRetrySleep(TEARDOWN_POISON_RETRY_MS);
        }
      }
      log("error", "codex.appserver_teardown_poisoned",
        "App Server process tree could not be proven terminated; all replacement daemons are durably fenced", {
          context,
          child_pid: poison.pid,
          poison_path: serviceTeardownPoisonPath(env),
          error: poison.error,
          poison_write_attempts: poisonWriteAttempts,
        });
      throw err;
    }
  }

  function recordRolloutBaseline(binding) {
    const found = findRolloutForThread(binding.threadId, { env });
    if (!found) return;
    const mtime = rolloutMtimeMs(found.path) ?? found.mtimeMs;
    if (Number.isFinite(mtime)) rolloutBaselines.set(binding.alias, { threadId: binding.threadId, mtime });
  }

  function aliasRuntime(alias) {
    if (!runtime.has(alias)) {
      runtime.set(alias, { state: "idle", detail: null, retryAt: 0, lastTurnOutcome: null });
    }
    return runtime.get(alias);
  }

  async function getClient() {
    if (client && !client.closed) return client;
    const poison = readTeardownPoison(env);
    if (poison) {
      throw new Error(
        `codex-channel App Server teardown is poisoned at ${serviceTeardownPoisonPath(env)}: `
        + `${poison.error ?? "unreadable poison record"}. Verify the old process tree is gone before clearing it.`,
      );
    }
    // A fatal framing/transport close marks the logical client closed before
    // its bounded child teardown necessarily finishes.  Never resume the same
    // thread through a replacement App Server while that old process may still
    // own subscriptions: await the idempotent teardown first.
    if (client?.closed) {
      const stale = client;
      // A failed Windows exact-tree teardown is a hard fence: propagating the
      // error keeps this service from resuming the same thread beside a
      // possibly orphaned Codex descendant.
      await closeClientVerified(stale, "replace_closed_client");
      if (client === stale) client = null;
    }
    if (Date.now() < versionBlockedUntil) {
      throw new Error("codex app-server version unsupported (retry window active)");
    }
    const factory = clientFactory ?? (() => CodexAppServerClient.spawn({
      env,
      logEvent: log,
      clientName: "agent-bridge-codex-channel",
      clientVersion: CHANNEL_VERSION,
    }));
    const fresh = await factory();
    try {
      await fresh.initialize();
    } catch (err) {
      try {
        await closeClientVerified(fresh, "initialize_failed");
      } catch (closeErr) {
        // Retain the poisoned logical owner. Future getClient calls await the
        // same rejected teardown and cannot manufacture a replacement.
        client = fresh;
        clientClosedReason = String(closeErr?.message ?? closeErr);
        throw closeErr;
      }
      if (err instanceof CodexVersionError) {
        versionBlockedUntil = Date.now() + VERSION_RETRY_MS;
      }
      throw err;
    }
    client = fresh;
    clientClosedReason = null;
    client.onClose((closeErr) => {
      clientClosedReason = String(closeErr?.message ?? closeErr ?? "closed");
      sessions.clear();
      log("warn", "codex.appserver_closed", `App-server connection closed: ${clientClosedReason}`, {});
    });
    return client;
  }

  /**
   * Ownership guard: fresh foreign rollout writes => defer/release.
   * Applies BOTH before attach and while attached (an existing session no
   * longer suppresses the check). Advances caused by our own active
   * bridge-owned turn are excluded — those are expected writes.
   */
  function foreignActivityRecent(binding) {
    if (binding.policy.ownershipGuard === false) return false;
    const session = sessions.get(binding.alias);
    if (session && session.turnActive && session.activeTurnOurs) return false; // our turn is writing
    const found = findRolloutForThread(binding.threadId, { env });
    if (!found) return false;
    const mtime = rolloutMtimeMs(found.path) ?? found.mtimeMs;
    const baseline = rolloutBaselines.get(binding.alias);
    // An exact advance beyond the last rollout state captured after our own
    // activity is foreign. This has no wall-clock grace/blind spot: an
    // immediate external touch after attach is detected on the next tick.
    if (baseline?.threadId === binding.threadId && Number.isFinite(baseline.mtime) && mtime <= baseline.mtime) return false;
    return Date.now() - mtime < ownershipFreshMs;
  }

  async function releaseSession(alias, reason, { detachOnRestoreFailure = false } = {}) {
    const session = sessions.get(alias);
    if (!session) return true;
    const outcome = await session.release({ detachOnRestoreFailure }).catch((err) => ({
      released: false,
      reason: `release_failed: ${String(err?.message ?? err)}`,
    }));
    if (!outcome?.released) {
      const state = aliasRuntime(alias);
      state.state = "settings_restore_pending";
      state.detail = `pre-bridge thread settings restore pending: ${outcome?.reason ?? "unknown"}`;
      state.retryAt = Date.now() + POLL_MS;
      log("warn", "codex.session_release_deferred", `Keeping session ${alias} attached until settings restoration succeeds`, {
        alias,
        reason,
        restore_reason: outcome?.reason ?? "unknown",
      });
      return false;
    }
    if (sessions.get(alias) === session) sessions.delete(alias);
    ourActivityAt.set(alias, Date.now());
    if (reason !== "foreign_activity_detected") recordRolloutBaseline(session.binding);
    log("info", "codex.session_released", `Released session for ${alias} (${reason})`, { alias, reason });
    return true;
  }

  /**
   * One App Server connection is intentionally single-session at the service
   * layer. ThreadSession supports exact multi-thread request routing, but a
   * connection recycle is necessarily connection-wide; serializing aliases
   * prevents an ambiguous cleanup for one alias from aborting another alias's
   * accepted active turn. Idle sessions are handed off cleanly, active ones
   * keep later aliases queued until their terminal notification arrives.
   */
  async function prepareExclusiveSession(alias) {
    for (const [otherAlias, other] of Array.from(sessions.entries())) {
      if (otherAlias === alias) continue;
      if (other.turnActive) {
        throw new Error(
          `shared Codex App Server is observing active bridge turn ${other.activeTurnId ?? "unknown"} `
          + `for ${otherAlias}; ${alias} remains queued until it completes`,
        );
      }
      const released = await releaseSession(otherAlias, `alias_handoff_to_${alias}`);
      if (!released) {
        throw new Error(
          `shared Codex App Server could not release idle alias ${otherAlias}; ${alias} remains queued`,
        );
      }
    }
  }

  /** Recover one durable sticky-settings journal before any new delivery. */
  async function recoverPendingSettings(binding) {
    const pending = readSettingsRestoreJournal(binding.alias, env);
    if (!pending) return false;
    if (pending.state === "resolved") {
      try { unlinkSync(pendingSettingsPath(binding.alias, env)); } catch { /* safe tombstone */ }
      return false;
    }
    await prepareExclusiveSession(binding.alias);
    const rpc = await getClient();
    const recovery = new ThreadSession({
      client: rpc,
      binding: { ...binding, threadId: pending.threadId },
      env,
      logEvent: log,
      dispatchFence,
    });
    await recovery.resume();
    let restored = { restored: false, reason: "not_needed" };
    if (recovery.recoveredRestoreJournal) {
      restored = recovery.turnActive
        ? { restored: false, reason: "turn_active" }
        : await recovery.restoreThreadSettings();
    }
    if (recovery.recoveredRestoreJournal && !recovery.settingsRestored) {
      const detached = await recovery.release({ detachOnRestoreFailure: true }).catch((err) => ({
        released: false,
        reason: `release_failed: ${String(err?.message ?? err)}`,
      }));
      if (!detached?.released) {
        // A temporary recovery session has no durable in-memory owner. If its
        // unsubscribe is rejected, recycle the otherwise-exclusive connection
        // so no handlerless subscription survives into a later retry.
        await closeClientVerified(rpc, "recovery_unsubscribe_rejected");
      }
      throw new Error(
        `pending settings restore for thread ${pending.threadId} is not complete (${restored.reason}); `
        + "new bridge delivery remains blocked",
      );
    }
    const released = await recovery.release().catch((err) => ({
      released: false,
      reason: `release_failed: ${String(err?.message ?? err)}`,
    }));
    if (!released?.released) {
      await closeClientVerified(rpc, "recovery_unsubscribe_rejected_after_restore");
      throw new Error(
        `pending settings restore for thread ${pending.threadId} completed, but unsubscribe was not confirmed `
        + `(${released?.reason ?? "unknown"}); connection recycled before retry`,
      );
    }
    log("info", "codex.settings_restore_recovered", `Recovered pending thread settings for ${binding.alias}`, {
      alias: binding.alias,
      thread_id: pending.threadId,
      resolution: restored.reason ?? (restored.restored ? "restored" : "already_resolved"),
    });
    return true;
  }

  /** Recover journals even when their binding was disabled or removed. */
  async function sweepPendingSettingsRestores() {
    let entries;
    try {
      entries = readdirSync(pendingSettingsDir(env), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return new Set();
      throw new Error(
        `cannot enumerate pending Codex settings restores at ${pendingSettingsDir(env)}: ${String(error?.message ?? error)}`,
        { cause: error },
      );
    }
    const blocked = new Set();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const alias = entry.name.slice(0, -5);
      if (!isValidAlias(alias)) continue;
      // A live session owns its pending journal and will restore it on queue
      // drain. Opening a second recovery subscription would race that owner.
      if (sessions.has(alias)) continue;
      if (Date.now() < (restoreRetryAt.get(alias) ?? 0)) {
        blocked.add(alias);
        continue;
      }
      let pending;
      try {
        pending = readSettingsRestoreJournal(alias, env);
      } catch (err) {
        blocked.add(alias);
        restoreRetryAt.set(alias, Date.now() + RESUME_RETRY_MS);
        log("error", "codex.settings_restore_recovery_failed", `Cannot read pending settings journal for ${alias}`, {
          alias,
          error: String(err?.message ?? err),
        });
        continue;
      }
      if (!pending) continue;
      const recoveryBinding = {
        alias,
        threadId: pending.threadId,
        cwd: null,
        enabled: false,
        policy: { steering: false, ownershipGuard: true, approvalPolicy: "never", sandbox: "read-only", turnTimeoutMs: null },
      };
      try {
        await recoverPendingSettings(recoveryBinding);
        restoreRetryAt.delete(alias);
      } catch (err) {
        blocked.add(alias);
        restoreRetryAt.set(alias, Date.now() + RESUME_RETRY_MS);
        log("warn", "codex.settings_restore_recovery_deferred", `Pending settings restore for ${alias} remains blocked`, {
          alias,
          thread_id: pending.threadId,
          error: String(err?.message ?? err),
        });
      }
    }
    return blocked;
  }

  async function getSession(binding) {
    const existing = sessions.get(binding.alias);
    if (existing && existing.threadId === binding.threadId && !existing.client.closed) {
      if (existing.sentOverrides && !existing.settingsRestored && !existing.turnActive) {
        const restored = await existing.restoreThreadSettings();
        if (!existing.settingsRestored) {
          throw new Error(`thread settings restore still pending for ${binding.threadId} (${restored.reason})`);
        }
      }
      return existing;
    }
    if (existing) {
      const released = await releaseSession(binding.alias, "binding_changed");
      if (!released) {
        throw new Error(
          `existing session for ${binding.alias} could not be released; refusing replacement resume`,
        );
      }
    }
    await prepareExclusiveSession(binding.alias);
    await recoverPendingSettings(binding);
    const rpc = await getClient();
    const session = new ThreadSession({
      client: rpc,
      binding,
      env,
      logEvent: log,
      dispatchFence,
      onIdle: () => {
        ourActivityAt.set(binding.alias, Date.now());
        lastActivityAt = Date.now();
      },
      onTurnCompleted: (finished) => {
        ourActivityAt.set(binding.alias, Date.now());
        recordRolloutBaseline(binding);
        lastActivityAt = Date.now();
        const delivery = deliveries.get(binding.alias);
        const msgId = finished.turnId && delivery ? delivery.messageForTurn(finished.turnId) : null;
        const state = aliasRuntime(binding.alias);
        state.lastTurnOutcome = {
          turnId: finished.turnId ?? null,
          status: finished.status,
          error: finished.errorMessage ?? null,
          msgId,
          at: new Date().toISOString(),
        };
        if (finished.status === "completed") {
          log("info", "codex.turn_completed", `Bridge turn ${finished.turnId ?? "?"} completed on ${binding.alias}`, {
            alias: binding.alias, turn_id: finished.turnId ?? null, msg_id: msgId,
          });
        } else {
          // Delivery remains "accepted into the thread", but the terminal
          // outcome is failed/cancelled — surface it loudly, never silently.
          log("error", "codex.turn_failed_terminal",
            `Bridge turn ${finished.turnId ?? "?"} ended ${finished.status} on ${binding.alias}: ${finished.errorMessage ?? "no error message"}`, {
              alias: binding.alias,
              turn_id: finished.turnId ?? null,
              msg_id: msgId,
              status: finished.status,
              error: finished.errorMessage ?? null,
            });
        }
      },
    });
    await session.resume();
    sessions.set(binding.alias, session);
    ourActivityAt.set(binding.alias, Date.now());
    recordRolloutBaseline(binding);
    return session;
  }

  function sweepUnrouted() {
    const dir = join(inboxRoot(env), CODEX_HARNESS_PREFIX);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const src = join(dir, entry.name);
      try {
        mkdirSync(unroutedDir(env), { recursive: true, mode: 0o700 });
        renameSync(src, join(unroutedDir(env), entry.name));
        log("warn", "codex.unrouted_quarantined",
          `Flat file ${entry.name} under inbox/codex/ moved to _unrouted (target must be codex/<alias>)`, {
            file: entry.name,
          });
      } catch { /* ignore */ }
    }
  }

  function bindingBehaviorKey(binding) {
    return JSON.stringify({ t: binding.threadId, c: binding.cwd, p: binding.policy });
  }

  async function syncBindings() {
    const enabled = listEnabledBindings({ env });
    const enabledAliases = new Set(enabled.map((b) => b.alias));
    for (const alias of Array.from(deliveries.keys())) {
      if (!enabledAliases.has(alias)) {
        const released = await releaseSession(alias, "binding_unloaded");
        if (!released) continue;
        deliveries.delete(alias);
        rolloutBaselines.delete(alias);
        runtime.delete(alias);
        log("info", "codex.binding_unloaded", `Binding ${alias} unloaded`, { alias });
      }
    }
    for (const binding of enabled) {
      const existing = deliveries.get(binding.alias);
      if (!existing) {
        const delivery = new AliasDelivery({
          binding,
          env,
          logEvent: log,
          localMachine,
          channelVersion: CHANNEL_VERSION,
          ledger,
          indeterminateLedger,
          sendFence: sendFence ?? (() => true),
        });
        delivery.reconcile();
        deliveries.set(binding.alias, delivery);
        log("info", "codex.binding_loaded", `Binding ${binding.alias} -> thread ${binding.threadId} loaded`, {
          alias: binding.alias,
          thread_id: binding.threadId,
          steering: binding.policy.steering,
          sandbox: binding.policy.sandbox,
          approval_policy: binding.policy.approvalPolicy,
        });
      } else if (bindingBehaviorKey(existing.binding) !== bindingBehaviorKey(binding)) {
        // ANY behavior-affecting change (thread, cwd, sandbox, approvals,
        // steering, ownership guard) invalidates the live session — a
        // session constructed with the OLD binding must never deliver under
        // NEW policy expectations (e.g. danger-full-access surviving a
        // rebind to read-only).
        const released = await releaseSession(binding.alias, "binding_policy_changed");
        if (!released) continue;
        if (existing.binding.threadId !== binding.threadId) rolloutBaselines.delete(binding.alias);
        existing.binding = binding;
        log("info", "codex.binding_reloaded", `Binding ${binding.alias} updated; session invalidated`, {
          alias: binding.alias,
          thread_id: binding.threadId,
          sandbox: binding.policy.sandbox,
          approval_policy: binding.policy.approvalPolicy,
          cwd: binding.cwd,
        });
      }
    }
    return enabled.filter((binding) => {
      const delivery = deliveries.get(binding.alias);
      return delivery && bindingBehaviorKey(delivery.binding) === bindingBehaviorKey(binding);
    });
  }

  async function pumpAlias(binding) {
    const delivery = deliveries.get(binding.alias);
    if (!delivery) return;
    const state = aliasRuntime(binding.alias);
    delivery.scanInbox();

    const session = sessions.get(binding.alias);
    const hasWork = delivery.hasQueued();
    const turnActive = Boolean(session && session.turnActive);

    // A crash can leave no queued message (it was already archived) but a
    // pending sticky-settings journal. Recovery itself is actionable work.
    if (!hasWork && !session) {
      let pendingRestore = null;
      try { pendingRestore = readSettingsRestoreJournal(binding.alias, env); } catch (err) {
        state.state = "settings_restore_pending";
        state.detail = String(err?.message ?? err);
        state.retryAt = Date.now() + RESUME_RETRY_MS;
        return;
      }
      if (pendingRestore?.state === "pending") {
        try {
          await recoverPendingSettings(binding);
          state.state = "idle";
          state.detail = null;
          state.retryAt = 0;
        } catch (err) {
          state.state = "settings_restore_pending";
          state.detail = String(err?.message ?? err);
          state.retryAt = Date.now() + RESUME_RETRY_MS;
        }
        return;
      }
    }

    // Resolve an already-dispatched ambiguous turn BEFORE interpreting its
    // rollout write as foreign ownership. A positive clientId history match
    // establishes bridge ownership and updates the exact rollout baseline.
    if (session && delivery.hasIndeterminateQueued()) {
      try {
        const outcome = await delivery.deliverStep(session);
        if (outcome === "delivered") {
          ourActivityAt.set(binding.alias, Date.now());
          recordRolloutBaseline(binding);
          state.state = session.turnActive ? "turn_active" : "idle";
          state.detail = null;
        } else {
          state.state = "waiting_reconciliation";
        }
      } catch (err) {
        state.state = "delivery_error";
        state.detail = String(err?.message ?? err);
        state.retryAt = Date.now() + RESUME_RETRY_MS;
      }
      return;
    }

    // Ownership guard AFTER attach: an unexplained rollout advance while we
    // hold a subscription (and are not mid-bridge-turn) means another client
    // took the thread — release rather than hold a second writer.
    if (session && foreignActivityRecent(binding)) {
      // The rollout advance itself is proof that another client may have
      // changed sticky settings without notifications on our connection.
      // Never replay our old snapshot over that foreign state.
      session.foreignTurnSinceOverrides = true;
      await releaseSession(binding.alias, "foreign_activity_detected");
      state.state = "deferred_foreign_activity";
      state.detail = "another Codex client wrote the thread while we were attached; released our subscription";
      state.retryAt = Date.now() + POLL_MS * 5;
      log("warn", "codex.ownership_deferred", `Foreign activity on ${binding.alias} after attach; session released`, {
        alias: binding.alias,
        thread_id: binding.threadId,
        phase: "post_attach",
      });
      return;
    }

    if (!hasWork && !turnActive) {
      // Prompt release: nothing to deliver and no bridge-owned turn to
      // observe — restore settings + unsubscribe instead of holding a
      // second writer against the user's task.
      if (session) {
        const released = await releaseSession(binding.alias, "queue_drained");
        if (!released) return;
      }
      if (state.state !== "idle") {
        state.state = "idle";
        state.detail = null;
      }
      return;
    }
    lastActivityAt = Date.now();
    if (Date.now() < (state.retryAt ?? 0)) return;

    if (!session && foreignActivityRecent(binding)) {
      if (state.state !== "deferred_foreign_activity") {
        log("warn", "codex.ownership_deferred",
          `Deferring delivery for ${binding.alias}: thread rollout was written recently by another client`, {
            alias: binding.alias,
            thread_id: binding.threadId,
            fresh_ms: ownershipFreshMs,
            phase: "pre_attach",
          });
      }
      state.state = "deferred_foreign_activity";
      state.detail = "another Codex client appears to be actively using this thread; delivery deferred until it goes quiet";
      state.retryAt = Date.now() + POLL_MS * 5;
      return;
    }

    if (!hasWork) return; // only observing an active bridge-owned turn

    let liveSession;
    try {
      liveSession = await getSession(binding);
    } catch (err) {
      const detail = String(err?.message ?? err);
      const notFound = /not.?found|no such thread|unknown thread/i.test(detail);
      const locked = /lock|owned|in use|another (?:client|process)/i.test(detail);
      state.state = err instanceof CodexVersionError || /version unsupported/.test(detail)
        ? "codex_unsupported"
        : notFound ? "thread_not_found"
          : locked ? "ownership_conflict"
            : "session_error";
      state.detail = detail;
      state.retryAt = Date.now() + RESUME_RETRY_MS;
      log("error", "codex.session_open_failed", `Cannot open session for ${binding.alias}: ${detail}`, {
        alias: binding.alias,
        thread_id: binding.threadId,
        classified_state: state.state,
      });
      return;
    }

    state.state = liveSession.turnActive ? "turn_active" : "delivering";
    state.detail = null;
    try {
      const outcome = await delivery.deliverStep(liveSession);
      if (outcome === "delivered") {
        ourActivityAt.set(binding.alias, Date.now());
        recordRolloutBaseline(binding);
        lastActivityAt = Date.now();
        state.state = liveSession.turnActive ? "turn_active" : "idle";
      } else if (outcome === "deferred") {
        state.state = liveSession.turnActive ? "turn_active" : "waiting";
      }
    } catch (err) {
      state.state = "delivery_error";
      state.detail = String(err?.message ?? err);
      state.retryAt = Date.now() + RESUME_RETRY_MS;
      log("error", "codex.delivery_step_failed", `deliverStep failed for ${binding.alias}: ${state.detail}`, {
        alias: binding.alias,
      });
    }
  }

  async function maybeIdleClose() {
    if (!client || client.closed) return;
    const anyQueued = Array.from(deliveries.values()).some((d) => d.hasQueued());
    const anyActiveTurn = Array.from(sessions.values()).some((s) => s.turnActive);
    if (anyQueued || anyActiveTurn) return;
    if (Date.now() - lastActivityAt < idleCloseMs) return;
    log("info", "codex.appserver_idle_close", "Closing idle app-server connection", {
      idle_ms: Date.now() - lastActivityAt,
    });
    let allReleased = true;
    for (const alias of Array.from(sessions.keys())) {
      if (!(await releaseSession(alias, "idle_close"))) allReleased = false;
    }
    if (!allReleased) return;
    const closing = client;
    await closeClientVerified(closing, "idle_close");
    if (client === closing) client = null;
  }

  /**
   * Automatic version refresh is a drain, not an abort. Stop opening or
   * dispatching new work at the daemon boundary, keep observing every active
   * turn, then restore settings and unsubscribe once each becomes idle. A
   * failed restore/unsubscribe remains attached and is retried; the caller's
   * bounded refresh wait may time out, but this daemon keeps its lease and
   * App Server alive until the drain is genuinely safe.
   */
  async function drainForVersionRefresh() {
    let drained = true;
    for (const [alias, session] of Array.from(sessions.entries())) {
      const state = aliasRuntime(alias);
      if (session.turnActive) {
        state.state = "draining_active_turn";
        state.detail = "version refresh is waiting for the active Codex turn to finish";
        drained = false;
        continue;
      }
      if (!(await releaseSession(alias, "version_refresh_drain"))) drained = false;
    }
    return drained && sessions.size === 0;
  }

  /** One full poll pass. Exposed for deterministic tests. */
  async function tick() {
    sweepUnrouted();
    const restoreBlocked = await sweepPendingSettingsRestores();
    const enabled = await syncBindings();
    for (const binding of enabled) {
      if (restoreBlocked.has(binding.alias)) continue;
      await pumpAlias(binding);
    }
    await maybeIdleClose();
  }

  async function shutdown(reason) {
    log("info", "codex.service_stopping", `codex-channel service stopping (${reason})`, { pid: process.pid });
    // Once our lease token is gone, another daemon may already be the sole
    // authority. Do not restore settings or unsubscribe through the old
    // connection after that boundary; leave durable journals for the new
    // owner and only tear down the App Server process we still own.
    if (reason !== "lease-lost") {
      for (const alias of Array.from(sessions.keys())) {
        await releaseSession(alias, `shutdown_${reason}`, { detachOnRestoreFailure: true });
      }
    }
    if (client) {
      const closing = client;
      await closeClientVerified(closing, `shutdown_${reason}`);
      if (client === closing) client = null;
    }
    log("info", "codex.service_stopped", "codex-channel service stopped", { pid: process.pid });
  }

  function statusSnapshot() {
    return {
      version: CHANNEL_VERSION,
      machine: localMachine,
      appServer: client && !client.closed
        ? { connected: true, serverVersion: client.serverVersion }
        : { connected: false, lastCloseReason: clientClosedReason },
      aliases: Array.from(deliveries.values()).map((d) => ({
        ...d.statusSnapshot(),
        sessionAttached: sessions.has(d.alias),
        runtime: runtime.get(d.alias) ?? { state: "idle", lastTurnOutcome: null },
      })),
    };
  }

  return { tick, drainForVersionRefresh, shutdown, statusSnapshot, _internals: { deliveries, sessions, runtime, getClient, ledger, indeterminateLedger, releaseSession, recoverPendingSettings, sweepPendingSettingsRestores, rolloutBaselines, prepareExclusiveSession } };
}

// ── Daemon entrypoints ──────────────────────────────────────────────────────

export async function runService({ env = process.env, mirror = null } = {}) {
  const log = makeEventLogger({ env, mirror });
  const startupPoison = readTeardownPoison(env);
  if (startupPoison) {
    log("error", "codex.service_start_blocked_teardown_poison",
      "Refusing to start beside an App Server process tree whose teardown was not verified", {
        poison_path: serviceTeardownPoisonPath(env),
        child_pid: startupPoison.pid ?? null,
        error: startupPoison.error ?? "unreadable poison record",
      });
    return { started: false, teardownPoisoned: true };
  }
  const startupLease = readLease(env);
  if (startupLease?.unreadable) {
    log("error", "codex.service_start_blocked_unreadable_lease",
      "Refusing to start because the retained service lease is unreadable or invalid", {
        lease_path: startupLease.path,
        error: startupLease.error,
      });
    return { started: false, leaseUnreadable: true, lease: startupLease };
  }
  const lease = acquireLease(env);
  if (!lease) {
    log("info", "codex.lease_busy", "codex-channel service already running", {});
    return { started: false };
  }
  log("info", "codex.service_started", "agent-bridge codex-channel service started", {
    pid: process.pid,
    version: CHANNEL_VERSION,
  });
  let drainingForVersionRefresh = false;
  const leaseDispatchFence = makeLeaseDispatchFence(lease, env);
  const service = createService({
    env,
    logEvent: log,
    sendFence: () => !drainingForVersionRefresh && readLease(env)?.token === lease.token,
    dispatchFence: (dispatch, request) => {
      if (drainingForVersionRefresh
        && ["thread/resume", "turn/start", "turn/steer"].includes(request?.method)) return false;
      return leaseDispatchFence(dispatch);
    },
  });
  let stopped = false;
  let stopReason = "loop-exit";
  const stop = (reason) => () => {
    stopped = true;
    stopReason = reason;
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  // INDEPENDENT heartbeat: a slow App Server RPC inside tick() must never
  // let the lease go stale (stale threshold 15 s vs 20-30 s RPC budgets).
  // The timer stays ref'd — the daemon must keep the loop alive anyway.
  let leaseLost = false;
  const heartbeatTimer = setInterval(() => {
    if (stopped || leaseLost) return;
    const control = readControlRequest(env);
    if (control?.leaseToken === lease.token) {
      const reason = String(control.reason ?? "stop");
      stopReason = `control:${reason}`;
      if (reason === "version_refresh") drainingForVersionRefresh = true;
      else {
        stopped = true;
        return;
      }
    }
    if (!heartbeatLease(lease, env)) {
      leaseLost = true;
      log("warn", "codex.lease_lost", "codex-channel lease lost; exiting", { pid: process.pid });
    }
  }, LEASE_HEARTBEAT_MS);

  try {
    while (!stopped && !leaseLost) {
      try {
        if (drainingForVersionRefresh) {
          if (await service.drainForVersionRefresh()) {
            stopped = true;
            break;
          }
        } else {
          await service.tick();
        }
      } catch (err) {
        log("error", "codex.tick_failed", `Service tick failed: ${String(err?.message ?? err)}`, {});
      }
      await sleep(POLL_MS);
    }
  } finally {
    clearInterval(heartbeatTimer);
    let shutdownVerified = false;
    try {
      await service.shutdown(leaseLost ? "lease-lost" : stopReason);
      shutdownVerified = true;
    } catch (err) {
      log("error", "codex.service_shutdown_unverified",
        "Service shutdown could not verify App Server teardown; preserving lease/control evidence and durable poison fence", {
          error: String(err?.message ?? err),
          poison_path: serviceTeardownPoisonPath(env),
        });
    }
    if (shutdownVerified) {
      releaseLease(lease, env);
      clearControlRequestIfToken(env, lease.token);
    }
  }
  return { started: true };
}

/**
 * Spawn a detached daemon unless a healthy same-or-newer one already holds
 * the lease.
 *
 * Version refresh: when the lease-holder is FRESH but OLDER-version, we
 * demand LIVE-OWNERSHIP PROOF (advancing heartbeat under the same token),
 * then request normal shutdown through the token-bound control file. No raw
 * PID signal is sent; an unverified live holder blocks takeover.
 *
 * Kill switch: AGENT_BRIDGE_CODEX_NO_ENSURE=1 makes this a no-op.
 */
/**
 * Prove a detached daemon is actually serving before reporting ensure
 * success. A returned PID only proves spawn dispatch; readiness requires that
 * exact child to publish a lease and advance its heartbeat under one token.
 */
export async function waitForSpawnedDaemonReady(child, env = process.env, {
  timeoutMs = STARTUP_READY_TIMEOUT_MS,
  sleepImpl = sleep,
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ready: false, reason: "spawn returned no valid pid" };
  let childError = null;
  const onError = (error) => { childError = `spawn error: ${String(error?.message ?? error)}`; };
  const onExit = (code, signal) => {
    childError = `daemon exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"})`;
  };
  child?.once?.("error", onError);
  child?.once?.("exit", onExit);
  let observed = null;
  let childFailedAt = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if ((childError || child?.exitCode !== null && child?.exitCode !== undefined || child?.signalCode) && !childFailedAt) {
        childFailedAt = Date.now();
      }
      const current = readLease(env);
      if (current?.unreadable) return { ready: false, reason: `startup lease unreadable: ${current.error}` };
      const candidateIsCurrentVersion = current && typeof current.token === "string"
        && compareVersions(typeof current.version === "string" ? current.version : "0.0.0", CHANNEL_VERSION) >= 0;
      if (candidateIsCurrentVersion) {
        if (observed?.pid === current.pid
          && observed?.token === current.token
          && Number(current.updatedAt) > Number(observed.updatedAt)
          && leaseFresh(current)) {
          return {
            ready: true,
            pid: current.pid,
            token: current.token,
            raced: current.pid !== pid,
          };
        }
        observed = { pid: current.pid, token: current.token, updatedAt: Number(current.updatedAt) };
      } else {
        observed = null;
      }
      // Give a concurrently spawned peer time to publish its lease. Once a
      // different current-version candidate appears, the normal deadline
      // applies so we can observe its required heartbeat advance.
      if (childFailedAt && (!current || current.pid === pid) && Date.now() - childFailedAt >= 1_000) {
        return { ready: false, reason: childError ?? "daemon exited before readiness" };
      }
      await sleepImpl(STARTUP_READY_POLL_MS);
    }
    return { ready: false, reason: "daemon did not publish an advancing heartbeat before the startup timeout" };
  } finally {
    child?.removeListener?.("error", onError);
    child?.removeListener?.("exit", onExit);
  }
}

export async function ensureService({
  env = process.env,
  spawnImpl = null,
  logEvent = null,
  readinessImpl = waitForSpawnedDaemonReady,
} = {}) {
  if (String(env.AGENT_BRIDGE_CODEX_NO_ENSURE ?? "") === "1") {
    const current = readLease(env);
    return { spawned: false, skipped: true, pid: leaseFresh(current) ? current.pid : null };
  }
  const log = logEvent ?? makeEventLogger({ env });
  const poison = readTeardownPoison(env);
  if (poison) {
    log("error", "codex.service_ensure_blocked_teardown_poison",
      "Refusing to ensure beside an App Server process tree whose teardown was not verified", {
        poison_path: serviceTeardownPoisonPath(env),
        child_pid: poison.pid ?? null,
        error: poison.error ?? "unreadable poison record",
      });
    return { spawned: false, pid: poison.pid ?? null, teardownPoisoned: true, poison };
  }
  let current = readLease(env);
  if (current?.unreadable) {
    log("error", "codex.service_ensure_blocked_unreadable_lease",
      "Refusing to spawn because the retained service lease is unreadable or invalid", {
        lease_path: current.path,
        error: current.error,
      });
    return { spawned: false, leaseUnreadable: true, lease: current };
  }
  if (current && Number.isInteger(current.pid) && pidIsAlive(current.pid) && !leaseFresh(current)) {
    log("warn", "codex.service_owner_unverified",
      "A live PID holds a heartbeat-stale lease; refusing split-brain takeover", {
        pid: current.pid,
        lease_version: current.version ?? null,
      });
    return { spawned: false, pid: current.pid, unverified: true };
  }
  if (leaseFresh(current)) {
    const leaseVersion = typeof current.version === "string" ? current.version : "0.0.0";
    if (compareVersions(leaseVersion, CHANNEL_VERSION) >= 0) {
      return { spawned: false, pid: current.pid };
    }
    // Older-version holder: verify live ownership before addressing it.
    const { live, lease: verified } = await verifyLiveDaemon(env);
    if (live) {
      log("info", "codex.service_version_refresh", `Stopping codex-channel v${leaseVersion} (pid ${verified.pid}) for v${CHANNEL_VERSION}`, {
        old_version: leaseVersion,
        new_version: CHANNEL_VERSION,
        pid: verified.pid,
      });
      const stopped = await requestGracefulDaemonStop(verified, "version_refresh", env);
      current = readLease(env);
      if (!stopped || (current?.token === verified.token && pidIsAlive(verified.pid))) {
        log("warn", "codex.service_version_refresh_stuck", `Old codex-channel pid ${current?.pid ?? verified.pid} did not exit; leaving it running`, {
          pid: current?.pid ?? verified.pid,
        });
        return { spawned: false, pid: current?.pid ?? verified.pid, staleVersion: true };
      }
    } else {
      // A live but non-advancing PID may be a suspended daemon inside a
      // delivery. Refuse takeover as well as a control request; availability needs
      // an explicit operator handoff, never two writers.
      log("warn", "codex.service_owner_unverified", "Lease PID is alive but ownership was not proven; refusing split-brain takeover", {
        lease_pid: current?.pid ?? null,
        lease_version: leaseVersion,
      });
      return { spawned: false, pid: current?.pid ?? null, unverified: true };
    }
  }
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const doSpawn = spawnImpl ?? spawn;
  const entry = fileURLToPath(new URL("../service.mjs", import.meta.url));
  const child = doSpawn(process.execPath, [entry, "run"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref?.();
  const readiness = await readinessImpl(child, env);
  if (!readiness?.ready) {
    const retained = readLease(env);
    if (retained && !retained.unreadable && retained.pid === child.pid && !pidIsAlive(child.pid)) {
      removeLeaseIfToken(env, retained.token);
    }
    log("error", "codex.service_startup_failed", `Spawned codex-channel did not become ready: ${readiness?.reason ?? "unknown"}`, {
      pid: child.pid ?? null,
      reason: readiness?.reason ?? "unknown",
    });
    return {
      spawned: false,
      pid: child.pid ?? null,
      startupFailed: true,
      reason: readiness?.reason ?? "startup readiness was not proven",
    };
  }
  if (readiness.raced) {
    return { spawned: false, pid: readiness.pid ?? null, raced: true, leaseToken: readiness.token ?? null };
  }
  return { spawned: true, pid: child.pid ?? null, leaseToken: readiness.token ?? null };
}

/** One truth source for user-facing ensure status and exit semantics. */
export function describeEnsureResult(result) {
  if (result?.leaseUnreadable) {
    return {
      ok: false,
      message: `codex-channel startup is blocked by unreadable/invalid lease state at ${result?.lease?.path ?? "locks/codex-channel.lock.json"}; inspect and recover it explicitly`,
    };
  }
  if (result?.teardownPoisoned) {
    return {
      ok: false,
      message: `codex-channel startup is blocked by an unverified prior App Server teardown at `
        + `${result?.poison?.path ?? "locks/codex-channel.teardown-poison.json"}; verify the old process tree is gone and clear the poison explicitly`,
    };
  }
  if (result?.staleVersion) {
    return {
      ok: false,
      message: `codex-channel service pid ${result.pid ?? "?"} remains on an older version; graceful version refresh did not complete`,
    };
  }
  if (result?.unverified) {
    return {
      ok: false,
      message: `codex-channel service pid ${result.pid ?? "?"} holds the lease but ownership could not be verified; refusing split-brain takeover`,
    };
  }
  if (result?.startupFailed) {
    return {
      ok: false,
      message: `codex-channel service pid ${result.pid ?? "?"} failed startup readiness: ${result.reason ?? "no advancing lease heartbeat"}`,
    };
  }
  if (result?.skipped) {
    return { ok: true, message: "codex-channel service ensure skipped (AGENT_BRIDGE_CODEX_NO_ENSURE=1)" };
  }
  if (result?.spawned) {
    return { ok: true, message: `codex-channel service spawned (pid ${result.pid ?? "?"})` };
  }
  return { ok: true, message: `codex-channel service already running (pid ${result?.pid ?? "?"})` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveEnvInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function safeLocalMachineName(env = process.env) {
  try {
    return localMachineName({
      env,
      nameFilePath: machineNameFilePath(env),
      identityPath: identityFilePath(env),
    });
  } catch {
    return "unknown";
  }
}

export const __testing = {
  LEASE_STALE_MS,
  LEASE_HEARTBEAT_MS,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_OWNERSHIP_FRESH_MS,
  LIVE_PROOF_WINDOW_MS,
  sleepSync,
};
