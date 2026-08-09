/**
 * Read-only helpers over Codex's persisted thread storage
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`).
 *
 * Used for:
 *  - bind-time existence validation of a thread id WITHOUT attaching an App
 *    Server client to it (attaching would contend with the live task's own
 *    connection — exactly what binding must not do), and
 *  - the ownership guard: rollout mtime advancing while codex-channel has no
 *    active delivery is evidence another Codex client is writing the thread.
 *
 * Strictly read-only: never opens files for write, never deletes.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexSessionsDir } from "./paths.js";

const MAX_DIR_ENTRIES = 20_000; // hard walk bound; sessions trees are shallow

/**
 * Find the rollout file for a thread id.
 * @returns {{ path: string, mtimeMs: number }|null}
 */
export function findRolloutForThread(threadId, { env = process.env } = {}) {
  const root = codexSessionsDir(env);
  const needle = String(threadId).toLowerCase();
  let visited = 0;

  /** Depth-first over the date-sharded tree, newest-ish last wins. */
  const walk = (dir, depth) => {
    if (depth > 4) return null; // sessions/YYYY/MM/DD/<file>
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Newest directories first so the common case (recent thread) is fast.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_DIR_ENTRIES) return null;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.toLowerCase().includes(needle) && entry.name.endsWith(".jsonl")) {
        try {
          return { path: full, mtimeMs: statSync(full).mtimeMs };
        } catch {
          return { path: full, mtimeMs: 0 };
        }
      }
    }
    return null;
  };

  return walk(root, 0);
}

/** Fresh mtime for a known rollout path (null when unreadable/missing). */
export function rolloutMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
