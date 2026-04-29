import test from 'node:test';
import assert from 'node:assert/strict';

const config = await import('../build/config.js');

test('parseConfigContent accepts identity_file-only peers', () => {
  const machines = config.parseConfigContent([
    '[WinPeer]',
    'host=192.0.2.10',
    'user=ethan',
    'port=22',
    'identity_file=/bridge/identity',
    'paired_at=2026-04-29T00:00:00Z',
    '',
  ].join('\n'));

  assert.equal(machines.length, 1);
  assert.equal(machines[0].key, '/bridge/identity');
  assert.equal(machines[0].identityFile, '/bridge/identity');
});

test('parseConfigContent keeps legacy key but prefers explicit identity_file field', () => {
  const machines = config.parseConfigContent([
    '[WinPeer]',
    'host=192.0.2.10',
    'user=ethan',
    'port=22',
    'key=/legacy/key',
    'identity_file=/bridge/identity',
    'paired_at=2026-04-29T00:00:00Z',
    '',
  ].join('\n'));

  assert.equal(machines.length, 1);
  assert.equal(machines[0].key, '/legacy/key');
  assert.equal(machines[0].identityFile, '/bridge/identity');
});
