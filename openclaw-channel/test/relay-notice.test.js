import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRelayNotice,
  relayNoticeEnabled,
  relayNoticePreview,
} from "../src/relay-notice.js";

test("relay notices are enabled by default and can be disabled", () => {
  assert.equal(relayNoticeEnabled({}, {}), true);
  assert.equal(relayNoticeEnabled({ relayNotice: false }, {}), false);
  assert.equal(relayNoticeEnabled({ relayNotice: { enabled: false } }, {}), false);
  assert.equal(relayNoticeEnabled({ relayNotice: false }, { relayNotice: true }), true);
});

test("relay notice preview is one-line and bounded", () => {
  assert.equal(relayNoticePreview("  hello\n\nworld  "), "hello world");
  assert.equal(relayNoticePreview("a".repeat(50), 20), `${"a".repeat(19)}…`);
  assert.equal(relayNoticePreview("a".repeat(3100)).length, 3000);
});

test("formatRelayNotice uses a glanceable Agent Bridge relay header", () => {
  const text = formatRelayNotice(
    {
      id: "msg-123",
      from: "MacBookPro",
      fromTarget: "claude-code",
      target: "openclaw/clordlethird",
      content: "Please sync the setup repo and reply with status.",
    },
    { targetName: "clordlethird", replyVia: "agent-bridge", agentBridgeVersion: "4.0.0" },
  );

  assert.match(text, /^\[Agent Bridge relay\] 🛰️/);
  assert.match(text, /agent-bridge: v4\.0\.0/);
  assert.match(text, /received: MacBookPro\/claude-code → openclaw\/clordlethird/);
  assert.match(text, /reply path: agent-bridge/);
  assert.match(text, /id: msg-123/);
  assert.match(text, /message: “Please sync/);
});
