/**
 * 4.10.0 [CODEX-CHANNEL] — MCP-side Codex lifecycle + outbound identity tests.
 *
 * Runs against the compiled build output (the repo's standard mcp-server test
 * posture: `npm test` builds first). Covers:
 *   - resolveDefaultFromTarget precedence: bound Claude persona > valid
 *     AGENT_BRIDGE_FROM_TARGET > legacy claude-code/default.
 *   - the LAZY codex runtime loader: candidate ordering (explicit
 *     AGENT_BRIDGE_SOURCE_DIR first), repo-layout resolution, cached support.
 *   - performCodexBind end-to-end through the loader (same canonical
 *     codex-channel modules the CLI uses).
 *
 * The "runtime absent" degradation path is proven by the separate
 * packaging-isolated test, which starts the server from a copy with no
 * codex-channel anywhere.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep, win32 } from "node:path";
import { formatCodexEnsureStatus, resolveDefaultFromTarget } from "../build/tools.js";
import {
  codexBindingsPath,
  codexEnsureRequired,
  codexPendingSettingsDir,
  codexRuntimeCandidates,
  codexServiceScriptCandidates,
  getCodexSupport,
  performCodexBind,
  resolveBridgeHome,
  resolveCodexThreadId,
} from "../build/codex.js";
import { setActivePersona } from "../build/inbox.js";

const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD2 = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";

function makeEnv(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-codex-"));
  return {
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    CODEX_HOME: join(root, ".codex"),
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
    ...extra,
  };
}

function writeRollout(env, threadId) {
  const dir = join(env.CODEX_HOME, "sessions", "2026", "08", "07");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-08-07T10-00-00-${threadId}.jsonl`), "{}\n");
}

// NOTE: persona state is module-global in build/inbox.js. The persona-bound
// case is tested LAST so earlier cases observe the unbound (tools-only) state.

test("resolveDefaultFromTarget: tools-only without env falls back to claude-code/default", () => {
  assert.equal(resolveDefaultFromTarget({}), "claude-code/default");
});

test("resolveDefaultFromTarget: valid AGENT_BRIDGE_FROM_TARGET wins in tools-only mode", () => {
  assert.equal(
    resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "codex/release-review" }),
    "codex/release-review",
  );
  assert.equal(
    resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "  codex/main  " }),
    "codex/main",
    "value is trimmed",
  );
});

test("resolveDefaultFromTarget: invalid env values fall back safely", () => {
  assert.equal(resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "../evil" }), "claude-code/default");
  assert.equal(resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "a//b" }), "claude-code/default");
  assert.equal(resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "" }), "claude-code/default");
});

test("resolveCodexThreadId: explicit arg beats env; env is best-effort; neither => null", () => {
  assert.deepEqual(resolveCodexThreadId(THREAD, { CODEX_THREAD_ID: "other" }), { threadId: THREAD, source: "arg" });
  assert.deepEqual(
    resolveCodexThreadId(undefined, { CODEX_THREAD_ID: THREAD.toUpperCase() }),
    { threadId: THREAD, source: "env" },
  );
  assert.deepEqual(resolveCodexThreadId(undefined, {}), { threadId: null, source: null });
});

test("formatCodexEnsureStatus renders unhealthy outcomes as warnings without inferring health from pid", () => {
  assert.equal(
    formatCodexEnsureStatus({ healthy: false, message: "pid 42 ownership could not be verified" }),
    "WARNING: pid 42 ownership could not be verified",
  );
  assert.equal(
    formatCodexEnsureStatus({ healthy: true, message: "codex-channel service spawned (pid 43)" }),
    "codex-channel service spawned (pid 43)",
  );
});

test("codexRuntimeCandidates: AGENT_BRIDGE_SOURCE_DIR override is FIRST; repo layout + installed runtime follow", () => {
  const override = `${sep}explicit${sep}checkout`;
  const withOverride = codexRuntimeCandidates({ AGENT_BRIDGE_SOURCE_DIR: override });
  assert.equal(withOverride[0], join(override, "codex-channel"));
  const plain = codexRuntimeCandidates({});
  assert.ok(plain.some((c) => c.endsWith(join("agent-bridge-codex-channel", "codex-channel")) || c.includes("codex-channel")),
    "repo-relative candidate present");
  assert.ok(plain.some((c) => c.includes(join(".agent-bridge", "runtime", "codex-channel"))),
    "installed runtime candidate present");
});

test("bridge-home resolution normalizes state/parent, tilde, separators, and Windows casing", () => {
  const stateDir = join(sep + "custom", ".agent-bridge");
  assert.equal(resolveBridgeHome({ AGENT_BRIDGE_HOME: stateDir }), stateDir, "state-dir override used as-is");
  assert.equal(
    resolveBridgeHome({ AGENT_BRIDGE_HOME: join(sep + "custom", "homeish") }),
    join(sep + "custom", "homeish", ".agent-bridge"),
    "parent-home override is normalized",
  );
  const viaHome = resolveBridgeHome({ HOME: join(sep + "unix", "user") });
  assert.equal(viaHome, join(sep + "unix", "user", ".agent-bridge"));
  const viaProfile = resolveBridgeHome({ USERPROFILE: join(sep + "win", "user") });
  assert.equal(viaProfile, join(sep + "win", "user", ".agent-bridge"));

  const unixHome = join(sep + "users", "bridge-test");
  const matrix = [
    ["~", join(unixHome, ".agent-bridge")],
    ["~/state/", join(unixHome, "state", ".agent-bridge")],
    ["~\\state\\", join(unixHome, "state", ".agent-bridge")],
    [`${join(unixHome, ".agent-bridge")}\\/`, join(unixHome, ".agent-bridge")],
  ];
  for (const [override, expected] of matrix) {
    assert.equal(resolveBridgeHome({ HOME: unixHome, AGENT_BRIDGE_HOME: override }, "linux"), expected, override);
  }

  const windowsHome = "C:\\Users\\BridgeTest";
  assert.equal(
    resolveBridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "~\\state\\" }, "win32"),
    win32.join(windowsHome, "state", ".agent-bridge"),
  );
  assert.equal(
    resolveBridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "D:\\Bridge\\.AGENT-BRIDGE\\/" }, "win32"),
    "D:\\Bridge\\.AGENT-BRIDGE",
    "Windows terminal state-dir matching is case-insensitive",
  );
  assert.equal(
    resolveBridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: "\\\\server\\share\\state" }, "win32"),
    "\\\\server\\share\\state\\.agent-bridge",
    "complete UNC roots are stable",
  );
  for (const rejected of ["state", "../state"]) {
    assert.throws(
      () => resolveBridgeHome({ HOME: unixHome, AGENT_BRIDGE_HOME: rejected }, "linux"),
      /must resolve to an absolute path/,
      rejected,
    );
  }
  for (const rejected of ["state", "C:state", "\\state", "\\\\server"]) {
    assert.throws(
      () => resolveBridgeHome({ USERPROFILE: windowsHome, AGENT_BRIDGE_HOME: rejected }, "win32"),
      /must resolve to an absolute path/,
      rejected,
    );
  }
  assert.equal(
    codexBindingsPath({ AGENT_BRIDGE_HOME: stateDir }),
    join(stateDir, "codex", "bindings.json"),
    "startup bindings gate follows the resolved bridge home",
  );
});

test("installed-runtime-only discovery: service-script candidates cover the runtime snapshot under an OVERRIDDEN bridge home", () => {
  const env = { AGENT_BRIDGE_HOME: join(sep + "sandbox", ".agent-bridge"), HOME: join(sep + "sandbox") };
  const scripts = codexServiceScriptCandidates(env);
  assert.ok(
    scripts.includes(join(sep + "sandbox", ".agent-bridge", "runtime", "codex-channel", "service.mjs")),
    "no-checkout installs must be able to restart the daemon from the installed runtime",
  );
  // And every candidate is a service.mjs entrypoint.
  for (const script of scripts) assert.ok(script.endsWith(join("codex-channel", "service.mjs")));
});

test("codexEnsureRequired: enabled bindings OR pending settings journals require supervision", () => {
  const env = makeEnv();
  const bindingsPath = codexBindingsPath(env);
  mkdirSync(dirname(bindingsPath), { recursive: true });

  writeFileSync(bindingsPath, JSON.stringify({ bindings: { paused: { enabled: false } } }));
  assert.equal(codexEnsureRequired(env), false, "all-disabled registry alone stays stopped");

  writeFileSync(bindingsPath, JSON.stringify({ bindings: { active: { enabled: true } } }));
  assert.equal(codexEnsureRequired(env), true, "enabled binding requires delivery daemon");

  writeFileSync(bindingsPath, JSON.stringify({ bindings: {} }));
  const pendingDir = codexPendingSettingsDir(env);
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, "removed-alias.json"), "{}");
  assert.equal(codexEnsureRequired(env), true, "journal-only recovery survives disable/unbind");
});

test("getCodexSupport resolves the repo runtime and is cached", async () => {
  const support = await getCodexSupport(process.env);
  assert.equal(typeof support.bindAlias, "function");
  assert.equal(typeof support.buildStatusSnapshot, "function");
  assert.equal(typeof support.describeEnsureResult, "function");
  assert.ok(Array.isArray([...support.APPROVAL_POLICIES]));
  assert.equal(support.APPROVAL_POLICIES.includes("on-failure"), false, "unsupported policy not exposed");
  const again = await getCodexSupport(process.env);
  assert.equal(support, again, "loader caches the resolved runtime");
});

test("performCodexBind: env-discovered thread id binds and is visible via status/list", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const outcome = await performCodexBind({ alias: "review", noEnsure: true, env });
  assert.equal(outcome.binding.threadId, THREAD);
  assert.equal(outcome.threadIdSource, "env");
  assert.equal(outcome.target, "codex/review");
  assert.equal(outcome.rolloutFound, true);
  assert.equal(outcome.binding.policy.approvalPolicy, "never");
  assert.equal(outcome.binding.policy.sandbox, "workspace-write");

  const support = await getCodexSupport(env);
  assert.equal(support.getBinding("review", { env }).threadId, THREAD);
  assert.equal(support.listBindings({ env }).length, 1);
  const snapshot = support.buildStatusSnapshot({ env });
  assert.equal(snapshot.bindings[0].target, "codex/review");
  assert.equal(snapshot.service.running, false);

  const removed = support.unbindAlias("review", { env });
  assert.equal(removed.threadId, THREAD);
  assert.equal(support.listBindings({ env }).length, 0);
});

test("performCodexBind: omitted alias derives, persists, and reuses the task-name target", async () => {
  const env = makeEnv({
    CODEX_THREAD_ID: THREAD,
    AGENT_BRIDGE_CODEX_THREAD_NAME: "Fleet Review",
  });
  writeRollout(env, THREAD);
  writeRollout(env, THREAD2);

  const first = await performCodexBind({ noEnsure: true, env });
  assert.equal(first.binding.alias, "fleet-review");
  assert.equal(first.target, "codex/fleet-review");
  assert.equal(first.aliasAutomatic, true);
  assert.equal(first.aliasSource, "thread-name");
  assert.equal(first.aliasTitle, "Fleet Review");

  env.AGENT_BRIDGE_CODEX_THREAD_NAME = "Renamed Later";
  const again = await performCodexBind({ noEnsure: true, env });
  assert.equal(again.binding.alias, "fleet-review", "saved alias wins over later title changes");
  assert.equal(again.aliasSource, "existing-binding");

  env.CODEX_THREAD_ID = THREAD2;
  env.AGENT_BRIDGE_CODEX_THREAD_NAME = "Fleet Review";
  const collision = await performCodexBind({ noEnsure: true, env });
  assert.equal(collision.binding.alias, "fleet-review-ffff0002");
});

test("performCodexBind: no thread id anywhere => actionable error", async () => {
  const env = makeEnv();
  await assert.rejects(
    () => performCodexBind({ alias: "x", noEnsure: true, env }),
    /CODEX_THREAD_ID|thread_id/,
  );
});

test("performCodexBind: missing rollout requires force", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  await assert.rejects(
    () => performCodexBind({ alias: "x", noEnsure: true, env }),
    /No persisted rollout/,
  );
  const forced = await performCodexBind({ alias: "x", force: true, noEnsure: true, env });
  assert.equal(forced.rolloutFound, false);
  assert.equal(forced.binding.threadId, THREAD);
});

test("performCodexBind: danger-full-access is refused via MCP; legacy on-failure policy rejected", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  await assert.rejects(
    () => performCodexBind({ alias: "x", sandbox: "danger-full-access", noEnsure: true, env }),
    /CLI-only|--allow-danger|not allowed/,
  );
  await assert.rejects(
    () => performCodexBind({ alias: "x", approvalPolicy: "on-failure", noEnsure: true, env }),
    /approval_policy must be one of/,
  );
});

test("performCodexBind: MCP rebind cannot inherit CLI danger-full-access", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD2 });
  writeRollout(env, THREAD);
  writeRollout(env, THREAD2);
  const support = await getCodexSupport(env);
  support.bindAlias({
    alias: "danger-inherited",
    threadId: THREAD,
    policy: { sandbox: "danger-full-access" },
    boundBy: "cli(--allow-danger)",
    allowDanger: true,
    env,
  });
  await assert.rejects(
    () => performCodexBind({ alias: "danger-inherited", threadId: THREAD2, rebind: true, noEnsure: true, env }, support),
    /effective sandbox=danger-full-access|inheritance from an existing alias/,
  );
  assert.equal(support.getBinding("danger-inherited", { env }).threadId, THREAD, "rejected MCP mutation leaves registry unchanged");
  const safe = await performCodexBind({
    alias: "danger-inherited",
    threadId: THREAD2,
    sandbox: "workspace-write",
    rebind: true,
    noEnsure: true,
    env,
  }, support);
  assert.equal(safe.binding.threadId, THREAD2);
  assert.equal(safe.binding.policy.sandbox, "workspace-write");
});

test("performCodexBind: duplicate alias errors without rebind, succeeds with rebind", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  await performCodexBind({ alias: "dup", noEnsure: true, env });
  await assert.rejects(
    () => performCodexBind({ alias: "dup", noEnsure: true, env }),
    /already bound/,
  );
  const rebound = await performCodexBind({ alias: "dup", rebind: true, noEnsure: true, env });
  assert.equal(rebound.replaced.threadId, THREAD);
});

test("performCodexBind: AGENT_BRIDGE_CODEX_NO_ENSURE keeps the ensure path inert", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const outcome = await performCodexBind({ alias: "kill-switch", env });
  assert.equal(outcome.serviceEnsured.spawned, false);
  assert.equal(outcome.serviceEnsured.healthy, true);
  assert.match(outcome.serviceEnsured.message, /ensure skipped/);
});

test("performCodexBind: stale, unverified, and thrown ensure outcomes remain explicit warnings", async () => {
  const env = makeEnv({ CODEX_THREAD_ID: THREAD });
  writeRollout(env, THREAD);
  const base = await getCodexSupport(env);
  const cases = [
    {
      alias: "stale-service",
      ensured: { spawned: false, pid: 41, staleVersion: true },
      message: /older version/,
    },
    {
      alias: "unverified-service",
      ensured: { spawned: false, pid: 42, unverified: true },
      message: /could not be verified|refusing split-brain/,
    },
  ];
  for (const scenario of cases) {
    const support = { ...base, ensureService: async () => scenario.ensured };
    const outcome = await performCodexBind({ alias: scenario.alias, allowSharedThread: true, env }, support);
    assert.equal(outcome.serviceEnsured.healthy, false, scenario.alias);
    assert.match(outcome.serviceEnsured.message, scenario.message, scenario.alias);
    assert.equal(outcome.serviceEnsured.staleVersion, scenario.ensured.staleVersion, scenario.alias);
    assert.equal(outcome.serviceEnsured.unverified, scenario.ensured.unverified, scenario.alias);
  }

  const thrown = await performCodexBind(
    { alias: "ensure-error", allowSharedThread: true, env },
    { ...base, ensureService: async () => { throw new Error("spawn exploded"); } },
  );
  assert.equal(thrown.serviceEnsured.healthy, false);
  assert.equal(thrown.serviceEnsured.skipped, undefined, "ensure errors are not rewritten as benign skips");
  assert.equal(thrown.serviceEnsured.error, "spawn exploded");
  assert.match(thrown.serviceEnsured.message, /spawn exploded/);
});

test("resolveDefaultFromTarget: bound Claude persona always wins (runs last — global state)", () => {
  setActivePersona("yolo");
  assert.equal(
    resolveDefaultFromTarget({ AGENT_BRIDGE_FROM_TARGET: "codex/release-review" }),
    "claude-code/yolo",
    "a bound persona must never be overridden by the env identity",
  );
});
