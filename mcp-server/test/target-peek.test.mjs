import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'ab-target-peek-'));
mkdirSync(join(sandbox, '.agent-bridge'), { recursive: true });
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestMachine';
process.env.AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG = '1';
process.env.AGENT_BRIDGE_DISABLE_PARENT_CHECK = '1';
process.env.AGENT_BRIDGE_DISABLE_PATCH_F = '1';

const inbox = await import('../build/inbox.js');

test.after(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

function writeMessage(dir, msg) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${msg.id}.json`), JSON.stringify(msg, null, 2), { mode: 0o600 });
}

function message(id, content, overrides = {}) {
  return {
    id,
    from: 'MacBook',
    to: 'MacMini',
    type: 'message',
    content,
    timestamp: overrides.timestamp ?? new Date('2026-05-24T12:00:00.000Z').toISOString(),
    replyTo: overrides.replyTo ?? null,
    target: overrides.target ?? 'openclaw/default',
    fromTarget: overrides.fromTarget ?? 'claude-code/default',
  };
}

test('peekInboxForTarget inspects OpenClaw pending/pending-ack/archive without mutating', () => {
  inbox.ensureInboxDirs();
  const target = 'openclaw/default';
  const pendingDir = join(sandbox, '.agent-bridge', 'inbox', 'openclaw', 'default');
  const pendingAckDir = join(sandbox, '.agent-bridge', 'inbox', '.pending-ack', 'openclaw', 'default');
  const archiveDir = join(sandbox, '.agent-bridge', 'inbox', '.archive', 'openclaw', 'default');
  const failedDir = join(sandbox, '.agent-bridge', 'inbox', '.failed', 'openclaw', 'default');

  writeMessage(pendingDir, message('msg-pending', 'pending content', { replyTo: 'msg-origin' }));
  writeMessage(pendingAckDir, message('msg-ack', 'pending ack content', { replyTo: 'msg-origin' }));
  writeMessage(archiveDir, message('msg-archived', 'archived content', { replyTo: 'msg-origin' }));

  // A malformed-by-target file should be reported for diagnostics, but never
  // moved into another harness's failed dir by a peek operation.
  const wrongTarget = message('msg-wrong-target', 'wrong target', { target: 'openclaw/other', replyTo: 'msg-origin' });
  writeMessage(pendingDir, wrongTarget);

  const result = inbox.peekInboxForTarget(target, {
    includePendingAck: true,
    includeArchived: true,
    replyTo: 'msg-origin',
  });

  assert.equal(result.target, target);
  assert.deepEqual(result.pending.map(m => m.id), ['msg-pending']);
  assert.deepEqual(result.pendingAck.map(m => m.id), ['msg-ack']);
  assert.deepEqual(result.archived.map(m => m.id), ['msg-archived']);
  assert.equal(result.parseErrors.length, 1);
  assert.ok(result.parseErrors[0].includes('msg-wrong-target.json'));
  assert.ok(existsSync(join(pendingDir, 'msg-wrong-target.json')), 'target peek must not move foreign harness files');
  assert.equal(existsSync(failedDir), false, 'target peek must not create a failed dir for another harness');
});

test('peekInboxForTarget applies per-section newest limit', () => {
  const target = 'openclaw/clawdiboi2';
  const pendingDir = join(sandbox, '.agent-bridge', 'inbox', 'openclaw', 'clawdiboi2');
  writeMessage(pendingDir, message('msg-old', 'old', {
    target,
    timestamp: new Date('2026-05-24T12:00:00.000Z').toISOString(),
  }));
  writeMessage(pendingDir, message('msg-new', 'new', {
    target,
    timestamp: new Date('2026-05-24T12:01:00.000Z').toISOString(),
  }));

  const result = inbox.peekInboxForTarget(target, { limit: 1 });
  assert.deepEqual(result.pending.map(m => m.id), ['msg-new']);
});

test('peekInboxForTarget accepts legacy claude-code target under default persona dir', () => {
  const target = 'claude-code/default';
  const pendingDir = join(sandbox, '.agent-bridge', 'inbox', 'claude-code', 'default');
  writeMessage(pendingDir, message('msg-legacy-claude', 'legacy target', { target: 'claude-code' }));

  const result = inbox.peekInboxForTarget(target);
  assert.ok(result.pending.some(m => m.id === 'msg-legacy-claude'));
});
