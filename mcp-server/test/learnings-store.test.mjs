// Tests for the SHARED CONTEXT learnings store (4.9.0+).
//
// Covers the TS half of the mirrored bash/TS implementation pair
// (mcp-server/src/learnings.ts ↔ `agent-bridge learnings` CLI verbs — the
// CLI half is pinned by test/cli-learnings.sh at the repo root):
//   • createLearningEntry: lowercase uuid id, tag normalization, scope=global
//   • appendLearningLocal: append + dedupe-by-id (replication idempotency)
//   • readLearnings: corrupt lines are skipped, never fatal
//   • searchLearnings: substring match, tag filter, newest-first, limit
//   • buildRemoteIngestCommand: hostile free-form body survives the SSH
//     command string — executed against a REAL shell with a stubbed
//     agent-bridge binary, same parity approach as notify-quoting.test.mjs
//
// Run with `npm test` (after `npm run build`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Sandbox HOME BEFORE importing the built module: config.ts computes
// BRIDGE_DIR from os.homedir() at import time, and os.homedir() reads $HOME.
const SANDBOX = mkdtempSync(join(tmpdir(), 'ab-learnings-'));
process.env.HOME = SANDBOX;
process.env.AGENT_BRIDGE_MACHINE_NAME = 'TestHost';

const learnings = await import('../build/learnings.js');

test('createLearningEntry: lowercase id, normalized tags, scope=global', () => {
  const e = learnings.createLearningEntry({
    title: '  Title here  ',
    body: 'body text',
    tags: [' VPN ', 'macos', 'vpn', ''],
    harness: 'claude-code/default',
  });
  assert.equal(e.id, e.id.toLowerCase(), 'id must be lowercase (bridge id convention)');
  assert.match(e.id, /^[0-9a-f-]{36}$/, 'id is a uuid');
  assert.equal(e.title, 'Title here');
  assert.deepEqual(e.tags, ['vpn', 'macos'], 'tags lowercased, trimmed, deduped, empty dropped');
  assert.equal(e.scope, 'global');
  assert.equal(e.v, 1);
  assert.equal(e.machine, 'TestHost');
  assert.equal(e.harness, 'claude-code/default');
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'second-precision ISO ts (matches bash date -u +%FT%TZ)');
});

test('appendLearningLocal: appends once, dedupes by id on replay', () => {
  const e = learnings.createLearningEntry({ title: 'dedupe test', body: 'b' });
  assert.equal(learnings.appendLearningLocal(e), true, 'first append writes');
  assert.equal(learnings.appendLearningLocal(e), false, 'replay is a no-op (idempotent replication)');
  const lines = readFileSync(learnings.learningsFilePath(), 'utf8').trim().split('\n');
  const matching = lines.filter(l => l.includes(e.id));
  assert.equal(matching.length, 1, 'exactly one stored copy');
});

test('readLearnings: corrupt lines are skipped, not fatal', () => {
  // Inject garbage between valid entries — a half-written line from a crashed
  // writer must never brick the store.
  appendFileSync(learnings.learningsFilePath(), 'NOT JSON AT ALL\n{"id": "trunc\n', 'utf8');
  const ok = learnings.createLearningEntry({ title: 'after corruption', body: 'b' });
  assert.equal(learnings.appendLearningLocal(ok), true);
  const all = learnings.readLearnings();
  assert.ok(all.some(e => e.id === ok.id), 'valid entries still readable');
  assert.ok(all.every(e => typeof e.id === 'string' && e.id !== ''), 'no garbage entries surfaced');
});

test('searchLearnings: substring across title/body/tags, tag filter, newest-first, limit', () => {
  const a = learnings.createLearningEntry({ title: 'Surfshark IKEv2 dialog loop', body: 'switch to WireGuard', tags: ['vpn', 'macos'] });
  const b = learnings.createLearningEntry({ title: 'Codex GUI recipe', body: 'osascript AX actions, never raw coordinates', tags: ['codex', 'macos'] });
  assert.equal(learnings.appendLearningLocal(a), true);
  assert.equal(learnings.appendLearningLocal(b), true);

  // Body substring, case-insensitive.
  const byBody = learnings.searchLearnings({ query: 'WIREGUARD' });
  assert.equal(byBody.length, 1);
  assert.equal(byBody[0].id, a.id);

  // Tag-term matches via the haystack too.
  const byTagWord = learnings.searchLearnings({ query: 'codex' });
  assert.ok(byTagWord.some(e => e.id === b.id));

  // Exact tag filter narrows to both macos entries; newest (b) comes first.
  const byTag = learnings.searchLearnings({ tag: 'macos' });
  assert.ok(byTag.length >= 2);
  assert.ok(byTag.findIndex(e => e.id === b.id) < byTag.findIndex(e => e.id === a.id), 'newest first');

  // Limit applies after newest-first ordering.
  const limited = learnings.searchLearnings({ limit: 1 });
  assert.equal(limited.length, 1);

  // No match → empty, not an error.
  assert.deepEqual(learnings.searchLearnings({ query: 'zzz-no-such-thing-zzz' }), []);
});

test('buildRemoteIngestCommand: hostile body survives a REAL shell round-trip', () => {
  // The entry JSON is free-form agent text re-parsed by the REMOTE shell —
  // the single most important correctness detail (same as notify). We verify
  // by actually EXECUTING the built command with a stubbed `agent-bridge` at
  // $HOME/.local/bin (which the command's PATH-prepend puts first) and
  // asserting the stub received the JSON byte-identical.
  const entry = learnings.createLearningEntry({
    title: `Done; rm -rf ~ 'quotes' "double" $HOME \`backtick\``,
    body: 'line1\nline2 with $vars and 100% weird — em dash',
    tags: ['hostile'],
  });
  const stubDir = join(SANDBOX, '.local', 'bin');
  mkdirSync(stubDir, { recursive: true });
  const argsFile = join(SANDBOX, 'stub-args.json');
  // Stub prints its argv as JSON so we can compare precisely.
  writeFileSync(
    join(stubDir, 'agent-bridge'),
    `#!/bin/sh\nprintf '%s' "$4" > ${JSON.stringify(argsFile)}\n[ "$1" = learnings ] && [ "$2" = ingest ] && [ "$3" = --json ] || exit 9\n`,
    'utf8',
  );
  chmodSync(join(stubDir, 'agent-bridge'), 0o755);

  const cmd = learnings.buildRemoteIngestCommand(entry);
  // Execute exactly like the remote sshd would: hand the string to a shell.
  execFileSync('/bin/sh', ['-c', cmd], { env: { ...process.env, HOME: SANDBOX } });

  const received = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.deepEqual(received, entry, 'entry JSON arrived byte-identical through the shell');
});

test('formatLearning: renders title, provenance line, indented body', () => {
  const e = learnings.createLearningEntry({ title: 'T', body: 'b1\nb2', tags: ['x'] });
  const out = learnings.formatLearning(e);
  assert.ok(out.startsWith('— T\n'), 'title first');
  assert.ok(out.includes(`id: ${e.id}`), 'id shown');
  assert.ok(out.includes('  b1\n  b2'), 'body indented');
  assert.ok(out.includes('tags: x'), 'tags shown');
});
