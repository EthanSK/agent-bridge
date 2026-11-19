/** Durable session-open backoff; never changes inbound delivery attempts. */
import { accessSync, constants, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { codexBinaryCandidates } from "./app-server-client.js";
import { writeFileDurable } from "./fsutil.js";
import { resumeRetryPath } from "./paths.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];
const INCOMPATIBLE_RETRY_MS = 3_600_000;

/** Changing the selected installed executable allows an immediate new probe. */
export function codexBinaryStamp(env = process.env) {
  const candidates = codexBinaryCandidates({ env });
  for (const candidate of candidates) {
    const paths = candidate.includes("/") || candidate.includes("\\")
      ? [candidate]
      : String(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, candidate));
    for (const path of paths) {
      try {
        accessSync(path, constants.X_OK);
        const stat = statSync(path);
        if (stat.isFile()) return JSON.stringify([path, stat.size, stat.mtimeMs]);
      } catch { /* missing candidates use the same ordered fallback as spawn */ }
    }
  }
  return JSON.stringify(candidates);
}

export function resumeRetryKey(binding, binaryStamp) {
  return JSON.stringify([binding.threadId, binding.cwd, binding.policy, binding.updatedAt, binaryStamp]);
}

export function readResumeRetry(alias, env = process.env) {
  try {
    const record = JSON.parse(readFileSync(resumeRetryPath(alias, env), "utf8"));
    if (record?.version !== 1 || typeof record.key !== "string"
      || !Number.isSafeInteger(record.attempts) || record.attempts < 1
      || !Number.isFinite(record.retryAt) || record.retryAt < 0) {
      throw new Error(`invalid resume retry record for ${alias}`);
    }
    return record;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export function nextResumeRetry({ previous, key, state, detail, now }) {
  const attempts = Math.min((previous?.key === key ? previous.attempts : 0) + 1, Number.MAX_SAFE_INTEGER);
  // Deserialization/unsupported/missing-thread errors cannot be repaired by
  // another immediate subprocess. Allow a sparse probe rather than spin.
  const incompatible = state === "codex_unsupported" || state === "thread_not_found"
    || /unknown variant|deserializ|unsupported.*(?:schema|format)|invalid.*(?:schema|format)/i.test(detail);
  const delayMs = incompatible ? INCOMPATIBLE_RETRY_MS
    : RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return {
    version: 1, key, attempts, retryAt: now + delayMs, delayMs,
    phase: incompatible || attempts >= RETRY_DELAYS_MS.length ? "cooldown" : "backoff",
    classifiedState: state, detail, lastFailureAt: now,
  };
}

export function persistResumeRetry(alias, record, env = process.env) {
  const path = resumeRetryPath(alias, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileDurable(path, `${JSON.stringify(record)}\n`);
}

export function clearResumeRetry(alias, env = process.env) {
  try { unlinkSync(resumeRetryPath(alias, env)); } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
