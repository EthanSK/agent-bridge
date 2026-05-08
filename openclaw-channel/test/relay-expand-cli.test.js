import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = join(repoRoot, "agent-bridge");

test("agent-bridge relay-expand prints the stored full relay message", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-relay-expand-cli-home-"));
  const storeDir = join(home, ".agent-bridge", "relay-expand");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "store.json"), JSON.stringify({
    version: 1,
    lastSeq: 7,
    entries: [
      {
        expandId: "07",
        storedAt: "2026-05-08T21:00:00.000Z",
        storedAtMs: Date.now(),
        expiresAt: "2999-01-01T00:00:00.000Z",
        expiresAtMs: Date.parse("2999-01-01T00:00:00.000Z"),
        message: {
          id: "msg-cli",
          from: "MacBookPro",
          fromTarget: "claude-code/default",
          target: "openclaw/default",
          content: "full message body from compact relay",
        },
        metadata: {
          targetName: "default",
          replyVia: ["agent-bridge", "telegram"],
          agentBridgeVersion: "4.1.0",
        },
      },
    ],
  }));

  const output = execFileSync("bash", [cliPath, "relay-expand", "7"], {
    env: { ...process.env, HOME: home, AGENT_BRIDGE_RELAY_EXPAND_STORE: join(storeDir, "store.json") },
    encoding: "utf8",
  });

  assert.match(output, /Agent Bridge relay expand 07/);
  assert.match(output, /message_id: msg-cli/);
  assert.match(output, /reply_path: agent-bridge, telegram/);
  assert.match(output, /--- message ---\nfull message body from compact relay/);
});

test("agent-bridge relay-expand --json prints the raw stored entry", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-bridge-relay-expand-cli-json-home-"));
  const storeDir = join(home, ".agent-bridge", "relay-expand");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "store.json"), JSON.stringify({
    version: 1,
    lastSeq: 8,
    entries: [
      {
        expandId: "08",
        storedAt: "2026-05-08T21:00:00.000Z",
        storedAtMs: Date.now(),
        expiresAt: "2999-01-01T00:00:00.000Z",
        expiresAtMs: Date.parse("2999-01-01T00:00:00.000Z"),
        message: { id: "msg-json", content: "json body" },
        metadata: {},
      },
    ],
  }));

  const output = execFileSync("bash", [cliPath, "relay-expand", "--json", "08"], {
    env: { ...process.env, HOME: home, AGENT_BRIDGE_RELAY_EXPAND_STORE: join(storeDir, "store.json") },
    encoding: "utf8",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.expandId, "08");
  assert.equal(parsed.message.content, "json body");
});
