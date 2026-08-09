import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindAutomaticCodexAlias,
  readCodexThreadMetadata,
  selectAutomaticCodexAlias,
  slugifyCodexAlias,
} from "../src/auto-alias.js";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { listBindings, setBindingEnabled } from "../src/bindings.js";
import { createFakeAppServer } from "./fake-app-server.mjs";

const THREAD_A = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD_B = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";

function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "ab-auto-alias-"));
  return {
    HOME: home,
    AGENT_BRIDGE_HOME: join(home, ".agent-bridge"),
    CODEX_HOME: join(home, ".codex"),
    ...extra,
  };
}

test("slugifyCodexAlias produces portable readable aliases", () => {
  assert.equal(slugifyCodexAlias("  Release Review!  "), "release-review");
  assert.equal(slugifyCodexAlias("Crème brûlée"), "creme-brulee");
  assert.equal(slugifyCodexAlias("CON"), "task-con");
  assert.equal(slugifyCodexAlias("日本語"), null);
  assert.ok(slugifyCodexAlias("word ".repeat(100)).length <= 64);
});

test("selection uses title, then cwd, then a short task-id fallback", () => {
  assert.deepEqual(
    selectAutomaticCodexAlias({ threadId: THREAD_A, threadName: "Release Review", cwd: "/repo/project" }),
    { alias: "release-review", source: "thread-name", reused: false, title: "Release Review" },
  );
  assert.equal(
    selectAutomaticCodexAlias({ threadId: THREAD_A, threadName: "日本語", cwd: "/repo/Agent Bridge" }).alias,
    "agent-bridge",
  );
  assert.equal(
    selectAutomaticCodexAlias({ threadId: THREAD_A }).alias,
    "codex-task-ffff0001",
  );
});

test("selection reuses the saved alias before reading a changed title", () => {
  const selected = selectAutomaticCodexAlias({
    threadId: THREAD_A,
    threadName: "A Completely Different New Title",
    bindings: [{ alias: "release-review", threadId: THREAD_A, createdAt: "2026-01-01T00:00:00Z" }],
  });
  assert.equal(selected.alias, "release-review");
  assert.equal(selected.source, "existing-binding");
  assert.equal(selected.reused, true);
});

test("duplicate task names get a deterministic thread-id suffix", () => {
  const selected = selectAutomaticCodexAlias({
    threadId: THREAD_B,
    threadName: "Release Review",
    bindings: [{ alias: "Release-Review", threadId: THREAD_A }],
  });
  assert.equal(selected.alias, "release-review-ffff0002");
  assert.equal(selected.source, "thread-name-collision");
});

test("metadata discovery uses read-only thread/read and never resumes", async () => {
  const fake = createFakeAppServer({
    threadReadResult: ({ threadId, includeTurns }) => ({
      thread: {
        id: threadId,
        name: "Inbox Review",
        cwd: "/safe/project",
        turns: includeTurns ? [{ id: "unexpected" }] : [],
      },
    }),
  });
  const metadata = await readCodexThreadMetadata({
    threadId: THREAD_A,
    env: makeEnv(),
    clientFactory: async () => new CodexAppServerClient(fake.child, {
      clientVersion: "4.10.0",
      killGraceMs: 20,
      reapGraceMs: 20,
    }),
  });
  assert.deepEqual(metadata, {
    name: "Inbox Review",
    cwd: "/safe/project",
    warning: null,
    source: "thread-read",
  });
  const methods = fake.received.map((frame) => frame.method).filter(Boolean);
  assert.ok(methods.includes("thread/read"));
  assert.ok(!methods.includes("thread/resume"));
  const read = fake.received.find((frame) => frame.method === "thread/read");
  assert.equal(read.params.includeTurns, false);
});

test("unavailable task-name lookup falls back to the task cwd", async () => {
  const env = makeEnv();
  const result = await bindAutomaticCodexAlias({
    threadId: THREAD_A,
    cwd: process.cwd(),
    env,
    clientFactory: async () => { throw new Error("codex unavailable"); },
  });
  assert.equal(result.binding.alias, "codex-channel");
  assert.equal(result.aliasResolution.source, "thread-cwd");
  assert.match(result.aliasResolution.metadataWarning, /codex unavailable/);
});

test("automatic bind is stable, idempotently re-enables, and collision-safe", async () => {
  const env = makeEnv();
  const first = await bindAutomaticCodexAlias({
    threadId: THREAD_A,
    cwd: process.cwd(),
    threadName: "Release Review",
    env,
  });
  assert.equal(first.binding.alias, "release-review");
  assert.equal(first.replaced, null);
  setBindingEnabled("release-review", false, { env });

  const again = await bindAutomaticCodexAlias({
    threadId: THREAD_A,
    cwd: process.cwd(),
    env,
    clientFactory: async () => { throw new Error("existing bindings must skip title lookup"); },
  });
  assert.equal(again.binding.alias, "release-review");
  assert.equal(again.binding.enabled, true);
  assert.equal(again.replaced.threadId, THREAD_A);
  assert.equal(again.aliasResolution.source, "existing-binding");

  const colliding = await bindAutomaticCodexAlias({
    threadId: THREAD_B,
    cwd: process.cwd(),
    threadName: "Release Review",
    env,
  });
  assert.equal(colliding.binding.alias, "release-review-ffff0002");
  assert.deepEqual(listBindings({ env }).map((binding) => binding.alias), [
    "release-review",
    "release-review-ffff0002",
  ]);
});
