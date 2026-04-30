/**
 * 3.9.0 [CONSUME-RACE] — regression coverage for the hybrid AC delivery flow.
 *
 * Pre-3.9 the watcher called markDelivered + archiveDeliveredMessage as soon
 * as the channel callback's Promise resolved. Stdout-write success is NOT
 * proof the receiving harness rendered the message — Windows reproduced 6
 * silent drops in one session under that model. 3.9 splits the path into:
 *
 *   1. push    — file moves to `.pending-ack/<target>/` + sidecar meta
 *   2. tick    — every 2 s (in-process: every poll cycle)
 *      - early-defer (5 s + alive-evidence + still own lease) → finalize
 *      - safety-net (180 s + no alive-evidence) → re-inject for retry
 *      - retry cap (1) → move to `.failed/.exhausted/`
 *   3. handover — files older than 30 s in `.pending-ack/` are recovered by
 *                 the new lease holder's `replayUndeliveredMessages`
 *   4. escape  — 5+ pushes within 30 s with no alive evidence flips
 *                channelMarkedDead; future pushes skip the callback
 *
 * 3.12.1 [DEDUP-RECEIVE-INJECT 2026-04-30] — safety-net 60s→180s, cap 3→1
 * to halve max-duplicate-channel-pushes for slow-thinking receivers.
 *
 * These tests drive the watcher in-process (no MCP transport) so we can
 * assert state transitions deterministically without depending on poll
 * timing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ── HOME-sandbox setup (must precede module imports) ────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), 'ab-consume-race-'));
mkdirSync(join(sandbox, '.agent-bridge'), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox; // Node's os.homedir() reads USERPROFILE on Windows, not HOME
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestMachine';
process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG = '1';
process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK = '1';
process.env.AGENT_BRIDGE_DISABLE_PATCH_F = '1';

// Dynamic imports — HOME must be in place before the modules cache their dirs.
const inbox = await import('../build/inbox.js');
const watcher = await import('../build/watcher.js');

const inboxDir = join(sandbox, '.agent-bridge', 'inbox', 'claude-code');
const pendingAckDir = join(sandbox, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code');
const archiveDir = join(sandbox, '.agent-bridge', 'inbox', '.archive', 'claude-code');
const exhaustedDir = join(sandbox, '.agent-bridge', 'inbox', '.failed', '.exhausted');
const deliveredFile = join(sandbox, '.agent-bridge', 'inbox', '.delivered');

inbox.ensureInboxDirs();
mkdirSync(inboxDir, { recursive: true });

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function dropMessage(content = 'consume-race test') {
  const msg = inbox.createMessage(
    'TestSender',
    'TestMachine',
    'message',
    content,
    null,
    600,
    'claude-code',
    'claude-code',
  );
  const filePath = join(inboxDir, `${msg.id}.json`);
  writeFileSync(filePath, JSON.stringify(msg, null, 2), { mode: 0o600 });
  return msg;
}

function deliveredLedgerHas(id) {
  if (!existsSync(deliveredFile)) return false;
  return readFileSync(deliveredFile, 'utf8').includes(id);
}

function listAck() {
  try { return readdirSync(pendingAckDir); } catch { return []; }
}

function listArchive() {
  try { return readdirSync(archiveDir); } catch { return []; }
}

function listExhausted() {
  try { return readdirSync(exhaustedDir); } catch { return []; }
}

function archiveContains(id) {
  return listArchive().some((f) => f.endsWith(`_${id}.json`));
}

function exhaustedContains(id) {
  return listExhausted().some((f) => f.endsWith(`_${id}.json`));
}

/**
 * Drive a single watcher poll pass. The exported `_fireInboxArrivalListenersForTesting`
 * does NOT trigger the file-watcher's checkForNewFiles — for that we depend
 * on the 2 s polling interval started by `startWatcher`. The cleaner path
 * for tests is to invoke the per-file emitChannelNotification directly via
 * the watcher's polling loop. Since checkForNewFiles is module-private, we
 * use the public `startWatcher`/wait/`stopWatcher` cycle and assert on
 * filesystem state.
 */

function configureCallback({ resolve = true, error = null } = {}) {
  // Returns a callback installed via startWatcher's channelCallback parameter.
  // Resolves immediately (= stdout-write succeeded) or throws.
  return async (_msg) => {
    if (error) throw error;
    if (!resolve) {
      // Hang — never resolves. The watcher applies a 10 s timeout
      // internally via withChannelNotifyTimeout, so the caller is bounded.
      return new Promise(() => {});
    }
    return undefined;
  };
}

// ── Case A: notification "fails silently" (resolves but harness drops) ──────
test('A. notification resolves but harness silently drops; file re-injected after 180s safety net', { timeout: 80_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  // Clean inbox and pending-ack so prior tests don't leak in.
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  // Configure alive signals so isHarnessAliveSincePush returns FALSE.
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  // Start watcher first — initKnownFiles snapshots the existing inbox
  // contents as "already known", so we must drop the new message AFTER
  // startup for the polling diff to detect it.
  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk, 'watcher should start');
  const msg = dropMessage('case A — silent drop');

  // Wait up to ~5s for the watcher's 2s poll loop to pick up the file and
  // stage it.
  let staged = false;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${msg.id}.json`)) { staged = true; break; }
  }
  assert.ok(staged, 'expected file to be staged into pending-ack/');

  // 3.12.1 [DEDUP-RECEIVE-INJECT] — Doctor pushedAt to 181s in the past so
  // the safety-net branch fires on the next tick (window bumped 60s→180s).
  const pending = watcher._getPendingDeliveriesForTesting();
  const entry = pending.find((p) => p.id === msg.id);
  assert.ok(entry, 'pending entry should exist for the staged file');
  entry.pushedAt = Date.now() - 181_000;

  // Drive a tick. With no alive evidence + age >= 180s, the entry must be
  // re-injected back into inbox/<target>/.
  watcher._processPendingDeliveriesForTesting();

  const inboxFiles = readdirSync(inboxDir);
  assert.ok(
    inboxFiles.includes(`${msg.id}.json`),
    `expected ${msg.id}.json to be re-injected into inbox/, got ${JSON.stringify(inboxFiles)}`,
  );
  assert.ok(
    !listAck().includes(`${msg.id}.json`),
    'pending-ack/ should no longer contain the file',
  );
  assert.equal(deliveredLedgerHas(msg.id), false, 'safety-net reinject must not mark delivered');

  watcher.stopWatcher();
  // Cleanup
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
});

// ── Case B: notification succeeds + alive-evidence within 5s → archive ──────
test('B. early-defer finalize: alive-evidence within 5s archives + marks delivered', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  // Alive signals: tool-call counter starts at 0; we'll bump it AFTER push.
  let toolCalls = 0;
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => toolCalls,
    getChannelCallbackRegisteredAt: () => 0,
  });

  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);
  const msg = dropMessage('case B — early defer');

  // Wait for stage.
  let staged = false;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${msg.id}.json`)) { staged = true; break; }
  }
  assert.ok(staged, 'file should be staged into pending-ack/');

  // Bump tool-call counter so isHarnessAliveSincePush returns TRUE for the
  // staged entry.
  toolCalls = 1;

  // Doctor pushedAt back by 5.5s so the early-defer window has elapsed.
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.ok(entry);
  entry.pushedAt = Date.now() - 5_500;

  watcher._processPendingDeliveriesForTesting();

  assert.ok(archiveContains(msg.id), 'expected file to be archived after early-defer + alive');
  assert.ok(deliveredLedgerHas(msg.id), 'expected .delivered ledger to record the msg id');
  assert.ok(!listAck().includes(`${msg.id}.json`), 'pending-ack/ should no longer hold the file');

  watcher.stopWatcher();
});

// ── Case C: notification succeeds + no activity for 180s → re-injected ──────
// 3.12.1 [DEDUP-RECEIVE-INJECT] — safety-net window bumped 60s → 180s.
test('C. safety-net reinject: no alive evidence after 180s → file goes back to inbox', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);
  const msg = dropMessage('case C — safety net');

  let staged = false;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${msg.id}.json`)) { staged = true; break; }
  }
  assert.ok(staged);

  // Doctor pushedAt to 181s ago — past the 180s safety-net window.
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.ok(entry);
  entry.pushedAt = Date.now() - 181_000;

  watcher._processPendingDeliveriesForTesting();

  // Re-injected back into inbox/.
  const inboxFiles = readdirSync(inboxDir);
  assert.ok(inboxFiles.includes(`${msg.id}.json`), 'file should be back in inbox');
  assert.equal(deliveredLedgerHas(msg.id), false, 'safety-net reinject must not mark delivered');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
});

// ── Case D: re-injection cap at 1 → moves to .failed/.exhausted/ ────────────
// 3.12.1 [DEDUP-RECEIVE-INJECT] — retry cap lowered 3 → 1.
test('D. retry cap exhaustion: 2nd reinject attempt moves file to .failed/.exhausted/', { timeout: 20_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}
  if (existsSync(exhaustedDir)) for (const f of readdirSync(exhaustedDir)) try { rmSync(join(exhaustedDir, f)); } catch {}

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);
  const msg = dropMessage('case D — retry cap');

  // Wait for stage.
  let staged = false;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${msg.id}.json`)) { staged = true; break; }
  }
  assert.ok(staged);

  // 3.12.1 [DEDUP-RECEIVE-INJECT] — Set the entry's retries to 1 (the new
  // cap) and pushedAt to 181s ago. The next safety-net trigger should bump
  // retries to 2 → exceed cap → exhaust.
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.ok(entry);
  entry.retries = 1;
  entry.pushedAt = Date.now() - 181_000;

  watcher._processPendingDeliveriesForTesting();

  assert.ok(exhaustedContains(msg.id), `expected file to land in .failed/.exhausted/, got: ${JSON.stringify(listExhausted())}`);
  assert.ok(!listAck().includes(`${msg.id}.json`), 'pending-ack/ should be cleared');
  assert.equal(deliveredLedgerHas(msg.id), false, 'exhausted retry must not mark delivered');
  assert.ok(!readdirSync(inboxDir).includes(`${msg.id}.json`), 'inbox/ should not contain the exhausted file');

  watcher.stopWatcher();
});

// ── Case E: lease handover with pending files → recovered by replay ─────────
test('E. handover replay: files in .pending-ack/ older than 30s are re-injected on replay', { timeout: 20_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  // Simulate handover: write a stale file directly into .pending-ack/ as if
  // the previous lease holder had staged it. Include retries=2 in the sidecar
  // so replay proves it does not reset the retry cap across lease handover.
  mkdirSync(pendingAckDir, { recursive: true });
  const id = `msg-${randomUUID()}`;
  const msg = inbox.createMessage(
    'TestSender', 'TestMachine', 'message', 'case E — handover', null, 600, 'claude-code', 'claude-code',
  );
  msg.id = id;
  const stalePath = join(pendingAckDir, `${id}.json`);
  const sidecarPath = join(pendingAckDir, `${id}.meta.json`);
  writeFileSync(stalePath, JSON.stringify(msg, null, 2), { mode: 0o600 });
  writeFileSync(sidecarPath, JSON.stringify({
    id,
    fileName: `${id}.json`,
    pushedAt: Date.now() - 61_000,
    retries: 2,
    target: 'claude-code',
  }, null, 2), { mode: 0o600 });
  // Backdate mtime to 31s ago via fs.utimesSync.
  const fs = await import('node:fs');
  const past = (Date.now() - 31_000) / 1000;
  fs.utimesSync(stalePath, past, past);

  // Sanity-check the staged file actually landed where the watcher expects.
  assert.ok(existsSync(stalePath), `pre-staged file should exist at ${stalePath}`);

  // startWatcher → triggers replayUndeliveredMessages once it acquires lease.
  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk, 'watcher should acquire lease for handover replay');

  // Hook the replay so we can assert it processed the handover file. After
  // re-injection the replay flow must deliver it through the same pending-ack
  // state machine as live polling. It must NOT mark delivered/archive
  // optimistically just because the channel callback resolved.
  await watcher.replayUndeliveredMessages();

  const stalePending = listAck();
  const inboxFiles = readdirSync(inboxDir);
  const archivedNow = archiveContains(id);
  const deliveredNow = deliveredLedgerHas(id);
  assert.ok(
    stalePending.includes(`${id}.json`),
    `expected handover-replay to re-stage ${id}.json into .pending-ack/; `
    + `inbox=${JSON.stringify(inboxFiles)}, pending-ack=${JSON.stringify(stalePending)}, `
    + `archived=${archivedNow}, delivered=${deliveredNow}`,
  );
  assert.equal(archivedNow, false, 'handover replay must not archive optimistically');
  assert.equal(deliveredNow, false, 'handover replay must not mark delivered optimistically');
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === id);
  assert.ok(entry, 'replayed handover file should have a pending entry');
  assert.equal(entry.retries, 2, 'handover replay must preserve sidecar retry count');

  // The file should be back at the pending-ack path after replay re-injects it
  // and the callback success re-stages it through the hybrid AC flow.
  assert.ok(existsSync(stalePath), 'handover file should be re-staged at the pending-ack path');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}
});

// ── Case F: escape-hatch — channel marked dead after 5 pushes/30s no acks ───
test('F. escape-hatch: 5 pushes in 30s without alive evidence flips channel dead; future pushes skip callback', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  // Frozen alive signals — never alive.
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  let callbackCount = 0;
  const callback = async (_msg) => { callbackCount += 1; };
  const startedOk = await watcher.startWatcher(() => {}, callback, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Drop 5 messages — each one triggers a push, fills the recent-pushes
  // window, and on the 5th the escape-hatch should arm. We need the polling
  // loop to actually pick them up; drop them with small spacing and wait.
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const m = dropMessage(`escape-${i}`);
    ids.push(m.id);
    // Wait between drops so the watcher's 2s poll stages each one separately.
    await new Promise((r) => setTimeout(r, 2_300));
  }

  // After 5 pushes within ~12 s, callback was invoked 5 times. Now drive a
  // tick with frozen alive signals to flip the dead flag.
  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    watcher._isChannelMarkedDeadForTesting(),
    `expected channel to be marked dead after ${callbackCount} pushes with no alive evidence`,
  );

  // Drop a 6th message; the channelMarkedDead branch must skip the callback
  // and stage directly to .pending-ack/.
  const callsBefore = callbackCount;
  const sixth = dropMessage('escape-after-dead');

  // Wait for the watcher to pick it up.
  let sixthStaged = false;
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 750));
    if (listAck().includes(`${sixth.id}.json`)) { sixthStaged = true; break; }
  }
  assert.ok(sixthStaged, '6th message should be staged into pending-ack/ even with dead channel');
  assert.equal(callbackCount, callsBefore, 'callback must NOT be invoked once channel is marked dead');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  // Reset for any subsequent tests.
  watcher._resetPendingDeliveriesForTesting();
});

// ── Case G: 3.9.1 retry-persistence — reinject loop terminates at cap ───────
// 3.12.1 [DEDUP-RECEIVE-INJECT] — cap dropped 3 → 1, so the loop now
// exhausts in two cycles instead of four.
test('G. retry-persistence: re-inject → re-stage twice lands the file in .failed/.exhausted/', { timeout: 40_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}
  if (existsSync(exhaustedDir)) for (const f of readdirSync(exhaustedDir)) try { rmSync(join(exhaustedDir, f)); } catch {}

  // Frozen alive signals — the 180s safety-net path will fire (we doctor
  // pushedAt to skip waiting).
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);
  const msg = dropMessage('case G — retry-persistence regression');

  // Helper: wait for stage into .pending-ack/.
  async function waitForStage(id) {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 750));
      if (listAck().includes(`${id}.json`)) return true;
    }
    return false;
  }

  // Helper: doctor pushedAt to fire the safety-net path on the next tick.
  // 3.12.1 [DEDUP-RECEIVE-INJECT] — must subtract more than PENDING_REINJECT_MS
  // (now 180s) to trigger the safety-net branch.
  function expirePushedAt(id) {
    const e = watcher._getPendingDeliveriesForTesting().find((p) => p.id === id);
    assert.ok(e, `expected pending entry for ${id}`);
    e.pushedAt = Date.now() - 181_000;
    return e;
  }

  // Initial stage.
  assert.ok(await waitForStage(msg.id), 'initial stage should succeed');

  // Cycle 1: retries 0 → 1 (re-injected).
  expirePushedAt(msg.id);
  watcher._processPendingDeliveriesForTesting();
  assert.ok(readdirSync(inboxDir).includes(`${msg.id}.json`), 'cycle 1: should be re-injected to inbox/');

  // Cycle 2: watcher polls inbox → re-stages with retries restored to 1 → fires
  // safety-net → retries 1 → 2 → exceeds cap (1) → exhausted. The bug pre-3.9.1
  // was that the retry count reset to 0 on every restage, never reaching the cap.
  assert.ok(await waitForStage(msg.id), 'cycle 2: file should be re-staged from inbox');
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.equal(entry.retries, 1, 'cycle 2: retries must be restored to 1, not reset to 0');
  expirePushedAt(msg.id);
  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    exhaustedContains(msg.id),
    `cycle 2: expected file in .failed/.exhausted/, got: ${JSON.stringify(listExhausted())}`,
  );
  assert.ok(!listAck().includes(`${msg.id}.json`), '.pending-ack/ should be empty after exhaust');
  assert.ok(!readdirSync(inboxDir).includes(`${msg.id}.json`), 'inbox/ should be empty after exhaust');
  assert.equal(deliveredLedgerHas(msg.id), false, 'exhausted retry must not mark delivered');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  watcher._resetPendingDeliveriesForTesting();
});

// ── Case H: later successful push is alive-evidence for no-tool replies ─────
test('H. later successful channel push finalizes older pending entry without tool-call evidence', { timeout: 40_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}

  // Frozen tool/reload signals: the only alive-evidence should be the later
  // successful channel notification callback.
  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
  });

  const startedOk = await watcher.startWatcher(
    () => {},
    configureCallback({ resolve: true }),
    { role: 'channel-owner' },
  );
  assert.ok(startedOk);

  async function waitForStage(id) {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 750));
      if (listAck().includes(`${id}.json`)) return true;
    }
    return false;
  }

  const first = dropMessage('case H — first no-tool message');
  assert.ok(await waitForStage(first.id), 'first message should stage into pending-ack/');
  const firstEntryBefore = watcher._getPendingDeliveriesForTesting().find((p) => p.id === first.id);
  assert.ok(firstEntryBefore, 'first pending entry should exist');

  const second = dropMessage('case H — later channel push');
  assert.ok(await waitForStage(second.id), 'second message should stage into pending-ack/');

  const firstEntry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === first.id);
  assert.ok(firstEntry, 'first pending entry should still exist before processing');
  assert.ok(
    firstEntry.successfulPushesAtStageTime >= 1,
    'first entry should snapshot the successful-push counter at its own stage time',
  );
  firstEntry.pushedAt = Date.now() - 5_500;

  watcher._processPendingDeliveriesForTesting();

  assert.ok(
    archiveContains(first.id),
    'later successful channel push should count as alive-evidence and archive the older entry',
  );
  assert.ok(deliveredLedgerHas(first.id), 'older entry should be marked delivered after later-push evidence');
  assert.ok(
    listAck().includes(`${second.id}.json`),
    'newer entry should remain pending because no still-later alive-evidence exists for it yet',
  );
  assert.equal(deliveredLedgerHas(second.id), false, 'newer entry should not be marked delivered by its own push');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  watcher._resetPendingDeliveriesForTesting();
});
