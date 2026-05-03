import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, 'watcher-standby-worker.mjs');
// 4.0.0 — lease key is `claude-code__<persona>.watcher-lock.json`. The
// standby-worker.mjs spawns startWatcher() directly without calling
// `setActivePersona`, so the active target is the default-persona one.
const leasePath = (home) => join(home, '.agent-bridge', 'locks', 'claude-code__default.watcher-lock.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  if (lastErr) throw lastErr;
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function readLease(home) {
  return JSON.parse(await readFile(leasePath(home), 'utf8'));
}

function startWorker(home, label) {
  const child = spawn(process.execPath, [workerPath, label], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: `test-${label}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.resume();
  return { child, get stderr() { return stderr; } };
}

test('standby Claude watcher promotes itself after active lease owner dies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-watcher-standby-'));
  const owner = startWorker(home, 'owner');
  let standby;

  try {
    const initial = await waitFor(async () => {
      if (!existsSync(leasePath(home))) return null;
      const lease = await readLease(home);
      return lease?.pid === owner.child.pid ? lease : null;
    });
    standby = startWorker(home, 'standby');
    await sleep(300);
    assert.equal((await readLease(home)).pid, owner.child.pid);
    assert.equal(initial.role, 'channel-owner');

    owner.child.kill('SIGKILL');
    await waitFor(() => owner.child.exitCode !== null || owner.child.killed, 4_000);

    const promoted = await waitFor(async () => {
      const lease = await readLease(home);
      return lease?.pid === standby.child.pid ? lease : null;
    }, 8_000);

    assert.equal(promoted.role, 'channel-owner');
    assert.notEqual(promoted.token, initial.token);
  } finally {
    owner.child.kill('SIGKILL');
    standby?.child.kill('SIGKILL');
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
