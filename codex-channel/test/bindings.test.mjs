import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPROVAL_POLICIES,
  DEFAULT_POLICY,
  SANDBOX_MODES,
  bindAlias,
  getBinding,
  isBroadWindowsWorkspaceRoot,
  isValidAlias,
  isValidThreadId,
  listBindings,
  listEnabledBindings,
  loadRegistry,
  normalizeBindingCwd,
  saveRegistry,
  setBindingEnabled,
  unbindAlias,
  withRegistryLock,
} from "../src/bindings.js";
import { bindingsFilePath } from "../src/paths.js";

const THREAD_A = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD_B = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";

function sandboxEnv() {
  const home = mkdtempSync(join(tmpdir(), "ab-codex-bindings-"));
  return { AGENT_BRIDGE_HOME: join(home, ".agent-bridge") };
}

test("alias validation accepts sane names and rejects path-shaped ones", () => {
  assert.equal(isValidAlias("release-review"), true);
  assert.equal(isValidAlias("main"), true);
  assert.equal(isValidAlias("Bot_2.beta"), true);
  assert.equal(isValidAlias(""), false);
  assert.equal(isValidAlias("a/b"), false);
  assert.equal(isValidAlias("a\\b"), false);
  assert.equal(isValidAlias("..evil"), false);
  assert.equal(isValidAlias(".hidden"), false);
  assert.equal(isValidAlias("-lead"), false);
  assert.equal(isValidAlias("trail-"), false);
  assert.equal(isValidAlias("x".repeat(129)), false);
  assert.equal(isValidAlias("e\u0301quipe"), false, "aliases must use canonical NFC form");
  assert.equal(isValidAlias("σ"), false, "portable Codex aliases exclude Unicode filesystem-fold ambiguity");
  assert.equal(isValidAlias("ς"), false, "APFS/NTFS-equivalent Unicode aliases cannot become directories");
  for (const reserved of ["CON", "con.txt", "PrN", "AUX.log", "NUL", "COM1", "com9.data", "LPT1", "lpt9.txt"]) {
    assert.equal(isValidAlias(reserved), false, `${reserved} is a Windows device basename`);
  }
  assert.equal(isValidAlias("com10"), true);
});

test("thread id validation is uuid-shaped, case-insensitive", () => {
  assert.equal(isValidThreadId(THREAD_A), true);
  assert.equal(isValidThreadId(THREAD_A.toUpperCase()), true);
  assert.equal(isValidThreadId("not-a-uuid"), false);
  assert.equal(isValidThreadId("0199aaaa-bbbb-4ccc-8ddd"), false);
});

test("Windows broad-root predicate is host-independent, exact, and case-insensitive", () => {
  const env = {
    SystemRoot: "D:\\CustomWindows",
    ProgramData: "E:\\CompanyData",
    ProgramFiles: "F:\\Applications",
    "ProgramFiles(x86)": "F:\\Applications x86",
    USERPROFILE: "G:\\People\\Ethan",
  };
  for (const broad of [
    "C:\\Users",
    "c:/WINDOWS/",
    "C:\\Program Files",
    "C:\\Program Files (x86)\\",
    "C:\\ProgramData",
    "\\\\?\\C:\\Windows",
    "d:\\customwindows",
    "E:/CompanyData/",
    "F:\\APPLICATIONS",
    "F:\\Applications x86",
    "G:\\People",
  ]) {
    assert.equal(isBroadWindowsWorkspaceRoot(broad, { env }), true, broad);
  }
  for (const project of [
    "C:\\Users\\Ethan\\project",
    "C:\\Windows\\Temp\\project",
    "E:\\CompanyData\\project",
    "F:\\Applications\\tool\\project",
    "\\\\server\\share\\project",
  ]) {
    assert.equal(isBroadWindowsWorkspaceRoot(project, { env }), false, project);
  }
});

test("cwd validation canonicalizes project dirs and rejects relative/filesystem/home/drive/UNC roots", () => {
  const env = sandboxEnv();
  const home = dirname(env.AGENT_BRIDGE_HOME);
  const project = join(home, "projects", "safe-project");
  mkdirSync(project, { recursive: true });
  const projectLink = join(home, "project-link");
  symlinkSync(project, projectLink);
  assert.equal(normalizeBindingCwd(projectLink, { env: { ...env, HOME: home } }), realpathSync(project));
  assert.throws(() => normalizeBindingCwd("relative/project", { env }), /absolute/);
  assert.throws(() => normalizeBindingCwd("/", { env }), /filesystem root/);
  assert.throws(() => normalizeBindingCwd(home, { env: { ...env, HOME: home } }), /broad root/);
  assert.throws(() => normalizeBindingCwd("C:\\", { env }), /filesystem root/);
  assert.throws(() => normalizeBindingCwd("\\\\server\\share\\", { env }), /filesystem root/);
  for (const broad of ["C:\\Users", "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]) {
    assert.throws(() => normalizeBindingCwd(broad, { env }), /broad Windows root/);
  }
  assert.throws(
    () => normalizeBindingCwd("D:\\CompanyData", { env: { ...env, ProgramData: "D:\\CompanyData" } }),
    /broad Windows root/,
  );
  const rootLink = join(home, "root-link");
  symlinkSync("/", rootLink);
  assert.throws(() => normalizeBindingCwd(rootLink, { env }), /filesystem root/);
});

test("cwd validation rejects canonical aliases of POSIX broad roots", { skip: process.platform === "win32" }, () => {
  const env = sandboxEnv();
  const home = dirname(env.AGENT_BRIDGE_HOME);
  assert.throws(() => normalizeBindingCwd("/tmp", { env }), /broad root/);
  assert.throws(() => normalizeBindingCwd("/etc", { env }), /broad root/);
  for (const target of ["/tmp", "/etc"]) {
    const link = join(home, `project-link-${target.slice(1)}`);
    symlinkSync(target, link);
    assert.throws(
      () => normalizeBindingCwd(link, { env }),
      /resolves to broad root/,
      `${link} must not make ${target} a workspace-write root`,
    );
  }
});

test("cwd validation rejects a Windows junction whose canonical target is a broad root", { skip: process.platform !== "win32" }, (t) => {
  const target = [
    process.env.SystemRoot,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env.USERPROFILE ? dirname(process.env.USERPROFILE) : null,
  ].find((candidate) => typeof candidate === "string" && existsSync(candidate));
  if (!target) {
    t.skip("no existing configured Windows broad root is available");
    return;
  }
  const temp = mkdtempSync(join(tmpdir(), "ab-codex-junction-"));
  const junction = join(temp, "project-junction");
  try {
    try {
      symlinkSync(target, junction, "junction");
    } catch (err) {
      t.skip(`junction creation unavailable: ${String(err?.code ?? err?.message ?? err)}`);
      return;
    }
    assert.throws(
      () => normalizeBindingCwd(junction, { env: process.env }),
      /resolves to broad Windows root/,
    );
  } finally {
    try { rmdirSync(junction); } catch { /* absent or unavailable junction */ }
    try { rmdirSync(temp); } catch { /* best-effort test cleanup */ }
  }
});

test("unsafe cwd in a persisted registry is disabled and cannot survive a policy-only rebind", () => {
  const env = sandboxEnv();
  const path = bindingsFilePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    bindings: {
      legacy: {
        alias: "legacy",
        threadId: THREAD_A,
        cwd: "/",
        enabled: true,
        policy: DEFAULT_POLICY,
      },
    },
  }));
  const loaded = getBinding("legacy", { env });
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.cwd, null);
  assert.equal(loaded.invalidCwd, "/");
  assert.throws(
    () => bindAlias({ alias: "legacy", threadId: THREAD_A, rebind: true, policy: { sandbox: "read-only" }, env }),
    /unsafe\/invalid persisted cwd/,
  );
});

test("bind + get + list round-trips with defaults and normalized thread id", () => {
  const env = sandboxEnv();
  const projectDir = join(dirname(bindingsFilePath(env)), "project-x");
  mkdirSync(projectDir, { recursive: true });
  const { binding } = bindAlias({ alias: "review", threadId: THREAD_A.toUpperCase(), cwd: projectDir, env });
  assert.equal(binding.threadId, THREAD_A);
  assert.deepEqual(binding.policy, { ...DEFAULT_POLICY });
  const fetched = getBinding("review", { env });
  assert.equal(fetched.threadId, THREAD_A);
  assert.equal(fetched.cwd, realpathSync(projectDir));
  assert.equal(listBindings({ env }).length, 1);
  assert.equal(listEnabledBindings({ env }).length, 1);
});

test("duplicate alias requires rebind; rebind preserves createdAt and replaces thread", () => {
  const env = sandboxEnv();
  const first = bindAlias({ alias: "review", threadId: THREAD_A, env }).binding;
  assert.throws(() => bindAlias({ alias: "review", threadId: THREAD_B, env }), /already bound/);
  const { binding, replaced } = bindAlias({ alias: "review", threadId: THREAD_B, rebind: true, env });
  assert.equal(binding.threadId, THREAD_B);
  assert.equal(replaced.threadId, THREAD_A);
  assert.equal(binding.createdAt, first.createdAt);
});

test("aliases cannot collide by case-folded filesystem identity", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "Review", threadId: THREAD_A, env });
  assert.throws(
    () => bindAlias({ alias: "review", threadId: THREAD_B, env }),
    /collides with existing alias "Review"/,
  );
  assert.equal(getBinding("Review", { env }).threadId, THREAD_A);
  assert.equal(getBinding("review", { env }), null);
});

test("one thread across two aliases is rejected unless --allow-shared-thread", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "a", threadId: THREAD_A, env });
  assert.throws(() => bindAlias({ alias: "b", threadId: THREAD_A, env }), /already bound to alias "a"/);
  const { binding } = bindAlias({ alias: "b", threadId: THREAD_A, allowSharedThread: true, env });
  assert.equal(binding.alias, "b");
});

test("policy inputs: invalid approvalPolicy is REJECTED with the supported set; invalid sandbox falls back", () => {
  const env = sandboxEnv();
  assert.throws(
    () => bindAlias({ alias: "p", threadId: THREAD_A, policy: { approvalPolicy: "yolo" }, env }),
    /approvalPolicy must be one of: never, on-request, untrusted/,
  );
  assert.throws(
    () => bindAlias({ alias: "p", threadId: THREAD_A, policy: { approvalPolicy: "on-failure" }, env }),
    /not a Codex 0\.145 policy/,
    "legacy on-failure is rejected with a clear migration message",
  );
  const { binding } = bindAlias({
    alias: "p",
    threadId: THREAD_A,
    policy: { steering: true, sandbox: "nonsense", turnTimeoutMs: -5, ownershipGuard: false },
    env,
  });
  assert.equal(binding.policy.steering, true);
  assert.equal(binding.policy.ownershipGuard, false);
  assert.equal(binding.policy.sandbox, DEFAULT_POLICY.sandbox);
  assert.equal(binding.policy.approvalPolicy, DEFAULT_POLICY.approvalPolicy);
  assert.equal(binding.policy.turnTimeoutMs, null);
  assert.ok(SANDBOX_MODES.includes(binding.policy.sandbox));
  assert.ok(APPROVAL_POLICIES.includes(binding.policy.approvalPolicy));
  assert.equal(APPROVAL_POLICIES.includes("on-failure"), false, "unsupported policy removed from the set");
});

test("legacy REGISTRY values (e.g. on-failure) migrate to the safe default on load", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "legacy", threadId: THREAD_A, env });
  const path = bindingsFilePath(env);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  parsed.bindings.legacy.policy.approvalPolicy = "on-failure";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  const loaded = getBinding("legacy", { env });
  assert.equal(loaded.policy.approvalPolicy, "never", "invalid stored policy migrates to the safe default");
});

test("unbind removes; enable/disable toggles without deleting", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "t", threadId: THREAD_A, env });
  const disabled = setBindingEnabled("t", false, { env });
  assert.equal(disabled.enabled, false);
  assert.equal(listEnabledBindings({ env }).length, 0);
  assert.equal(listBindings({ env }).length, 1);
  setBindingEnabled("t", true, { env });
  assert.equal(listEnabledBindings({ env }).length, 1);
  const removed = unbindAlias("t", { env });
  assert.equal(removed.threadId, THREAD_A);
  assert.equal(listBindings({ env }).length, 0);
  assert.equal(unbindAlias("t", { env }), null);
});

test("invalid alias / thread inputs throw actionable errors", () => {
  const env = sandboxEnv();
  assert.throws(() => bindAlias({ alias: "a/b", threadId: THREAD_A, env }), /Invalid alias/);
  assert.throws(() => bindAlias({ alias: "ok", threadId: "nope", env }), /Invalid Codex thread id/);
});

test("corrupt registry: read-only loads report WITHOUT touching the file; mutations preserve bytes aside", () => {
  const env = sandboxEnv();
  const path = bindingsFilePath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ this is not json", "utf8");
  // Read-only load: NO side effects, corruption reported via flag.
  const readOnly = loadRegistry({ env });
  assert.deepEqual(readOnly.registry.bindings, {});
  assert.equal(readOnly.corruptDetected, true);
  assert.equal(readOnly.corruptMovedTo, null);
  assert.match(readFileSync(path, "utf8"), /not json/, "read-only load must not move/modify the corrupt file");
  // Mutation (under the lock): bytes preserved aside, then the bind lands.
  bindAlias({ alias: "fresh", threadId: THREAD_A, env });
  assert.equal(getBinding("fresh", { env }).threadId, THREAD_A);
  const aside = readdirSync(join(path, "..")).filter((n) => n.startsWith("bindings.json.corrupt-"));
  assert.equal(aside.length, 1, "corrupt bytes preserved, never silently clobbered");
  assert.match(readFileSync(join(path, "..", aside[0]), "utf8"), /not json/);
});

test("registry lock: a FRESH foreign lock blocks mutations (bounded, actionable error) and is never stolen", () => {
  const env = sandboxEnv();
  const lockPath = join(bindingsFilePath(env), "..", "bindings.lock");
  mkdirSync(join(lockPath, ".."), { recursive: true });
  // A live pid (our parent) holding a YOUNG lock: must not be stolen.
  writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, token: "live", startedAt: Date.now() }));
  assert.throws(
    () => withRegistryLock(() => "never runs", { env, timeoutMs: 300 }),
    /registry is locked by pid/,
  );
  assert.match(readFileSync(lockPath, "utf8"), /"token":"live"/, "live lock left intact");
});

test("registry lock: stale locks (dead owner, old) are recovered without touching live ones", () => {
  const env = sandboxEnv();
  const lockPath = join(bindingsFilePath(env), "..", "bindings.lock");
  mkdirSync(join(lockPath, ".."), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: "dead", startedAt: Date.now() - 60_000 }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);
  const result = withRegistryLock(() => "ran", { env, timeoutMs: 2000 });
  assert.equal(result, "ran");
  // And the lock is released afterwards.
  bindAlias({ alias: "after", threadId: THREAD_A, env });
  assert.equal(getBinding("after", { env }).threadId, THREAD_A);
});

test("unreadable-but-existing registry FAILS mutations closed (never clobbered to empty)", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "keep", threadId: THREAD_A, env });
  const path = bindingsFilePath(env);
  // Make the file unreadable by replacing it with a directory of the same
  // name (portable simulation of an unreadable path — EISDIR on read).
  const bytes = readFileSync(path, "utf8");
  unlinkSync(path);
  mkdirSync(path);
  assert.throws(() => bindAlias({ alias: "clobber", threadId: THREAD_B, env }), /unreadable|refusing/i);
  // Restore and confirm the original data was never lost.
  rmdirSync(path);
  writeFileSync(path, bytes, "utf8");
  assert.equal(getBinding("keep", { env }).threadId, THREAD_A);
});

test("registry entries failing validation are dropped on load, valid ones survive", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "good", threadId: THREAD_A, env });
  const path = bindingsFilePath(env);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  parsed.bindings["bad/alias"] = { alias: "bad/alias", threadId: THREAD_B };
  parsed.bindings.badthread = { alias: "badthread", threadId: "zzz" };
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  const list = listBindings({ env });
  assert.equal(list.length, 1);
  assert.equal(list[0].alias, "good");
});

test("saves are atomic: no temp files left behind, file always parseable", () => {
  const env = sandboxEnv();
  bindAlias({ alias: "one", threadId: THREAD_A, env });
  bindAlias({ alias: "two", threadId: THREAD_B, env });
  const dir = join(bindingsFilePath(env), "..");
  const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  const parsed = JSON.parse(readFileSync(bindingsFilePath(env), "utf8"));
  assert.equal(Object.keys(parsed.bindings).length, 2);
  assert.equal(parsed.version, 1);
});

test("saveRegistry surface is usable directly for migrations/tools", () => {
  const env = sandboxEnv();
  const { registry } = loadRegistry({ env });
  registry.bindings.x = {
    alias: "x", threadId: THREAD_A, cwd: null, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    boundBy: "test", policy: { ...DEFAULT_POLICY },
  };
  saveRegistry(registry, { env });
  assert.equal(getBinding("x", { env }).threadId, THREAD_A);
});
