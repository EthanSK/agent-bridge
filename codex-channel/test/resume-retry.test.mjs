import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearResumeRetry, codexBinaryStamp, nextResumeRetry, persistResumeRetry, readResumeRetry, resumeRetryKey } from "../src/resume-retry.js";
import { resumeRetryPath } from "../src/paths.js";
import { bindAlias } from "../src/bindings.js";
import { buildStatusSnapshot } from "../src/status.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-resume-retry-"));
  return { root, env: { AGENT_BRIDGE_HOME: join(root, ".agent-bridge"), CODEX_HOME: join(root, ".codex") } };
}

test("changing a binding or its selected binary produces a new resume budget", () => {
  const { root, env } = fixture();
  const bin = join(root, "codex");
  writeFileSync(bin, "first build");
  chmodSync(bin, 0o700);
  env.AGENT_BRIDGE_CODEX_BIN = bin;
  const firstStamp = codexBinaryStamp(env);
  writeFileSync(bin, "second longer build");
  const secondStamp = codexBinaryStamp(env);
  assert.notEqual(firstStamp, secondStamp);
  const binding = { threadId: "t", cwd: null, policy: {}, updatedAt: "one" };
  const key = resumeRetryKey(binding, firstStamp);
  assert.notEqual(key, resumeRetryKey(binding, secondStamp));
  assert.notEqual(key, resumeRetryKey({ ...binding, updatedAt: "two" }, firstStamp));
  const previous = { key, attempts: 50 };
  assert.equal(nextResumeRetry({ previous, key: resumeRetryKey(binding, secondStamp), state: "session_error", detail: "timeout", now: 0 }).attempts, 1);
});

test("retained cooldown is visible in read-only status; corrupt records are preserved and reported", () => {
  const { env } = fixture();
  const binding = bindAlias({ alias: "review", threadId: "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001", env });
  const record = nextResumeRetry({ key: resumeRetryKey(binding, codexBinaryStamp(env)), state: "session_error", detail: "unknown variant functionCallOutput", now: 100 });
  persistResumeRetry("review", record, env);
  assert.deepEqual(readResumeRetry("review", env), record);
  assert.equal(buildStatusSnapshot({ env }).bindings[0].resumeRetry.phase, "cooldown");
  const path = resumeRetryPath("review", env);
  writeFileSync(path, "{corrupt");
  assert.throws(() => readResumeRetry("review", env));
  assert.equal(buildStatusSnapshot({ env }).bindings[0].resumeRetry.unreadable, true);
  assert.equal(readFileSync(path, "utf8"), "{corrupt");
  clearResumeRetry("review", env);
  assert.equal(readResumeRetry("review", env), null);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, key: "x", attempts: -1, retryAt: 0 }));
  assert.throws(() => readResumeRetry("review", env), /invalid resume retry/);
});
