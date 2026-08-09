/**
 * Small filesystem/concurrency primitives shared across codex-channel.
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Atomic durable file write: same-directory temp file (0600), fsync the
 * file, rename over the destination, then best-effort fsync of the
 * directory. Windows cannot fsync directories — there the file-level fsync +
 * atomic rename is the strongest portable guarantee, which is why callers
 * must treat "rename visible" as the commit point rather than relying on
 * directory durability.
 */
export function writeFileDurable(path, contents, injectedOps = {}) {
  const ops = {
    closeSync,
    fsyncSync,
    openSync,
    renameSync,
    unlinkSync,
    writeSync,
    ...injectedOps,
  };
  const dir = dirname(path);
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  const fd = ops.openSync(tmp, "wx", 0o600);
  let closed = false;
  try {
    let offset = 0;
    while (offset < data.length) {
      const written = ops.writeSync(fd, data, offset, data.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error(`durable write made no progress at byte ${offset}/${data.length}`);
      }
      offset += written;
    }
    // A successful rename is not enough for the pre-send durability gates:
    // surface ENOSPC/EIO (and every other file-fsync failure) to the caller.
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    closed = true;
  } catch (err) {
    if (!closed) {
      try { ops.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { ops.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
  try {
    ops.renameSync(tmp, path);
  } catch (err) {
    try { ops.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try {
    const dirFd = ops.openSync(dir, "r");
    try { ops.fsyncSync(dirFd); } catch { /* directory fsync unsupported (e.g. win32) */ }
    ops.closeSync(dirFd);
  } catch { /* directory fds unsupported on this platform */ }
}

/**
 * Publish a complete exclusive lock file in one namespace operation.
 *
 * Writing directly after open("wx") exposes a short empty/partial-file
 * window. A crash there leaves a malformed fixed lock that cannot safely be
 * attributed or recovered. Instead, fully write + fsync a unique owner file,
 * then hard-link it at the fixed path. link(2) is the atomic no-replace commit:
 * EEXIST means another owner won, and a visible lock always has complete
 * identity bytes. An orphaned unique file never blocks later acquisition.
 */
export function publishExclusiveFile(path, contents, injectedOps = {}) {
  const ops = {
    closeSync,
    fsyncSync,
    linkSync,
    openSync,
    unlinkSync,
    writeSync,
    ...injectedOps,
  };
  const unique = `${path}.owner-${process.pid}-${randomUUID()}`;
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  const fd = ops.openSync(unique, "wx", 0o600);
  let closed = false;
  try {
    let offset = 0;
    while (offset < data.length) {
      const written = ops.writeSync(fd, data, offset, data.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error(`exclusive publication made no progress at byte ${offset}/${data.length}`);
      }
      offset += written;
    }
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    closed = true;
    ops.linkSync(unique, path);
  } catch (error) {
    if (!closed) {
      try { ops.closeSync(fd); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    try { ops.unlinkSync(unique); } catch { /* crash-forensic orphan is non-owning */ }
  }
}

/**
 * Synchronous bounded sleep without spinning the CPU (Atomics.wait on an
 * unshared buffer). Used by the synchronous registry-lock retry loop so the
 * existing synchronous mutator API can stay synchronous.
 */
export function sleepSync(ms) {
  const bounded = Math.max(1, Math.min(Math.floor(ms), 1000));
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, bounded);
  } catch {
    // Extremely defensive fallback: busy-wait a bounded slice.
    const until = Date.now() + bounded;
    while (Date.now() < until) { /* bounded spin */ }
  }
}

/** Liveness probe tolerant of EPERM (alive but not signalable). */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}
