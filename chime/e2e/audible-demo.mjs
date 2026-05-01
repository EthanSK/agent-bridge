#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_INBOX_DIR,
  BRIDGE_OUTBOX_DIR,
  CHIME_SOURCE_TARGET,
  CHIME_TARGET,
  ensureChimeDirs,
  localMachineName,
} from "../core.mjs";
import { deliverReplyLocal } from "../../openclaw-channel/src/outbound.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const bridgeCli = join(repoRoot, "agent-bridge");
const localMachine = localMachineName();
const remoteMachine = process.env.AGENT_BRIDGE_CHIME_E2E_REMOTE_MACHINE || "Chiron-E2E-Remote";
const remoteSource = process.env.AGENT_BRIDGE_CHIME_E2E_REMOTE_SOURCE || "chiron-harness";
const localSource = process.env.AGENT_BRIDGE_CHIME_E2E_LOCAL_SOURCE || "audible-e2e-local";
const agentId = `audible-e2e-${Date.now()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(cmd, args, options = {}) {
  const result = await execFileAsync(cmd, args, {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

async function say(text) {
  process.stdout.write(`say: ${text}\n`);
  try {
    await run("/usr/bin/say", [text]);
  } catch {
    // Non-macOS / unavailable audio output: keep the demo runnable.
  }
}

async function sendSnapshot({ seq, active }) {
  ensureChimeDirs();
  const now = Date.now();
  const payload = {
    kind: "agent.snapshot",
    machine: remoteMachine,
    sourceId: remoteSource,
    harness: remoteSource,
    seq,
    updatedAt: now,
    activeAgents: active
      ? [{ agentId: `${remoteSource}-task`, harness: remoteSource, label: "synthetic remote task", startedAt: now }]
      : [],
  };
  const message = {
    id: `msg-chime-e2e-${randomUUID()}`,
    from: remoteMachine,
    to: localMachine,
    type: "message",
    content: JSON.stringify(payload),
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 3600,
    target: CHIME_TARGET,
    fromTarget: CHIME_SOURCE_TARGET,
  };
  await deliverReplyLocal({
    message,
    toMachine: localMachine,
    inboxDir: BRIDGE_INBOX_DIR,
    outboxDir: BRIDGE_OUTBOX_DIR,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  process.stdout.write(`bridge snapshot delivered: ${remoteMachine}/${remoteSource} active=${active}\n`);
}

async function main() {
  process.stdout.write("Agent Bridge chime audible E2E demo starting.\n");
  process.stdout.write(`localMachine=${localMachine} remoteMachine=${remoteMachine} remoteSource=${remoteSource}\n`);

  await run(bridgeCli, ["chime", "reset"]);

  await say("E two E one. Emulating a local agent start. No chime should play yet.");
  await run(bridgeCli, ["chime", "start", agentId, "--source", localSource, "--harness", "openclaw", "--label", "audible e2e local task"]);
  await sleep(3000);

  await say("E two E two. A remote Chiron harness reports active over Agent Bridge. Still no chime.");
  await sendSnapshot({ seq: 1, active: true });
  await sleep(3000);

  await say("E two E three. The local agent completes. Glass should play, but Hero should wait.");
  await run(bridgeCli, ["chime", "end", agentId, "--source", localSource, "--harness", "openclaw", "--label", "audible e2e local task"]);
  await sleep(4000);

  await say("E two E four. The remote harness completes over Agent Bridge. Hero should play now.");
  await sendSnapshot({ seq: 2, active: false });
  await sleep(5000);

  const status = await run(bridgeCli, ["chime", "status"]);
  process.stdout.write("Final chime status:\n");
  process.stdout.write(`${status}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
