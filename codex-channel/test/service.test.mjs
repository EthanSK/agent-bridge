import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexAppServerClient } from "../src/app-server-client.js";
import { deliveredTombstonePath, indeterminateTombstonePath } from "../src/delivery.js";
import { bindAlias, setBindingEnabled, unbindAlias } from "../src/bindings.js";
import {
  acquireLease,
  describeEnsureResult,
  createService,
  ensureService,
  heartbeatLease,
  leaseFresh,
  makeLeaseDispatchFence,
  readLease,
  releaseLease,
  stopService,
  verifyLiveDaemon,
  waitForSpawnedDaemonReady,
} from "../src/service.js";
import { codexInboxDir, codexSessionsDir, pendingSettingsPath, serviceControlPath, serviceLeasePath, serviceTeardownPoisonPath, unroutedDir, inboxRoot } from "../src/paths.js";
import { CHANNEL_VERSION } from "../src/version.js";
import { createFakeAppServer, FAKE_USER_AGENT } from "./fake-app-server.mjs";

const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD2 = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";
const noop = () => {};

function makeEnv(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-service-"));
  return {
    AGENT_BRIDGE_HOME: join(root, ".agent-bridge"),
    CODEX_HOME: join(root, ".codex"),
    ...extra,
  };
}

function writeRollout(env, threadId, mtimeMs = Date.now()) {
  const dir = join(codexSessionsDir(env), "2026", "08", "07");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-07T10-00-00-${threadId}.jsonl`);
  writeFileSync(path, `{"thread":"${threadId}"}\n`);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

let msgN = 0;
function writeInbound(env, alias, overrides = {}) {
  msgN += 1;
  const msg = {
    id: `msg-svc${String(msgN).padStart(3, "0")}-aaaa-4bbb-8ccc-ddddeeee0000`,
    from: "Mac-Mini",
    to: "MBP",
    type: "message",
    content: `service payload ${msgN}`,
    timestamp: new Date().toISOString(),
    replyTo: null,
    ttl: 86400,
    target: `codex/${alias}`,
    fromTarget: "claude-code/default",
    ...overrides,
  };
  const dir = codexInboxDir(alias, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${msg.id}.json`), JSON.stringify(msg));
  return msg;
}

function writePendingSettingsJournal(env, alias, threadId) {
  const path = pendingSettingsPath(alias, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    state: "pending",
    token: `journal-${alias}`,
    alias,
    threadId,
    originalSettings: {
      cwd: "/before-bridge",
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
    // Matches createFakeAppServer's default resume response, representing
    // the bridge-applied values still active after a crash.
    expectedOverrides: {
      cwd: realpathSync(process.cwd()),
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [realpathSync(process.cwd())], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    },
    createdAt: new Date().toISOString(),
  }));
  return path;
}

function fakeClientFactory(fakes, options = {}) {
  return async () => {
    const safeCwd = realpathSync(process.cwd());
    const fake = createFakeAppServer({
      originalCwd: safeCwd,
      originalSandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [safeCwd],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      ...options,
    });
    fakes.push(fake);
    return new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "svc-test", clientVersion: "0" });
  };
}

// ── Lease semantics ─────────────────────────────────────────────────────────

test("lease: acquire -> heartbeat -> release lifecycle", () => {
  const env = makeEnv();
  const lease = acquireLease(env);
  assert.ok(lease);
  assert.equal(readLease(env).pid, process.pid);
  assert.equal(heartbeatLease(lease, env), true);
  assert.equal(leaseFresh(readLease(env)), true);
  releaseLease(lease, env);
  assert.equal(readLease(env), null);
});

test("lease: a fresh foreign holder blocks acquisition", () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  // process.ppid is a live pid that is not us — a legitimate foreign holder.
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.ppid,
    token: "foreign",
    version: CHANNEL_VERSION,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));
  assert.equal(acquireLease(env), null);
});

test("lease: corrupt or unreadable retained state fails closed across acquire, ensure, and stop", async () => {
  const env = makeEnv();
  const first = acquireLease(env);
  assert.ok(first);
  writeFileSync(serviceLeasePath(env), "{truncated");
  assert.equal(readLease(env).unreadable, true);
  assert.equal(acquireLease(env), null, "corrupt lease is never overwritten");
  let spawned = false;
  const ensured = await ensureService({
    env,
    logEvent: noop,
    spawnImpl: () => { spawned = true; return { pid: 1, unref: noop }; },
  });
  assert.equal(ensured.leaseUnreadable, true);
  assert.equal(spawned, false);
  assert.equal((await stopService({ env, logEvent: noop })).reason, "lease_unreadable");

  unlinkSync(serviceLeasePath(env));
  mkdirSync(serviceLeasePath(env));
  assert.equal(readLease(env).unreadable, true, "non-file lease is also fenced");
  assert.equal(acquireLease(env), null);
});

test("lease: dead holders are replaced, but a heartbeat-stale live PID still blocks split-brain takeover", () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: 999999999,
    token: "dead",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }));
  const lease = acquireLease(env);
  assert.ok(lease, "dead-pid lease must be stealable");
  releaseLease(lease, env);

  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.ppid,
    token: "stale-heartbeat",
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
  }));
  assert.equal(acquireLease(env), null, "a suspended live holder must never be replaced by heartbeat age alone");
});

test("lease: heartbeat detects replacement and refuses to overwrite", () => {
  const env = makeEnv();
  const lease = acquireLease(env);
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.pid, token: "replaced", startedAt: Date.now(), updatedAt: Date.now(),
  }));
  assert.equal(heartbeatLease(lease, env), false);
});

test("lease dispatch fence linearizes token validation with synchronous write dispatch", () => {
  const env = makeEnv();
  const lease = acquireLease(env);
  const fence = makeLeaseDispatchFence(lease, env);
  let sends = 0;
  assert.equal(fence(() => { sends += 1; }), true);
  assert.equal(sends, 1);

  writeFileSync(serviceLeasePath(env), JSON.stringify({
    ...lease,
    token: "replacement-token",
    updatedAt: Date.now(),
  }));
  assert.equal(fence(() => { sends += 1; }), false);
  assert.equal(sends, 1, "no bytes dispatched after token replacement");
  unlinkSync(serviceLeasePath(env));
});

test("lease: real cross-process contention elects exactly one live singleton", async () => {
  const env = makeEnv();
  const barrier = join(dirname(serviceLeasePath(env)), "lease-start-barrier");
  const releaseBarrier = join(dirname(serviceLeasePath(env)), "lease-release-barrier");
  mkdirSync(dirname(barrier), { recursive: true });
  const serviceUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "service.js")).href;
  const script = `
    import { existsSync } from "node:fs";
    import { acquireLease, releaseLease } from ${JSON.stringify(serviceUrl)};
    process.stdout.write("ready\\n");
    while (!existsSync(process.argv[1])) await new Promise(r => setTimeout(r, 2));
    const lease = acquireLease(process.env, { mutexTimeoutMs: 30_000 });
    process.stdout.write(lease ? "winner\\n" : "blocked\\n");
    if (lease) {
      while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 2));
      releaseLease(lease, process.env);
    }
  `;
  const children = Array.from({ length: 32 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, barrier, releaseBarrier], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let readyResolve;
    let resultResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const result = new Promise((resolve) => { resultResolve = resolve; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) readyResolve();
      if (stdout.includes("winner\n")) resultResolve("winner");
      else if (stdout.includes("blocked\n")) resultResolve("blocked");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.on("close", (code) => {
      // A contender can fail before emitting its marker (for example, if the
      // bounded mutex wait expires under a heavily loaded full-suite run).
      // Resolve every coordination promise so the sole winner is never left
      // waiting forever for a release barrier the parent cannot reach.
      readyResolve();
      resultResolve("error");
      resolve({ code, stdout, stderr });
    }));
    return { child, done, ready, result };
  });
  await Promise.all(children.map(({ ready }) => ready));
  writeFileSync(barrier, "go");
  const outcomes = await Promise.all(children.map(({ result }) => result));
  // The sole winner retains the live lease until every contender has
  // reported its acquisition outcome, so a slow module import can never be
  // miscounted as a legitimate later takeover.
  writeFileSync(releaseBarrier, "release");
  const results = await Promise.all(children.map(({ done }) => done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(outcomes.filter((outcome) => outcome === "winner").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === "blocked").length, 31);
});

// ── ensureService ───────────────────────────────────────────────────────────

test("ensureService: no-op when a fresh same-version daemon holds the lease", async () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.ppid, token: "x", version: CHANNEL_VERSION, startedAt: Date.now(), updatedAt: Date.now(),
  }));
  let spawned = false;
  const result = await ensureService({ env, spawnImpl: () => { spawned = true; return { pid: 1, unref: noop }; }, logEvent: noop });
  assert.equal(result.spawned, false);
  assert.equal(spawned, false);
});

test("ensureService: spawns the daemon entry detached when no lease exists", async () => {
  const env = makeEnv();
  let spawnArgs = null;
  const result = await ensureService({
    env,
    logEvent: noop,
    spawnImpl: (cmd, args, opts) => {
      spawnArgs = { cmd, args, opts };
      return { pid: 4242, unref: noop };
    },
    readinessImpl: async () => ({ ready: true, token: "mock-ready" }),
  });
  assert.equal(result.spawned, true);
  assert.equal(result.pid, 4242);
  assert.equal(spawnArgs.cmd, process.execPath);
  assert.match(spawnArgs.args[0], /codex-channel[\\/]service\.mjs$/);
  assert.equal(spawnArgs.args[1], "run");
  assert.equal(spawnArgs.opts.detached, true);
  assert.equal(spawnArgs.opts.stdio, "ignore");
});

test("spawn readiness requires the exact child lease heartbeat to advance", async () => {
  const env = makeEnv();
  const child = new EventEmitter();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  mkdirSync(dirname(serviceLeasePath(env)), { recursive: true });
  const firstUpdatedAt = Date.now();
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: child.pid,
    token: "startup-proof",
    version: CHANNEL_VERSION,
    startedAt: firstUpdatedAt,
    updatedAt: firstUpdatedAt,
  }));
  let sleepCalls = 0;
  const readiness = await waitForSpawnedDaemonReady(child, env, {
    timeoutMs: 1000,
    sleepImpl: async () => {
      sleepCalls += 1;
      writeFileSync(serviceLeasePath(env), JSON.stringify({
        pid: child.pid,
        token: "startup-proof",
        version: CHANNEL_VERSION,
        startedAt: firstUpdatedAt,
        updatedAt: firstUpdatedAt + sleepCalls,
      }));
    },
  });
  assert.equal(readiness.ready, true);
  assert.ok(sleepCalls >= 1, "initial lease publication alone is not readiness");
  unlinkSync(serviceLeasePath(env));
});

test("spawn readiness reconciles a concurrently spawned peer that wins the lease", async () => {
  const env = makeEnv();
  const child = new EventEmitter();
  child.pid = 989898;
  child.exitCode = 1;
  child.signalCode = null;
  mkdirSync(dirname(serviceLeasePath(env)), { recursive: true });
  const firstUpdatedAt = Date.now();
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: process.pid,
    token: "peer-startup-proof",
    version: CHANNEL_VERSION,
    startedAt: firstUpdatedAt,
    updatedAt: firstUpdatedAt,
  }));
  let sleepCalls = 0;
  const readiness = await waitForSpawnedDaemonReady(child, env, {
    timeoutMs: 1000,
    sleepImpl: async () => {
      sleepCalls += 1;
      writeFileSync(serviceLeasePath(env), JSON.stringify({
        pid: process.pid,
        token: "peer-startup-proof",
        version: CHANNEL_VERSION,
        startedAt: firstUpdatedAt,
        updatedAt: firstUpdatedAt + sleepCalls,
      }));
    },
  });
  assert.deepEqual(readiness, {
    ready: true,
    pid: process.pid,
    token: "peer-startup-proof",
    raced: true,
  });
  assert.ok(sleepCalls >= 1, "the peer must also prove a heartbeat advance");
  unlinkSync(serviceLeasePath(env));
});

test("ensure reports a detached daemon startup failure when retained delivery state is corrupt", async () => {
  const env = makeEnv();
  const id = "msg-startup-corrupt-aaaa-4bbb-8ccc-ddddeeee0000";
  const tombstone = deliveredTombstonePath(id, env);
  mkdirSync(dirname(tombstone), { recursive: true });
  writeFileSync(tombstone, "");
  const result = await ensureService({ env, logEvent: noop });
  assert.equal(result.spawned, false);
  assert.equal(result.startupFailed, true);
  assert.match(result.reason, /exited before readiness|startup/i);
  assert.equal(describeEnsureResult(result).ok, false);
  assert.equal(readLease(env), null, "dead startup child's exact lease is cleaned after failure proof");
});

test("ensureService: AGENT_BRIDGE_CODEX_NO_ENSURE=1 skips spawning", async () => {
  const env = makeEnv({ AGENT_BRIDGE_CODEX_NO_ENSURE: "1" });
  let spawned = false;
  const result = await ensureService({ env, spawnImpl: () => { spawned = true; }, logEvent: noop });
  assert.equal(result.skipped, true);
  assert.equal(spawned, false);
});

test("ensure status never reports stale-version or unverified ownership as success", () => {
  assert.deepEqual(describeEnsureResult({ spawned: false, pid: 41, staleVersion: true }), {
    ok: false,
    message: "codex-channel service pid 41 remains on an older version; graceful version refresh did not complete",
  });
  assert.deepEqual(describeEnsureResult({ spawned: false, pid: 42, unverified: true }), {
    ok: false,
    message: "codex-channel service pid 42 holds the lease but ownership could not be verified; refusing split-brain takeover",
  });
  assert.equal(describeEnsureResult({ spawned: false, skipped: true }).ok, true);
  assert.equal(describeEnsureResult({ spawned: true, pid: 43 }).ok, true);
  assert.equal(describeEnsureResult({ spawned: false, pid: 44, startupFailed: true, reason: "early exit" }).ok, false);
});

test("verifyLiveDaemon: advancing heartbeat under the same token is the ONLY accepted identity proof", async () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  const lease = { pid: process.pid, token: "proof", version: CHANNEL_VERSION, startedAt: Date.now(), updatedAt: Date.now() };
  writeFileSync(serviceLeasePath(env), JSON.stringify(lease));
  // Advancing: the injected sleeper simulates the daemon heartbeating.
  const advancing = await verifyLiveDaemon(env, {
    windowMs: 2000,
    sleepImpl: async () => {
      lease.updatedAt = Date.now();
      writeFileSync(serviceLeasePath(env), JSON.stringify(lease));
    },
  });
  assert.equal(advancing.live, true);
  // Non-advancing (same alive pid, frozen updatedAt): NOT live.
  writeFileSync(serviceLeasePath(env), JSON.stringify({ ...lease, updatedAt: Date.now() }));
  const frozen = await verifyLiveDaemon(env, { windowMs: 700, sleepImpl: async () => {} });
  assert.equal(frozen.live, false, "an alive PID without advancing heartbeats proves nothing");
});

test("ensureService: NEVER signals or starts beside an UNRELATED live process behind a reused-PID lease", async () => {
  const env = makeEnv();
  // A real, disposable child that does NOT heartbeat the lease — stands in
  // for an unrelated process whose PID a stale lease happens to point at.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: child.pid, token: "reused", version: "4.9.0", startedAt: Date.now(), updatedAt: Date.now(),
  }));
  let spawnedFresh = false;
  const result = await ensureService({
    env,
    logEvent: noop,
    spawnImpl: () => { spawnedFresh = true; return { pid: 777, unref: noop }; },
  });
  assert.equal(child.exitCode, null, "the unrelated process was NOT signaled");
  assert.equal(child.signalCode, null);
  assert.equal(spawnedFresh, false, "availability yields to the no-split-brain safety boundary");
  assert.equal(result.spawned, false);
  assert.equal(result.unverified, true);
  assert.equal(readLease(env).token, "reused", "uncertain live holder remains fenced");
  child.kill("SIGKILL"); // test cleanup only
});

test("ensureService: version refresh uses token-bound graceful control IPC for a PROVABLY live older daemon", async () => {
  const env = makeEnv();
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  // A real child that behaves like an old daemon: it heartbeats the lease
  // and acknowledges the same token-bound control request as runService.
  const script = `
    const fs = require("fs");
    const leasePath = process.argv[1];
    const controlPath = process.argv[2];
    const heartbeat = setInterval(() => {
      fs.writeFileSync(leasePath, JSON.stringify({
        pid: process.pid, token: "old-daemon", version: "4.9.0",
        startedAt: Date.now() - 5000, updatedAt: Date.now(),
      }));
    }, 150);
    const controls = setInterval(() => {
      try {
        const request = JSON.parse(fs.readFileSync(controlPath, "utf8"));
        if (request.leaseToken !== "old-daemon") return;
        clearInterval(heartbeat);
        clearInterval(controls);
        try { fs.unlinkSync(leasePath); } catch {}
        try { fs.unlinkSync(controlPath); } catch {}
        process.exit(0);
      } catch {}
    }, 50);
  `;
  const child = spawn(process.execPath, ["-e", script, serviceLeasePath(env), serviceControlPath(env)], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  await waitFor(() => leaseFresh(readLease(env)), 5000);
  let spawnedFresh = false;
  const result = await ensureService({
    env,
    logEvent: noop,
    spawnImpl: () => { spawnedFresh = true; return { pid: 888, unref: noop }; },
    readinessImpl: async () => ({ ready: true, token: "mock-ready" }),
  });
  assert.equal(spawnedFresh, true, "fresh daemon spawned after verified version refresh");
  assert.equal(result.spawned, true);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
});

test("stopService: an unverified live PID is neither signaled nor unfenced; missing lease reports not_running", async () => {
  const env = makeEnv();
  assert.deepEqual((await stopService({ env, logEvent: noop })).reason, "not_running");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  mkdirSync(join(serviceLeasePath(env), ".."), { recursive: true });
  writeFileSync(serviceLeasePath(env), JSON.stringify({
    pid: child.pid, token: "reused", version: CHANNEL_VERSION, startedAt: Date.now(), updatedAt: Date.now(),
  }));
  const result = await stopService({ env, logEvent: noop });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, "live_pid_unverified");
  assert.equal(child.exitCode, null, "unrelated process untouched");
  assert.equal(readLease(env).token, "reused", "lease retained so no second daemon can start beside it");
  child.kill("SIGKILL"); // test cleanup only
});

test("independent heartbeat + portable control IPC: real daemon shuts down cleanly and releases its lease", async () => {
  const env = makeEnv();
  const serviceEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "service.mjs");
  const child = spawn(process.execPath, [serviceEntry, "run"], {
    stdio: "ignore",
    env: { ...process.env, ...env, AGENT_BRIDGE_CODEX_NO_ENSURE: "0" },
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  await waitFor(() => leaseFresh(readLease(env)), 8000);
  const first = readLease(env);
  // Heartbeat advances on its own timer (independent of the delivery pump).
  await waitFor(() => Number(readLease(env)?.updatedAt) > Number(first.updatedAt), 8000);
  assert.equal(readLease(env).token, first.token);
  const stopped = await stopService({ env, logEvent: noop });
  assert.equal(stopped.stopped, true);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000);
  await waitFor(() => readLease(env) === null, 8000);
  assert.equal(existsSync(serviceControlPath(env)), false, "control request acknowledged and removed");
});

// ── Service tick orchestration ──────────────────────────────────────────────

test("tick delivers an inbound message end-to-end through the fake app server", async () => {
  const env = makeEnv();
  const projectDir = join(dirname(env.AGENT_BRIDGE_HOME), "project-p");
  mkdirSync(projectDir, { recursive: true });
  bindAlias({ alias: "review", threadId: THREAD, cwd: projectDir, env });
  const msg = writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(fakes.length, 1);
  const turnStarts = fakes[0].requestsFor("turn/start");
  assert.equal(turnStarts.length, 1);
  assert.equal(turnStarts[0].params.threadId, THREAD);
  assert.equal(turnStarts[0].params.clientUserMessageId, msg.id);
  assert.match(turnStarts[0].params.input[0].text, new RegExp(msg.id));
  const resumes = fakes[0].requestsFor("thread/resume");
  assert.equal(resumes.length, 1);
  const snapshot = service.statusSnapshot();
  assert.equal(snapshot.appServer.connected, true);
  assert.equal(snapshot.appServer.serverVersion, "0.145.0");
  await service.shutdown("test");
  assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 1, "shutdown unsubscribes");
});

test("version refresh drains an active turn before restore, unsubscribe, and App Server close", async () => {
  const env = makeEnv();
  const projectDir = join(dirname(env.AGENT_BRIDGE_HOME), "project-version-drain");
  mkdirSync(projectDir, { recursive: true });
  bindAlias({ alias: "review", threadId: THREAD, cwd: projectDir, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { emitTurnLifecycle: false }),
  });
  await service.tick();
  const fake = fakes[0];
  const accepted = fake.acceptedTurnInputs[0];
  assert.ok(accepted?.turnId);

  assert.equal(await service.drainForVersionRefresh(), false, "active turn keeps the old daemon draining");
  assert.equal(fake.requestsFor("thread/settings/update").length, 0);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 0);
  assert.equal(fake.child.exitCode, null);

  fake.sendNotification("turn/completed", {
    threadId: THREAD,
    turn: { id: accepted.turnId, status: "completed", items: [] },
  });
  await waitFor(() => service._internals.sessions.get("review")?.turnActive === false, 2000);
  assert.equal(await service.drainForVersionRefresh(), true);
  assert.equal(fake.requestsFor("thread/settings/update").length, 1);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
  await service.shutdown("control:version_refresh");
  assert.ok(fake.child.exitCode !== null || fake.child.signalCode !== null);
});

test("tick with no bindings does nothing and spawns no app server", async () => {
  const env = makeEnv();
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(fakes.length, 0);
  await service.shutdown("test");
});

test("corrupt retained delivered state fences service creation before any App Server can start", () => {
  const env = makeEnv();
  const id = "msg-corrupt-ledger-aaaa-4bbb-8ccc-ddddeeee0000";
  const path = deliveredTombstonePath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  let factoryCalls = 0;
  assert.throws(() => createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => {
      factoryCalls += 1;
      throw new Error("must not be reached");
    },
  }), /Malformed delivered tombstone/);
  assert.equal(factoryCalls, 0);
});

test("corrupt retained possibly-sent state also fences service creation before any App Server can start", () => {
  const env = makeEnv();
  const id = "msg-corrupt-indeterminate-aaaa-4bbb-8ccc-ddddeeee0000";
  const path = indeterminateTombstonePath(id, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  let factoryCalls = 0;
  assert.throws(() => createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => {
      factoryCalls += 1;
      throw new Error("must not be reached");
    },
  }), /Malformed indeterminate tombstone/);
  assert.equal(factoryCalls, 0);
});

for (const registryState of ["enabled", "disabled", "unbound"]) {
  test(`pending settings restore is recovered with an empty queue when alias is ${registryState}`, async () => {
    const env = makeEnv();
    if (registryState !== "unbound") {
      bindAlias({ alias: "recovery", threadId: THREAD, env });
      if (registryState === "disabled") setBindingEnabled("recovery", false, { env });
    }
    const journal = writePendingSettingsJournal(env, "recovery", THREAD);
    const fakes = [];
    const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
    await service.tick();
    assert.equal(fakes.length, 1, "journal recovery starts App Server even without delivery work");
    assert.equal(fakes[0].requestsFor("thread/resume").length, 1);
    assert.equal(fakes[0].requestsFor("thread/settings/update").length, 1);
    assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 1);
    assert.equal(fakes[0].requestsFor("turn/start").length, 0);
    assert.equal(existsSync(journal), false);
    await service.shutdown("test");
  });
}

test("temporary settings recovery recycles after rejected unsubscribe before any delivery", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writePendingSettingsJournal(env, "review", THREAD);
  writeInbound(env, "review");
  const fakes = [];
  const events = [];
  let clientNumber = 0;
  const service = createService({
    env,
    logEvent: (_level, event) => events.push(event),
    machineName: "MBP",
    clientFactory: async () => {
      clientNumber += 1;
      const options = clientNumber === 1
        ? { unsubscribeResult: () => { throw Object.assign(new Error("unsubscribe rejected"), { rpcCode: -32000 }); } }
        : {};
      return fakeClientFactory(fakes, options)();
    },
  });

  await service.tick();
  assert.equal(fakes.length, 1);
  assert.equal(fakes[0].settingsUpdates.length, 1, "pending settings are restored first");
  assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 1);
  assert.ok(fakes[0].child.exitCode !== null || fakes[0].child.signalCode !== null,
    "handlerless temporary subscription is torn down with its connection");
  assert.equal(fakes[0].requestsFor("turn/start").length, 0, "delivery remains blocked during uncertain cleanup");
  assert.equal(events.includes("codex.settings_restore_recovered"), false);

  await service.tick();
  assert.equal(fakes.length, 2, "delivery uses a fresh App Server only after teardown");
  assert.equal(fakes[1].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("disabled bindings queue messages without delivery; re-enable flushes", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  setBindingEnabled("review", false, { env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(fakes.length, 0, "disabled binding must not open sessions");
  setBindingEnabled("review", true, { env });
  await service.tick();
  assert.equal(fakes.length, 1);
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("unbind mid-flight unloads the alias and releases its session", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(service.statusSnapshot().aliases.length, 1);
  unbindAlias("review", { env });
  await service.tick();
  assert.equal(service.statusSnapshot().aliases.length, 0);
  await service.shutdown("test");
});

test("rebind to a new thread re-resumes the new thread for later messages", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  bindAlias({ alias: "review", threadId: THREAD2, rebind: true, env });
  writeInbound(env, "review");
  await service.tick();
  const resumes = fakes[0].requestsFor("thread/resume").map((r) => r.params.threadId);
  assert.deepEqual(resumes, [THREAD, THREAD2]);
  await service.shutdown("test");
});

test("new-thread rebind never reuses an old thread's rollout baseline", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick(); // load the old binding without attaching

  // Old thread baseline is numerically newer than the new thread's still-
  // fresh foreign write. Alias-only baselines would suppress the guard.
  service._internals.rolloutBaselines.set("review", { threadId: THREAD, mtime: Date.now() + 1000 });
  writeRollout(env, THREAD2, Date.now() - 100);
  bindAlias({ alias: "review", threadId: THREAD2, rebind: true, env });
  writeInbound(env, "review");
  await service.tick();
  assert.equal(fakes.length, 0, "foreign activity on the new thread blocks attach");
  assert.equal(service.statusSnapshot().aliases[0].runtime.state, "deferred_foreign_activity");
  assert.equal(service._internals.rolloutBaselines.has("review"), false);
  await service.shutdown("test");
});

test("ownership guard: fresh foreign rollout writes defer delivery, stale ones do not", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const rolloutPath = writeRollout(env, THREAD, Date.now()); // fresh foreign write
  writeInbound(env, "review");
  const fakes = [];
  const events = [];
  const service = createService({
    env,
    logEvent: (l, e) => events.push(e),
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes),
  });
  await service.tick();
  assert.equal(fakes.length, 0, "no session while another client is writing the thread");
  assert.ok(events.includes("codex.ownership_deferred"));
  const aliasState = service.statusSnapshot().aliases[0].runtime.state;
  assert.equal(aliasState, "deferred_foreign_activity");

  // Foreign writer goes quiet: age the rollout and clear the retry backoff.
  const past = Date.now() - 10 * 60_000;
  utimesSync(rolloutPath, new Date(past), new Date(past));
  service._internals.runtime.get("review").retryAt = 0;
  await service.tick();
  assert.equal(fakes.length, 1);
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("ownership guard can be disabled per binding", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, policy: { ownershipGuard: false }, env });
  writeRollout(env, THREAD, Date.now());
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(fakes.length, 1);
  await service.shutdown("test");
});

test("thread_not_found classification when resume fails", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, {
      resumeResult: () => { throw new Error("no such thread on disk"); },
    }),
  });
  await service.tick();
  const alias = service.statusSnapshot().aliases[0];
  assert.equal(alias.runtime.state, "thread_not_found");
  assert.equal(fakes[0].requestsFor("turn/start").length, 0);
  await service.shutdown("test");
});

test("unsupported Codex version is classified and blocks with a retry window", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { userAgent: "codex/0.100.0 (ancient)" }),
  });
  await service.tick();
  assert.equal(service.statusSnapshot().aliases[0].runtime.state, "codex_unsupported");
  await service.shutdown("test");
});

test("unrouted flat files under inbox/codex/ are quarantined to _unrouted", async () => {
  const env = makeEnv();
  const flatDir = join(inboxRoot(env), "codex");
  mkdirSync(flatDir, { recursive: true });
  writeFileSync(join(flatDir, "stray.json"), JSON.stringify({ id: "x" }));
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory([]) });
  await service.tick();
  assert.equal(existsSync(join(flatDir, "stray.json")), false);
  assert.ok(readdirSync(unroutedDir(env)).includes("stray.json"));
  await service.shutdown("test");
});

test("idle-close shuts the app server down after quiet period and reopens on demand", async () => {
  const env = makeEnv({ AGENT_BRIDGE_CODEX_IDLE_CLOSE_MS: "1" });
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(service.statusSnapshot().appServer.connected, true);
  // Let the fake turn complete so no active turns hold the connection.
  await waitFor(() => service._internals.sessions.size === 0 || Array.from(service._internals.sessions.values()).every((s) => !s.turnActive));
  await sleep(5);
  await service.tick();
  assert.equal(service.statusSnapshot().appServer.connected, false, "idle connection closed");
  assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 1);
  // New message re-opens a fresh connection.
  writeInbound(env, "review");
  await service.tick();
  assert.equal(fakes.length, 2);
  assert.equal(service.statusSnapshot().appServer.connected, true);
  await service.shutdown("test");
});

test("stdout-only App Server loss is discarded and the next delivery creates a fresh client", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { killDelayMs: 50 }),
  });
  await service.tick();
  await waitFor(() => !service._internals.sessions.get("review")?.turnActive);
  await service.tick(); // release completed session
  assert.equal(fakes.length, 1);

  fakes[0].child.stdout.end(); // wrapper died without an exit event
  await waitFor(() => service.statusSnapshot().appServer.connected === false);
  writeInbound(env, "review");
  await service.tick();
  assert.ok(fakes[0].child.exitCode !== null || fakes[0].child.signalCode !== null,
    "replacement waits for the old child's bounded teardown");
  assert.equal(fakes.length, 2, "deaf closed client was never reused");
  assert.equal(fakes[1].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("aliases serialize on the shared App Server so one cleanup cannot abort another active turn", async () => {
  const env = makeEnv();
  bindAlias({ alias: "alpha", threadId: THREAD, env });
  bindAlias({ alias: "beta", threadId: THREAD2, env });
  writeInbound(env, "alpha");
  writeInbound(env, "beta");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { emitTurnLifecycle: false }),
  });

  await service.tick();
  assert.equal(fakes.length, 1);
  assert.deepEqual(fakes[0].requestsFor("thread/resume").map((r) => r.params.threadId), [THREAD]);
  assert.deepEqual(fakes[0].requestsFor("turn/start").map((r) => r.params.threadId), [THREAD]);
  assert.equal(service._internals.sessions.get("alpha")?.turnActive, true);
  assert.equal(service._internals.sessions.has("beta"), false, "second alias stays queued, not concurrently subscribed");
  assert.equal(fakes[0].child.exitCode, null, "active alias connection remains alive");

  const alphaTurn = service._internals.sessions.get("alpha").activeTurnId;
  fakes[0].sendNotification("turn/completed", {
    threadId: THREAD,
    turn: { id: alphaTurn, status: "completed" },
  });
  await waitFor(() => !service._internals.sessions.get("alpha")?.turnActive);
  service._internals.runtime.get("beta").retryAt = 0;
  await service.tick();
  assert.deepEqual(fakes[0].requestsFor("thread/resume").map((r) => r.params.threadId), [THREAD, THREAD2]);
  assert.deepEqual(fakes[0].requestsFor("turn/start").map((r) => r.params.threadId), [THREAD, THREAD2]);
  await service.shutdown("test");
});

test("failed Windows exact-tree teardown blocks replacement beside a possible orphan", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, cwd: realpathSync(process.cwd()), env });
  writeInbound(env, "review");
  const fake = createFakeAppServer();
  const spawnProcess = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  };
  const firstClient = new CodexAppServerClient(fake.child, {
    logEvent: noop,
    clientName: "svc-test",
    clientVersion: "0",
    platform: "win32",
    spawnProcess,
  });
  let factoryCalls = 0;
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) return firstClient;
      return new CodexAppServerClient(createFakeAppServer().child, {
        logEvent: noop,
        clientName: "unexpected-replacement",
        clientVersion: "0",
      });
    },
  });
  await service.tick();
  await waitFor(() => !service._internals.sessions.get("review")?.turnActive);
  await service.tick();

  fake.child.stdout.end();
  await waitFor(() => service.statusSnapshot().appServer.connected === false);
  await sleep(0); // taskkill failure settles the teardown promise
  writeInbound(env, "review");
  await service.tick();
  assert.equal(factoryCalls, 1, "replacement remains fenced when the old process tree may survive");
  assert.match(service.statusSnapshot().aliases[0].runtime.detail, /teardown could not be verified/i);
  assert.equal(existsSync(serviceTeardownPoisonPath(env)), true, "unknown process-tree ownership is fenced durably");
  let spawned = false;
  const ensured = await ensureService({
    env,
    logEvent: noop,
    spawnImpl: () => { spawned = true; throw new Error("must not spawn"); },
  });
  assert.equal(ensured.teardownPoisoned, true);
  assert.equal(spawned, false);
  await assert.rejects(() => service.shutdown("test"), /teardown could not be verified/i);
  fake.exit(0);
});

test("initialize cleanup failure retains and poisons the exact client instead of spawning beside it", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, cwd: realpathSync(process.cwd()), env });
  writeInbound(env, "review");
  const fake = createFakeAppServer({ userAgent: "codex/0.100.0 (ancient)" });
  const spawnProcess = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  };
  const poisonedClient = new CodexAppServerClient(fake.child, {
    logEvent: noop,
    clientName: "svc-test",
    clientVersion: "0",
    platform: "win32",
    spawnProcess,
  });
  let factoryCalls = 0;
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => {
      factoryCalls += 1;
      return poisonedClient;
    },
  });
  await service.tick();
  assert.equal(factoryCalls, 1);
  assert.equal(existsSync(serviceTeardownPoisonPath(env)), true);
  service._internals.runtime.get("review").retryAt = 0;
  await service.tick();
  assert.equal(factoryCalls, 1, "poisoned initialize owner is retained across retries");
  await assert.rejects(() => service.shutdown("test"), /teardown could not be verified/i);
  fake.exit(0);
});

test("idle close failure preserves the client and durable poison before later demand", async () => {
  const env = makeEnv({ AGENT_BRIDGE_CODEX_IDLE_CLOSE_MS: "50" });
  bindAlias({ alias: "review", threadId: THREAD, cwd: realpathSync(process.cwd()), env });
  writeInbound(env, "review");
  const fake = createFakeAppServer({
    originalCwd: realpathSync(process.cwd()),
    originalSandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [realpathSync(process.cwd())],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  });
  const spawnProcess = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  };
  const firstClient = new CodexAppServerClient(fake.child, {
    logEvent: noop,
    clientName: "svc-test",
    clientVersion: "0",
    platform: "win32",
    spawnProcess,
  });
  let factoryCalls = 0;
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => {
      factoryCalls += 1;
      return firstClient;
    },
  });
  await service.tick();
  await waitFor(() => !service._internals.sessions.get("review")?.turnActive);
  await sleep(60);
  await assert.rejects(() => service.tick(), /teardown could not be verified/i);
  assert.equal(existsSync(serviceTeardownPoisonPath(env)), true);
  writeInbound(env, "review");
  await service.tick();
  assert.equal(factoryCalls, 1, "later demand cannot discard the idle-close owner");
  await assert.rejects(() => service.shutdown("test"), /teardown could not be verified/i);
  fake.exit(0);
});

test("shutdown retains its live process fence until a transient teardown-poison write failure is durably resolved", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, cwd: realpathSync(process.cwd()), env });
  writeInbound(env, "review");
  const fake = createFakeAppServer();
  const spawnProcess = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  };
  const client = new CodexAppServerClient(fake.child, {
    logEvent: noop,
    clientName: "svc-test",
    clientVersion: "0",
    platform: "win32",
    spawnProcess,
  });
  let poisonAttempts = 0;
  let retrySleeps = 0;
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: async () => client,
    teardownPoisonWriter: (_target, error, context, writerEnv) => {
      poisonAttempts += 1;
      if (poisonAttempts === 1) throw new Error("simulated transient ENOSPC");
      const path = serviceTeardownPoisonPath(writerEnv);
      const poison = {
        version: 1,
        path,
        pid: fake.child.pid,
        context,
        error: String(error?.message ?? error),
        serviceVersion: CHANNEL_VERSION,
        createdAt: new Date().toISOString(),
      };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(poison));
      return poison;
    },
    teardownPoisonRetrySleep: async () => { retrySleeps += 1; },
  });
  await service.tick();
  await assert.rejects(() => service.shutdown("test"), /teardown could not be verified/i);
  assert.equal(poisonAttempts, 2, "shutdown did not return after the failed poison publication");
  assert.equal(retrySleeps, 1);
  assert.equal(existsSync(serviceTeardownPoisonPath(env)), true, "replacement fence is durable before shutdown returns");
  assert.equal(acquireLease(env), null, "a replacement daemon remains fenced by the poison record");
  fake.exit(0);
});

test("lease-lost shutdown sends no settings update or unsubscribe through the old authority", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, cwd: realpathSync(process.cwd()), env });
  writeInbound(env, "review");
  const fakes = [];
  let authoritative = true;
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { emitTurnLifecycle: false }),
    dispatchFence: (dispatch) => {
      if (!authoritative) return false;
      dispatch();
      return true;
    },
  });
  await service.tick();
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  authoritative = false;
  await service.shutdown("lease-lost");
  assert.equal(fakes[0].requestsFor("thread/settings/update").length, 0);
  assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 0);
});

test("same-thread rebind serializes old restore/unsubscribe before replacement resume and keeps new notifications", async () => {
  const env = makeEnv();
  const oldDir = join(dirname(env.AGENT_BRIDGE_HOME), "old");
  const newDir = join(dirname(env.AGENT_BRIDGE_HOME), "new");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  bindAlias({
    alias: "review",
    threadId: THREAD,
    cwd: oldDir,
    policy: { sandbox: "danger-full-access" },
    allowDanger: true,
    env,
  });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, { settingsUpdateDelayMs: 30, unsubscribeDelayMs: 30 }),
  });
  await service.tick();
  const firstStart = fakes[0].requestsFor("turn/start")[0];
  assert.deepEqual(firstStart.params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(firstStart.params.cwd, realpathSync(oldDir));

  // Rebind the SAME thread with tightened policy + new cwd.
  bindAlias({ alias: "review", threadId: THREAD, cwd: newDir, policy: { sandbox: "read-only" }, rebind: true, env });
  writeInbound(env, "review");
  await service.tick();
  const starts = fakes.flatMap((f) => f.requestsFor("turn/start"));
  assert.equal(starts.length, 2);
  const secondStart = starts[1];
  assert.deepEqual(secondStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false }, "old session settings must not survive the rebind");
  assert.equal(secondStart.params.cwd, realpathSync(newDir));

  const lifecycle = fakes[0].received
    .filter((r) => ["thread/settings/update", "thread/unsubscribe", "thread/resume"].includes(r.method))
    .map((r) => r.method);
  assert.deepEqual(
    lifecycle.slice(-3),
    ["thread/settings/update", "thread/unsubscribe", "thread/resume"],
    "old restore -> old unsubscribe -> replacement resume is strictly serialized",
  );

  const replacement = service._internals.sessions.get("review");
  fakes[0].sendNotification("turn/started", { threadId: THREAD, turn: { id: "replacement-notification" } });
  await waitFor(() => replacement.activeTurnId === "replacement-notification");
  fakes[0].sendNotification("turn/completed", { threadId: THREAD, turn: { id: "replacement-notification", status: "completed" } });
  await waitFor(() => !replacement.turnActive);
  await service.shutdown("test");
});

test("rebind never overwrites an old same-alias session whose unsubscribe was rejected", async () => {
  const env = makeEnv();
  const oldDir = join(dirname(env.AGENT_BRIDGE_HOME), "old-reject");
  const newDir = join(dirname(env.AGENT_BRIDGE_HOME), "new-reject");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  bindAlias({ alias: "review", threadId: THREAD, cwd: oldDir, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, {
      unsubscribeResult: () => { throw Object.assign(new Error("subscription still live"), { rpcCode: -32000 }); },
    }),
  });
  await service.tick();
  await waitFor(() => !service._internals.sessions.get("review")?.turnActive);
  const oldSession = service._internals.sessions.get("review");

  bindAlias({ alias: "review", threadId: THREAD, cwd: newDir, policy: { sandbox: "read-only" }, rebind: true, env });
  writeInbound(env, "review");
  await service.tick();
  assert.equal(fakes[0].requestsFor("thread/resume").length, 1, "replacement never resumes beside rejected old unsubscribe");
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  assert.equal(service._internals.sessions.get("review"), oldSession, "old handler owner remains registered for retry");
  assert.equal(service.statusSnapshot().aliases[0].runtime.state, "settings_restore_pending");
  await service.shutdown("test");
});

test("ownership AFTER attach: unexplained rollout advance releases the session and defers", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const rolloutPath = writeRollout(env, THREAD, Date.now() - 10 * 60_000); // quiet at attach time
  writeInbound(env, "review");
  const fakes = [];
  const events = [];
  const service = createService({ env, logEvent: (l, e) => events.push(e), machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  assert.equal(service._internals.sessions.size, 1, "attached and delivered");
  writeInbound(env, "review"); // pending work so the alias is pumped again
  // Foreign writer touches the rollout IMMEDIATELY while we are attached and
  // idle. Exact rollout baselines must detect this without a 1s blind spot.
  const now = Date.now();
  utimesSync(rolloutPath, new Date(now), new Date(now));
  await service.tick();
  assert.equal(service._internals.sessions.size, 0, "session released on foreign activity");
  assert.equal(service.statusSnapshot().aliases[0].runtime.state, "deferred_foreign_activity");
  assert.ok(events.includes("codex.session_released"));
  assert.ok(events.includes("codex.ownership_deferred"));
  const unsubs = fakes[0].requestsFor("thread/unsubscribe");
  assert.ok(unsubs.length >= 1, "released via thread/unsubscribe, not held as a second writer");
  assert.equal(fakes[0].requestsFor("turn/start").length, 1, "foreign touch blocks the second turn/start");
  assert.equal(fakes[0].requestsFor("thread/settings/update").length, 0,
    "rollout-only foreign evidence prevents replaying old settings over the other client");

  // Fast-forward only the service retry, NOT the ownership freshness window:
  // the foreign mtime must remain foreign rather than becoming our baseline.
  service._internals.runtime.get("review").retryAt = 0;
  await service.tick();
  assert.equal(fakes[0].requestsFor("thread/resume").length, 1, "still deferred while the foreign write is fresh");
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("prompt release: after the bridge turn completes and the queue drains, the session unsubscribes and restores settings WITHOUT waiting for idle-close", async () => {
  const env = makeEnv(); // default idle-close is 5 minutes — must NOT be needed
  bindAlias({ alias: "review", threadId: THREAD, env });
  writeInbound(env, "review");
  const fakes = [];
  const events = [];
  const service = createService({ env, logEvent: (l, e) => events.push(e), machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick(); // deliver (turn completes synchronously in the fake)
  await waitFor(() => Array.from(service._internals.sessions.values()).every((s) => !s.turnActive));
  await service.tick(); // queue empty + no turn => prompt release
  assert.equal(service._internals.sessions.size, 0);
  assert.ok(events.includes("codex.session_released"));
  assert.equal(fakes[0].requestsFor("thread/unsubscribe").length, 1);
  assert.equal(fakes[0].settingsUpdates.length, 1, "pre-bridge thread settings restored before release");
  assert.equal(fakes[0].settingsUpdates[0].cwd, realpathSync(process.cwd()));
  await service.shutdown("test");
});

test("terminal turn outcomes are wired: a FAILED bridge turn is logged and surfaced in status", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const msg = writeInbound(env, "review");
  const fakes = [];
  const events = [];
  const service = createService({
    env,
    logEvent: (l, e, m, c) => events.push({ e, c }),
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, {
      emitTurnLifecycle: false,
      turnStartResult: () => ({ turn: { id: "turn-doomed" } }),
    }),
  });
  await service.tick();
  fakes[0].sendNotification("turn/completed", {
    threadId: THREAD,
    turn: { id: "turn-doomed", status: "failed", error: { message: "model exploded" } },
  });
  await waitFor(() => events.some((x) => x.e === "codex.turn_failed_terminal"));
  const failure = events.find((x) => x.e === "codex.turn_failed_terminal");
  assert.equal(failure.c.turn_id, "turn-doomed");
  assert.equal(failure.c.msg_id, msg.id, "terminal outcome attributed to the delivered bridge message");
  assert.equal(failure.c.error, "model exploded");
  const outcome = service.statusSnapshot().aliases[0].runtime.lastTurnOutcome;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.msgId, msg.id);
  await service.shutdown("test");
});

test("recovered indeterminate message: probe (includeTurns) finds it, finalizes with ZERO new turn/start", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const msg = writeInbound(env, "review");
  const fakes = [];
  const factory = fakeClientFactory(fakes);
  // First service delivers normally (the fake records the accepted input).
  const first = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: factory });
  await first.tick();
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  await first.shutdown("test");
  // Simulate the crash window: put the message BACK as a claimed staged file
  // with a turn_starting meta (as if turn/start's response was never seen)
  // and clear the delivered ledger.
  const { unlinkSync: unlink } = await import("node:fs");
  try { unlink(join(env.AGENT_BRIDGE_HOME, ".codex-channel-delivered")); } catch { /* ignore */ }
  try { unlink(deliveredTombstonePath(msg.id, env)); } catch { /* ignore */ }
  const staging = join(inboxRoot(env), ".pending-ack", "codex", "review");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, `${msg.id}.json`), JSON.stringify({ ...msg }));
  writeFileSync(join(staging, `${msg.id}.meta.json`), JSON.stringify({
    id: msg.id, alias: "review", state: "turn_starting", attempts: 0, probeFailures: 0,
    nextAttemptAt: 0, turnId: null, stagedAt: new Date().toISOString(),
  }));
  // Restarted service: reconcile marks the message indeterminate. A fresh
  // fake pre-seeded with the SAME accepted-turn history (the persisted
  // thread survived the crash) must satisfy the paginated exact-clientId
  // probe — and NO new turn/start may go out.
  const seededFakes = [];
  const seededFactory = async () => {
    const safeCwd = realpathSync(process.cwd());
    const fake = createFakeAppServer({
      originalCwd: safeCwd,
      originalSandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [safeCwd],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    fake.acceptedTurnInputs.push(...fakes[0].acceptedTurnInputs);
    seededFakes.push(fake);
    return new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "svc", clientVersion: "0" });
  };
  const restarted = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: seededFactory });
  await restarted.tick();
  const lists = seededFakes[0].requestsFor("thread/items/list");
  assert.ok(lists.length >= 1, "authoritative paginated probe used");
  assert.equal(lists[0].params.sortDirection, "desc");
  assert.equal(seededFakes[0].requestsFor("turn/start").length, 0, "already-accepted message is NEVER re-sent");
  assert.equal(readdirSync(staging).filter((n) => n.endsWith(".json") && !n.endsWith(".meta.json")).length, 0, "finalized (archived)");
  await restarted.shutdown("test");
});

test("accepted turn with dropped response reconciles before ownership guard and restores normally", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, policy: { turnTimeoutMs: 10 }, env });
  const rolloutPath = writeRollout(env, THREAD, Date.now() - 10 * 60_000);
  writeInbound(env, "review");
  const fakes = [];
  const events = [];
  const service = createService({
    env,
    logEvent: (level, event) => events.push(event),
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, {
      dropTurnStartResponse: true,
      turnStartResult: () => ({ turn: { id: "turn-accepted-drop" } }),
    }),
  });
  await service.tick();
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  const delivery = service._internals.deliveries.get("review");
  assert.equal(Array.from(delivery.queue.values())[0].needsProbe, true);

  // The accepted turn wrote the rollout. Reconciliation must run before the
  // ownership guard can mistake that write for a foreign client.
  const now = Date.now();
  utimesSync(rolloutPath, new Date(now), new Date(now));
  await service.tick();
  assert.equal(delivery.queue.size, 0, "history clientId match finalized the accepted turn");
  assert.equal(fakes[0].requestsFor("turn/start").length, 1, "no duplicate turn/start");
  assert.equal(events.includes("codex.ownership_deferred"), false);

  await service.tick();
  assert.equal(fakes[0].requestsFor("thread/settings/update").length, 1);
  assert.equal(service._internals.sessions.size, 0);
  await service.shutdown("test");
});

test("historical ambiguous hit never makes a different live user turn steerable", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, policy: { steering: true, turnTimeoutMs: 10 }, env });
  writeInbound(env, "review");
  const fakes = [];
  const service = createService({
    env,
    logEvent: noop,
    machineName: "MBP",
    clientFactory: fakeClientFactory(fakes, {
      dropTurnStartResponse: true,
      turnStartResult: () => ({ turn: { id: "turn-old-bridge" } }),
    }),
  });
  await service.tick();
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);

  writeInbound(env, "review");
  fakes[0].sendNotification("turn/started", { threadId: THREAD, turn: { id: "turn-user-live" } });
  await waitFor(() => service._internals.sessions.get("review")?.activeTurnId === "turn-user-live");

  await service.tick(); // history-finalize the old ambiguous bridge message
  const session = service._internals.sessions.get("review");
  assert.equal(session.activeTurnId, "turn-user-live");
  assert.equal(session.activeTurnOurs, false, "old history correlation cannot transfer ownership");
  await service.tick(); // second message sees foreign active turn and queues
  assert.equal(fakes[0].requestsFor("turn/steer").length, 0);
  assert.equal(fakes[0].requestsFor("turn/start").length, 1);
  await service.shutdown("test");
});

test("dedupe across ticks: the same message id is never delivered twice", async () => {
  const env = makeEnv();
  bindAlias({ alias: "review", threadId: THREAD, env });
  const msg = writeInbound(env, "review");
  const fakes = [];
  const service = createService({ env, logEvent: noop, machineName: "MBP", clientFactory: fakeClientFactory(fakes) });
  await service.tick();
  // Redeliver the same file (duplicate inbox write / sender retry).
  writeInbound(env, "review", { id: msg.id, content: "duplicate copy" });
  await service.tick();
  const starts = fakes.flatMap((f) => f.requestsFor("turn/start"));
  assert.equal(starts.length, 1);
  await service.shutdown("test");
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor timed out");
}
