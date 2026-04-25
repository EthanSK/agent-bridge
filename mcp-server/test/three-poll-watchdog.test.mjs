/**
 * 3.5.5 — 3-poll orphan-watchdog confirmation tests.
 *
 * Telegram-pattern lifecycle polish (Patch A mirror, server.ts:711-737):
 *   - A SINGLE failed kill(parentPid, 0) ESRCH must NOT trigger shutdown.
 *   - 3 CONSECUTIVE failed polls (≈15s at 5s polling) MUST trigger shutdown.
 *   - Reset counter on any clean poll.
 *
 * We can't reach into the running interval to inject ESRCHs, so this test
 * suite combines:
 *   1. A live-process source-level guard (the constants and event names must
 *      exist in the shipped build).
 *   2. A live-process behavioural test that verifies a freshly-orphaned stdin
 *      (which trips stdin.readableEnded / stdin.destroyed in the SAME watchdog)
 *      requires more than one poll to terminate the child, and produces the
 *      orphan_poll log entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

function startServer(home, env = {}) {
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-3-5-5',
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_ROLE: 'tools-only',
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
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('3-poll watchdog wiring is present in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('ORPHAN_CONFIRMATION_POLLS'),
    'ORPHAN_CONFIRMATION_POLLS constant must exist',
  );
  assert.ok(
    /ORPHAN_CONFIRMATION_POLLS\s*=\s*3/.test(indexSrc),
    'orphan confirmation polls must be set to 3 (Patch A)',
  );
  assert.ok(
    indexSrc.includes("event: 'parent.orphan_poll'"),
    'parent.orphan_poll log event must be wired',
  );
  assert.ok(
    indexSrc.includes("event: 'parent.orphan_recovered'"),
    'parent.orphan_recovered reset event must be wired',
  );
  assert.ok(
    indexSrc.includes('orphan-watchdog:'),
    'shutdown reason should carry the orphan-watchdog: prefix',
  );
});

test('single stdin-end does NOT trigger immediate shutdown (orphan watchdog requires 3 polls)', { timeout: 20_000 }, async () => {
  // Behavioural confirmation: with the 3-poll gate, a fresh orphaned stdin
  // must not kill the child within the first 5s after stdin.end(). Telegram's
  // Patch A explicitly says "any clean poll resets the counter, so a true
  // reparenting still terminates within ~15s" — we assert the lower bound.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-5-5-no-immediate-'));
  const server = startServer(home, {
    AGENT_BRIDGE_ROLE: 'channel-owner',
    AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT: '1',
  });
  try {
    await sleep(800);
    server.stdin.end();
    // Observe state at 5s (one poll in) — the child MUST still be alive.
    await sleep(5_000);
    assert.equal(server.exitCode, null, 'child must not have exited after a single orphan poll');

    // Now wait the rest of the way (up to 25s total) — child should exit.
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', () => resolve(true))),
      sleep(20_000).then(() => false),
    ]);
    assert.ok(exited, 'child must exit after 3 confirmed polls (~15s)');

    // Verify the log carries the orphan_poll progression.
    const events = await readEvents(home);
    const polls = events.filter((e) => e.event === 'parent.orphan_poll');
    assert.ok(
      polls.length >= 3,
      `expected at least 3 parent.orphan_poll events, got ${polls.length}`,
    );
    // Final poll number should be >= 3 (confirmation reached).
    const finalPoll = polls[polls.length - 1];
    assert.ok(
      typeof finalPoll.context.poll === 'number' && finalPoll.context.poll >= 3,
      'final orphan poll must be >= 3 (confirmation count reached)',
    );
    assert.equal(
      finalPoll.context.confirmation_polls,
      3,
      'confirmation_polls field must be 3',
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
