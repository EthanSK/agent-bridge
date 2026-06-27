// Tests for the bridge_notify quoting + remote-command building (4.8.0+).
//
// Background: bridge_notify renders a native banner LOCALLY in-process, or
// REMOTELY by SSHing the target and running ITS own `agent-bridge notify
// --local …`. The remote command is a single shell string re-parsed by the
// remote shell, so every free-form field (title/message/subtitle/sound/group)
// MUST be shell-quoted. shellQuoteForSsh is the TS equivalent of bash
// `printf '%q'`. These tests pin:
//   • shellQuoteForSsh handles spaces, quotes, $, backticks, empty string
//   • shellQuoteForSsh output round-trips through a real shell to the original
//   • buildRemoteNotifyCommand only emits optional flags when set, and the
//     emitted command parses back to the original field values via a shell
//
// Run with `npm test` (after `npm run build`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const notify = await import('../build/notify.js');

// Helper: ask a real /bin/sh to echo back a single quoted token so we can
// confirm our quoting decodes to exactly the original string.
function shellDecodeSingle(quoted) {
  // `printf %s` avoids trailing newline; we wrap in a tiny script that echoes
  // the single argument the quoting expands to.
  const out = execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`]);
  return out.toString('utf8');
}

test('shellQuoteForSsh empty string', () => {
  assert.equal(notify.shellQuoteForSsh(''), "''");
  assert.equal(shellDecodeSingle(notify.shellQuoteForSsh('')), '');
});

test('shellQuoteForSsh round-trips tricky strings through a real shell', () => {
  const cases = [
    'simple',
    'has spaces here',
    "it's got an apostrophe",
    'double "quotes" inside',
    'cost is $5 and $HOME',
    'backticks `whoami` here',
    'semicolons; and && pipes |',
    'newline\nin\nthe\nmiddle',
    'rm -rf ~ (looks dangerous)',
    'mixed \'single\' and "double" and $VAR and `cmd`',
  ];
  for (const c of cases) {
    const quoted = notify.shellQuoteForSsh(c);
    assert.equal(shellDecodeSingle(quoted), c, `failed for: ${JSON.stringify(c)}`);
  }
});

test('buildRemoteNotifyCommand wraps the inner command with a PATH prepend', () => {
  // The remote command must be wrapped in `sh -c '<export PATH …; inner>'` so
  // the standard install dirs (~/.local/bin, /opt/homebrew/bin) are on PATH on
  // the remote's non-interactive shell (a login shell does NOT help — zsh users
  // set PATH in ~/.zshrc which `sh -lc` never sources).
  const cmd = notify.buildRemoteNotifyCommand({ title: 'T', message: 'M' });
  assert.match(cmd, /^sh -c /);
  assert.ok(cmd.includes('.local/bin'));
  // The inner agent-bridge invocation is inside the quoted -c argument.
  assert.ok(cmd.includes('agent-bridge notify --local --title'));
});

test('buildRemoteNotifyCommand emits only required flags when optional absent', () => {
  const cmd = notify.buildRemoteNotifyCommand({ title: 'T', message: 'M' });
  assert.ok(cmd.includes('--title'));
  assert.ok(cmd.includes('--message'));
  assert.ok(!cmd.includes('--subtitle'));
  assert.ok(!cmd.includes('--sound'));
  assert.ok(!cmd.includes('--group'));
});

test('buildRemoteNotifyCommand emits optional flags when set', () => {
  const cmd = notify.buildRemoteNotifyCommand({
    title: 'T', message: 'M', subtitle: 'S', sound: 'Glass', group: 'g1',
  });
  assert.ok(cmd.includes('--subtitle'));
  assert.ok(cmd.includes('--sound'));
  assert.ok(cmd.includes('--group'));
});

test('buildRemoteNotifyCommand quoting survives the full remote shell + login wrap', async () => {
  // Build a command with a hostile title/message, then EXECUTE the full
  // remote command string (including the `sh -lc` login wrap) with a stubbed
  // `agent-bridge` on PATH that echoes its args. This is the most faithful
  // test: it proves the value survives BOTH the outer SSH-command tokenization
  // AND the inner `sh -lc` re-parse, arriving at agent-bridge verbatim.
  const title = 'Done; rm -rf ~';
  const message = 'cost "$5" `oops`';
  const cmd = notify.buildRemoteNotifyCommand({ title, message });

  // Create a temp dir with a stub `agent-bridge` that prints each arg on a line.
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const stub = join(dir, 'agent-bridge');
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);

  // Run the built command with the stub dir prepended to PATH.
  const out = execFileSync('/bin/sh', ['-c', cmd], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
    .toString('utf8')
    .split('\n');

  const ti = out.indexOf('--title');
  const mi = out.indexOf('--message');
  assert.ok(ti >= 0 && mi >= 0, `args were: ${JSON.stringify(out)}`);
  assert.equal(out[ti + 1], title);
  assert.equal(out[mi + 1], message);
});
