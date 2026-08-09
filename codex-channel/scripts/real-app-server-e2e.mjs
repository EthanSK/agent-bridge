#!/usr/bin/env node

/**
 * Manual authenticated E2E against the installed Codex App Server.
 *
 * This is deliberately outside the deterministic npm test glob: it invokes
 * the configured model, creates one disposable persisted thread, verifies the
 * bridge lifecycle, archives the thread in finally, and uses a temporary
 * Agent Bridge home for settings journals. It never opens Codex UI.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { ThreadSession } from "../src/session.js";
import { CHANNEL_VERSION } from "../src/version.js";

const projectRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const scratchRoot = mkdtempSync(join(tmpdir(), "agent-bridge-codex-real-e2e-"));
const sessionEnv = { ...process.env, AGENT_BRIDGE_HOME: join(scratchRoot, ".agent-bridge") };
const messageId = `msg-real-e2e-${randomUUID()}`;
const events = [];
const logEvent = (level, event, message, context = {}) => {
  events.push({ level, event, message, context });
};

let client = null;
let session = null;
let threadId = null;
let directSubscription = false;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

try {
  client = await CodexAppServerClient.spawn({
    env: process.env,
    logEvent,
    clientName: "agent-bridge-codex-channel-real-e2e",
    clientVersion: CHANNEL_VERSION,
  });
  const runtime = await client.initialize({ timeoutMs: 20_000 });
  const created = await client.request("thread/start", {
    cwd: projectRoot,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
  }, { timeoutMs: 30_000 });
  threadId = created?.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no disposable thread id");
  directSubscription = true;

  // A new thread has no rollout until its first turn. Seed one inherited
  // read-only turn so the later operation is a true cross-subscription
  // resume of persisted history rather than an in-memory thread object.
  let seedTurnId = null;
  const completedSeedTurns = new Set();
  let seedCompletionResolve;
  const seedCompletion = new Promise((resolve) => { seedCompletionResolve = resolve; });
  const disposeSeedNotifications = client.onNotification((notification) => {
    if (notification?.method !== "turn/completed") return;
    const params = notification?.params ?? {};
    const notificationThreadId = params.threadId ?? params.thread?.id ?? params.turn?.threadId;
    const notificationTurnId = params.turnId ?? params.turn?.id;
    if (notificationThreadId !== threadId || typeof notificationTurnId !== "string") return;
    completedSeedTurns.add(notificationTurnId);
    if (seedTurnId === notificationTurnId) seedCompletionResolve(params.turn ?? params);
  });
  const seeded = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly SEED_READY and no other text.", text_elements: [] }],
    clientUserMessageId: `seed-${randomUUID()}`,
  }, { timeoutMs: 60_000 });
  seedTurnId = seeded?.turn?.id;
  if (typeof seedTurnId !== "string" || !seedTurnId) throw new Error("seed turn/start returned no turn id");
  if (completedSeedTurns.has(seedTurnId)) seedCompletionResolve(seeded.turn);
  await withTimeout(seedCompletion, 180_000, "real Codex seed turn");
  disposeSeedNotifications();
  await client.request("thread/unsubscribe", { threadId }, { timeoutMs: 10_000 });
  directSubscription = false;

  let completionResolve;
  let completionReject;
  const completion = new Promise((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  session = new ThreadSession({
    client,
    env: sessionEnv,
    binding: {
      alias: `real-e2e-${process.pid}`,
      threadId,
      cwd: projectRoot,
      policy: {
        steering: false,
        ownershipGuard: true,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        turnTimeoutMs: 180_000,
      },
    },
    logEvent,
    onTurnCompleted: (info) => {
      if (info?.status === "failed") completionReject(new Error(`bridge turn failed: ${info?.error ?? "unknown"}`));
      else completionResolve(info);
    },
  });

  await session.resume({ timeoutMs: 30_000 });
  const original = structuredClone(session.originalSettings);
  const started = await session.startTurn({
    text: "Reply with exactly BRIDGE_E2E_OK and no other text.",
    clientUserMessageId: messageId,
    timeoutMs: 60_000,
  });
  if (!started?.turnId) throw new Error(`bridge turn did not start: ${JSON.stringify(started)}`);
  const terminal = await withTimeout(completion, 180_000, "real Codex bridge turn");
  const historyContains = await session.threadContains(messageId, { timeoutMs: 30_000 });
  if (historyContains !== true) throw new Error(`history did not structurally echo ${messageId}`);

  const history = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  }, { timeoutMs: 30_000 });
  const replyObserved = JSON.stringify(history).includes("BRIDGE_E2E_OK");
  if (!replyObserved) throw new Error("real turn completed but expected reply text was absent from history");

  const approvalDeclines = session.approvalDeclineCount;
  const released = await session.release({ timeoutMs: 15_000 });
  if (!released?.released) throw new Error(`session release was not confirmed: ${JSON.stringify(released)}`);
  session = null;

  const verified = await client.request("thread/resume", {
    threadId,
    initialTurnsPage: { limit: 5, sortDirection: "desc", itemsView: "full" },
  }, { timeoutMs: 30_000 });
  directSubscription = true;
  const settingsRestored = verified?.cwd === original?.cwd
    && JSON.stringify(verified?.approvalPolicy) === JSON.stringify(original?.approvalPolicy)
    && JSON.stringify(verified?.sandbox) === JSON.stringify(original?.sandboxPolicy);
  if (!settingsRestored) {
    throw new Error(`thread settings were not restored: ${JSON.stringify({ original, verified }, null, 2)}`);
  }
  await client.request("thread/unsubscribe", { threadId }, { timeoutMs: 10_000 });
  directSubscription = false;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    serverVersion: runtime.serverVersion,
    threadId,
    turnId: started.turnId,
    terminalStatus: terminal?.status ?? "completed",
    historyContains,
    replyObserved,
    settingsRestored,
    approvalDeclines,
  }, null, 2)}\n`);
} finally {
  if (session) {
    try { await session.release({ timeoutMs: 10_000, detachOnRestoreFailure: true }); } catch { /* continue cleanup */ }
  } else if (directSubscription && client && threadId) {
    try { await client.request("thread/unsubscribe", { threadId }, { timeoutMs: 5_000 }); } catch { /* continue cleanup */ }
  }
  if (client && threadId) {
    try { await client.request("thread/archive", { threadId }, { timeoutMs: 10_000 }); } catch { /* retain primary error */ }
  }
  if (client) {
    try { await client.close(); } catch { /* retain primary error */ }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
}
