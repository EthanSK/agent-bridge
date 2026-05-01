import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  BRIDGE_INBOX_DIR,
  BRIDGE_OUTBOX_DIR,
  CHIME_SOURCE_TARGET,
  CHIME_TARGET,
  ensureChimeDirs,
  localMachineName,
} from "./core.mjs";
import { deliverReplyLocal } from "../openclaw-channel/src/outbound.js";

export function ensureService() {
  ensureChimeDirs();
  const servicePath = new URL("./service.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [servicePath, "--ensure"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function emitLifecycleEvent({ kind, sourceId, harness, agentId, label = null }) {
  ensureService();
  const machine = localMachineName();
  const payload = {
    kind,
    eventId: `evt-${randomUUID()}`,
    machine,
    sourceId,
    harness,
    agentId,
    label,
    ts: Date.now(),
  };
  const message = {
    id: `msg-chime-local-${randomUUID()}`,
    from: machine,
    to: machine,
    type: "message",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 3600,
    target: CHIME_TARGET,
    fromTarget: CHIME_SOURCE_TARGET,
  };
  deliverReplyLocal({
    message,
    toMachine: machine,
    inboxDir: BRIDGE_INBOX_DIR,
    outboxDir: BRIDGE_OUTBOX_DIR,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
}
