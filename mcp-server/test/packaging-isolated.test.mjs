/**
 * 4.10.0 [CODEX-CHANNEL] — marketplace/cache artifact isolation proof.
 *
 * The Claude plugin cache contains ONLY the mcp-server directory. This test
 * copies exactly that payload (package.json + build/ + node_modules/) into an
 * isolated directory with NO codex-channel and NO repo, starts the server on
 * real stdio, performs the MCP initialize handshake + tools/list, and then
 * calls a codex tool to prove graceful degradation:
 *
 *   - the server MUST start and register every tool (existing Claude/OpenClaw
 *     tools never fail to load because Codex support is absent), and
 *   - codex tool HANDLERS return an actionable error instead of crashing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeIsolatedServer() {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-pack-"));
  const artifact = join(root, "cache", "mcp-server");
  mkdirSync(artifact, { recursive: true });
  cpSync(join(mcpRoot, "package.json"), join(artifact, "package.json"));
  cpSync(join(mcpRoot, "build"), join(artifact, "build"), { recursive: true });
  cpSync(join(mcpRoot, "vendor"), join(artifact, "vendor"), { recursive: true });
  cpSync(join(mcpRoot, "node_modules"), join(artifact, "node_modules"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    AGENT_BRIDGE_MACHINE_NAME: "Isolated-MCP",
  };
  return { artifact, env, home, root };
}

/** Minimal line-delimited MCP stdio client. */
function mcpExchange(artifact, env, requests, { timeoutMs = 25_000, settleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(artifact, "build", "index.js")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map();
    let buffer = "";
    let stderrTail = "";
    let completionScheduled = false;
    const wanted = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));
    const timer = setTimeout(() => {
      finish(new Error(`MCP exchange timed out; got ids [${[...responses.keys()]}], stderr: ${stderrTail.slice(-500)}`));
    }, timeoutMs);
    const finish = (err) => {
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve({ responses, stderrTail });
    };
    child.stderr.on("data", (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            responses.set(msg.id, msg);
            wanted.delete(msg.id);
            if (wanted.size === 0 && !completionScheduled) {
              completionScheduled = true;
              if (settleMs > 0) setTimeout(() => finish(null), settleMs);
              else finish(null);
            }
          }
        } catch { /* non-JSON stdout noise is ignored */ }
      }
    });
    child.once("error", (err) => finish(err));
    child.once("exit", (code) => {
      if (wanted.size > 0) finish(new Error(`server exited early (code ${code}); stderr: ${stderrTail.slice(-500)}`));
    });
    for (const req of requests) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...req })}\n`);
    }
  });
}

test("isolated mcp-server artifact (NO codex-channel): initializes, lists ALL tools, codex handlers degrade actionably", async () => {
  const { artifact, env } = makeIsolatedServer();
  assert.equal(existsSync(join(artifact, "..", "..", "codex-channel")), false, "isolation precondition");

  const { responses } = await mcpExchange(artifact, env, [
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packaging-test", version: "0.0.0" },
      },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list", params: {} },
    { id: 3, method: "tools/call", params: { name: "bridge_codex_status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "bridge_send_message", arguments: {
      machine: "local", message: "bad target", target: "bad//target",
    } } },
    { id: 5, method: "tools/call", params: { name: "bridge_send_message", arguments: {
      machine: "local", message: "bad sender", target: "openclaw/default", from_target: "../sender",
    } } },
  ]);

  const init = responses.get(1);
  assert.ok(init?.result?.serverInfo?.name, "initialize succeeded");

  const listedTools = responses.get(2)?.result?.tools ?? [];
  const tools = listedTools.map((t) => t.name);
  for (const required of [
    "bridge_send_message",
    "bridge_receive_messages",
    "bridge_list_machines",
    "bridge_status",
    "bridge_run_command",
    "bridge_clear_inbox",
    "bridge_inbox_stats",
    "bridge_notify",
    "bridge_learnings_add",
    "bridge_learnings_search",
    "bridge_codex_bind",
    "bridge_codex_unbind",
    "bridge_codex_status",
  ]) {
    assert.ok(tools.includes(required), `tool ${required} must register in the isolated artifact (got: ${tools.join(", ")})`);
  }

  const sendTool = listedTools.find((tool) => tool.name === "bridge_send_message");
  assert.match(sendTool?.description ?? "", /codex\/<alias>/, "tool description advertises bound Codex targets");
  assert.match(
    sendTool?.inputSchema?.properties?.target?.description ?? "",
    /codex\/<alias>/,
    "field-level target schema advertises bound Codex targets",
  );
  const bindTool = listedTools.find((tool) => tool.name === "bridge_codex_bind");
  assert.ok(!(bindTool?.inputSchema?.required ?? []).includes("alias"),
    "alias is optional so a current Codex task can opt in with one tool call");
  assert.match(bindTool?.description ?? "", /omit `alias`|automatically/i,
    "bind help advertises automatic task-name aliases");
  assert.match(bindTool?.description ?? "", /prompt authority|user-prompt authority/i,
    "bind help states the paired-sender prompt trust boundary");
  assert.match(bindTool?.description ?? "", /no per-turn tool allowlist|no per-turn tool.*isolation/i,
    "bind help does not imply unavailable Codex 0.145 tool isolation");

  const codexCall = responses.get(3);
  assert.equal(codexCall?.result?.isError, true, "codex handler degrades with an error result, not a crash");
  const text = codexCall?.result?.content?.[0]?.text ?? "";
  assert.match(text, /codex-channel runtime not found/i);
  assert.match(text, /AGENT_BRIDGE_SOURCE_DIR/, "error is actionable");

  const invalidTarget = responses.get(4)?.result?.content?.[0]?.text ?? "";
  assert.match(invalidTarget, /codex\/<alias>/, "invalid target help names the Codex form");
  const invalidFromTarget = responses.get(5)?.result?.content?.[0]?.text ?? "";
  assert.match(invalidFromTarget, /codex\/<alias>/, "invalid from_target help names the Codex form");
});

test("MCP startup logs a nonzero codex service ensure exit", async () => {
  const { artifact, env, home, root } = makeIsolatedServer();
  const source = join(root, "source");
  const runtime = join(source, "codex-channel");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "service.mjs"), "process.exit(7);\n");
  const registry = join(home, ".agent-bridge", "codex", "bindings.json");
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, JSON.stringify({ bindings: { active: { enabled: true } } }));

  await mcpExchange(artifact, { ...env, AGENT_BRIDGE_SOURCE_DIR: source }, [
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ensure-exit-test", version: "0.0.0" },
      },
    },
    { method: "notifications/initialized" },
  ], { settleMs: 500 });

  const logFile = join(home, ".agent-bridge", "logs", "agent-bridge.log");
  assert.equal(existsSync(logFile), true, "startup ensure failure must reach the unified log");
  const records = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const failure = records.find((record) => record.event === "codex.ensure_failed" && record.context?.exit_code === 7);
  assert.ok(failure, `missing nonzero ensure-exit record: ${JSON.stringify(records)}`);
  assert.match(failure.msg, /exited unsuccessfully/);
});
