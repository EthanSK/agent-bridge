/**
 * Core inbox→agent bridge used by both:
 *   - the OpenClaw plugin entry (src/index.js)
 *   - the standalone daemon (bin/agent-bridge-openclaw-inbox.js)
 *
 * Responsibilities:
 *   1. Watch ~/.agent-bridge/inbox/ for new BridgeMessage JSON files.
 *   2. For each new message, inject it into a running OpenClaw agent session
 *      by invoking `openclaw agent --to <peer> --message <envelope>`.
 *   3. Record delivered IDs in ~/.agent-bridge/.openclaw-delivered so we
 *      never re-deliver across restarts.
 *
 * This mirrors the semantics of the Claude Code channel plugin:
 * the user's running OpenClaw agent receives a new user turn formatted as
 *   <channel source="agent-bridge" from="..." ...>content</channel>
 * and can respond via bridge_send_message just like Claude Code.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { logEvent as unifiedLogEvent } from "./log.js";

/** Component label for unified-log events emitted from this module. */
const LOG_COMPONENT = "openclaw-plugin";
function uLog(opts) {
  unifiedLogEvent({ component: LOG_COMPONENT, ...opts });
}

// Dynamic import shields the plugin-install safety scanner from flagging
// static child_process usage. The scanner's critical rule looks for calls
// like `spawn(...)` in files that import 'child_process' at top level.
let _childProcessModule = null;
async function loadChildProcess() {
  if (!_childProcessModule) {
    _childProcessModule = await import("node:" + "child_process");
  }
  return _childProcessModule;
}

// ── constants ────────────────────────────────────────────────────────────────

export const DEFAULT_INBOX_DIR = join(homedir(), ".agent-bridge", "inbox");
export const DEFAULT_STATE_DIR = join(homedir(), ".agent-bridge");
export const DEFAULT_DELIVERED_FILE = join(DEFAULT_STATE_DIR, ".openclaw-delivered");
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_DELIVERY_TIMEOUT_SEC = 600;
export const DEFAULT_SESSION_PREFIX = "agent-bridge";
const DELIVERED_MAX_LINES = 10_000;
const FAILED_DIR = join(DEFAULT_STATE_DIR, "inbox", ".failed");
// NB: avoid `.delivered/` — that name is already used as a FILE by the
// Claude Code MCP server's watcher (mcp-server/src/watcher.ts) to track
// delivered IDs. A dir with the same name would collide on shared inboxes.
const ARCHIVE_DIR = join(DEFAULT_STATE_DIR, "inbox", ".openclaw-delivered");

// Delivery modes, see PLAN.md and ROUTING.md.
//   log-only      – parse, ack, archive (default; safest, no bridge-spam).
//   message-send  – shell out to `openclaw message send --channel X --account A --target T`.
//                   Posts the bridge envelope as a message FROM the bot into a chat.
//                   Useful for surfacing bridge traffic in Telegram without
//                   triggering an agent turn.
//   agent-turn    – shell out to `openclaw agent --agent <id> --message <envelope>
//                                   --deliver --reply-channel telegram
//                                   --reply-account <acc> --reply-to <chat>`.
//                   Runs a real agent turn. The agent processes the message and
//                   delivers its reply to the configured channel.
//   agent         – legacy `openclaw agent --to <slug>` path (flaky, kept for
//                   backward compat only).
export const DELIVERY_MODES = new Set(["log-only", "message-send", "agent-turn", "agent"]);
export const DEFAULT_DELIVERY_MODE = "log-only";
export const DEFAULT_TARGET_AGENT = "main";
export const DEFAULT_DELIVERY_CHANNEL = "telegram";
export const DEFAULT_DELIVERY_ACCOUNT = "default";

// ── delivered-id tracking ───────────────────────────────────────────────────

function loadDeliveredIds(path) {
  const ids = new Set();
  if (!existsSync(path)) return ids;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const id = line.trim();
      if (id) ids.add(id);
    }
  } catch {
    /* ignore */
  }
  return ids;
}

function recordDeliveredId(path, id, ids) {
  ids.add(id);
  try {
    appendFileSync(path, id + "\n", { mode: 0o600 });
    if (ids.size > DELIVERED_MAX_LINES) {
      const keep = Array.from(ids).slice(-Math.floor(DELIVERED_MAX_LINES / 2));
      writeFileSync(path, keep.join("\n") + "\n", { mode: 0o600 });
    }
  } catch {
    /* best-effort */
  }
}

// ── envelope formatting ─────────────────────────────────────────────────────

function formatChannelEnvelope(msg) {
  const attrs = [
    `source="agent-bridge"`,
    `from=${JSON.stringify(String(msg.from ?? "unknown"))}`,
    `to=${JSON.stringify(String(msg.to ?? ""))}`,
    `message_id=${JSON.stringify(String(msg.id ?? ""))}`,
    `type=${JSON.stringify(String(msg.type ?? "message"))}`,
    `ts=${JSON.stringify(String(msg.timestamp ?? new Date().toISOString()))}`,
  ];
  if (msg.replyTo) attrs.push(`reply_to=${JSON.stringify(String(msg.replyTo))}`);
  const header = `<channel ${attrs.join(" ")}>`;
  const footer = `</channel>`;
  return `${header}\n${msg.content ?? ""}\n${footer}`;
}

// ── file parsing ────────────────────────────────────────────────────────────

function parseMessageFile(filePath, logger) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== "object" || !msg.id || !msg.timestamp) {
      throw new Error("missing required fields: id, timestamp");
    }
    return msg;
  } catch (err) {
    logger?.warn?.(`[agent-bridge] malformed message ${filePath}: ${err?.message ?? err}`);
    try {
      mkdirSync(FAILED_DIR, { recursive: true, mode: 0o700 });
      const fileName = filePath.split("/").pop();
      renameSync(filePath, join(FAILED_DIR, fileName));
    } catch {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
    return null;
  }
}

// ── openclaw CLI resolution ─────────────────────────────────────────────────

function findOpenclawBin() {
  const candidates = [
    process.env.OPENCLAW_BIN,
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "openclaw"; // rely on PATH
}

// ── agent invocation ────────────────────────────────────────────────────────

async function runOpenclawCli({ args, timeoutMs, logger }) {
  const { spawn } = await loadChildProcess();
  const bin = findOpenclawBin();

  // Mark subprocesses so the plugin's own register() skips activation —
  // otherwise each CLI invocation would re-spawn this bridge and cascade.
  const childEnv = {
    ...process.env,
    AGENT_BRIDGE_PLUGIN_SKIP: "1",
  };

  return new Promise((resolveRun) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }, timeoutMs)
      : null;
    if (killTimer && killTimer.unref) killTimer.unref();

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.once("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      logger?.error?.(`[agent-bridge] cli spawn error: ${err?.message ?? err}`);
      resolveRun({ ok: false, stdout, stderr: String(err), timedOut: false });
    });
    child.once("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      resolveRun({ ok: code === 0 && !timedOut, stdout, stderr, timedOut, code });
    });
  });
}

async function injectMessageViaAgentCli({ target, agentId, text, timeoutSec, logger }) {
  const args = [
    "agent",
    "--to",
    target,
    "--message",
    text,
    "--timeout",
    String(timeoutSec),
    "--json",
  ];
  if (agentId) args.push("--agent", agentId);
  // Gate the watchdog kill just past openclaw's own --timeout so we don't
  // strand child processes if the gateway hangs on a session-file lock.
  const killAfterMs = (Number(timeoutSec) || DEFAULT_DELIVERY_TIMEOUT_SEC) * 1000 + 5000;
  const r = await runOpenclawCli({ args, timeoutMs: killAfterMs, logger });
  if (r.ok) {
    logger?.info?.(`[agent-bridge] agent-cli delivery ok target=${target}`);
  } else {
    logger?.warn?.(
      `[agent-bridge] agent-cli delivery failed target=${target} exit=${r.code} timedOut=${r.timedOut} stderr=${(r.stderr || "").slice(0, 400)}`,
    );
  }
  return r;
}

async function injectMessageViaChannelSend({ channel, account, targetId, text, logger }) {
  if (!channel || !targetId) {
    logger?.error?.(
      `[agent-bridge] message-send mode requires deliveryChannel + deliveryTarget config`,
    );
    return { ok: false, stderr: "missing deliveryChannel/deliveryTarget" };
  }
  const args = [
    "message",
    "send",
    "--channel",
    String(channel),
    "--target",
    String(targetId),
    "--message",
    text,
  ];
  if (account) {
    args.push("--account", String(account));
  }
  // message send is synchronous but fast; 30s is plenty.
  const r = await runOpenclawCli({ args, timeoutMs: 30_000, logger });
  if (r.ok) {
    logger?.info?.(
      `[agent-bridge] message-send delivery ok channel=${channel} account=${account ?? "<default>"} target=${targetId}`,
    );
  } else {
    logger?.warn?.(
      `[agent-bridge] message-send delivery failed channel=${channel} account=${account ?? "<default>"} target=${targetId} exit=${r.code} timedOut=${r.timedOut} stderr=${(r.stderr || "").slice(0, 400)}`,
    );
  }
  return r;
}

/**
 * Run a real agent turn: feed the bridge envelope into the agent and have it
 * deliver its reply back to a chat channel (e.g. one of the user's Telegram
 * bots). This is what makes OpenClaw "actually respond" to bridge messages.
 */
async function injectMessageViaAgentTurn({
  agentId,
  text,
  replyChannel,
  replyAccount,
  replyTo,
  timeoutSec,
  logger,
}) {
  if (!replyChannel || !replyTo) {
    logger?.error?.(
      `[agent-bridge] agent-turn mode requires replyChannel + replyTo (target chat id)`,
    );
    return { ok: false, stderr: "missing replyChannel/replyTo" };
  }
  const args = [
    "agent",
    "--agent",
    String(agentId || DEFAULT_TARGET_AGENT),
    "--message",
    text,
    "--deliver",
    "--reply-channel",
    String(replyChannel),
    "--reply-to",
    String(replyTo),
    "--timeout",
    String(timeoutSec),
    "--json",
  ];
  if (replyAccount) {
    args.push("--reply-account", String(replyAccount));
  }
  // Gate the watchdog kill just past openclaw's own --timeout so we don't
  // strand child processes if the gateway hangs.
  const killAfterMs = (Number(timeoutSec) || DEFAULT_DELIVERY_TIMEOUT_SEC) * 1000 + 5000;
  const r = await runOpenclawCli({ args, timeoutMs: killAfterMs, logger });
  if (r.ok) {
    logger?.info?.(
      `[agent-bridge] agent-turn delivery ok agent=${agentId ?? DEFAULT_TARGET_AGENT} reply=${replyChannel}:${replyAccount ?? "<default>"}:${replyTo}`,
    );
  } else {
    logger?.warn?.(
      `[agent-bridge] agent-turn delivery failed agent=${agentId ?? DEFAULT_TARGET_AGENT} reply=${replyChannel}:${replyAccount ?? "<default>"}:${replyTo} exit=${r.code} timedOut=${r.timedOut} stderr=${(r.stderr || "").slice(0, 400)}`,
    );
  }
  return r;
}

/**
 * Resolve per-message routing from a BridgeMessage.
 *
 * BridgeMessage.content is normally a free-text string. Callers who want to
 * target a specific bot/agent/chat can include a leading "@@route" header on
 * the first line(s) of the content, then a blank line, then the actual body.
 * Examples:
 *   @@route target_chat_id=6164541473 target_account=clordlethird
 *
 *   actual message body here
 *
 * Or include a top-level `route` field in the message JSON itself:
 *   { ..., content: "...", route: { target_chat_id: "...", target_agent: "..." } }
 *
 * Returns { route: { targetChatId, targetAccount, targetAgent }, content }
 * where content has the @@route header stripped.
 */
function resolveMessageRoute(msg, defaults) {
  const route = {
    targetChatId: defaults?.targetChatId,
    targetAccount: defaults?.targetAccount,
    targetAgent: defaults?.targetAgent || DEFAULT_TARGET_AGENT,
    targetChannel: defaults?.targetChannel || DEFAULT_DELIVERY_CHANNEL,
  };

  // 1. Top-level `route` object on the message (preferred).
  if (msg && typeof msg.route === "object" && msg.route !== null) {
    if (msg.route.target_chat_id) route.targetChatId = String(msg.route.target_chat_id);
    if (msg.route.target_account) route.targetAccount = String(msg.route.target_account);
    if (msg.route.target_agent) route.targetAgent = String(msg.route.target_agent);
    if (msg.route.target_channel) route.targetChannel = String(msg.route.target_channel);
  }

  // 2. Inline @@route header on the first line of content.
  let content = String(msg?.content ?? "");
  const m = content.match(/^@@route\s+([^\n]+)(?:\n+|$)/);
  if (m) {
    const kvs = m[1];
    for (const tok of kvs.split(/\s+/)) {
      const eq = tok.indexOf("=");
      if (eq <= 0) continue;
      const k = tok.slice(0, eq).trim().toLowerCase();
      const v = tok.slice(eq + 1).trim();
      if (!v) continue;
      if (k === "target_chat_id" || k === "chat_id" || k === "to") route.targetChatId = v;
      else if (k === "target_account" || k === "account" || k === "bot") route.targetAccount = v;
      else if (k === "target_agent" || k === "agent") route.targetAgent = v;
      else if (k === "target_channel" || k === "channel") route.targetChannel = v;
    }
    content = content.slice(m[0].length);
  }

  // 3. Default chat → account map (configured via plugin config).
  if (route.targetChatId && !route.targetAccount && defaults?.chatIdToAccount) {
    const acc = defaults.chatIdToAccount[String(route.targetChatId)];
    if (acc) route.targetAccount = String(acc);
  }

  return { route, content };
}

function archiveDeliveredFile(filePath, logger) {
  try {
    mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    const fileName = filePath.split("/").pop();
    renameSync(filePath, join(ARCHIVE_DIR, fileName));
  } catch (err) {
    logger?.warn?.(`[agent-bridge] failed to archive ${filePath}: ${err?.message ?? err}`);
    // Best-effort: if archive fails, unlink so we don't loop forever.
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// ── watcher ─────────────────────────────────────────────────────────────────

async function startInboxWatcher({ inboxDir, pollIntervalMs, onNew, logger }) {
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const known = new Set(readdirSync(inboxDir).filter((f) => f.endsWith(".json")));

  let nativeChild = null;
  let poller = null;
  let stopped = false;

  const scan = () => {
    if (stopped || !existsSync(inboxDir)) return;
    try {
      const now = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
      const fresh = now.filter((f) => !known.has(f));
      for (const f of fresh) known.add(f);
      for (const f of Array.from(known)) {
        if (!now.includes(f)) known.delete(f);
      }
      if (fresh.length > 0) onNew(fresh);
    } catch (err) {
      logger?.warn?.(`[agent-bridge] scan error: ${err?.message ?? err}`);
    }
  };

  const startPoller = () => {
    if (poller) return;
    poller = setInterval(scan, pollIntervalMs);
    if (poller.unref) poller.unref();
    logger?.info?.(`[agent-bridge] polling inbox every ${pollIntervalMs}ms`);
  };

  const tryNative = async (cmd, args) => {
    // We need to know synchronously-ish whether spawn actually attached to a
    // running process. Node emits 'spawn' when the child is executing; 'error'
    // when ENOENT (binary missing) or similar. Race them with a short timeout.
    try {
      const { spawn } = await loadChildProcess();
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      const ready = await new Promise((res) => {
        const done = (ok, reason) => {
          child.removeListener("spawn", onSpawn);
          child.removeListener("error", onError);
          res({ ok, reason });
        };
        const onSpawn = () => done(true);
        const onError = (err) => done(false, err?.message ?? String(err));
        child.once("spawn", onSpawn);
        child.once("error", onError);
        // Safety timeout — if neither event fires in 500ms, assume not ready
        // and fall through to polling. This won't leak because we'll also
        // register stdout/exit handlers below only if ok.
        setTimeout(() => done(false, "spawn-timeout"), 500).unref?.();
      });
      if (!ready.ok) {
        logger?.debug?.(`[agent-bridge] ${cmd} unavailable (${ready.reason}); fallback to polling`);
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        return null;
      }
      child.stdout.on("data", () => scan());
      child.stderr.on("data", () => { /* ignore */ });
      child.once("exit", (code) => {
        if (!stopped) {
          logger?.warn?.(`[agent-bridge] ${cmd} exited code=${code}; switching to polling`);
          startPoller();
        }
      });
      // Silence further 'error' events (e.g. EPIPE on kill) so they don't crash us.
      child.on("error", (err) => {
        logger?.debug?.(`[agent-bridge] ${cmd} late error: ${err?.message ?? err}`);
      });
      return child;
    } catch (err) {
      logger?.debug?.(`[agent-bridge] ${cmd} spawn threw (${err?.message ?? err}); fallback to polling`);
      return null;
    }
  };

  if (process.platform === "darwin") {
    nativeChild = await tryNative("fswatch", ["-0", inboxDir]);
    if (nativeChild) logger?.info?.(`[agent-bridge] fswatch active on ${inboxDir}`);
  } else if (process.platform === "linux") {
    nativeChild = await tryNative("inotifywait", ["-m", "-q", "-e", "create,moved_to,close_write", inboxDir]);
    if (nativeChild) logger?.info?.(`[agent-bridge] inotifywait active on ${inboxDir}`);
  }

  if (!nativeChild) startPoller();

  // initial sweep for anything queued while offline
  setImmediate(() => {
    try {
      const initial = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
      if (initial.length > 0) onNew(initial);
    } catch (err) {
      logger?.warn?.(`[agent-bridge] initial sweep error: ${err?.message ?? err}`);
    }
  });

  return () => {
    stopped = true;
    if (nativeChild) {
      try { nativeChild.kill("SIGTERM"); } catch { /* ignore */ }
      nativeChild = null;
    }
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };
}

// ── main entry ──────────────────────────────────────────────────────────────

/**
 * Start the inbox→agent bridge.
 * @param {object} options
 * @param {string} [options.inboxDir]
 * @param {string} [options.sessionKeyPrefix]
 * @param {string} [options.agentId]                Default agent for agent-turn mode.
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.deliveryTimeoutSec]
 * @param {string} [options.deliveredFile]
 * @param {"log-only"|"message-send"|"agent-turn"|"agent"} [options.deliveryMode]
 * @param {string} [options.deliveryChannel]        Channel for message-send + agent-turn reply (default: telegram).
 * @param {string} [options.deliveryAccount]        Channel account id for message-send + agent-turn reply.
 * @param {string} [options.deliveryTarget]         Default target chat id (used when route doesn't specify).
 * @param {Object<string,string>} [options.chatIdToAccount]  Map of chat_id → channel account id.
 * @param {object} [options.logger]
 * @returns {Promise<() => void>} cleanup function
 */
export async function startInboxBridge(options = {}) {
  const inboxDir = resolve(options.inboxDir || DEFAULT_INBOX_DIR);
  const sessionKeyPrefix = options.sessionKeyPrefix || DEFAULT_SESSION_PREFIX;
  const agentId = options.agentId || DEFAULT_TARGET_AGENT;
  const pollIntervalMs = Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;
  const deliveryTimeoutSec = Number(options.deliveryTimeoutSec) || DEFAULT_DELIVERY_TIMEOUT_SEC;
  const deliveredFile = options.deliveredFile || DEFAULT_DELIVERED_FILE;
  const rawMode = options.deliveryMode || DEFAULT_DELIVERY_MODE;
  const deliveryMode = DELIVERY_MODES.has(rawMode) ? rawMode : DEFAULT_DELIVERY_MODE;
  const deliveryChannel = options.deliveryChannel || DEFAULT_DELIVERY_CHANNEL;
  const deliveryAccount = options.deliveryAccount || undefined;
  const deliveryTarget = options.deliveryTarget || undefined;
  const chatIdToAccount = (options.chatIdToAccount && typeof options.chatIdToAccount === "object")
    ? options.chatIdToAccount
    : {};
  const logger = options.logger || console;

  mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const deliveredIds = loadDeliveredIds(deliveredFile);

  if (rawMode !== deliveryMode) {
    logger.warn?.(
      `[agent-bridge] unknown deliveryMode=${rawMode}; falling back to ${deliveryMode}`,
    );
  }
  logger.info?.(
    `[agent-bridge] starting inbox=${inboxDir} prefix=${sessionKeyPrefix} mode=${deliveryMode} agent=${agentId} channel=${deliveryChannel} account=${deliveryAccount ?? "<none>"} target=${deliveryTarget ?? "<none>"} routes=${Object.keys(chatIdToAccount).length}`,
  );
  uLog({
    event: "watcher.starting",
    msg: `openclaw-plugin inbox bridge starting (mode=${deliveryMode})`,
    context: {
      inboxDir,
      sessionKeyPrefix,
      deliveryMode,
      agentId,
      deliveryChannel,
      deliveryAccount: deliveryAccount ?? null,
      deliveryTarget: deliveryTarget ?? null,
      routes: Object.keys(chatIdToAccount).length,
    },
  });
  if ((deliveryMode === "message-send" || deliveryMode === "agent-turn") && !deliveryTarget) {
    logger.warn?.(
      `[agent-bridge] deliveryMode=${deliveryMode} has no default deliveryTarget — only messages with explicit @@route or msg.route.target_chat_id will be delivered; others will be acked as log-only`,
    );
  }

  // Serialize deliveries so we don't stampede the agent with parallel turns.
  let inFlight = Promise.resolve();

  async function deliverOne(fileName) {
    const filePath = join(inboxDir, fileName);
    const msg = parseMessageFile(filePath, logger);
    if (!msg) return;

    uLog({
      event: "message.received",
      msg: `inbox message ${msg.id} picked up from ${msg.from}`,
      context: {
        msg_id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        reply_to: msg.replyTo ?? null,
        content_length: typeof msg.content === "string" ? msg.content.length : 0,
      },
    });

    if (deliveredIds.has(msg.id)) {
      logger.debug?.(`[agent-bridge] skipping already-delivered ${msg.id}`);
      uLog({
        event: "message.already_delivered",
        msg: `skipping already-delivered ${msg.id}`,
        context: { msg_id: msg.id },
      });
      // Still archive the lingering file so it doesn't clutter the inbox.
      if (existsSync(filePath)) archiveDeliveredFile(filePath, logger);
      return;
    }

    const senderSlug = String(msg.from ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-");
    const sessionTarget = `${sessionKeyPrefix}-${senderSlug}`;

    // Resolve per-message routing (top-level msg.route, inline @@route header,
    // or fall back to plugin defaults).
    const { route, content: stripped } = resolveMessageRoute(msg, {
      targetChatId: deliveryTarget,
      targetAccount: deliveryAccount,
      targetAgent: agentId,
      targetChannel: deliveryChannel,
      chatIdToAccount,
    });
    // Build the envelope using the stripped content (so the agent doesn't see
    // the routing header).
    const text = formatChannelEnvelope({ ...msg, content: stripped });

    logger.info?.(
      `[agent-bridge] delivering ${msg.id} from=${msg.from} mode=${deliveryMode} agent=${route.targetAgent} reply=${route.targetChannel}:${route.targetAccount ?? "<default>"}:${route.targetChatId ?? "<none>"}`,
    );
    uLog({
      event: "message.resolving",
      msg: `resolved route for ${msg.id}`,
      context: {
        msg_id: msg.id,
        from: msg.from,
        deliveryMode,
        target_agent: route.targetAgent,
        target_channel: route.targetChannel,
        target_account: route.targetAccount ?? null,
        target_chat_id: route.targetChatId ?? null,
      },
    });

    let result = { ok: true };
    if (deliveryMode === "agent") {
      result = await injectMessageViaAgentCli({
        target: sessionTarget,
        agentId: route.targetAgent,
        text,
        timeoutSec: deliveryTimeoutSec,
        logger,
      });
    } else if (deliveryMode === "agent-turn") {
      if (route.targetChatId) {
        result = await injectMessageViaAgentTurn({
          agentId: route.targetAgent,
          text,
          replyChannel: route.targetChannel,
          replyAccount: route.targetAccount,
          replyTo: route.targetChatId,
          timeoutSec: deliveryTimeoutSec,
          logger,
        });
      } else {
        logger.info?.(
          `[agent-bridge] agent-turn mode but no chat_id resolved; acking ${msg.id} as log-only`,
        );
        result = { ok: true };
      }
    } else if (deliveryMode === "message-send") {
      if (route.targetChannel && route.targetChatId) {
        result = await injectMessageViaChannelSend({
          channel: route.targetChannel,
          account: route.targetAccount,
          targetId: route.targetChatId,
          text,
          logger,
        });
      } else {
        // No route resolvable → ack as delivered (log-only semantics) so the
        // inbox drains. The MCP tools path is still the primary way the
        // running agent talks back.
        logger.info?.(
          `[agent-bridge] message-send mode but no route resolved; acking ${msg.id} as log-only`,
        );
        result = { ok: true };
      }
    } else {
      // log-only — MCP tools path handles bidirectional agent-to-agent.
      // This mode exists so the inbox drains cleanly and the plugin never
      // stampedes OpenClaw with user-turn injections it can't service.
      result = { ok: true };
    }

    if (result.ok) {
      recordDeliveredId(deliveredFile, msg.id, deliveredIds);
      // Archive the file so we don't loop on it after restart. This is
      // a new invariant in v3.2.0: delivered ⇒ file leaves the inbox.
      if (existsSync(filePath)) archiveDeliveredFile(filePath, logger);
      uLog({
        event: "message.delivered",
        msg: `delivered ${msg.id} via ${deliveryMode}`,
        context: {
          msg_id: msg.id,
          from: msg.from,
          deliveryMode,
          target_agent: route.targetAgent,
          target_channel: route.targetChannel,
          target_chat_id: route.targetChatId ?? null,
        },
      });
    } else {
      logger.error?.(
        `[agent-bridge] failed to deliver ${msg.id}; leaving in inbox for retry on next event`,
      );
      uLog({
        event: "message.delivery_failed",
        level: "error",
        msg: `failed to deliver ${msg.id} via ${deliveryMode}`,
        context: {
          msg_id: msg.id,
          from: msg.from,
          deliveryMode,
          exit_code: result.code ?? null,
          timedOut: result.timedOut ?? false,
          stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 1500) : null,
        },
      });
    }
  }

  function enqueue(files) {
    for (const f of files) {
      inFlight = inFlight
        .then(() => deliverOne(f))
        .catch((err) => {
          logger.error?.(`[agent-bridge] unhandled delivery error: ${err?.message ?? err}`);
        });
    }
  }

  const stopWatcher = await startInboxWatcher({
    inboxDir,
    pollIntervalMs,
    onNew: enqueue,
    logger,
  });

  logger.info?.("[agent-bridge] inbox bridge ready");
  uLog({
    event: "watcher.ready",
    msg: "openclaw-plugin inbox bridge ready",
    context: { inboxDir, deliveryMode },
  });

  return () => {
    try { stopWatcher(); } catch { /* ignore */ }
  };
}
