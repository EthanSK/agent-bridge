#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_INBOX_DIR,
  BRIDGE_OUTBOX_DIR,
  CHIME_DIR,
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
const logFile = join(CHIME_DIR, "e2e-audible-demo.log");

function logStep(event, context = {}) {
  ensureChimeDirs();
  const entry = {
    ts: new Date().toISOString(),
    event,
    localMachine,
    remoteMachine,
    remoteSource,
    localSource,
    agentId,
    ...context,
  };
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  process.stdout.write(`${event}: ${JSON.stringify(context)}\n`);
}

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
  logStep("say", { text });
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
    playbackHost: localMachine,
    seq,
    updatedAt: now,
    activeAgents: active
      ? [{ agentId: `${remoteSource}-task`, harness: remoteSource, label: "synthetic remote task", playbackHost: localMachine, startedAt: now }]
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
  logStep("bridge_snapshot_delivered", {
    machine: remoteMachine,
    sourceId: remoteSource,
    playbackHost: localMachine,
    active,
    seq,
  });
}

async function main() {
  logStep("demo_start", { logFile });

  await run(bridgeCli, ["chime", "reset"]);
  logStep("chime_reset");

  await say("Demo start. Local agent begins. No chime yet.");
  await run(bridgeCli, ["chime", "start", agentId, "--source", localSource, "--harness", "openclaw", "--label", "audible e2e local task"]);
  logStep("local_agent_started");
  await sleep(3000);

  await say("Remote harness active. No chime yet.");
  await sendSnapshot({ seq: 1, active: true });
  await sleep(3000);

  await say("Intermediate chime. Glass should play now.");
  await run(bridgeCli, ["chime", "end", agentId, "--source", localSource, "--harness", "openclaw", "--label", "audible e2e local task"]);
  logStep("local_agent_completed", { expectedSound: "per-agent", expectedSoundName: "Glass" });
  await sleep(4000);

  await say("Final chime. Hero should play now.");
  await sendSnapshot({ seq: 2, active: false });
  logStep("remote_agent_completed", { expectedSound: "all-complete", expectedSoundName: "Hero" });
  await sleep(5000);

  const status = await run(bridgeCli, ["chime", "status"]);
  logStep("final_status", { status: JSON.parse(status) });
  process.stdout.write("Final chime status:\n");
  process.stdout.write(`${status}\n`);
  process.stdout.write(`Durable E2E log: ${logFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
