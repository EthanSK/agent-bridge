// Tests for the SFTP-based cross-platform send path (3.8.1+).
//
// Background: in 3.8.0 and earlier, sshWriteFile shelled into the remote with
// a POSIX pipeline (`dest=...; mkdir -p "$dir"; ... mv -f "$tmp" "$dest"`).
// That broke against Windows OpenSSH-server because cmd.exe doesn't know
// `dest`, `mkdir -p`, or `mv`. 3.8.1 switches to the SFTP subsystem (no
// remote shell) and atomic put-then-rename. These tests pin the pure-function
// helpers that drive batch construction.
//
// Run with `npm test` (after `npm run build`).
import test from 'node:test';
import assert from 'node:assert/strict';

const ssh = await import('../build/ssh.js');

test('normalizeSftpPath strips ~/ prefix (Windows OpenSSH-sftp does not expand ~)', () => {
  assert.equal(
    ssh.normalizeSftpPath('~/.agent-bridge/inbox/claude-code/m1.json'),
    '.agent-bridge/inbox/claude-code/m1.json',
  );
});

test('normalizeSftpPath leaves bare ~ as cwd marker', () => {
  assert.equal(ssh.normalizeSftpPath('~'), '.');
});

test('normalizeSftpPath leaves absolute paths alone', () => {
  assert.equal(
    ssh.normalizeSftpPath('/Users/foo/.agent-bridge/inbox/claude-code/m1.json'),
    '/Users/foo/.agent-bridge/inbox/claude-code/m1.json',
  );
});

test('normalizeSftpPath leaves relative paths alone', () => {
  assert.equal(
    ssh.normalizeSftpPath('.agent-bridge/inbox/claude-code/m1.json'),
    '.agent-bridge/inbox/claude-code/m1.json',
  );
});

test('sftpParentDirs walks the directory chain (relative)', () => {
  assert.deepEqual(
    ssh.sftpParentDirs('.agent-bridge/inbox/claude-code/m1.json'),
    ['.agent-bridge', '.agent-bridge/inbox', '.agent-bridge/inbox/claude-code'],
  );
});

test('sftpParentDirs walks multi-segment targets like openclaw/<account>', () => {
  assert.deepEqual(
    ssh.sftpParentDirs('.agent-bridge/inbox/openclaw/clawdiboi2/m1.json'),
    [
      '.agent-bridge',
      '.agent-bridge/inbox',
      '.agent-bridge/inbox/openclaw',
      '.agent-bridge/inbox/openclaw/clawdiboi2',
    ],
  );
});

test('sftpParentDirs returns empty list when file lives at session cwd', () => {
  assert.deepEqual(ssh.sftpParentDirs('m1.json'), []);
});

test('sftpParentDirs handles absolute paths', () => {
  assert.deepEqual(
    ssh.sftpParentDirs('/Users/foo/.agent-bridge/inbox/claude-code/m1.json'),
    [
      '/Users',
      '/Users/foo',
      '/Users/foo/.agent-bridge',
      '/Users/foo/.agent-bridge/inbox',
      '/Users/foo/.agent-bridge/inbox/claude-code',
    ],
  );
});

test('buildSftpBatch emits -mkdir for each ancestor, put, rename, bye', () => {
  const batch = ssh.buildSftpBatch(
    '/local/payload.json',
    '.agent-bridge/inbox/claude-code/m1.json.tmp.abc',
    '.agent-bridge/inbox/claude-code/m1.json',
  );
  const lines = batch.trim().split('\n');
  assert.deepEqual(lines, [
    '-mkdir ".agent-bridge"',
    '-mkdir ".agent-bridge/inbox"',
    '-mkdir ".agent-bridge/inbox/claude-code"',
    'put "/local/payload.json" ".agent-bridge/inbox/claude-code/m1.json.tmp.abc"',
    'rename ".agent-bridge/inbox/claude-code/m1.json.tmp.abc" ".agent-bridge/inbox/claude-code/m1.json"',
    'bye',
  ]);
});

test('buildSftpBatch trailing newline so sftp -b - flushes the last command', () => {
  const batch = ssh.buildSftpBatch('/l', 'r.tmp', 'r');
  assert.equal(batch.endsWith('\n'), true);
});

test('buildSftpGetBatch downloads via SFTP get without remote shell', () => {
  assert.equal(
    ssh.buildSftpGetBatch('.agent-bridge/inbox/m1.json', '/tmp/local m1.json'),
    'get ".agent-bridge/inbox/m1.json" "/tmp/local m1.json"\nbye\n',
  );
});

test('buildSftpListBatch lists via SFTP ls without remote shell redirection', () => {
  assert.equal(
    ssh.buildSftpListBatch('.agent-bridge/inbox/claude-code'),
    'ls -1 ".agent-bridge/inbox/claude-code"\nbye\n',
  );
});

test('buildSftpBatch produces no shell-mode constructs ($, &&, |, mv, mkdir -p)', () => {
  const batch = ssh.buildSftpBatch(
    '/local/payload.json',
    '.agent-bridge/inbox/claude-code/m1.json.tmp.abc',
    '.agent-bridge/inbox/claude-code/m1.json',
  );
  // Sanity: the regression we're guarding against is reintroducing a POSIX
  // shell pipeline that breaks on Windows cmd.exe. None of these tokens
  // should appear in an SFTP batch script.
  for (const banned of ['$', '&&', '||', 'mv -f', 'mkdir -p', 'cat ', 'echo ', 'base64']) {
    assert.equal(
      batch.includes(banned),
      false,
      `SFTP batch must not contain shell construct ${JSON.stringify(banned)}; got:\n${batch}`,
    );
  }
});
