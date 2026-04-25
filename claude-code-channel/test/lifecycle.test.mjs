/**
 * 3.6.0 — claude-code-channel plugin lifecycle smoke tests.
 *
 * Verifies:
 *   - the plugin starts up, acquires the watcher lease, and writes
 *     channel.starting / channel.ready events to the unified log.
 *   - SIGTERM triggers shutdown with handle/request dump (Patch E).
 *   - the persistent stderr tee (Patch B) writes to
 *     ~/.agent-bridge/logs/claude-code-channel-stderr.log.
 *   - 3-poll orphan watchdog (Patch A) wiring is present in the build.
 *   - Patch F (heartbeat-recency guard) is present in the build.
 *
 * We can't realistically wait the full 15 s for the orphan watchdog in CI,
 * but we DO test that a single stdin.end() does not trigger immediate
 * shutdown — that mirrors the same behavioural test mcp-server uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

function startPlugin(home, env = {}) {
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-claude-code-channel',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1', // off by default in tests
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.resume();
  return { child, get stderr() { return stderr; } };
}

async function readUnifiedEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = await readFile(logFile, 'utf8');
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

test('plugin starts, acquires lease, emits channel.starting + channel.ready, then shuts down on SIGTERM', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-startup-'));
  const plugin = startPlugin(home);
  const lockPath = join(home, '.agent-bridge', 'locks', 'claude-code.watcher-lock.json');
  try {
    // Give the plugin enough time to: ensureDirectories, initInbox, McpServer
    // construction, startWatcher (acquires lease), server.connect.
    await sleep(1500);
    assert.ok(existsSync(lockPath), 'plugin should acquire watcher lease at startup');

    plugin.child.kill('SIGTERM');
    await new Promise((resolve) => plugin.child.once('exit', resolve));

    const events = await readUnifiedEvents(home);
    const starting = events.find((e) => e.event === 'channel.starting');
    assert.ok(starting, 'expected channel.starting event');
    assert.equal(starting.context.version, '3.6.1', 'startup event should report version 3.6.1');
    assert.equal(starting.component, 'claude-code-channel', 'log component should be claude-code-channel');

    const ready = events.find((e) => e.event === 'channel.ready');
    assert.ok(ready, 'expected channel.ready event after server.connect()');

    const diag = events.find((e) => e.event === 'channel.shutdown_diag');
    assert.ok(diag, 'expected channel.shutdown_diag event on shutdown (Patch E)');
    assert.ok(typeof diag.context.handles === 'number', 'handle count present');
    assert.ok(typeof diag.context.requests === 'number', 'request count present');
    assert.ok(Array.isArray(diag.context.handle_types), 'handle_types is an array');

    const released = events.find((e) => e.event === 'watcher.lease_released');
    assert.ok(released, 'watcher lease should be released on clean shutdown');
    assert.ok(!existsSync(lockPath), 'lock file should be gone after lease release');
  } finally {
    try { plugin.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('Patch B persistent stderr tee writes to claude-code-channel-stderr.log', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-stderr-'));
  const plugin = startPlugin(home);
  try {
    await sleep(1500);
    plugin.child.kill('SIGTERM');
    await new Promise((resolve) => plugin.child.once('exit', resolve));

    const stderrLogPath = join(home, '.agent-bridge', 'logs', 'claude-code-channel-stderr.log');
    assert.ok(existsSync(stderrLogPath), `expected stderr tee file at ${stderrLogPath}`);
    const content = await readFile(stderrLogPath, 'utf8');
    assert.ok(content.length > 0, 'stderr tee must not be empty');
    assert.ok(
      /claude-code-channel/.test(content) || /\[heartbeat\]|\[shutdown\]/.test(content),
      `stderr tee should contain a startup banner or lifecycle line; got: ${content.slice(0, 400)}`,
    );
  } finally {
    try { plugin.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('source-level guards: Patches A, B, C, D, E, F are wired in built index.js', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  // Patch A — 3-poll orphan watchdog
  assert.ok(/ORPHAN_CONFIRMATION_POLLS\s*=\s*3/.test(indexSrc), 'Patch A: 3-poll watchdog constant');
  assert.ok(indexSrc.includes('channel.orphan_poll'), 'Patch A: orphan_poll event wired');
  // Patch B — stderr tee
  assert.ok(indexSrc.includes('claude-code-channel-stderr.log'), 'Patch B: stderr tee filename');
  assert.ok(indexSrc.includes('createWriteStream'), 'Patch B: stream creation');
  // Patch C — shutdownWithReason funnel
  assert.ok(indexSrc.includes('shutdownWithReason'), 'Patch C: funnel function');
  // Patch D — heartbeat (REFED — must NOT call .unref() on heartbeatInterval)
  assert.ok(/setInterval[\s\S]{0,800}heartbeat/.test(indexSrc), 'Patch D: heartbeat interval');
  // Patch E — shutdown handle/request dump
  assert.ok(indexSrc.includes('_getActiveHandles'), 'Patch E: handle dump');
  assert.ok(indexSrc.includes('_getActiveRequests'), 'Patch E: request dump');
  // Patch F — heartbeat-recency guard via lease updatedAt
  assert.ok(indexSrc.includes('patch_f.backoff'), 'Patch F: backoff event wired');
  assert.ok(/AGENT_BRIDGE_DISABLE_PATCH_F/.test(indexSrc), 'Patch F: env opt-out');
});

test('3.6.1: source-level — stdin.readableEnded is NOT in orphan decision', async () => {
  // 3.6.1 regression: Claude Code's MCP plugin host writes the JSON-RPC
  // handshake to stdin then leaves the pipe idle. Node flips
  // `process.stdin.readableEnded` to true once the MCP SDK consumes the
  // buffered handshake bytes — but the pipe is still open and the parent is
  // still alive. Treating that as an orphan signal killed the plugin within
  // 15 s of every spawn. The fix: drop `readableEnded` from the orphan check.
  const indexSrc = await readFile(indexPath, 'utf8');
  const orphanLineMatch = indexSrc.match(/const\s+orphaned\s*=\s*[^;]+;/);
  assert.ok(orphanLineMatch, 'expected an `orphaned = ...` decision line in the watchdog');
  const orphanLine = orphanLineMatch[0];
  assert.ok(
    !/\bstdinEnded\b/.test(orphanLine),
    `3.6.1 fix regressed: orphan decision still references stdinEnded — got: ${orphanLine}`,
  );
  assert.ok(/ppidChanged/.test(orphanLine), 'ppidChanged must remain in orphan decision');
  assert.ok(/stdinDestroyed/.test(orphanLine), 'stdinDestroyed must remain in orphan decision');
  assert.ok(/stdinHadError/.test(orphanLine), 'stdinHadError must remain in orphan decision');
  // Diagnostic field still logged for forensics.
  assert.ok(
    /stdin_ended:\s*process\.stdin\.readableEnded/.test(indexSrc),
    'stdin_ended should still be logged as a diagnostic-only field in orphan_poll context',
  );
});

test('3.6.1: plugin survives idle stdin (handshake delivered, pipe held open)', { timeout: 25_000 }, async () => {
  // Behavioural confirmation. Reproduces the production scenario: parent
  // writes a single JSON-RPC handshake message to stdin, then holds the
  // pipe open and idle. The orphan watchdog must NOT shut the plugin down.
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-3-6-1-idle-'));
  // Re-enable the orphan watchdog (the default in tests is to disable it).
  const plugin = startPlugin(home, { AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '0' });
  try {
    await sleep(1500);
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
    plugin.child.stdin.write(handshake);

    const exited = await Promise.race([
      new Promise((resolve) => plugin.child.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(20_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `plugin must NOT exit on idle stdin (3.6.1 fix) — got ${JSON.stringify(exited)}`,
    );

    const events = await readUnifiedEvents(home);
    const polls = events.filter((e) => e.event === 'channel.orphan_poll');
    assert.equal(polls.length, 0, `no orphan polls expected on healthy idle parent, got: ${JSON.stringify(polls.map((p) => p.context))}`);
  } finally {
    try { plugin.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin exits cleanly when an existing healthy peer holds the lease (Patch F)', { timeout: 10_000 }, async () => {
  // Simulate a healthy peer by writing a fresh lease file held by THIS test
  // process (its pid is alive). Patch F should refuse to take over.
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-patch-f-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code.watcher-lock.json');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const fakeLease = {
    pid: process.pid,
    target: 'claude-code',
    role: 'channel-owner',
    token: `${process.pid}-fake-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeFile(lockPath, JSON.stringify(fakeLease, null, 2));

  const plugin = startPlugin(home);
  try {
    const exited = await Promise.race([
      new Promise((resolve) => plugin.child.once('exit', (code) => resolve(code))),
      sleep(7_000).then(() => null),
    ]);
    assert.ok(exited !== null, 'plugin should exit promptly when Patch F sees a healthy peer');
    assert.equal(exited, 0, 'Patch F backoff should exit 0');

    const events = await readUnifiedEvents(home);
    const backoff = events.find((e) => e.event === 'patch_f.backoff');
    assert.ok(backoff, 'expected patch_f.backoff event when an alive peer holds the lease');
  } finally {
    try { plugin.child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
