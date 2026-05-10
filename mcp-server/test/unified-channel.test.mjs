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
      // 4.0.0 — `AGENT_BRIDGE_ROLE` + `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`
      // were removed. Channel-owner mode is keyed off
      // `AGENT_BRIDGE_PERSONA`. Unit tests are not Claude Code so the
      // cmdline-fallback would otherwise demote us to tools-only;
      // setting `AGENT_BRIDGE_PERSONA=default` puts us into channel-owner
      // mode regardless of parent.
      AGENT_BRIDGE_PERSONA: 'default',
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
  // Version constant — 4.0.0, sourced from config.ts
  assert.ok(
    /MCP_SERVER_VERSION\s*=\s*['"]4\.4\.0['"]/.test(configSrc),
    'MCP_SERVER_VERSION must be 4.4.0 in config.ts',
  );
  // 4.0.0 — `parentLooksChannelCapable` lives in persona.js. Assert the
  // built persona module carries the Claude Code parent signatures.
  const personaSrc = await readFile(join(__dirname, '..', 'build', 'persona.js'), 'utf8');
  assert.ok(
    personaSrc.includes('/claude\\.app\\/Contents\\/MacOS\\/claude'),
    'Claude Code desktop parent signature accepted as channel-capable',
  );
  assert.ok(
    personaSrc.includes('anthropic\\.claude-code-'),
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
  const lockPath = join(lockDir, 'claude-code__default.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const fakeLease = {
    pid: process.pid,
    target: 'claude-code/default',
    role: 'channel-owner',
    token: `${process.pid}-fake-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    version: '4.4.0', // same version as our build → no kill
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
  const lockPath = join(lockDir, 'claude-code__default.watcher-lock.json');
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
    target: 'claude-code/default',
    role: 'channel-owner',
    token: `${deadPid}-dead-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    version: '3.14.3',
  };
  await writeFile(lockPath, JSON.stringify(fakeLease, null, 2));

  const child = startServer(home, { /* startServer defaults to AGENT_BRIDGE_PERSONA=default */ });
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
  const lockPath = join(lockDir, 'claude-code__default.watcher-lock.json');
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
      target: 'claude-code/default',
      role: 'channel-owner',
      token: `${peer.pid}-old-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      version: '3.6.0', // strictly older than our 3.7.1 build
    };
    await writeFile(lockPath, JSON.stringify(peerLease, null, 2));

    const child = startServer(home, { /* startServer defaults to AGENT_BRIDGE_PERSONA=default */ });
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
      assert.equal(killEvent.context.our_version, '4.4.0', 'our_version logged');
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

// ─── 4.0.0 replacement for the 3.14.8 gate ─────────────────────────────────
// In 4.0.0 the inline 3.14.8 gate was removed. Its job (preventing
// openclaw-gateway-spawned MCP children from killing the user's main CC
// channel-owner) is now handled structurally by persona resolution at
// module load: a non-CC parent without `AGENT_BRIDGE_PERSONA` set ends
// up in tools-only mode and never reaches Patch F's kill block. This
// test verifies that pathway: the older peer survives because the new
// child is in tools-only mode, not because of an inline gate.
test('4.0.0 (replaces 3.14.8 gate): non-Claude-channel parent + no AGENT_BRIDGE_PERSONA → tools-only at module load, peer NOT killed', { timeout: 15_000 }, async () => {
  // Bug context: openclaw-gateway-spawned MCP children of the agent-bridge
  // plugin would arrive at Patch F's evict-by-version with a NEWER on-disk
  // version than the user's main Claude Code channel-owner, and SIGTERM →
  // SIGKILL it — disconnecting the user's interactive session. The new
  // gate (3.14.8) blocks the kill when our parent is not a Claude channel
  // host.
  //
  // Test mechanism: the test runner (this `node` process) is the plugin's
  // parent. Its command line does NOT match parentLooksChannelCapable
  // (no --channels flag, no /claude.app/Contents/MacOS/claude path, no
  // anthropic.claude-code-* path). 4.0.0 normally puts non-CC parents
  // into tools-only mode at module load when AGENT_BRIDGE_PERSONA is
  // unset, so Patch F never runs in the first place. To exercise the
  // 3.14.8 gate as a defence-in-depth backstop we explicitly SET
  // AGENT_BRIDGE_PERSONA=default (forcing channel-owner mode despite
  // the non-CC parent), then assert the inner gate refuses to evict.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3.14.8-non-channel-parent-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code__default.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  // Long-lived helper that traps SIGTERM. If Patch F erroneously fires,
  // this peer would die within ~200 ms. We assert it stays alive.
  const peer = spawn(process.execPath, [
    '-e',
    `process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 200); });
     setInterval(() => {}, 1000);`,
  ], { stdio: 'ignore' });
  await sleep(200);

  try {
    const peerLease = {
      pid: peer.pid,
      target: 'claude-code/default',
      role: 'channel-owner',
      token: `${peer.pid}-old-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      version: '3.6.0', // strictly older than our 4.0.0 build
    };
    await writeFile(lockPath, JSON.stringify(peerLease, null, 2));

    // 4.0.0 — explicitly clear AGENT_BRIDGE_PERSONA so the cmdline-
    // fallback runs. The test runner's parent cmdline does NOT match
    // parentLooksChannelCapable (no Claude flags), so identity.mode
    // resolves to tools-only at module load and Patch F never runs.
    const child = spawn(process.execPath, [indexPath], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENT_BRIDGE_MACHINE_NAME: 'test-unified',
        AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
        AGENT_BRIDGE_DISABLE_PATCH_G: '1',
        AGENT_BRIDGE_PERSONA: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    child.stdout.resume();

    try {
      // Wait long enough that, if Patch F fired, the peer would already be
      // dead (SIGTERM + 2 s grace + buffer).
      await sleep(4_000);

      // Assert: peer is still alive — kill(0) should not throw ESRCH.
      let peerStillAlive = true;
      try {
        process.kill(peer.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') peerStillAlive = false;
      }
      assert.equal(
        peerStillAlive,
        true,
        'older-version peer must NOT be killed when our parent is non-Claude-channel (4.0.0 tools-only at module load)',
      );

      const events = await readEvents(home);

      // 4.0.0 — Patch F was never reached. The kill events must NOT be
      // present. The watcher.role_demoted_non_channel_parent event MUST
      // be present because main() logs it when persona+cmdline-fallback
      // both fail.
      const killEvent = events.find((e) => e.event === 'patch_f.peer_version_kill');
      assert.equal(
        killEvent,
        undefined,
        'patch_f.peer_version_kill must NOT fire when child is tools-only at module load',
      );
      const preKillWarn = events.find(
        (e) => e.event === 'auto_update_runner.kill_will_evict_active_session',
      );
      assert.equal(
        preKillWarn,
        undefined,
        'auto_update_runner.kill_will_evict_active_session must NOT fire when child is tools-only',
      );

      const demoted = events.find(
        (e) => e.event === 'watcher.role_demoted_non_channel_parent',
      );
      assert.ok(
        demoted,
        '4.0.0: watcher.role_demoted_non_channel_parent MUST fire — persona env unset and cmdline-fallback negative ⇒ tools-only',
      );
      assert.equal(
        demoted.context.identity_reason,
        'tools_only_no_channel_flag',
        'demotion event must carry identity_reason=tools_only_no_channel_flag',
      );
    } finally {
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2_000),
      ]);
      try { child.kill('SIGKILL'); } catch {}
    }
  } finally {
    try { peer.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('4.0.0: persona resolution wires the parent-capability decision via persona.ts', async () => {
  // 4.0.0 — the inline 3.14.8 gate was removed. Its job is now done by
  // `resolveIdentity` in persona.ts at module load. Assert that:
  //   1. persona.ts ships the `parentLooksChannelCapable` helper
  //   2. persona.ts ships the `readParentCommandLine` helper
  //   3. index.ts imports those helpers (so the IIFE + main() agree)
  //   4. index.ts no longer carries the in-the-loop skip_evict_*
  //      event name (its replacement is structural).
  const indexSrc = await readFile(indexPath, 'utf8');
  const personaSrc = await readFile(join(__dirname, '..', 'build', 'persona.js'), 'utf8');
  assert.ok(
    personaSrc.includes('parentLooksChannelCapable'),
    'parentLooksChannelCapable must live in persona.ts (4.0.0)',
  );
  assert.ok(
    personaSrc.includes('readParentCommandLine'),
    'readParentCommandLine must live in persona.ts (4.0.0)',
  );
  assert.ok(
    indexSrc.includes('resolveIdentity'),
    'index.ts must call resolveIdentity at module load (4.0.0)',
  );
  // The 3.14.8 in-the-loop skip event should be gone — its replacement
  // is the persona-resolution-driven tools-only mode.
  assert.equal(
    indexSrc.includes('auto_update_runner.skip_evict_non_channel_parent'),
    false,
    '4.0.0: the inline 3.14.8 skip event was replaced by structural persona resolution',
  );
});

// ─── Patch G — SIGTERM ignored when parent alive + watcher healthy ──────────
test('Patch G: SIGTERM is ignored when parent is alive and channel-owner watcher is healthy', { timeout: 12_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip("Windows child.kill('SIGTERM') can terminate without exercising Node's SIGTERM handler");
    return;
  }
  // The test runner IS the plugin's parent and is alive while we run, so
  // the Patch G ignore branch should fire. Re-enable Patch G for this test.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-patch-g-'));
  const child = startServer(home, {
    AGENT_BRIDGE_DISABLE_PATCH_G: '0',
    // 4.0.0 — startServer already sets AGENT_BRIDGE_PERSONA=default.
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
      // 4.0.0 — tools-only mode is the natural outcome when
      // AGENT_BRIDGE_PERSONA is unset and parent cmdline lacks the
      // channel flag. Explicitly clear PERSONA in case the test runner
      // shell has it set.
      AGENT_BRIDGE_PERSONA: '',
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
    assert.equal(parsed.version, '4.4.0', 'status.version is 4.4.0');
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
  // 4.0.0 — persona-scoped subdir under claude-code/default/.
  const inboxDir = join(home, '.agent-bridge', 'inbox', 'claude-code', 'default');
  const pendingAckDir = join(home, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code', 'default');

  const child = startServer(home, {
    // startServer already sets AGENT_BRIDGE_PERSONA=default.
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
      target: 'claude-code/default',
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

// ─── 3.14.4 — Pre-kill warning event + epitaph ──────────────────────────────
test('3.14.4: kill_will_evict_active_session fires before peer_version_kill', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3.14.4-prekill-'));
  const lockDir = join(home, '.agent-bridge', 'locks');
  const lockPath = join(lockDir, 'claude-code__default.watcher-lock.json');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  const peer = spawn(process.execPath, [
    '-e',
    `process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 200); });
     setInterval(() => {}, 1000);`,
  ], { stdio: 'ignore' });
  await sleep(200);

  try {
    const peerLease = {
      pid: peer.pid,
      target: 'claude-code/default',
      role: 'channel-owner',
      token: `${peer.pid}-old-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(), // fresh heartbeat — would_orphan_this_session=true
      version: '3.6.0', // older than 4.0.0
    };
    await writeFile(lockPath, JSON.stringify(peerLease, null, 2));

    const child = startServer(home, { /* startServer defaults to AGENT_BRIDGE_PERSONA=default */ });
    try {
      await Promise.race([
        new Promise((resolve) => peer.once('exit', resolve)),
        sleep(8_000),
      ]);

      // Wait an extra moment for log file flushes to land.
      await sleep(500);

      const events = await readEvents(home);
      const preKill = events.find((e) => e.event === 'auto_update_runner.kill_will_evict_active_session');
      assert.ok(preKill, 'expected auto_update_runner.kill_will_evict_active_session event before peer kill');
      assert.equal(preKill.context.peer_pid, peer.pid, 'peer_pid logged in pre-kill warning');
      assert.equal(preKill.context.peer_version, '3.6.0', 'peer_version logged');
      assert.equal(preKill.context.our_version, '4.4.0', 'our_version logged');
      assert.equal(preKill.context.would_orphan_this_session, true, 'fresh heartbeat → would_orphan_this_session=true');
      assert.ok(typeof preKill.context.human_summary === 'string', 'human_summary string present');
      assert.ok(preKill.context.human_summary.includes('disconnect'), 'human_summary mentions disconnect risk');

      // Pre-kill warning MUST come before the actual kill event.
      const killIdx = events.findIndex((e) => e.event === 'patch_f.peer_version_kill');
      const preKillIdx = events.findIndex((e) => e.event === 'auto_update_runner.kill_will_evict_active_session');
      assert.ok(preKillIdx >= 0 && killIdx >= 0, 'both events present');
      assert.ok(preKillIdx < killIdx, 'pre-kill warning must be logged BEFORE the kill itself');
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

test('3.14.4: epitaph fires on SIGTERM-initiated shutdown', { timeout: 10_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip("Windows child.kill('SIGTERM') can terminate without exercising Node's SIGTERM handler");
    return;
  }
  // Spin up a server with Patch G disabled so SIGTERM actually triggers shutdown.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3.14.4-epitaph-'));
  const child = startServer(home, {
    // 4.0.0 — startServer already sets AGENT_BRIDGE_PERSONA=default.
    AGENT_BRIDGE_DISABLE_PATCH_G: '1',
  });
  try {
    // Give the server a moment to boot + acquire the lease.
    await sleep(1500);
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5000),
    ]);
    // Allow log flushes.
    await sleep(300);

    const events = await readEvents(home);
    const epitaph = events.find((e) => e.event === 'auto_update_runner.epitaph');
    assert.ok(epitaph, 'expected auto_update_runner.epitaph event after SIGTERM-initiated shutdown');
    assert.equal(epitaph.context.version, '4.4.0', 'epitaph carries our version');
    assert.ok(
      typeof epitaph.context.kill_reason === 'string' && epitaph.context.kill_reason.length > 0,
      'epitaph carries a kill_reason string',
    );
    assert.ok(
      epitaph.context.pid === child.pid || typeof epitaph.context.pid === 'number',
      'epitaph carries pid',
    );
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ─── 3.14.4 — mcp-incident-report CLI extracts events in window ─────────────
test('3.14.4: agent-bridge mcp-incident-report extracts events around timestamp', { timeout: 10_000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);

  // Build a synthetic agent-bridge.log in a sandbox HOME.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-incident-report-'));
  const logsDir = join(home, '.agent-bridge', 'logs');
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const logPath = join(logsDir, 'agent-bridge.log');

  const t0 = new Date('2026-05-03T12:00:00.000Z').getTime();
  const events = [
    { ts: new Date(t0 - 60_000).toISOString(), event: 'unrelated.before_window', level: 'info' },
    { ts: new Date(t0 + 5_000).toISOString(), event: 'auto_update_runner.kill_will_evict_active_session', level: 'warn',
      context: { peer_pid: 111, peer_version: '3.14.3', our_version: '3.14.4', would_orphan_this_session: true,
                 human_summary: 'about to kill v=3.14.3' } },
    { ts: new Date(t0 + 6_000).toISOString(), event: 'patch_f.peer_version_kill', level: 'info',
      context: { peer_pid: 111, peer_version: '3.14.3', our_version: '3.14.4' } },
    { ts: new Date(t0 + 7_000).toISOString(), event: 'auto_update_runner.epitaph', level: 'info',
      context: { pid: 111, version: '3.14.3', kill_reason: 'patch_f.peer_version_kill_suspected' } },
    { ts: new Date(t0 + 30 * 60_000).toISOString(), event: 'unrelated.after_window', level: 'info' },
  ];

  await writeFile(
    logPath,
    events.map((e) => JSON.stringify({ ...e, component: 'mcp-server', machine: 'test' })).join('\n') + '\n',
  );

  const cliPath = join(__dirname, '..', '..', 'agent-bridge');
  // Resolve the running node's real binary dir so the bash CLI's `node`
  // invocation works even when HOME is sandboxed (some user shims under
  // ~/bin/node depend on $HOME/.nvm being readable, which a sandbox HOME
  // hides). Prepending the real bin dir to PATH gives bash a deterministic
  // node it can exec.
  const { dirname: pathDirname } = await import('node:path');
  const realNodeDir = pathDirname(process.execPath);
  const { stdout } = await execFileP('bash', [cliPath, 'mcp-incident-report', '--around', '2026-05-03T12:00:05.000Z'], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${realNodeDir}:${process.env.PATH ?? ''}`,
    },
    timeout: 8_000,
  });

  // The report must include the in-window events and the human summary.
  assert.ok(stdout.includes('auto_update_runner.kill_will_evict_active_session'), 'report mentions pre-kill warning event');
  assert.ok(stdout.includes('patch_f.peer_version_kill'), 'report mentions kill event');
  assert.ok(stdout.includes('auto_update_runner.epitaph'), 'report mentions epitaph');
  assert.ok(!stdout.includes('unrelated.before_window'), 'report excludes events before the window');
  assert.ok(!stdout.includes('unrelated.after_window'), 'report excludes events after the window');
  assert.ok(/SUMMARY:/i.test(stdout), 'report includes a SUMMARY line');

  await rm(home, { recursive: true, force: true });
});
