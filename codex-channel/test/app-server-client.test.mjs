import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  CodexAppServerClient,
  CodexVersionError,
  MIN_CODEX_VERSION,
  codexBinaryCandidates,
  compareVersions,
  parseCodexVersionFromUserAgent,
} from "../src/app-server-client.js";
import { buildLegacyApprovalDecline } from "../src/session.js";
import { createFakeAppServer } from "./fake-app-server.mjs";

const noopLog = () => {};

function makeClient(fakeOptions = {}, clientOptions = {}) {
  const fake = createFakeAppServer(fakeOptions);
  const client = new CodexAppServerClient(fake.child, {
    logEvent: clientOptions.logEvent ?? noopLog,
    clientName: "test-client",
    clientVersion: "0.0.1",
    ...clientOptions,
  });
  return { fake, client };
}

test("initialize handshake negotiates version and sends initialized", async () => {
  const { fake, client } = makeClient();
  const identity = await client.initialize();
  assert.equal(identity.serverVersion, "0.145.0");
  assert.equal(client.serverVersion, "0.145.0");
  const init = fake.requestsFor("initialize")[0];
  assert.equal(init.params.clientInfo.name, "test-client");
  assert.equal(init.params.capabilities.experimentalApi, true);
  assert.equal(fake.requestsFor("initialized").length, 1);
  await client.close();
});

test("initialize rejects unsupported Codex versions", async () => {
  const { client } = makeClient({ userAgent: "codex/0.120.0 (old)" });
  await assert.rejects(() => client.initialize(), (err) => {
    assert.ok(err instanceof CodexVersionError);
    assert.equal(err.detectedVersion, "0.120.0");
    assert.match(err.message, new RegExp(MIN_CODEX_VERSION.replaceAll(".", "\\.")));
    return true;
  });
  assert.equal(client.closed, true, "unsupported server connection must be closed");
});

test("initialize rejects unparseable user agents", async () => {
  const { client } = makeClient({ userAgent: "mystery-binary" });
  await assert.rejects(() => client.initialize(), CodexVersionError);
});

test("stdio fragmentation: split frames across chunks are reassembled", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const pending = client.request("thread/read", { threadId: "t" }, { timeoutMs: 2000 });
  const frame = `${JSON.stringify({ id: 1, result: { ok: true, marker: "fragmented" } })}\n`;
  const mid = Math.floor(frame.length / 2);
  fake.writeRaw(frame.slice(0, 3));
  await tickAsync();
  fake.writeRaw(frame.slice(3, mid));
  await tickAsync();
  fake.writeRaw(frame.slice(mid));
  const result = await pending;
  assert.equal(result.marker, "fragmented");
  await client.close();
});

test("stdio UTF-8 framing preserves a 4-byte character split at every byte boundary", async () => {
  const marker = "🛰";
  const markerBytes = Buffer.from(marker, "utf8");
  assert.equal(markerBytes.length, 4, "fixture must exercise a four-byte UTF-8 sequence");

  for (let split = 1; split < markerBytes.length; split += 1) {
    const { fake, client } = makeClient({ autoRespond: false });
    const pending = client.request("thread/read", { threadId: "t" }, { timeoutMs: 2000 });
    const frame = Buffer.from(`${JSON.stringify({ id: 1, result: { marker } })}\n`, "utf8");
    const markerOffset = frame.indexOf(markerBytes);
    assert.notEqual(markerOffset, -1);

    fake.writeRaw(frame.subarray(0, markerOffset + split));
    await tickAsync();
    fake.writeRaw(frame.subarray(markerOffset + split));

    const result = await pending;
    assert.equal(result.marker, marker, `split after UTF-8 byte ${split}`);
    assert.equal(client.parseFailures, 0);
    await client.close();
  }
});

test("malformed frames are counted, not fatal", async () => {
  const events = [];
  const { fake, client } = makeClient({ autoRespond: false }, {
    logEvent: (level, event) => events.push(event),
  });
  fake.writeRaw("this is not json\n");
  fake.writeRaw("{\"broken\": \n");
  await tickAsync();
  assert.equal(client.parseFailures >= 1, true);
  assert.ok(events.includes("codex.appserver_parse_failed"));
  // Client still works after garbage:
  const pending = client.request("x/y", {}, { timeoutMs: 2000 });
  fake.writeFrame({ id: 1, result: { alive: true } });
  const result = await pending;
  assert.equal(result.alive, true);
  await client.close();
});

test("request timeout rejects and does not leak the pending entry", async () => {
  const { client } = makeClient({ autoRespond: false });
  await assert.rejects(
    () => client.request("never/answers", {}, { timeoutMs: 150 }),
    /timed out/,
  );
  assert.equal(client.pending.size, 0);
  await client.close();
});

test("rpc errors surface code and message", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const pending = client.request("boom", {}, { timeoutMs: 2000 });
  fake.writeFrame({ id: 1, error: { code: -32602, message: "invalid params: unknown field" } });
  await assert.rejects(() => pending, (err) => {
    assert.equal(err.code, -32602);
    assert.match(err.message, /invalid params/);
    return true;
  });
  await client.close();
});

test("interactive requests with NO handler get global fail-closed declines; unknown methods get method-not-found", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  // Approval-shaped => exact safe decline, never an approval, never a hang.
  const approval = await fake.sendServerRequest("item/commandExecution/requestApproval", {});
  assert.deepEqual(approval.result, { decision: "decline" });
  const perms = await fake.sendServerRequest("item/permissions/requestApproval", {});
  assert.deepEqual(perms.result, { permissions: {}, scope: "turn" });
  for (const method of ["applyPatchApproval", "execCommandApproval"]) {
    const legacy = await fake.sendServerRequest(method, {});
    assert.deepEqual(legacy.result, buildLegacyApprovalDecline());
  }
  const input = await fake.sendServerRequest("item/tool/requestUserInput", { questions: [{ id: "q1" }] });
  assert.deepEqual(input.result, { answers: { q1: { answers: [] } } });
  const elicit = await fake.sendServerRequest("mcpServer/elicitation/request", {});
  assert.deepEqual(elicit.result, { action: "decline", content: null, _meta: null });
  // Non-interactive unknown method => JSON-RPC method-not-found.
  const unknown = await fake.sendServerRequest("thread/mystery", {});
  assert.equal(unknown.error.code, -32601);
  await client.close();
});

test("multi-handler dispatch: first claim wins, disposers work, throwing handlers fall through safely", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const calls = [];
  const disposeA = client.addRequestHandler(async (req) => {
    calls.push("a");
    if (req.params?.owner === "a") return { decision: "decline" };
    return null;
  });
  client.addRequestHandler(async (req) => {
    calls.push("b");
    if (req.params?.owner === "throw") throw new Error("handler exploded");
    if (req.params?.owner === "b") return { decision: "decline" };
    return null;
  });

  const forB = await fake.sendServerRequest("item/commandExecution/requestApproval", { owner: "b" });
  assert.deepEqual(forB.result, { decision: "decline" });
  assert.deepEqual(calls, ["a", "b"], "insertion order, unclaimed falls through");

  calls.length = 0;
  const forA = await fake.sendServerRequest("item/commandExecution/requestApproval", { owner: "a" });
  assert.deepEqual(forA.result, { decision: "decline" });
  assert.deepEqual(calls, ["a"], "first claim short-circuits");

  // A throwing handler must not break dispatch — the request still resolves
  // via the fail-closed default (safe decline, never an approval).
  calls.length = 0;
  const thrown = await fake.sendServerRequest("item/commandExecution/requestApproval", { owner: "throw" });
  assert.deepEqual(thrown.result, { decision: "decline" });

  disposeA();
  calls.length = 0;
  const afterDispose = await fake.sendServerRequest("item/commandExecution/requestApproval", { owner: "a" });
  assert.deepEqual(afterDispose.result, { decision: "decline" }, "fail-closed after the claiming handler was disposed");
  assert.deepEqual(calls, ["b"], "disposed handler no longer runs");
  await client.close();
});

test("child exit rejects pending requests with stderr tail", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  fake.writeStderr("panic: something exploded token=abc\n");
  const pending = client.request("stuck", {}, { timeoutMs: 10_000 });
  fake.exit(1);
  await assert.rejects(() => pending, (err) => {
    assert.match(err.message, /connection closed/);
    assert.match(err.message, /exit code=1/);
    assert.match(err.message, /exploded/);
    return true;
  });
  assert.equal(client.closed, true);
});

test("stdout end closes immediately, rejects pending work, and notifies listeners once", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  let closeCalls = 0;
  client.onClose(() => { closeCalls += 1; });
  const pending = client.request("thread/read", { threadId: "t" }, { timeoutMs: 10_000 });
  fake.child.stdout.end();
  await assert.rejects(() => pending, /stdout ended/);
  assert.equal(client.closed, true);
  assert.match(client.closeError.message, /stdout ended/);
  assert.equal(closeCalls, 1);
  await tickAsync();
  assert.ok(fake.child.exitCode !== null || fake.child.signalCode !== null,
    "fatal stdout loss tears down the still-live child and its subscriptions");
  fake.exit(0);
  await tickAsync();
  assert.equal(closeCalls, 1, "later child exit cannot double-close");
});

test("close() is idempotent and rejects later requests", async () => {
  const { client } = makeClient();
  await client.initialize();
  await client.close();
  await client.close();
  await assert.rejects(() => client.request("anything", {}), /closed/);
});

test("Windows .cmd/shell teardown uses exact owned taskkill process-tree scope", async () => {
  const taskkillCalls = [];
  const spawnProcess = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 0, null));
    return killer;
  };
  const { fake, client } = makeClient({}, { platform: "win32", spawnProcess });
  await client.initialize();
  await client.close();
  assert.deepEqual(taskkillCalls.map(({ command, args }) => ({ command, args })), [{
    command: "taskkill",
    args: ["/PID", String(fake.child.pid), "/T", "/F"],
  }]);
});

test("failed Windows taskkill fails closed instead of trusting wrapper exit", async () => {
  const taskkillCalls = [];
  const spawnProcess = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  };
  const { fake, client } = makeClient({}, { platform: "win32", spawnProcess });
  await client.initialize();
  await assert.rejects(() => client.close(), /child teardown could not be verified.*taskkill exited 1/i);
  assert.equal(taskkillCalls.length, 1);
  assert.equal(fake.child.signalCode, null, "killing only cmd.exe cannot prove its Codex grandchild stopped");
});

test("direct-child teardown fails closed when TERM is refused and no exit is observed", async () => {
  const { fake, client } = makeClient();
  await client.initialize();
  fake.child.kill = () => false;
  await assert.rejects(() => client.close(), /child teardown could not be verified.*SIGTERM was refused/i);
  assert.equal(fake.child.exitCode, null);
  assert.equal(fake.child.signalCode, null);
});

test("Unix teardown owns the whole spawned process group, not only a configured wrapper", async () => {
  let groupAlive = true;
  const signals = [];
  let fake;
  const processKill = (pid, signal) => {
    signals.push({ pid, signal });
    assert.equal(pid, -fake.child.pid);
    if (signal === 0) {
      if (groupAlive) return true;
      const error = new Error("no such process group");
      error.code = "ESRCH";
      throw error;
    }
    if (signal === "SIGTERM") {
      // The shell wrapper exits, but its descendant deliberately survives.
      queueMicrotask(() => fake.exit(0));
      return true;
    }
    if (signal === "SIGKILL") {
      groupAlive = false;
      return true;
    }
    return true;
  };
  fake = createFakeAppServer();
  const client = new CodexAppServerClient(fake.child, {
    logEvent: noopLog,
    clientName: "test-client",
    clientVersion: "0.0.1",
    platform: "darwin",
    ownsProcessGroup: true,
    processKill,
    killGraceMs: 5,
    reapGraceMs: 50,
  });
  await client.initialize();
  await client.close();
  assert.ok(signals.some((entry) => entry.signal === "SIGTERM"));
  assert.ok(signals.some((entry) => entry.signal === "SIGKILL"), "descendant survived wrapper exit, so exact group was killed");
  assert.equal(groupAlive, false);
});

test("Unix teardown verifies the owned process group even when its wrapper exited before close", async () => {
  let groupAlive = true;
  const signals = [];
  let fake;
  const processKill = (pid, signal) => {
    signals.push({ pid, signal });
    assert.equal(pid, -fake.child.pid);
    if (signal === 0) {
      if (groupAlive) return true;
      const error = new Error("no such process group");
      error.code = "ESRCH";
      throw error;
    }
    if (signal === "SIGKILL") groupAlive = false;
    return true;
  };
  fake = createFakeAppServer();
  const client = new CodexAppServerClient(fake.child, {
    logEvent: noopLog,
    clientName: "test-client",
    clientVersion: "0.0.1",
    platform: "darwin",
    ownsProcessGroup: true,
    processKill,
    killGraceMs: 5,
    reapGraceMs: 50,
  });
  await client.initialize();
  fake.exit(0);
  await client.close();
  assert.ok(signals.some((entry) => entry.signal === "SIGTERM"));
  assert.ok(signals.some((entry) => entry.signal === "SIGKILL"));
  assert.equal(groupAlive, false);
});

test("Windows teardown never trusts a pre-exited wrapper without exact tree cleanup", async () => {
  const taskkillCalls = [];
  const spawnProcess = (command, args, options) => {
    taskkillCalls.push({ command, args, options });
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 0, null));
    return killer;
  };
  const { fake, client } = makeClient({}, { platform: "win32", spawnProcess });
  await client.initialize();
  fake.exit(0);
  await client.close();
  assert.equal(taskkillCalls.length, 1);
  assert.deepEqual(taskkillCalls[0].args, ["/PID", String(fake.child.pid), "/T", "/F"]);
});

test("oversized un-terminated line closes the connection instead of buffering forever", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const closed = new Promise((resolve) => client.onClose(resolve));
  fake.writeRaw("x".repeat(1_100_000)); // > 1MB, no newline
  const err = await closed;
  assert.match(String(err.message), /exceeded/);
  await tickAsync();
  assert.ok(fake.child.exitCode !== null || fake.child.signalCode !== null,
    "oversized framing failure tears down the child");
});

test("oversized newline-terminated frame closes the connection before parsing", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const closed = new Promise((resolve) => client.onClose(resolve));
  const frame = Buffer.from(`${JSON.stringify({ method: "oversized/frame", params: { blob: "x".repeat(1_000_000) } })}\n`);
  assert.ok(frame.length > 1_000_000, "fixture must exceed the framing limit");
  fake.writeRaw(frame);
  const err = await closed;
  assert.match(String(err.message), /exceeded/);
  assert.equal(client.parseFailures, 0, "oversized complete frames are rejected before JSON parsing");
  await tickAsync();
  assert.ok(fake.child.exitCode !== null || fake.child.signalCode !== null,
    "oversized complete frame tears down the child");
  await client.close();
});

test("notification handlers receive notifications and can unsubscribe", async () => {
  const { fake, client } = makeClient({ autoRespond: false });
  const seen = [];
  const dispose = client.onNotification((n) => seen.push(n.method));
  fake.sendNotification("turn/started", { turn: { id: "t1" } });
  await tickAsync();
  dispose();
  fake.sendNotification("turn/completed", { turn: { id: "t1" } });
  await tickAsync();
  assert.deepEqual(seen, ["turn/started"]);
  await client.close();
});

test("version comparison + user agent parsing", () => {
  assert.equal(parseCodexVersionFromUserAgent("codex/0.145.0 (Mac OS 26.0.1; arm64)"), "0.145.0");
  assert.equal(parseCodexVersionFromUserAgent("Codex CLI"), null);
  assert.equal(compareVersions("0.145.0", "0.143.0") > 0, true);
  assert.equal(compareVersions("0.143.0", "0.143.0"), 0);
  assert.equal(compareVersions("0.9.9", "0.143.0") < 0, true);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0") < 0, true);
});

test("binary candidate resolution: pinned binaries are EXCLUSIVE, fallbacks only when unpinned", () => {
  const fromEnv = codexBinaryCandidates({
    env: { AGENT_BRIDGE_CODEX_BIN: "/custom/codex" },
    configuredBin: "/configured/codex",
  });
  assert.deepEqual(fromEnv, ["/custom/codex"], "env pin never falls back to another build");
  const fromConfig = codexBinaryCandidates({ env: {}, configuredBin: "/configured/codex" });
  assert.deepEqual(fromConfig, ["/configured/codex"]);
  const plain = codexBinaryCandidates({ env: {} });
  assert.ok(plain.includes("codex"));
  assert.ok(plain.length >= 2, "unpinned resolution keeps platform fallbacks");
});

test("CodexAppServerClient.spawn errors helpfully when the pinned binary is missing", async () => {
  // Hermetic BY CONSTRUCTION: a pinned AGENT_BRIDGE_CODEX_BIN is the only
  // candidate, so this can never fall through to a real codex install on
  // developer machines.
  await assert.rejects(
    () => CodexAppServerClient.spawn({
      env: { AGENT_BRIDGE_CODEX_BIN: "definitely-not-a-real-binary-xyz", PATH: "", Path: "" },
      logEvent: noopLog,
    }),
    /codex binary not found.*definitely-not-a-real-binary-xyz/is,
  );
});

function tickAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}
