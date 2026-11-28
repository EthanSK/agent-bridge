/**
 * 4.0.x — Observability tests for the new structured log events added
 * after the 2026-05-04 dead-channel sticky bug + dead-Dell mcp-server
 * silence debug session. The two pain points were:
 *
 *   1. The `server.heartbeat` event did not carry channel-dead state, so
 *      a stuck escape-hatch went 12+ h undetected. This test asserts the
 *      heartbeat now embeds `channel_dead`, `channel_dead_age_ms`,
 *      `pending_count`, etc.
 *
 *   2. There was no clean `channel.recovered` event on dead→healthy
 *      transition; reconstructing the recovery required cross-referencing
 *      `channel.dead_escape_hatch` + `channel.dead_escape_hatch_cleared`.
 *
 *   3. `replayUndeliveredMessages` had no structured drain summary, so
 *      "how many handover-pending re-injected, how many quarantined"
 *      required grepping individual log lines and counting.
 *
 *   4. The epitaph event was named `auto_update_runner.epitaph` (a
 *      misleading historical name) — there's now a clean
 *      `process.epitaph` semantic alias.
 *
 * Tests run in-process where possible (drain summary, channel recovery)
 * and via spawned MCP child for the heartbeat + epitaph paths because
 * those are wired to the real `setInterval` + `process.on('exit')`
 * lifecycles.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = readFileSync(logFile, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ── In-process test setup (drain summary, recovered event) ──────────────────
//
// HOME-sandbox setup must precede module imports. We share one sandbox
// across the in-process tests so module-load-time identity resolution
// runs once. (Mirrors `dead-channel-recovery.test.mjs`.)
const sandbox = mkdtempSync(join(tmpdir(), 'ab-observability-'));
mkdirSync(join(sandbox, '.agent-bridge'), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestMachine';
process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG = '1';
process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK = '1';
process.env.AGENT_BRIDGE_DISABLE_PATCH_F = '1';

const inbox = await import('../build/inbox.js');
const watcher = await import('../build/watcher.js');

const inboxDir = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', 'default');
const pendingAckDir = join(sandbox, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code', 'default');

inbox.ensureInboxDirs();
mkdirSync(inboxDir, { recursive: true });

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

function dropMessage(content) {
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

function listAck() {
  try { return readdirSync(pendingAckDir); } catch { return []; }
}

function cleanup() {
  for (const f of readdirSync(inboxDir)) try { rmSync(join(inboxDir, f)); } catch {}
  if (existsSync(pendingAckDir)) for (const f of readdirSync(pendingAckDir)) try { rmSync(join(pendingAckDir, f)); } catch {}
}

async function waitForStage(id) {
  for (let i = 0; i < 8; i += 1) {
    await sleep(750);
    if (listAck().includes(`${id}.json`)) return true;
  }
  return false;
}

// Truncate the unified log so each test starts from a clean slate. The
// log file is shared with module-load-time events from prior tests in
// the same process, so we anchor each test on the count of events seen
// before the test runs and slice events AFTER that count. (Anchoring on
// object reference doesn't work — `readEvents` re-parses each call so
// each event object is a fresh allocation.)
function snapshotEventCount(home) {
  return readEvents(home).length;
}

function eventsSince(home, count) {
  return readEvents(home).slice(count);
}

// ── Test 1: channel.recovered fires with the full dead→healthy delta ────────
test('channel.recovered fires with full delta on harness-ack recovery', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Anchor the log slice we care about (events older than this count
  // belong to setup / prior tests).
  const anchor = snapshotEventCount(sandbox);

  // Trip escape-hatch.
  for (let i = 0; i < 5; i += 1) {
    dropMessage(`recovered-evt-${i}`);
    await sleep(2_300);
  }
  watcher._processPendingDeliveriesForTesting();
  assert.ok(watcher._isChannelMarkedDeadForTesting(), 'sanity: dead-mark must trip');

  // Recovery.
  watcher.recordHarnessAck();
  assert.ok(!watcher._isChannelMarkedDeadForTesting(), 'sanity: dead-mark must clear');

  const after = eventsSince(sandbox, anchor);
  const recovered = after.filter((e) => e.event === 'channel.recovered');
  assert.equal(recovered.length, 1, `expected exactly 1 channel.recovered event, got ${recovered.length}`);

  const evt = recovered[0];
  assert.equal(evt.level, 'warn', 'channel.recovered should be warn-level');
  assert.ok(typeof evt.context.marked_dead_at_ms === 'number', 'marked_dead_at_ms is a number');
  assert.ok(typeof evt.context.recovered_at_ms === 'number', 'recovered_at_ms is a number');
  assert.ok(typeof evt.context.stuck_for_ms === 'number', 'stuck_for_ms is a number');
  assert.ok(evt.context.stuck_for_ms >= 0, 'stuck_for_ms is non-negative');
  assert.ok(typeof evt.context.messages_recovered === 'number', 'messages_recovered is a number');
  assert.ok(typeof evt.context.pending_count_after === 'number', 'pending_count_after is a number');
  assert.ok(typeof evt.context.target === 'string', 'target is set');

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 2: inbox.drain.summary fires with correct counts after replay ──────
test('inbox.drain.summary fires after replayUndeliveredMessages with correct counts', { timeout: 30_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 1,
    getChannelCallbackRegisteredAt: () => Date.now(),
    getToolCallsInFlight: () => 1,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  // Pre-seed the inbox with 3 valid undelivered messages PLUS 1 file
  // that will be quarantined (missing required content field).
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push(dropMessage(`drain-${i}`).id);
  }
  // Bad file → quarantine path.
  const badPath = join(inboxDir, 'malformed.json');
  writeFileSync(badPath, JSON.stringify({ id: 'bad', timestamp: new Date().toISOString() }), { mode: 0o600 });

  const anchor = snapshotEventCount(sandbox);

  await watcher.replayUndeliveredMessages();

  const after = eventsSince(sandbox, anchor);
  const summary = after.filter((e) => e.event === 'inbox.drain.summary');
  assert.equal(summary.length, 1, `expected exactly 1 inbox.drain.summary event, got ${summary.length}`);

  const ctx = summary[0].context;
  assert.ok(typeof ctx.duration_ms === 'number' && ctx.duration_ms >= 0, 'duration_ms is non-negative number');
  assert.equal(typeof ctx.handover_reinjected, 'number');
  assert.equal(typeof ctx.handover_skipped_fresh, 'number');
  assert.equal(typeof ctx.handover_failed, 'number');
  // 3 valid + 1 malformed seeded.
  assert.equal(ctx.inbox_scanned, 4, 'inbox_scanned counts every .json file');
  assert.equal(ctx.inbox_quarantined, 1, 'malformed file routes through quarantine path');
  assert.equal(ctx.inbox_emitted, 3, 'all 3 valid messages emit + stage');
  assert.equal(ctx.inbox_emit_failed, 0, 'no emit failures expected');
  assert.equal(ctx.inbox_stage_failed, 0, 'no stage failures expected');
  assert.ok(typeof ctx.target === 'string', 'target is set');

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 3: empty drain still emits a summary (zero-counts case) ────────────
test('inbox.drain.summary fires even when nothing is replayed', { timeout: 15_000 }, async () => {
  watcher._resetPendingDeliveriesForTesting();
  cleanup();

  watcher.registerAliveSignals({
    getToolCallsReceivedCount: () => 0,
    getChannelCallbackRegisteredAt: () => 0,
    getToolCallsInFlight: () => 0,
  });

  const startedOk = await watcher.startWatcher(() => {}, async () => {}, { role: 'channel-owner' });
  assert.ok(startedOk);

  const anchor = snapshotEventCount(sandbox);

  await watcher.replayUndeliveredMessages();

  const after = eventsSince(sandbox, anchor);
  const summary = after.filter((e) => e.event === 'inbox.drain.summary');
  assert.equal(summary.length, 1, 'drain summary fires on the no-files path too');
  const ctx = summary[0].context;
  assert.equal(ctx.inbox_scanned, 0);
  assert.equal(ctx.inbox_emitted, 0);
  assert.equal(ctx.handover_reinjected, 0);

  watcher.stopWatcher();
  cleanup();
  watcher._resetPendingDeliveriesForTesting();
});

// ── Test 4 (subprocess): server.heartbeat carries channel-state fields ─────
//
// Heartbeat fires every 60s in production — too long for CI. We assert
// build-time wiring instead, but Codex P2 (round 1) flagged that a
// loose substring search can pass even when `channel_dead` only appears
// in some OTHER context (e.g. epitaph) while the heartbeat block
// silently drops it. Slice the source to just the `server.heartbeat`
// emit block (event-name → closing brace of context literal) and assert
// the fields are present THERE specifically.
test('server.heartbeat block includes channel_dead + channel_dead_age_ms + pending_count', async () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  const eventMarker = "event: 'server.heartbeat'";
  const eventIdx = indexSrc.indexOf(eventMarker);
  assert.ok(eventIdx >= 0, "could not locate server.heartbeat event in build/index.js");

  // Slice from event marker to ~1500 chars beyond — enough to cover the
  // whole logEvent({...}) call without picking up unrelated blocks.
  const heartbeatBlock = indexSrc.slice(eventIdx, eventIdx + 1500);

  for (const field of ['channel_dead', 'channel_dead_age_ms', 'pending_count', 'pending_escape_hatch_count']) {
    assert.ok(
      heartbeatBlock.includes(field),
      `server.heartbeat block must reference ${field} (block did not contain it)`,
    );
  }
  // The snapshot helper itself must be wired into the heartbeat path.
  assert.ok(
    heartbeatBlock.includes('getChannelHealthSnapshot') || indexSrc.includes('getChannelHealthSnapshot'),
    "heartbeat path must call getChannelHealthSnapshot()",
  );
});

// ── Test 5 (subprocess): process.epitaph fires on clean SIGTERM exit ───────
test('process.epitaph event fires on clean SIGTERM shutdown', { timeout: 20_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows child.kill() signal delivery can bypass Node shutdown handlers');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'ab-epitaph-'));
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-epitaph',
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_DISABLE_ORPHAN_SUICIDE: '1',
      AGENT_BRIDGE_PERSONA: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdout.resume();
  try {
    // Wait for signal handlers before signalling. The server.starting event is logged earlier.
    const deadline = Date.now() + 8_000;
    let started = false;
    while (Date.now() < deadline) {
      const events = readEvents(home);
      if (events.some((e) => e.event === 'server.signal_handlers_ready')) { started = true; break; }
      await sleep(100);
    }
    assert.ok(started, 'server signal handlers should be ready before SIGTERM');

    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));

    const events = readEvents(home);
    const epitaphs = events.filter((e) => e.event === 'process.epitaph');
    assert.equal(epitaphs.length, 1, `expected exactly 1 process.epitaph event, got ${epitaphs.length}`);

    const ctx = epitaphs[0].context;
    assert.equal(ctx.pid, child.pid, 'epitaph carries the child pid');
    assert.equal(typeof ctx.kill_reason, 'string', 'kill_reason recorded');
    assert.equal(typeof ctx.uptime_s, 'number', 'uptime_s recorded');
    assert.equal(typeof ctx.lease_state, 'string', 'lease_state recorded');
    // Channel-health fields embedded at death.
    assert.equal(typeof ctx.channel_dead_at_death, 'boolean', 'channel_dead_at_death recorded');
    assert.equal(typeof ctx.pending_count_at_death, 'number', 'pending_count_at_death recorded');

    // Back-compat: the historical event name is still emitted.
    const legacy = events.filter((e) => e.event === 'auto_update_runner.epitaph');
    assert.equal(legacy.length, 1, 'auto_update_runner.epitaph still emitted for back-compat');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
});
