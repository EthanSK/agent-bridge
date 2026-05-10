import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readCliVersion() {
  const cli = readFileSync(join(repoRoot, "agent-bridge"), "utf8");
  const match = cli.match(/^VERSION="([^"]+)"$/m);
  assert.ok(match, "agent-bridge CLI VERSION must be declared");
  return match[1];
}

test("openclaw-channel package version stays pinned to agent-bridge runtime version", () => {
  const channelPkg = readJson("openclaw-channel/package.json");
  const mcpPkg = readJson("mcp-server/package.json");
  const claudePlugin = readJson("mcp-server/.claude-plugin/plugin.json");
  const cliVersion = readCliVersion();

  assert.equal(channelPkg.version, mcpPkg.version);
  assert.equal(channelPkg.version, claudePlugin.version);
  assert.equal(channelPkg.version, cliVersion);
});
