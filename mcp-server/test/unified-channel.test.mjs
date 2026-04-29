/**
 * 3.7.0 — Unified plugin (tools + channel) tests.
 *
 * Covers behaviour ported from the deleted claude-code-channel package:
 *   - Patch F (heartbeat-recency guard against parallel-spawn) — fresh peer
 *     lease causes the new starter to back off and exit cleanly.
 *   - Patch G (channel-owner SIGTERM ignore) — SIGTERM is absorbed when the
 *     parent is alive and the watcher is healthy.
 *   - Patch H (no-op `claude_code_channel_status` MCP tool) — registration
 *     surfaces the tool in `tools/list` and `tools/call` returns a status
 *     object.
 *   - Signal evidence logging — `signal.evidence` event written on every
 *     signal arrival.
 *   - End-to-end inbox delivery via the unified watcher — drop a JSON file in
 *     inbox/claude-code/, verify it gets picked up, the channel push event is
 *     emitted, the file is archived, and the .delivered ledger records it.
 *
 * The dedicated `claude-code-channel` plugin was removed in 3.7.0 because
 * Claude Code's plugin host gates idle reaping on MCP tool-call frequency,
 * not channel registration. A unified plugin with 7+ user-facing tools gets
 * called frequently enough to stay alive (same lifetime guarantees as the
 * Telegram plugin).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-unified',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      // Default to channel-owner role with parent-channel-capability check
      // disabled — unit tests are not Claude Code, so the parentLooksChannelCapable
      // check would otherwise demote us to tools-only.
      AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
      // Patch G ignores SIGTERM when parent is alive; tests that want to use
      // SIGTERM-driven shutdown set AGENT_BRIDGE_DISABLE_PATCH_G: '1'.
      AGENT_BRIDGE_DISABLE_PATCH_G: '1',
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
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// ─── Source-level guards for Patches F, G, H + signal.evidence ──────────────
test('source-level: Patches F, G, H wired into unified plugin', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  const configSrc = await readFile(join(__dirname, '..', 'build', 'config.js'), 'utf8');
  // Patch F — heartbeat-recency guard via lease updatedAt, plus 3.7.1's
  // standby+retry refactor and stale-version peer-kill paths.
  assert.ok(indexSrc.includes('patch_f.standby'), 'Patch F: 3.7.1 standby event wired');
  assert.ok(
    indexSrc.includes('patch_f.peer_version_kill'),
    'Patch F: 3.7.1 stale-version peer-kill event wired',
  );
  assert.ok(/AGENT_BRIDGE_DISABLE_PATCH_F/.test(indexSrc), 'Patch F: env opt-out present');
  // Patch G — channel-owner SIGTERM ignore
  assert.ok(indexSrc.includes('signal.ignored_channel_owner'), 'Patch G: ignored event wired');
  assert.ok(indexSrc.includes('AGENT_BRIDGE_DISABLE_PATCH_G'), 'Patch G: env opt-out present');
  assert.ok(/signal\s*===\s*['"]SIGTERM['"]/.test(indexSrc), 'Patch G: ignore is SIGTERM-only');
  // Patch H — no-op informational tool
  assert.ok(
    /server\.registerTool\(\s*['"]claude_code_channel_status['"]/.test(indexSrc),
    'Patch H: claude_code_channel_status tool registered via server.registerTool',
  );
  assert.ok(indexSrc.includes('signal.evidence'), 'signal.evidence event wired');
  assert.ok(indexSrc.includes('last_notification_at_ms'), 'last_notification_at_ms tracked');
  assert.ok(indexSrc.includes('tool_calls_received_count'), 'tool_calls_received_count tracked');
  // Version constant — 3.9.3, sourced from config.ts
  assert.ok(
    /MCP_SERVER_VERSION\s*=\s*['"]3\.9\.3['"]/.test(configSrc),
    'MCP_SERVER_VERSION must be 3.9.3 in config.ts',
  );
  assert.ok(
    indexSrc.includes('/claude\\.app\\/Contents\\/MacOS\\/claude'),
    'Claude Code desktop parent signature accepted as channel-capable',
  );
  assert.ok(
    indexSrc.includes('anthropic\\.claude-code-'),
    'Claude Code VS Code parent signature accepted as channel-capable',
  );
});

// ─── Patch F (3.7.1) — standby + retry on healthy peer lease, no exit ───────
test('Patch F (3.7.1): server stays in standby when a same-version healthy peer holds the lease', { timeout: 12_000 }, async () => {
  // Simulate a healthy SAME-VERSION peer by writing a fresh lease file held
  // by THIS test process (its pid is alive). Patch F's 3.7.1 form must NOT
  // exit — it should log patch_f.standby and stay alive, polling the lease.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-f-standby-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const fakeLease = {
    pid: process.pid,
    target: 'claude-code',
    role: 'channel-owner',
    token: `${process.pid}-fake-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    version: '3.9.3', // same version as our build → no kill
  };
  await writeFile(lockPath, JSON.stringify(fakeLease, null, 2));

  const child = startServer(home);
  try {
    // The plugin must NOT exit within 4 s — it should be sitting in standby.
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', (code) => resolve({ code }))),
      sleep(4_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `Patch F 3.7.1 must NOT exit when same-version peer holds the lease; got ${JSON.stringify(exited)}`,
    );

    const events = await readEvents(home);
    const standby = events.find((e) => e.event === 'patch_f.standby');
    assert.ok(standby, 'expected patch_f.standby event when an alive same-version peer holds the lease');
    // Should NOT have logged the legacy backoff_exit event.
    const backoffExit = events.find((e) => e.event === 'patch_f.backoff_exit');
    assert.equal(backoffExit, undefined, '3.7.1 must not emit the legacy patch_f.backoff_exit event');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('Patch F (3.7.1): standby plugin acquires lease once peer heartbeat goes stale', { timeout: 30_000 }, async () => {
  // Write a stale lease file held by a definitely-dead pid. The standby
  // retry path inside watcher.ts should pick this up via tryAcquireWatcherLease
  // (lease is stale because the holder pid is ESRCH) and steal it. We use a
  // pid that does not exist — pid 1 is always alive but signalling it from
  // a non-root user gets EPERM (treated as alive). Use a guaranteed-dead pid
  // by spawning + killing a short-lived helper to mint a recently-recycled
  // pid number.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-f-promote-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  // Mint a definitely-dead pid.
  const helper = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => helper.once('exit', resolve));
  const deadPid = helper.pid;

  // Write a fresh-LOOKING lease (updatedAt now) held by a dead pid. Patch F
  // probes liveness with kill(pid, 0) and ESRCH on the dead pid means it
  // falls through directly without standby/kill. startWatcher then steals
  // the lease via the stale-lease branch. We assert the steal happens.
  const fakeLease = {
    pid: deadPid,
    target: 'claude-code',
    role: 'channel-owner',
    token: `${deadPid}-dead-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    version: '3.9.3',
  };
  await writeFile(lockPath, JSON.stringify(fakeLease, null, 2));

  const child = startServer(home, { AGENT_BRIDGE_ROLE: 'channel-owner' });
  try {
    // Wait up to ~10 s for the plugin to acquire the lease (either directly
    // through Patch F fall-through or via the standby retry path).
    let acquired = false;
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      try {
        const raw = await readFile(lockPath, 'utf8');
        const lease = JSON.parse(raw);
        if (lease.pid === child.pid) {
          acquired = true;
          break;
        }
      } catch {
        /* lease may be momentarily missing during steal */
      }
    }
    assert.ok(acquired, `expected child pid=${child.pid} to take over the stale lease within 10 s`);
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000),
    ]);
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ─── Patch F (3.7.1) — stale-version peer-kill ──────────────────────────────
test('Patch F (3.7.1): SIGTERMs and replaces a peer with an older version', { timeout: 20_000 }, async () => {
  // Mint a long-lived helper process that will simulate the older-version peer.
  // It traps SIGTERM and exits cleanly within ~200 ms (well under the 2 s
  // grace window). Patch F should detect the stale version, SIGTERM it,
  // wait for the exit, and then steal the lease.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-f-version-kill-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  const peer = spawn(process.execPath, [
    '-e',
    `process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 200); });
     setInterval(() => {}, 1000);`,
  ], { stdio: 'ignore' });
  // Give the peer a moment to attach its SIGTERM handler before we write the
  // lease file pointing at it.
  await sleep(200);

  try {
    const peerLease = {
      pid: peer.pid,
      target: 'claude-code',
      role: 'channel-owner',
      token: `${peer.pid}-old-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      version: '3.6.0', // strictly older than our 3.7.1 build
    };
    await writeFile(lockPath, JSON.stringify(peerLease, null, 2));

    const child = startServer(home, { AGENT_BRIDGE_ROLE: 'channel-owner' });
    try {
      // Wait for the peer to die (SIGTERMed by Patch F).
      const peerExited = await Promise.race([
        new Promise((resolve) => peer.once('exit', resolve)),
        sleep(8_000).then(() => null),
      ]);
      assert.ok(peerExited !== null, 'older-version peer must be killed by Patch F');

      // Wait for the new plugin to acquire the lease.
      let acquired = false;
      for (let i = 0; i < 20; i += 1) {
        await sleep(500);
        try {
          const raw = await readFile(lockPath, 'utf8');
          const lease = JSON.parse(raw);
          if (lease.pid === child.pid) {
            acquired = true;
            break;
          }
        } catch {
          /* lease in flux */
        }
      }
      assert.ok(acquired, `expected child pid=${child.pid} to take over the lease after killing the old-version peer`);

      const events = await readEvents(home);
      const killEvent = events.find((e) => e.event === 'patch_f.peer_version_kill');
      assert.ok(killEvent, 'expected patch_f.peer_version_kill event for stale-version peer');
      assert.equal(killEvent.context.peer_version, '3.6.0', 'peer_version logged');
      assert.equal(killEvent.context.our_version, '3.9.3', 'our_version logged');
      assert.equal(killEvent.context.peer_pid, peer.pid, 'peer_pid logged');
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000),
      ]);
      try { child.kill('SIGKILL'); } catch {}
    }
  } finally {
    try { peer.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ─── Patch G — SIGTERM ignored when parent alive + watcher healthy ──────────
test('Patch G: SIGTERM is ignored when parent is alive and channel-owner watcher is healthy', { timeout: 12_000 }, async () => {
  // The test runner IS the plugin's parent and is alive while we run, so
  // the Patch G ignore branch should fire. Re-enable Patch G for this test.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-g-'));
  const child = startServer(home, {
    AGENT_BRIDGE_DISABLE_PATCH_G: '0',
    AGENT_BRIDGE_ROLE: 'channel-owner',
  });
  try {
    await sleep(1500);
    // Send SIGTERM — Patch G must absorb it. Plugin must keep running.
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(3_500).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `plugin must NOT exit on SIGTERM with healthy parent (Patch G) — got ${JSON.stringify(exited)}`,
    );

    const events = await readEvents(home);
    const ignored = events.find((e) => e.event === 'signal.ignored_channel_owner');
    assert.ok(ignored, 'expected signal.ignored_channel_owner event when SIGTERM is absorbed by Patch G');
    assert.equal(ignored.context.parentPid, process.pid, 'parentPid in ignore event should match the test runner pid');

    // Now confirm SIGINT still shuts down (Patch G is SIGTERM-only).
    child.kill('SIGINT');
    await new Promise((resolve) => child.once('exit', resolve));
    const post = await readEvents(home);
    const shutdown = post.find((e) => e.event === 'server.shutdown' && /SIGINT/.test(e.context?.reason ?? ''));
    assert.ok(shutdown, 'SIGINT must still trigger server.shutdown (Patch G ignores SIGTERM only)');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ─── Patch H — claude_code_channel_status tool registered + callable ────────
test('Patch H: tools/list reports claude_code_channel_status; tools/call returns expected shape', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-h-'));
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-patch-h',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_DISABLE_PATCH_G: '1',
      AGENT_BRIDGE_ROLE: 'tools-only', // we don't need the watcher here
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();

  // JSON-RPC framing: read newline-delimited JSON from stdout.
  let buffer = '';
  const responses = new Map(); // id → response
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id !== 'undefined') {
          responses.set(parsed.id, parsed);
        }
      } catch {
        // ignore non-JSON or partial frames
      }
    }
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (responses.has(id)) return responses.get(id);
      await sleep(50);
    }
    throw new Error(`timeout waiting for response id=${id}`);
  }

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tool-registration-test', version: '1.0' },
      },
    });
    const initResp = await waitForResponse(1);
    assert.equal(initResp.jsonrpc, '2.0', 'init response is JSON-RPC 2.0');
    assert.ok(initResp.result, `init must return a result, got: ${JSON.stringify(initResp)}`);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(200);

    // tools/list must include both bridge_* tools AND claude_code_channel_status.
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listResp = await waitForResponse(2);
    assert.ok(listResp.result, `tools/list must return a result, got: ${JSON.stringify(listResp)}`);
    const tools = listResp.result.tools ?? [];
    const toolNames = tools.map((t) => t.name);
    assert.ok(
      toolNames.includes('claude_code_channel_status'),
      `tools/list must include claude_code_channel_status; got: ${JSON.stringify(toolNames)}`,
    );
    assert.ok(
      toolNames.includes('bridge_send_message'),
      `tools/list must include bridge_send_message; got: ${JSON.stringify(toolNames)}`,
    );
    assert.ok(
      toolNames.includes('bridge_inbox_stats'),
      `tools/list must include bridge_inbox_stats; got: ${JSON.stringify(toolNames)}`,
    );

    // tools/call claude_code_channel_status
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'claude_code_channel_status', arguments: {} },
    });
    const callResp = await waitForResponse(3);
    assert.ok(callResp.result, `tools/call must return a result, got: ${JSON.stringify(callResp)}`);
    const content = callResp.result.content ?? [];
    assert.ok(content.length > 0, 'tool result must have content');
    const text = content[0]?.text;
    assert.ok(typeof text === 'string', 'tool result content[0].text must be a string');
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed.pid, 'number', 'status.pid is a number');
    assert.equal(parsed.pid, child.pid, 'status.pid matches the plugin child pid');
    assert.equal(typeof parsed.uptime_s, 'number', 'status.uptime_s is a number');
    assert.equal(parsed.version, '3.9.3', 'status.version is 3.9.3');
    assert.equal(typeof parsed.machine, 'string', 'status.machine is a string');
    assert.equal(parsed.machine, 'test-patch-h', 'status.machine reflects env override');
    assert.equal(typeof parsed.watcher_active, 'boolean', 'status.watcher_active is boolean');
    assert.ok(
      parsed.tool_calls_received_count >= 1,
      `tool_calls_received_count must be >= 1 after one call, got ${parsed.tool_calls_received_count}`,
    );
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ─── End-to-end inbox delivery via unified plugin ──────────────────────────
test('unified plugin: watcher detects new inbox file, pushes channel notification, stages pending-ack (3.9.0)', { timeout: 25_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-unified-delivery-'));
  const inboxDir = join(home, '.agent-bridge', 'inbox', 'claude-code');
  const pendingAckDir = join(home, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code');

  const child = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
  });
  try {
    // Wait for plugin startup.
    await sleep(1500);

    // Drop a fully-formed BridgeMessage into the inbox.
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const msgId = `msg-${randomUUID()}`;
    const msg = {
      id: msgId,
      from: 'TestSender',
      to: 'test-unified',
      type: 'message',
      content: 'hello from the unified-delivery test',
      timestamp: new Date().toISOString(),
      replyTo: null,
      ttl: 600,
      target: 'claude-code',
      fromTarget: 'claude-code',
    };
    const msgPath = join(inboxDir, `${msgId}.json`);
    await writeFile(msgPath, JSON.stringify(msg, null, 2), { mode: 0o600 });

    // 3.9.0 [CONSUME-RACE] — under the hybrid AC delivery model, the file
    // moves from inbox/<target>/ → .pending-ack/<target>/ once the channel
    // callback resolves. Without any alive evidence (no tool calls in this
    // test process, no long-poll listeners), it sits there until the 60 s
    // safety net OR a positive ack arrives. Within the 12 s window we
    // assert: file left the inbox, file landed in pending-ack/, and the
    // sidecar meta json was written. Finalization (archive + .delivered)
    // is the alive-evidence path and is covered by consume-race tests.
    let staged = false;
    for (let i = 0; i < 12; i += 1) {
      await sleep(1000);
      try {
        const ackEntries = await readdir(pendingAckDir);
        if (ackEntries.includes(`${msgId}.json`)) {
          staged = true;
          break;
        }
      } catch {
        /* pending-ack dir may not exist yet */
      }
    }
    assert.ok(staged, `expected inbox file to be staged into ${pendingAckDir} within 12 s`);

    // Sidecar metadata should accompany the staged file.
    const ackEntries = await readdir(pendingAckDir);
    assert.ok(
      ackEntries.includes(`${msgId}.meta.json`),
      'expected sidecar meta json alongside the pending-ack file',
    );

    // Inbox should no longer have the file (it was renamed into pending-ack/).
    const inboxRemaining = await readdir(inboxDir);
    assert.ok(
      !inboxRemaining.includes(`${msgId}.json`),
      'inbox should no longer contain the staged file',
    );

    // Unified log should show message.received, pushed_to_channel, and
    // the new 3.9.0 channel.pending_staged event.
    const events = await readEvents(home);
    const received = events.find((e) => e.event === 'message.received' && e.context?.msg_id === msgId);
    assert.ok(received, 'expected message.received event for delivered msg');
    const pushed = events.find((e) => e.event === 'message.pushed_to_channel' && e.context?.msg_id === msgId);
    assert.ok(pushed, 'expected message.pushed_to_channel event for delivered msg');
    const pending = events.find((e) => e.event === 'channel.pending_staged' && e.context?.msg_id === msgId);
    assert.ok(pending, 'expected channel.pending_staged event for delivered msg (3.9.0)');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000),
      ]);
    } catch {}
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
