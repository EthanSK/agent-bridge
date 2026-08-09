import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexSessionsDir } from "../src/paths.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "codex-channel.mjs");
const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD2 = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";

function makeEnv(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-cli-"));
  return {
    // Minimal, hermetic environment. PATH is inherited so node subprocesses
    // resolve, but bridge/codex state is fully sandboxed and the daemon
    // ensure path is disabled twice over (--no-ensure + env kill switch).
    PATH: process.env.PATH,
    HOME: root,
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    CODEX_HOME: join(root, ".codex"),
    AGENT_BRIDGE_MACHINE_NAME: "Test-Mac",
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
    ...extra,
  };
}

function writeRollout(env, threadId) {
  const dir = join(codexSessionsDir(env), "2026", "08", "07");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-08-07T10-00-00-${threadId}.jsonl`), "{}\n");
}

function run(args, env, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr, error });
    });
    if (stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

test("bind auto-discovers CODEX_THREAD_ID from the task shell env", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const result = await run(["bind", "--alias", "release-review", "--no-ensure", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.binding.alias, "release-review");
  assert.equal(parsed.binding.threadId, THREAD);
  assert.equal(parsed.target, "codex/release-review");
  assert.equal(parsed.binding.policy.approvalPolicy, "never");
  assert.equal(parsed.binding.policy.sandbox, "workspace-write");
});

test("zero-argument bind derives a stable task-name alias and suffixes collisions", async () => {
  const env = makeEnv({
    CODEX_THREAD_ID: THREAD,
    AGENT_BRIDGE_CODEX_THREAD_NAME: "Codex Agent Bridge",
  });
  writeRollout(env, THREAD);
  writeRollout(env, THREAD2);

  const first = await run(["bind", "--no-ensure", "--json"], env);
  assert.equal(first.code, 0, first.stderr);
  const firstParsed = JSON.parse(first.stdout);
  assert.equal(firstParsed.binding.alias, "codex-agent-bridge");
  assert.equal(firstParsed.target, "codex/codex-agent-bridge");
  assert.equal(firstParsed.aliasAutomatic, true);
  assert.equal(firstParsed.aliasSource, "thread-name");

  env.AGENT_BRIDGE_CODEX_THREAD_NAME = "A Later Rename Must Not Move The Endpoint";
  const again = await run(["bind", "--no-ensure", "--json"], env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).binding.alias, "codex-agent-bridge");
  assert.equal(JSON.parse(again.stdout).aliasSource, "existing-binding");

  env.CODEX_THREAD_ID = THREAD2;
  env.AGENT_BRIDGE_CODEX_THREAD_NAME = "Codex Agent Bridge";
  const collision = await run(["bind", "--no-ensure", "--json"], env);
  assert.equal(collision.code, 0, collision.stderr);
  assert.equal(JSON.parse(collision.stdout).binding.alias, "codex-agent-bridge-ffff0002");

  const bindings = JSON.parse((await run(["list", "--json"], env)).stdout).bindings;
  assert.deepEqual(bindings.map((binding) => binding.alias), [
    "codex-agent-bridge",
    "codex-agent-bridge-ffff0002",
  ]);
});

test("bind human output explains reachability + reply identity", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const result = await run(["bind", "--alias", "main", "--no-ensure"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /bound codex\/main -> Codex thread/);
  assert.match(result.stdout, /target: "codex\/main"/);
  assert.match(result.stdout, /from_target: "codex\/main"/);
});

test("bind without a thread id fails with actionable guidance", async () => {
  const env = makeEnv();
  const result = await run(["bind", "--alias", "x", "--no-ensure"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /CODEX_THREAD_ID/);
  assert.match(result.stderr, /--thread-id/);
});

test("bind validates rollout existence unless --force", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  const missing = await run(["bind", "--alias", "x", "--no-ensure"], env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /no persisted rollout/);
  const forced = await run(["bind", "--alias", "x", "--no-ensure", "--force"], env);
  assert.equal(forced.code, 0, forced.stderr);
});

test("bind rejects danger-full-access without --allow-danger", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const denied = await run(["bind", "--alias", "x", "--sandbox", "danger-full-access", "--no-ensure"], env);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /--allow-danger/);
});

test("rebind cannot silently inherit danger-full-access without fresh consent", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  writeRollout(env, THREAD2);
  const created = await run([
    "bind", "--alias", "danger", "--sandbox", "danger-full-access", "--allow-danger", "--no-ensure",
  ], env);
  assert.equal(created.code, 0, created.stderr);

  const denied = await run(["rebind", "danger", "--thread-id", THREAD2, "--no-ensure"], env);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /--allow-danger/);
  const afterDenied = JSON.parse((await run(["list", "--json"], env)).stdout);
  assert.equal(afterDenied.bindings[0].threadId, THREAD, "failed consent check leaves the original binding unchanged");

  const safe = await run([
    "rebind", "danger", "--thread-id", THREAD2, "--sandbox", "workspace-write", "--no-ensure",
  ], env);
  assert.equal(safe.code, 0, safe.stderr);
});

test("duplicate alias fails; rebind verb moves the alias; list/status/doctor reflect it", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  writeRollout(env, THREAD2);
  assert.equal((await run(["bind", "--alias", "r", "--no-ensure"], env)).code, 0);
  const dup = await run(["bind", "--alias", "r", "--thread-id", THREAD2, "--no-ensure"], env);
  assert.notEqual(dup.code, 0);
  assert.match(dup.stderr, /already bound/);
  const moved = await run(["rebind", "r", "--thread-id", THREAD2, "--no-ensure", "--json"], env);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(JSON.parse(moved.stdout).binding.threadId, THREAD2);

  const list = await run(["list"], env);
  assert.match(list.stdout, new RegExp(`codex/r -> ${THREAD2}`));

  const status = await run(["status", "--json"], env);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.bindings[0].threadId, THREAD2);
  assert.equal(snapshot.service.running, false);

  const doctor = await run(["doctor"], env);
  assert.notEqual(doctor.code, 0, "doctor exits non-zero while checks fail (no daemon, no MCP registration)");
  assert.match(doctor.stdout, /doctor checks:/);
});

test("disable/enable and unbind lifecycle", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  await run(["bind", "--alias", "r", "--no-ensure"], env);
  const disabled = await run(["disable", "r"], env);
  assert.match(disabled.stdout, /DISABLED/);
  const listDisabled = await run(["list"], env);
  assert.match(listDisabled.stdout, /\[disabled\]/);
  await run(["enable", "r"], env);
  const removed = await run(["unbind", "r"], env);
  assert.match(removed.stdout, /unbound codex\/r/);
  const listEmpty = await run(["list"], env);
  assert.match(listEmpty.stdout, /no codex bindings/);
});

test("send --machine local writes a canonical BridgeMessage into the local inbox", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  await run(["bind", "--alias", "r", "--no-ensure"], env);
  const sent = await run([
    "send",
    "--machine", "local",
    "--target", "claude-code/default",
    "--message", "hello from codex task",
    "--reply-to", "msg-original",
    "--from-alias", "r",
    "--json",
  ], env);
  assert.equal(sent.code, 0, sent.stderr);
  const parsed = JSON.parse(sent.stdout);
  assert.equal(parsed.fromTarget, "codex/r");
  const inboxDir = join(env.AGENT_BRIDGE_HOME, "inbox", "claude-code", "default");
  const files = readdirSync(inboxDir);
  assert.equal(files.length, 1);
  const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
  assert.equal(msg.content, "hello from codex task");
  assert.equal(msg.target, "claude-code/default");
  assert.equal(msg.fromTarget, "codex/r");
  assert.equal(msg.replyTo, "msg-original");
  assert.equal(msg.type, "reply");
  assert.equal(msg.from, "Test-Mac");
  assert.match(msg.id, /^msg-[0-9a-f-]{36}$/);
  assert.ok(msg.sourceAgentBridgeVersion, "source version stamped for relay notices");
});

test("send --stdin reads the body from stdin; --one-way omits fromTarget", async () => {
  const env = makeEnv();
  const sent = await run([
    "send", "--machine", "local", "--target", "openclaw/default", "--stdin", "--one-way", "--json",
  ], env, { stdin: "body via stdin" });
  assert.equal(sent.code, 0, sent.stderr);
  const inboxDir = join(env.AGENT_BRIDGE_HOME, "inbox", "openclaw", "default");
  const files = readdirSync(inboxDir);
  const msg = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
  assert.equal(msg.content, "body via stdin");
  assert.equal(msg.fromTarget, undefined);
  assert.equal(msg.type, "message");
});

test("send validation: bad target, unknown from-alias, unpaired machine", async () => {
  const env = makeEnv();
  const badTarget = await run(["send", "--machine", "local", "--target", "../evil", "--message", "x"], env);
  assert.notEqual(badTarget.code, 0);
  assert.match(badTarget.stderr, /invalid --target/);

  const badAlias = await run(["send", "--machine", "local", "--target", "openclaw/default", "--message", "x", "--from-alias", "nope"], env);
  assert.notEqual(badAlias.code, 0);
  assert.match(badAlias.stderr, /no such binding/);

  const badMachine = await run(["send", "--machine", "Unpaired-Box", "--target", "openclaw/default", "--message", "x"], env);
  assert.notEqual(badMachine.code, 0);
  assert.match(badMachine.stderr, /delivery failed/);
});

test("service status reports NOT RUNNING in a fresh sandbox; help lists verbs", async () => {
  const env = makeEnv();
  const status = await run(["service", "status"], env);
  assert.match(status.stdout, /NOT RUNNING/);
  const help = await run(["help"], env);
  assert.match(help.stdout, /agent-bridge codex bind --alias/);
  assert.match(help.stdout, /service run\|ensure\|stop\|status/);
  const unknown = await run(["frobnicate"], env);
  assert.equal(unknown.code, 2);
});
