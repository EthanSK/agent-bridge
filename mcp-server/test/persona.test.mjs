/**
 * 4.0.0 — Persona-based multi-session inbox routing tests.
 *
 * Covers the locked design (Ethan voice 1922 + 1924 + 1926 + 1928 + 1929):
 *   1. AGENT_BRIDGE_PERSONA env var → MCP child claims the persona's
 *      inbox lease.
 *   2. AGENT_BRIDGE_PERSONA unset + parent cmdline has channel flag →
 *      cmdline-fallback adopts persona "default".
 *   3. AGENT_BRIDGE_PERSONA unset + no channel flag → tools-only mode,
 *      no lease attempt.
 *   4. Two MCP children with the same persona → first wins lease,
 *      second demotes to tools-only-for-life. Outbound `bridge_*`
 *      tools still work in the loser.
 *   5. Sender addresses `target=claude-code` → routes to
 *      `inbox/claude-code/default/`.
 *   6. Sender addresses `target=claude-code/foo` → routes to
 *      `inbox/claude-code/foo/`.
 *   7. Backward-compat: legacy `inbox/claude-code/<file>.json` files at
 *      boot get migrated into `inbox/claude-code/default/`.
 *   8. Removed env vars (AGENT_BRIDGE_ROLE,
 *      AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT, AGENT_BRIDGE_DISABLE_WATCHER)
 *      have NO effect on identity resolution.
 *   9. resolveIdentity unit tests — pure function on env + cmdline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');
const buildDir = join(__dirname, '..', 'build');
const packageVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(home, env = {}) {
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-persona',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_DISABLE_PATCH_G: '1',
      // Default to PERSONA unset; tests opt in by setting it via `env`.
      AGENT_BRIDGE_PERSONA: '',
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

async function waitFor(predicate, timeoutMs = 8_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ── 1. PERSONA env var set → claim persona-scoped lease ────────────────────
test('PERSONA env var set: MCP child claims inbox/claude-code/<persona>/ lease keyed by persona', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-set-'));
  const child = startServer(home, { AGENT_BRIDGE_PERSONA: 'yolo' });
  try {
    const leasePath = join(home, '.agent-bridge', 'locks', 'claude-code__yolo.watcher-lock.json');
    const acquired = await waitFor(() => existsSync(leasePath), 6_000);
    assert.ok(acquired, `expected lease at ${leasePath}`);

    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.equal(lease.target, 'claude-code/yolo', 'lease target encodes persona');
    assert.equal(lease.pid, child.pid, 'lease pid matches child');
    assert.equal(lease.role, 'channel-owner', 'lease role is channel-owner');

    // The DEFAULT persona's lease must NOT exist — they're independent.
    const defaultLease = join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');
    assert.equal(existsSync(defaultLease), false, 'default-persona lease must NOT be claimed by yolo persona');

    // Startup banner reflects identity_reason=env_var.
    await sleep(500);
    const events = await readEvents(home);
    const starting = events.find((e) => e.event === 'server.starting');
    assert.ok(starting, 'server.starting fired');
    assert.equal(starting.context.persona, 'yolo', 'persona logged on startup');
    assert.equal(starting.context.target, 'claude-code/yolo', 'target logged on startup');
    assert.equal(starting.context.mode, 'channel-owner', 'mode is channel-owner');
    assert.equal(starting.context.identity_reason, 'env_var', 'reason is env_var');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 2. PERSONA unset + cmdline-fallback positive → persona=default ─────────
test('PERSONA unset + cmdline has --channels plugin:agent-bridge: cmdline-fallback adopts persona=default', { timeout: 10_000 }, async () => {
  // We can't easily inject a custom cmdline into the test runner, but we
  // CAN spawn a wrapper that has `--channels plugin:agent-bridge` in its
  // own argv (a no-op flag for node, which puts it in the cmdline). The
  // wrapper then exec's the MCP child as a subprocess so MCP child's
  // ppid == wrapper, and ps -p <wrapper> shows the channel flag.
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-cmdline-fallback-'));
  // Use `--` to tell node to stop parsing flags; everything after `--`
  // is positional. The wrapper needs to be a file because `-e` argv is
  // squashed.
  const wrapperPath = join(home, 'wrapper.mjs');
  await writeFile(wrapperPath, `
import { spawn } from 'node:child_process';
const env = { ...process.env };
const child = spawn(process.execPath, ['${indexPath}'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
child.stdout.resume();
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
`);
  const wrapperArgs = [
    wrapperPath,
    '--channels',
    'plugin:agent-bridge@example',
  ];
  const wrapper = spawn(process.execPath, wrapperArgs, {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-persona-fallback',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_DISABLE_PATCH_G: '1',
      AGENT_BRIDGE_PERSONA: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  wrapper.stderr.resume();
  wrapper.stdout.resume();

  try {
    const leasePath = join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');
    const acquired = await waitFor(() => existsSync(leasePath), 8_000);
    assert.ok(acquired, `expected default-persona lease at ${leasePath}`);

    await sleep(500);
    const events = await readEvents(home);
    const starting = events.find((e) => e.event === 'server.starting');
    assert.ok(starting, 'server.starting fired');
    assert.equal(starting.context.persona, 'default', 'persona=default via cmdline-fallback');
    assert.equal(starting.context.identity_reason, 'cmdline_fallback', 'reason is cmdline_fallback');
  } finally {
    try { wrapper.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 3. PERSONA unset + no channel flag → tools-only ────────────────────────
test('PERSONA unset + parent cmdline has NO channel flag: tools-only, no lease attempted', { timeout: 8_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-tools-only-'));
  const child = startServer(home, { AGENT_BRIDGE_PERSONA: '' });
  try {
    // Wait long enough for the watcher to NOT acquire a lease.
    await sleep(2_500);

    const defaultLease = join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');
    assert.equal(existsSync(defaultLease), false, 'tools-only mode must NOT claim the default-persona lease');

    const events = await readEvents(home);
    const starting = events.find((e) => e.event === 'server.starting');
    assert.ok(starting, 'server.starting fired');
    assert.equal(starting.context.mode, 'tools-only', 'mode is tools-only');
    assert.ok(
      ['tools_only_no_channel_flag', 'tools_only_no_parent_cmdline'].includes(starting.context.identity_reason),
      `reason should be tools_only_no_channel_flag or tools_only_no_parent_cmdline; got ${starting.context.identity_reason}`,
    );

    const watcherDisabled = events.find((e) => e.event === 'watcher.disabled');
    assert.ok(watcherDisabled, 'watcher.disabled event must fire in tools-only mode');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 4. Two children with same persona → loser demotes to tools-only ────────
test('Two MCP children with same PERSONA: first wins lease, second goes to standby (still tools-capable)', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-collision-'));
  const winner = startServer(home, { AGENT_BRIDGE_PERSONA: 'default' });
  try {
    const leasePath = join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');
    const winnerAcquired = await waitFor(() => existsSync(leasePath), 6_000);
    assert.ok(winnerAcquired, 'first child must acquire the lease');
    let lease = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.equal(lease.pid, winner.pid, 'winner pid in lease');

    // Spawn a second child with the same persona.
    const loser = startServer(home, { AGENT_BRIDGE_PERSONA: 'default' });
    try {
      // Give the loser time to attempt the lease + log standby.
      await sleep(3_000);

      // Lease still owned by the winner.
      lease = JSON.parse(await readFile(leasePath, 'utf8'));
      assert.equal(lease.pid, winner.pid, 'lease still owned by winner; loser demoted to standby');

      // Loser's events show patch_f.standby OR watcher.standby (depending
      // on the exact race outcome). Either is correct — the loser does
      // NOT exit, does NOT kill the winner, and stays connected.
      const events = await readEvents(home);
      const loserStandby = events.find(
        (e) => (e.event === 'patch_f.standby' || e.event === 'watcher.standby')
        && e.context?.pid === loser.pid,
      );
      assert.ok(
        loserStandby,
        `expected patch_f.standby OR watcher.standby for loser pid=${loser.pid}`,
      );

      // Loser must still be alive (proves outbound bridge_* tools could run).
      assert.equal(loser.exitCode, null, 'loser is still alive (tools-capable, just no inbox lease)');
    } finally {
      try { loser.kill('SIGKILL'); } catch {}
    }
  } finally {
    try { winner.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 5/6. Sender-side target rewrites: spawn a sandboxed Node process so
// HOME is fixed at module load (config.ts caches `homedir()` into
// `BRIDGE_DIR`).
async function runSendLocalInSandbox(home, target, fromTarget) {
  const script = `
    const inbox = await import('${join(buildDir, 'inbox.js').replaceAll('\\\\', '/').replaceAll("'", "\\'")}');
    const msg = inbox.createMessage(
      'TestSender', 'TestSender', 'message', 'sandbox test', null, 60,
      ${JSON.stringify(target)}, ${JSON.stringify(fromTarget)},
    );
    inbox.sendLocalMessage(msg);
    process.stdout.write(msg.id);
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENT_BRIDGE_MACHINE_NAME: 'TestSender',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`sandbox exit ${code}; stderr:\n${stderr}`));
    });
  });
}

test('Sender addresses target=claude-code (legacy): file lands at flat inbox/claude-code/<id>.json with target preserved (rolling-upgrade compat)', { timeout: 8_000 }, async () => {
  // Rolling-upgrade compatibility (codex review pass 3): when a v4 sender
  // addresses the legacy `claude-code` literal, the file MUST land at the
  // un-scoped legacy path with `target` and `fromTarget` left untouched.
  // This is the ONLY shape a still-running v3 channel-owner can read
  // (v3 watchers scan flat `inbox/claude-code/*.json` and assert
  // `target === "claude-code"`). v4 receivers handle the same file via
  // `migrateLegacyClaudeCodeInboxFiles()` which drains it into
  // `inbox/claude-code/default/` on init AND periodically via the watcher
  // tick. The same rule applies to local sends because v4 tools-only
  // siblings can coexist with a v3 channel-owner on the same host (no
  // lease-based eviction for tools-only children).
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-legacy-target-'));
  try {
    const msgId = await runSendLocalInSandbox(home, 'claude-code', 'claude-code');
    const expected = join(home, '.agent-bridge', 'inbox', 'claude-code', `${msgId}.json`);
    assert.ok(existsSync(expected), `expected file at flat legacy path ${expected}`);
    const parsed = JSON.parse(await readFile(expected, 'utf8'));
    assert.equal(parsed.target, 'claude-code', 'legacy `claude-code` target preserved on the wire');
    assert.equal(parsed.fromTarget, 'claude-code', 'legacy fromTarget preserved on the wire');

    const personaPath = join(home, '.agent-bridge', 'inbox', 'claude-code', 'default', `${msgId}.json`);
    assert.equal(existsSync(personaPath), false, 'file must NOT be pre-routed into `default/` subdir');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Sender addresses target=claude-code/foo: routes to inbox/claude-code/foo/', { timeout: 8_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-named-target-'));
  try {
    const msgId = await runSendLocalInSandbox(home, 'claude-code/foo', 'claude-code/default');
    const expected = join(home, '.agent-bridge', 'inbox', 'claude-code', 'foo', `${msgId}.json`);
    assert.ok(existsSync(expected), `expected file at ${expected}`);
    const parsed = JSON.parse(await readFile(expected, 'utf8'));
    assert.equal(parsed.target, 'claude-code/foo', 'named target preserved unchanged');
    assert.equal(parsed.fromTarget, 'claude-code/default', 'fromTarget preserved unchanged');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── 7. Backward-compat: legacy files at inbox/claude-code/*.json get migrated
test('Backward-compat: legacy `inbox/claude-code/*.json` files migrate to `inbox/claude-code/default/` on boot', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-legacy-migration-'));
  const legacyDir = join(home, '.agent-bridge', 'inbox', 'claude-code');
  await mkdir(legacyDir, { recursive: true, mode: 0o700 });

  // Drop a fully-formed BridgeMessage at the legacy un-scoped path.
  const msgId = `msg-${randomUUID()}`;
  const msg = {
    id: msgId,
    from: 'LegacySender',
    to: 'test-persona',
    type: 'message',
    content: 'pre-4.0.0 legacy message',
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 600,
    target: 'claude-code',
    fromTarget: 'claude-code',
  };
  const legacyPath = join(legacyDir, `${msgId}.json`);
  await writeFile(legacyPath, JSON.stringify(msg, null, 2), { mode: 0o600 });

  // Now boot the MCP child as the default persona — initInbox should
  // migrate the legacy file into `inbox/claude-code/default/`.
  const child = startServer(home, { AGENT_BRIDGE_PERSONA: 'default' });
  try {
    const newPath = join(home, '.agent-bridge', 'inbox', 'claude-code', 'default', `${msgId}.json`);
    const migratedOrPushed = await waitFor(async () => {
      // The file may move from legacy → default → pending-ack (if the
      // watcher staged it). All three are evidence that migration ran.
      if (!existsSync(legacyPath)) {
        const pendingPath = join(home, '.agent-bridge', 'inbox', '.pending-ack', 'claude-code', 'default', `${msgId}.json`);
        return existsSync(newPath) || existsSync(pendingPath);
      }
      return false;
    }, 8_000);
    assert.ok(migratedOrPushed, 'legacy file must be moved out of inbox/claude-code/ within 8 s');

    // Legacy path must be gone.
    assert.equal(existsSync(legacyPath), false, 'legacy path no longer holds the file');

    const events = await readEvents(home);
    const migrated = events.find((e) => e.event === 'inbox.legacy_migrated');
    assert.ok(migrated, 'inbox.legacy_migrated event must fire on boot');
    assert.equal(migrated.context.persona, 'default', 'migration logged for default persona');
    assert.ok(migrated.context.moved >= 1, 'at least 1 file moved');
    assert.ok(migrated.context.ids.includes(msgId), 'migrated id list includes our test message');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 7b. Non-default personas leave legacy files alone ──────────────────────
test('Backward-compat: non-default personas DO NOT adopt legacy `inbox/claude-code/*.json` files', { timeout: 8_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-non-default-no-migrate-'));
  const legacyDir = join(home, '.agent-bridge', 'inbox', 'claude-code');
  await mkdir(legacyDir, { recursive: true, mode: 0o700 });

  const msgId = `msg-${randomUUID()}`;
  const legacyPath = join(legacyDir, `${msgId}.json`);
  await writeFile(legacyPath, JSON.stringify({
    id: msgId,
    from: 'LegacySender',
    to: 'test-persona',
    type: 'message',
    content: 'legacy file',
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 600,
    target: 'claude-code',
    fromTarget: 'claude-code',
  }, null, 2), { mode: 0o600 });

  // Boot as persona=yolo. The default persona's legacy file MUST stay
  // in place.
  const child = startServer(home, { AGENT_BRIDGE_PERSONA: 'yolo' });
  try {
    await sleep(2_500);
    assert.ok(existsSync(legacyPath), 'legacy file must NOT be migrated by a non-default persona');

    const yoloDir = join(home, '.agent-bridge', 'inbox', 'claude-code', 'yolo');
    const yoloEntries = existsSync(yoloDir) ? await readdir(yoloDir) : [];
    assert.ok(
      !yoloEntries.includes(`${msgId}.json`),
      'legacy file must NOT have been moved into the yolo persona subdir',
    );

    const events = await readEvents(home);
    const migrated = events.find((e) => e.event === 'inbox.legacy_migrated');
    assert.equal(migrated, undefined, 'inbox.legacy_migrated must NOT fire for a non-default persona');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 8. Removed env vars have no effect on identity ─────────────────────────
test('Removed env vars (AGENT_BRIDGE_ROLE, AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT, AGENT_BRIDGE_DISABLE_WATCHER) have NO effect', { timeout: 8_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'ab-persona-removed-envs-'));
  // Set ALL the legacy env vars — they should be silently ignored.
  // Without AGENT_BRIDGE_PERSONA + with the test runner as parent (no
  // channel flag), the child MUST end up in tools-only mode regardless
  // of these legacy vars.
  const child = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
    AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
    AGENT_BRIDGE_DISABLE_WATCHER: '0',
    AGENT_BRIDGE_PERSONA: '', // explicitly unset
  });
  try {
    await sleep(2_500);

    const defaultLease = join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');
    assert.equal(
      existsSync(defaultLease),
      false,
      'AGENT_BRIDGE_ROLE=channel-owner + AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT=1 must NOT claim the lease in 4.0.0',
    );

    const events = await readEvents(home);
    const starting = events.find((e) => e.event === 'server.starting');
    assert.ok(starting, 'server.starting fired');
    assert.equal(starting.context.mode, 'tools-only', 'mode is tools-only despite legacy env vars');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

// ── 9. resolveIdentity unit tests ───────────────────────────────────────────
test('resolveIdentity: pure function on env + cmdline (env_var path)', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: { AGENT_BRIDGE_PERSONA: 'yolo' },
    parentCommandLine: 'irrelevant — env var wins',
  });
  assert.equal(r.mode, 'channel-owner');
  assert.equal(r.persona, 'yolo');
  assert.equal(r.target, 'claude-code/yolo');
  assert.equal(r.reason, 'env_var');
});

test('resolveIdentity: env var unset + channel flag in parent cmdline → cmdline_fallback path', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '/usr/local/bin/node /path/to/claude --channels plugin:agent-bridge@example --other-flag',
  });
  assert.equal(r.mode, 'channel-owner');
  assert.equal(r.persona, 'default');
  assert.equal(r.target, 'claude-code/default');
  assert.equal(r.reason, 'cmdline_fallback');
});

test('resolveIdentity: env var unset + plain `--channels` (no agent-bridge value) → tools-only', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '/usr/local/bin/node /path/to/claude --channels plugin:telegram@example',
  });
  assert.equal(r.mode, 'tools-only', 'channel flag with non-agent-bridge value does NOT count');
  assert.equal(r.persona, null);
  assert.equal(r.reason, 'tools_only_no_channel_flag');
});

test('resolveIdentity: env var unset + Claude Code desktop binary in cmdline → cmdline_fallback', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '/Applications/Claude.app/Contents/MacOS/claude --resume',
  });
  assert.equal(r.mode, 'channel-owner');
  assert.equal(r.persona, 'default');
  assert.equal(r.reason, 'cmdline_fallback');
});

test('resolveIdentity: env var unset + Claude Code VS Code native binary in cmdline → cmdline_fallback', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '/Users/foo/.vscode/extensions/anthropic.claude-code-1.2.3/resources/native-binary/claude --resume',
  });
  assert.equal(r.mode, 'channel-owner');
  assert.equal(r.persona, 'default');
  assert.equal(r.reason, 'cmdline_fallback');
});

test('resolveIdentity: env var unset + non-Claude parent cmdline → tools-only', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '/usr/bin/node /Users/foo/some-script.js',
  });
  assert.equal(r.mode, 'tools-only');
  assert.equal(r.persona, null);
  assert.equal(r.target, null);
  assert.equal(r.reason, 'tools_only_no_channel_flag');
});

test('resolveIdentity: env var unset + empty cmdline (Windows / ps failure) → tools-only', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {},
    parentCommandLine: '',
  });
  assert.equal(r.mode, 'tools-only');
  assert.equal(r.reason, 'tools_only_no_parent_cmdline');
});

test('resolveIdentity: invalid persona env var (path traversal etc.) -> tools-only with env_var_invalid', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  // The composed target `claude-code/<persona>` is validated by
  // `isValidTarget`. These all FAIL validation:
  //   - `..`            -> the includes('..') check rejects
  //   - `has space`     -> whitespace not in the allowed char class
  //   - `-leading`      -> segment must START with letter/digit/_
  //   - `trailing-`     -> segment must END with letter/digit/_
  //   - `with/slash/`   -> composed target ends with '/'
  const cases = ['..', 'has space', '-leading', 'trailing-', 'with/slash/'];
  for (const persona of cases) {
    const r = personaModule.resolveIdentity({
      env: { AGENT_BRIDGE_PERSONA: persona },
      parentCommandLine: '',
    });
    assert.equal(r.mode, 'tools-only', `invalid persona ${JSON.stringify(persona)} must demote to tools-only`);
    assert.equal(r.reason, 'env_var_invalid', `reason for ${JSON.stringify(persona)} should be env_var_invalid`);
  }
});

test('resolveIdentity: ignores legacy env vars (AGENT_BRIDGE_ROLE, AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT, AGENT_BRIDGE_DISABLE_WATCHER)', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  const r = personaModule.resolveIdentity({
    env: {
      AGENT_BRIDGE_ROLE: 'channel-owner',
      AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
      AGENT_BRIDGE_DISABLE_WATCHER: '0',
    },
    parentCommandLine: '/usr/bin/node /not/claude.js',
  });
  assert.equal(r.mode, 'tools-only', 'legacy env vars must NOT promote to channel-owner in 4.0.0');
  assert.equal(r.reason, 'tools_only_no_channel_flag');
});

test('normalizeClaudeCodeTarget: legacy `claude-code` → `claude-code/default`, anything else passes through', async () => {
  const personaModule = await import(join(buildDir, 'persona.js'));
  assert.equal(personaModule.normalizeClaudeCodeTarget('claude-code'), 'claude-code/default');
  assert.equal(personaModule.normalizeClaudeCodeTarget('claude-code/yolo'), 'claude-code/yolo');
  assert.equal(personaModule.normalizeClaudeCodeTarget('openclaw/default'), 'openclaw/default');
});

// ── Source-level wiring guards ──────────────────────────────────────────────
test('source-level: AGENT_BRIDGE_ROLE / AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT / AGENT_BRIDGE_DISABLE_WATCHER are not read in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  const watcherSrc = await readFile(join(buildDir, 'watcher.js'), 'utf8');
  const inboxSrc = await readFile(join(buildDir, 'inbox.js'), 'utf8');
  const personaSrc = await readFile(join(buildDir, 'persona.js'), 'utf8');
  const configSrc = await readFile(join(buildDir, 'config.js'), 'utf8');
  for (const src of [indexSrc, watcherSrc, inboxSrc, personaSrc, configSrc]) {
    assert.equal(
      /process\.env\.AGENT_BRIDGE_ROLE/.test(src),
      false,
      'AGENT_BRIDGE_ROLE must NOT be read anywhere in 4.0.0',
    );
    assert.equal(
      /process\.env\.AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT/.test(src),
      false,
      'AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT must NOT be read anywhere in 4.0.0',
    );
    assert.equal(
      /process\.env\.AGENT_BRIDGE_DISABLE_WATCHER/.test(src),
      false,
      'AGENT_BRIDGE_DISABLE_WATCHER must NOT be read anywhere in 4.0.0',
    );
  }
});

test('source-level: AGENT_BRIDGE_PERSONA is the only identity env var read in shipped build', async () => {
  const personaSrc = await readFile(join(buildDir, 'persona.js'), 'utf8');
  // The persona module reads `env[AGENT_BRIDGE_PERSONA_ENV]` — verify
  // the constant string is present.
  assert.ok(
    personaSrc.includes('AGENT_BRIDGE_PERSONA'),
    'AGENT_BRIDGE_PERSONA must be the env var name read by persona.js',
  );
});

test('source-level: .mcp.json pins AGENT_BRIDGE_PERSONA=default for cross-platform channel-mode default', async () => {
  // 4.0.0 (codex review pass 3): the bundled .mcp.json must default the
  // persona to `default` so channel mode works on hosts where the
  // cmdline-fallback path can't resolve channel-capability — notably
  // Windows (no `ps` binary) and any host that hides parent argv. Without
  // this default, those installs would resolve to
  // `tools_only_no_parent_cmdline` and silently lose inbound channel
  // delivery. User shell env overrides this default for non-default
  // personas (env-var precedence is enforced in resolveIdentity).
  const mcpJsonPath = join(__dirname, '..', '.mcp.json');
  const raw = await readFile(mcpJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const server = parsed?.mcpServers?.['agent-bridge'];
  assert.ok(server, '.mcp.json must declare the agent-bridge server');
  assert.ok(server.env, '.mcp.json env block must be present');
  assert.equal(
    server.env.AGENT_BRIDGE_PERSONA,
    'default',
    '.mcp.json must pin AGENT_BRIDGE_PERSONA=default for cross-platform channel mode',
  );
  // 4.0.0 — only AGENT_BRIDGE_PERSONA may live here. The legacy v3 triad
  // (AGENT_BRIDGE_ROLE / ALLOW_NON_CHANNEL_PARENT / DISABLE_WATCHER) MUST
  // stay removed.
  assert.equal(server.env.AGENT_BRIDGE_ROLE, undefined, 'legacy AGENT_BRIDGE_ROLE must not be in .mcp.json');
  assert.equal(
    server.env.AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT,
    undefined,
    'legacy AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT must not be in .mcp.json',
  );
  assert.equal(
    server.env.AGENT_BRIDGE_DISABLE_WATCHER,
    undefined,
    'legacy AGENT_BRIDGE_DISABLE_WATCHER must not be in .mcp.json',
  );
});

test('source-level: lease key for claude-code/default is `claude-code__default.watcher-lock.json`', async () => {
  const configModule = await import(join(buildDir, 'config.js'));
  assert.equal(
    configModule.leaseFileNameForTarget('claude-code/default'),
    'claude-code__default.watcher-lock.json',
  );
  assert.equal(
    configModule.leaseFileNameForTarget('claude-code/yolo'),
    'claude-code__yolo.watcher-lock.json',
  );
});

// ─── Patch F rolling-upgrade: legacy lease (no version field) is killed ────
//
// Regression for the round-2 Codex finding. A pre-3.7.1 `agent-bridge`
// build wrote `claude-code.watcher-lock.json` WITHOUT a `version` field.
// During a v3 → v4 rolling upgrade, the v4 default-persona owner must
// see that legacy lease, treat the unknown-version holder as strictly
// older (synthesized "3.0.0"), SIGTERM it, and acquire the new
// persona-keyed lease — otherwise v3 + v4 run concurrently and split
// inbox delivery between `inbox/claude-code/` and `inbox/claude-code/default/`.
test(
  '4.0.0: Patch F kills legacy `claude-code.watcher-lock.json` holder with no version field',
  { timeout: 12_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-bridge-legacy-lease-'));
    const lockDir = join(home, '.agent-bridge', 'locks');
    await mkdir(lockDir, { recursive: true, mode: 0o700 });

    // Spawn a long-running placeholder process to act as the "v3 holder"
    // — Patch F probes liveness via kill(pid, 0). We use `sleep` so the
    // pid is real and not our own (the self-pid path is skipped).
    const placeholder = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    let placeholderExitCode = null;
    placeholder.on('exit', (code, signal) => {
      placeholderExitCode = signal ?? code;
    });
    // Give the kernel a moment to wire up signal delivery.
    await sleep(50);

    const legacyLeasePath = join(lockDir, 'claude-code.watcher-lock.json');
    const fakeLegacyLease = {
      pid: placeholder.pid,
      target: 'claude-code',
      role: 'channel-owner',
      token: `${placeholder.pid}-legacy-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      // NOTE: no `version` field — this is the pre-3.7.1 form Codex
      // flagged as the rolling-upgrade hole.
    };
    await writeFile(legacyLeasePath, JSON.stringify(fakeLegacyLease, null, 2));

    const child = startServer(home, { AGENT_BRIDGE_PERSONA: 'default' });
    try {
      // Patch F's pre-kill warning + kill events should fire at module
      // load. We poll the unified log for both, and confirm the
      // placeholder process actually exited (signal).
      await waitFor(async () => {
        const events = await readEvents(home);
        const preKill = events.find(
          (e) => e.event === 'auto_update_runner.kill_will_evict_active_session'
              && e.context?.peer_pid === placeholder.pid,
        );
        const kill = events.find(
          (e) => e.event === 'patch_f.peer_version_kill'
              && e.context?.peer_pid === placeholder.pid,
        );
        return preKill && kill;
      }, 8_000);

      // Verify the synthesized peer_version is the strictly-older
      // placeholder ("3.0.0") so the kill decision is auditable.
      const events = await readEvents(home);
      const kill = events.find(
        (e) => e.event === 'patch_f.peer_version_kill'
            && e.context?.peer_pid === placeholder.pid,
      );
      assert.ok(kill, 'patch_f.peer_version_kill must fire for legacy holder');
      assert.equal(
        kill.context?.peer_version,
        '3.0.0',
        'legacy holder with no version field must be treated as 3.0.0 (strictly older)',
      );
      assert.equal(
        kill.context?.our_version,
        packageVersion,
        `our_version must be ${packageVersion} in the kill event`,
      );

      // The placeholder should have received SIGTERM (or SIGKILL after
      // the 2s grace) and exited.
      await waitFor(() => placeholderExitCode !== null, 5_000);
      assert.ok(
        placeholderExitCode === 'SIGTERM' || placeholderExitCode === 'SIGKILL',
        `placeholder must have been SIGTERMed/SIGKILLed (got ${placeholderExitCode})`,
      );
    } finally {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      try { placeholder.kill('SIGKILL'); } catch { /* best-effort */ }
      await sleep(100);
      await rm(home, { recursive: true, force: true });
    }
  },
);
