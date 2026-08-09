/**
 * Codex binding registry: stable alias -> persisted Codex thread id.
 *
 * A "binding" is the durable opt-in that makes a Codex task addressable over
 * agent-bridge. Once `codex/release-review` is bound to a thread id, any
 * paired machine can `bridge_send_message({ target: "codex/release-review" })`
 * and the codex-channel service resumes THAT EXACT thread to deliver it.
 *
 * Registry file: `~/.agent-bridge/codex/bindings.json`.
 *
 * CONCURRENCY: every mutation (bind/rebind/unbind/enable/disable) runs under
 * an interprocess lock (`bindings.lock`, atomically hard-link-published,
 * ownership token, recovery election, bounded stale recovery) and re-loads
 * the registry INSIDE the lock before
 * modifying, so parallel processes can never lose each other's successful
 * writes via load-modify-save races. Saves are atomic + durable
 * (temp + fsync + rename).
 *
 * FAIL-CLOSED reads: a registry file that EXISTS but cannot be read aborts
 * mutations (never "treat as empty then clobber good data on save").
 * Corrupt-but-readable bytes are preserved aside (`bindings.json.corrupt-*`)
 * — and only a MUTATION (under the lock) may move them; read-only loads
 * report the corruption without touching the file.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve, win32 } from "node:path";
import { bindingsFilePath, codexStateDir, codexTargetForAlias } from "./paths.js";
import { pidIsAlive, publishExclusiveFile, sleepSync, writeFileDurable } from "./fsutil.js";

export const REGISTRY_VERSION = 1;

/** Sandbox modes accepted per binding. Wire shapes in session.js. */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
/**
 * Approval policies accepted per binding. Codex 0.145 supports
 * untrusted | on-request | granular | never; `granular` needs structured
 * per-rule configuration this surface does not expose, so the supported safe
 * subset here is: never (default) | on-request | untrusted. Legacy registry
 * values outside the set (e.g. the never-valid "on-failure") are migrated to
 * the safe default on load.
 */
export const APPROVAL_POLICIES = ["never", "on-request", "untrusted"];

export const DEFAULT_POLICY = Object.freeze({
  steering: false,
  ownershipGuard: true,
  approvalPolicy: "never",
  sandbox: "workspace-write",
  turnTimeoutMs: null,
});

// Codex aliases become directory names on every fleet filesystem. Restrict
// this binding surface to portable ASCII so APFS/NTFS Unicode case-fold and
// normalization equivalences can never make two registry keys share storage.
const ALIAS_SEGMENT_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED_ALIAS_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

// ── Interprocess registry lock ───────────────────────────────────────────────

const LOCK_RETRY_MS = 15;
// Registry writes fsync both file and directory. A burst of independent CLI
// binds therefore serializes real durable I/O; five seconds was too short for
// 24 legitimate contenders on a loaded host. Keep acquisition bounded while
// allowing that queue to drain.
const LOCK_TIMEOUT_MS = 15_000;
/** A lock this old with a dead owner (or 3x this old regardless) is stale. */
const LOCK_STALE_MS = 10_000;

function registryLockPath(env) {
  return join(codexStateDir(env), "bindings.lock");
}

function readLockFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return { pid: null, token: null, startedAt: 0, unreadable: true, error: "invalid lock record" };
    }
    return {
      pid: Number(parsed.pid),
      token: typeof parsed.token === "string" ? parsed.token : null,
      startedAt: Number(parsed.startedAt) || 0,
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

function lockIsStale(path, lock, nowMs) {
  let ageMs = nowMs - (lock?.startedAt || 0);
  try {
    ageMs = Math.min(ageMs, nowMs - statSync(path).mtimeMs);
  } catch {
    return false; // unknown visible state is a fence, never proof of staleness
  }
  if (ageMs < LOCK_STALE_MS) return false; // young locks are NEVER stolen
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (!pidIsAlive(lock.pid)) return true;
  // A suspended live owner may resume inside its critical section. Never
  // steal from a live PID: doing so would let both writers commit.
  return false;
}

/**
 * Acquire the registry mutation lock (synchronous, bounded). Returns an
 * ownership record for release. Throws after LOCK_TIMEOUT_MS.
 */
export function acquireRegistryLock({ env = process.env, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const path = registryLockPath(env);
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
        `codex bindings registry ${recovering ? "stale-lock recovery" : "is locked"} by pid `
        + `${existing?.pid ?? "?"} (${recovering ? recoveryPath : path}); retry shortly or investigate a wedged process`,
      );
    }
    sleepSync(LOCK_RETRY_MS);
  };
  const releaseIfToken = (lockPath, ownedToken) => {
    const current = readLockFile(lockPath);
    if (current?.token === ownedToken) {
      try { unlinkSync(lockPath); } catch { /* fail closed on a later acquisition */ }
    }
  };
  for (;;) {
    // A stale-lock recovery temporarily owns this election path. Every normal
    // contender checks it both before and after publishing so a process that
    // raced the election cannot occupy the removal/publish gap.
    const recovery = readLockFile(recoveryPath);
    if (recovery) {
      waitOrThrow(recovery, true);
      continue;
    }
    try {
      publishExclusiveFile(path, JSON.stringify(owner));
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const existing = readLockFile(path);
      if (lockIsStale(path, existing, Date.now())) {
        let recoveryOwned = false;
        try {
          publishExclusiveFile(recoveryPath, JSON.stringify(recoveryOwner));
          recoveryOwned = true;
        } catch (recoveryError) {
          if (recoveryError?.code !== "EEXIST") throw recoveryError;
          waitOrThrow(readLockFile(recoveryPath), true);
        }
        if (!recoveryOwned) continue;
        try {
          // Re-read under the recovery election. A normal contender may have
          // acquired just before the election became visible; never move it.
          const current = readLockFile(path);
          if (!lockIsStale(path, current, Date.now())) continue;
          const aside = `${path}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
          renameSync(path, aside);
          try { unlinkSync(aside); } catch { /* forensic leftover is harmless */ }

          // A contender that passed the pre-election check can still publish
          // in this small gap, but its mandatory post-publication check makes
          // it release. Wait under the election until our publication wins.
          for (;;) {
            try {
              publishExclusiveFile(path, JSON.stringify(owner));
              return { path, token };
            } catch (publishError) {
              if (publishError?.code !== "EEXIST") throw publishError;
              waitOrThrow(readLockFile(path));
            }
          }
        } finally {
          releaseIfToken(recoveryPath, recoveryToken);
        }
      }
      if (!lockIsStale(path, existing, Date.now())) {
        waitOrThrow(existing);
      }
      continue;
    }

    const recoveryAfterPublish = readLockFile(recoveryPath);
    if (recoveryAfterPublish) {
      releaseIfToken(path, token);
      waitOrThrow(recoveryAfterPublish, true);
      continue;
    }
    return { path, token };
  }
}

export function releaseRegistryLock(lock) {
  if (!lock) return;
  const current = readLockFile(lock.path);
  if (current?.token === lock.token) {
    try { unlinkSync(lock.path); } catch { /* ignore */ }
  }
}

/** Run `fn` with the registry mutation lock held. */
export function withRegistryLock(fn, { env = process.env, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lock = acquireRegistryLock({ env, timeoutMs });
  try {
    return fn();
  } finally {
    releaseRegistryLock(lock);
  }
}

// ── Validation / sanitization ────────────────────────────────────────────────

/**
 * Alias grammar: ONE portable ASCII path segment (the target becomes
 * `codex/<alias>` and the alias becomes an inbox subdir name).
 */
export function isValidAlias(alias) {
  if (typeof alias !== "string" || !alias) return false;
  if (alias.length > 128) return false;
  if (alias !== alias.normalize("NFC")) return false;
  if (alias.includes("/") || alias.includes("\\")) return false;
  if (alias.includes("..")) return false;
  if (WINDOWS_RESERVED_ALIAS_RE.test(alias)) return false;
  return ALIAS_SEGMENT_RE.test(alias);
}

/** Filesystem identity used to prevent case-insensitive alias collisions. */
export function aliasFilesystemKey(alias) {
  return String(alias).normalize("NFC").toLocaleLowerCase("en-US");
}

export function isValidThreadId(threadId) {
  return typeof threadId === "string" && THREAD_ID_RE.test(threadId);
}

export function normalizeThreadId(threadId) {
  return String(threadId).trim().toLowerCase();
}

function windowsPathComparable(path) {
  let normalized = win32.normalize(String(path).trim());
  // realpath on Windows may return an extended-length drive path. Compare it
  // to ordinary drive-form policy roots without weakening UNC handling.
  if (/^\\\\\?\\[A-Za-z]:\\/.test(normalized)) normalized = normalized.slice(4);
  return normalized.replace(/[\\]+$/, "").toLocaleLowerCase("en-US");
}

/**
 * Host-independent exact-root policy for broad Windows workspace roots.
 * Keeping this pure lets Unix CI exercise Windows path spelling/casing rules.
 */
export function isBroadWindowsWorkspaceRoot(path, { env = process.env } = {}) {
  if (typeof path !== "string" || !path.trim()) return false;
  const comparable = windowsPathComparable(path);
  if (/^[a-z]:\\(?:users|windows|program files(?: \(x86\))?|programdata)$/i.test(comparable)) {
    return true;
  }
  const configuredRoots = [
    env.SystemRoot,
    env.SYSTEMROOT,
    env.ProgramData,
    env.PROGRAMDATA,
    env.ProgramFiles,
    env.PROGRAMFILES,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
    env.USERPROFILE ? win32.dirname(win32.normalize(env.USERPROFILE)) : null,
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  return configuredRoots.some((candidate) => windowsPathComparable(candidate) === comparable);
}

function addNativeBroadRoot(set, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return;
  set.add(normalize(candidate));
  try {
    const canonical = realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
    set.add(normalize(canonical));
  } catch {
    // Some platform-specific literals do not exist on this host. Retaining
    // their literal form still protects any matching path spelling.
  }
}

/**
 * Canonicalize a binding cwd and reject roots that would turn
 * workspace-write into effectively whole-machine access. There is no broad
 * root consent surface on MCP, so unsafe roots fail closed for every binder.
 */
export function normalizeBindingCwd(cwd, { env = process.env } = {}) {
  if (cwd === null || cwd === undefined || cwd === "") return null;
  if (typeof cwd !== "string") throw new Error("cwd must be an absolute existing directory");
  const raw = cwd.trim();
  const windowsAbsolute = win32.isAbsolute(raw);
  if (!isAbsolute(raw) && !windowsAbsolute) {
    throw new Error(`cwd must be an absolute existing directory; got ${JSON.stringify(cwd)}`);
  }
  // Reject Windows drive/UNC share roots even when validation runs on Unix.
  const winNormalized = win32.normalize(raw);
  if (/^[A-Za-z]:\\$/.test(winNormalized)
    || /^\\\\[^\\]+\\[^\\]+\\?$/.test(winNormalized)) {
    throw new Error(`cwd ${JSON.stringify(cwd)} is a filesystem root; broad workspace-write roots are refused`);
  }
  if (isBroadWindowsWorkspaceRoot(raw, { env })) {
    throw new Error(`cwd ${JSON.stringify(cwd)} is a broad Windows root; choose a project subdirectory`);
  }
  let canonical;
  try {
    canonical = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw);
  } catch (err) {
    throw new Error(`cwd must be an existing directory: ${raw} (${String(err?.code ?? err?.message ?? err)})`);
  }
  let stat;
  try { stat = statSync(canonical); } catch (err) {
    throw new Error(`cwd cannot be inspected: ${canonical} (${String(err?.code ?? err?.message ?? err)})`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd must be a directory: ${canonical}`);
  const normalized = normalize(canonical);
  if (normalized === parse(normalized).root) {
    throw new Error(`cwd ${JSON.stringify(cwd)} resolves to a filesystem root; broad workspace-write roots are refused`);
  }
  if (isBroadWindowsWorkspaceRoot(canonical, { env })) {
    throw new Error(`cwd ${JSON.stringify(cwd)} resolves to broad Windows root ${canonical}; choose a project subdirectory`);
  }
  const homeCandidate = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const broadRootCandidates = [
    homeCandidate,
    resolve(homeCandidate),
    "/Users", "/home", "/tmp", "/var", "/etc", "/usr", "/opt", "/Applications", "/Library", "/System", "/Volumes",
  ];
  const broadRoots = new Set();
  for (const candidate of broadRootCandidates) addNativeBroadRoot(broadRoots, candidate);
  if (broadRoots.has(normalized)) {
    throw new Error(`cwd ${JSON.stringify(cwd)} resolves to broad root ${canonical}; choose a project subdirectory`);
  }
  return canonical;
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, bindings: {} };
}

function sanitizePolicy(raw) {
  const policy = { ...DEFAULT_POLICY };
  if (!raw || typeof raw !== "object") return policy;
  if (typeof raw.steering === "boolean") policy.steering = raw.steering;
  if (typeof raw.ownershipGuard === "boolean") policy.ownershipGuard = raw.ownershipGuard;
  // Values outside the supported set (including legacy "on-failure", which
  // Codex 0.145 does not accept) migrate to the safe default.
  if (APPROVAL_POLICIES.includes(raw.approvalPolicy)) policy.approvalPolicy = raw.approvalPolicy;
  if (SANDBOX_MODES.includes(raw.sandbox)) policy.sandbox = raw.sandbox;
  const t = Number(raw.turnTimeoutMs);
  if (Number.isFinite(t) && t > 0) policy.turnTimeoutMs = Math.floor(t);
  return policy;
}

function sanitizeBinding(raw, env) {
  if (!raw || typeof raw !== "object") return null;
  if (!isValidAlias(raw.alias)) return null;
  if (!isValidThreadId(raw.threadId)) return null;
  let cwd = null;
  let invalidCwd = typeof raw.invalidCwd === "string" ? raw.invalidCwd : null;
  if (typeof raw.cwd === "string" && raw.cwd) {
    try {
      cwd = normalizeBindingCwd(raw.cwd, { env });
      invalidCwd = null;
    } catch {
      invalidCwd = raw.cwd;
    }
  }
  return {
    alias: raw.alias,
    threadId: normalizeThreadId(raw.threadId),
    cwd,
    enabled: raw.enabled !== false && invalidCwd === null,
    ...(invalidCwd ? { invalidCwd } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    boundBy: typeof raw.boundBy === "string" ? raw.boundBy : "unknown",
    policy: sanitizePolicy(raw.policy),
  };
}

// ── Load / save ──────────────────────────────────────────────────────────────

/**
 * Load the registry.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.forMutation]  when true (mutators, under the lock):
 *    - an EXISTING but UNREADABLE file THROWS (fail closed — never clobber),
 *    - corrupt bytes are preserved aside so the mutation can proceed.
 *  when false (read-only callers): no side effects; corruption/read errors
 *  are reported via flags and an empty view is returned.
 * @returns {{ registry: object, corruptMovedTo: string|null, corruptDetected: boolean, readError: string|null }}
 */
export function loadRegistry({ env = process.env, forMutation = false } = {}) {
  const path = bindingsFilePath(env);
  if (!existsSync(path)) {
    return { registry: emptyRegistry(), corruptMovedTo: null, corruptDetected: false, readError: null };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const readError = String(err?.message ?? err);
    if (forMutation) {
      throw new Error(`codex bindings registry exists but is unreadable (${readError}); refusing to overwrite it`);
    }
    return { registry: emptyRegistry(), corruptMovedTo: null, corruptDetected: false, readError };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.bindings !== "object" || parsed.bindings === null) {
      throw new Error("bindings registry missing bindings map");
    }
  } catch {
    if (!forMutation) {
      // Read-only: report, never mutate the on-disk corrupt bytes.
      return { registry: emptyRegistry(), corruptMovedTo: null, corruptDetected: true, readError: null };
    }
    // Mutation path (lock held): preserve the bytes for manual recovery,
    // then start fresh for this mutation.
    const corruptPath = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corruptPath);
      return { registry: emptyRegistry(), corruptMovedTo: corruptPath, corruptDetected: true, readError: null };
    } catch (err) {
      throw new Error(
        `codex bindings registry is corrupt and could not be preserved aside (${String(err?.message ?? err)}); refusing to overwrite it`,
      );
    }
  }
  const registry = emptyRegistry();
  const filesystemKeys = new Set();
  for (const [alias, binding] of Object.entries(parsed.bindings)) {
    const clean = sanitizeBinding({ ...binding, alias: binding?.alias ?? alias }, env);
    if (!clean || clean.alias !== alias) continue;
    const filesystemKey = aliasFilesystemKey(alias);
    if (filesystemKeys.has(filesystemKey)) continue;
    filesystemKeys.add(filesystemKey);
    registry.bindings[alias] = clean;
  }
  return { registry, corruptMovedTo: null, corruptDetected: false, readError: null };
}

/** Atomic + durable save. Callers must hold the registry lock for mutations. */
export function saveRegistry(registry, { env = process.env } = {}) {
  const path = bindingsFilePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: REGISTRY_VERSION, bindings: registry.bindings }, null, 2);
  writeFileDurable(path, `${body}\n`);
}

// ── Mutations (all lock-guarded, reload-inside-lock) ─────────────────────────

/**
 * Bind (or rebind) an alias to a thread id.
 *
 * Rules:
 *  - alias + threadId must validate.
 *  - binding a NEW alias whose threadId is already bound to another alias is
 *    rejected unless `allowSharedThread` (double-delivery footgun).
 *  - re-binding an EXISTING alias requires `rebind: true` (explicit intent).
 *
 * @returns {{ binding: object, replaced: object|null }}
 */
export function bindAlias({
  alias,
  threadId,
  cwd = null,
  boundBy = "cli",
  policy = {},
  rebind = false,
  allowSharedThread = false,
  allowDanger = false,
  env = process.env,
}) {
  if (!isValidAlias(alias)) {
    throw new Error(
      `Invalid alias ${JSON.stringify(alias)}. Aliases are a single path segment `
      + `(ASCII letters/digits/_ start+end; ASCII letters/digits/_ . - inside), e.g. "release-review".`,
    );
  }
  const normalizedThreadId = normalizeThreadId(threadId ?? "");
  if (!isValidThreadId(normalizedThreadId)) {
    throw new Error(
      `Invalid Codex thread id ${JSON.stringify(threadId ?? null)}. Expected a UUID `
      + `(pass --thread-id explicitly, or run this inside a Codex task shell where CODEX_THREAD_ID is set).`,
    );
  }
  if (policy && policy.approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(policy.approvalPolicy)) {
    throw new Error(
      `approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")} `
      + `(Codex "granular" needs per-rule config this surface does not expose; legacy "on-failure" is not a Codex 0.145 policy).`,
    );
  }
  const canonicalCwd = cwd === null || cwd === undefined || cwd === ""
    ? null
    : normalizeBindingCwd(cwd, { env });

  return withRegistryLock(() => {
    const { registry } = loadRegistry({ env, forMutation: true });
    const existing = registry.bindings[alias] ?? null;
    const aliasKey = aliasFilesystemKey(alias);
    const collidingAlias = Object.keys(registry.bindings)
      .find((otherAlias) => otherAlias !== alias && aliasFilesystemKey(otherAlias) === aliasKey);
    if (collidingAlias) {
      throw new Error(
        `Alias ${JSON.stringify(alias)} collides with existing alias ${JSON.stringify(collidingAlias)} `
        + "on case-insensitive filesystems; choose a distinct alias.",
      );
    }
    if (existing?.invalidCwd && canonicalCwd === null) {
      throw new Error(
        `Alias "${alias}" has an unsafe/invalid persisted cwd ${JSON.stringify(existing.invalidCwd)}. `
        + "Rebind with --cwd pointing to an existing project subdirectory.",
      );
    }
    if (existing && !rebind) {
      throw new Error(
        `Alias "${alias}" is already bound to thread ${existing.threadId}. `
        + `Use \`agent-bridge codex rebind ${alias} --thread-id <id>\` to move it.`,
      );
    }
    for (const other of Object.values(registry.bindings)) {
      if (other.alias !== alias && other.threadId === normalizedThreadId && !allowSharedThread) {
        throw new Error(
          `Thread ${normalizedThreadId} is already bound to alias "${other.alias}". `
          + `Two aliases delivering into one thread double-inject turns; pass --allow-shared-thread only if that is intended.`,
        );
      }
    }

    const now = new Date().toISOString();
    const inheritedCwd = canonicalCwd === null && existing?.cwd
      ? normalizeBindingCwd(existing.cwd, { env })
      : null;
    const effectivePolicy = sanitizePolicy({ ...(existing?.policy ?? {}), ...policy });
    if (effectivePolicy.sandbox === "danger-full-access" && allowDanger !== true) {
      throw new Error(
        "effective sandbox=danger-full-access requires explicit --allow-danger consent "
        + "(including when rebind inherits it from the existing alias)",
      );
    }
    const binding = {
      alias,
      threadId: normalizedThreadId,
      cwd: canonicalCwd ?? inheritedCwd,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      boundBy,
      policy: effectivePolicy,
    };
    registry.bindings[alias] = binding;
    saveRegistry(registry, { env });
    return { binding, replaced: existing };
  }, { env });
}

/** Remove a binding. Returns the removed binding or null. */
export function unbindAlias(alias, { env = process.env } = {}) {
  return withRegistryLock(() => {
    const { registry } = loadRegistry({ env, forMutation: true });
    const existing = registry.bindings[alias] ?? null;
    if (!existing) return null;
    delete registry.bindings[alias];
    saveRegistry(registry, { env });
    return existing;
  }, { env });
}

/** Enable/disable a binding without deleting it. Returns updated binding or null. */
export function setBindingEnabled(alias, enabled, { env = process.env } = {}) {
  return withRegistryLock(() => {
    const { registry } = loadRegistry({ env, forMutation: true });
    const existing = registry.bindings[alias];
    if (!existing) return null;
    existing.enabled = enabled === true;
    existing.updatedAt = new Date().toISOString();
    saveRegistry(registry, { env });
    return existing;
  }, { env });
}

// ── Read-only accessors (no locks, no side effects) ──────────────────────────

export function getBinding(alias, { env = process.env } = {}) {
  const { registry } = loadRegistry({ env });
  return registry.bindings[alias] ?? null;
}

/** All bindings, sorted by alias. */
export function listBindings({ env = process.env } = {}) {
  const { registry } = loadRegistry({ env });
  return Object.values(registry.bindings).sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Enabled bindings only (the set the service watches). */
export function listEnabledBindings({ env = process.env } = {}) {
  return listBindings({ env }).filter((b) => b.enabled);
}

export { codexTargetForAlias };
