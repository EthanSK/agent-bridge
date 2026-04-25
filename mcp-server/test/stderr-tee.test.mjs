/**
 * 3.5.5 — persistent stderr tee tests (Patch B mirror).
 *
 * Stderr lines written by the MCP server must be captured into a durable
 * file even when Claude Code closes the diagnostic stderr pipe between turns.
 * Mirrors the Telegram channel plugin's Patch B (server.ts:31-51).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('stderr tee creates a durable file with at least the startup banner', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-3-5-5-stderr-tee-'));
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-3-5-5-stderr',
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_ROLE: 'tools-only',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();

  try {
    await sleep(1_500);
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));

    const stderrLogPath = join(home, '.agent-bridge', 'logs', 'mcp-server-stderr.log');
    assert.ok(existsSync(stderrLogPath), `expected stderr tee file at ${stderrLogPath}`);
    const content = await readFile(stderrLogPath, 'utf8');
    // The logger writes [INFO] lines via console.error (which goes to stderr).
    // We assert that *some* readable content landed in the durable log.
    assert.ok(content.length > 0, 'stderr tee file must not be empty');
    // The startup log line includes "agent-bridge MCP server starting" as a
    // very stable marker. Confirm we captured it.
    assert.ok(
      /agent-bridge MCP server starting/.test(content)
      || /\[INFO\]/.test(content),
      `stderr tee file should contain the startup banner; got: ${content.slice(0, 400)}`,
    );
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('stderr tee wiring is present in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('mcp-server-stderr.log'),
    'durable stderr tee filename must appear in built index.js',
  );
  assert.ok(
    indexSrc.includes('createWriteStream'),
    'stderr tee must use createWriteStream for the durable log',
  );
  assert.ok(
    indexSrc.includes('STDERR_LOG_FILE'),
    'STDERR_LOG_FILE constant must exist',
  );
});
