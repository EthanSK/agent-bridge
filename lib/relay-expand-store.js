/**
 * Local expand-id store for compact Agent Bridge relay notices.
 *
 * OpenClaw relay receipts are intentionally compact: they show a short,
 * human-referenceable expand id instead of dumping the inbound bridge message
 * body into Telegram/user channels. The full content is kept locally under
 * ~/.agent-bridge/relay-expand/ with a small rotating id space so agents can
 * later run `agent-bridge relay-expand <id>` when Ethan asks to expand one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_RELAY_EXPAND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RELAY_EXPAND_MAX_ENTRIES = 100;
export const DEFAULT_RELAY_EXPAND_ID_SPACE = 100;

const STORE_VERSION = 1;

export function defaultRelayExpandDir() {
  return join(homedir(), ".agent-bridge", "relay-expand");
}

export function defaultRelayExpandStorePath() {
  return process.env.AGENT_BRIDGE_RELAY_EXPAND_STORE
    || join(defaultRelayExpandDir(), "store.json");
}

export function normalizeExpandId(value) {
  const raw = String(value ?? "").trim().replace(/^#/, "");
  if (/^\d$/.test(raw)) return `0${raw}`;
  return raw;
}

export function storeRelayExpandMessage(msg, metadata = {}, opts = {}) {
  const storePath = opts.storePath || defaultRelayExpandStorePath();
  const nowMs = resolveNowMs(opts.now);
  const ttlMs = resolvePositiveInt(
    opts.ttlMs ?? envInt("AGENT_BRIDGE_RELAY_EXPAND_TTL_SECS", null)?.valueOf() * 1000,
    DEFAULT_RELAY_EXPAND_TTL_MS,
  );
  const maxEntries = Math.min(
    resolvePositiveInt(opts.maxEntries ?? envInt("AGENT_BRIDGE_RELAY_EXPAND_MAX_ENTRIES", null), DEFAULT_RELAY_EXPAND_MAX_ENTRIES),
    resolveIdSpace(opts.idSpace),
  );
  const idSpace = resolveIdSpace(opts.idSpace);
  ensureStoreDir(storePath);

  const store = pruneStore(readStore(storePath), nowMs, { maxEntries, idSpace });
  const allocation = allocateExpandId(store, { idSpace });
  const expandId = allocation.expandId;

  const record = {
    expandId,
    storedAt: new Date(nowMs).toISOString(),
    storedAtMs: nowMs,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    expiresAtMs: nowMs + ttlMs,
    message: normalizeBridgeMessage(msg),
    metadata: normalizeMetadata(metadata),
  };

  const entries = (store.entries || [])
    .filter((entry) => normalizeExpandId(entry?.expandId) !== expandId);
  entries.push(record);
  entries.sort((a, b) => Number(a?.storedAtMs || 0) - Number(b?.storedAtMs || 0));
  const boundedEntries = entries.slice(Math.max(0, entries.length - maxEntries));

  const nextStore = {
    version: STORE_VERSION,
    lastSeq: allocation.seq,
    updatedAt: record.storedAt,
    ttlMs,
    maxEntries,
    idSpace,
    entries: boundedEntries,
  };

  writeStore(storePath, nextStore);
  writeEntryFiles(storePath, record, boundedEntries);
  return record;
}

export function readRelayExpandEntry(expandId, opts = {}) {
  const normalized = normalizeExpandId(expandId);
  if (!normalized) return null;
  const storePath = opts.storePath || defaultRelayExpandStorePath();
  const nowMs = resolveNowMs(opts.now);
  const store = pruneStore(readStore(storePath), nowMs, {
    maxEntries: opts.maxEntries,
    idSpace: opts.idSpace,
  });
  const entry = (store.entries || []).find((candidate) => normalizeExpandId(candidate?.expandId) === normalized);
  if (!entry) return null;
  if (Number(entry.expiresAtMs || 0) <= nowMs) return null;
  return entry;
}

export function formatRelayExpandEntry(entry) {
  if (!entry) return "";
  const message = entry.message || {};
  const metadata = entry.metadata || {};
  const lines = [
    `Agent Bridge relay expand ${entry.expandId}`,
    `stored_at: ${entry.storedAt || ""}`,
    `expires_at: ${entry.expiresAt || ""}`,
  ];

  if (message.id) lines.push(`message_id: ${message.id}`);
  if (message.from) lines.push(`from: ${message.from}`);
  if (message.to) lines.push(`to: ${message.to}`);
  if (message.fromTarget) lines.push(`from_target: ${message.fromTarget}`);
  if (message.target) lines.push(`target: ${message.target}`);
  if (metadata.replyVia) lines.push(`reply_path: ${formatList(metadata.replyVia)}`);
  if (metadata.targetName) lines.push(`openclaw_target: ${metadata.targetName}`);
  const sourceVersion = metadata.sourceAgentBridgeVersion || message.sourceAgentBridgeVersion;
  if (sourceVersion) {
    lines.push(`source_agent_bridge_version: ${sourceVersion}`);
  }
  if (metadata.destinationAgentBridgeVersion) {
    lines.push(`destination_agent_bridge_version: ${metadata.destinationAgentBridgeVersion}`);
  }
  if (metadata.agentBridgeVersion) lines.push(`agent_bridge_version: ${metadata.agentBridgeVersion}`);
  if (message.timestamp) lines.push(`message_timestamp: ${message.timestamp}`);
  if (message.replyTo) lines.push(`reply_to: ${message.replyTo}`);
  lines.push("", "--- message ---", String(message.content ?? ""));
  return lines.join("\n");
}

export const __testing = {
  allocateExpandId,
  pruneStore,
  readStore,
  resolveIdSpace,
};

function allocateExpandId(store, { idSpace = DEFAULT_RELAY_EXPAND_ID_SPACE } = {}) {
  const liveIds = new Set((store.entries || []).map((entry) => normalizeExpandId(entry?.expandId)).filter(Boolean));
  const lastSeq = Number.isInteger(Number(store.lastSeq)) ? Number(store.lastSeq) : -1;
  const start = positiveModulo(lastSeq + 1, idSpace);

  for (let offset = 0; offset < idSpace; offset += 1) {
    const seq = positiveModulo(start + offset, idSpace);
    const candidate = formatSeq(seq, idSpace);
    if (!liveIds.has(candidate)) return { expandId: candidate, seq };
  }

  // Full id space: roll over deterministically to the next sequence. The
  // caller replaces that id's older record, keeping recent lookups stable while
  // bounding the store forever.
  const seq = start;
  return { expandId: formatSeq(seq, idSpace), seq };
}

function pruneStore(store, nowMs, { maxEntries, idSpace } = {}) {
  const limit = Math.min(
    resolvePositiveInt(maxEntries, DEFAULT_RELAY_EXPAND_MAX_ENTRIES),
    resolveIdSpace(idSpace),
  );
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(store.entries) ? store.entries : []) {
    const id = normalizeExpandId(entry?.expandId);
    if (!id || seen.has(id)) continue;
    if (Number(entry?.expiresAtMs || 0) <= nowMs) continue;
    seen.add(id);
    entries.push({ ...entry, expandId: id });
  }
  entries.sort((a, b) => Number(a?.storedAtMs || 0) - Number(b?.storedAtMs || 0));
  return {
    version: STORE_VERSION,
    lastSeq: Number.isInteger(Number(store.lastSeq)) ? Number(store.lastSeq) : -1,
    updatedAt: store.updatedAt || null,
    entries: entries.slice(Math.max(0, entries.length - limit)),
  };
}

function normalizeBridgeMessage(msg) {
  return {
    id: clean(msg?.id),
    from: clean(msg?.from),
    to: clean(msg?.to),
    fromTarget: clean(msg?.fromTarget),
    target: clean(msg?.target),
    sourceAgentBridgeVersion: clean(
      msg?.sourceAgentBridgeVersion
        ?? msg?.agentBridgeVersion
        ?? msg?.agent_bridge_version,
    ),
    type: clean(msg?.type),
    content: String(msg?.content ?? ""),
    timestamp: clean(msg?.timestamp),
    replyTo: clean(msg?.replyTo ?? msg?.reply_to),
    ttl: msg?.ttl ?? null,
  };
}

function normalizeMetadata(metadata) {
  return {
    targetName: clean(metadata?.targetName),
    replyVia: Array.isArray(metadata?.replyVia)
      ? metadata.replyVia.map((v) => clean(v)).filter(Boolean)
      : clean(metadata?.replyVia),
    sourceAgentBridgeVersion: clean(metadata?.sourceAgentBridgeVersion),
    destinationAgentBridgeVersion: clean(
      metadata?.destinationAgentBridgeVersion
        ?? metadata?.agentBridgeVersion
        ?? metadata?.version,
    ),
    agentBridgeVersion: clean(
      metadata?.agentBridgeVersion
        ?? metadata?.destinationAgentBridgeVersion
        ?? metadata?.version,
    ),
  };
}

function writeEntryFiles(storePath, record, liveEntries) {
  const dir = dirname(storePath);
  const jsonPath = join(dir, `${record.expandId}.json`);
  const textPath = join(dir, `${record.expandId}.txt`);
  writeAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  writeAtomic(textPath, `${formatRelayExpandEntry(record)}\n`, 0o600);

  const liveIds = new Set(liveEntries.map((entry) => normalizeExpandId(entry?.expandId)).filter(Boolean));
  try {
    for (const name of readdirSync(dir)) {
      const match = /^(\d{2})\.(json|txt)$/.exec(name);
      if (match && !liveIds.has(match[1])) {
        unlinkSync(join(dir, name));
      }
    }
  } catch {
    // Best-effort cleanup only. The bounded store.json remains authoritative.
  }
}

function readStore(storePath) {
  if (!existsSync(storePath)) return { version: STORE_VERSION, lastSeq: -1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return { version: STORE_VERSION, lastSeq: -1, entries: [] };
    return parsed;
  } catch {
    return { version: STORE_VERSION, lastSeq: -1, entries: [] };
  }
}

function writeStore(storePath, store) {
  writeAtomic(storePath, `${JSON.stringify(store, null, 2)}\n`, 0o600);
}

function writeAtomic(path, content, mode) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function ensureStoreDir(storePath) {
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
}

function resolveNowMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function resolvePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveIdSpace(value) {
  const n = resolvePositiveInt(value, DEFAULT_RELAY_EXPAND_ID_SPACE);
  return Math.min(Math.max(n, 1), DEFAULT_RELAY_EXPAND_ID_SPACE);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function formatSeq(seq, idSpace) {
  const width = idSpace <= 100 ? 2 : String(idSpace - 1).length;
  return String(seq).padStart(width, "0");
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function formatList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return String(value ?? "");
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
