import test from "node:test";
import assert from "node:assert/strict";

import { __testing as indexTesting } from "../src/index.js";

test("startOrReuseWatcher reuses an identical watcher instead of starting twice", () => {
  const processState = {
    replyTargets: new Map(),
    watcherStop: null,
    watcherSignature: null,
    cleanupInstalled: false,
  };
  const log = {
    info() {},
    warn() {},
  };

  let starts = 0;
  let stops = 0;
  const start = () => {
    starts += 1;
    return () => {
      stops += 1;
    };
  };

  const args = {
    processState,
    agentId: "main",
    inboxRoot: "/tmp/inbox",
    pollIntervalMs: 2000,
    targets: {
      default: {
        openclaw_channel: "telegram",
        account: "default",
        peer_id: "6164541473",
        additionalReplyChannels: null,
      },
    },
    log,
    start,
  };

  assert.equal(indexTesting.startOrReuseWatcher(args), "started");
  assert.equal(indexTesting.startOrReuseWatcher(args), "reused");
  assert.equal(starts, 1);
  assert.equal(stops, 0);
});

test("startOrReuseWatcher restarts when watcher config changes", () => {
  const processState = {
    replyTargets: new Map(),
    watcherStop: null,
    watcherSignature: null,
    cleanupInstalled: false,
  };
  const log = {
    info() {},
    warn() {},
  };

  let starts = 0;
  let stops = 0;
  const makeArgs = (account) => ({
    processState,
    agentId: "main",
    inboxRoot: "/tmp/inbox",
    pollIntervalMs: 2000,
    targets: {
      [account]: {
        openclaw_channel: "telegram",
        account,
        peer_id: "6164541473",
        additionalReplyChannels: null,
      },
    },
    log,
    start: () => {
      starts += 1;
      return () => {
        stops += 1;
      };
    },
  });

  assert.equal(indexTesting.startOrReuseWatcher(makeArgs("default")), "started");
  assert.equal(indexTesting.startOrReuseWatcher(makeArgs("clawdiboi2")), "started");
  assert.equal(starts, 2);
  assert.equal(stops, 1);
});

test("startOrReuseWatcher restarts when ONLY plugin-level additionalReplyChannels changes", () => {
  // Codex review P2 (2026-05-04): a hot reload that flips plugin-level
  // additionalReplyChannels MUST invalidate the watcher signature so the
  // refreshed pluginCfg closure is used. Per-target signature alone misses
  // this when targets leave the field null and inherit from the plugin.
  const processState = {
    replyTargets: new Map(),
    watcherStop: null,
    watcherSignature: null,
    cleanupInstalled: false,
  };
  const log = { info() {}, warn() {} };

  let starts = 0;
  let stops = 0;
  const makeArgs = (pluginCfg) => ({
    processState,
    agentId: "main",
    inboxRoot: "/tmp/inbox",
    pollIntervalMs: 2000,
    targets: {
      default: {
        openclaw_channel: "telegram",
        account: "default",
        peer_id: "6164541473",
        additionalReplyChannels: null, // inherit from plugin
      },
    },
    pluginCfg,
    log,
    start: () => {
      starts += 1;
      return () => {
        stops += 1;
      };
    },
  });

  assert.equal(
    indexTesting.startOrReuseWatcher(makeArgs({ additionalReplyChannels: ["telegram"] })),
    "started",
  );
  // Same per-target shape, but plugin-level flipped → must restart.
  assert.equal(
    indexTesting.startOrReuseWatcher(makeArgs({ additionalReplyChannels: [] })),
    "started",
  );
  assert.equal(starts, 2);
  assert.equal(stops, 1);
});

test("normalizeExplicitTargets preserves legacy_session", () => {
  const warnings = [];
  const targets = indexTesting.normalizeExplicitTargets(
    {
      peer_id: "6164541473",
      targets: {
        default: {
          openclaw_channel: "telegram",
          account: "default",
          legacy_session: true,
        },
      },
    },
    {
      warn(msg) {
        warnings.push(msg);
      },
    },
  );

  assert.deepEqual(warnings, []);
  assert.equal(targets.default.legacy_session, true);
});
