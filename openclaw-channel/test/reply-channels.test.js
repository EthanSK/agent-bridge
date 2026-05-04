// Tests for the replyVia channel resolution (A+B combo, 2026-05-04).
//
// `resolveReplyChannels` is the single source of truth for which reply
// channels an inbound message fans out to. It supports:
//   A — array-valued replyVia (string or array, at any precedence level)
//   B — implicit bridge fallback (any inbound with msg.fromTarget always
//       gets "agent-bridge" appended, deduplicated)
//
// These tests pin the per-precedence + dedup behavior so the onMessage
// dispatcher's loop has a stable contract.

import test from "node:test";
import assert from "node:assert/strict";

import { __testing as indexTesting } from "../src/index.js";

const { resolveReplyChannels, normalizeReplyVia } = indexTesting;

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeTarget(overrides = {}) {
  return {
    name: "default",
    config: {
      account: "default",
      peer_id: "6164541473",
      openclaw_channel: "telegram",
      replyVia: null,
      ...overrides,
    },
  };
}

function makeMsg(overrides = {}) {
  return {
    id: "msg-1",
    from: "MacBookPro",
    fromTarget: undefined,
    replyVia: undefined,
    content: "hello",
    ...overrides,
  };
}

// ── 1. String replyVia, no fromTarget → single channel ─────────────────────

test("string replyVia + no fromTarget → single resolved channel", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: "telegram" }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram"]);
});

test("string replyVia=agent-bridge + no fromTarget → single resolved channel", () => {
  // Note: this is the unusual no-fromTarget + agent-bridge case. Resolution
  // returns the single channel; the actual dispatcher will reject at
  // runtime (no fromTarget means no return path), but resolution itself is
  // a pure function and shouldn't pre-validate.
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: "agent-bridge" }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["agent-bridge"]);
});

// ── 2. String replyVia, with fromTarget → string + agent-bridge appended ───

test("string replyVia=telegram + fromTarget set → telegram first, then agent-bridge", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: "claude-code" }),
    target: makeTarget({ replyVia: "telegram" }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

// ── 3. Array replyVia, no fromTarget → all channels ────────────────────────

test("array replyVia + no fromTarget → exact array (no implicit append)", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: ["telegram", "agent-bridge"] }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

test("array replyVia preserves declared order", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: ["agent-bridge", "telegram"] }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["agent-bridge", "telegram"]);
});

// ── 4. Array includes agent-bridge, with fromTarget → no dup ───────────────

test("array replyVia including agent-bridge + fromTarget → no duplicate", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: "claude-code" }),
    target: makeTarget({ replyVia: ["telegram", "agent-bridge"] }),
    pluginCfg: {},
    log: silentLog,
  });
  // agent-bridge is already present; resolveReplyChannels must NOT push a
  // second copy.
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

test("array replyVia with duplicates is deduped (preserves first occurrence)", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: ["telegram", "telegram", "agent-bridge", "telegram"] }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

// ── 5. Null replyVia, with fromTarget → senderDerived only (no dup) ────────

test("null replyVia + fromTarget set → senderDerived agent-bridge only (no double-append)", () => {
  // Sender-derived already returns ["agent-bridge"] when fromTarget is set;
  // implicit fallback would also append "agent-bridge" — dedup must collapse
  // back to a single entry.
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: "claude-code" }),
    target: makeTarget({ replyVia: null }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["agent-bridge"]);
});

// ── 6. Null replyVia, no fromTarget → senderDerived single channel ─────────

test("null replyVia + no fromTarget → senderDerived telegram", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: null }),
    pluginCfg: {},
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram"]);
});

// ── Bonus: precedence ───────────────────────────────────────────────────────

test("per-message msg.replyVia overrides target + plugin levels (string)", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ replyVia: "agent-bridge", fromTarget: "claude-code" }),
    target: makeTarget({ replyVia: "telegram" }),
    pluginCfg: { replyVia: ["telegram", "agent-bridge"] },
    log: silentLog,
  });
  // msg.replyVia wins → ["agent-bridge"]; fromTarget present so implicit
  // bridge fallback would re-append "agent-bridge", but dedup keeps one.
  assert.deepEqual(channels, ["agent-bridge"]);
});

test("per-message msg.replyVia array overrides target + plugin (array)", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ replyVia: ["telegram", "agent-bridge"], fromTarget: "claude-code" }),
    target: makeTarget({ replyVia: "telegram" }),
    pluginCfg: { replyVia: "agent-bridge" },
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

test("plugin-level array applies when target + msg are null", () => {
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: null }),
    pluginCfg: { replyVia: ["telegram", "agent-bridge"] },
    log: silentLog,
  });
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
});

test("unknown channel names normalize to telegram with a warn log", () => {
  const warns = [];
  const log = { ...silentLog, warn: (m) => warns.push(m) };
  const channels = resolveReplyChannels({
    msg: makeMsg({ fromTarget: undefined }),
    target: makeTarget({ replyVia: ["telegram", "discord", "agent-bridge"] }),
    pluginCfg: {},
    log,
  });
  // "discord" is unknown → coerces to "telegram" → dedup against the
  // first "telegram" → final list is ["telegram", "agent-bridge"].
  assert.deepEqual(channels, ["telegram", "agent-bridge"]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /discord/);
});

// ── normalizeReplyVia direct sanity ────────────────────────────────────────

test("normalizeReplyVia coerces casing/whitespace and unknown values", () => {
  assert.equal(normalizeReplyVia("Telegram", silentLog, "t"), "telegram");
  assert.equal(normalizeReplyVia("  AGENT-BRIDGE ", silentLog, "t"), "agent-bridge");
  assert.equal(normalizeReplyVia(null, silentLog, "t"), "telegram");
  assert.equal(normalizeReplyVia("foo", silentLog, "t"), "telegram");
});
