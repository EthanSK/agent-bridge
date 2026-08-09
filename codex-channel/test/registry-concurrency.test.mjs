/**
 * REAL cross-process registry concurrency: N parallel processes each bind a
 * distinct alias through the public CLI; every successful bind must survive.
 * (The pre-lock load-modify-save implementation lost 9-11 of 40 parallel
 * binds — this is the regression fence.)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBindings } from "../src/bindings.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "codex-channel.mjs");
const PARALLEL = 24;

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-reg-conc-"));
  return {
    PATH: process.env.PATH,
    HOME: root,
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    CODEX_HOME: join(root, ".codex"),
    AGENT_BRIDGE_MACHINE_NAME: "Conc-Test",
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
  };
}

function threadIdFor(i) {
  return `0199aaaa-bbbb-4ccc-8ddd-${String(100000000000 + i)}`;
}

function runBind(env, alias, threadId) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, "bind", "--alias", alias, "--thread-id", threadId, "--force", "--no-ensure", "--json"],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("parallel cross-process binds: EVERY successful bind is preserved", async () => {
  const env = makeEnv();
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, (_, i) => runBind(env, `alias-${String(i).padStart(2, "0")}`, threadIdFor(i))),
  );
  const succeeded = results.filter((r) => r.code === 0);
  for (const r of results) {
    assert.equal(r.code, 0, `bind failed: ${r.stderr || r.stdout}`);
  }
  const bindings = listBindings({ env });
  assert.equal(
    bindings.length,
    succeeded.length,
    `registry lost ${succeeded.length - bindings.length} of ${succeeded.length} successful binds`,
  );
  const aliases = new Set(bindings.map((b) => b.alias));
  for (let i = 0; i < PARALLEL; i += 1) {
    assert.ok(aliases.has(`alias-${String(i).padStart(2, "0")}`), `alias-${i} lost`);
  }
});

test("parallel mixed mutations (bind + disable + rebind) never lose unrelated records", async () => {
  const env = makeEnv();
  // Seed a few bindings sequentially.
  for (let i = 0; i < 4; i += 1) {
    const r = await runBind(env, `seed-${i}`, threadIdFor(100 + i));
    assert.equal(r.code, 0, r.stderr);
  }
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const ops = await Promise.all([
    runBind(env, "extra-a", threadIdFor(200)),
    runBind(env, "extra-b", threadIdFor(201)),
    run(["disable", "seed-0"]),
    run(["disable", "seed-1"]),
    run(["rebind", "seed-2", "--thread-id", threadIdFor(300), "--force", "--no-ensure"]),
  ]);
  for (const op of ops) assert.equal(op.code, 0, op.stderr || op.stdout);
  const bindings = listBindings({ env });
  assert.equal(bindings.length, 6, "4 seeds + 2 extras all present");
  assert.equal(bindings.find((b) => b.alias === "seed-0").enabled, false);
  assert.equal(bindings.find((b) => b.alias === "seed-1").enabled, false);
  assert.equal(bindings.find((b) => b.alias === "seed-2").threadId, threadIdFor(300));
});
