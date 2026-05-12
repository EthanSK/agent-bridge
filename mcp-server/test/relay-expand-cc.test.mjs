/**
 * Source-level test that verifies the CC mcp-server inbound-channel handler
 * is wired to populate the shared relay-expand store and pass the allocated
 * expandId into the relay scaffold. Mirrors OC's behavior so the
 * `agent-bridge relay-expand <id>` CLI verb works against CC-emitted relays.
 *
 * Added 2026-05-12 with agent-bridge 4.7.1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('CC index.ts imports storeRelayExpandMessage from the shared lib', () => {
  const indexSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'index.ts'),
    'utf8',
  );
  assert.ok(
    indexSrc.includes(
      "import { storeRelayExpandMessage } from './relay-expand-store.js';",
    ),
    "mcp-server/src/index.ts must import storeRelayExpandMessage from './relay-expand-store.js'",
  );
});

test('CC mcp-server has a relay-expand-store re-export shim pointing at lib/', () => {
  const shimSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'relay-expand-store.ts'),
    'utf8',
  );
  assert.ok(
    shimSrc.includes("from '../../lib/relay-expand-store.js'"),
    'relay-expand-store.ts must re-export from the shared lib path',
  );
  assert.ok(
    shimSrc.includes('storeRelayExpandMessage'),
    'shim must re-export storeRelayExpandMessage',
  );
  assert.ok(
    shimSrc.includes('readRelayExpandEntry'),
    'shim must re-export readRelayExpandEntry',
  );
});

test('CC inbound handler stores BridgeMessage in relay-expand and threads expandId into the scaffold', () => {
  const indexSrc = readFileSync(
    resolve(__dirname, '..', 'src', 'index.ts'),
    'utf8',
  );
  assert.ok(
    indexSrc.includes('storeRelayExpandMessage('),
    'inbound handler must call storeRelayExpandMessage()',
  );
  assert.ok(
    /expandId\s*=\s*record\?\.expandId/.test(indexSrc),
    'inbound handler must read expandId from the store record',
  );
  assert.ok(
    /\.\.\.\(expandId\s*\?\s*\{\s*expandId\s*\}\s*:\s*\{\}\)/.test(indexSrc),
    'formatRelayScaffold opts must spread { expandId } when populated',
  );
  assert.ok(
    /\.\.\.\(expandId\s*\?\s*\{\s*expand_id:\s*expandId\s*\}\s*:\s*\{\}\)/.test(
      indexSrc,
    ),
    'channel notification meta must include expand_id when populated',
  );
});

test('lib/relay-expand-store.js exposes the canonical API consumed by both harnesses', async () => {
  const repoRoot = resolve(__dirname, '..', '..');
  const mod = await import(
    /* @vite-ignore */ `file://${resolve(repoRoot, 'lib', 'relay-expand-store.js')}`
  );
  assert.equal(typeof mod.storeRelayExpandMessage, 'function');
  assert.equal(typeof mod.readRelayExpandEntry, 'function');
  assert.equal(typeof mod.formatRelayExpandEntry, 'function');
  assert.equal(typeof mod.normalizeExpandId, 'function');
  assert.equal(typeof mod.defaultRelayExpandDir, 'function');
  assert.equal(typeof mod.defaultRelayExpandStorePath, 'function');
});

test('openclaw-channel relay-expand-store is a re-export shim onto lib/', () => {
  const repoRoot = resolve(__dirname, '..', '..');
  const shimSrc = readFileSync(
    resolve(repoRoot, 'openclaw-channel', 'src', 'relay-expand-store.js'),
    'utf8',
  );
  assert.ok(
    shimSrc.includes('../../lib/relay-expand-store.js'),
    'openclaw-channel shim must re-export from lib/',
  );
});
