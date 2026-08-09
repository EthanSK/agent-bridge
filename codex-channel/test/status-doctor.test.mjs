import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { bindAlias, setBindingEnabled } from "../src/bindings.js";
import { buildStatusSnapshot, formatStatus, formatDoctor, runDoctor } from "../src/status.js";
import { bridgeHome, codexHome, codexInboxDir, codexPendingAckDir, codexSessionsDir, exhaustedDir, inboxRoot, serviceLeasePath, serviceTeardownPoisonPath } from "../src/paths.js";
import { CHANNEL_VERSION } from "../src/version.js";

const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-status-"));
  return {
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    CODEX_HOME: join(root, ".codex"),
  };
}

function writeRollout(env, threadId) {
  const dir = join(codexSessionsDir(env), "2026", "08", "07");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-07T10-00-00-${threadId}.jsonl`);
  writeFileSync(path, "{}\n");
  return path;
}

test("status snapshot: empty environment", () => {
  const env = makeEnv();
  const snapshot = buildStatusSnapshot({ env });
  assert.equal(snapshot.channelVersion, CHANNEL_VERSION);
  assert.equal(snapshot.service.running, false);
  assert.equal(snapshot.service.staleLease, false);
  assert.deepEqual(snapshot.bindings, []);
  assert.deepEqual(snapshot.unboundAliasDirs, []);
  assert.equal(snapshot.deadLetterCount, 0);
  const text = formatStatus(snapshot);
  assert.match(text, /service: NOT RUNNING/);
  assert.match(text, /bindings: none/);
});

test("status snapshot: bindings, queues, rollouts, stale lease, dead letters, unbound dirs", () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  setBindingEnabled("review", false, { env });
  writeRollout(env, THREAD);
  // Pending + staged files.
  mkdirSync(codexInboxDir("review", env), { recursive: true });
  writeFileSync(join(codexInboxDir("review", env), "msg-a.json"), "{}");
  mkdirSync(codexPendingAckDir("review", env), { recursive: true });
  writeFileSync(join(codexPendingAckDir("review", env), "msg-b.json"), "{}");
  writeFileSync(join(codexPendingAckDir("review", env), "msg-b.meta.json"), "{}");
  // Unbound alias dir with a pending message.
  mkdirSync(join(inboxRoot(env), "codex", "ghost"), { recursive: true });
  writeFileSync(join(inboxRoot(env), "codex", "ghost", "msg-c.json"), "{}");
  // Dead letter.
  mkdirSync(exhaustedDir(env), { recursive: true });
  writeFileSync(join(exhaustedDir(env), "old_msg.json"), "{}");
  // Stale lease (dead pid).
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({ pid: 999999999, token: "x", updatedAt: Date.now() }));

  const snapshot = buildStatusSnapshot({ env });
  assert.equal(snapshot.service.running, false);
  assert.equal(snapshot.service.staleLease, true);
  const b = snapshot.bindings[0];
  assert.equal(b.alias, "review");
  assert.equal(b.enabled, false);
  assert.equal(b.pendingInbox, 1);
  assert.equal(b.staged, 1, "meta sidecars are not counted as staged messages");
  assert.equal(b.rolloutFound, true);
  assert.deepEqual(snapshot.unboundAliasDirs, [{ alias: "ghost", pending: 1 }]);
  assert.equal(snapshot.deadLetterCount, 1);

  const text = formatStatus(snapshot);
  assert.match(text, /stale lease/);
  assert.match(text, /codex\/review -> thread/);
  assert.match(text, /pending=1 staged=1/);
  assert.match(text, /ghost.*NO binding/);
  assert.match(text, /dead letters: 1/);
});

test("status: fresh lease reports running with pid", () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.pid, token: "me", version: CHANNEL_VERSION, startedAt: Date.now(), updatedAt: Date.now(),
  }));
  const snapshot = buildStatusSnapshot({ env });
  assert.equal(snapshot.service.running, true);
  assert.equal(snapshot.service.pid, process.pid);
  assert.match(formatStatus(snapshot), new RegExp(`RUNNING \\(pid ${process.pid}`));
});

test("status/doctor surface a durable unverified App Server teardown fence", () => {
  const env = makeEnv();
  mkdirSync(join(serviceTeardownPoisonPath(env), ".."), { recursive: true });
  writeFileSync(serviceTeardownPoisonPath(env), JSON.stringify({
    version: 1,
    pid: 424242,
    error: "taskkill failed",
    createdAt: new Date().toISOString(),
  }));
  const snapshot = buildStatusSnapshot({ env });
  assert.equal(snapshot.service.teardownPoisoned, true);
  assert.match(formatStatus(snapshot), /service: BLOCKED.*unverified prior App Server teardown/i);
  const byName = Object.fromEntries(runDoctor({ env }).checks.map((check) => [check.name, check]));
  assert.equal(byName.appserver_teardown_fence.ok, false);
  assert.match(byName.appserver_teardown_fence.detail, /verify\/reboot/i);
  assert.equal(byName.service_lease.ok, false);
});

test("doctor: flags missing codex home, missing rollout, missing MCP registration, no daemon with bindings", () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const { checks } = runDoctor({ env });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName.codex_home.ok, false, "no CODEX_HOME dir yet");
  assert.equal(byName["rollout:review"].ok, false);
  assert.match(byName["rollout:review"].detail, /thread_not_found/);
  assert.equal(byName.service_lease.ok, false);
  assert.match(byName.service_lease.detail, /codex service ensure/);
  assert.equal(byName.codex_mcp_registration.ok, false);
  assert.equal(byName.dead_letters.ok, true);
});

test("doctor: healthy environment passes all checks", () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeRollout(env, THREAD);
  writeFileSync(join(codexHome(env), "config.toml"), [
    "[mcp_servers.agent-bridge]",
    'command = "node"',
    'args = ["/Users/x/Projects/agent-bridge/mcp-server/build/index.js"]',
  ].join("\n"));
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.pid, token: "me", version: CHANNEL_VERSION, startedAt: Date.now(), updatedAt: Date.now(),
  }));
  const result = runDoctor({ env });
  const failing = result.checks.filter((c) => !c.ok);
  assert.deepEqual(failing, []);
  assert.match(formatDoctor(result), /all checks passed/);
});

test("doctor: unbound alias dirs and dead letters fail their checks", () => {
  const env = makeEnv();
  mkdirSync(join(inboxRoot(env), "codex", "ghost"), { recursive: true });
  writeFileSync(join(inboxRoot(env), "codex", "ghost", "msg.json"), "{}");
  mkdirSync(exhaustedDir(env), { recursive: true });
  writeFileSync(join(exhaustedDir(env), "dead.json"), "{}");
  const { checks } = runDoctor({ env });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName["unbound_inbox:ghost"].ok, false);
  assert.equal(byName.dead_letters.ok, false);
});

test("platform: every derived path stays under the AGENT_BRIDGE_HOME sandbox", () => {
  const env = makeEnv();
  for (const path of [
    codexInboxDir("a", env),
    codexPendingAckDir("a", env),
    exhaustedDir(env),
    serviceLeasePath(env),
    inboxRoot(env),
  ]) {
    assert.ok(path.startsWith(env.AGENT_BRIDGE_HOME), `${path} must live under the sandbox`);
  }
  assert.ok(codexSessionsDir(env).startsWith(env.CODEX_HOME));
});

test("platform: bridge home normalization covers tilde, both separators, and Windows casing", () => {
  const unixHome = "/Users/bridge-test";
  const unixCases = [
    ["~", join(unixHome, ".agent-bridge")],
    ["~/state/", join(unixHome, "state", ".agent-bridge")],
    ["~\\state\\", join(unixHome, "state", ".agent-bridge")],
    [`${join(unixHome, ".agent-bridge")}\\/`, join(unixHome, ".agent-bridge")],
  ];
  for (const [override, expected] of unixCases) {
    assert.equal(bridgeHome({ HOME: unixHome, AGENT_BRIDGE_HOME: override }, "linux"), expected, override);
  }

  const windowsHome = "C:\\Users\\BridgeTest";
  assert.equal(
    bridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "~\\state\\" }, "win32"),
    win32.join(windowsHome, "state", ".agent-bridge"),
  );
  assert.equal(
    bridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "D:\\Bridge\\.AGENT-BRIDGE\\/" }, "win32"),
    "D:\\Bridge\\.AGENT-BRIDGE",
    "Windows terminal state-dir matching is case-insensitive",
  );
  assert.equal(
    bridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "\\\\server\\share\\state" }, "win32"),
    "\\\\server\\share\\state\\.agent-bridge",
    "complete UNC roots are stable",
  );

  for (const rejected of ["state", "../state"]) {
    assert.throws(
      () => bridgeHome({ HOME: unixHome, AGENT_BRIDGE_HOME: rejected }, "linux"),
      /must resolve to an absolute path/,
      rejected,
    );
  }
  for (const rejected of ["state", "C:state", "\\state", "\\\\server"]) {
    assert.throws(
      () => bridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: rejected }, "win32"),
      /must resolve to an absolute path/,
      rejected,
    );
  }
});
