import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindingsFilePath, serviceLeasePath } from "../src/paths.js";
import { withRegistryLock } from "../src/bindings.js";
import { withLeaseMutex } from "../src/service.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/stale-lock-contender.mjs", import.meta.url));
const CONTENDERS = 24;

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-stale-lock-"));
  return {
    ...process.env,
    HOME: root,
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
  };
}

function launchContender(mode, env, barrierPath, criticalPath, resultDir) {
  const child = spawn(process.execPath, [FIXTURE, mode, barrierPath, criticalPath, resultDir], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readySeen = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!readySeen && stdout.includes("ready\n")) {
      readySeen = true;
      readyResolve();
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      if (!readySeen) readyReject(new Error(`contender exited before ready: ${stderr || stdout}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { ready, done };
}

async function assertStaleRecoveryIsSingleton(mode) {
  const env = makeEnv();
  const root = dirname(env.AGENT_BRIDGE_HOME);
  const lockPath = mode === "registry"
    ? join(dirname(bindingsFilePath(env)), "bindings.lock")
    : `${serviceLeasePath(env)}.acquire`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: 999999999,
    token: "dead-stale-owner",
    startedAt: Date.now() - 60_000,
  }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath, past, past);

  const barrierPath = join(root, `${mode}.barrier`);
  const criticalPath = join(root, `${mode}.critical`);
  const resultDir = join(root, `${mode}.results`);
  mkdirSync(resultDir, { recursive: true });
  const contenders = Array.from({ length: CONTENDERS }, () =>
    launchContender(mode, env, barrierPath, criticalPath, resultDir));
  await Promise.all(contenders.map((entry) => entry.ready));
  writeFileSync(barrierPath, "go\n");
  const results = await Promise.all(contenders.map((entry) => entry.done));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || result.stdout || `signal=${result.signal}`);
  }
  const overlaps = readdirSync(resultDir).filter((name) => name.startsWith("overlap-"));
  assert.deepEqual(overlaps, [], `${mode} stale recovery admitted concurrent critical sections`);
}

test("registry stale-lock recovery elects one remover and never renames a fresh owner", async () => {
  await assertStaleRecoveryIsSingleton("registry");
});

test("lease-mutex stale-lock recovery elects one remover and never overlaps writers", async () => {
  await assertStaleRecoveryIsSingleton("lease");
});

test("a crashed recovery election fails closed instead of being auto-stolen", () => {
  for (const mode of ["registry", "lease"]) {
    const env = makeEnv();
    const lockPath = mode === "registry"
      ? join(dirname(bindingsFilePath(env)), "bindings.lock")
      : `${serviceLeasePath(env)}.acquire`;
    const recoveryPath = `${lockPath}.recovery`;
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      pid: 999999999,
      token: "crashed-recovery-owner",
      startedAt: Date.now() - 60_000,
    }));
    const run = mode === "registry"
      ? () => withRegistryLock(() => "unsafe", { env, timeoutMs: 100 })
      : () => withLeaseMutex(env, () => "unsafe", { timeoutMs: 100 });
    assert.throws(run, /stale-lock recovery/);
    assert.equal(readdirSync(dirname(lockPath)).includes(basename(lockPath)), false,
      `${mode} must not publish the main lock through an unresolved recovery election`);
  }
});
