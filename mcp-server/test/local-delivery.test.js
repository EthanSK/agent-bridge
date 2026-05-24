// Tests for same-machine delivery (3.5.0+).
//
// These tests exercise the local-delivery code path end-to-end:
//   • isLocalMachineName recognises the real local name + reserved aliases
//   • sendLocalMessage writes the JSON to the correct per-target inbox subdir
//   • mixed scenario: local send goes to inbox/, getMachine() ignores local name
//
// Run with `npm test` (after `npm run build`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We override HOME *before* importing the modules so all path constants
// (BRIDGE_DIR, INBOX_DIR, …) resolve into a sandbox dir. Any subsequent test
// run would see the real ~/.agent-bridge otherwise.
const sandbox = mkdtempSync(join(tmpdir(), 'ab-test-'));
mkdirSync(join(sandbox, '.agent-bridge'), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox; // Node's os.homedir() reads USERPROFILE on Windows, not HOME
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestMachine';

// Dynamic imports so the env vars above take effect before the modules cache
// the resolved paths.
const config = await import('../build/config.js');
const inbox = await import('../build/inbox.js');

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

test('isLocalMachineName recognises the real machine name (case-insensitive)', () => {
  assert.equal(config.isLocalMachineName('TestMachine'), true);
  assert.equal(config.isLocalMachineName('testmachine'), true);
  assert.equal(config.isLocalMachineName('  TestMachine  '), true);
  assert.equal(config.isLocalMachineName('SomeOtherMachine'), false);
});

test('isLocalMachineName recognises every reserved alias', () => {
  for (const alias of config.LOCAL_MACHINE_ALIASES) {
    assert.equal(config.isLocalMachineName(alias), true, alias);
    assert.equal(config.isLocalMachineName(alias.toUpperCase()), true, alias);
  }
});

test('isLocalMachineName rejects empty/non-string input', () => {
  assert.equal(config.isLocalMachineName(''), false);
  assert.equal(config.isLocalMachineName('   '), false);
  assert.equal(config.isLocalMachineName(undefined), false);
  assert.equal(config.isLocalMachineName(null), false);
});

test('getMachine returns undefined for the local name and aliases (no SSH route to self)', () => {
  // No paired remotes in the sandbox config — the local lookup must not throw
  // and must not return a ghost MachineConfig.
  assert.equal(config.getMachine('TestMachine'), undefined);
  assert.equal(config.getMachine('local'), undefined);
  assert.equal(config.getMachine('self'), undefined);
});

test('sendLocalMessage with legacy claude-code target lands at flat inbox/claude-code/<id>.json (rolling-upgrade compat)', () => {
  // 4.0.0 (codex review pass 3): legacy `claude-code` addressing is
  // preserved on the wire AND on disk. A v4 tools-only sibling MCP child
  // can coexist with a v3 channel-owner on the same host (tools-only
  // children don't participate in the lease, so eviction doesn't apply).
  // Pre-4.0 receivers only watch flat `inbox/claude-code/*.json` and only
  // accept `target === "claude-code"`. v4 receivers handle the same file
  // via `migrateLegacyClaudeCodeInboxFiles()` (init + periodic watcher
  // tick) which drains it into `inbox/claude-code/default/`.
  const msg = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'hello local world',
    null,
    60,
    'claude-code',
    'claude-code',
  );

  inbox.sendLocalMessage(msg);

  const expectedPath = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', `${msg.id}.json`);
  const raw = readFileSync(expectedPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(parsed.id, msg.id);
  assert.equal(parsed.target, 'claude-code', 'legacy `claude-code` target preserved on the wire');
  assert.equal(parsed.fromTarget, 'claude-code', 'legacy fromTarget preserved on the wire');
  assert.equal(parsed.sourceAgentBridgeVersion, config.MCP_SERVER_VERSION, 'sender-side Agent Bridge version stamped on the wire');
  assert.equal(parsed.content, 'hello local world');
  assert.equal(parsed.from, 'TestMachine');
  assert.equal(parsed.to, 'TestMachine');

  // File must NOT be pre-routed into the persona subdir.
  const personaPath = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', 'default', `${msg.id}.json`);
  assert.equal(
    existsSync(personaPath),
    false,
    'file must NOT be pre-routed into `default/` subdir on the sender side',
  );

  // The outbox copy should also exist (with legacy target preserved).
  const outboxPath = join(sandbox, '.agent-bridge', 'outbox', `${msg.id}.json`);
  const outboxRaw = readFileSync(outboxPath, 'utf8');
  const outboxParsed = JSON.parse(outboxRaw);
  assert.equal(outboxParsed.id, msg.id);
  assert.equal(outboxParsed.target, 'claude-code', 'outbox copy mirrors the wire target');
});

test('sendLocalMessage preserves source-authored relaySummary on the wire', () => {
  const msg = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'please check the bridge receipt',
    null,
    60,
    'openclaw/default',
    'claude-code/default',
    undefined,
    '  Source wants OpenClaw to code-post this receipt.  ',
  );

  inbox.sendLocalMessage(msg);

  const expectedPath = join(sandbox, '.agent-bridge', 'inbox', 'openclaw', 'default', `${msg.id}.json`);
  const raw = readFileSync(expectedPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(parsed.sourceAgentBridgeVersion, config.MCP_SERVER_VERSION, 'default sender version still stamped');
  assert.equal(parsed.relaySummary, 'Source wants OpenClaw to code-post this receipt.');
});

test('sendLocalMessage with explicit claude-code/foo target writes to claude-code/foo/ (no rewrite for already-scoped target)', () => {
  const msg = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'hello named persona',
    null,
    60,
    'claude-code/foo',
    'claude-code/default',
  );

  inbox.sendLocalMessage(msg);

  const expectedPath = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', 'foo', `${msg.id}.json`);
  const raw = readFileSync(expectedPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(parsed.target, 'claude-code/foo', 'persona-scoped target preserved unchanged');
  assert.equal(parsed.fromTarget, 'claude-code/default', 'fromTarget preserved unchanged');
});

test('sendLocalMessage routes to a custom OpenClaw target subdir', () => {
  const msg = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'check the queue',
    null,
    60,
    'openclaw/clawdiboi2',
    'claude-code',
  );

  inbox.sendLocalMessage(msg);

  const targetDir = join(sandbox, '.agent-bridge', 'inbox', 'openclaw', 'clawdiboi2');
  const files = readdirSync(targetDir).filter(f => f.endsWith('.json'));
  assert.ok(files.includes(`${msg.id}.json`), `${msg.id}.json missing in ${targetDir}`);
});

test('sendLocalMessage rejects messages with no/invalid target', () => {
  const msg = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'bad',
    null,
    60,
    undefined,
    undefined,
  );
  assert.throws(() => inbox.sendLocalMessage(msg), /target is required/);

  const msgBadTarget = inbox.createMessage(
    'TestMachine',
    'TestMachine',
    'message',
    'bad',
    null,
    60,
    '../escape',
    undefined,
  );
  assert.throws(() => inbox.sendLocalMessage(msgBadTarget), /target is required/);
});

test('sendLocalMessage atomic write: no .tmp files left behind on success', () => {
  const msg = inbox.createMessage(
    'TestMachine', 'TestMachine', 'message', 'atomic', null, 60, 'claude-code', undefined,
  );
  inbox.sendLocalMessage(msg);

  // 4.0.0 (codex review pass 3): legacy `claude-code` lands at the flat
  // legacy path on disk. Verify the same dir has no orphan tmp files.
  const targetDir = join(sandbox, '.agent-bridge', 'inbox', 'claude-code');
  const tmpFiles = readdirSync(targetDir).filter(f => f.startsWith('.agent-bridge-') && f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0, `unexpected tmp files: ${tmpFiles.join(',')}`);
});

test('mixed scenario: local send lands in local inbox even when paired remotes exist', async () => {
  // Write a fake config with one paired remote.
  const { writeFileSync } = await import('node:fs');
  const cfgPath = join(sandbox, '.agent-bridge', 'config');
  writeFileSync(
    cfgPath,
    [
      '[MacBookPro]',
      'host=192.168.1.50',
      'user=ethan',
      'port=22',
      'key=/dev/null',
      'paired_at=2026-01-01T00:00:00Z',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  // The remote loads cleanly.
  const remote = config.getMachine('MacBookPro');
  assert.ok(remote, 'paired remote should load');
  assert.equal(remote.host, '192.168.1.50');

  // Local lookup still routes to undefined (and isLocalMachineName flags it).
  assert.equal(config.getMachine('TestMachine'), undefined);
  assert.equal(config.isLocalMachineName('TestMachine'), true);

  // A local-targeted send goes to the local inbox without touching SSH.
  // 4.0.0 (codex review pass 3): legacy `claude-code` lands at the flat
  // legacy path on disk for rolling-upgrade compat.
  const msg = inbox.createMessage(
    'TestMachine', 'TestMachine', 'message', 'mixed', null, 60, 'claude-code', undefined,
  );
  inbox.sendLocalMessage(msg);
  const localPath = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', `${msg.id}.json`);
  assert.equal(JSON.parse(readFileSync(localPath, 'utf8')).id, msg.id);
});

test('getInboxStats reports a healthy shared watcher lease from a tools-only process', async () => {
  const { writeFileSync } = await import('node:fs');
  const locksDir = join(sandbox, '.agent-bridge', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const now = Date.now();
  // 4.0.0 — lease key is `claude-code__<persona>.watcher-lock.json` and
  // the lease's `target` field is `claude-code/<persona>`.
  writeFileSync(
    join(locksDir, 'claude-code__default.watcher-lock.json'),
    JSON.stringify({
      pid: process.pid,
      target: 'claude-code/default',
      role: 'channel-owner',
      token: `test-${now}`,
      startedAt: now,
      updatedAt: now,
    }, null, 2),
    { mode: 0o600 },
  );

  const stats = inbox.getInboxStats();
  assert.equal(stats.watcherBackend, 'polling');
  assert.equal(stats.watcherHealthy, true);
  assert.equal(stats.watcherLeasePid, process.pid);
  assert.equal(stats.watcherLeaseRole, 'channel-owner');
  assert.equal(stats.watcherLeaseAlive, true);
  assert.equal(stats.watcherLeaseFresh, true);
  assert.equal(typeof stats.watcherLeaseAge, 'number');
});
