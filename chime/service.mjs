#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_HOME,
  BRIDGE_CONFIG_FILE,
  BRIDGE_INBOX_DIR,
  BRIDGE_KEYS_DIR,
  BRIDGE_OUTBOX_DIR,
  CHIME_ARCHIVE_DIR,
  CHIME_CONFIG_FILE,
  CHIME_INBOX_DIR,
  CHIME_LOCK_FILE,
  CHIME_SOURCE_TARGET,
  CHIME_TARGET,
  applyControlEvent,
  applySnapshotEvent,
  buildSnapshotPayload,
  ensureChimeDirs,
  evaluateFleetState,
  expireChimeState,
  loadChimeConfig,
  loadChimeState,
  localMachineName,
  logChimeEvent,
  playSound,
  saveChimeState,
} from "./core.mjs";
import { deliverReply, resolvePairedMachine } from "../openclaw-channel/src/outbound.js";

const COMPONENT = "chime-service";
const LEASE_STALE_MS = 15_000;
const POLL_MS = 2_000;

function logEvent(level, event, msg, context = {}) {
  const logFile = join(BRIDGE_HOME, "logs", "agent-bridge.log");
  try {
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      component: COMPONENT,
      machine: localMachineName(),
      event,
      level,
      msg,
      context,
    });
    writeFileSync(logFile, `${line}\n`, { flag: "a", mode: 0o600 });
  } catch {}
}

function parseArgs(argv) {
  return {
    ensureOnly: argv.includes("--ensure"),
  };
}

function readLease() {
  try {
    return JSON.parse(readFileSync(CHIME_LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function acquireLease() {
  ensureChimeDirs();
  const existing = readLease();
  const now = Date.now();
  if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid) && now - Number(existing.updatedAt ?? 0) < LEASE_STALE_MS) {
    return null;
  }
  const lease = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: now,
    updatedAt: now,
  };
  writeFileSync(CHIME_LOCK_FILE, JSON.stringify(lease, null, 2), { mode: 0o600 });
  const confirmed = readLease();
  if (confirmed?.token !== lease.token) return null;
  return lease;
}

function heartbeatLease(lease) {
  const current = readLease();
  if (!current || current.token !== lease.token) return false;
  lease.updatedAt = Date.now();
  writeFileSync(CHIME_LOCK_FILE, JSON.stringify(lease, null, 2), { mode: 0o600 });
  return true;
}

function releaseLease(lease) {
  const current = readLease();
  if (current?.token === lease?.token) {
    try { unlinkSync(CHIME_LOCK_FILE); } catch {}
  }
}

async function listPeerMachines() {
  const configPath = BRIDGE_CONFIG_FILE;
  if (!existsSync(configPath)) return [];
  const raw = readFileSync(configPath, "utf8");
  const names = [];
  let section = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^\[(.+)\]$/);
    if (!match) continue;
    section = match[1];
    if (section && !["chime", "__chime__"].includes(section.toLowerCase())) names.push(section);
  }
  const unique = new Set(names);
  return names.filter((name) => {
    if (name === localMachineName()) return false;
    if (name.toLowerCase().endsWith(".lan") && unique.has(name.slice(0, -4))) return false;
    const machine = resolvePairedMachine(name);
    return machine && !machine.host?.includes("undefined");
  });
}

function buildBridgeEnvelope(machine, content, replyTo = null) {
  return {
    id: `msg-chime-${randomUUID()}`,
    from: localMachineName(),
    to: machine,
    type: "message",
    content: JSON.stringify(content),
    timestamp: new Date().toISOString(),
    replyTo,
    ttl: 3600,
    target: CHIME_TARGET,
    fromTarget: CHIME_SOURCE_TARGET,
  };
}

async function broadcastSnapshot(snapshot) {
  const peers = await listPeerMachines();
  for (const peer of peers) {
    try {
      await deliverReply({
        message: buildBridgeEnvelope(peer, snapshot),
        toMachine: peer,
        keysDir: BRIDGE_KEYS_DIR,
        configPath: BRIDGE_CONFIG_FILE,
        inboxDir: BRIDGE_INBOX_DIR,
        outboxDir: BRIDGE_OUTBOX_DIR,
        logger: { info() {}, debug() {}, warn() {}, error() {} },
      });
      logEvent("info", "chime.snapshot_sent", `Sent chime snapshot to ${peer}`, {
        peer,
        sourceId: snapshot.sourceId,
        seq: snapshot.seq,
        activeCount: snapshot.activeAgents?.length ?? 0,
      });
    } catch (err) {
      logEvent("warn", "chime.snapshot_send_failed", `Failed to send chime snapshot to ${peer}`, {
        peer,
        sourceId: snapshot.sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function archiveProcessedFile(filePath) {
  ensureChimeDirs();
  const dest = join(CHIME_ARCHIVE_DIR, `${Date.now()}-${randomUUID()}-${filePath.split("/").pop()}`);
  try {
    renameSync(filePath, dest);
  } catch {
    try { unlinkSync(filePath); } catch {}
  }
}

function parseBridgeMessage(filePath) {
  try {
    const msg = JSON.parse(readFileSync(filePath, "utf8"));
    if (msg?.target !== CHIME_TARGET) return null;
    return {
      envelope: msg,
      payload: JSON.parse(String(msg.content || "{}")),
    };
  } catch {
    return null;
  }
}

async function processInboxOnce() {
  ensureChimeDirs();
  const config = loadChimeConfig();
  if (config.enabled === false) return;
  const state = loadChimeState();
  const files = readdirSync(CHIME_INBOX_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  let changed = false;
  let localSnapshotToBroadcast = [];
  let localPerAgent = 0;

  for (const name of files) {
    const filePath = join(CHIME_INBOX_DIR, name);
    const parsed = parseBridgeMessage(filePath);
    if (!parsed) {
      archiveProcessedFile(filePath);
      continue;
    }

    const now = Date.now();
    if (parsed.payload.kind === "agent.start" || parsed.payload.kind === "agent.end") {
      const result = applyControlEvent({ state, config, payload: parsed.payload, now });
      if (result.changed && result.broadcast) {
        changed = true;
        localSnapshotToBroadcast.push(result.broadcast);
        if (result.perAgent) localPerAgent += 1;
      }
    } else if (parsed.payload.kind === "agent.snapshot") {
      const result = applySnapshotEvent({ state, config, payload: parsed.payload, now });
      if (result.changed) changed = true;
    }
    archiveProcessedFile(filePath);
  }

  const now = Date.now();
  const expiry = expireChimeState({ state, config, now, localMachine: localMachineName() });
  if (expiry.changed) {
    changed = true;
    localPerAgent += expiry.expiredLocalAgents;
    localSnapshotToBroadcast.push(...expiry.broadcasts);
  }

  if (!changed) return;

  const fleet = evaluateFleetState({ state, config, now, localMachine: localMachineName() });

  if (config.enabled !== false && localPerAgent > 0 && config.playback !== "off") {
    playSound(config.perAgentSound, config.volume);
  }
  if (config.enabled !== false && fleet.allCompletePlayback && config.playback !== "off") {
    setTimeout(() => {
      playSound(config.allCompleteSound, config.volume);
    }, 350);
  }

  saveChimeState(state);
  logChimeEvent({
    ts: Date.now(),
    event: "state_update",
    fleetActiveCount: fleet.fleetActiveCount,
    staleBlocking: fleet.staleBlocking,
    expiredSources: fleet.expiredSources,
    playbackHosts: fleet.playbackHosts,
    allCompletePlayback: fleet.allCompletePlayback,
    localSnapshots: localSnapshotToBroadcast.map((snapshot) => ({
      sourceId: snapshot.sourceId,
      seq: snapshot.seq,
      activeCount: snapshot.activeAgents.length,
    })),
  });
  for (const snapshot of localSnapshotToBroadcast) {
    await broadcastSnapshot(snapshot);
  }
}

async function sendHeartbeatSnapshots() {
  const config = loadChimeConfig();
  if (config.enabled === false || config.scope === "local") return;
  const state = loadChimeState();
  const now = Date.now();
  for (const source of Object.values(state.sources)) {
    if (source.machine !== localMachineName()) continue;
    await broadcastSnapshot(buildSnapshotPayload(source, now));
  }
}

async function runService() {
  const lease = acquireLease();
  if (!lease) {
    logEvent("info", "chime.lease_busy", "Chime service already running", {});
    return;
  }
  logEvent("info", "chime.started", "Agent Bridge chime service started", { pid: process.pid });

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastHeartbeatAt = 0;
  try {
    while (!stopped) {
      if (!heartbeatLease(lease)) break;
      await processInboxOnce();
      const config = loadChimeConfig();
      const intervalMs = Math.max(10, Number(config.heartbeatSeconds ?? 30)) * 1000;
      if (Date.now() - lastHeartbeatAt >= intervalMs) {
        lastHeartbeatAt = Date.now();
        await sendHeartbeatSnapshots();
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    releaseLease(lease);
    logEvent("info", "chime.stopped", "Agent Bridge chime service stopped", { pid: process.pid });
  }
}

async function ensureService() {
  ensureChimeDirs();
  const current = readLease();
  if (current?.pid && pidAlive(current.pid) && Date.now() - Number(current.updatedAt ?? 0) < LEASE_STALE_MS) return;
  const child = spawn(process.execPath, [new URL("./service.mjs", import.meta.url).pathname], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const args = parseArgs(process.argv.slice(2));
if (args.ensureOnly) {
  await ensureService();
} else {
  await runService();
}
