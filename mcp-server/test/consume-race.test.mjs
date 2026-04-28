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
 *      - safety-net (60 s + no alive-evidence) → re-inject for retry
 *      - retry cap (3) → move to `.failed/.exhausted/`
 *   3. handover — files older than 30 s in `.pending-ack/` are recovered by
 *                 the new lease holder's `replayUndeliveredMessages`
 *   4. escape  — 5+ pushes within 30 s with no alive evidence flips
 *                channelMarkedDead; future pushes skip the callback
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
test('A. notification resolves but harness silently drops; file re-injected after 60s safety net', { timeout: 80_000 }, async () => {
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

  // Doctor the pushedAt to be 61s in the past so the safety-net branch
  // fires on the next tick.
  const pending = watcher._getPendingDeliveriesForTesting();
  const entry = pending.find((p) => p.id === msg.id);
  assert.ok(entry, 'pending entry should exist for the staged file');
  entry.pushedAt = Date.now() - 61_000;

  // Drive a tick. With no alive evidence + age >= 60s, the entry must be
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

// ── Case C: notification succeeds + no activity for 60s → re-injected ───────
test('C. safety-net reinject: no alive evidence after 60s → file goes back to inbox', { timeout: 30_000 }, async () => {
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

  // Doctor pushedAt to 61s ago.
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.ok(entry);
  entry.pushedAt = Date.now() - 61_000;

  watcher._processPendingDeliveriesForTesting();

  // Re-injected back into inbox/.
  const inboxFiles = readdirSync(inboxDir);
  assert.ok(inboxFiles.includes(`${msg.id}.json`), 'file should be back in inbox');
  assert.equal(deliveredLedgerHas(msg.id), false, 'safety-net reinject must not mark delivered');

  watcher.stopWatcher();
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
});

// ── Case D: re-injection cap at 3 → moves to .failed/.exhausted/ ────────────
test('D. retry cap exhaustion: 4th reinject attempt moves file to .failed/.exhausted/', { timeout: 20_000 }, async () => {
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

  // Set the entry's retries to 3 (the cap) and pushedAt to 61s ago. The
  // next safety-net trigger should bump retries to 4 → exceed cap → exhaust.
  const entry = watcher._getPendingDeliveriesForTesting().find((p) => p.id === msg.id);
  assert.ok(entry);
  entry.retries = 3;
  entry.pushedAt = Date.now() - 61_000;

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
  // the previous lease holder had staged it. mtime defaults to now, so we
  // need to backdate it.
  mkdirSync(pendingAckDir, { recursive: true });
  const id = `msg-${randomUUID()}`;
  const msg = inbox.createMessage(
    'TestSender', 'TestMachine', 'message', 'case E — handover', null, 600, 'claude-code', 'claude-code',
  );
  msg.id = id;
  const stalePath = join(pendingAckDir, `${id}.json`);
  writeFileSync(stalePath, JSON.stringify(msg, null, 2), { mode: 0o600 });
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
  // re-injection the existing replay flow attempts to deliver it through the
  // channel callback, which in turn re-stages it into .pending-ack/ (3.9.0
  // hybrid AC). Either of these post-states proves handover replay worked:
  //   - file is back in inbox/<target>/   (still pre-push)
  //   - file is in .pending-ack/<target>/ (callback resolved, awaiting ack)
  await watcher.replayUndeliveredMessages();

  const stalePending = listAck();
  const inboxFiles = readdirSync(inboxDir);
  const archivedNow = archiveContains(id);
  const deliveredNow = deliveredLedgerHas(id);
  const handedOver =
    inboxFiles.includes(`${id}.json`)
    || stalePending.includes(`${id}.json`)
    || archivedNow
    || deliveredNow;
  assert.ok(
    handedOver,
    `expected handover-replay to recover ${id}.json into inbox/ / .pending-ack/ / .archive/ / .delivered; `
    + `inbox=${JSON.stringify(inboxFiles)}, pending-ack=${JSON.stringify(stalePending)}, `
    + `archived=${archivedNow}, delivered=${deliveredNow}`,
  );

  // Original stale path (the one we backdated) MUST be gone — that's the
  // load-bearing assertion: handover replay actually picked the file up,
  // not just its timestamp.
  assert.ok(!existsSync(stalePath), 'original handover file in pending-ack/ should be gone');

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
