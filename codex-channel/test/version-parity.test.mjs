import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHANNEL_VERSION } from "../src/version.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readCliVersion() {
  const cli = readFileSync(join(repoRoot, "agent-bridge"), "utf8");
  const match = cli.match(/^VERSION="([^"]+)"$/m);
  assert.ok(match, "agent-bridge CLI VERSION must be declared");
  return match[1];
}

test("codex-channel version stays pinned to the agent-bridge runtime version on EVERY surface", () => {
  const channelPkg = readJson("codex-channel/package.json");
  const mcpPkg = readJson("mcp-server/package.json");
  const mcpLock = readJson("mcp-server/package-lock.json");
  const claudePlugin = readJson("mcp-server/.claude-plugin/plugin.json");
  const openclawPkg = readJson("openclaw-channel/package.json");
  const cliVersion = readCliVersion();

  assert.equal(CHANNEL_VERSION, channelPkg.version, "src/version.js must match codex-channel/package.json");
  assert.equal(channelPkg.version, mcpPkg.version);
  assert.equal(channelPkg.version, mcpLock.version, "package-lock.json root version");
  assert.equal(channelPkg.version, mcpLock.packages?.[""]?.version, "package-lock.json packages entry");
  assert.equal(channelPkg.version, claudePlugin.version);
  assert.equal(channelPkg.version, openclawPkg.version);
  assert.equal(channelPkg.version, cliVersion);

  // MCP_SERVER_VERSION constant in config.ts (source of the runtime string).
  const configTs = readFileSync(join(repoRoot, "mcp-server", "src", "config.ts"), "utf8");
  const constMatch = configTs.match(/MCP_SERVER_VERSION = '([^']+)'/);
  assert.ok(constMatch, "MCP_SERVER_VERSION constant must exist");
  assert.equal(constMatch[1], channelPkg.version);
});
