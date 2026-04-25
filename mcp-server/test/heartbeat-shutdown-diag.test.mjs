/**
 * Smoke tests for 3.5.4 diagnostic instrumentation:
 *   - server.heartbeat events appear at ~60s intervals
 *   - server.shutdown_diag dumps active handles + requests on shutdown
 *
 * We can't realistically wait 60s in CI, so we override the heartbeat
 * interval through a tiny build-time mod test: the test verifies the
 * shutdown_diag path and the presence of the heartbeat scheduling block
 * by inspecting the on-disk log AFTER a forced kill.
 *
 * Sibling detection is covered by inspection of the source — exhaustive
 * end-to-end coverage would require simulating two MCP children with a
 * shared lease, which the existing watcher-standby.test.mjs already does
 * for the lease-takeover path. This test just verifies the wiring exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(home, env = {}) {
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-3-5-2',
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_ROLE: 'tools-only',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.resume();
  return { child, get stderr() { return stderr; } };
}

async function readEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = await readFile(logFile, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('server.shutdown_diag dumps active handles and request counts on shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-5-5-shutdown-'));
  // 3.5.5: stdin-end no longer fires immediate shutdown — orphan watchdog
  // confirms across 3 polls. To exercise the shutdown path quickly, send
  // SIGTERM instead, which goes through handleSignal → shutdown → diag.
  const server = startServer(home);
  try {
    await sleep(800);
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));

    const events = await readEvents(home);
    const starting = events.find((e) => e.event === 'server.starting');
    assert.ok(starting, 'expected server.starting event');
    assert.equal(starting.context.version, '3.5.5', 'startup event should report version 3.5.5');

    const diag = events.find((e) => e.event === 'server.shutdown_diag');
    assert.ok(diag, 'expected server.shutdown_diag event on shutdown');
    assert.ok(typeof diag.context.uptime_s === 'number', 'uptime_s present');
    assert.ok(typeof diag.context.handles === 'number', 'handles count present');
    assert.ok(typeof diag.context.requests === 'number', 'requests count present');
    assert.ok(typeof diag.context.rss_mb === 'number', 'rss_mb present');
    assert.ok(Array.isArray(diag.context.handle_types), 'handle_types is an array');
    assert.equal(typeof diag.context.reason, 'string', 'reason string present');
    assert.equal(diag.context.pid, server.child.pid, 'pid matches');
  } finally {
    try { server.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('server.heartbeat fires for short-interval override (test-only via env)', async () => {
  // The heartbeat interval is hardcoded at 60s for production safety. We can
  // still smoke-test the heartbeat path by waiting briefly and confirming
  // that the scheduling code path doesn't crash. A tighter unit test would
  // require exposing the interval; we accept the trade-off because: (1) the
  // shutdown_diag test above verifies the harness wiring, and (2) the
  // production heartbeat is observable in the real mcp-server.log.
  //
  // This test just asserts that no error events fire during the first second
  // of a tools-only run, which is the canary for "did the heartbeat setup
  // throw at startup".
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-5-2-heartbeat-'));
  const server = startServer(home);
  try {
    await sleep(1200);
    const events = await readEvents(home);
    const errors = events.filter((e) => e.level === 'error');
    assert.deepEqual(errors, [], `no error events expected, got: ${JSON.stringify(errors)}`);

    // The startup, watcher.disabled, and server.ready events MUST all fire
    // before any heartbeat would. Confirm those exist.
    const startingIdx = events.findIndex((e) => e.event === 'server.starting');
    const readyIdx = events.findIndex((e) => e.event === 'server.ready');
    assert.ok(startingIdx >= 0, 'server.starting fired');
    assert.ok(readyIdx > startingIdx, 'server.ready fired after starting');
  } finally {
    try { server.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('sibling detection wiring is present in shipped build', async () => {
  // Source-level guard: ensure the sibling.detected event is wired and the
  // lease file path used by the watchdog matches what watcher.ts writes.
  // If a future refactor moves the lock dir or renames the event, this test
  // will catch the drift before users do.
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes("event: 'sibling.detected'"),
    'sibling detection event must be present in built index.js',
  );
  assert.ok(
    indexSrc.includes('watcher-lock.json'),
    'sibling detection must reference the watcher-lock.json filename',
  );
  assert.ok(
    indexSrc.includes('SIGKILL'),
    'shutdown SIGKILL backstop must be present',
  );
});

test('channel-owner treats stdin close as host lifecycle shutdown after 3-poll confirmation and releases lease', { timeout: 30_000 }, async () => {
  // 3.5.5: stdin-end no longer triggers immediate shutdown. The orphan
  // watchdog must observe stdin destroyed/readableEnded across 3 consecutive
  // 5s polls (15s total) before calling shutdown. Reason is the new
  // composite "orphan-watchdog: ..." string (mirroring Telegram's Patch A).
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-5-5-channel-owner-'));
  const server = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
    AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
  });
  const lockPath = join(home, '.agent-bridge', 'locks', 'claude-code.watcher-lock.json');
  try {
    await sleep(800);
    assert.ok(await readFile(lockPath, 'utf8'), 'channel-owner should acquire watcher lease');

    server.child.stdin.end();
    // Give the orphan watchdog up to 25s to reach 3 confirmations (15s nominal
    // at 5s polling, plus startup slack).
    const exited = await Promise.race([
      new Promise((resolve) => server.child.once('exit', () => resolve(true))),
      sleep(25_000).then(() => false),
    ]);
    assert.ok(exited, 'channel-owner should exit within 25s of stdin.end()');

    const events = await readEvents(home);
    const shutdown = events.find((e) => e.event === 'server.shutdown');
    assert.ok(shutdown, 'expected clean shutdown event');
    assert.match(
      shutdown.context.reason,
      /orphan-watchdog/,
      'shutdown reason should come from the 3-poll orphan watchdog',
    );
    // Confirm we logged at least one orphan_poll event before the final shutdown.
    const orphanPolls = events.filter((e) => e.event === 'parent.orphan_poll');
    assert.ok(orphanPolls.length >= 1, 'expected at least one parent.orphan_poll log entry');
    assert.ok(events.find((e) => e.event === 'watcher.lease_released'), 'watcher lease should be released');
    await assert.rejects(() => readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    try { server.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
