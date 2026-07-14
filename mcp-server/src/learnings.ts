/**
 * learnings.ts — the fleet-wide SHARED CONTEXT store ("learnings") for
 * agent-bridge, backing the `bridge_learnings_add` / `bridge_learnings_search`
 * MCP tools and mirroring the `agent-bridge learnings` CLI verbs.
 *
 * ============================================================================
 * WHY THIS EXISTS / THE BIG ARCHITECTURAL DECISION (read this first)
 * ============================================================================
 *
 * The fleet already has PER-REPO institutional memory (each repo's
 * LEARNINGS.md) and PER-HARNESS memory (Claude Code auto-memory, OpenClaw
 * workspace rules). What was missing is a GLOBAL layer: a learning discovered
 * by ONE agent on ONE machine ("Surfshark stuck on IKEv2 → switch protocol to
 * WireGuard in the group plist") that every OTHER agent on every OTHER machine
 * should be able to find before re-deriving it from scratch. That is what this
 * store is: fleet-wide, harness-agnostic, machine-replicated.
 *
 * STORAGE — append-only NDJSON at ~/.agent-bridge/shared-context/learnings.ndjson.
 * One JSON object per line, exactly like the unified event log
 * (~/.agent-bridge/logs/agent-bridge.log). NDJSON was chosen deliberately:
 *   • append-only writes are atomic enough for our concurrency (single-line
 *     appends far below the PIPE_BUF boundary don't interleave on local fs),
 *   • merging two machines' stores is a trivial line-union deduped by `id`,
 *   • it's greppable/jq-able by hand, and `learnings list/show` renders a
 *     human-readable view on top.
 *
 * REPLICATION — push-on-write + pull-reconcile, both idempotent by entry id:
 *   • On `add`, we best-effort push the new entry to every paired machine via
 *     sshExec running the REMOTE machine's own
 *     `agent-bridge learnings ingest --json '<entry>'` (the exact pattern
 *     bridge_notify uses: reuse the side-effect path, never the inbox/watcher
 *     path — a learning replica is a SIDE EFFECT, not an agent message; it
 *     must not depend on a live remote channel-owner).
 *   • Offline peers simply miss the push; `agent-bridge learnings sync`
 *     reconciles bidirectionally on next contact (fetch remote NDJSON, union
 *     by id both ways). Because ingest dedupes by id, replays are harmless.
 *
 * ID CONVENTION — entry ids are LOWERCASE uuids. This mirrors the established
 * agent-bridge convention that hand-crafted BridgeMessage ids MUST be
 * lowercase (uppercase UUIDs get quarantined to _unrouted). randomUUID()
 * already emits lowercase; the bash side lowercases `uuidgen` output. Ingest
 * normalizes defensively anyway.
 *
 * The store logic lives in TWO mirrored places that must stay behaviorally
 * identical (same pattern as notify.ts / _render_local_notification):
 *   1. `cmd_learnings` + helpers (bash) in the `agent-bridge` CLI — used by
 *      the CLI verbs AND by every REMOTE ingest (the remote runs its own CLI).
 *   2. This file — used by the MCP tools' LOCAL reads/writes so we avoid a
 *      node→bash→node hop for same-machine operations.
 * If you change validation/merge semantics in one, change the other.
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRIDGE_DIR, getLocalMachineName } from './config.js';
import { shellQuoteForSsh } from './notify.js';

/** A single fleet-wide learning entry. Matches the bash CLI's schema 1:1. */
export interface LearningEntry {
  /** Lowercase uuid — the dedupe key for replication (see header). */
  id: string;
  /** ISO-8601 UTC timestamp of when the learning was recorded. */
  ts: string;
  /** Machine the learning was recorded on (getLocalMachineName / get_machine_name). */
  machine: string;
  /**
   * Which agent recorded it — free-form harness/persona label, e.g.
   * "claude-code/default", "openclaw/clawdiboi2", "codex", "cli".
   */
  harness: string;
  /** Short one-line title (the thing you scan in `learnings list`). */
  title: string;
  /**
   * Full learning text. Symptom/cause/fix/guard prose is encouraged for
   * bug-shaped learnings, but body is deliberately free-form: recipes and
   * "how X actually works" findings are first-class too.
   */
  body: string;
  /** Lowercase keyword tags for filtering (e.g. ["macos","vpn","surfshark"]). */
  tags: string[];
  /**
   * Always "global". Present + explicit so a future scoped tier (per-project,
   * per-machine) can coexist in the same file without a migration.
   */
  scope: string;
  /** Schema version for forward-compat parsing. */
  v: number;
}

/** Relative path under ~/.agent-bridge — shared with the bash CLI verbatim. */
export const LEARNINGS_REL_PATH = 'shared-context/learnings.ndjson';

/** Absolute path of the local store file. */
export function learningsFilePath(): string {
  return join(BRIDGE_DIR, LEARNINGS_REL_PATH);
}

/**
 * createLearningEntry — build a fully-populated entry from the add-tool input.
 * Tags are normalized to lowercase + trimmed + deduped so searches by tag are
 * predictable across machines regardless of how the author typed them.
 */
export function createLearningEntry(input: {
  title: string;
  body: string;
  tags?: string[];
  harness?: string;
}): LearningEntry {
  const tags = Array.from(
    new Set(
      (input.tags ?? [])
        .map(t => t.trim().toLowerCase())
        .filter(t => t !== ''),
    ),
  );
  return {
    id: randomUUID(), // node emits lowercase — matches the lowercase-id convention
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // second precision, matches bash `date -u +%FT%TZ`
    machine: getLocalMachineName(),
    harness: input.harness && input.harness.trim() !== '' ? input.harness.trim() : 'unknown',
    title: input.title.trim(),
    body: input.body.trim(),
    tags,
    scope: 'global',
    v: 1,
  };
}

/**
 * readLearnings — parse the local NDJSON store, newest-last (file order =
 * append order). Corrupt lines are SKIPPED, not fatal: a half-written line
 * from a crashed writer must never brick every future read of the whole
 * store. Missing file = empty store (first use).
 */
export function readLearnings(): LearningEntry[] {
  const file = learningsFilePath();
  if (!existsSync(file)) return [];
  const out: LearningEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const obj = JSON.parse(trimmed) as LearningEntry;
      // Minimal shape check — id + title are the only fields every consumer
      // relies on; anything else degrades gracefully in the renderers.
      if (typeof obj.id === 'string' && obj.id !== '' && typeof obj.title === 'string') {
        out.push(obj);
      }
    } catch {
      // Corrupt line — skip (see docstring). The bash CLI does the same.
    }
  }
  return out;
}

/**
 * appendLearningLocal — idempotent local append: writes the entry as one
 * NDJSON line unless an entry with the same id already exists.
 *
 * Returns true if the entry was written, false if it was a duplicate (which
 * is the NORMAL case during sync replays — not an error).
 *
 * Concurrency note: we deliberately use a plain appendFileSync of a single
 * `<line>\n` (well under 4 KB in practice). On local filesystems appends of
 * that size from concurrent processes don't interleave mid-line, and the
 * read path skips any corrupt line defensively anyway — a lock file would be
 * more machinery than the risk justifies for a low-write-rate store.
 */
export function appendLearningLocal(entry: LearningEntry): boolean {
  const file = learningsFilePath();
  // Dedupe-by-id BEFORE appending — this is what makes replication replays
  // (push retry + sync overlap) harmless.
  const existing = readLearnings();
  if (existing.some(e => e.id === entry.id)) return false;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return true;
}

/**
 * searchLearnings — case-insensitive substring search across title, body and
 * tags. Empty/omitted query = everything (list mode). Optional tag filter is
 * an exact (lowercased) tag match. Results come back NEWEST FIRST because the
 * caller is almost always asking "has anyone hit this recently".
 */
export function searchLearnings(opts: {
  query?: string;
  tag?: string;
  limit?: number;
} = {}): LearningEntry[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const tag = (opts.tag ?? '').trim().toLowerCase();
  let entries = readLearnings();
  if (tag !== '') {
    entries = entries.filter(e => (e.tags ?? []).includes(tag));
  }
  if (q !== '') {
    entries = entries.filter(e => {
      const hay = `${e.title}\n${e.body}\n${(e.tags ?? []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }
  entries.reverse(); // file order is oldest-first; return newest-first
  const limit = opts.limit && opts.limit > 0 ? opts.limit : entries.length;
  return entries.slice(0, limit);
}

/**
 * formatLearning — human-readable render of one entry for MCP tool output.
 * Kept deliberately close to the bash `_learnings_render` layout so agents
 * see the same shape whether they used the CLI or the tool.
 */
export function formatLearning(e: LearningEntry): string {
  const tags = (e.tags ?? []).length > 0 ? `  tags: ${(e.tags ?? []).join(', ')}` : '';
  return [
    `— ${e.title}`,
    `  ${e.ts}  ·  ${e.machine}/${e.harness}  ·  id: ${e.id}${tags}`,
    // Indent the body so multi-entry output stays scannable.
    ...e.body.split('\n').map(l => `  ${l}`),
  ].join('\n');
}

/**
 * buildRemoteIngestCommand — assemble the exact shell command we run on a
 * REMOTE machine over SSH to replicate one entry. It invokes the remote's OWN
 * bundled CLI (`agent-bridge learnings ingest --json '<entry>'`) so the
 * remote owns its store writes + dedupe — we never touch its file directly.
 *
 * QUOTING — the single most important correctness detail (same as notify):
 * the serialized entry is free-form agent text (quotes, $, backticks,
 * newlines-in-JSON-escapes...) and the whole command string is re-parsed by
 * the REMOTE shell, so the JSON is passed through shellQuoteForSsh.
 *
 * PATH-PREPEND WRAP — sshExec runs a non-interactive remote shell with a
 * minimal PATH that does NOT include ~/.local/bin (install.sh default) or
 * /opt/homebrew/bin, and a login shell does not help (zsh users set PATH in
 * ~/.zshrc which `sh -lc` never sources). Without the explicit prepend the
 * remote fails exit 127 even though agent-bridge IS installed. Same
 * load-bearing wrap as buildRemoteNotifyCommand.
 */
export function buildRemoteIngestCommand(entry: LearningEntry): string {
  const q = shellQuoteForSsh;
  const inner = `agent-bridge learnings ingest --json ${q(JSON.stringify(entry))}`;
  const withPath = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${inner}`;
  return `sh -c ${q(withPath)}`;
}
