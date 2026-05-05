#!/usr/bin/env node

// HARD KILL SWITCH — if `~/.agent-bridge/chime/.kill-switch` exists,
// exit immediately. Bypasses any --ensure auto-spawn from sibling
// CLIs/subagents. Established 2026-05-04 (Ethan voice 6328 + 6332 + 6335:
// "Just disable the agent chime fucking thing. ... I just heard another
// agent chime"). Remove the file (`rm ~/.agent-bridge/chime/.kill-switch`)
// to re-enable spawn.
import { existsSync as _ksExistsSync } from "node:fs";
import { homedir as _ksHomedir } from "node:os";
import { join as _ksJoin } from "node:path";
if (_ksExistsSync(_ksJoin(_ksHomedir(), ".agent-bridge/chime/.kill-switch"))) {
  process.exit(0);
}

// =============================================================================
// agent-bridge chime service — Mini-as-master architecture (2026-05-04)
// =============================================================================
//
// Why chime lives in agent-bridge (not the standalone agent-completion-chime
// repo): cross-machine completion comms need an SSH transport, and agent-bridge
// already owns paired-machine SSH plumbing. Co-locating chime here lets us
// SFTP completion events into a peer's inbox via the same mechanism that
// powers `bridge_send_message`. (Resolved 2026-05-04, Ethan voice 6283.)
//
// Mini-as-master decision (Ethan voice 6286, 2026-05-04):
//
//   "the Mac Mini is like the one playing it, so they all have to tell the
//    Mac Mini or whatever the master one is that they're done, and then the
//    Mac Mini is like the parent who controls them all."
//
// There is only ONE human at the desk. To avoid fan-out chiming from every
// paired Mac (laptop, mini, etc.) when a single agent completes, we designate
// ONE host (Mini) as the sole-player. Peers forward their completion events
// to Mini's chime inbox via SFTP; Mini receives, dedupes, and plays Glass /
// Hero with the existing cooldown logic.
//
//   peer hook fires (Stop / SubagentStop)
//      ↓
//   chime.js end --from-claude-... (standalone CLI)
//      ↓ role=peer? then:
//   forwardEventToMaster() — SFTP write to Mini's
//      ~/.agent-bridge/inbox/agent-bridge/chime/<id>.json
//      ↓
//   Mini's chime daemon (this file) processInboxOnce()
//      ↓ apply control event, evaluateFleetState
//      ↓ playSound(perAgent / allComplete) on Mini ONLY
//
// Master does NOT broadcast back to peers. Peers do NOT play locally. Each
// machine does NOT play its own chime independently. This is the OPPOSITE
// of the canceled "broadcast snapshots to peers" model that lived here
// before 2026-05-04 — keep this comment as a "do not re-consolidate" guard.
//
// Future-proofing: `masterMachine` is configurable in
// ~/.agent-bridge/chime/config.json. Set to `null` to opt out and revert to
// legacy local-play. Set to a different machine name on a different fleet.
// =============================================================================

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
  loadChimePeers,
  loadChimeState,
  localMachineName,
  logChimeEvent,
  masterMachineOf,
  playSound,
  recordPeerRegistration,
  roleFor,
  saveChimePeers,
  saveChimeState,
  speak,
} from "./core.mjs";
import {
  refreshLocalBotNameCache,
  resolveBotNameSync,
  shortenMachineNameForSpeech,
  speechForChime,
} from "./bot-name.mjs";
import { deliverReply, resolvePairedMachine } from "../openclaw-channel/src/outbound.js";

const COMPONENT = "chime-service";
const LEASE_STALE_MS = 15_000;
const POLL_MS = 2_000;
const CHIME_VERSION = "1.1.0-bot-name-say";

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

function recordPeerRegistrationFromPayload(payload, now = Date.now()) {
  const registry = recordPeerRegistration(loadChimePeers(), payload, now);
  saveChimePeers(registry);
  return registry;
}

/**
 * Mini-as-master playback policy.
 *
 *  role         | per-agent  | all-complete | inbox processing
 *  -------------+------------+--------------+--------------------
 *  master       | play local | play local   | always
 *  peer         | (none)     | (none)       | events should be
 *                                              forwarded by emitter,
 *                                              not arrive here. If
 *                                              they do, we still
 *                                              update fleet state
 *                                              for status visibility
 *                                              but do NOT play.
 *  standalone   | play local | play local   | always (legacy)
 *
 * All three roles still honor `config.enabled === false` and `config.playback === "off"`.
 */
async function processInboxOnce() {
  ensureChimeDirs();
  const config = loadChimeConfig();
  if (config.enabled === false) {
    // 4.0.1 (Codex P2 2026-05-04) — drain (archive without playback) any
    // files that landed in the inbox while disabled. Without this, old
    // pre-disable files would replay if the user later re-enables chimes.
    // Going forward the emitter short-circuits, so no new files arrive,
    // but a one-time drain protects users upgrading from <4.0.1.
    try {
      for (const name of readdirSync(CHIME_INBOX_DIR).filter((n) => n.endsWith(".json")).sort()) {
        archiveProcessedFile(join(CHIME_INBOX_DIR, name));
      }
    } catch {
      // best-effort drain
    }
    return;
  }
  const role = roleFor(config);
  const state = loadChimeState();
  const files = readdirSync(CHIME_INBOX_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  let changed = false;
  let localSnapshotToBroadcast = [];
  let localPerAgent = 0;
  let remotePerAgent = 0;
  let registrationsHandled = 0;
  // Track the origin machine of the LAST processed perAgent event in this
  // cycle, so the post-chime `say` can speak the right bot name. We pick
  // the most-recent event so multi-event bursts feel coherent (you hear the
  // name of the agent that "just" finished). If both local and remote events
  // land in the same cycle, we prefer the LOCAL one — that's "Ethan's desk"
  // and matches the same-cycle pitch decision below.
  let lastPerAgentOriginMachine = null;
  let lastPerAgentWasLocal = false;
  // 4.0.1 (Codex P2 2026-05-04) — track local-fallback marker so the
  // playback gate can override peer-suppression for emitter-fallback
  // events (peer with unreachable master).
  let saw_localFallbackInCycle = false;

  for (const name of files) {
    const filePath = join(CHIME_INBOX_DIR, name);
    const parsed = parseBridgeMessage(filePath);
    if (!parsed) {
      archiveProcessedFile(filePath);
      continue;
    }

    const now = Date.now();
    const payload = parsed.payload || {};
    const eventOriginMachine = String(payload.machine || "").trim();
    const isRemoteEvent = eventOriginMachine && eventOriginMachine !== localMachineName();
    // 4.0.1 (Codex P2 R3 2026-05-04) — only trust the local-fallback marker
    // when the envelope is from-local-to-local AND the payload's origin is
    // the local machine. Without this gate, a remote (or misrouted) message
    // could set `_localFallback: true` and bypass peer-suppression.
    if (
      payload._localFallback === true
      && parsed.envelope?.from === localMachineName()
      && parsed.envelope?.to === localMachineName()
      && eventOriginMachine === localMachineName()
    ) {
      saw_localFallbackInCycle = true;
    }

    if (payload.kind === "chime.register" || payload.kind === "chime.heartbeat") {
      // Peer ↔ master registration handshake. Master records; peer ignores
      // (peers should never receive these, but be tolerant.)
      if (role === "master") {
        recordPeerRegistrationFromPayload(payload, now);
        registrationsHandled += 1;
      }
      archiveProcessedFile(filePath);
      continue;
    }

    if (payload.kind === "agent.start" || payload.kind === "agent.end") {
      const result = applyControlEvent({ state, config, payload, now });
      if (result.changed) {
        changed = true;
        if (result.broadcast) localSnapshotToBroadcast.push(result.broadcast);
        if (result.perAgent) {
          if (isRemoteEvent) {
            remotePerAgent += 1;
            // Only set as last-origin if we don't already have a LOCAL pick.
            if (!lastPerAgentWasLocal) {
              lastPerAgentOriginMachine = eventOriginMachine;
            }
          } else {
            localPerAgent += 1;
            lastPerAgentOriginMachine = eventOriginMachine || localMachineName();
            lastPerAgentWasLocal = true;
          }
        }
      }
    } else if (payload.kind === "agent.snapshot") {
      const result = applySnapshotEvent({ state, config, payload, now });
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

  if (!changed && registrationsHandled === 0) return;

  const fleet = evaluateFleetState({ state, config, now, localMachine: localMachineName() });

  // -------------------------------------------------------------------------
  // PLAYBACK DECISION — Mini-as-master.
  // -------------------------------------------------------------------------
  const baseShouldPlay =
    config.enabled !== false
    && config.playback !== "off"
    && (role === "master" || role === "standalone");
  // 4.0.1 (Codex P2 2026-05-04) — local-fallback override for peer role.
  // When this peer's master is unreachable, the emitter writes events
  // locally with `_localFallback: true` so SOME chime fires. Without this
  // override, the role-gate above would suppress playback entirely.
  const sawLocalFallback = saw_localFallbackInCycle;
  const shouldPlayHere = baseShouldPlay || (role === "peer" && sawLocalFallback);

  const totalPerAgentEnded = localPerAgent + remotePerAgent;
  const remoteRate = Number(config.remotePitchRate ?? 1.0);

  if (shouldPlayHere && totalPerAgentEnded > 0) {
    // If only remote events landed, pitch slightly up so Ethan can tell.
    // If any local event landed too, play at normal pitch (it's "his" desk).
    const rate = (localPerAgent === 0 && remotePerAgent > 0) ? remoteRate : 1.0;
    playSound(config.perAgentSound, config.volume, rate);
  }
  // 4.0.1 (Codex P2 2026-05-04) — master/standalone always plays all-complete
  // on the transition boundary, even when every contributing source is a
  // remote peer. `fleet.allCompletePlayback` enforces local-machine membership
  // in `playbackHosts`, which is correct for snapshot-broadcast peers but
  // wrong for the Mini-as-master architecture where the master plays on
  // behalf of remote peers.
  const masterAllComplete = baseShouldPlay && fleet.allCompleteTransition;
  if (masterAllComplete || (shouldPlayHere && fleet.allCompletePlayback)) {
    // All-complete sound plays at normal pitch — it's a "fleet idle" event,
    // not a per-machine event, so the pitch hint isn't meaningful here.
    setTimeout(() => {
      playSound(config.allCompleteSound, config.volume, 1.0);
    }, 350);
  }

  // -------------------------------------------------------------------------
  // POST-CHIME SAY (2026-05-04, voice 6308) — speak the Telegram bot name
  // bound to the event's origin machine. We say AT MOST ONCE per cycle:
  //   - If the cycle resolved to all-complete, prefer that boundary's
  //     speech ("<botname> all complete"). If we know the originating
  //     machine of the last perAgent event in this cycle, use ITS bot
  //     name; otherwise fall back to the master's local bot name.
  //   - Otherwise (per-agent only), say "<botname> subagent complete".
  //
  // Cooldown / dedup: bursting multiple per-agent events in one cycle
  // collapses to one `say` (we don't speak per file, only per cycle).
  // Multiple cycles in quick succession (e.g. several SubagentStop hooks
  // arriving within 2s) will each say once. Acceptable — Ethan can dial
  // via `sayBotName: false` if it's too chatty.
  //
  // Toggle off via config: { "sayBotName": false }.
  // -------------------------------------------------------------------------
  // 4.0.1 — speak when ANY playback fired this cycle. masterAllComplete
  // covers the "master plays for remote-only fleet idle" case that the
  // legacy `fleet.allCompletePlayback` gate misses.
  const allCompleteAudible = masterAllComplete || (shouldPlayHere && fleet.allCompletePlayback);
  if (shouldPlayHere && config.sayBotName !== false && (totalPerAgentEnded > 0 || allCompleteAudible)) {
    const speechMachine = lastPerAgentOriginMachine || localMachineName();
    const speechBotName = resolveBotNameSync({ machine: speechMachine, config });
    const speechFallback = shortenMachineNameForSpeech(speechMachine);
    const speechKind = allCompleteAudible ? "all_complete" : "per_agent";
    const phrase = speechForChime({
      kind: speechKind,
      bot_name: speechBotName,
      machine_fallback: speechFallback,
    });
    if (phrase) {
      // Stagger after the chime sound so we don't speak over Glass/Hero.
      // All-complete sound is itself delayed ~350ms; speak at ~1200ms total.
      // Per-agent sound fires immediately; speak at ~600ms.
      const delay = allCompleteAudible ? 1200 : 600;
      speak(phrase, delay);
    }
    // Best-effort: refresh local bot-name cache async so the NEXT cycle
    // has a fresh entry even if the local token rotated. Never blocks.
    refreshLocalBotNameCache({ local_machine: localMachineName() }).catch(() => {});
  }

  saveChimeState(state);
  logChimeEvent({
    ts: Date.now(),
    event: "state_update",
    role,
    masterMachine: masterMachineOf(config),
    fleetActiveCount: fleet.fleetActiveCount,
    staleBlocking: fleet.staleBlocking,
    expiredSources: fleet.expiredSources,
    playbackHosts: fleet.playbackHosts,
    allCompletePlayback: fleet.allCompletePlayback,
    playedHere: shouldPlayHere,
    localPerAgent,
    remotePerAgent,
    registrationsHandled,
    localSnapshots: localSnapshotToBroadcast.map((snapshot) => ({
      sourceId: snapshot.sourceId,
      seq: snapshot.seq,
      activeCount: snapshot.activeAgents.length,
    })),
    spokenOriginMachine: lastPerAgentOriginMachine,
    spokenLocal: lastPerAgentWasLocal,
  });
}

async function sendHeartbeatSnapshots() {
  const config = loadChimeConfig();
  if (config.enabled === false || config.scope === "local") return;
  const role = roleFor(config);

  // ---- Peer side: send a chime.register heartbeat to master --------------
  // Establishes / refreshes our presence in master's peers.json registry.
  // Master uses it to know which machines are wired up; nothing is gated
  // on registration today (peers can forward events without prior register)
  // but the registry helps debugging and future fleet UX.
  if (role === "peer") {
    const master = masterMachineOf(config);
    if (!master) return;
    try {
      await deliverReply({
        message: buildBridgeEnvelope(master, {
          kind: "chime.heartbeat",
          machine: localMachineName(),
          chimeVersion: CHIME_VERSION,
          pid: process.pid,
          ts: Date.now(),
        }),
        toMachine: master,
        keysDir: BRIDGE_KEYS_DIR,
        configPath: BRIDGE_CONFIG_FILE,
        inboxDir: BRIDGE_INBOX_DIR,
        outboxDir: BRIDGE_OUTBOX_DIR,
        logger: { info() {}, debug() {}, warn() {}, error() {} },
      });
      logEvent("debug", "chime.heartbeat_sent", `Sent chime heartbeat to master ${master}`, { master });
    } catch (err) {
      logEvent("warn", "chime.heartbeat_failed", `Failed to send chime heartbeat to master ${master}`, {
        master,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ---- Master / standalone side: legacy snapshot broadcast disabled ------
  // The pre-2026-05-04 behavior broadcast snapshots to all peers so each peer
  // could compute fleet state and play its OWN chimes. Mini-as-master inverts
  // that — only the master plays, peers don't need fleet state. We keep the
  // function (and `broadcastSnapshot` / `listPeerMachines` above) for tests
  // and to allow `scope` overrides, but don't fan out by default.
  //
  // To re-enable legacy snapshot fan-out, set
  // `~/.agent-bridge/chime/config.json` { "scope": "broadcast" } (any value
  // other than "local" or the new default "fleet" historically triggered
  // broadcast — we now require an explicit "broadcast" opt-in).
  if (config.scope !== "broadcast") return;
  const state = loadChimeState();
  const now = Date.now();
  for (const source of Object.values(state.sources)) {
    if (source.machine !== localMachineName()) continue;
    await broadcastSnapshot(buildSnapshotPayload(source, now));
  }
}

async function sendInitialRegistration() {
  // Peers ping the master once at startup with a `chime.register` event so the
  // master's peers.json registry knows about us. Heartbeats refresh it.
  const config = loadChimeConfig();
  if (config.enabled === false) return;
  const role = roleFor(config);
  if (role !== "peer") return;
  const master = masterMachineOf(config);
  if (!master) return;
  try {
    await deliverReply({
      message: buildBridgeEnvelope(master, {
        kind: "chime.register",
        machine: localMachineName(),
        chimeVersion: CHIME_VERSION,
        pid: process.pid,
        ts: Date.now(),
      }),
      toMachine: master,
      keysDir: BRIDGE_KEYS_DIR,
      configPath: BRIDGE_CONFIG_FILE,
      inboxDir: BRIDGE_INBOX_DIR,
      outboxDir: BRIDGE_OUTBOX_DIR,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    logEvent("info", "chime.registered", `Registered with chime master ${master}`, { master });
  } catch (err) {
    logEvent("warn", "chime.register_failed", `Failed to register with chime master ${master}`, {
      master,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runService() {
  const lease = acquireLease();
  if (!lease) {
    logEvent("info", "chime.lease_busy", "Chime service already running", {});
    return;
  }
  const config = loadChimeConfig();
  const role = roleFor(config);
  logEvent("info", "chime.started", "Agent Bridge chime service started", {
    pid: process.pid,
    role,
    masterMachine: masterMachineOf(config),
    localMachine: localMachineName(),
  });

  // Peer-side: announce ourselves to master immediately. Best-effort.
  await sendInitialRegistration();

  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastHeartbeatAt = 0;
  try {
    while (!stopped) {
      if (!heartbeatLease(lease)) break;
      await processInboxOnce();
      const cfg = loadChimeConfig();
      const intervalMs = Math.max(10, Number(cfg.heartbeatSeconds ?? 30)) * 1000;
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
