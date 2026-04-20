/**
 * Inbox watcher for the openclaw side of agent-bridge.
 *
 * As of v2.1.0 the single global inbox has been split into per-harness /
 * per-target subdirs under `~/.agent-bridge/inbox/`. This watcher walks
 * `inbox/openclaw/<targetName>/*.json` for each configured target and
 * dispatches messages to the caller-provided handler, tagging each dispatch
 * with the target name so `index.js` can route into the matching Telegram
 * session.
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
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseBridgeMessage } from "./envelope.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_INBOX_ROOT = join(homedir(), ".agent-bridge", "inbox");
const DEFAULT_LEDGER = join(homedir(), ".agent-bridge", ".openclaw-v2-delivered");
const OPENCLAW_HARNESS_PREFIX = "openclaw";

/**
 * @typedef {Object} TargetSpec
 * @property {string} name               e.g. "default", "clawdiboi2"
 * @property {string} dir                absolute path of the watched subdir
 * @property {object} config             resolved target config block (openclaw_channel, account, peer_id, ...)
 */

/**
 * Start the multi-target inbox watcher.
 *
 * @param {object} opts
 * @param {string} [opts.inboxRoot]      absolute path of ~/.agent-bridge/inbox (defaults to homedir/.agent-bridge/inbox)
 * @param {string} [opts.ledgerPath]     absolute path of the delivered-id ledger
 * @param {number} [opts.pollIntervalMs] polling interval per subdir (default 2000)
 * @param {object} [opts.logger]         logger with {info,warn,error,debug}
 * @param {Record<string, object>} opts.targets  map of <targetName> -> target config. The watcher creates and watches a subdir per target.
 * @param {(msg: object, ctx: {filePath:string, target:TargetSpec}) => Promise<void>|void} opts.onMessage
 * @returns {() => void} stop fn
 */
export function startInboxWatcher(opts) {
  const inboxRoot = opts.inboxRoot ?? DEFAULT_INBOX_ROOT;
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER;
  const pollMs = Math.max(500, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  const log = opts.logger ?? console;
  const onMessage = opts.onMessage;
  const targetsMap = opts.targets ?? {};
  const failedRoot = failedRootFor(inboxRoot);
  const unroutedDir = unroutedSubdir(inboxRoot);

  // Ensure the harness root + each target subdir exist up front so the host
  // can drop files in straight away. Also mkdir the `_unrouted/` quarantine
  // dir so legacy flat files have a place to land.
  mkdirSync(join(inboxRoot, OPENCLAW_HARNESS_PREFIX), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(unroutedDir, { recursive: true });

  /** @type {TargetSpec[]} */
  const targets = Object.keys(targetsMap).flatMap((name) => {
    if (!isValidTargetName(name)) {
      log.warn?.(`target "${name}" has an invalid subdir name — skipping`);
      return [];
    }
    const dir = join(inboxRoot, OPENCLAW_HARNESS_PREFIX, name);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.warn?.(`unable to mkdir target dir ${dir}: ${err?.message ?? err}`);
    }
    return [{ name, dir, config: targetsMap[name] }];
  });

  if (targets.length === 0) {
    log.warn?.(
      "inbox watcher: no targets configured — the plugin will not dispatch any messages. "
      + 'Add `channels["agent-bridge"].config.targets = { default: {...}, ... }` to openclaw.json.',
    );
  } else {
    log.info?.(
      `watching ${targets.length} target(s) under ${inboxRoot}/${OPENCLAW_HARNESS_PREFIX}/: `
      + targets.map((t) => t.name).join(", "),
    );
  }

  const delivered = loadLedger(ledgerPath);
  let stopped = false;
  let timer = null;
  let scanning = false;

  async function scanOneTarget(target) {
    const entries = safeReaddir(target.dir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const fullPath = join(target.dir, name);
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
        log.warn?.(`unable to read ${target.name}/${name}: ${err?.message ?? err}`);
        continue;
      }
      const msg = parseBridgeMessage(raw);
      if (!msg) {
        log.warn?.(`inbox: skipping invalid envelope ${target.name}/${name}`);
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      const expectedTarget = `${OPENCLAW_HARNESS_PREFIX}/${target.name}`;
      if (msg.target !== expectedTarget) {
        log.warn?.(
          `inbox: target mismatch for ${target.name}/${name}: expected ${expectedTarget}, got ${JSON.stringify(msg.target ?? null)}`,
        );
        quarantine(fullPath, target.name, failedRoot);
        continue;
      }
      if (delivered.has(msg.id)) continue;

      try {
        const deliveredOk = await onMessage(msg, { filePath: fullPath, target });
        if (deliveredOk === false) continue;
        delivered.add(msg.id);
        appendLedger(ledgerPath, msg.id);
      } catch (err) {
        log.error?.(`inbox: dispatch failed for ${target.name}/${msg.id}: ${err?.stack || err}`);
      }
    }
  }

  async function scanUnrouted() {
    // Sweep any flat-file messages sitting at the root of inbox/openclaw/ or
    // at the root of inbox/ itself (legacy senders running agent-bridge < 3.4.0).
    // These can't be routed deterministically — per design there's no default
    // routing — so shove them into .failed/_unrouted/ with a loud log line.
    const legacyCandidates = [
      inboxRoot,
      join(inboxRoot, OPENCLAW_HARNESS_PREFIX),
    ];
    for (const legacyDir of legacyCandidates) {
      try {
        const entries = readdirSync(legacyDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".json")) continue;
          const src = join(legacyDir, entry.name);
          const dest = join(unroutedDir, entry.name);
          try {
            renameSync(src, dest);
            log.warn?.(
              `Legacy flat-file inbox message moved to ${unroutedDir}: ${entry.name}. `
              + `Senders must set BridgeMessage.target (e.g. "openclaw/clawdiboi2").`,
            );
          } catch (err) {
            log.error?.(`failed to quarantine legacy ${src}: ${err?.message ?? err}`);
          }
        }
      } catch {
        /* dir may not exist yet */
      }
    }
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await scanUnrouted();
      for (const target of targets) {
        if (stopped) break;
        await scanOneTarget(target);
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

function failedRootFor(inboxRoot) {
  return join(inboxRoot, ".failed");
}

function unroutedSubdir(inboxRoot) {
  return join(failedRootFor(inboxRoot), "_unrouted");
}

function isValidTargetName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
  );
}

function quarantine(filePath, targetName, failedRoot) {
  try {
    const failedDir = join(failedRoot, `${OPENCLAW_HARNESS_PREFIX}__${targetName}`);
    mkdirSync(failedDir, { recursive: true });
    const base = filePath.split("/").pop();
    renameSync(filePath, join(failedDir, base));
  } catch {
    // last-resort rename-in-place
    try {
      renameSync(filePath, filePath + ".bad");
    } catch {
      /* ignore */
    }
  }
}

export const __testing = {
  DEFAULT_INBOX_ROOT,
  DEFAULT_LEDGER,
  UNROUTED_SUBDIR: unroutedSubdir(DEFAULT_INBOX_ROOT),
  OPENCLAW_HARNESS_PREFIX,
};
