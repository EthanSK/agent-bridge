import test from "node:test";
import assert from "node:assert/strict";

import { buildReply } from "../src/envelope.js";

test("buildReply preserves message id threading and explicit return target", () => {
  const reply = buildReply({
    fromMachine: "Mac-Mini",
    toMachine: "MacBookPro",
    replyToId: "msg-incoming",
    content: "done",
    target: "claude-code",
    ownTarget: "openclaw/clordlethird",
  });

  assert.match(reply.id, /^msg-/);
  assert.equal(reply.replyTo, "msg-incoming");
  assert.equal(reply.target, "claude-code");
  assert.equal(reply.fromTarget, "openclaw/clordlethird");
});

test("buildReply can derive return target from incoming.fromTarget", () => {
  const reply = buildReply({
    fromMachine: "Mac-Mini",
    toMachine: "MacBookPro",
    replyToId: "msg-incoming",
    content: "done",
    incoming: {
      fromTarget: "openclaw/default",
    },
    ownTarget: "openclaw/default",
  });

  assert.equal(reply.target, "openclaw/default");
});
