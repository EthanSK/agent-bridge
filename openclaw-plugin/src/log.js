/**
 * Unified structured event log for agent-bridge (JS, openclaw-plugin + daemon).
 *
 * Twin of mcp-server/src/log.ts. Both write NDJSON to the same file:
 *   ~/.agent-bridge/logs/agent-bridge.log
 *
 * Each line:
 *   { ts, component, machine, event, level, msg, context? }
 *
 * Design notes and secret-redaction rules mirror the TypeScript version —
 * any change here should be mirrored there, and vice-versa.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGS_DIR = join(homedir(), ".agent-bridge", "logs");
const LOG_FILE_NAME = "agent-bridge.log";
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
const ROTATION_CHECK_INTERVAL = 50;
const MAX_CONTEXT_STRING = 2000;

let writesSinceRotationCheck = 0;
let logsDirVerified = false;
let cachedMachine = null;

function ensureLogsDir() {
  if (logsDirVerified) return;
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
  } catch {
    /* ignore — stderr fallback handles the write failure */
  }
  logsDirVerified = true;
}

function logPath() {
  return join(LOGS_DIR, LOG_FILE_NAME);
}

function rotatedPath() {
  return join(LOGS_DIR, `${LOG_FILE_NAME}.1`);
}

function rotateIfNeeded() {
  writesSinceRotationCheck++;
  if (writesSinceRotationCheck < ROTATION_CHECK_INTERVAL) return;
  writesSinceRotationCheck = 0;
  try {
    const p = logPath();
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.size <= MAX_LOG_SIZE) return;
    renameSync(p, rotatedPath());
  } catch {
    /* ignore */
  }
}

function getMachine() {
  if (cachedMachine !== null) return cachedMachine;
  try {
    cachedMachine = hostname().replace(/\.local$/, "");
  } catch {
    cachedMachine = "unknown";
  }
  return cachedMachine;
}

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

function redactString(input) {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function truncateString(input) {
  if (input.length <= MAX_CONTEXT_STRING) return input;
  return `${input.slice(0, MAX_CONTEXT_STRING)}…[truncated ${input.length - MAX_CONTEXT_STRING}]`;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(redactString(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(redactString(value.message || "")),
      stack: value.stack ? truncateString(redactString(value.stack)) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Append one NDJSON event to ~/.agent-bridge/logs/agent-bridge.log.
 *
 * @param {object} opts
 * @param {string} opts.component   Origin component name ("openclaw-plugin" or "openclaw-daemon" or "cli")
 * @param {string} opts.event       Dotted event name, e.g. "inbox.message.delivered"
 * @param {"info"|"warn"|"error"} [opts.level]
 * @param {string} opts.msg         Human-readable sentence
 * @param {object} [opts.context]   Arbitrary structured fields (sanitized)
 */
export function logEvent({ component, event, level = "info", msg, context }) {
  ensureLogsDir();
  rotateIfNeeded();

  const record = {
    ts: new Date().toISOString(),
    component: component || "openclaw-plugin",
    machine: getMachine(),
    event,
    level,
    msg: truncateString(redactString(String(msg ?? ""))),
    ...(context ? { context: sanitize(context) } : {}),
  };

  let line;
  try {
    line = JSON.stringify(record) + "\n";
  } catch (err) {
    line = JSON.stringify({
      ts: record.ts,
      component: record.component,
      machine: record.machine,
      event,
      level: "warn",
      msg: `[log.js] failed to serialize event ${event}: ${String(err)}`,
    }) + "\n";
  }

  try {
    appendFileSync(logPath(), line);
  } catch (err) {
    try {
      process.stderr.write(`[agent-bridge.log fallback] ${line}`);
      process.stderr.write(`[agent-bridge.log fallback] write error: ${String(err)}\n`);
    } catch {
      /* swallow */
    }
  }
}

/** Curry a component name so call sites don't repeat themselves. */
export function makeLogger(component) {
  return (opts) => logEvent({ component, ...opts });
}
