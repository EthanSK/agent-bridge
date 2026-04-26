/**
 * 3.6.3 — Patch H: no-op MCP tool registration test.
 *
 * Verifies that the `claude_code_channel_status` tool:
 *   1. Is present in the built artifact (source-level guard).
 *   2. Is reported by the MCP server's tools/list response.
 *   3. Returns the expected JSON shape on call (pid, uptime, lease, version,
 *      machine, watcher_active, tool_calls_received_count).
 *
 * Why this matters: Claude Code's plugin host classifies channel-only plugins
 * (no tools registered) as disposable and SIGKILLs them after a few seconds
 * of idle, even when SIGTERM is ignored. Telegram (also a channel plugin)
 * survives 21+ hours through identical lifecycle by registering 4 MCP tools.
 * This test is the regression guard that ensures we keep the no-op tool that
 * mirrors Telegram's effective behaviour.
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

test('3.6.3: source-level — claude_code_channel_status tool registered (Patch H)', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('claude_code_channel_status'),
    'Patch H: claude_code_channel_status tool name must be present in built artifact',
  );
  assert.ok(
    /server\.registerTool\(\s*['"]claude_code_channel_status['"]/.test(indexSrc),
    'Patch H: tool must be registered via server.registerTool(...)',
  );
  // Evidence logging fields (Patch H 3.6.3) — must be wired alongside the tool.
  assert.ok(
    indexSrc.includes('signal.evidence'),
    'Patch H: signal.evidence event must be logged on every signal arrival',
  );
  assert.ok(
    indexSrc.includes('last_notification_at_ms'),
    'Patch H: last_notification_at_ms evidence field must be tracked',
  );
  assert.ok(
    indexSrc.includes('tool_calls_received_count'),
    'Patch H: tool_calls_received_count evidence field must be tracked',
  );
  assert.ok(
    /VERSION\s*=\s*['"]3\.6\.3['"]/.test(indexSrc),
    'version constant must be 3.6.3',
  );
});

test('3.6.3: tools/list reports claude_code_channel_status; tools/call returns expected shape', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-code-channel-tool-'));
  const child = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-claude-code-channel',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_DISABLE_PATCH_G: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();

  // JSON-RPC framing: read newline-delimited JSON from stdout.
  let buffer = '';
  const responses = new Map(); // id → response
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id !== 'undefined') {
          responses.set(parsed.id, parsed);
        }
      } catch {
        // ignore non-JSON or partial frames
      }
    }
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function waitForResponse(id, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (responses.has(id)) return responses.get(id);
      await sleep(50);
    }
    throw new Error(`timeout waiting for response id=${id}`);
  }

  try {
    // Initialize handshake first.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tool-registration-test', version: '1.0' },
      },
    });
    const initResp = await waitForResponse(1);
    assert.equal(initResp.jsonrpc, '2.0', 'init response is JSON-RPC 2.0');
    assert.ok(initResp.result, `init must return a result, got: ${JSON.stringify(initResp)}`);

    // Send the post-init "initialized" notification per MCP spec.
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(200);

    // tools/list
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listResp = await waitForResponse(2);
    assert.ok(listResp.result, `tools/list must return a result, got: ${JSON.stringify(listResp)}`);
    const tools = listResp.result.tools ?? [];
    const found = tools.find((t) => t.name === 'claude_code_channel_status');
    assert.ok(
      found,
      `tools/list must include claude_code_channel_status; got: ${JSON.stringify(tools.map((t) => t.name))}`,
    );

    // tools/call
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'claude_code_channel_status', arguments: {} },
    });
    const callResp = await waitForResponse(3);
    assert.ok(callResp.result, `tools/call must return a result, got: ${JSON.stringify(callResp)}`);
    const content = callResp.result.content ?? [];
    assert.ok(content.length > 0, 'tool result must have content');
    const text = content[0]?.text;
    assert.ok(typeof text === 'string', 'tool result content[0].text must be a string');
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed.pid, 'number', 'status.pid is a number');
    assert.equal(parsed.pid, child.pid, 'status.pid matches the plugin child pid');
    assert.equal(typeof parsed.uptime_s, 'number', 'status.uptime_s is a number');
    assert.equal(parsed.version, '3.6.3', 'status.version is 3.6.3');
    assert.equal(typeof parsed.machine, 'string', 'status.machine is a string');
    assert.equal(parsed.machine, 'test-claude-code-channel', 'status.machine reflects env override');
    assert.equal(typeof parsed.watcher_active, 'boolean', 'status.watcher_active is boolean');
    // After at least one call, the count must be >= 1.
    assert.ok(
      parsed.tool_calls_received_count >= 1,
      `tool_calls_received_count must be >= 1 after one call, got ${parsed.tool_calls_received_count}`,
    );
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
