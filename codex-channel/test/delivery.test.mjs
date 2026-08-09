import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpcError } from "../src/app-server-client.js";
import {
  AliasDelivery,
  CodexLedgerStateError,
  MAX_ATTEMPTS,
  MAX_PROBE_FAILURES,
  appendLedger,
  deliveredTombstonePath,
  hasIndeterminateTombstone,
  indeterminateTombstonePath,
  loadIndeterminateLedger,
  loadLedger,
  persistIndeterminateTombstone,
} from "../src/delivery.js";
import { deliveredLedgerPath, exhaustedDir } from "../src/paths.js";

const ALIAS = "review";
const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const noop = () => {};

function rpcError(message, code = -32000, method = "turn/start") {
  return new CodexRpcError({ code, message }, method);
}

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "ab-codex-delivery-"));
  return { AGENT_BRIDGE_HOME: join(home, ".agent-bridge") };
}

function binding(policy = {}) {
  return {
    alias: ALIAS,
    threadId: THREAD,
    cwd: "/tmp/proj",
    enabled: true,
    policy: { steering: false, ownershipGuard: true, approvalPolicy: "never", sandbox: "workspace-write", turnTimeoutMs: null, ...policy },
  };
}

function makeDelivery(env, {
  policy = {},
  logEvent = noop,
  ledger = new Set(),
  appendLedgerImpl,
  sendFence,
  deadLetterMove,
  stagingReadDir,
  stagedRead,
  stagedLstat,
} = {}) {
  return new AliasDelivery({
    binding: binding(policy),
    env,
    logEvent,
    localMachine: "MBP",
    channelVersion: "4.10.0",
    ledger,
    ...(appendLedgerImpl ? { appendLedgerImpl } : {}),
    ...(sendFence ? { sendFence } : {}),
    ...(deadLetterMove ? { deadLetterMove } : {}),
    ...(stagingReadDir ? { stagingReadDir } : {}),
    ...(stagedRead ? { stagedRead } : {}),
    ...(stagedLstat ? { stagedLstat } : {}),
  });
}

let msgCounter = 0;
/**
 * Write an inbound message file. `fileName` overrides the on-disk name so
 * hostile INTERNAL ids (e.g. path traversal in the JSON body) can be staged
 * inside the inbox without the fixture itself writing outside it.
 */
function writeInbound(delivery, overrides = {}, fileName = null) {
  msgCounter += 1;
  const msg = {
    id: `msg-${String(msgCounter).padStart(4, "0")}-aaaa-4bbb-8ccc-ddddeeee0000`,
    from: "Mac-Mini",
    to: "MBP",
    type: "message",
    content: `payload ${msgCounter}`,
    timestamp: new Date(Date.now() - 1000 + msgCounter).toISOString(),
    replyTo: null,
    ttl: 86400,
    target: `codex/${ALIAS}`,
    fromTarget: "claude-code/default",
    ...overrides,
  };
  mkdirSync(delivery.inboxDir, { recursive: true });
  writeFileSync(join(delivery.inboxDir, fileName ?? `${msg.id}.json`), JSON.stringify(msg, null, 2));
  return msg;
}

function fakeSession({ turnActive = false, turnOurs = false, startTurnImpl = null, steerImpl = null, probeImpl = null } = {}) {
  const calls = { startTurn: [], steerTurn: [], probes: [] };
  return {
    calls,
    turnActive,
    activeTurnOurs: turnActive ? turnOurs : false,
    activeTurnId: turnActive ? "turn-live" : null,
    async startTurn(args) {
      calls.startTurn.push(args);
      if (startTurnImpl) return startTurnImpl(args, calls.startTurn.length);
      return { turnId: `turn-${calls.startTurn.length}` };
    },
    async steerTurn(args) {
      calls.steerTurn.push(args);
      if (steerImpl) return steerImpl(args, calls.steerTurn.length);
      return { steered: true };
    },
    async threadContains(id) {
      calls.probes.push(id);
      return probeImpl ? probeImpl(id) : false;
    },
  };
}

test("scan claims valid inbound into staging with a durable meta sidecar", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  assert.equal(readdirSync(delivery.inboxDir).length, 0, "inbox file claimed away");
  assert.ok(existsSync(delivery.stagedPath(msg.id)));
  const meta = delivery.readMeta(msg.id);
  assert.equal(meta.state, "staged");
  assert.equal(meta.attempts, 0);
  assert.equal(delivery.queue.size, 1);
});

test("invalid target / unsafe id / oversized envelopes quarantine to .failed", () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e, m, c) => events.push({ e, c }) });
  writeInbound(delivery, { target: "codex/other-alias" });
  // Hostile id INSIDE the envelope, staged under a safe on-disk name — the
  // validator must quarantine before the id can ever reach a path join.
  writeInbound(delivery, { id: "../../escape" }, "hostile-id.json");
  const big = "x".repeat(1024 * 1024 + 1);
  writeInbound(delivery, { content: big });
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  const failed = readdirSync(delivery.failedDir);
  assert.equal(failed.length, 3);
  assert.ok(failed.includes("hostile-id.json"));
  assert.equal(events.filter((x) => x.e === "codex.quarantined").length, 3);
});

test("ledger duplicates are archived, never re-delivered", () => {
  const env = makeEnv();
  const ledger = new Set();
  const delivery = makeDelivery(env, { ledger });
  const msg = writeInbound(delivery);
  ledger.add(msg.id);
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  const archived = readdirSync(delivery.archiveDir);
  assert.equal(archived.length, 1);
  assert.match(archived[0], new RegExp(msg.id));
});

test("TTL-expired messages quarantine instead of delivering stale work", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  writeInbound(delivery, { timestamp: new Date(Date.now() - 90_000_000).toISOString() });
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.equal(readdirSync(delivery.failedDir).length, 1);
});

test("idle delivery: turn/start with clientUserMessageId=BridgeMessage.id, then finalize", async () => {
  const env = makeEnv();
  const events = [];
  const ledger = new Set();
  const delivery = makeDelivery(env, { ledger, logEvent: (l, e, m, c) => events.push({ e, c }) });
  const msg = writeInbound(delivery, { replyTo: null });
  delivery.scanInbox();
  const session = fakeSession();
  const outcome = await delivery.deliverStep(session);
  assert.equal(outcome, "delivered");
  const call = session.calls.startTurn[0];
  assert.equal(call.clientUserMessageId, msg.id);
  assert.match(call.text, /\[BRIDGE-CONTEXT\]/);
  assert.match(call.text, new RegExp(`message_id: ${msg.id}`));
  assert.match(call.text, /payload/);
  // Durable finalize: ledger + archive + no staging leftovers + queue empty.
  assert.ok(ledger.has(msg.id));
  assert.ok(loadLedger(env).has(msg.id));
  assert.equal(readdirSync(delivery.archiveDir).length, 1);
  assert.equal(readdirSync(delivery.stagingDir).length, 0);
  assert.equal(delivery.queue.size, 0);
  assert.ok(events.some((x) => x.e === "codex.turn_start"));
  assert.ok(events.some((x) => x.e === "codex.turn_started"));
  assert.ok(events.some((x) => x.e === "codex.delivery_finalized"));
  assert.ok(events.some((x) => x.e === "codex.reply_expected"), "fromTarget present => reply expectation logged");
});

test("strict FIFO by timestamp across queued messages", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const older = writeInbound(delivery, { timestamp: new Date(Date.now() - 60_000).toISOString() });
  const newer = writeInbound(delivery, { timestamp: new Date().toISOString() });
  delivery.scanInbox();
  const session = fakeSession();
  await delivery.deliverStep(session);
  await delivery.deliverStep(session);
  assert.equal(session.calls.startTurn[0].clientUserMessageId, older.id);
  assert.equal(session.calls.startTurn[1].clientUserMessageId, newer.id);
});

test("active turn queues by default (no steering)", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e) => events.push(e) });
  writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ turnActive: true });
  const outcome = await delivery.deliverStep(session);
  assert.equal(outcome, "deferred");
  assert.equal(session.calls.startTurn.length, 0);
  assert.equal(session.calls.steerTurn.length, 0);
  assert.ok(events.includes("codex.queue_deferred_active_turn"));
  // Message stays durably claimed for the flush after idle.
  assert.equal(delivery.queue.size, 1);
  const session2 = fakeSession({ turnActive: false });
  assert.equal(await delivery.deliverStep(session2), "delivered");
});

test("queued message that expires while a foreign turn is busy is terminally moved without a turn RPC", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery, { ttl: 60 });
  delivery.scanInbox();

  const busy = fakeSession({ turnActive: true });
  assert.equal(await delivery.deliverStep(busy), "deferred");
  assert.equal(busy.calls.startTurn.length, 0);

  // Fast-forward only the queued envelope's age; it was valid when claimed.
  const entry = delivery.queue.get(msg.id);
  entry.message.timestamp = new Date(Date.now() - 120_000).toISOString();
  entry.message.ttl = 1;
  const idle = fakeSession();
  assert.equal(await delivery.deliverStep(idle), "failed");
  assert.equal(idle.calls.startTurn.length, 0);
  assert.equal(idle.calls.steerTurn.length, 0);
  assert.equal(delivery.queue.size, 0);
  assert.equal(readdirSync(exhaustedDir(env)).length, 1);
  assert.equal(existsSync(indeterminateTombstonePath(msg.id, env)), false,
    "proven-unsent TTL expiry is not an indeterminate tombstone");
});

test("restart-reconciled staged message is TTL-checked before its first send", async () => {
  const env = makeEnv();
  const first = makeDelivery(env);
  const msg = writeInbound(first, { ttl: 60 });
  first.scanInbox();

  const persisted = JSON.parse(readFileSync(first.stagedPath(msg.id), "utf8"));
  persisted.timestamp = new Date(Date.now() - 120_000).toISOString();
  persisted.ttl = 1;
  writeFileSync(first.stagedPath(msg.id), JSON.stringify(persisted, null, 2));

  const restarted = makeDelivery(env);
  restarted.reconcile();
  assert.equal(restarted.queue.get(msg.id).meta.state, "staged");
  assert.equal(restarted.queue.get(msg.id).needsProbe, false);
  const session = fakeSession();
  assert.equal(await restarted.deliverStep(session), "failed");
  assert.equal(session.calls.startTurn.length, 0);
  assert.equal(session.calls.steerTurn.length, 0);
  assert.equal(session.calls.probes.length, 0);
  assert.equal(restarted.queue.size, 0);
});

test("clean RPC retry re-checks TTL and does not send after the queued message expires", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery, { ttl: 60 });
  delivery.scanInbox();
  const rejected = fakeSession({ startTurnImpl: () => { throw rpcError("clean rejection"); } });
  assert.equal(await delivery.deliverStep(rejected), "failed");
  assert.equal(rejected.calls.startTurn.length, 1);

  const entry = delivery.queue.get(msg.id);
  entry.meta.nextAttemptAt = 0;
  entry.message.timestamp = new Date(Date.now() - 120_000).toISOString();
  entry.message.ttl = 1;
  const retry = fakeSession();
  assert.equal(await delivery.deliverStep(retry), "failed");
  assert.equal(retry.calls.startTurn.length, 0, "expired clean retry must not send");
  assert.equal(retry.calls.steerTurn.length, 0);
  assert.equal(delivery.queue.size, 0);
  assert.equal(existsSync(indeterminateTombstonePath(msg.id, env)), false);
});

test("expired turn_starting and steering states still require history probes", async () => {
  for (const state of ["turn_starting", "steering"]) {
    const env = makeEnv();
    const first = makeDelivery(env);
    const msg = writeInbound(first, { ttl: 60 });
    first.scanInbox();
    const persisted = JSON.parse(readFileSync(first.stagedPath(msg.id), "utf8"));
    persisted.timestamp = new Date(Date.now() - 120_000).toISOString();
    persisted.ttl = 1;
    writeFileSync(first.stagedPath(msg.id), JSON.stringify(persisted, null, 2));
    const meta = first.readMeta(msg.id);
    meta.state = state;
    first.writeMeta(meta);

    const restarted = makeDelivery(env);
    restarted.reconcile();
    assert.equal(restarted.queue.get(msg.id).needsProbe, true, `${state} remains indeterminate`);
    const session = fakeSession({ probeImpl: () => true });
    assert.equal(await restarted.deliverStep(session), "delivered");
    assert.deepEqual(session.calls.probes, [msg.id]);
    assert.equal(session.calls.startTurn.length, 0);
    assert.equal(session.calls.steerTurn.length, 0);
    assert.equal(existsSync(indeterminateTombstonePath(msg.id, env)), false,
      "probe-found messages use delivered state, not an indeterminate terminal tombstone");
  }
});

test("turn/start busy result re-queues without consuming an attempt", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ startTurnImpl: () => ({ busy: true }) });
  assert.equal(await delivery.deliverStep(session), "deferred");
  const meta = delivery.readMeta(msg.id);
  assert.equal(meta.state, "staged");
  assert.equal(meta.attempts, 0);
});

test("failed attempts back off and dead-letter after MAX_ATTEMPTS", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e, m, c) => events.push({ e, c }) });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ startTurnImpl: () => { throw rpcError("model backend unavailable"); } });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const entry = delivery.queue.get(msg.id);
    if (entry) entry.meta.nextAttemptAt = 0; // fast-forward backoff for the test
    const outcome = await delivery.deliverStep(session);
    assert.equal(outcome, "failed");
    if (attempt < MAX_ATTEMPTS) {
      const meta = delivery.readMeta(msg.id);
      assert.equal(meta.attempts, attempt);
      assert.ok(meta.nextAttemptAt > Date.now(), "backoff scheduled");
    }
  }
  assert.equal(delivery.queue.size, 0);
  const deadLetters = readdirSync(exhaustedDir(env));
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0], new RegExp(msg.id));
  assert.ok(events.some((x) => x.e === "codex.delivery_retry"));
  assert.ok(events.some((x) => x.e === "codex.delivery_exhausted"));
});

test("failed dead-letter move remains durable and retries locally after restart without another turn", async () => {
  const env = makeEnv();
  let moveAttempts = 0;
  const delivery = makeDelivery(env, {
    deadLetterMove: () => {
      moveAttempts += 1;
      throw new Error("simulated exhausted filesystem failure");
    },
  });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const failing = fakeSession({ startTurnImpl: () => { throw rpcError("clean rejection"); } });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const entry = delivery.queue.get(msg.id);
    if (entry) entry.meta.nextAttemptAt = 0;
    assert.equal(await delivery.deliverStep(failing), "failed");
  }
  assert.equal(moveAttempts, 1);
  assert.equal(failing.calls.startTurn.length, MAX_ATTEMPTS);
  assert.ok(delivery.queue.has(msg.id), "failed local move retains the queue entry");
  assert.ok(existsSync(delivery.stagedPath(msg.id)), "staged payload remains recoverable");
  assert.ok(existsSync(delivery.metaPath(msg.id)), "terminal sidecar remains recoverable");
  assert.equal(delivery.readMeta(msg.id).state, "dead_lettering");

  const restarted = makeDelivery(env, { deadLetterMove: renameSync });
  restarted.reconcile();
  const retrySession = fakeSession();
  assert.equal(await restarted.deliverStep(retrySession), "failed");
  assert.equal(retrySession.calls.startTurn.length, 0, "restart retries only the local dead-letter move");
  assert.equal(retrySession.calls.steerTurn.length, 0);
  assert.equal(restarted.queue.size, 0);
  assert.equal(readdirSync(exhaustedDir(env)).length, 1);
  assert.match(readdirSync(exhaustedDir(env))[0], new RegExp(msg.id));
});

test("possibly-sent terminal tombstone is durable before an indeterminate dead-letter move", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env, {
    deadLetterMove: () => { throw new Error("simulated move failure after tombstone"); },
  });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const initial = fakeSession({ startTurnImpl: () => { throw new Error("connection lost after write"); } });
  assert.equal(await delivery.deliverStep(initial), "deferred");
  for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
    delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
    await delivery.deliverStep(fakeSession({ probeImpl: () => false }));
  }

  assert.ok(existsSync(indeterminateTombstonePath(msg.id, env)),
    "terminal id survives even though payload removal failed");
  assert.ok(existsSync(delivery.stagedPath(msg.id)), "payload remains for local recovery");
  const terminalMeta = delivery.readMeta(msg.id);
  assert.equal(terminalMeta.state, "dead_lettering");
  assert.equal(terminalMeta.possiblySent, true);

  const restarted = makeDelivery(env, { deadLetterMove: renameSync });
  restarted.reconcile();
  const session = fakeSession();
  assert.equal(await restarted.deliverStep(session), "failed");
  assert.equal(session.calls.startTurn.length, 0);
  assert.equal(session.calls.steerTurn.length, 0);
  assert.equal(session.calls.probes.length, 0);
  assert.equal(restarted.queue.size, 0);
});

test("backoff parking: entry is not retried before nextAttemptAt", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ startTurnImpl: () => { throw rpcError("transient"); } });
  await delivery.deliverStep(session);
  // Parked: next step sees nothing actionable.
  assert.equal(await delivery.deliverStep(fakeSession()), "idle");
  assert.equal(delivery.queue.get(msg.id).meta.attempts, 1);
});

test("indeterminate turn/start (timeout) probes before ANY re-delivery: found => finalize", async () => {
  const env = makeEnv();
  const ledger = new Set();
  const delivery = makeDelivery(env, { ledger });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const timeoutSession = fakeSession({ startTurnImpl: () => { throw new Error("turn/start timed out after 30000ms"); } });
  assert.equal(await delivery.deliverStep(timeoutSession), "deferred");
  assert.equal(delivery.queue.get(msg.id).needsProbe, true);

  const probeSession = fakeSession({ probeImpl: () => true });
  assert.equal(await delivery.deliverStep(probeSession), "delivered");
  assert.deepEqual(probeSession.calls.probes, [msg.id]);
  assert.equal(probeSession.calls.startTurn.length, 0, "no double turn");
  assert.ok(ledger.has(msg.id));
});

test("AT-MOST-ONCE: after an ambiguous send, authoritative ABSENT is NOT permission to resend — bounded probes then explicit indeterminate dead letter", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e, m, c) => events.push({ e, c }) });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  await delivery.deliverStep(fakeSession({ startTurnImpl: () => { throw new Error("connection closed: exit"); } }));
  let totalStartTurns = 0;
  for (let i = 1; i <= MAX_PROBE_FAILURES; i += 1) {
    delivery.queue.get(msg.id).meta.nextAttemptAt = 0; // fast-forward probe backoff
    const session = fakeSession({ probeImpl: () => false });
    const outcome = await delivery.deliverStep(session);
    totalStartTurns += session.calls.startTurn.length;
    if (i < MAX_PROBE_FAILURES) assert.equal(outcome, "deferred", "probing the late-acceptance window");
    else assert.equal(outcome, "failed");
  }
  assert.equal(totalStartTurns, 0, "NO second turn/start, ever — absence is not proof the original cannot land later");
  assert.equal(delivery.queue.size, 0);
  const deadLetters = readdirSync(exhaustedDir(env));
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0], new RegExp(msg.id));
  const exhausted = events.find((x) => x.e === "codex.delivery_exhausted");
  assert.match(exhausted.c.reason, /indeterminate_ambiguous_send_absent_no_resend/, "manual-recovery dead letter, clearly labeled");
  assert.ok(events.some((x) => x.e === "codex.delivery_indeterminate" && x.c.probe_result === "authoritative_absent"));
});

test("indeterminate terminal tombstone suppresses a duplicate already waiting in the inbox", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const initial = fakeSession({ startTurnImpl: () => { throw new Error("connection closed after write"); } });
  assert.equal(await delivery.deliverStep(initial), "deferred");
  assert.equal(initial.calls.startTurn.length, 1);

  writeInbound(delivery, { id: msg.id, content: "sender retry already waiting" }, "renamed-retry.json");
  delivery.scanInbox();
  assert.ok(existsSync(join(delivery.inboxDir, "renamed-retry.json")),
    "same-id retry remains queued while the original outcome is unresolved");

  let laterStarts = 0;
  for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
    delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
    const probe = fakeSession({ probeImpl: () => false });
    await delivery.deliverStep(probe);
    laterStarts += probe.calls.startTurn.length;
  }
  assert.equal(laterStarts, 0);
  assert.ok(existsSync(indeterminateTombstonePath(msg.id, env)),
    "possibly-sent terminal id is persisted before queue removal");
  assert.equal(loadLedger(env).has(msg.id), false,
    "indeterminate terminal ids remain semantically distinct from delivered ids");

  delivery.scanInbox();
  assert.equal(existsSync(join(delivery.inboxDir, "renamed-retry.json")), false);
  assert.ok(readdirSync(delivery.failedDir).includes("renamed-retry.json"),
    "later duplicate is quarantined by validated message id, independent of filename");
  assert.equal(initial.calls.startTurn.length + laterStarts, 1, "exactly one total turn/start");
});

test("restart reconcile suppresses a same-id duplicate staged under another filename", async () => {
  const env = makeEnv();
  const first = makeDelivery(env);
  const msg = writeInbound(first);
  first.scanInbox();
  const initial = fakeSession({ startTurnImpl: () => { throw new Error("connection closed after write"); } });
  assert.equal(await first.deliverStep(initial), "deferred");
  for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
    first.queue.get(msg.id).meta.nextAttemptAt = 0;
    await first.deliverStep(fakeSession({ probeImpl: () => false }));
  }
  assert.ok(existsSync(indeterminateTombstonePath(msg.id, env)));

  // Simulate a replay claimed by an older process just before restart. The
  // staging filename is deliberately unrelated to the envelope's id.
  const replayName = "different-file-after-restart.json";
  writeFileSync(join(first.stagingDir, replayName), JSON.stringify({
    ...msg,
    content: "replayed after terminal dead letter",
    timestamp: new Date().toISOString(),
  }, null, 2));

  const restarted = makeDelivery(env, { ledger: loadLedger(env) });
  restarted.reconcile();
  assert.equal(restarted.queue.size, 0);
  assert.ok(readdirSync(restarted.failedDir).includes(replayName));
  const session = fakeSession();
  assert.equal(await restarted.deliverStep(session), "idle");
  assert.equal(session.calls.startTurn.length, 0);
  assert.equal(session.calls.steerTurn.length, 0);
  assert.equal(session.calls.probes.length, 0);
  assert.equal(initial.calls.startTurn.length + session.calls.startTurn.length, 1,
    "terminal id remains at-most-once across restart");
});

test("probe unavailable N times dead-letters instead of risking a double turn", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  await delivery.deliverStep(fakeSession({ startTurnImpl: () => { throw new Error("timed out after 1ms"); } }));
  for (let i = 1; i <= MAX_PROBE_FAILURES; i += 1) {
    delivery.queue.get(msg.id).meta.nextAttemptAt = 0; // fast-forward probe backoff
    const outcome = await delivery.deliverStep(fakeSession({ probeImpl: () => null }));
    if (i < MAX_PROBE_FAILURES) assert.equal(outcome, "deferred");
    else assert.equal(outcome, "failed");
  }
  assert.equal(delivery.queue.size, 0);
  const deadLetters = readdirSync(exhaustedDir(env));
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0], new RegExp(msg.id));
});

for (const transportCode of ["EPIPE", "ERR_STREAM_DESTROYED"]) {
  test(`AT-MOST-ONCE: raw ${transportCode} after turn/start is ambiguous and never re-sent`, async () => {
    const env = makeEnv();
    const delivery = makeDelivery(env);
    const msg = writeInbound(delivery);
    delivery.scanInbox();
    const transportError = Object.assign(new Error(`stdin write failed: ${transportCode}`), { code: transportCode });
    const first = fakeSession({ startTurnImpl: () => { throw transportError; } });
    assert.equal(await delivery.deliverStep(first), "deferred");
    assert.equal(first.calls.startTurn.length, 1);
    assert.equal(delivery.queue.get(msg.id).needsProbe, true);

    let laterStarts = 0;
    for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
      delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
      const probe = fakeSession({ probeImpl: () => false });
      await delivery.deliverStep(probe);
      laterStarts += probe.calls.startTurn.length;
    }
    assert.equal(laterStarts, 0, "an absent history probe never authorizes a second turn/start");
    assert.equal(delivery.queue.size, 0, "ambiguous message ends in manual-recovery dead letter");
  });
}

test("AT-MOST-ONCE: malformed successful turn/start without turn id is indeterminate, never finalized or re-sent", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const malformed = fakeSession({ startTurnImpl: () => ({}) });
  assert.equal(await delivery.deliverStep(malformed), "deferred");
  assert.equal(delivery.queue.get(msg.id).needsProbe, true);
  assert.equal(delivery.ledger.has(msg.id), false);
  let laterStarts = 0;
  for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
    delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
    const probe = fakeSession({ probeImpl: () => false });
    await delivery.deliverStep(probe);
    laterStarts += probe.calls.startTurn.length;
  }
  assert.equal(laterStarts, 0);
  assert.equal(delivery.queue.size, 0);
});

test("clean pre-acceptance RPC errors still retry normally (not charged to the at-most-once path)", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  // A clean rejection (not timeout/pipe): the request was never accepted.
  await delivery.deliverStep(fakeSession({ startTurnImpl: () => { throw rpcError("model backend unavailable"); } }));
  assert.equal(delivery.queue.get(msg.id).needsProbe, false, "clean failure is not indeterminate");
  assert.equal(existsSync(indeterminateTombstonePath(msg.id, env)), false,
    "a proven clean rejection remains retryable and gets no terminal tombstone");
  delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
  const session = fakeSession();
  assert.equal(await delivery.deliverStep(session), "delivered");
  assert.equal(session.calls.startTurn.length, 1, "safe resend because the first request provably failed pre-acceptance");
});

test("steering policy: steer into a BRIDGE-OWNED turn finalizes without turn/start", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env, { policy: { steering: true } });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ turnActive: true, turnOurs: true });
  const outcome = await delivery.deliverStep(session);
  assert.equal(outcome, "delivered");
  assert.equal(session.calls.steerTurn.length, 1);
  assert.equal(session.calls.steerTurn[0].expectedTurnId, "turn-live");
  assert.equal(session.calls.steerTurn[0].clientUserMessageId, msg.id);
  assert.equal(session.calls.startTurn.length, 0);
});

test("steering NEVER targets a FOREIGN turn (policies unknowable) — queues instead", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { policy: { steering: true }, logEvent: (l, e) => events.push(e) });
  writeInbound(delivery);
  delivery.scanInbox();
  const session = fakeSession({ turnActive: true, turnOurs: false });
  const outcome = await delivery.deliverStep(session);
  assert.equal(outcome, "deferred");
  assert.equal(session.calls.steerTurn.length, 0, "turn/steer cannot apply safe policies to a foreign turn");
  assert.equal(session.calls.startTurn.length, 0);
  assert.ok(events.includes("codex.queue_deferred_active_turn"));
});

test("steer timeout is indeterminate: probe gate before retry, no duplicate", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env, { policy: { steering: true } });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const timeoutSession = fakeSession({ turnActive: true, turnOurs: true, steerImpl: () => { throw new Error("turn/steer timed out after 15000ms"); } });
  assert.equal(await delivery.deliverStep(timeoutSession), "deferred");
  assert.equal(delivery.queue.get(msg.id).needsProbe, true);
  const probeSession = fakeSession({ probeImpl: () => true });
  assert.equal(await delivery.deliverStep(probeSession), "delivered");
  assert.equal(probeSession.calls.startTurn.length, 0);
  assert.equal(probeSession.calls.steerTurn.length, 0);
});

for (const transportCode of ["EPIPE", "ERR_STREAM_DESTROYED"]) {
  test(`AT-MOST-ONCE: raw ${transportCode} after turn/steer is ambiguous and never re-sent`, async () => {
    const env = makeEnv();
    const delivery = makeDelivery(env, { policy: { steering: true } });
    const msg = writeInbound(delivery);
    delivery.scanInbox();
    const transportError = Object.assign(new Error(`stdin write failed: ${transportCode}`), { code: transportCode });
    const first = fakeSession({
      turnActive: true,
      turnOurs: true,
      steerImpl: () => { throw transportError; },
    });
    assert.equal(await delivery.deliverStep(first), "deferred");
    assert.equal(first.calls.steerTurn.length, 1);
    assert.equal(delivery.queue.get(msg.id).needsProbe, true);

    let laterRpcCalls = 0;
    for (let i = 0; i < MAX_PROBE_FAILURES; i += 1) {
      delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
      const probe = fakeSession({ probeImpl: () => false });
      await delivery.deliverStep(probe);
      laterRpcCalls += probe.calls.startTurn.length + probe.calls.steerTurn.length;
    }
    assert.equal(laterRpcCalls, 0, "an absent history probe never authorizes another turn RPC");
    assert.equal(delivery.queue.size, 0);
  });
}

test("steer clean RPC rejection falls back to the queue path (turn/start when idle)", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { policy: { steering: true }, logEvent: (l, e) => events.push(e) });
  writeInbound(delivery);
  delivery.scanInbox();
  const failSession = fakeSession({ turnActive: true, turnOurs: true, steerImpl: () => { throw rpcError("expected turn already completed", -32000, "turn/steer"); } });
  assert.equal(await delivery.deliverStep(failSession), "deferred");
  assert.ok(events.includes("codex.steer_fallback"));
  const idleSession = fakeSession();
  assert.equal(await delivery.deliverStep(idleSession), "delivered");
  assert.equal(idleSession.calls.startTurn.length, 1);
});

test("reconcile re-adopts staged claims and preserves attempts across restart", async () => {
  const env = makeEnv();
  const ledger = new Set();
  const first = makeDelivery(env, { ledger });
  const msg = writeInbound(first);
  first.scanInbox();
  await first.deliverStep(fakeSession({ startTurnImpl: () => { throw rpcError("transient"); } }));
  assert.equal(first.readMeta(msg.id).attempts, 1);

  // "Restart": fresh AliasDelivery over the same durable state.
  const second = makeDelivery(env, { ledger: loadLedger(env) });
  second.reconcile();
  const entry = second.queue.get(msg.id);
  assert.ok(entry, "staged claim re-adopted");
  assert.equal(entry.meta.attempts, 1);
  assert.equal(entry.needsProbe, false);
  entry.meta.nextAttemptAt = 0;
  assert.equal(await second.deliverStep(fakeSession()), "delivered");
});

test("failed staging reconciliation blocks inbox claims until the original indeterminate state is recovered", async () => {
  const env = makeEnv();
  const first = makeDelivery(env);
  const msg = writeInbound(first);
  first.scanInbox();
  const meta = first.readMeta(msg.id);
  meta.state = "turn_starting";
  meta.possiblySent = true;
  first.writeMeta(meta);

  let failEnumeration = true;
  const restarted = makeDelivery(env, {
    stagingReadDir: (dir) => {
      if (failEnumeration) {
        failEnumeration = false;
        const error = new Error("simulated EACCES");
        error.code = "EACCES";
        throw error;
      }
      return readdirSync(dir);
    },
  });
  assert.throws(() => restarted.reconcile(), /cannot reconcile Codex staging directory/);
  writeInbound(restarted, { id: msg.id, content: "sender retry must not overwrite" }, "duplicate-retry.json");

  restarted.scanInbox();
  assert.equal(restarted.readMeta(msg.id).state, "turn_starting", "original probe gate survives recovery");
  assert.equal(JSON.parse(readFileSync(restarted.stagedPath(msg.id), "utf8")).content, msg.content,
    "retained possibly-sent payload was not overwritten by the retry");
  const session = fakeSession({ probeImpl: () => true });
  assert.equal(await restarted.deliverStep(session), "delivered");
  assert.equal(session.calls.startTurn.length, 0, "recovered ambiguous work is probed, never sent twice");
});

test("reconcile: crash after turn/start success (turn_active meta) finalizes as delivered", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const meta = delivery.readMeta(msg.id);
  meta.state = "turn_active";
  meta.turnId = "turn-99";
  delivery.writeMeta(meta);

  const ledger = new Set();
  const fresh = makeDelivery(env, { ledger });
  fresh.reconcile();
  assert.equal(fresh.queue.size, 0);
  assert.ok(ledger.has(msg.id));
  assert.equal(readdirSync(fresh.archiveDir).length, 1);
  assert.equal(readdirSync(fresh.stagingDir).length, 0);
});

test("ledger persistence failure retains a delivered tombstone and restart finalizes without another turn", async () => {
  const env = makeEnv();
  const ledger = new Set();
  let ledgerCalls = 0;
  const delivery = makeDelivery(env, {
    ledger,
    appendLedgerImpl: () => {
      ledgerCalls += 1;
      throw Object.assign(new Error("simulated ledger fsync failure"), { code: "EIO" });
    },
  });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const firstSession = fakeSession();
  assert.equal(await delivery.deliverStep(firstSession), "deferred");
  assert.equal(firstSession.calls.startTurn.length, 1, "the turn was accepted exactly once");
  assert.equal(ledgerCalls, 1);
  assert.equal(delivery.readMeta(msg.id).state, "delivered");
  assert.equal(existsSync(delivery.stagedPath(msg.id)), true, "staged payload retained for recovery");
  assert.equal(ledger.has(msg.id), false, "in-memory ledger is not advanced ahead of disk");

  // Restart with working storage: delivered meta retries only ledger/archive.
  const recoveredLedger = loadLedger(env);
  const recovered = makeDelivery(env, { ledger: recoveredLedger });
  recovered.reconcile();
  assert.equal(recovered.queue.size, 0);
  assert.ok(recoveredLedger.has(msg.id));
  assert.equal(readdirSync(recovered.archiveDir).length, 1);

  // A sender retry of the same id is consumed by the durable ledger and can
  // never create a second turn.
  writeInbound(recovered, { id: msg.id, content: "duplicate retry" });
  recovered.scanInbox();
  const duplicateSession = fakeSession();
  assert.equal(await recovered.deliverStep(duplicateSession), "idle");
  assert.equal(duplicateSession.calls.startTurn.length, 0);
});

test("reconcile: crash mid turn/start (turn_starting meta) requires a probe before redelivery", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const meta = delivery.readMeta(msg.id);
  meta.state = "turn_starting";
  delivery.writeMeta(meta);

  const fresh = makeDelivery(env);
  fresh.reconcile();
  const entry = fresh.queue.get(msg.id);
  assert.equal(entry.needsProbe, true);
  const session = fakeSession({ probeImpl: () => true });
  assert.equal(await fresh.deliverStep(session), "delivered");
  assert.equal(session.calls.startTurn.length, 0);
});

test("reconcile: MISSING meta for a claimed file is INDETERMINATE (probe before any resend); orphan meta dropped", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  // Simulate: meta lost + an orphan meta for a message that no longer exists.
  unlinkSync(delivery.metaPath(msg.id));
  writeFileSync(join(delivery.stagingDir, "msg-ghost.meta.json"), JSON.stringify({ id: "msg-ghost", state: "staged", attempts: 0 }));

  const fresh = makeDelivery(env);
  fresh.reconcile();
  const entry = fresh.queue.get(msg.id);
  assert.ok(entry);
  assert.equal(entry.needsProbe, true, "missing meta must never be assumed safe-staged");
  assert.equal(existsSync(join(fresh.stagingDir, "msg-ghost.meta.json")), false);
  // Probe found => finalize with ZERO new turn/start (no double turn).
  const session = fakeSession({ probeImpl: () => true });
  assert.equal(await fresh.deliverStep(session), "delivered");
  assert.equal(session.calls.startTurn.length, 0);
});

test("reconcile: CORRUPT meta is also indeterminate — resolved by probe, never by resend", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  writeFileSync(delivery.metaPath(msg.id), "{{{ torn write", "utf8");
  const fresh = makeDelivery(env);
  fresh.reconcile();
  assert.equal(fresh.queue.get(msg.id).needsProbe, true);
  // Found in the thread => finalize with ZERO new turn/start.
  const session = fakeSession({ probeImpl: () => true });
  assert.equal(await fresh.deliverStep(session), "delivered");
  assert.equal(session.calls.startTurn.length, 0);
});

test("first-ever claim stays distinguishable: normal claims carry durable staged meta and deliver WITHOUT probing", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  assert.equal(delivery.readMeta(msg.id).state, "staged");
  const fresh = makeDelivery(env);
  fresh.reconcile();
  assert.equal(fresh.queue.get(msg.id).needsProbe, false, "durable staged meta => no probe needed");
  const session = fakeSession();
  assert.equal(await fresh.deliverStep(session), "delivered");
  assert.equal(session.calls.probes.length, 0);
});

test("reconcile quarantines tampered staged files", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  writeFileSync(delivery.stagedPath(msg.id), "corrupted {{{", "utf8");
  const fresh = makeDelivery(env);
  fresh.reconcile();
  assert.equal(fresh.queue.size, 0);
  assert.equal(readdirSync(fresh.failedDir).length, 1);
});

test("legacy delivered ledger tolerates duplicates but fails closed on malformed retained ids", () => {
  const env = makeEnv();
  mkdirSync(join(deliveredLedgerPath(env), ".."), { recursive: true });
  writeFileSync(deliveredLedgerPath(env), "msg-a\nmsg-a\n\nmsg-b\n");
  const ledger = loadLedger(env);
  assert.ok(ledger.has("msg-a"));
  assert.ok(ledger.has("msg-b"));
  appendLedger("msg-a", ledger, env); // idempotent, no duplicate append
  const lines = readFileSync(deliveredLedgerPath(env), "utf8").split("\n").filter((l) => l === "msg-a");
  assert.equal(lines.length, 2, "pre-existing duplicates tolerated, no new one added");

  writeFileSync(deliveredLedgerPath(env), "msg-a\n<<garbage line>>\nmsg-b\n");
  assert.throws(() => loadLedger(env), CodexLedgerStateError);
});

test("delivered tombstone loading fails closed on empty, mismatched, or unreadable retained state", () => {
  const env = makeEnv();
  const id = "msg-ledger-corruption-aaaa-4bbb-8ccc-ddddeeee0000";
  const ledger = new Set();
  appendLedger(id, ledger, env);
  const path = deliveredTombstonePath(id, env);
  assert.ok(loadLedger(env).has(id));

  writeFileSync(path, "");
  assert.throws(() => loadLedger(env), CodexLedgerStateError, "empty tombstone blocks startup");

  writeFileSync(path, "msg-different-valid-id\n");
  assert.throws(() => loadLedger(env), CodexLedgerStateError, "body/path hash mismatch blocks startup");

  unlinkSync(path);
  mkdirSync(path);
  assert.throws(() => loadLedger(env), CodexLedgerStateError, "non-file tombstone blocks startup");
});

test("indeterminate tombstone loading is retained in memory and fails closed on corruption", () => {
  const env = makeEnv();
  const id = "msg-indeterminate-corruption-aaaa-4bbb-8ccc-ddddeeee0000";
  persistIndeterminateTombstone(id, env);
  const path = indeterminateTombstonePath(id, env);
  assert.ok(loadIndeterminateLedger(env).has(id));
  assert.equal(hasIndeterminateTombstone(id, env, loadIndeterminateLedger(env)), true);

  writeFileSync(path, "");
  assert.throws(() => loadIndeterminateLedger(env), CodexLedgerStateError, "empty possibly-sent tombstone blocks startup");

  writeFileSync(path, "msg-different-valid-id\n");
  assert.throws(() => loadLedger(env), CodexLedgerStateError, "all startup loaders validate the possibly-sent set");
});

test("delivered-id retention never evicts old ids when the legacy ledger exceeds the former cap", () => {
  const env = makeEnv();
  const path = deliveredLedgerPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  const ids = Array.from({ length: 10_000 }, (_, i) => `msg-retained-${String(i).padStart(5, "0")}-${"x".repeat(48)}`);
  writeFileSync(path, `${ids.join("\n")}\n`);
  const ledger = loadLedger(env);
  appendLedger("msg-new-after-large-ledger", ledger, env);
  const restarted = loadLedger(env);
  assert.ok(restarted.has(ids[0]), "earliest id survives; no half-ledger compaction");
  assert.ok(restarted.has(ids.at(-1)));
  assert.ok(restarted.has("msg-new-after-large-ledger"));
});

test("claim race: file consumed by another process mid-scan is skipped silently", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  // Pre-claim the file the way a raced sibling would (rename target exists,
  // source gone). Simulate by removing the inbox file after listing: easiest
  // deterministic approximation is to claim once, then re-scan.
  delivery.scanInbox();
  delivery.scanInbox(); // second scan sees empty inbox + already-queued id
  assert.equal(delivery.queue.size, 1);
  assert.equal(delivery.readMeta(msg.id).state, "staged");
});

// ── Durable state gating (injected failures) ────────────────────────────────

test("pre-send durable-state gate: if the turn_starting meta cannot be written, NO turn/start goes out", async () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e) => events.push(e) });
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const realWriteMeta = delivery.writeMeta.bind(delivery);
  delivery.writeMeta = (meta) => {
    if (meta.state === "turn_starting") throw new Error("disk on fire");
    return realWriteMeta(meta);
  };
  const session = fakeSession();
  const outcome = await delivery.deliverStep(session);
  assert.equal(outcome, "failed");
  assert.equal(session.calls.startTurn.length, 0, "no send without a durable indeterminate marker");
  assert.ok(events.includes("codex.delivery_retry"));
  assert.equal(delivery.queue.get(msg.id).meta.attempts, 1);
  // Recovery: writes work again => delivery proceeds normally.
  delivery.writeMeta = realWriteMeta;
  delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
  assert.equal(await delivery.deliverStep(fakeSession()), "delivered");
});

test("pre-steer durable-state gate blocks the steer the same way", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env, { policy: { steering: true } });
  writeInbound(delivery);
  delivery.scanInbox();
  const realWriteMeta = delivery.writeMeta.bind(delivery);
  delivery.writeMeta = (meta) => {
    if (meta.state === "steering") throw new Error("disk on fire");
    return realWriteMeta(meta);
  };
  const session = fakeSession({ turnActive: true, turnOurs: true });
  assert.equal(await delivery.deliverStep(session), "failed");
  assert.equal(session.calls.steerTurn.length, 0);
});

test("lease fence loss immediately before turn/start or turn/steer sends zero RPCs", async () => {
  for (const steering of [false, true]) {
    const env = makeEnv();
    let fenceChecks = 0;
    const delivery = makeDelivery(env, {
      policy: { steering },
      // First check permits the durable pre-send marker; second simulates a
      // lease replacement in the final pre-RPC window.
      sendFence: () => ++fenceChecks === 1,
    });
    const msg = writeInbound(delivery);
    delivery.scanInbox();
    const session = fakeSession({ turnActive: steering, turnOurs: steering });
    assert.equal(await delivery.deliverStep(session), "deferred");
    assert.equal(session.calls.startTurn.length, 0);
    assert.equal(session.calls.steerTurn.length, 0);
    assert.equal(delivery.readMeta(msg.id).state, "staged", "unsent entry remains safely retryable");
  }
});

test("claim meta-write failure UN-claims the file (no claimed-without-meta window)", () => {
  const env = makeEnv();
  const events = [];
  const delivery = makeDelivery(env, { logEvent: (l, e) => events.push(e) });
  const msg = writeInbound(delivery);
  const realWriteMeta = delivery.writeMeta.bind(delivery);
  delivery.writeMeta = () => { throw new Error("disk full"); };
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.ok(events.includes("codex.claim_meta_write_failed"));
  assert.ok(existsSync(join(delivery.inboxDir, `${msg.id}.json`)), "claim rolled back to inbox");
  // Next scan with healthy disk claims normally.
  delivery.writeMeta = realWriteMeta;
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 1);
});

test("crash mid-finalize (durable delivered meta) completes the finalize on reconcile — never redelivers", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const meta = delivery.readMeta(msg.id);
  meta.state = "delivered";
  delivery.writeMeta(meta); // ledger/archive never happened — crash point
  const ledger = new Set();
  const fresh = makeDelivery(env, { ledger });
  fresh.reconcile();
  assert.equal(fresh.queue.size, 0);
  assert.ok(ledger.has(msg.id));
  assert.equal(readdirSync(fresh.archiveDir).length, 1);
  assert.equal(readdirSync(fresh.stagingDir).length, 0);
});

test("archive failure during finalize keeps a durable delivered marker — reconcile completes, never reopens delivery", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const realArchive = delivery.archiveDelivered.bind(delivery);
  delivery.archiveDelivered = () => false; // injected archive failure
  const session = fakeSession();
  assert.equal(await delivery.deliverStep(session), "deferred");
  assert.equal(delivery.queue.get(msg.id).needsFinalize, true);
  assert.ok(delivery.ledger.has(msg.id));
  assert.equal(delivery.readMeta(msg.id).state, "delivered", "durable delivered marker retained");
  // Restart with a working archive: finalize completes, no redelivery.
  delivery.archiveDelivered = realArchive;
  const fresh = makeDelivery(env, { ledger: new Set() });
  fresh.reconcile();
  assert.equal(fresh.queue.size, 0);
  assert.equal(readdirSync(fresh.archiveDir).length, 1);
  const session2 = fakeSession();
  assert.equal(await fresh.deliverStep(session2), "idle");
  assert.equal(session2.calls.startTurn.length, 0);
});

// ── FIFO + backoff interaction ──────────────────────────────────────────────

test("STRICT FIFO: a backoff-parked HEAD is never bypassed by newer messages", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const older = writeInbound(delivery, { timestamp: new Date(Date.now() - 60_000).toISOString() });
  const newer = writeInbound(delivery, { timestamp: new Date().toISOString() });
  delivery.scanInbox();
  // Head fails once -> parked with backoff.
  const failing = fakeSession({ startTurnImpl: () => { throw rpcError("transient"); } });
  assert.equal(await delivery.deliverStep(failing), "failed");
  assert.ok(delivery.queue.get(older.id).meta.nextAttemptAt > Date.now());
  // While the head is parked, the newer message must NOT jump the queue.
  const eager = fakeSession();
  assert.equal(await delivery.deliverStep(eager), "idle");
  assert.equal(eager.calls.startTurn.length, 0, "ordering preserved: parked head blocks (bounded by dead-letter caps)");
  // Head becomes ready again -> delivered first, then the newer one.
  delivery.queue.get(older.id).meta.nextAttemptAt = 0;
  const session = fakeSession();
  await delivery.deliverStep(session);
  await delivery.deliverStep(session);
  assert.equal(session.calls.startTurn[0].clientUserMessageId, older.id);
  assert.equal(session.calls.startTurn[1].clientUserMessageId, newer.id);
});

test("every documented backoff delay is reachable: 5s, 30s, 120s, then dead-letter", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  const failing = fakeSession({ startTurnImpl: () => { throw rpcError("still broken"); } });
  const observedBackoffs = [];
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const entry = delivery.queue.get(msg.id);
    entry.meta.nextAttemptAt = 0;
    assert.equal(await delivery.deliverStep(failing), "failed");
    const remaining = delivery.queue.get(msg.id);
    assert.ok(remaining, `attempt ${attempt} parks rather than dead-letters`);
    observedBackoffs.push(remaining.meta.nextAttemptAt - Date.now());
  }
  // Delays observed: ~5s, ~30s, ~120s (allow scheduling slack).
  assert.ok(observedBackoffs[0] > 3_000 && observedBackoffs[0] <= 5_000);
  assert.ok(observedBackoffs[1] > 25_000 && observedBackoffs[1] <= 30_000);
  assert.ok(observedBackoffs[2] > 100_000 && observedBackoffs[2] <= 120_000, "the 120s delay is genuinely reachable");
  // Final attempt dead-letters.
  delivery.queue.get(msg.id).meta.nextAttemptAt = 0;
  assert.equal(await delivery.deliverStep(failing), "failed");
  assert.equal(delivery.queue.size, 0);
  assert.equal(readdirSync(exhaustedDir(env)).length, 1);
});

test("poison head drains via the bounded terminal path and later work proceeds", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const poison = writeInbound(delivery, { timestamp: new Date(Date.now() - 60_000).toISOString() });
  const healthy = writeInbound(delivery);
  delivery.scanInbox();
  const failing = fakeSession({ startTurnImpl: (args) => {
    if (args.clientUserMessageId === poison.id) throw new Error("permanently poisoned");
    return { turnId: "turn-ok" };
  } });
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const entry = delivery.queue.get(poison.id);
    if (entry) entry.meta.nextAttemptAt = 0;
    await delivery.deliverStep(failing);
  }
  assert.equal(delivery.queue.has(poison.id), false, "poison dead-lettered, head unblocked");
  assert.equal(await delivery.deliverStep(failing), "delivered");
  assert.ok(delivery.ledger.has(healthy.id));
});

// ── Hostile envelope files ──────────────────────────────────────────────────

test("oversized FILES are quarantined before parsing", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  mkdirSync(delivery.inboxDir, { recursive: true });
  writeFileSync(join(delivery.inboxDir, "huge.json"), Buffer.alloc(1024 * 1024 + 70 * 1024, 0x41));
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.ok(readdirSync(delivery.failedDir).includes("huge.json"));
});

test("symlinks and non-regular files are rejected unread", (t) => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  mkdirSync(delivery.inboxDir, { recursive: true });
  const secret = join(env.AGENT_BRIDGE_HOME, "secret.json");
  writeFileSync(secret, JSON.stringify({ id: "msg-secret" }));
  try {
    symlinkSync(secret, join(delivery.inboxDir, "sneaky.json"));
  } catch {
    t.skip("symlinks unavailable on this platform/permission level");
    return;
  }
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.ok(readdirSync(delivery.failedDir).includes("sneaky.json"), "the LINK is quarantined, target untouched");
  assert.ok(existsSync(secret));
});

test("hostile timestamps (1e300, NaN-producing) are quarantined and cannot poison FIFO ordering", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  writeInbound(delivery, { timestamp: 1e300 });
  writeInbound(delivery, { timestamp: "not-a-date" });
  writeInbound(delivery, { timestamp: -5 });
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.equal(readdirSync(delivery.failedDir).length, 3);
});

test("oversized routing metadata (from) is quarantined", () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  writeInbound(delivery, { from: "F".repeat(600) });
  delivery.scanInbox();
  assert.equal(delivery.queue.size, 0);
  assert.equal(readdirSync(delivery.failedDir).length, 1);
});

test("unexpected composition failures charge the bounded terminal path", async () => {
  const env = makeEnv();
  const delivery = makeDelivery(env);
  const msg = writeInbound(delivery);
  delivery.scanInbox();
  // Corrupt the in-memory binding so composeTurnInputText throws (policy
  // reads still succeed; the throw happens inside the compose try/catch).
  const broken = { alias: delivery.alias, cwd: null, policy: delivery.binding.policy };
  Object.defineProperty(broken, "threadId", { get() { throw new Error("compose boom"); } });
  delivery.binding = broken;
  const session = fakeSession();
  assert.equal(await delivery.deliverStep(session), "failed");
  assert.equal(session.calls.startTurn.length, 0);
  assert.equal(delivery.queue.get(msg.id).meta.attempts, 1);
});
