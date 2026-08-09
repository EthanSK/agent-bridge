/**
 * Automatic Codex alias discovery and binding.
 *
 * The zero-argument UX is intentionally stable:
 *   1. reuse an alias already bound to this exact thread;
 *   2. otherwise read the persisted thread's user-facing name through the
 *      public, read-only `thread/read` App Server method;
 *   3. fall back to the task cwd, then a short thread-id suffix;
 *   4. add a deterministic thread-id suffix only when the clean name is
 *      already owned by another task.
 *
 * Once persisted, a later title change never renames the endpoint because
 * step (1) wins before title discovery.
 */

import { basename } from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";
import {
  aliasFilesystemKey,
  bindAlias,
  isValidAlias,
  listBindings,
  normalizeThreadId,
} from "./bindings.js";
import { CHANNEL_VERSION } from "./version.js";

const AUTO_ALIAS_BASE_MAX = 64;
const AUTO_BIND_RETRIES = 8;

function trimAliasBase(value, maxLength = AUTO_ALIAS_BASE_MAX) {
  return String(value).slice(0, maxLength).replace(/-+$/g, "");
}

/** Turn a human task name into one portable lowercase alias segment. */
export function slugifyCodexAlias(value, { maxLength = AUTO_ALIAS_BASE_MAX } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  let slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  slug = trimAliasBase(slug, maxLength);
  if (!slug) return null;
  // Windows device basenames (CON, NUL, COM1, …) are deliberately invalid
  // aliases. Prefixing retains the useful title while making it portable.
  if (!isValidAlias(slug)) slug = trimAliasBase(`task-${slug}`, maxLength);
  return isValidAlias(slug) ? slug : null;
}

function cwdLeaf(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  // Accept either separator so a registry prepared on one OS can still be
  // inspected safely on another during packaging/tests.
  const pieces = cwd.trim().split(/[\\/]+/).filter(Boolean);
  return pieces.at(-1) ?? basename(cwd.trim()) ?? null;
}

function compareExistingBindings(left, right) {
  const created = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  return created || left.alias.localeCompare(right.alias);
}

function aliasWithSuffix(base, suffix) {
  const cleanSuffix = String(suffix).replace(/[^a-z0-9]/g, "");
  const room = 128 - cleanSuffix.length - 1;
  const prefix = trimAliasBase(base, room) || "task";
  return `${prefix}-${cleanSuffix}`;
}

/**
 * Pure alias selection over a registry snapshot.
 *
 * @returns {{alias:string, source:string, reused:boolean, title:string|null}}
 */
export function selectAutomaticCodexAlias({
  threadId,
  threadName = null,
  cwd = null,
  bindings = [],
}) {
  const normalizedThreadId = normalizeThreadId(threadId ?? "");
  const existing = bindings
    .filter((binding) => normalizeThreadId(binding?.threadId ?? "") === normalizedThreadId)
    .sort(compareExistingBindings)[0];
  if (existing) {
    return {
      alias: existing.alias,
      source: "existing-binding",
      reused: true,
      title: null,
    };
  }

  const titleSlug = slugifyCodexAlias(threadName);
  const cwdSlug = slugifyCodexAlias(cwdLeaf(cwd));
  const compactId = normalizedThreadId.replace(/-/g, "") || "unknown";
  let base = titleSlug ?? cwdSlug;
  let source = titleSlug ? "thread-name" : cwdSlug ? "thread-cwd" : "thread-id";
  if (!base) base = "codex-task";

  const used = new Set(bindings.map((binding) => aliasFilesystemKey(binding.alias)));
  if (source !== "thread-id" && !used.has(aliasFilesystemKey(base))) {
    return { alias: base, source, reused: false, title: titleSlug ? threadName.trim() : null };
  }

  // UUIDv7 ids share a time-heavy prefix, so use the random tail first.
  for (const length of [8, 12, 16, compactId.length]) {
    const suffix = compactId.slice(-Math.min(length, compactId.length));
    const candidate = aliasWithSuffix(base, suffix);
    if (isValidAlias(candidate) && !used.has(aliasFilesystemKey(candidate))) {
      return {
        alias: candidate,
        source: source === "thread-id" ? source : `${source}-collision`,
        reused: false,
        title: titleSlug ? threadName.trim() : null,
      };
    }
  }

  // A manually-created alias could theoretically occupy even the full UUID
  // spelling. Keep selection deterministic for that pathological case.
  for (let counter = 2; counter <= 9999; counter += 1) {
    const candidate = aliasWithSuffix(base, `${compactId}-${counter}`);
    if (isValidAlias(candidate) && !used.has(aliasFilesystemKey(candidate))) {
      return {
        alias: candidate,
        source: `${source}-collision`,
        reused: false,
        title: titleSlug ? threadName.trim() : null,
      };
    }
  }
  throw new Error(`could not derive a free automatic Codex alias for thread ${normalizedThreadId}`);
}

/**
 * Read task metadata without resuming or subscribing to the task.
 * Title lookup failure is non-fatal (callers have cwd/id fallbacks), but an
 * unverified child teardown still throws so an orphan App Server is never
 * silently left behind merely to obtain a pretty alias.
 */
export async function readCodexThreadMetadata({
  threadId,
  env = process.env,
  timeoutMs = 10_000,
  clientFactory = (opts) => CodexAppServerClient.spawn(opts),
  logEvent = () => {},
} = {}) {
  const injectedName = env.AGENT_BRIDGE_CODEX_THREAD_NAME?.trim();
  if (injectedName) {
    return { name: injectedName, cwd: null, warning: null, source: "env-override" };
  }

  let client = null;
  let metadata = { name: null, cwd: null, warning: null, source: "thread-read" };
  try {
    client = await clientFactory({
      env,
      logEvent,
      clientName: "agent-bridge-codex-auto-alias",
      clientVersion: CHANNEL_VERSION,
    });
    await client.initialize({ timeoutMs });
    const response = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    }, { timeoutMs });
    const thread = response?.thread;
    if (normalizeThreadId(thread?.id ?? "") !== normalizeThreadId(threadId ?? "")) {
      throw new Error("thread/read returned a different or missing thread id");
    }
    metadata = {
      name: typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : null,
      cwd: typeof thread.cwd === "string" && thread.cwd.trim() ? thread.cwd.trim() : null,
      warning: null,
      source: "thread-read",
    };
  } catch (error) {
    metadata = {
      name: null,
      cwd: null,
      warning: `task name lookup unavailable; using a stable fallback (${String(error?.message ?? error)})`,
      source: "fallback",
    };
  } finally {
    // Do not swallow exact-process-tree teardown uncertainty. The caller may
    // safely fall back after ordinary read/spawn errors, but not while a
    // second App Server could still be alive.
    if (client) await client.close();
  }
  return metadata;
}

/** Resolve an automatic alias, avoiding App Server startup when already bound. */
export async function resolveAutomaticCodexAlias({
  threadId,
  cwd = null,
  env = process.env,
  threadName = null,
  clientFactory,
  logEvent = () => {},
} = {}) {
  const firstSnapshot = listBindings({ env });
  const existing = selectAutomaticCodexAlias({ threadId, cwd, bindings: firstSnapshot });
  if (existing.reused) {
    return { ...existing, resolvedCwd: cwd, metadataWarning: null, metadataSource: "not-needed" };
  }

  const metadata = threadName
    ? { name: threadName, cwd: null, warning: null, source: "provided" }
    : await readCodexThreadMetadata({ threadId, env, clientFactory, logEvent });
  const selected = selectAutomaticCodexAlias({
    threadId,
    threadName: metadata.name,
    cwd: metadata.cwd ?? cwd,
    bindings: firstSnapshot,
  });
  return {
    ...selected,
    resolvedCwd: metadata.cwd ?? cwd,
    metadataWarning: metadata.warning,
    metadataSource: metadata.source,
  };
}

/**
 * Resolve and bind atomically enough for independent CLI/MCP contenders:
 * selection is refreshed after any registry race, while bindAlias remains
 * the one lock-guarded durable mutation.
 */
export async function bindAutomaticCodexAlias({
  threadId,
  cwd = null,
  boundBy = "automatic",
  policy = {},
  allowDanger = false,
  env = process.env,
  threadName = null,
  clientFactory,
  logEvent = () => {},
} = {}) {
  const initiallyResolved = await resolveAutomaticCodexAlias({
    threadId,
    cwd,
    env,
    threadName,
    clientFactory,
    logEvent,
  });
  const discoveredName = initiallyResolved.title;
  const resolvedCwd = initiallyResolved.resolvedCwd ?? cwd;
  const metadataWarning = initiallyResolved.metadataWarning;
  const metadataSource = initiallyResolved.metadataSource;

  for (let attempt = 0; attempt < AUTO_BIND_RETRIES; attempt += 1) {
    const bindings = listBindings({ env });
    const selected = selectAutomaticCodexAlias({
      threadId,
      threadName: discoveredName,
      cwd: resolvedCwd,
      bindings,
    });
    try {
      const result = bindAlias({
        alias: selected.alias,
        threadId,
        cwd: resolvedCwd,
        boundBy,
        policy,
        // Re-running zero-argument bind re-enables/refreshes the exact saved
        // endpoint instead of creating another alias or requiring --rebind.
        rebind: selected.reused,
        allowSharedThread: false,
        allowDanger,
        env,
      });
      return {
        ...result,
        aliasResolution: {
          ...selected,
          metadataWarning,
          metadataSource,
        },
      };
    } catch (error) {
      // Retry only when the snapshot became stale because another process
      // claimed this alias/thread. Validation, policy, cwd, and I/O failures
      // are returned immediately.
      const refreshed = listBindings({ env });
      const sameThreadNowExists = refreshed.some(
        (binding) => normalizeThreadId(binding.threadId) === normalizeThreadId(threadId),
      );
      const aliasNowOccupied = refreshed.some(
        (binding) => aliasFilesystemKey(binding.alias) === aliasFilesystemKey(selected.alias),
      );
      if (!sameThreadNowExists && !aliasNowOccupied) throw error;
    }
  }
  throw new Error(`automatic Codex alias binding kept racing for thread ${normalizeThreadId(threadId)}`);
}
