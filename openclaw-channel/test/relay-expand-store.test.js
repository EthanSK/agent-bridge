import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  formatRelayExpandEntry,
  normalizeExpandId,
  readRelayExpandEntry,
  storeRelayExpandMessage,
} from "../src/relay-expand-store.js";

function tempStorePath() {
  return join(mkdtempSync(join(tmpdir(), "agent-bridge-relay-expand-")), "store.json");
}

function makeMsg(overrides = {}) {
  return {
    id: overrides.id ?? "msg-abc",
    from: "MacBookPro",
    fromTarget: "claude-code/default",
    target: "openclaw/default",
    type: "message",
    content: overrides.content ?? "full bridge message\nwith multiple lines\nand private context",
    timestamp: "2026-05-08T21:00:00.000Z",
    ...overrides,
  };
}

test("normalizeExpandId accepts one-digit human references", () => {
  assert.equal(normalizeExpandId("7"), "07");
  assert.equal(normalizeExpandId("#7"), "07");
  assert.equal(normalizeExpandId("07"), "07");
});

test("storeRelayExpandMessage stores full content and writes companion files", () => {
  const storePath = tempStorePath();
  const now = Date.parse("2026-05-08T21:00:00.000Z");
  const record = storeRelayExpandMessage(makeMsg(), {
    targetName: "default",
    replyVia: ["agent-bridge", "telegram"],
    agentBridgeVersion: "4.1.0",
  }, { storePath, now });

  assert.equal(record.expandId, "00");
  const fetched = readRelayExpandEntry("0", { storePath, now: now + 1000 });
  assert.equal(fetched.message.content, "full bridge message\nwith multiple lines\nand private context");
  assert.deepEqual(fetched.metadata.replyVia, ["agent-bridge", "telegram"]);

  const rendered = formatRelayExpandEntry(fetched);
  assert.match(rendered, /Agent Bridge relay expand 00/);
  assert.match(rendered, /message_id: msg-abc/);
  assert.match(rendered, /reply_path: agent-bridge, telegram/);
  assert.match(rendered, /--- message ---\nfull bridge message\nwith multiple lines/);

  const txtPath = join(dirname(storePath), "00.txt");
  assert.match(readFileSync(txtPath, "utf8"), /full bridge message\nwith multiple lines/);
});

test("relay expand store prunes expired entries", () => {
  const storePath = tempStorePath();
  const now = Date.parse("2026-05-08T21:00:00.000Z");
  storeRelayExpandMessage(makeMsg({ id: "msg-expiring" }), {}, {
    storePath,
    now,
    ttlMs: 1000,
  });

  assert.equal(readRelayExpandEntry("00", { storePath, now: now + 999 })?.message.id, "msg-expiring");
  assert.equal(readRelayExpandEntry("00", { storePath, now: now + 1001 }), null);
});

test("relay expand ids rotate deterministically and overwrite collisions when id space is full", () => {
  const storePath = tempStorePath();
  const now = Date.parse("2026-05-08T21:00:00.000Z");
  const opts = { storePath, ttlMs: 60_000, maxEntries: 2, idSpace: 2 };

  const first = storeRelayExpandMessage(makeMsg({ id: "msg-0", content: "first" }), {}, { ...opts, now });
  const second = storeRelayExpandMessage(makeMsg({ id: "msg-1", content: "second" }), {}, { ...opts, now: now + 1 });
  const third = storeRelayExpandMessage(makeMsg({ id: "msg-2", content: "third" }), {}, { ...opts, now: now + 2 });

  assert.equal(first.expandId, "00");
  assert.equal(second.expandId, "01");
  assert.equal(third.expandId, "00");
  assert.equal(readRelayExpandEntry("00", { storePath, now: now + 3 })?.message.content, "third");
  assert.equal(readRelayExpandEntry("01", { storePath, now: now + 3 })?.message.content, "second");

  const stored = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(stored.entries.length, 2);
});
