/**
 * Inbox watcher for ~/.agent-bridge/inbox/*.json
 *
 * Polls the inbox directory at a configurable interval (default 2000ms),
 * parses each new BridgeMessage JSON, and dispatches it to a caller-provided
 * handler. Delivered IDs are tracked so restarts don't re-inject old messages.
 *
 * Zero external dependencies — Node builtins only (fs, path, os).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseBridgeMessage } from "./envelope.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_INBOX = join(homedir(), ".agent-bridge", "inbox");
const DEFAULT_LEDGER = join(homedir(), ".agent-bridge", ".openclaw-v2-delivered");

/**
 * @param {object} opts
 * @param {string} [opts.inboxDir]
 * @param {string} [opts.ledgerPath]
 * @param {number} [opts.pollIntervalMs]
 * @param {object} [opts.logger]
 * @param {(msg: object, filePath: string) => Promise<void>|void} opts.onMessage
 * @returns {() => void} stop fn
 */
export function startInboxWatcher(opts) {
  const inboxDir = opts.inboxDir ?? DEFAULT_INBOX;
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER;
  const pollMs = Math.max(500, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  const log = opts.logger ?? console;
  const onMessage = opts.onMessage;

  // Ensure inbox + ledger dir exist.
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const delivered = loadLedger(ledgerPath);
  let stopped = false;
  let timer = null;
  let scanning = false;

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const entries = safeReaddir(inboxDir);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const fullPath = join(inboxDir, name);
        let st;
        try {
          st = statSync(fullPath);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;

        let raw;
        try {
          raw = readFileSync(fullPath, "utf8");
        } catch (err) {
          log.warn?.(`unable to read ${name}: ${err?.message ?? err}`);
          continue;
        }
        const msg = parseBridgeMessage(raw);
        if (!msg) {
          log.warn?.(`inbox: skipping invalid envelope ${name}`);
          quarantine(fullPath);
          continue;
        }
        if (delivered.has(msg.id)) continue;

        try {
          await onMessage(msg, fullPath);
          delivered.add(msg.id);
          appendLedger(ledgerPath, msg.id);
        } catch (err) {
          log.error?.(`inbox: dispatch failed for ${msg.id}: ${err?.stack || err}`);
        }
      }
    } finally {
      scanning = false;
      if (!stopped) {
        timer = setTimeout(scan, pollMs);
      }
    }
  }

  // Kick off first scan on next tick so the host finishes registering first.
  timer = setTimeout(scan, 250);

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadLedger(path) {
  const set = new Set();
  if (!existsSync(path)) return set;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t) set.add(t);
    }
  } catch {
    /* ignore */
  }
  return set;
}

function appendLedger(path, id) {
  try {
    appendFileSync(path, id + "\n");
  } catch {
    /* ignore */
  }
}

function quarantine(filePath) {
  try {
    renameSync(filePath, filePath + ".bad");
  } catch {
    /* ignore */
  }
}

export const __testing = { DEFAULT_INBOX, DEFAULT_LEDGER };
