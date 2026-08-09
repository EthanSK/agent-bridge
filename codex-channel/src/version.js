/**
 * Single source of truth for the codex-channel build version. Bump in
 * lockstep with the repo-wide agent-bridge version (CLI VERSION=,
 * mcp-server/package.json, mcp-server/.claude-plugin/plugin.json,
 * openclaw-channel/package.json, codex-channel/package.json) — enforced by
 * openclaw-channel/test/version-parity.test.js and
 * codex-channel/test/version-parity.test.mjs.
 */
export const CHANNEL_VERSION = "4.10.0";
