/**
 * Unified NDJSON event logging for the Codex channel.
 *
 * Appends `component: "codex-channel"` events to the fleet-wide unified log
 * at `~/.agent-bridge/logs/agent-bridge.log`, matching the record shape used
 * by `mcp-server/src/log.ts` and `chime/service.mjs` so the standard jq
 * recipes in AGENTS.md work unchanged:
 *
 *   jq -c 'select(.component == "codex-channel")' ~/.agent-bridge/logs/agent-bridge.log
 *
 * Design mirrors log.ts: never throws, secret-redacting, size-bounded
 * context strings, single-generation 50 MB rotation. No cross-package import
 * of log.ts (that is TypeScript compiled into mcp-server/build); this module
 * is the plain-ESM twin — keep record shapes in sync.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { unifiedLogPath } from "./paths.js";

const MAX_LOG_SIZE = 50 * 1024 * 1024;
const MAX_CONTEXT_STRING = 2000;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /gho_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

let cachedMachine = null;

function machineName() {
  if (cachedMachine !== null) return cachedMachine;
  try {
    cachedMachine = hostname().replace(/\.local$/i, "");
  } catch {
    cachedMachine = "unknown";
  }
  return cachedMachine;
}

function redact(input) {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function truncate(input) {
  if (input.length <= MAX_CONTEXT_STRING) return input;
  return `${input.slice(0, MAX_CONTEXT_STRING)}…[truncated ${input.length - MAX_CONTEXT_STRING}]`;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(redact(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: truncate(redact(value.message)) };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  return String(value);
}

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= MAX_LOG_SIZE) return;
    renameSync(path, `${path}.1`);
  } catch {
    /* never block logging */
  }
}

/**
 * Create a logger bound to an env (so tests can redirect via
 * AGENT_BRIDGE_HOME). `mirror` optionally receives human lines
 * (e.g. process stderr for CLI verbs / foreground service).
 */
export function makeEventLogger({ env = process.env, mirror = null } = {}) {
  const path = unifiedLogPath(env);
  return function logEvent(level, event, msg, context = {}) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      rotateIfNeeded(path);
      const record = {
        ts: new Date().toISOString(),
        component: "codex-channel",
        machine: machineName(),
        event,
        level,
        msg: truncate(redact(String(msg))),
        ...(context && Object.keys(context).length > 0 ? { context: sanitize(context) } : {}),
      };
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* fail-open — logging must never crash the channel */
    }
    if (mirror) {
      try {
        mirror(`[codex-channel] ${level.toUpperCase()} ${event} ${msg}`);
      } catch {
        /* ignore */
      }
    }
  };
}
