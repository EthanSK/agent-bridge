/**
 * Unified structured event log for agent-bridge.
 *
 * Writes NDJSON (one JSON object per line) to
 *   ~/.agent-bridge/logs/agent-bridge.log
 *
 * Every component (mcp-server, openclaw-plugin, CLI) appends to the SAME file
 * so an operator or AI agent can tail one log and see the full end-to-end
 * picture. See AGENTS.md in the repo root for query patterns.
 *
 * Design goals:
 *   - NDJSON: grep/jq-friendly, one event per line.
 *   - Concurrency-safe: plain appendFile — POSIX guarantees atomic appends
 *     up to PIPE_BUF for O_APPEND fds, which Node.js gives us on the
 *     underlying write(2).
 *   - Self-rotating: rename to `.1` when file exceeds ~50 MB.
 *   - Secret-safe: redact API-key / bearer-token / JWT patterns from
 *     any context value before writing.
 *   - Size-bounded context: truncate giant strings to ~2000 chars so a
 *     single huge payload can't blow the log out.
 *   - Fail-open: if the log can't be written for any reason, fall back
 *     to stderr and swallow the error — logging must never crash the
 *     server.
 *
 * This is ADDITIVE. The existing verbose logger.ts (mcp-server.log) is
 * untouched; unified events go into agent-bridge.log alongside it.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { LOGS_DIR } from './config.js';

const LOG_FILE_NAME = 'agent-bridge.log';
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB — rotate when exceeded
const ROTATION_CHECK_INTERVAL = 50;    // amortize: stat() once every N writes
const MAX_CONTEXT_STRING = 2000;        // truncate individual string values

let writesSinceRotationCheck = 0;
let logsDirVerified = false;
let cachedMachine: string | null = null;

function ensureLogsDir(): void {
  if (logsDirVerified) return;
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
  } catch {
    /* fall through — appendFileSync will also fail and we'll stderr */
  }
  logsDirVerified = true;
}

function logPath(): string {
  return join(LOGS_DIR, LOG_FILE_NAME);
}

function rotatedPath(): string {
  return join(LOGS_DIR, `${LOG_FILE_NAME}.1`);
}

function rotateIfNeeded(): void {
  writesSinceRotationCheck++;
  if (writesSinceRotationCheck < ROTATION_CHECK_INTERVAL) return;
  writesSinceRotationCheck = 0;

  try {
    const p = logPath();
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.size <= MAX_LOG_SIZE) return;
    // Overwrite previous .1 (single-generation rotation — keep it simple).
    renameSync(p, rotatedPath());
  } catch {
    /* ignore rotation errors; never block logging */
  }
}

function getMachine(): string {
  if (cachedMachine !== null) return cachedMachine;
  try {
    cachedMachine = hostname().replace(/\.local$/, '');
  } catch {
    cachedMachine = 'unknown';
  }
  return cachedMachine;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * Secret patterns redacted in logged context values.
 *
 * Tuned for false-positive safety: we only blast through known high-confidence
 * prefixes (Anthropic, OpenAI, Slack bot tokens, Bearer headers, JWT-style
 * three-segment base64 blobs, GitHub/Stripe prefixes).
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,            // OpenAI / Anthropic
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /ghp_[A-Za-z0-9]{30,}/g,             // GitHub PAT
  /gho_[A-Za-z0-9]{30,}/g,             // GitHub OAuth
  /github_pat_[A-Za-z0-9_]{30,}/g,     // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g,                 // AWS access key id
  /(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, // Bearer tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function truncateString(input: string): string {
  if (input.length <= MAX_CONTEXT_STRING) return input;
  return `${input.slice(0, MAX_CONTEXT_STRING)}…[truncated ${input.length - MAX_CONTEXT_STRING}]`;
}

/** Recursively sanitize a context value: redact secrets + truncate strings. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'; // guard against cycles / pathological nesting
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(redactString(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(redactString(value.message)),
      stack: value.stack ? truncateString(redactString(value.stack)) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ── Public API ───────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEventInput {
  event: string;
  level?: LogLevel;
  msg: string;
  context?: Record<string, unknown>;
}

/**
 * Append one NDJSON event to the unified agent-bridge log.
 *
 * Never throws. On failure, falls back to stderr.
 */
export function logEvent(input: LogEventInput): void {
  ensureLogsDir();
  rotateIfNeeded();

  const record = {
    ts: new Date().toISOString(),
    component: 'mcp-server',
    machine: getMachine(),
    event: input.event,
    level: input.level ?? 'info',
    msg: truncateString(redactString(input.msg)),
    ...(input.context ? { context: sanitize(input.context) } : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(record) + '\n';
  } catch (err) {
    // Circular references or similar — last-ditch flatten.
    line = JSON.stringify({
      ts: record.ts,
      component: record.component,
      machine: record.machine,
      event: record.event,
      level: 'warn',
      msg: `[log.ts] failed to serialize event ${input.event}: ${String(err)}`,
    }) + '\n';
  }

  try {
    appendFileSync(logPath(), line);
  } catch (err) {
    try {
      process.stderr.write(`[agent-bridge.log fallback] ${line}`);
      process.stderr.write(`[agent-bridge.log fallback] write error: ${String(err)}\n`);
    } catch {
      /* truly nowhere to go — swallow */
    }
  }
}
