import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeBridgePeerId,
  encodeBridgePeerId,
} from "../src/bridge-peer.js";
import { __testing as channelPluginTesting } from "../src/channel-plugin.js";

test("bridge peer id round-trips machine and return target", () => {
  const encoded = encodeBridgePeerId("MacBookPro", "claude-code");

  assert.match(encoded, /^bridge-v1\./);
  assert.deepEqual(decodeBridgePeerId(encoded), {
    encoded: true,
    fromMachine: "MacBookPro",
    returnTarget: "claude-code",
  });
});

test("legacy peer id decodes as a machine without a return target", () => {
  assert.deepEqual(decodeBridgePeerId("MacBookPro"), {
    encoded: false,
    fromMachine: "MacBookPro",
    returnTarget: null,
  });
});

test("outbound resolution treats encoded ctx.to as authoritative over stale account hints", () => {
  const encoded = encodeBridgePeerId("MacBookPro", "claude-code");
  const staleHit = {
    fromMachine: "OtherMachine",
    returnTarget: "openclaw/default",
    ownTarget: "openclaw/default",
    incoming: {
      id: "msg-old",
      fromTarget: "openclaw/default",
    },
  };
  const targets = new Map([["default", staleHit]]);

  const hit = channelPluginTesting.resolveOutboundTarget(
    {
      to: encoded,
      accountId: "default",
    },
    () => targets,
  );

  assert.equal(hit.fromMachine, "MacBookPro");
  assert.equal(hit.returnTarget, "claude-code");
  assert.equal(hit.replyToId, null);
});

test("outbound resolution keeps reply id when encoded ctx.to matches the cached session hint", () => {
  const encoded = encodeBridgePeerId("MacBookPro", "claude-code");
  const sessionHit = {
    fromMachine: "MacBookPro",
    returnTarget: "claude-code",
    ownTarget: "openclaw/default",
    incoming: {
      id: "msg-incoming",
      fromTarget: "claude-code",
    },
  };
  const targets = new Map([[encoded, sessionHit]]);

  const hit = channelPluginTesting.resolveOutboundTarget(
    {
      to: encoded,
      accountId: "default",
    },
    () => targets,
  );

  assert.equal(hit.fromMachine, "MacBookPro");
  assert.equal(hit.returnTarget, "claude-code");
  assert.equal(hit.replyToId, "msg-incoming");
});

test("outbound resolution can recover from encoded ctx.to after restart", () => {
  const encoded = encodeBridgePeerId("MacBookPro", "openclaw/default");

  const hit = channelPluginTesting.resolveOutboundTarget(
    {
      to: encoded,
      accountId: "clordlethird",
    },
    () => new Map(),
  );

  assert.equal(hit.fromMachine, "MacBookPro");
  assert.equal(hit.returnTarget, "openclaw/default");
  assert.equal(hit.ownTarget, "openclaw/clordlethird");
});
