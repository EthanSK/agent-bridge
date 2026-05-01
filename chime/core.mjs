import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const BRIDGE_HOME = process.env.AGENT_BRIDGE_HOME
  ? process.env.AGENT_BRIDGE_HOME.replace(/^~/, homedir())
  : join(homedir(), ".agent-bridge");
export const BRIDGE_CONFIG_FILE = join(BRIDGE_HOME, "config");
export const BRIDGE_KEYS_DIR = join(BRIDGE_HOME, "keys");
export const BRIDGE_INBOX_DIR = join(BRIDGE_HOME, "inbox");
export const BRIDGE_OUTBOX_DIR = join(BRIDGE_HOME, "outbox");
export const CHIME_DIR = join(BRIDGE_HOME, "chime");
export const CHIME_CONFIG_FILE = join(CHIME_DIR, "config.json");
export const CHIME_STATE_FILE = join(CHIME_DIR, "state.json");
export const CHIME_LOG_FILE = join(CHIME_DIR, "chime.log");
export const CHIME_ACTIVE_DIR = join(CHIME_DIR, "active");
export const CHIME_LOCK_FILE = join(BRIDGE_HOME, "locks", "agent-bridge-chime.lock.json");
export const CHIME_TARGET = "agent-bridge/chime";
export const CHIME_SOURCE_TARGET = "agent-bridge-chime";
export const CHIME_ARCHIVE_DIR = join(BRIDGE_HOME, "archive", "agent-bridge", "chime");
export const CHIME_INBOX_DIR = join(BRIDGE_INBOX_DIR, "agent-bridge", "chime");
export const MACHINE_NAME_FILE = join(BRIDGE_HOME, "machine-name");

export const BUILTIN_SOUNDS = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
  "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
];

export const DEFAULT_CONFIG = {
  enabled: true,
  scope: "fleet",
  playback: "local",
  perAgentSound: "Glass",
  allCompleteSound: "Hero",
  volume: 1.0,
  stalePeerSeconds: 90,
  activeLockTtlSeconds: 1800,
  heartbeatSeconds: 30,
  allCompleteCooldownSeconds: 4,
  historyLimit: 200,
};

export const EMPTY_STATE = {
  sources: {},
  processedControlEvents: [],
  lastFleetActiveCount: 0,
  lastAllCompleteTs: 0,
  history: [],
};

export function ensureChimeDirs() {
  for (const dir of [
    BRIDGE_HOME,
    join(BRIDGE_HOME, "locks"),
    join(BRIDGE_HOME, "archive"),
    join(BRIDGE_HOME, "archive", "agent-bridge"),
    CHIME_DIR,
    CHIME_ACTIVE_DIR,
    CHIME_ARCHIVE_DIR,
    CHIME_INBOX_DIR,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function localMachineName() {
  const env = process.env.AGENT_BRIDGE_MACHINE_NAME?.trim();
  if (env) return env;
  if (existsSync(MACHINE_NAME_FILE)) {
    const pinned = readFileSync(MACHINE_NAME_FILE, "utf8").trim();
    if (pinned) return pinned;
  }
  return hostname().replace(/\.local$/i, "");
}

function withLock(lockFile, fn) {
  const started = Date.now();
  let fd;
  while (true) {
    try {
      fd = openSync(lockFile, "wx");
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = statSync(lockFile);
        if (Date.now() - st.mtimeMs > 30_000) {
          try { unlinkSync(lockFile); } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - started > 5_000) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      try { unlinkSync(lockFile); } catch {}
    }
  }
}

export function loadChimeConfig() {
  ensureChimeDirs();
  if (!existsSync(CHIME_CONFIG_FILE)) {
    saveChimeConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CHIME_CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveChimeConfig(config) {
  ensureChimeDirs();
  const tmp = `${CHIME_CONFIG_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, CHIME_CONFIG_FILE);
}

export function updateChimeConfig(patch) {
  return withLock(join(CHIME_DIR, "config.lock"), () => {
    const next = { ...loadChimeConfig(), ...patch };
    saveChimeConfig(next);
    return next;
  });
}

export function loadChimeState() {
  ensureChimeDirs();
  if (!existsSync(CHIME_STATE_FILE)) return structuredClone(EMPTY_STATE);
  try {
    const parsed = JSON.parse(readFileSync(CHIME_STATE_FILE, "utf8"));
    return {
      ...structuredClone(EMPTY_STATE),
      ...parsed,
      sources: parsed?.sources ?? {},
      processedControlEvents: Array.isArray(parsed?.processedControlEvents) ? parsed.processedControlEvents : [],
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function saveChimeState(state) {
  ensureChimeDirs();
  const tmp = `${CHIME_STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, CHIME_STATE_FILE);
}

export function appendChimeHistory(state, entry, limit) {
  state.history.push(entry);
  const max = Number.isFinite(limit) ? Math.max(10, Math.floor(limit)) : DEFAULT_CONFIG.historyLimit;
  if (state.history.length > max) state.history = state.history.slice(-max);
}

export function logChimeEvent(entry) {
  ensureChimeDirs();
  try {
    appendFileSync(CHIME_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {}
}

export function resolveSoundPath(name) {
  if (!name) return null;
  if (name.startsWith("/") || name.startsWith("~")) {
    return name.replace(/^~/, homedir());
  }
  const normalized = name.endsWith(".aiff") ? name : `${name}.aiff`;
  return join("/System/Library/Sounds", normalized);
}

export function playSound(name, volume = 1.0) {
  const soundPath = resolveSoundPath(name);
  if (!soundPath) return false;
  try {
    const vol = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1.0;
    const child = spawn("afplay", ["-v", String(vol), soundPath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function makeAgentKey(agentId) {
  return String(agentId).trim();
}

function encodeLockPart(part) {
  return Buffer.from(String(part || "unknown")).toString("base64url");
}

function activeLockPath(machine, sourceId, agentId) {
  return join(CHIME_ACTIVE_DIR, `${encodeLockPart(machine)}.${encodeLockPart(sourceId)}.${encodeLockPart(agentId)}.json`);
}

function activeLockTtlMs(config) {
  return Math.max(60, Number(config.activeLockTtlSeconds ?? DEFAULT_CONFIG.activeLockTtlSeconds)) * 1000;
}

export function writeActiveAgentLock({ machine, sourceId, harness, agentId, label = null, playbackHost = machine, startedAt, updatedAt = Date.now(), config = DEFAULT_CONFIG }) {
  ensureChimeDirs();
  const now = Number(updatedAt || Date.now());
  const payload = {
    machine,
    sourceId,
    harness,
    agentId,
    label,
    playbackHost,
    startedAt: Number(startedAt || now),
    updatedAt: now,
    expiresAt: now + activeLockTtlMs(config),
  };
  writeFileSync(activeLockPath(machine, sourceId, agentId), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function removeActiveAgentLock({ machine, sourceId, agentId }) {
  try { unlinkSync(activeLockPath(machine, sourceId, agentId)); } catch {}
}

function sourceMapKey(machine, sourceId) {
  return `${machine}::${sourceId}`;
}

function sourcePlaybackHost(source) {
  return source.playbackHost || source.machine;
}

function sourceSummary(source) {
  return {
    machine: source.machine,
    sourceId: source.sourceId,
    harness: source.harness,
    playbackHost: sourcePlaybackHost(source),
    activeCount: Object.keys(source.activeAgents ?? {}).length,
    seq: source.seq ?? 0,
    updatedAt: source.updatedAt ?? 0,
  };
}

export function buildSnapshotPayload(source, now = Date.now()) {
  return {
    kind: "agent.snapshot",
    machine: source.machine,
    sourceId: source.sourceId,
    harness: source.harness,
    playbackHost: sourcePlaybackHost(source),
    seq: source.seq ?? 0,
    updatedAt: now,
    activeAgents: Object.values(source.activeAgents ?? {}),
  };
}

export function applyControlEvent({ state, config, payload, now = Date.now() }) {
  if (!payload?.eventId) return { changed: false, broadcast: null, perAgent: false, summary: null };
  if (state.processedControlEvents.includes(payload.eventId)) {
    return { changed: false, broadcast: null, perAgent: false, summary: null };
  }
  state.processedControlEvents.push(payload.eventId);
  if (state.processedControlEvents.length > 500) {
    state.processedControlEvents = state.processedControlEvents.slice(-500);
  }

  const machine = payload.machine || localMachineName();
  const playbackHost = String(payload.playbackHost || machine);
  const sourceId = String(payload.sourceId || payload.harness || "unknown");
  const key = sourceMapKey(machine, sourceId);
  const current = state.sources[key] ?? {
    machine,
    sourceId,
    harness: payload.harness || sourceId,
    seq: 0,
    updatedAt: now,
    activeAgents: {},
  };
  current.machine = machine;
  current.sourceId = sourceId;
  current.harness = payload.harness || current.harness;
  current.playbackHost = playbackHost;
  current.updatedAt = now;
  current.seq = (current.seq ?? 0) + 1;
  current.activeAgents = current.activeAgents ?? {};

  const agentKey = makeAgentKey(payload.agentId || `${payload.harness || sourceId}:${payload.eventId}`);
  let changed = false;
  let perAgent = false;
  if (payload.kind === "agent.start") {
    if (!current.activeAgents[agentKey]) {
      current.activeAgents[agentKey] = {
        agentId: agentKey,
        harness: payload.harness || current.harness,
        label: payload.label || null,
        playbackHost,
        startedAt: now,
      };
      if (config.activeLockFiles !== false && machine === localMachineName()) {
        writeActiveAgentLock({
          machine,
          sourceId,
          harness: payload.harness || current.harness,
          agentId: agentKey,
          label: payload.label || null,
          playbackHost,
          startedAt: now,
          updatedAt: now,
          config,
        });
      }
      changed = true;
    }
  } else if (payload.kind === "agent.end") {
    if (current.activeAgents[agentKey]) {
      delete current.activeAgents[agentKey];
      if (config.activeLockFiles !== false && machine === localMachineName()) {
        removeActiveAgentLock({ machine, sourceId, agentId: agentKey });
      }
      changed = true;
      perAgent = true;
    }
  }

  state.sources[key] = current;
  if (changed) {
    appendChimeHistory(state, {
      ts: now,
      kind: payload.kind,
      machine,
      sourceId,
      agentId: agentKey,
      harness: payload.harness || current.harness,
      label: payload.label || null,
      playbackHost,
    }, config.historyLimit);
  }
  return {
    changed,
    perAgent,
    broadcast: changed ? buildSnapshotPayload(current) : null,
    summary: sourceSummary(current),
  };
}

export function applySnapshotEvent({ state, config, payload, now = Date.now(), localMachine = localMachineName() }) {
  if (!payload?.machine || !payload?.sourceId) return { changed: false, summary: null };
  if (payload.machine === localMachine) return { changed: false, summary: null };
  const key = sourceMapKey(payload.machine, payload.sourceId);
  const existing = state.sources[key];
  const seq = Number(payload.seq ?? 0);
  const incomingUpdatedAt = Number(payload.updatedAt ?? now);
  if (
    existing
    && (
      Number(existing.seq ?? 0) > seq
      || (
        Number(existing.seq ?? 0) === seq
        && Number(existing.updatedAt ?? existing.receivedAt ?? 0) >= incomingUpdatedAt
      )
    )
  ) {
    return { changed: false, summary: sourceSummary(existing) };
  }
  const activeAgents = {};
  for (const agent of Array.isArray(payload.activeAgents) ? payload.activeAgents : []) {
    const agentKey = makeAgentKey(agent.agentId || `${payload.sourceId}:${Object.keys(activeAgents).length}`);
    activeAgents[agentKey] = {
      agentId: agentKey,
      harness: agent.harness || payload.harness || payload.sourceId,
      label: agent.label || null,
      playbackHost: agent.playbackHost || payload.playbackHost || payload.machine,
      startedAt: Number(agent.startedAt ?? now),
    };
  }
  state.sources[key] = {
    machine: payload.machine,
    sourceId: payload.sourceId,
    harness: payload.harness || payload.sourceId,
    playbackHost: payload.playbackHost || payload.machine,
    seq,
    updatedAt: incomingUpdatedAt,
    receivedAt: now,
    activeAgents,
  };
  appendChimeHistory(state, {
    ts: now,
    kind: payload.kind || "agent.snapshot",
    machine: payload.machine,
    sourceId: payload.sourceId,
    activeCount: Object.keys(activeAgents).length,
    harness: payload.harness || payload.sourceId,
    playbackHost: payload.playbackHost || payload.machine,
  }, config.historyLimit);
  return { changed: true, summary: sourceSummary(state.sources[key]) };
}

export function expireChimeState({ state, config, now = Date.now(), localMachine = localMachineName() }) {
  const ttlMs = activeLockTtlMs(config);
  let changed = false;
  let expiredLocalAgents = 0;
  const broadcasts = [];
  const expiredSources = [];

  for (const [key, source] of Object.entries(state.sources ?? {})) {
    const isLocal = source.machine === localMachine;
    let sourceChanged = false;
    const agents = Object.entries(source.activeAgents ?? {});

    for (const [agentKey, agent] of agents) {
      const startedAt = Number(agent.startedAt ?? source.updatedAt ?? source.receivedAt ?? now);
      if (now - startedAt <= ttlMs) continue;
      delete source.activeAgents[agentKey];
      sourceChanged = true;
      changed = true;
      if (isLocal) {
        expiredLocalAgents += 1;
        removeActiveAgentLock({ machine: source.machine, sourceId: source.sourceId, agentId: agentKey });
      }
      appendChimeHistory(state, {
        ts: now,
        kind: "agent.expired",
        machine: source.machine,
        sourceId: source.sourceId,
        agentId: agentKey,
        harness: agent.harness || source.harness,
        label: agent.label || null,
        playbackHost: agent.playbackHost || sourcePlaybackHost(source),
      }, config.historyLimit);
    }

    const activeCount = Object.keys(source.activeAgents ?? {}).length;
    const sourceUpdatedAt = Number(source.updatedAt ?? source.receivedAt ?? 0);
    if (!isLocal && activeCount > 0 && sourceUpdatedAt > 0 && now - sourceUpdatedAt > ttlMs) {
      expiredSources.push({
        machine: source.machine,
        sourceId: source.sourceId,
        activeCount,
        updatedAt: sourceUpdatedAt,
      });
      source.activeAgents = {};
      sourceChanged = true;
      changed = true;
      appendChimeHistory(state, {
        ts: now,
        kind: "agent.source_expired",
        machine: source.machine,
        sourceId: source.sourceId,
        activeCount,
        harness: source.harness,
        playbackHost: sourcePlaybackHost(source),
      }, config.historyLimit);
    }

    if (sourceChanged) {
      source.seq = (source.seq ?? 0) + 1;
      source.updatedAt = now;
      state.sources[key] = source;
      if (isLocal) broadcasts.push(buildSnapshotPayload(source, now));
    }
  }

  if (config.activeLockFiles !== false && existsSync(CHIME_ACTIVE_DIR)) {
    for (const file of readdirSync(CHIME_ACTIVE_DIR).filter((name) => name.endsWith(".json"))) {
      const filePath = join(CHIME_ACTIVE_DIR, file);
      try {
        const lock = JSON.parse(readFileSync(filePath, "utf8"));
        const expiresAt = Number(lock.expiresAt ?? 0);
        if (expiresAt > 0 && now > expiresAt) unlinkSync(filePath);
      } catch {
        try { unlinkSync(filePath); } catch {}
      }
    }
  }

  return { changed, expiredLocalAgents, broadcasts, expiredSources };
}

export function evaluateFleetState({ state, config, now = Date.now(), localMachine = localMachineName() }) {
  const staleMs = Math.max(30, Number(config.stalePeerSeconds ?? DEFAULT_CONFIG.stalePeerSeconds)) * 1000;
  const expireMs = activeLockTtlMs(config);
  const fleetScope = config.scope !== "local";
  let fleetActiveCount = 0;
  const staleBlocking = [];
  const expiredSources = [];
  const playbackHosts = new Set();
  const sourceViews = [];

  for (const source of Object.values(state.sources)) {
    const activeCount = Object.keys(source.activeAgents ?? {}).length;
    const playbackHost = sourcePlaybackHost(source);
    playbackHosts.add(playbackHost);
    const updatedAt = Number(source.updatedAt ?? source.receivedAt ?? 0);
    const isLocal = source.machine === localMachine;
    const ageMs = updatedAt > 0 ? now - updatedAt : 0;
    const isStale = !isLocal && updatedAt > 0 && ageMs > staleMs;
    const isExpired = !isLocal && activeCount > 0 && updatedAt > 0 && ageMs > expireMs;

    sourceViews.push({
      machine: source.machine,
      sourceId: source.sourceId,
      harness: source.harness,
      playbackHost,
      activeCount,
      updatedAt,
      isLocal,
      isStale,
      isExpired,
    });

    if (!fleetScope && !isLocal) continue;
    if (isExpired) {
      expiredSources.push({
        machine: source.machine,
        sourceId: source.sourceId,
        activeCount,
        updatedAt,
      });
      continue;
    }
    if (isStale) {
      if (activeCount > 0) {
        fleetActiveCount += activeCount;
        staleBlocking.push({
          machine: source.machine,
          sourceId: source.sourceId,
          activeCount,
          updatedAt,
        });
      }
      continue;
    }
    fleetActiveCount += activeCount;
  }

  const previous = Number(state.lastFleetActiveCount ?? 0);
  const cooldownMs = Math.max(1, Number(config.allCompleteCooldownSeconds ?? DEFAULT_CONFIG.allCompleteCooldownSeconds)) * 1000;
  const allCompleteTransition = previous > 0
    && fleetActiveCount === 0
    && staleBlocking.length === 0
    && now - Number(state.lastAllCompleteTs ?? 0) > cooldownMs;

  state.lastFleetActiveCount = fleetActiveCount;
  if (allCompleteTransition) state.lastAllCompleteTs = now;
  const sortedPlaybackHosts = [...playbackHosts].sort();

  return {
    fleetActiveCount,
    staleBlocking,
    expiredSources,
    playbackHosts: sortedPlaybackHosts,
    allCompleteTransition,
    allCompletePlayback: allCompleteTransition && sortedPlaybackHosts.includes(localMachine),
    sources: sourceViews.sort((a, b) => `${a.machine}/${a.sourceId}`.localeCompare(`${b.machine}/${b.sourceId}`)),
  };
}

export function statusSnapshot({ state = loadChimeState(), config = loadChimeConfig(), now = Date.now() } = {}) {
  const localMachine = localMachineName();
  const fleet = evaluateFleetState({ state: structuredClone(state), config, now, localMachine });
  return {
    config,
    localMachine,
    fleetActiveCount: fleet.fleetActiveCount,
    staleBlocking: fleet.staleBlocking,
    expiredSources: fleet.expiredSources,
    playbackHosts: fleet.playbackHosts,
    lastAllCompleteTs: state.lastAllCompleteTs ?? 0,
    lastFleetActiveCount: state.lastFleetActiveCount ?? 0,
    sources: fleet.sources,
    history: state.history ?? [],
  };
}
