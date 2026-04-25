/**
 * 3.5.5 — notification.push_failed event shape test.
 *
 * The deliberate notification.push_failed event must be emitted with:
 *   - event: 'notification.push_failed'
 *   - level: 'error'
 *   - context.decision === 'leave_pending_for_next_owner'
 *
 * This makes the post-mortem chain unambiguous about WHY a file is left
 * pending after a channel notification rejection (so the next live
 * channel-owner / replay scan picks it up).
 *
 * We assert the wiring at source level rather than orchestrating an MCP
 * notification rejection end-to-end, because reliably forcing a rejection
 * requires installing a callback that throws — which would mean shipping a
 * test-only escape hatch into watcher.ts. The source-level guard is the
 * same pattern already used by stdout-broken-pipe.test.mjs and the sibling
 * detection check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watcherBuiltPath = join(__dirname, '..', 'build', 'watcher.js');
const indexBuiltPath = join(__dirname, '..', 'build', 'index.js');

test('notification.push_failed event with decision=leave_pending_for_next_owner is wired in watcher.js', async () => {
  const watcherSrc = await readFile(watcherBuiltPath, 'utf8');
  assert.ok(
    watcherSrc.includes("event: 'notification.push_failed'"),
    'notification.push_failed event must be emitted in watcher.js',
  );
  assert.ok(
    watcherSrc.includes("decision: 'leave_pending_for_next_owner'"),
    'notification.push_failed must include decision=leave_pending_for_next_owner',
  );
  assert.ok(
    /level:\s*'error'/.test(watcherSrc),
    'notification.push_failed must be logged at error level',
  );
  // Sanity: the failure log line and the decision string are co-located in
  // the same module, proving the new event is part of the failure path.
  const failureLogIdx = watcherSrc.indexOf('Channel: notification callback failed');
  const decisionIdx = watcherSrc.indexOf('leave_pending_for_next_owner');
  assert.ok(failureLogIdx >= 0, 'expected channel notification callback failure log line');
  assert.ok(decisionIdx > failureLogIdx, 'decision marker must follow the failure log line in source order');
});

test('index.js push_failed log carries decision=leave_pending_for_next_owner for back-compat', async () => {
  const indexSrc = await readFile(indexBuiltPath, 'utf8');
  // The legacy message.push_failed event in index.ts is preserved for any
  // log consumers from 3.5.4 and earlier, but should now also carry the
  // deliberate decision string.
  assert.ok(
    indexSrc.includes("event: 'message.push_failed'"),
    'legacy message.push_failed event must remain wired in index.js',
  );
  // Find the message.push_failed block and assert decision appears in it.
  const idx = indexSrc.indexOf("event: 'message.push_failed'");
  assert.ok(idx > 0, 'message.push_failed block found');
  const block = indexSrc.slice(idx, idx + 800);
  assert.ok(
    block.includes('leave_pending_for_next_owner'),
    'message.push_failed must include decision=leave_pending_for_next_owner',
  );
});
