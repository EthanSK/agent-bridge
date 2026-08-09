/**
 * Durable per-alias delivery pipeline: inbox scan -> claim -> turn delivery,
 * with crash/replay safety.
 *
 * State machine (durable via `<id>.meta.json` sidecars in
 * `inbox/.pending-ack/codex/<alias>/`, every write atomic + fsynced):
 *
 *   [inbox file]
 *      │ claim = atomic rename into .pending-ack (the rename IS the exclusive
 *      │         claim; a loser of the race sees ENOENT and skips) followed
 *      │         IMMEDIATELY by a durable `staged` meta. If the meta cannot
 *      │         be written durably the file is UN-claimed (renamed back) so
 *      │         a claimed file without meta can only mean lost/tampered
 *      │         metadata — which reconcile treats as INDETERMINATE.
 *      ▼
 *   staged ──────────────► turn_starting ──► delivered (meta first, then
 *      ▲   attempt when         │            ledger + archive + meta unlink)
 *      │   session idle;        │   turn/start success
 *      │   the durable          │
 *      │   turn_starting        │ rpc outcome unknown (timeout/conn-drop)
 *      │   write MUST           ▼
 *      │   succeed BEFORE  INDETERMINATE — never automatically re-sent. The
 *      │   any send        next available session probes structural thread
 *      │                   history for the unique clientUserMessageId:
 *      └── bounded probe   found -> delivered; absent/unavailable after
 *          window          bounded probes -> explicit indeterminate dead
 *                          letter (.failed/.exhausted/) plus a separate
 *                          immutable possibly-sent id tombstone. Absence is
 *                          not permission to risk a second turn or replay.
 *
 * Finalize hardening: `delivered` is itself a durable meta state written
 * BEFORE archive/ledger side effects, so a crash mid-finalize reconciles by
 * completing the finalize — it can never reopen redelivery.
 *
 * Ordering is STRICT FIFO per alias by (timestamp, id): a backoff-parked
 * head is waited for, never bypassed (head-of-line is bounded — every
 * failure path caps at MAX_ATTEMPTS / MAX_PROBE_FAILURES and dead-letters).
 * Resendable `staged` work is TTL-checked again immediately before sending;
 * indeterminate states never use TTL as a shortcut around history probing.
 *
 * Hostile-envelope guards happen BEFORE parsing: lstat (regular files only,
 * symlinks quarantined unread), total file-size cap, then the shared
 * envelope validation (target/id/fromTarget grammar, content cap, finite
 * timestamp).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileDurable } from "./fsutil.js";
import {
  codexArchiveDir,
  codexFailedDir,
  codexInboxDir,
  codexPendingAckDir,
  deliveredLedgerPath,
  deliveredTombstonesDir,
  exhaustedDir,
} from "./paths.js";
import {
  composeTurnInputText,
  isExpired,
  isSafeMessageId,
  MAX_CONTENT_BYTES,
  validateInboundForAlias,
} from "./envelope.js";
import { isDispatchFenced, isRpcRejection } from "./session.js";

/**
 * Attempt budget: 4 total attempts = 3 retry delays (5s / 30s / 120s), then
 * dead-letter on the 4th failure — every documented delay is reachable.
 */
export const MAX_ATTEMPTS = 4;
export const MAX_PROBE_FAILURES = 3;
export const ATTEMPT_BACKOFF_MS = [5_000, 30_000, 120_000];
/** Backoff between indeterminate-dedupe probes (late acceptance window). */
export const PROBE_BACKOFF_MS = 5_000;
/** Hard cap on an inbox FILE before we even read it (content cap + slack). */
export const MAX_ENVELOPE_FILE_BYTES = MAX_CONTENT_BYTES + 64 * 1024;

const META_STATES = new Set(["staged", "turn_starting", "steering", "turn_active", "delivered", "dead_lettering"]);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export { writeFileDurable };

// ── Delivered-id ledger ──────────────────────────────────────────────────────

export class CodexLedgerStateError extends Error {
  constructor(message, { path = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexLedgerStateError";
    this.path = path;
  }
}

function ledgerStateError(message, path, cause = null) {
  return new CodexLedgerStateError(`${message}${path ? `: ${path}` : ""}`, { path, cause });
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function loadLegacyLedger(env) {
  const set = new Set();
  const path = deliveredLedgerPath(env);
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const id = line.trim();
      if (!id) continue;
      if (!isSafeMessageId(id)) {
        throw ledgerStateError("Malformed delivered id in legacy ledger", path);
      }
      set.add(id);
    }
  } catch (error) {
    if (!isMissing(error)) {
      if (error instanceof CodexLedgerStateError) throw error;
      throw ledgerStateError("Unable to read retained legacy delivery state", path, error);
    }
  }

  return set;
}

function loadTombstoneTree(root, kind, { allowIndeterminateRoot = false } = {}) {
  const set = new Set();
  let shards;
  try {
    shards = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return set;
    throw ledgerStateError(`Unable to enumerate retained ${kind} state`, root, error);
  }

  for (const shard of shards) {
    if (allowIndeterminateRoot && shard.name === "_indeterminate") {
      if (!shard.isDirectory()) {
        throw ledgerStateError("Indeterminate tombstone root is not a directory", join(root, shard.name));
      }
      continue;
    }
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) {
      throw ledgerStateError(`Unexpected entry in ${kind} tombstone root`, join(root, shard.name));
    }
    const shardDir = join(root, shard.name);
    let entries;
    try {
      entries = readdirSync(shardDir, { withFileTypes: true });
    } catch (error) {
      throw ledgerStateError(`Unable to enumerate ${kind} tombstone shard`, shardDir, error);
    }
    for (const entry of entries) {
      const tombstonePath = join(shardDir, entry.name);
      if (!entry.isFile() || !/^[0-9a-f]{64}\.id$/.test(entry.name)) {
        throw ledgerStateError(`Unexpected entry in ${kind} tombstone shard`, tombstonePath);
      }
      let raw;
      try {
        raw = readFileSync(tombstonePath, "utf8");
      } catch (error) {
        throw ledgerStateError(`Unable to read ${kind} tombstone`, tombstonePath, error);
      }
      const deliveredId = raw.trim();
      if (!deliveredId || !isSafeMessageId(deliveredId)) {
        throw ledgerStateError(`Malformed ${kind} tombstone`, tombstonePath);
      }
      const expectedHash = createHash("sha256").update(deliveredId, "utf8").digest("hex");
      if (entry.name !== `${expectedHash}.id` || shard.name !== expectedHash.slice(0, 2)) {
        throw ledgerStateError(`${kind} tombstone identity does not match its path`, tombstonePath);
      }
      if (raw !== deliveredId && raw !== `${deliveredId}\n` && raw !== `${deliveredId}\r\n`) {
        throw ledgerStateError(`Malformed ${kind} tombstone bytes`, tombstonePath);
      }
      set.add(deliveredId);
    }
  }
  return set;
}

/**
 * Load both terminal-id sets in one fail-closed snapshot. One missing,
 * unreadable, malformed, or identity-mismatched retained tombstone could
 * otherwise permit a duplicate turn, so only ENOENT for a not-yet-created
 * tree is treated as empty.
 */
export function loadRetainedDeliveryState(env = process.env) {
  const delivered = loadLegacyLedger(env);
  const root = deliveredTombstonesDir(env);
  for (const id of loadTombstoneTree(root, "delivered", { allowIndeterminateRoot: true })) {
    delivered.add(id);
  }
  const indeterminate = loadTombstoneTree(join(root, "_indeterminate"), "indeterminate");
  return { delivered, indeterminate };
}

export function loadLedger(env = process.env) {
  return loadRetainedDeliveryState(env).delivered;
}

export function loadIndeterminateLedger(env = process.env) {
  return loadRetainedDeliveryState(env).indeterminate;
}

export function deliveredTombstonePath(id, env = process.env) {
  const hash = createHash("sha256").update(String(id), "utf8").digest("hex");
  return join(deliveredTombstonesDir(env), hash.slice(0, 2), `${hash}.id`);
}

export function appendLedger(id, ledger, env = process.env) {
  if (ledger.has(id)) return; // idempotent — no duplicate ledger lines
  const path = deliveredTombstonePath(id, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Publish the immutable id tombstone atomically and fsync it BEFORE the
  // staged message can be archived. Failure is actionable: callers retain
  // the delivered meta + staged message and retry finalization without ever
  // issuing another turn RPC.
  writeFileDurable(path, `${id}\n`);
  ledger.add(id);
}

// ── Possibly-sent terminal tombstones ──────────────────────────────────────

/**
 * Separate from delivered tombstones: this id was possibly sent, could not be
 * proven present, and was terminally dead-lettered under the at-most-once
 * policy. It must never be submitted again automatically, but it must not be
 * reported as delivered either.
 */
export function indeterminateTombstonePath(id, env = process.env) {
  const hash = createHash("sha256").update(String(id), "utf8").digest("hex");
  return join(deliveredTombstonesDir(env), "_indeterminate", hash.slice(0, 2), `${hash}.id`);
}

export function hasIndeterminateTombstone(id, env = process.env, retained = null) {
  return (retained ?? loadIndeterminateLedger(env)).has(id);
}

export function persistIndeterminateTombstone(id, env = process.env) {
  const path = indeterminateTombstonePath(id, env);
  if (existsSync(path)) {
    if (!loadIndeterminateLedger(env).has(id)) {
      throw ledgerStateError("Existing indeterminate tombstone did not validate", path);
    }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The file is never removed or compacted. Concurrent identical writes are
  // harmless because the hashed path and body are deterministic for the id.
  writeFileDurable(path, `${id}\n`);
  return path;
}

// ── Per-alias durable queue ──────────────────────────────────────────────────

export class AliasDelivery {
  /**
   * @param {object} params
   * @param {object} params.binding
   * @param {object} params.env
   * @param {function} params.logEvent
   * @param {string} params.localMachine
   * @param {string} params.channelVersion
   * @param {Set<string>} params.ledger      shared delivered-id ledger
   */
  constructor({
    binding,
    env = process.env,
    logEvent,
    localMachine,
    channelVersion,
    ledger,
    indeterminateLedger = null,
    appendLedgerImpl = appendLedger,
    sendFence = () => true,
    deadLetterMove = renameSync,
    stagingReadDir = readdirSync,
    stagedRead = readFileSync,
    stagedLstat = lstatSync,
  }) {
    this.binding = binding;
    this.env = env;
    this.logEvent = logEvent;
    this.localMachine = localMachine;
    this.channelVersion = channelVersion;
    this.ledger = ledger;
    this.indeterminateLedger = indeterminateLedger ?? loadIndeterminateLedger(env);
    this.appendLedgerImpl = appendLedgerImpl;
    this.sendFence = sendFence;
    this.deadLetterMove = deadLetterMove;
    this.stagingReadDir = stagingReadDir;
    this.stagedRead = stagedRead;
    this.stagedLstat = stagedLstat;
    this.alias = binding.alias;
    this.inboxDir = codexInboxDir(this.alias, env);
    this.stagingDir = codexPendingAckDir(this.alias, env);
    this.archiveDir = codexArchiveDir(this.alias, env);
    this.failedDir = codexFailedDir(this.alias, env);
    /** @type {Map<string, object>} id -> entry {id, message, meta, needsProbe} */
    this.queue = new Map();
    this.inFlight = false;
    this.reconciled = false;
    /** turnId -> msg id for terminal turn-outcome attribution (bounded). */
    this.recentTurnMessages = new Map();
    this.ensureDirs();
  }

  ensureDirs() {
    for (const dir of [this.inboxDir, this.stagingDir, this.archiveDir, this.failedDir, exhaustedDir(this.env)]) {
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
    }
  }

  metaPath(id) {
    return join(this.stagingDir, `${id}.meta.json`);
  }

  stagedPath(id) {
    return join(this.stagingDir, `${id}.json`);
  }

  readMeta(id, { strictIo = false } = {}) {
    try {
      const raw = readFileSync(this.metaPath(id), "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || parsed.id !== id) return null;
      if (!META_STATES.has(parsed.state)) return null;
      return {
        id,
        state: parsed.state,
        attempts: Number.isInteger(parsed.attempts) && parsed.attempts >= 0 ? parsed.attempts : 0,
        probeFailures: Number.isInteger(parsed.probeFailures) && parsed.probeFailures >= 0 ? parsed.probeFailures : 0,
        nextAttemptAt: Number.isFinite(parsed.nextAttemptAt) ? parsed.nextAttemptAt : 0,
        turnId: typeof parsed.turnId === "string" ? parsed.turnId : null,
        deadLetterReason: typeof parsed.deadLetterReason === "string" ? parsed.deadLetterReason : null,
        // Old sidecars predate this field. The two indeterminate wire states
        // themselves are sufficient evidence that a send may have happened.
        possiblySent: parsed.possiblySent === true
          || parsed.state === "turn_starting"
          || parsed.state === "steering"
          || (parsed.state === "dead_lettering" && /^indeterminate_/.test(parsed.deadLetterReason ?? "")),
        stagedAt: typeof parsed.stagedAt === "string" ? parsed.stagedAt : new Date().toISOString(),
      };
    } catch (error) {
      if (strictIo && error?.code && error.code !== "ENOENT") throw error;
      return null;
    }
  }

  /**
   * Durable meta write. THROWS on failure — callers that gate protocol sends
   * on durable state must treat a throw as "do not send".
   */
  writeMeta(meta) {
    const body = JSON.stringify({
      id: meta.id,
      alias: this.alias,
      state: meta.state,
      attempts: meta.attempts,
      probeFailures: meta.probeFailures ?? 0,
      nextAttemptAt: meta.nextAttemptAt ?? 0,
      turnId: meta.turnId ?? null,
      deadLetterReason: meta.deadLetterReason ?? null,
      possiblySent: meta.possiblySent === true,
      stagedAt: meta.stagedAt,
      channelVersion: this.channelVersion,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    writeFileDurable(this.metaPath(meta.id), body);
  }

  quarantine(filePath, reason) {
    const name = basename(filePath);
    try {
      mkdirSync(this.failedDir, { recursive: true, mode: 0o700 });
      renameSync(filePath, join(this.failedDir, name));
    } catch {
      try { renameSync(filePath, `${filePath}.bad`); } catch { /* ignore */ }
    }
    this.logEvent("warn", "codex.quarantined", `Quarantined ${name}: ${reason}`, {
      alias: this.alias,
      file: name,
      reason,
    });
  }

  /** @returns {boolean} whether the archive rename succeeded */
  archiveDelivered(fromPath, id) {
    try {
      mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
      renameSync(fromPath, join(this.archiveDir, `${stamp()}_${basename(fromPath)}`));
      return true;
    } catch (err) {
      this.logEvent("warn", "codex.archive_failed", `Failed to archive ${id}: ${String(err?.message ?? err)}`, {
        alias: this.alias,
        msg_id: id,
      });
      return false;
    }
  }

  /**
   * Pre-read hostile-file guard. Returns an error string (=> quarantine) or
   * null when the file looks safe to read.
   */
  _fileGuard(filePath, { strictIo = false } = {}) {
    let st;
    try {
      st = strictIo ? this.stagedLstat(filePath) : lstatSync(filePath);
    } catch (error) {
      if (strictIo && error?.code !== "ENOENT") throw error;
      return null; // vanished — raced consumer; caller skips on read failure
    }
    if (!st.isFile()) return "not a regular file (symlink or special file rejected)";
    if (st.size > MAX_ENVELOPE_FILE_BYTES) return `file exceeds ${MAX_ENVELOPE_FILE_BYTES} bytes`;
    return null;
  }

  /**
   * Startup reconciliation over the staging dir.
   *
   * - `delivered` meta: a crash interrupted finalize — complete it (ledger +
   *   archive + meta unlink), never re-deliver.
   * - `turn_active`: turn/start had succeeded — finalize as delivered.
   * - `staged`: re-adopt the claim with its attempts/backoff intact.
   * - `turn_starting`/`steering`: INDETERMINATE — probe before any resend.
   * - MISSING or CORRUPT meta for a claimed file: also INDETERMINATE (the
   *   claim path writes meta durably before any send, so absence can only
   *   mean lost/tampered metadata — never assume "safe staged").
   */
  reconcile() {
    this.reconciled = false;
    let entries = [];
    try {
      entries = this.stagingReadDir(this.stagingDir);
    } catch (error) {
      throw new Error(`cannot reconcile Codex staging directory ${this.stagingDir}: ${String(error?.message ?? error)}`, { cause: error });
    }
    const files = new Set(entries.filter((n) => n.endsWith(".json") && !n.endsWith(".meta.json")));
    const metas = new Set(entries.filter((n) => n.endsWith(".meta.json")));

    for (const fileName of files) {
      const id = fileName.slice(0, -".json".length);
      const stagedFile = this.stagedPath(id);
      let meta = this.readMeta(id, { strictIo: true });
      const guardError = this._fileGuard(stagedFile, { strictIo: true });
      if (guardError) {
        if (meta?.possiblySent) {
          persistIndeterminateTombstone(id, this.env);
          this.indeterminateLedger.add(id);
        }
        this.quarantine(stagedFile, `reconcile: ${guardError}`);
        try { unlinkSync(this.metaPath(id)); } catch { /* ignore */ }
        continue;
      }
      let raw;
      try {
        raw = this.stagedRead(stagedFile, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new Error(`cannot read staged Codex message ${stagedFile}: ${String(error?.message ?? error)}`, { cause: error });
      }
      const validated = validateInboundForAlias(raw, this.alias);
      if (!validated.message) {
        if (meta?.possiblySent) {
          persistIndeterminateTombstone(id, this.env);
          this.indeterminateLedger.add(id);
        }
        this.quarantine(stagedFile, `reconcile: ${validated.error}`);
        try { unlinkSync(this.metaPath(id)); } catch { /* ignore */ }
        continue;
      }
      if (validated.message.id !== id) {
        if (meta?.possiblySent) {
          persistIndeterminateTombstone(id, this.env);
          this.indeterminateLedger.add(id);
        }
        this.quarantine(stagedFile, "reconcile: body id does not match staged filename");
        try { unlinkSync(this.metaPath(id)); } catch { /* ignore */ }
        continue;
      }
      const terminalDuplicate = this.indeterminateLedger.has(validated.message.id);
      const recoveringOriginalDeadLetter = terminalDuplicate
        && validated.message.id === id
        && meta?.state === "dead_lettering";
      if (terminalDuplicate && !recoveringOriginalDeadLetter) {
        // Check the validated body id, not the staging filename: a replay may
        // arrive under any filename and must not bypass the id tombstone.
        this.quarantine(stagedFile, "indeterminate_terminal_tombstone");
        try { unlinkSync(this.metaPath(id)); } catch { /* ignore */ }
        this.logEvent("warn", "codex.indeterminate_duplicate_suppressed",
          `Suppressed possibly-sent terminal id ${validated.message.id} during reconcile`, {
            alias: this.alias,
            msg_id: validated.message.id,
            staged_file_id: id,
            phase: "reconcile",
          });
        continue;
      }
      let metaWasMissing = false;
      if (!meta) {
        metaWasMissing = true;
        meta = {
          id,
          state: "turn_starting", // conservative: unknown history => indeterminate
          attempts: 0,
          probeFailures: 0,
          nextAttemptAt: 0,
          turnId: null,
          possiblySent: true,
          stagedAt: new Date().toISOString(),
        };
        try { this.writeMeta(meta); } catch { /* readMeta degrades again next boot */ }
      }
      if (this.ledger.has(id) || meta.state === "turn_active" || meta.state === "delivered") {
        // Already delivered (or finalize was interrupted) — complete finalize.
        const finalized = this._completeFinalize(id, meta, "reconcile", validated.message);
        if (!finalized) {
          this.queue.set(id, {
            id,
            message: validated.message,
            meta,
            needsProbe: false,
            needsFinalize: true,
          });
        }
        continue;
      }
      const needsProbe = metaWasMissing || meta.state === "turn_starting" || meta.state === "steering";
      const needsDeadLetter = meta.state === "dead_lettering";
      this.queue.set(id, {
        id,
        message: validated.message,
        meta,
        needsProbe,
        needsDeadLetter,
        deadLetterReason: meta.deadLetterReason ?? "recovered_dead_letter",
      });
      this.logEvent(metaWasMissing ? "warn" : "info", "codex.delivery_readopted",
        `Reconcile: re-adopted ${id} (${metaWasMissing ? "missing/corrupt meta -> indeterminate" : meta.state})`, {
          alias: this.alias,
          msg_id: id,
          state: meta.state,
          attempts: meta.attempts,
          needs_probe: needsProbe,
          meta_missing: metaWasMissing,
        });
    }

    // Orphan meta files (no message file): the message finished or was moved;
    // drop the sidecar.
    for (const metaName of metas) {
      const id = metaName.slice(0, -".meta.json".length);
      if (!files.has(`${id}.json`)) {
        try { unlinkSync(join(this.stagingDir, metaName)); } catch { /* ignore */ }
      }
    }
    this.reconciled = true;
    return true;
  }

  /**
   * Scan the inbox for new files: guard, validate, dedupe, TTL-prune, claim
   * into staging with a DURABLE staged meta, enqueue. Safe to call repeatedly.
   */
  scanInbox() {
    // A failed startup reconciliation may hide a possibly-sent claimed
    // message. Never claim new inbox work until a complete later pass has
    // recovered every staged payload and its probe/finalize state.
    if (!this.reconciled) this.reconcile();
    let names = [];
    try {
      names = readdirSync(this.inboxDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const filePath = join(this.inboxDir, name);
      const guardError = this._fileGuard(filePath);
      if (guardError) {
        this.quarantine(filePath, guardError);
        continue;
      }
      const raw = safeRead(filePath);
      if (raw === null) continue;
      const validated = validateInboundForAlias(raw, this.alias);
      if (!validated.message) {
        this.quarantine(filePath, validated.error);
        continue;
      }
      const message = validated.message;
      if (this.indeterminateLedger.has(message.id)) {
        // Tombstones are keyed by the validated envelope id, never filename,
        // so renamed/replayed envelopes cannot escape suppression.
        this.quarantine(filePath, "indeterminate_terminal_tombstone");
        this.logEvent("warn", "codex.indeterminate_duplicate_suppressed",
          `Suppressed possibly-sent terminal id ${message.id} from inbox`, {
            alias: this.alias,
            msg_id: message.id,
            file: name,
            phase: "scan",
          });
        continue;
      }
      if (this.queue.has(message.id)) continue;
      if (this.ledger.has(message.id)) {
        this.archiveDelivered(filePath, message.id);
        this.logEvent("info", "codex.duplicate_skipped", `Duplicate message ${message.id} archived`, {
          alias: this.alias, msg_id: message.id,
        });
        continue;
      }
      if (isExpired(message)) {
        this.quarantine(filePath, "ttl_expired");
        continue;
      }
      // Claim: atomic rename into staging. ENOENT => raced consumer, skip.
      const stagedFile = this.stagedPath(message.id);
      if (existsSync(stagedFile) || existsSync(this.metaPath(message.id))) {
        this.logEvent("warn", "codex.claim_destination_exists",
          `Refusing to overwrite retained staged state for ${message.id}`, {
            alias: this.alias,
            msg_id: message.id,
          });
        continue;
      }
      try {
        renameSync(filePath, stagedFile);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          this.logEvent("warn", "codex.claim_failed", `Failed to claim ${message.id}: ${String(err?.message ?? err)}`, {
            alias: this.alias, msg_id: message.id,
          });
        }
        continue;
      }
      const meta = {
        id: message.id,
        state: "staged",
        attempts: 0,
        probeFailures: 0,
        nextAttemptAt: 0,
        turnId: null,
        possiblySent: false,
        stagedAt: new Date().toISOString(),
      };
      try {
        this.writeMeta(meta);
      } catch (err) {
        // The distinguishable first-ever-claim guarantee depends on a durable
        // staged meta existing BEFORE any send. If we cannot write it, UNDO
        // the claim so the next scan retries cleanly — never leave a claimed
        // file without metadata.
        this.logEvent("error", "codex.claim_meta_write_failed",
          `Could not durably stage ${message.id}; un-claiming for retry`, {
            alias: this.alias, msg_id: message.id, error: String(err?.message ?? err),
          });
        try { renameSync(stagedFile, filePath); } catch { /* next reconcile treats as indeterminate */ }
        continue;
      }
      this.queue.set(message.id, { id: message.id, message, meta, needsProbe: false });
      this.logEvent("info", "codex.message_received", `Claimed ${message.id} for ${this.alias}`, {
        alias: this.alias,
        msg_id: message.id,
        from: message.from,
        from_target: message.fromTarget ?? null,
        reply_to: message.replyTo ?? null,
        content_length: message.content.length,
      });
    }
  }

  /**
   * STRICT FIFO head (timestamp, then id). A backoff-parked head is WAITED
   * for — never bypassed by newer messages — so cross-message ordering is
   * preserved. Head-of-line blocking is bounded because every failure path
   * dead-letters after MAX_ATTEMPTS / MAX_PROBE_FAILURES.
   *
   * @returns {{ entry: object|null, parkedUntil: number|null }}
   */
  nextEntry(nowMs = Date.now()) {
    let head = null;
    for (const entry of this.queue.values()) {
      if (!head || compareOrder(entry, head) < 0) head = entry;
    }
    if (!head) return { entry: null, parkedUntil: null };
    const readyAt = head.meta.nextAttemptAt ?? 0;
    if (readyAt > nowMs) return { entry: null, parkedUntil: readyAt };
    return { entry: head, parkedUntil: null };
  }

  hasQueued() {
    return this.queue.size > 0;
  }

  hasIndeterminateQueued() {
    return Array.from(this.queue.values()).some((entry) => entry.needsProbe === true);
  }

  _sendFenceAllows() {
    try {
      return this.sendFence() === true;
    } catch {
      return false;
    }
  }

  _deferLeaseLost(entry, phase) {
    entry.meta.state = "staged";
    entry.meta.possiblySent = false;
    entry.needsProbe = false;
    try { this.writeMeta(entry.meta); } catch { /* no send occurred; reconcile stays conservative */ }
    this.logEvent("warn", "codex.lease_fence_lost", `Lease ownership lost before ${phase}; delivery deferred without sending`, {
      alias: this.alias,
      msg_id: entry.id,
      phase,
    });
    return "deferred";
  }

  _expireStagedBeforeSend(entry) {
    // Only a proven-unsent staged entry may expire here. Indeterminate wire
    // states must always take the history-probe path, even after their TTL.
    if (entry.meta.state !== "staged" || entry.meta.possiblySent === true || entry.needsProbe) return false;
    if (!isExpired(entry.message)) return false;
    this.logEvent("warn", "codex.delivery_expired_before_send",
      `Queued message ${entry.id} expired before a safe send attempt`, {
        alias: this.alias,
        msg_id: entry.id,
        attempts: entry.meta.attempts,
      });
    this.deadLetter(entry, "ttl_expired_before_send");
    return true;
  }

  /**
   * Finalize path, crash-hardened: durably record `delivered` FIRST, then
   * perform side effects. A crash at any point reconciles by completing the
   * finalize — never by re-delivering.
   */
  finalizeDelivered(entry, reason) {
    const finalized = this._completeFinalize(entry.id, entry.meta, reason, entry.message);
    if (finalized) this.queue.delete(entry.id);
    else entry.needsFinalize = true;
    return finalized;
  }

  /** Shared by finalizeDelivered and reconcile. */
  _completeFinalize(id, meta, reason, message = null) {
    try {
      if (meta.state !== "delivered") {
        meta.state = "delivered";
        this.writeMeta(meta);
      }
    } catch (err) {
      this.logEvent("error", "codex.finalize_meta_write_failed",
        `Could not durably mark ${id} delivered`, {
          alias: this.alias, msg_id: id, error: String(err?.message ?? err),
        });
      return false;
    }
    try {
      this.appendLedgerImpl(id, this.ledger, this.env);
    } catch (err) {
      this.logEvent("error", "codex.finalize_ledger_write_failed",
        `Could not durably ledger ${id}; retaining staged delivery for retry`, {
          alias: this.alias, msg_id: id, error: String(err?.message ?? err),
        });
      return false;
    }
    const archived = this.archiveDelivered(this.stagedPath(id), id);
    if (archived) {
      try { unlinkSync(this.metaPath(id)); } catch { /* orphan-meta sweep cleans up */ }
    } else return false;
    if (meta.turnId) {
      this.recentTurnMessages.set(meta.turnId, id);
      while (this.recentTurnMessages.size > 16) {
        const oldest = this.recentTurnMessages.keys().next().value;
        this.recentTurnMessages.delete(oldest);
      }
    }
    const replyExpected = Boolean(message?.fromTarget);
    this.logEvent("info", "codex.delivery_finalized", `Delivered ${id} to ${this.alias} (${reason})`, {
      alias: this.alias,
      msg_id: id,
      thread_id: this.binding.threadId,
      reason,
      attempts: meta.attempts,
      turn_id: meta.turnId ?? null,
      reply_expected: replyExpected,
      ...(message ? { from: message.from, from_target: message.fromTarget ?? null } : {}),
    });
    if (replyExpected) {
      this.logEvent("info", "codex.reply_expected",
        `Reply expected for ${id} -> ${message.from}/${message.fromTarget}`, {
          alias: this.alias,
          msg_id: id,
          reply_machine: message.from,
          reply_target: message.fromTarget,
        });
    }
    return true;
  }

  /** Message id for a completed turn (terminal-outcome attribution). */
  messageForTurn(turnId) {
    return this.recentTurnMessages.get(turnId) ?? null;
  }

  failAttempt(entry, errorText) {
    // This path is reserved for proven pre-acceptance failures (or local work
    // before the RPC). It remains safely retryable and must never acquire the
    // possibly-sent terminal tombstone.
    entry.meta.possiblySent = false;
    entry.meta.attempts += 1;
    if (entry.meta.attempts >= MAX_ATTEMPTS) {
      this.deadLetter(entry, `attempts_exhausted: ${errorText}`);
      return;
    }
    const backoff = ATTEMPT_BACKOFF_MS[Math.min(entry.meta.attempts - 1, ATTEMPT_BACKOFF_MS.length - 1)];
    entry.meta.state = "staged";
    entry.meta.nextAttemptAt = Date.now() + backoff;
    entry.needsProbe = false;
    try {
      this.writeMeta(entry.meta);
    } catch (err) {
      this.logEvent("error", "codex.meta_write_failed", `Backoff meta write failed for ${entry.id}`, {
        alias: this.alias, msg_id: entry.id, error: String(err?.message ?? err),
      });
    }
    this.logEvent("warn", "codex.delivery_retry", `Attempt ${entry.meta.attempts} failed for ${entry.id}; retrying in ${backoff}ms`, {
      alias: this.alias,
      msg_id: entry.id,
      attempts: entry.meta.attempts,
      max_attempts: MAX_ATTEMPTS,
      backoff_ms: backoff,
      error: errorText,
    });
  }

  deadLetter(entry, reason) {
    const possiblySent = entry.meta.possiblySent === true || entry.needsProbe === true;
    entry.needsDeadLetter = true;
    entry.deadLetterReason = reason;
    entry.meta.state = "dead_lettering";
    entry.meta.deadLetterReason = reason;
    entry.meta.possiblySent = possiblySent;
    entry.meta.nextAttemptAt = 0;
    try {
      // Persist the terminal intent BEFORE moving the payload. If the move
      // fails or the process crashes, reconcile retries only this local
      // finalization and can never issue another turn RPC.
      this.writeMeta(entry.meta);
    } catch (err) {
      this.logEvent("error", "codex.dead_letter_meta_failed", `Failed to persist dead-letter state for ${entry.id}: ${String(err?.message ?? err)}`, {
        alias: this.alias, msg_id: entry.id,
      });
      return false;
    }
    if (possiblySent) {
      try {
        // Publish a separate immutable terminal id BEFORE removing the staged
        // payload. A later replay must be suppressed even after the sidecar
        // and exhausted payload move out of the active queue.
        persistIndeterminateTombstone(entry.id, this.env);
        this.indeterminateLedger.add(entry.id);
      } catch (err) {
        this.logEvent("error", "codex.indeterminate_tombstone_failed",
          `Failed to persist possibly-sent terminal tombstone for ${entry.id}: ${String(err?.message ?? err)}`, {
            alias: this.alias, msg_id: entry.id,
          });
        return false;
      }
    }
    try {
      mkdirSync(exhaustedDir(this.env), { recursive: true, mode: 0o700 });
      this.deadLetterMove(this.stagedPath(entry.id), join(exhaustedDir(this.env), `${stamp()}_${entry.id}.json`));
    } catch (err) {
      this.logEvent("error", "codex.dead_letter_move_failed", `Failed to move ${entry.id} to .exhausted/: ${String(err?.message ?? err)}`, {
        alias: this.alias, msg_id: entry.id,
      });
      return false;
    }
    try { unlinkSync(this.metaPath(entry.id)); } catch { /* ignore */ }
    this.queue.delete(entry.id);
    this.logEvent("error", "codex.delivery_exhausted", `Dead-lettered ${entry.id} (${reason})`, {
      alias: this.alias,
      msg_id: entry.id,
      attempts: entry.meta.attempts,
      reason,
    });
    return true;
  }

  /**
   * Drive one delivery step against an available session. Returns:
   *   "idle"       — nothing actionable (empty queue or parked head)
   *   "delivered"  — one message finalized
   *   "deferred"   — thread busy / probe unresolved
   *   "failed"     — attempt failed (backoff scheduled or dead-lettered)
   */
  async deliverStep(session) {
    if (this.inFlight) return "deferred";
    const { entry } = this.nextEntry();
    if (!entry) return "idle";
    this.inFlight = true;
    try {
      // A terminal outcome was already decided, but the local move into the
      // exhausted queue failed. Retry ONLY that move; never execute another
      // turn/start or turn/steer. The durable dead_lettering state preserves
      // this rule across daemon restarts.
      if (entry.needsDeadLetter || entry.meta.state === "dead_lettering") {
        this.deadLetter(entry, entry.deadLetterReason ?? entry.meta.deadLetterReason ?? "dead_letter_retry");
        return "failed";
      }

      // A turn was already accepted, but durable ledger/archive finalization
      // failed. Retry ONLY those local side effects; never issue another
      // protocol send for this entry.
      if (entry.needsFinalize) {
        const finalized = this._completeFinalize(entry.id, entry.meta, "finalize_retry", entry.message);
        if (finalized) {
          this.queue.delete(entry.id);
          return "delivered";
        }
        return "deferred";
      }

      // Indeterminate resolution first — AT-MOST-ONCE, never a resend.
      //
      // Once a turn/start or turn/steer left the machine with an ambiguous
      // outcome (timeout / dropped pipe / lost metadata), "not found in the
      // thread" is NOT permission to send again: Codex could still accept
      // the original request later, and it does not document idempotent
      // duplicate suppression for clientUserMessageId. Policy:
      //   found            -> finalize (safe);
      //   absent/unknown   -> bounded re-probes with backoff (late-
      //                       acceptance window), then an EXPLICIT
      //                       indeterminate dead letter for manual
      //                       recovery — with NO second turn for this
      //                       message, ever.
      // (Clean pre-acceptance RPC errors never enter this path; they retry
      // via failAttempt below.)
      if (entry.needsProbe) {
        const present = await session.threadContains(entry.id);
        if (present === true) {
          await session.confirmAmbiguousDelivery?.(entry.id, session.lastHistoryMatchTurnId ?? null);
          return this.finalizeDelivered(entry, "probe_found_in_thread") ? "delivered" : "deferred";
        }
        entry.meta.probeFailures = (entry.meta.probeFailures ?? 0) + 1;
        entry.meta.nextAttemptAt = Date.now() + PROBE_BACKOFF_MS;
        try { this.writeMeta(entry.meta); } catch { /* bounded by in-memory count */ }
        const kind = present === false ? "authoritative_absent" : "probe_unavailable";
        this.logEvent("warn", "codex.delivery_indeterminate",
          `Ambiguous send for ${entry.id}: ${kind} (${entry.meta.probeFailures}/${MAX_PROBE_FAILURES}); at-most-once policy forbids resend`, {
            alias: this.alias,
            msg_id: entry.id,
            probe_failures: entry.meta.probeFailures,
            probe_result: kind,
          });
        if (entry.meta.probeFailures >= MAX_PROBE_FAILURES) {
          session.abandonAmbiguousDelivery?.(entry.id);
          this.deadLetter(entry, present === false
            ? "indeterminate_ambiguous_send_absent_no_resend"
            : "indeterminate_delivery_probe_unavailable");
          return "failed";
        }
        return "deferred";
      }

      // TTL is checked at inbox pickup AND again at the last resendable queue
      // state. A message may have waited behind a busy turn/backoff or been
      // recovered from `staged` after restart. Expiry is terminal and sends no
      // RPC; possibly-sent states above are deliberately never shortcut.
      if (this._expireStagedBeforeSend(entry)) return "failed";

      const attempt = entry.meta.attempts + 1;
      // Steering is ONLY safe into a turn WE started (bridge-owned): its
      // policies are known because we set them. Never steer a foreign
      // Desktop/TUI turn — turn/steer cannot apply safe policies.
      const steering = this.binding.policy.steering === true
        && session.turnActive
        && session.activeTurnOurs === true
        && session.activeTurnId;

      if (session.turnActive && !steering) {
        this.logEvent("info", "codex.queue_deferred_active_turn", `Queued ${entry.id}: turn active on ${this.alias}`, {
          alias: this.alias, msg_id: entry.id, active_turn_id: session.activeTurnId, turn_ours: session.activeTurnOurs === true,
        });
        return "deferred";
      }

      let text;
      try {
        text = composeTurnInputText({
          message: entry.message,
          binding: this.binding,
          localMachine: this.localMachine,
          channelVersion: this.channelVersion,
          attempt,
          deliveryMode: steering ? "turn/steer" : "turn/start",
        });
      } catch (err) {
        // Unexpected composition failure: bounded terminal path, never an
        // infinite head-of-line blocker.
        this.failAttempt(entry, `compose_failed: ${String(err?.message ?? err)}`);
        return "failed";
      }

      if (steering) {
        if (!this._sendFenceAllows()) return this._deferLeaseLost(entry, "turn/steer");
        try {
          entry.meta.state = "steering";
          entry.meta.possiblySent = true;
          this.writeMeta(entry.meta); // durable BEFORE the send — throws stop us
        } catch (err) {
          this.failAttempt(entry, `pre_steer_meta_write_failed: ${String(err?.message ?? err)}`);
          return "failed";
        }
        this.logEvent("info", "codex.steer_attempt", `Steering ${entry.id} into active bridge-owned turn`, {
          alias: this.alias, msg_id: entry.id, expected_turn_id: session.activeTurnId,
        });
        if (!this._sendFenceAllows()) return this._deferLeaseLost(entry, "turn/steer");
        try {
          await session.steerTurn({
            text,
            clientUserMessageId: entry.id,
            expectedTurnId: session.activeTurnId,
          });
          entry.meta.turnId = session.activeTurnId;
          return this.finalizeDelivered(entry, "steered") ? "delivered" : "deferred";
        } catch (err) {
          if (isDispatchFenced(err)) return this._deferLeaseLost(entry, "turn/steer");
          if (isRpcRejection(err)) {
            // A JSON-RPC error response proves App Server processed and
            // rejected the steer, so it is safe to return to the queue.
            entry.meta.state = "staged";
            entry.meta.possiblySent = false;
            try { this.writeMeta(entry.meta); } catch { /* conservative: reconcile probes */ }
            this.logEvent("info", "codex.steer_fallback", `Steer was rejected for ${entry.id}; falling back to queue`, {
              alias: this.alias, msg_id: entry.id, error: String(err?.message ?? err),
            });
            return "deferred";
          }
          // Every non-RPC error after the durable send gate is ambiguous:
          // stdin may have accepted the bytes before EPIPE/timeout/process
          // failure surfaced. Never convert this into a clean retry.
          entry.needsProbe = true;
          session.markAmbiguousDeliveryPending?.(entry.id);
          try { this.writeMeta(entry.meta); } catch { /* state already steering => probed on reconcile */ }
          this.logEvent("warn", "codex.steer_indeterminate", `Steer outcome unknown for ${entry.id}; will probe without resending`, {
            alias: this.alias, msg_id: entry.id, error: String(err?.message ?? err),
          });
          return "deferred";
        }
      }

      // Durable pre-send gate: the indeterminate marker MUST be on disk
      // before turn/start goes out, or a crash window opens where a resend
      // could double-deliver. A failed write means NO send this step.
      if (!this._sendFenceAllows()) return this._deferLeaseLost(entry, "turn/start");
      try {
        entry.meta.state = "turn_starting";
        entry.meta.possiblySent = true;
        this.writeMeta(entry.meta);
      } catch (err) {
        this.failAttempt(entry, `pre_send_meta_write_failed: ${String(err?.message ?? err)}`);
        return "failed";
      }
      this.logEvent("info", "codex.turn_start", `Starting turn for ${entry.id} on thread ${this.binding.threadId}`, {
        alias: this.alias,
        msg_id: entry.id,
        thread_id: this.binding.threadId,
        attempt,
        approval_policy: this.binding.policy.approvalPolicy,
        sandbox: this.binding.policy.sandbox,
      });
      if (!this._sendFenceAllows()) return this._deferLeaseLost(entry, "turn/start");
      let result;
      try {
        result = await session.startTurn({
          text,
          clientUserMessageId: entry.id,
          timeoutMs: this.binding.policy.turnTimeoutMs ?? undefined,
        });
      } catch (err) {
        const detail = String(err?.message ?? err);
        if (isRpcRejection(err)) {
          this.failAttempt(entry, detail);
          return "failed";
        }
        entry.needsProbe = true;
        session.markAmbiguousDeliveryPending?.(entry.id);
        try { this.writeMeta(entry.meta); } catch { /* state turn_starting already durable */ }
        this.logEvent("warn", "codex.delivery_indeterminate", `turn/start outcome unknown for ${entry.id}; will probe without resending`, {
          alias: this.alias, msg_id: entry.id, error: detail,
        });
        return "deferred";
      }
      if (result.busy) {
        entry.meta.state = "staged";
        entry.meta.possiblySent = false;
        try { this.writeMeta(entry.meta); } catch { /* conservative: reconcile probes */ }
        this.logEvent("info", "codex.queue_deferred_active_turn", `turn/start reported busy for ${entry.id}; queued`, {
          alias: this.alias, msg_id: entry.id,
        });
        return "deferred";
      }
      if (result.fenced) return this._deferLeaseLost(entry, "turn/start");
      if (!result || typeof result.turnId !== "string" || !result.turnId) {
        // Codex 0.145 requires TurnStartResponse.turn.id. A malformed
        // success may still mean the request was accepted, so reconcile it
        // exactly like a lost response; never archive or resend directly.
        entry.needsProbe = true;
        session.markAmbiguousDeliveryPending?.(entry.id);
        try { this.writeMeta(entry.meta); } catch { /* turn_starting remains durable */ }
        this.logEvent("warn", "codex.delivery_indeterminate", `turn/start returned no turn id for ${entry.id}; will probe without resending`, {
          alias: this.alias,
          msg_id: entry.id,
        });
        return "deferred";
      }
      entry.meta.state = "turn_active";
      entry.meta.turnId = result.turnId;
      try { this.writeMeta(entry.meta); } catch { /* finalize below re-records */ }
      this.logEvent("info", "codex.turn_started", `Turn ${result.turnId} started for ${entry.id}`, {
        alias: this.alias, msg_id: entry.id, turn_id: result.turnId,
      });
      // turn/start success == the message text is durably in the thread.
      return this.finalizeDelivered(entry, "turn_started") ? "delivered" : "deferred";
    } finally {
      this.inFlight = false;
    }
  }

  /** Snapshot for status/doctor. */
  statusSnapshot() {
    let pendingInbox = 0;
    try {
      pendingInbox = readdirSync(this.inboxDir).filter((n) => n.endsWith(".json")).length;
    } catch { /* ignore */ }
    return {
      alias: this.alias,
      threadId: this.binding.threadId,
      queued: this.queue.size,
      pendingInbox,
      entries: Array.from(this.queue.values()).map((e) => ({
        id: e.id,
        state: e.meta.state,
        attempts: e.meta.attempts,
        needsProbe: e.needsProbe === true,
      })),
    };
  }
}

function compareOrder(a, b) {
  const ta = new Date(a.message.timestamp).getTime() || 0;
  const tb = new Date(b.message.timestamp).getTime() || 0;
  if (ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
