/**
 * Regression guards for the silent watcher-death path observed in production:
 * stdout/JSON-RPC EPIPE must no longer call process.exit(0) without first
 * writing a durable reason and releasing the watcher lease.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

test('stdout EPIPE exit path logs durable reason and releases watcher lease', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');

  assert.ok(
    indexSrc.includes('stdout.broken_pipe_exit'),
    'stdout broken-pipe handler must emit a durable stdout.broken_pipe_exit event',
  );
  assert.ok(
    indexSrc.includes('mcp-server-sync-exit.log'),
    'fatal exit paths must write a logger-independent synchronous breadcrumb',
  );
  assert.ok(
    indexSrc.includes('fatal_transport_exit.enter'),
    'fatal transport path must breadcrumb entry before logger-dependent work',
  );
  assert.ok(
    indexSrc.includes('fatal_transport_exit.after_stop_watcher'),
    'fatal transport path must breadcrumb after stopWatcher',
  );
  assert.ok(
    indexSrc.includes('fatal_transport_exit.after_shutdown_inbox'),
    'fatal transport path must breadcrumb after shutdownInbox',
  );
  assert.ok(
    indexSrc.includes('process.exit_event'),
    'process exit event must write a synchronous breadcrumb with the exit code',
  );
  assert.ok(
    indexSrc.includes('signal.received'),
    'SIGTERM/SIGINT/SIGHUP handlers must breadcrumb before branch logic',
  );
  assert.ok(
    indexSrc.includes('JSON-RPC/channel transport closed; releasing watcher lease before exit'),
    'stdout broken-pipe event should explain that channel delivery is gone',
  );
  assert.ok(
    indexSrc.includes('stopWatcher();'),
    'fatal transport exit must release the watcher lease before process.exit(0)',
  );
  assert.ok(
    indexSrc.includes('shutdownInbox();'),
    'fatal transport exit must stop inbox/prune state before process.exit(0)',
  );
  assert.ok(
    !indexSrc.includes("if (isBrokenPipe(err))\n        process.exit(0);"),
    'broken-pipe handlers must not silently process.exit(0)',
  );
});
