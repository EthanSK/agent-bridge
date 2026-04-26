/**
 * 3.5.5 — 3-poll orphan-watchdog confirmation tests.
 *
 * Telegram-pattern lifecycle polish (Patch A mirror, server.ts:711-737):
 *   - A SINGLE failed kill(parentPid, 0) ESRCH must NOT trigger shutdown.
 *   - 3 CONSECUTIVE failed polls (≈15s at 5s polling) MUST trigger shutdown.
 *   - Reset counter on any clean poll.
 *
 * We can't reach into the running interval to inject ESRCHs, so this test
 * suite combines:
 *   1. A live-process source-level guard (the constants and event names must
 *      exist in the shipped build).
 *   2. A live-process behavioural test that verifies a freshly-orphaned stdin
 *      (which trips stdin.readableEnded / stdin.destroyed in the SAME watchdog)
 *      requires more than one poll to terminate the child, and produces the
 *      orphan_poll log entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      AGENT_BRIDGE_MACHINE_NAME: 'test-3-5-5',
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_ROLE: 'tools-only',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdout.resume();
  return child;
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

test('3-poll watchdog wiring is present in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('ORPHAN_CONFIRMATION_POLLS'),
    'ORPHAN_CONFIRMATION_POLLS constant must exist',
  );
  assert.ok(
    /ORPHAN_CONFIRMATION_POLLS\s*=\s*3/.test(indexSrc),
    'orphan confirmation polls must be set to 3 (Patch A)',
  );
  assert.ok(
    indexSrc.includes("event: 'parent.orphan_poll'"),
    'parent.orphan_poll log event must be wired',
  );
  assert.ok(
    indexSrc.includes("event: 'parent.orphan_recovered'"),
    'parent.orphan_recovered reset event must be wired',
  );
  assert.ok(
    indexSrc.includes('orphan-watchdog:'),
    'shutdown reason should carry the orphan-watchdog: prefix',
  );
});

test('3.6.1: source-level — stdin.readableEnded is NOT in the orphan decision', async () => {
  // 3.6.1 regression: Claude Code's MCP plugin host writes the JSON-RPC
  // handshake to the child's stdin then leaves the pipe idle. On Node, the
  // MCP SDK's StdioServerTransport consumes those bytes and Node flips
  // `process.stdin.readableEnded` to true even though the pipe is still
  // open. Treating that as an orphan signal killed the server within 15 s
  // of every spawn. The fix: drop `stdin.readableEnded` from the orphan
  // decision in the watchdog. Source-level assertion that the orphan flag
  // composition is `parentDead || stdinDestroyed || stdinHadError` — NO
  // `stdinEnded` term.
  const indexSrc = await readFile(indexPath, 'utf8');
  // The orphan decision line — must NOT include stdinEnded as a disjunct.
  const orphanLineMatch = indexSrc.match(/const\s+orphaned\s*=\s*[^;]+;/);
  assert.ok(orphanLineMatch, 'expected an `orphaned = ...` decision line in the watchdog');
  const orphanLine = orphanLineMatch[0];
  assert.ok(
    !/\bstdinEnded\b/.test(orphanLine),
    `3.6.1 fix regressed: orphan decision still references stdinEnded — got: ${orphanLine}`,
  );
  assert.ok(/parentDead/.test(orphanLine), 'parentDead must remain in orphan decision');
  assert.ok(/stdinDestroyed/.test(orphanLine), 'stdinDestroyed must remain in orphan decision');
  assert.ok(/stdinHadError/.test(orphanLine), 'stdinHadError must remain in orphan decision');
  // Diagnostic field still logged for forensics.
  assert.ok(
    /stdin_ended:\s*process\.stdin\.readableEnded/.test(indexSrc),
    'stdin_ended should still be logged as a diagnostic-only field in orphan_poll context',
  );
});

test('3.6.1: idle stdin (handshake delivered, pipe held open) does not trigger shutdown', { timeout: 25_000 }, async () => {
  // Behavioural confirmation. Reproduces the production scenario: parent
  // writes a single JSON-RPC handshake message to stdin, then holds the
  // pipe open and idle for 20 s. The orphan watchdog must NOT shut the
  // server down. This catches the bug where the watchdog tripped on
  // `readableEnded === true` during normal idle operation.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-6-1-idle-'));
  const server = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
    AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
  });
  try {
    await sleep(800);
    // Simulate the MCP initialize handshake. Importantly we do NOT call
    // server.stdin.end() — the pipe stays open, just like Claude Code does.
    const handshake = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' },
      },
    }) + '\n';
    server.stdin.write(handshake);

    // Wait 20 s — well past the old 15 s confirmation window. Server must
    // still be alive and the watchdog must not have flagged an orphan.
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(20_000).then(() => null),
    ]);
    assert.equal(exited, null, `server must remain alive on idle stdin (3.6.1) — got ${JSON.stringify(exited)}`);

    const events = await readEvents(home);
    const polls = events.filter((e) => e.event === 'parent.orphan_poll');
    assert.equal(polls.length, 0, `no orphan polls expected on healthy idle parent, got: ${JSON.stringify(polls.map((p) => p.context))}`);
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('3.6.1: SIGTERM still triggers clean shutdown (orphan watchdog not regressing other paths)', { timeout: 10_000 }, async () => {
  // Sanity — make sure removing the stdin_ended check didn't break the rest
  // of the lifecycle. Explicit SIGTERM must still drive shutdown promptly.
  // 3.7.0: Patch G now ignores SIGTERM when parent is alive in channel-owner
  // mode; disable it here so the test can exercise the SIGTERM shutdown path.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-6-1-sigterm-'));
  const server = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
    AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
    AGENT_BRIDGE_DISABLE_PATCH_G: '1',
  });
  try {
    await sleep(800);
    server.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', () => resolve(true))),
      sleep(7_000).then(() => false),
    ]);
    assert.ok(exited, 'server must exit promptly on SIGTERM');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
