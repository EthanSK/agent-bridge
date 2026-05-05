// =============================================================================
// agent-bridge chime emitter — Mini-as-master event forwarding (2026-05-04)
// =============================================================================
//
// One entry point — `emitLifecycleEvent({ kind, sourceId, harness, agentId,
// label })` — used by:
//   - This repo's CLI (`agent-bridge chime start|end`).
//   - The standalone `agent-completion-chime` repo's `bin/chime.js` (via
//     dynamic import).
//
// Behavior depends on the local chime role (resolved from
// `~/.agent-bridge/chime/config.json`):
//
//   role=master / role=standalone — drop the event into the LOCAL chime inbox
//                                   (no SSH). The local daemon (service.mjs)
//                                   picks it up on its next 2s poll, applies
//                                   the control event, and plays the sound.
//   role=peer                     — SFTP the event into MASTER's chime inbox
//                                   (~/.agent-bridge/inbox/agent-bridge/chime/
//                                   <id>.json). Master's daemon plays the
//                                   sound. We do NOT play locally.
//
// All forwarding goes through agent-bridge's existing SFTP machinery
// (deliverReply / deliverReplyLocal in openclaw-channel/src/outbound.js).
// No new SSH plumbing — we reuse the paired-machine config that
// `bridge_send_message` already uses.
//
// If we're a peer and master is unreachable, the event is dropped into the
// local inbox as a fall-back. Better to play locally than drop the chime
// silently — the user expects the audible feedback.
// =============================================================================

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  BRIDGE_CONFIG_FILE,
  BRIDGE_INBOX_DIR,
  BRIDGE_KEYS_DIR,
  BRIDGE_OUTBOX_DIR,
  CHIME_SOURCE_TARGET,
  CHIME_TARGET,
  ensureChimeDirs,
  loadChimeConfig,
  localMachineName,
  masterMachineOf,
  roleFor,
} from "./core.mjs";
import { deliverReply, deliverReplyLocal } from "../openclaw-channel/src/outbound.js";

export function ensureService() {
  ensureChimeDirs();
  const servicePath = new URL("./service.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [servicePath, "--ensure"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function buildEnvelope({ toMachine, fromMachine, payload, replyTo = null }) {
  return {
    id: `msg-chime-${randomUUID()}`,
    from: fromMachine,
    to: toMachine,
    type: "message",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    replyTo,
    ttl: 3600,
    target: CHIME_TARGET,
    fromTarget: CHIME_SOURCE_TARGET,
  };
}

/**
 * Lifecycle emitter. `kind` is one of `agent.start` | `agent.end` |
 * `chime.register` | `chime.heartbeat`. The first two carry agent metadata;
 * the latter two carry only `{machine, chimeVersion?, pid?}`.
 *
 * Returns a Promise that resolves when the event has been written. Callers
 * that don't need to wait (CLI hooks) can fire-and-forget.
 */
export async function emitLifecycleEvent({ kind, sourceId, harness, agentId, label = null, extra = {} }) {
  const config = loadChimeConfig();
  // 4.0.1 (Codex P2 2026-05-04) — short-circuit when chimes are disabled.
  // Without this, hooks would still queue lifecycle events into the chime
  // inbox, which the disabled service ignores. If the user later enables
  // chimes, the accumulated stale `agent.end` files would replay and fire
  // surprise chimes. Returning early means disabled mode is truly silent
  // and stateless.
  if (config.enabled === false) {
    return { delivered: "skipped-disabled", master: null, role: roleFor(config, localMachineName()) };
  }
  ensureService();
  const machine = localMachineName();
  const role = roleFor(config, machine);
  const master = masterMachineOf(config);

  const payload = {
    kind,
    eventId: `evt-${randomUUID()}`,
    machine,
    sourceId,
    harness,
    agentId,
    label,
    ts: Date.now(),
    ...extra,
  };

  // role=master / role=standalone: write straight to local inbox.
  if (role !== "peer" || !master) {
    const message = buildEnvelope({ toMachine: machine, fromMachine: machine, payload });
    deliverReplyLocal({
      message,
      toMachine: machine,
      inboxDir: BRIDGE_INBOX_DIR,
      outboxDir: BRIDGE_OUTBOX_DIR,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    return { delivered: "local", master: null, role };
  }

  // role=peer: SFTP to master's inbox.
  const message = buildEnvelope({ toMachine: master, fromMachine: machine, payload });
  try {
    await deliverReply({
      message,
      toMachine: master,
      keysDir: BRIDGE_KEYS_DIR,
      configPath: BRIDGE_CONFIG_FILE,
      inboxDir: BRIDGE_INBOX_DIR,
      outboxDir: BRIDGE_OUTBOX_DIR,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    return { delivered: "master", master, role };
  } catch (err) {
    // Master unreachable — fall back to local inbox so SOME chime still fires.
    // Better to play on the wrong machine than to silently drop.
    // 4.0.1 (Codex P2 2026-05-04): mark the fallback payload with
    // `_localFallback: true` so the service can override peer-suppression
    // and actually play the sound on this machine. Without this hint, the
    // service would update fleet state but stay silent (peer role gates
    // shouldPlayHere=false), defeating the entire fallback.
    const fallbackPayload = { ...payload, _localFallback: true };
    const fallback = buildEnvelope({ toMachine: machine, fromMachine: machine, payload: fallbackPayload });
    deliverReplyLocal({
      message: fallback,
      toMachine: machine,
      inboxDir: BRIDGE_INBOX_DIR,
      outboxDir: BRIDGE_OUTBOX_DIR,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    return {
      delivered: "local-fallback",
      master,
      role,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
