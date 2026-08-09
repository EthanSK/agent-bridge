import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexAppServerClient, CodexRpcError } from "../src/app-server-client.js";
import {
  ThreadSession,
  buildElicitationDecline,
  buildEmptyUserInputAnswers,
  buildLegacyApprovalDecline,
  errorLooksInvalidParams,
  errorLooksTurnActive,
  sandboxPolicyForMode,
} from "../src/session.js";
import { pendingSettingsPath } from "../src/paths.js";
import { createFakeAppServer } from "./fake-app-server.mjs";
import { writeFileDurable } from "../src/fsutil.js";

const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD_B = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002";
const noop = () => {};

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-session-"));
  return { AGENT_BRIDGE_HOME: join(root, ".agent-bridge") };
}

function binding(policy = {}, extras = {}) {
  return {
    alias: extras.alias ?? "review",
    threadId: extras.threadId ?? THREAD,
    cwd: Object.hasOwn(extras, "cwd") ? extras.cwd : "/tmp/proj",
    policy: { steering: false, ownershipGuard: true, approvalPolicy: "never", sandbox: "workspace-write", turnTimeoutMs: null, ...policy },
  };
}

async function makeSession(fakeOptions = {}, sessionExtras = {}) {
  const env = sessionExtras.env ?? makeEnv();
  const fake = createFakeAppServer(fakeOptions);
  const client = new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "t", clientVersion: "0" });
  await client.initialize();
  const session = new ThreadSession({
    client,
    binding: binding(sessionExtras.policy ?? {}, sessionExtras.bindingExtras ?? {}),
    logEvent: sessionExtras.logEvent ?? noop,
    onIdle: sessionExtras.onIdle,
    onTurnCompleted: sessionExtras.onTurnCompleted,
    env,
    journalUnlink: sessionExtras.journalUnlink,
    journalWrite: sessionExtras.journalWrite,
    dispatchFence: sessionExtras.dispatchFence,
  });
  return { fake, client, session, env };
}

// ── Resume exactness ────────────────────────────────────────────────────────

test("resume subscribes the exact thread, captures original settings, and releases cleanly", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  assert.equal(session.subscribed, true);
  const resumeReq = fake.requestsFor("thread/resume")[0];
  assert.equal(resumeReq.params.threadId, THREAD);
  // Exact 0.145 shape: recent full page requested so in-progress turns can
  // be hydrated before declaring idle.
  assert.deepEqual(resumeReq.params.initialTurnsPage, { limit: 20, sortDirection: "desc", itemsView: "full" });
  assert.equal(session.turnActive, false, "idle thread resumes idle");
  // Original settings captured from the resume response for later restore.
  assert.equal(session.originalSettings.cwd, "/original/cwd");
  assert.equal(session.originalSettings.approvalPolicy, "on-request");
  assert.equal(session.originalSettings.sandboxPolicy.networkAccess, true);
  await session.release();
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
  await client.close();
});

test("resume REFUSES a substitute thread and unsubscribes it", async () => {
  const { fake, client, session } = await makeSession({
    resumeResult: () => ({ thread: { id: "totally-different-thread" } }),
  });
  await assert.rejects(() => session.resume(), /refusing substitute thread/);
  assert.equal(session.subscribed, false);
  const unsub = fake.requestsFor("thread/unsubscribe");
  assert.deepEqual(
    unsub.map((request) => request.params.threadId),
    ["totally-different-thread", THREAD],
    "both the returned substitute and requested thread are unwound",
  );
  await client.close();
});

test("resume with NO returned thread id is a FAILURE and unwinds the requested subscription", async () => {
  const { fake, client, session } = await makeSession({
    resumeResult: () => ({}),
  });
  await assert.rejects(() => session.resume(), /no thread id/i);
  assert.equal(session.subscribed, false);
  assert.deepEqual(fake.requestsFor("thread/unsubscribe").map((request) => request.params.threadId), [THREAD]);
  await client.close();
});

test("accepted resume with a lost response unsubscribes before retrying", async () => {
  const { fake, client, session } = await makeSession({ dropResumeResponse: true });
  await assert.rejects(() => session.resume({ timeoutMs: 100 }), /thread\/resume timed out/);
  assert.equal(session.subscribed, false);
  assert.deepEqual(fake.requestsFor("thread/unsubscribe").map((request) => request.params.threadId), [THREAD]);
  assert.equal(fake.requestsFor("turn/start").length, 0);
  assert.equal(client.closed, true, "an ambiguous resume always recycles the connection after cleanup");
  await client.close();
});

test("delayed resume cannot subscribe after a successful cleanup response on the same connection", async () => {
  const { fake, client, session } = await makeSession({ resumeDelayMs: 200 });
  await assert.rejects(() => session.resume({ timeoutMs: 100 }), /thread\/resume timed out/);
  assert.deepEqual(fake.requestsFor("thread/unsubscribe").map((request) => request.params.threadId), [THREAD]);
  assert.equal(client.closed, true, "the connection is closed before delayed resume acceptance can survive");
  assert.equal(session.subscribed, false);
});

test("post-resume journal validation failure unsubscribes the requested thread", async () => {
  const env = makeEnv();
  const path = pendingSettingsPath("review", env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileDurable(path, JSON.stringify({
    version: 1,
    token: "journal-other-thread",
    alias: "review",
    threadId: THREAD_B,
    originalSettings: { cwd: "/original/cwd" },
    expectedOverrides: { cwd: "/tmp/proj" },
    state: "pending",
  }));
  const { fake, client, session } = await makeSession({}, { env });
  await assert.rejects(() => session.resume(), /belongs to thread/);
  assert.deepEqual(fake.requestsFor("thread/unsubscribe").map((request) => request.params.threadId), [THREAD]);
  assert.equal(fake.requestsFor("turn/start").length, 0);
  await client.close();
});

test("workspace-write without an explicit binding cwd validates and sends the task's persisted cwd", async () => {
  const safeCwd = process.cwd();
  const { fake, client, session } = await makeSession(
    { originalCwd: safeCwd, emitTurnLifecycle: false },
    { bindingExtras: { cwd: null } },
  );
  await session.resume();
  await session.startTurn({ text: "safe inherited workspace", clientUserMessageId: "msg-inherited-cwd" });
  const request = fake.requestsFor("turn/start")[0];
  assert.equal(request.params.cwd, safeCwd);
  assert.deepEqual(request.params.sandboxPolicy.writableRoots, [safeCwd]);
  await client.close();
});

test("workspace-write fails closed when an unbound task's persisted cwd is broad", async () => {
  const { fake, client, session } = await makeSession(
    { originalCwd: "/" },
    { bindingExtras: { cwd: null } },
  );
  await assert.rejects(() => session.resume(), /workspace-write requires a safe project cwd/);
  assert.equal(fake.requestsFor("turn/start").length, 0);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
  await client.close();
});

test("ambiguous unsubscribe recycles the connection instead of orphaning a handlerless subscription", async () => {
  const { fake, client, session } = await makeSession({ dropUnsubscribeResponse: true });
  await session.resume();
  const released = await session.release({ timeoutMs: 100 });
  assert.equal(released.released, true);
  assert.equal(released.connectionRecycled, true);
  assert.equal(session.subscribed, false);
  assert.equal(client.closed, true);
  assert.equal(client.notificationHandlers.size, 0);
  assert.equal(client.requestHandlers.size, 0);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
});

test("clean unsubscribe rejection keeps the subscribed session and handlers for retry", async () => {
  const { fake, client, session } = await makeSession({
    unsubscribeResult: () => {
      const error = new Error("still subscribed");
      error.rpcCode = -32000;
      throw error;
    },
  });
  await session.resume();
  const released = await session.release({ timeoutMs: 100 });
  assert.deepEqual(released, { released: false, reason: "unsubscribe_rejected" });
  assert.equal(session.subscribed, true);
  assert.equal(client.closed, false);
  assert.equal(client.notificationHandlers.size, 1);
  assert.equal(client.requestHandlers.size, 1);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
  await client.close();
});

// ── Turn delivery ───────────────────────────────────────────────────────────

test("startTurn delivers with clientUserMessageId, safe policies, and tracks the turn", async () => {
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false, turnStartResult: () => ({ turn: { id: "turn-1" } }) });
  await session.resume();
  const result = await session.startTurn({ text: "hello", clientUserMessageId: "msg-abc" });
  assert.equal(result.turnId, "turn-1");
  assert.equal(session.turnActive, true);
  assert.equal(session.activeTurnOurs, true);
  const req = fake.requestsFor("turn/start")[0];
  assert.equal(req.params.threadId, THREAD);
  assert.equal(req.params.clientUserMessageId, "msg-abc");
  assert.equal(req.params.cwd, "/tmp/proj");
  assert.equal(req.params.approvalPolicy, "never");
  assert.deepEqual(req.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/proj"],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.deepEqual(req.params.input, [{ type: "text", text: "hello", text_elements: [] }]);
  await client.close();
});

test("atomic dispatch fence refusal sends no turn bytes and resolves the pre-send settings journal", async () => {
  let fencedDispatches = 0;
  const { fake, client, session, env } = await makeSession(
    { emitTurnLifecycle: false },
    {
      dispatchFence: (dispatch) => {
        fencedDispatches += 1;
        if (fencedDispatches !== 1) return false;
        dispatch();
        return true;
      },
    },
  );
  await session.resume();
  assert.deepEqual(
    await session.startTurn({ text: "must not dispatch", clientUserMessageId: "msg-fenced" }),
    { fenced: true },
  );
  assert.equal(fake.requestsFor("turn/start").length, 0);
  assert.equal(session.sentOverrides, false);
  assert.equal(session.settingsRestored, true);
  assert.equal(existsSync(pendingSettingsPath("review", env)), false);
  await client.close();
});

test("dispatch-fenced start stays attached until its no-overrides journal resolution is durable", async () => {
  let failResolution = true;
  const { fake, client, session, env } = await makeSession(
    { emitTurnLifecycle: false },
    {
      dispatchFence: (dispatch, request) => {
        if (request?.method === "turn/start") return false;
        dispatch();
        return true;
      },
      journalWrite: (path, contents) => {
        if (JSON.parse(contents).state === "resolved" && failResolution) {
          throw Object.assign(new Error("simulated journal fsync failure"), { code: "EIO" });
        }
        return writeFileDurable(path, contents);
      },
    },
  );
  await session.resume();
  assert.deepEqual(
    await session.startTurn({ text: "must not dispatch", clientUserMessageId: "msg-fenced-journal" }),
    { fenced: true },
  );
  assert.equal(fake.requestsFor("turn/start").length, 0);
  assert.equal(session.sentOverrides, true);
  assert.equal(session.settingsRestored, false);
  assert.equal(session.overridesRejected, true);
  assert.equal(existsSync(pendingSettingsPath("review", env)), true);

  assert.deepEqual(await session.release(), { released: false, reason: "rejected_journal_resolve_failed" });
  assert.equal(session.subscribed, true, "failed durable resolution retains the live guard");
  assert.equal(fake.requestsFor("thread/settings/update").length, 0);

  failResolution = false;
  assert.equal((await session.release()).released, true);
  assert.equal(fake.requestsFor("thread/settings/update").length, 0, "known-unsent overrides are never restored");
  assert.equal(existsSync(pendingSettingsPath("review", env)), false);
  await client.close();
});

test("turn completion notification clears activity and fires onIdle + onTurnCompleted", async () => {
  let idleCount = 0;
  const completions = [];
  const { client, session } = await makeSession({}, {
    onIdle: () => { idleCount += 1; },
    onTurnCompleted: (finished) => completions.push(finished),
  });
  await session.resume();
  await session.startTurn({ text: "go", clientUserMessageId: "msg-1" });
  await waitFor(() => !session.turnActive);
  assert.equal(session.turnActive, false);
  assert.ok(idleCount >= 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].ours, true);
  assert.equal(completions[0].status, "completed");
  await client.close();
});

test("failed turn surfaces terminal status + error message via onTurnCompleted", async () => {
  const completions = [];
  const fake = createFakeAppServer({ emitTurnLifecycle: false });
  const client = new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "t", clientVersion: "0" });
  await client.initialize();
  const session = new ThreadSession({
    client, binding: binding(), logEvent: noop,
    onTurnCompleted: (finished) => completions.push(finished),
    env: makeEnv(),
  });
  await session.resume();
  await session.startTurn({ text: "boom", clientUserMessageId: "msg-f" });
  const turnId = session.activeTurnId;
  fake.sendNotification("turn/completed", {
    threadId: THREAD,
    turn: { id: turnId, status: "failed", error: { message: "model exploded" } },
  });
  await waitFor(() => !session.turnActive);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "failed");
  assert.equal(completions[0].errorMessage, "model exploded");
  await client.close();
});

test("durable identity invariant: clientUserMessageId is NEVER dropped on structural rejection", async () => {
  const { fake, client, session } = await makeSession({
    emitTurnLifecycle: false,
    turnStartResult: (params) => {
      if (params.clientUserMessageId) {
        const err = new Error("invalid params: unknown field `clientUserMessageId`");
        err.rpcCode = -32602;
        throw err;
      }
      return { turn: { id: "turn-compat" } };
    },
  });
  await session.resume();
  await assert.rejects(
    () => session.startTurn({ text: "x", clientUserMessageId: "msg-2" }),
    /invalid params/,
    "no silent identity-dropping retry — the error surfaces (0.145 floor guarantees the field)",
  );
  assert.equal(fake.requestsFor("turn/start").length, 1, "exactly one attempt, id intact");
  assert.equal(fake.requestsFor("turn/start")[0].params.clientUserMessageId, "msg-2");
  await client.close();
});

// ── Pending-start lifecycle correlation (ordering) ──────────────────────────

test("early completion BEFORE the turn/start response is emitted exactly once as OUR completion", async () => {
  // The default fake emits turn/started + item/completed + turn/completed
  // SYNCHRONOUSLY inside the turn/start exchange — before the response
  // continuation can mark the id as ours. Attribution must survive.
  const completions = [];
  const { client, session } = await makeSession({}, {
    onTurnCompleted: (finished) => completions.push(finished),
  });
  await session.resume();
  await session.startTurn({ text: "quick", clientUserMessageId: "msg-early" });
  await waitFor(() => completions.length >= 1);
  assert.equal(completions.length, 1, "exactly once");
  assert.equal(completions[0].ours, true, "ownership established retroactively by the response");
  assert.equal(completions[0].status, "completed");
  assert.equal(session.turnActive, false, "completed turn never re-marked active");
  await client.close();
});

test("stale duplicate completion after attribution does not double-fire", async () => {
  const completions = [];
  const { fake, client, session } = await makeSession({}, {
    onTurnCompleted: (finished) => completions.push(finished),
  });
  await session.resume();
  await session.startTurn({ text: "once", clientUserMessageId: "msg-once" });
  await waitFor(() => completions.length >= 1);
  const turnId = completions[0].turnId;
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
  await tick();
  assert.equal(completions.length, 1, "recently-completed memory blocks resurrection AND duplicate callbacks");
  await client.close();
});

test("early completion for a DIFFERENT turn than the response id is foreign (no ours callback, guarded restore)", async () => {
  const completions = [];
  const { fake, client, session } = await makeSession({
    emitTurnLifecycle: false,
    turnStartResult: () => {
      // While turn/start is being handled, a FOREIGN turn starts+completes;
      // frames are queued on the same stream before our response.
      fake.sendNotification("turn/started", { threadId: THREAD, turn: { id: "foreign-race" } });
      fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: "foreign-race", status: "completed" } });
      return { turn: { id: "turn-ours" } };
    },
  }, { onTurnCompleted: (finished) => completions.push(finished) });
  await session.resume();
  const result = await session.startTurn({ text: "mine", clientUserMessageId: "msg-race" });
  assert.equal(result.turnId, "turn-ours");
  assert.equal(completions.length, 0, "foreign completion never attributed to us");
  assert.equal(session.activeTurnId, "turn-ours", "our turn is active after settle");
  assert.equal(session.activeTurnOurs, true);
  assert.equal(session.foreignTurnSinceOverrides, true, "raced foreign turn blocks blind settings restore");
  await client.close();
});

test("startTurn surfaces busy for already-active-turn errors instead of failing", async () => {
  const { fake, client, session, env } = await makeSession({
    turnStartResult: () => {
      throw new Error("a turn is already in progress for this thread");
    },
  });
  await session.resume();
  const result = await session.startTurn({ text: "x", clientUserMessageId: "msg-3" });
  assert.deepEqual(result, { busy: true });
  assert.equal(session.unknownActiveTurn, true, "clean busy response establishes safe busy state");
  assert.equal(fake.settingsUpdates.length, 0, "rejected start never triggers a settings restore");
  assert.equal(existsSync(pendingSettingsPath("review", env)), false, "pre-send settings journal resolved as not applied");
  await session.release();
  assert.equal(fake.settingsUpdates.length, 0);
  await client.close();
});

test("typed non-busy turn rejection resolves the settings journal and never restores unapplied overrides", async () => {
  const { fake, client, session, env } = await makeSession({
    turnStartResult: () => { throw new Error("model unavailable"); },
  });
  await session.resume();
  await assert.rejects(() => session.startTurn({ text: "x", clientUserMessageId: "msg-clean-reject" }), /model unavailable/);
  assert.equal(fake.settingsUpdates.length, 0);
  assert.equal(existsSync(pendingSettingsPath("review", env)), false);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 0);
  await client.close();
});

test("startTurn requires every sticky field it overrides to have a restorable original", async () => {
  const cases = [
    { label: "cwd", options: { originalCwd: undefined }, pattern: /cwd/ },
    { label: "approval", options: { originalApprovalPolicy: undefined }, pattern: /approvalPolicy/ },
    { label: "sandbox", options: { originalSandboxPolicy: undefined, originalActivePermissionProfile: null }, pattern: /sandbox/ },
  ];
  for (const fixture of cases) {
    const { fake, client, session } = await makeSession({ ...fixture.options, emitTurnLifecycle: false });
    await session.resume();
    await assert.rejects(
      () => session.startTurn({ text: fixture.label, clientUserMessageId: `msg-missing-${fixture.label}` }),
      fixture.pattern,
    );
    assert.equal(fake.requestsFor("turn/start").length, 0, `${fixture.label}: no sticky override was sent`);
    await client.close();
  }
});

// ── Schema-exact server requests ────────────────────────────────────────────

test("command/file approvals answer the exact decision shape (no extra fields)", async () => {
  const events = [];
  const { fake, client, session } = await makeSession({}, { logEvent: (l, e) => events.push(e) });
  await session.resume();

  const cmd = await fake.sendServerRequest("item/commandExecution/requestApproval", { threadId: THREAD });
  assert.deepEqual(cmd.result, { decision: "decline" }, "exact schema shape, no unknown reason field");
  const file = await fake.sendServerRequest("item/fileChange/requestApproval", { threadId: THREAD });
  assert.deepEqual(file.result, { decision: "decline" });
  const future = await fake.sendServerRequest("item/somethingNew/requestApproval", { threadId: THREAD });
  assert.deepEqual(future.result, { decision: "decline" });
  assert.ok(events.includes("codex.approval_declined"));
  assert.equal(session.approvalDeclineCount, 3);
  await client.close();
});

test("legacy patch/exec approvals return the exact ReviewDecision denied shape", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  const expected = buildLegacyApprovalDecline();
  assert.deepEqual((await fake.sendServerRequest("applyPatchApproval", { conversationId: THREAD })).result, expected);
  assert.deepEqual(
    (await fake.sendServerRequest("execCommandApproval", { conversationId: THREAD })).result,
    expected,
  );
  assert.equal(session.approvalDeclineCount, 2);
  await client.close();
});

test("permission approvals grant nothing with the exact permissions/scope shape", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  const perms = await fake.sendServerRequest("item/permissions/requestApproval", { threadId: THREAD });
  assert.deepEqual(perms.result, { permissions: {}, scope: "turn" });
  await client.close();
});

test("requestUserInput answers EVERY question with empty answers (schema-exact)", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  const input = await fake.sendServerRequest("item/tool/requestUserInput", {
    threadId: THREAD,
    questions: [{ id: "q1", text: "which db?" }, { id: "q2", text: "which env?" }],
  });
  assert.deepEqual(input.result, { answers: { q1: { answers: [] }, q2: { answers: [] } } });
  // No questions => empty map, still schema-valid.
  const empty = await fake.sendServerRequest("item/tool/requestUserInput", { threadId: THREAD });
  assert.deepEqual(empty.result, { answers: {} });
  await client.close();
});

test("MCP elicitation declines with the exact schema shape", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  const res = await fake.sendServerRequest("mcpServer/elicitation/request", { threadId: THREAD });
  assert.deepEqual(res.result, { action: "decline", content: null, _meta: null });
  assert.deepEqual(buildElicitationDecline(), { action: "decline", content: null, _meta: null });
  await client.close();
});

test("shape helpers are schema-exact", () => {
  assert.deepEqual(
    buildEmptyUserInputAnswers({ questions: [{ id: "a" }, { questionId: "b" }, { nope: true }] }),
    { answers: { a: { answers: [] }, b: { answers: [] } } },
  );
  assert.deepEqual(buildEmptyUserInputAnswers({}), { answers: {} });
});

test("approval requests during a delivered turn resolve without blocking turn completion", async () => {
  const { client, session } = await makeSession({
    turnServerRequest: { method: "item/commandExecution/requestApproval", params: {} },
  });
  await session.resume();
  await session.startTurn({ text: "risky", clientUserMessageId: "msg-4" });
  await waitFor(() => !session.turnActive);
  assert.equal(session.approvalDeclineCount, 1);
  await client.close();
});

// ── Multi-session dispatch ──────────────────────────────────────────────────

test("two sessions dispatch by threadId; releasing the newest keeps the survivor handling; unknown context fails closed", async () => {
  const fake = createFakeAppServer({ emitTurnLifecycle: false });
  const client = new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "t", clientVersion: "0" });
  await client.initialize();
  const sharedEnv = makeEnv();
  const sessionA = new ThreadSession({ client, binding: binding({}, { alias: "a", threadId: THREAD }), logEvent: noop, env: sharedEnv });
  const sessionB = new ThreadSession({ client, binding: binding({}, { alias: "b", threadId: THREAD_B }), logEvent: noop, env: sharedEnv });
  await sessionA.resume();
  await sessionB.resume();

  const forA = await fake.sendServerRequest("item/commandExecution/requestApproval", { threadId: THREAD });
  assert.deepEqual(forA.result, { decision: "decline" });
  assert.equal(sessionA.approvalDeclineCount, 1);
  assert.equal(sessionB.approvalDeclineCount, 0);

  const forB = await fake.sendServerRequest("item/commandExecution/requestApproval", { threadId: THREAD_B });
  assert.deepEqual(forB.result, { decision: "decline" });
  assert.equal(sessionB.approvalDeclineCount, 1);

  // Lifecycle notifications without the schema-required threadId are
  // malformed. They must not mutate every live session on the connection.
  fake.sendNotification("turn/started", { turn: { id: "missing-thread" } });
  await tick();
  assert.equal(sessionA.turnActive, false);
  assert.equal(sessionB.turnActive, false);
  fake.sendNotification("turn/started", { threadId: THREAD, turn: { id: "only-a" } });
  await waitFor(() => sessionA.turnActive);
  fake.sendNotification("turn/completed", { turn: { id: "only-a", status: "completed" } });
  await tick();
  assert.equal(sessionA.turnActive, true, "missing-context completion cannot clear A");
  assert.equal(sessionB.turnActive, false);
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: "only-a", status: "completed" } });
  await waitFor(() => !sessionA.turnActive);

  // Release the NEWEST session; the survivor must still handle its requests.
  await sessionB.release();
  const survivorReq = await fake.sendServerRequest("item/permissions/requestApproval", { threadId: THREAD });
  assert.deepEqual(survivorReq.result, { permissions: {}, scope: "turn" });
  assert.equal(sessionA.approvalDeclineCount, 1, "survivor counters unaffected by release of the other session");

  // Requests for the RELEASED thread (or unknown context) hit the global
  // fail-closed defaults — a safe decline, never an approval, never a hang.
  const orphan = await fake.sendServerRequest("item/commandExecution/requestApproval", { threadId: THREAD_B });
  assert.deepEqual(orphan.result, { decision: "decline" });
  const noContext = await fake.sendServerRequest("item/fileChange/requestApproval", {});
  assert.deepEqual(noContext.result, { decision: "decline" });
  assert.equal(sessionA.approvalDeclineCount, 1, "fail-closed answers are not attributed to the survivor");

  await sessionA.release();
  await client.close();
});

// ── Steering ────────────────────────────────────────────────────────────────

test("steerTurn requires expected turn id and returns steered", async () => {
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false });
  await session.resume();
  await session.startTurn({ text: "long job", clientUserMessageId: "msg-5" });
  const result = await session.steerTurn({ text: "and also", clientUserMessageId: "msg-6", expectedTurnId: session.activeTurnId });
  assert.deepEqual(result, { steered: true });
  const req = fake.requestsFor("turn/steer")[0];
  assert.equal(req.params.expectedTurnId, session.activeTurnId);
  assert.deepEqual(req.params.input, [{ type: "text", text: "and also", text_elements: [] }]);
  await client.close();
});

// ── Dedupe probe (thread/items/list, fail-closed) ───────────────────────────

test("threadContains uses thread/items/list with exact 0.145 pagination and matches userMessage.clientId", async () => {
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false });
  await session.resume();
  const started = await session.startTurn({ text: "…message_id: msg-present…", clientUserMessageId: "msg-present" });
  assert.equal(await session.threadContains("msg-present"), true, "exact clientId echo match");
  assert.equal(session.lastHistoryMatchTurnId, started.turnId, "probe correlates the exact containing turn");
  assert.equal(await session.threadContains("msg-absent"), false, "exhausted history => authoritative absent");
  assert.equal(session.lastHistoryMatchTurnId, null, "a miss clears stale correlation");
  const lists = fake.requestsFor("thread/items/list");
  assert.ok(lists.length >= 2);
  for (const req of lists) {
    assert.equal(req.params.threadId, THREAD);
    assert.equal(req.params.sortDirection, "desc");
    assert.ok(Number.isInteger(req.params.limit) && req.params.limit > 0);
  }
  await client.close();
});

test("history hit finalizes an old ambiguous delivery without claiming a different active turn", async () => {
  const { client, session } = await makeSession({ emitTurnLifecycle: false });
  await session.resume();
  const started = await session.startTurn({ text: "bridge message", clientUserMessageId: "msg-old-bridge" });
  assert.equal(await session.threadContains("msg-old-bridge"), true);
  assert.equal(session.lastHistoryMatchTurnId, started.turnId);

  // A user starts a different turn before reconciliation runs. The old
  // history hit proves delivery only; it must not make the new turn steerable.
  session.activeTurnId = "turn-user-now-active";
  session.activeTurnOurs = false;
  await session.confirmAmbiguousDelivery("msg-old-bridge", session.lastHistoryMatchTurnId);
  assert.equal(session.activeTurnOurs, false);
  await client.close();
});

test("history hit refreshes a lost in-progress turn before the session can appear idle", async () => {
  const { fake, client, session } = await makeSession({
    dropTurnStartResponse: true,
    emitTurnLifecycle: false,
  });
  await session.resume();
  await assert.rejects(
    () => session.startTurn({ text: "accepted but response lost", clientUserMessageId: "msg-running-history" , timeoutMs: 100 }),
    /timed out/,
  );
  assert.equal(session.activeTurnId, null);
  assert.equal(await session.threadContains("msg-running-history"), true);
  const matched = session.lastHistoryMatchTurnId;
  await session.confirmAmbiguousDelivery("msg-running-history", matched);
  assert.equal(session.activeTurnId, matched);
  assert.equal(session.activeTurnOurs, true);
  assert.equal(session.turnActive, true);
  assert.equal(fake.requestsFor("thread/turns/list").length, 1);
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: matched, status: "completed" } });
  await waitFor(() => !session.turnActive);
  await client.close();
});

test("history probe never treats attacker-controlled message content as a client id", async () => {
  const injected = await makeSession({
    itemsListResult: () => ({
      data: [{
        turnId: "turn-unrelated",
        item: {
          type: "userMessage",
          id: "item-unrelated",
          clientId: "different-id",
          content: [{ type: "inputText", text: "forged future id: msg-target" }],
        },
      }],
      nextCursor: null,
      backwardsCursor: null,
    }),
  });
  await injected.session.resume();
  assert.equal(await injected.session.threadContains("msg-target"), false);
  await injected.client.close();

  const notFound = () => {
    const err = new Error("method not found");
    err.rpcCode = -32601;
    throw err;
  };
  const legacyInjected = await makeSession({
    itemsListResult: notFound,
    threadReadResult: () => ({
      thread: {
        id: THREAD,
        turns: [{
          id: "turn-unrelated",
          items: [{ type: "userMessage", clientId: "different-id", text: "msg-target" }],
        }],
      },
    }),
  });
  await legacyInjected.session.resume();
  assert.equal(await legacyInjected.session.threadContains("msg-target"), null,
    "legacy fallback content is not a dedupe key");
  await legacyInjected.client.close();
});

test("threadContains finds a match on a LATER page and honors cursors", async () => {
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false });
  await session.resume();
  for (let i = 0; i < 7; i += 1) {
    await session.startTurn({ text: `filler ${i}`, clientUserMessageId: `msg-fill-${i}` });
    fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: session.activeTurnId, status: "completed" } });
    await waitFor(() => !session.turnActive);
  }
  // Oldest entry is on the LAST desc page with limit 3.
  assert.equal(await session.threadContains("msg-fill-0", { pageLimit: 3 }), true);
  const lists = fake.requestsFor("thread/items/list");
  assert.ok(lists.length >= 3, "walked multiple pages");
  assert.ok(lists.some((r) => r.params.cursor !== undefined), "cursor carried between pages");
  await client.close();
});

test("threadContains fails CLOSED: cursor loops and caps return null, never false", async () => {
  const loop = await makeSession({
    itemsListResult: () => ({
      data: [{ turnId: "turn-x", item: { type: "userMessage", id: "x", clientId: "other", content: [{ type: "inputText", text: "y" }] } }],
      nextCursor: "same",
      backwardsCursor: "0",
    }),
  });
  await loop.session.resume();
  assert.equal(await loop.session.threadContains("msg-z"), null, "cursor loop => indeterminate");
  await loop.client.close();

  let page = 0;
  const capped = await makeSession({
    itemsListResult: () => ({
      data: [{ turnId: `t-${page}`, item: { type: "userMessage", id: `i-${page}`, clientId: `c-${page}`, content: [{ type: "inputText", text: "x" }] } }],
      nextCursor: String(++page),
      backwardsCursor: null,
    }),
  });
  await capped.session.resume();
  assert.equal(await capped.session.threadContains("msg-z", { maxPages: 5 }), null, "page cap => indeterminate");
  assert.equal(await capped.session.threadContains("msg-z", { maxItems: 3 }), null, "item cap => indeterminate");
  await capped.client.close();
});

test("threadContains fails CLOSED on RPC/schema failures", async () => {
  const broken = await makeSession({
    itemsListResult: () => { throw new Error("backend exploded"); },
  });
  await broken.session.resume();
  assert.equal(await broken.session.threadContains("msg-x"), null);
  await broken.client.close();

  const badSchema = await makeSession({ itemsListResult: () => ({ nope: true }) });
  await badSchema.session.resume();
  assert.equal(await badSchema.session.threadContains("msg-x"), null);
  await badSchema.client.close();
});

test("compat fallback: items/list method-not-found -> thread/read HIT is authoritative, MISS is null (unprovable), rejection is null", async () => {
  const notFound = () => {
    const err = new Error("method not found");
    err.rpcCode = -32601;
    throw err;
  };
  const hit = await makeSession({ itemsListResult: notFound, emitTurnLifecycle: false });
  await hit.session.resume();
  await hit.session.startTurn({ text: "…message_id: msg-old…", clientUserMessageId: "msg-old" });
  assert.equal(await hit.session.threadContains("msg-old"), true, "exact clientId hit via thread/read fallback");
  assert.equal(hit.fake.requestsFor("thread/read").at(-1).params.includeTurns, true);

  assert.equal(await hit.session.threadContains("msg-never"), null,
    "fallback MISS is indeterminate — exhaustiveness unprovable");
  await hit.client.close();

  const rejected = await makeSession({
    itemsListResult: notFound,
    threadReadResult: () => { throw new Error("includeTurns hydration rejected for paginated history"); },
  });
  await rejected.session.resume();
  assert.equal(await rejected.session.threadContains("msg-x"), null,
    "paginated thread-read rejection => indeterminate, never false");
  await rejected.client.close();
});

// ── Resume hydration of running threads ─────────────────────────────────────

test("resume hydrates an inProgress turn from LEGACY thread.turns as foreign busy", async () => {
  const { client, session } = await makeSession({
    threadStatusType: "active",
    legacyTurns: [
      { id: "turn-done", status: "completed" },
      { id: "turn-live", status: "inProgress" },
    ],
  });
  await session.resume();
  assert.equal(session.turnActive, true);
  assert.equal(session.activeTurnId, "turn-live");
  assert.equal(session.activeTurnOurs, false, "hydrated turn is foreign and unowned — never steered");
  await client.close();
});

test("resume hydrates an inProgress turn from PAGINATED initialTurnsPage.data", async () => {
  const { client, session } = await makeSession({
    threadStatusType: "active",
    initialTurnsData: [{ id: "turn-paged", status: "inProgress" }],
  });
  await session.resume();
  assert.equal(session.activeTurnId, "turn-paged");
  assert.equal(session.activeTurnOurs, false);
  await client.close();
});

test("active thread with NO recoverable turn id enters safe unknown-active busy; a completion clears it", async () => {
  const { fake, client, session } = await makeSession({ threadStatusType: "active" });
  await session.resume();
  assert.equal(session.activeTurnId, null);
  assert.equal(session.turnActive, true, "safe busy state queues rather than starting/steering");
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: "whatever-finished", status: "completed" } });
  await waitFor(() => !session.turnActive);
  assert.equal(session.unknownActiveTurn, false);
  await client.close();
});

test("thread/status/changed idle clears only unknown-active safe busy for the exact thread", async () => {
  let idleCalls = 0;
  const { fake, client, session } = await makeSession({
    threadStatusType: "active",
    initialTurnsData: [],
  }, { onIdle: () => { idleCalls += 1; } });
  await session.resume();
  assert.equal(session.unknownActiveTurn, true);

  fake.sendNotification("thread/status/changed", { threadId: THREAD_B, status: { type: "idle" } });
  fake.sendNotification("thread/status/changed", { status: { type: "idle" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.unknownActiveTurn, true, "wrong/missing thread context is ignored");

  fake.sendNotification("thread/status/changed", { threadId: THREAD, status: { type: "idle" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.unknownActiveTurn, false);
  assert.equal(session.turnActive, false);
  assert.equal(idleCalls, 1);

  await session.startTurn({ text: "now deliverable", clientUserMessageId: "msg-after-idle" });
  assert.equal(fake.requestsFor("turn/start").length, 1);
  await client.close();
});

// ── Granular approval capture (D) ───────────────────────────────────────────

test("granular AskForApproval OBJECTS are captured exactly and restored verbatim", async () => {
  const granular = {
    granular: {
      sandbox_approval: true,
      rules: false,
      skill_approval: true,
      request_permissions: false,
      mcp_elicitations: true,
    },
  };
  const { fake, client, session } = await makeSession({ originalApprovalPolicy: granular });
  await session.resume();
  assert.deepEqual(session.originalSettings.approvalPolicy, granular, "non-string policy preserved exactly");
  await session.startTurn({ text: "work", clientUserMessageId: "msg-g1" });
  await waitFor(() => !session.turnActive);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 1);
  assert.deepEqual(fake.settingsUpdates[0].approvalPolicy, granular, "restoration does not lose the granular policy");
  await client.close();
});

// ── Sticky settings capture/restore ─────────────────────────────────────────

test("release after a bridge turn restores the ORIGINAL thread settings", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  await session.startTurn({ text: "work", clientUserMessageId: "msg-r1" });
  await waitFor(() => !session.turnActive);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 1);
  const update = fake.settingsUpdates[0];
  assert.equal(update.threadId, THREAD);
  assert.equal(update.cwd, "/original/cwd");
  assert.equal(update.approvalPolicy, "on-request");
  assert.equal(update.sandboxPolicy.networkAccess, true);
  // Restore precedes unsubscribe.
  const methods = fake.received.filter((m) => m.method === "thread/settings/update" || m.method === "thread/unsubscribe").map((m) => m.method);
  assert.deepEqual(methods, ["thread/settings/update", "thread/unsubscribe"]);
  await client.close();
});

test("named activePermissionProfile is restored exactly with permissions, never sandboxPolicy", async () => {
  const profile = { id: "ethan-safe-profile", extends: ":workspace" };
  const { fake, client, session } = await makeSession({ originalActivePermissionProfile: profile });
  await session.resume();
  assert.equal(session.originalSettings.permissions, profile.id);
  assert.equal("sandboxPolicy" in session.originalSettings, false, "profile provenance wins over legacy sandbox approximation");
  await session.startTurn({ text: "work", clientUserMessageId: "msg-profile" });
  await waitFor(() => !session.turnActive);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 1);
  assert.equal(fake.settingsUpdates[0].permissions, profile.id);
  assert.equal("sandboxPolicy" in fake.settingsUpdates[0], false, "permissions and sandboxPolicy cannot be combined");
  await client.close();
});

test("crash recovery compares the observed sandbox while restoring the original named permission profile", async () => {
  const env = makeEnv();
  const originalProfile = { id: "ethan-safe-profile", extends: ":workspace" };
  const first = await makeSession({
    originalActivePermissionProfile: originalProfile,
    emitTurnLifecycle: false,
  }, { env });
  await first.session.resume();
  await first.session.startTurn({ text: "work", clientUserMessageId: "msg-profile-crash" });
  assert.ok(existsSync(pendingSettingsPath("review", env)), "pre-bridge profile is durably journaled");
  await first.client.close(); // process crash before settings restore

  const bridgeSandbox = sandboxPolicyForMode("workspace-write", "/tmp/proj");
  const restarted = await makeSession({
    originalCwd: "/tmp/proj",
    originalApprovalPolicy: "never",
    originalSandboxPolicy: bridgeSandbox,
    originalActivePermissionProfile: { id: ":workspace", extends: null },
  }, { env });
  await restarted.session.resume();
  assert.equal(restarted.session.recoveredRestoreJournal, true,
    "implicit built-in profile does not hide the observed bridge sandbox");
  const restored = await restarted.session.restoreThreadSettings();
  assert.equal(restored.restored, true);
  assert.equal(restarted.fake.settingsUpdates.length, 1);
  assert.equal(restarted.fake.settingsUpdates[0].permissions, originalProfile.id);
  assert.equal("sandboxPolicy" in restarted.fake.settingsUpdates[0], false,
    "named-profile restore never combines permissions and sandboxPolicy");
  await restarted.session.release();
  await restarted.client.close();
});

test("accepted turn with a lost response still restores possibly-applied sticky overrides", async () => {
  const { fake, client, session } = await makeSession({
    emitTurnLifecycle: false,
    dropTurnStartResponse: true,
    turnStartResult: () => ({ turn: { id: "turn-accepted-response-lost" } }),
  });
  await session.resume();
  await assert.rejects(
    () => session.startTurn({ text: "accepted", clientUserMessageId: "msg-response-lost", timeoutMs: 10 }),
    /timed out/i,
  );
  assert.equal(fake.acceptedTurnInputs.length, 1, "fake App Server accepted and persisted the turn before losing the response");
  assert.equal(session.sentOverrides, true, "settings are conservatively considered possibly applied at dispatch");
  await session.release();
  assert.equal(fake.settingsUpdates.length, 1, "release restores even though turn/start never returned success");
  await client.close();
});

test("restore failure keeps the session attached and retries successfully on the next release", async () => {
  const { fake, client, session, env } = await makeSession({
    settingsUpdateResult: (_params, call) => {
      if (call === 1) throw new Error("temporary settings backend failure");
      return {};
    },
  });
  await session.resume();
  await session.startTurn({ text: "work", clientUserMessageId: "msg-retry-restore" });
  await waitFor(() => !session.turnActive);
  assert.equal(existsSync(pendingSettingsPath("review", env)), true);
  const first = await session.release();
  assert.equal(first.released, false);
  assert.equal(session.subscribed, true, "failed restoration retains the live session for retry");
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 0);
  assert.equal(existsSync(pendingSettingsPath("review", env)), true, "durable original settings remain pending");

  const second = await session.release();
  assert.equal(second.released, true);
  assert.equal(fake.settingsUpdates.length, 2);
  assert.equal(fake.requestsFor("thread/unsubscribe").length, 1);
  assert.equal(existsSync(pendingSettingsPath("review", env)), false);
  await client.close();
});

test("ambiguous restore response recycles, then a fresh resume preserves later user settings", async () => {
  const env = makeEnv();
  const first = await makeSession({ dropSettingsUpdateResponse: true }, { env });
  await first.session.resume();
  await first.session.startTurn({ text: "work", clientUserMessageId: "msg-ambiguous-restore-user-change" });
  await waitFor(() => !first.session.turnActive);
  const ambiguous = await first.session.restoreThreadSettings({ timeoutMs: 10 });
  assert.equal(ambiguous.reason, "update_ambiguous");
  assert.equal(first.fake.settingsUpdates.length, 1, "the update may already have applied");
  assert.equal(first.client.closed, true, "unknown restore outcome recycles the observation connection");
  assert.equal(existsSync(pendingSettingsPath("review", env)), true);

  const restarted = await makeSession({
    originalCwd: "/user/changed-cwd",
    originalApprovalPolicy: "untrusted",
    originalSandboxPolicy: { type: "readOnly", networkAccess: false },
  }, { env });
  await restarted.session.resume();
  assert.equal(restarted.session.recoveredRestoreJournal, false);
  assert.equal(restarted.fake.settingsUpdates.length, 0, "stale originals are not replayed over the user's change");
  assert.equal(existsSync(pendingSettingsPath("review", env)), false, "the conflicted journal is resolved");
  await restarted.session.release();
  await restarted.client.close();
});

test("ambiguous restore response retries from recovery only while bridge overrides still match", async () => {
  const env = makeEnv();
  const first = await makeSession({ dropSettingsUpdateResponse: true }, { env });
  await first.session.resume();
  await first.session.startTurn({ text: "work", clientUserMessageId: "msg-ambiguous-restore-still-ours" });
  await waitFor(() => !first.session.turnActive);
  const ambiguous = await first.session.restoreThreadSettings({ timeoutMs: 10 });
  assert.equal(ambiguous.reason, "update_ambiguous");
  assert.equal(first.fake.settingsUpdates.length, 1);

  const bridgeSandbox = sandboxPolicyForMode("workspace-write", "/tmp/proj");
  const restarted = await makeSession({
    originalCwd: "/tmp/proj",
    originalApprovalPolicy: "never",
    originalSandboxPolicy: bridgeSandbox,
  }, { env });
  await restarted.session.resume();
  assert.equal(restarted.session.recoveredRestoreJournal, true);
  const restored = await restarted.session.restoreThreadSettings();
  assert.equal(restored.restored, true);
  assert.equal(restarted.fake.settingsUpdates.length, 1, "fresh comparison authorizes exactly one recovery update");
  await restarted.session.release();
  await restarted.client.close();
});

test("journal-resolution retry never replays settings after the restore RPC already succeeded", async () => {
  let failResolvedWrite = true;
  const journalWrite = (path, contents) => {
    const parsed = JSON.parse(contents);
    if (parsed.state === "resolved" && failResolvedWrite) {
      throw Object.assign(new Error("simulated journal disk failure"), { code: "EIO" });
    }
    return writeFileDurable(path, contents);
  };
  const { fake, client, session } = await makeSession({}, { journalWrite });
  await session.resume();
  await session.startTurn({ text: "work", clientUserMessageId: "msg-journal-retry" });
  await waitFor(() => !session.turnActive);

  const first = await session.release();
  assert.equal(first.released, false);
  assert.equal(session.restoreRpcSucceeded, true);
  assert.equal(fake.settingsUpdates.length, 1);

  // Represents legitimate user activity/settings changes during the disk
  // outage. Journal recovery may proceed, but the old snapshot cannot be
  // sent a second time over those changes.
  session.foreignTurnSinceOverrides = true;
  failResolvedWrite = false;
  const second = await session.release();
  assert.equal(second.released, true);
  assert.equal(fake.settingsUpdates.length, 1, "settings/update is never replayed");
  assert.equal(session.settingsRestored, true);
  await client.close();
});

test("restart recovers a pending settings journal before another bridge turn", async () => {
  const env = makeEnv();
  const first = await makeSession({ emitTurnLifecycle: false }, { env });
  await first.session.resume();
  await first.session.startTurn({ text: "accepted before crash", clientUserMessageId: "msg-crash-restore" });
  assert.equal(existsSync(pendingSettingsPath("review", env)), true);
  await first.client.close(); // simulate process loss before queue-drained release

  const bridgeSandbox = sandboxPolicyForMode("workspace-write", "/tmp/proj");
  const restarted = await makeSession({
    emitTurnLifecycle: false,
    originalCwd: "/tmp/proj",
    originalApprovalPolicy: "never",
    originalSandboxPolicy: bridgeSandbox,
  }, { env });
  await restarted.session.resume();
  assert.equal(restarted.session.recoveredRestoreJournal, true);
  const restored = await restarted.session.restoreThreadSettings();
  assert.equal(restored.restored, true);
  assert.equal(restarted.fake.settingsUpdates.length, 1);
  assert.equal(restarted.fake.settingsUpdates[0].cwd, "/original/cwd");
  await restarted.session.release();
  assert.equal(existsSync(pendingSettingsPath("review", env)), false);
  await restarted.client.close();
});

test("restart never replays stale originals over settings changed manually after the crash", async () => {
  const env = makeEnv();
  const first = await makeSession({ emitTurnLifecycle: false }, { env });
  await first.session.resume();
  await first.session.startTurn({ text: "accepted before user edit", clientUserMessageId: "msg-user-changed" });
  await first.client.close();

  const restarted = await makeSession({
    emitTurnLifecycle: false,
    originalCwd: "/user/changed-cwd",
    originalApprovalPolicy: "untrusted",
    originalSandboxPolicy: { type: "readOnly", networkAccess: false },
  }, { env });
  await restarted.session.resume();
  assert.equal(restarted.session.recoveredRestoreJournal, false, "current settings no longer match bridge overrides");
  assert.equal(restarted.fake.settingsUpdates.length, 0, "stale original snapshot is not replayed");
  assert.equal(existsSync(pendingSettingsPath("review", env)), false, "conflicted journal is resolved, not retried forever");
  await restarted.session.release();
  await restarted.client.close();
});

test("resolved journal tombstone prevents replay when unlink fails", async () => {
  const env = makeEnv();
  const first = await makeSession({}, {
    env,
    journalUnlink: () => { throw new Error("simulated unlink failure"); },
  });
  await first.session.resume();
  await first.session.startTurn({ text: "work", clientUserMessageId: "msg-resolved-tombstone" });
  await waitFor(() => !first.session.turnActive);
  const release = await first.session.release();
  assert.equal(release.released, true);
  const journalPath = pendingSettingsPath("review", env);
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).state, "resolved");
  await first.client.close();

  const restarted = await makeSession({}, { env });
  await restarted.session.resume();
  assert.equal(restarted.fake.settingsUpdates.length, 0, "resolved tombstone is cleanup-only, never a restore instruction");
  assert.equal(existsSync(journalPath), false);
  await restarted.session.release();
  await restarted.client.close();
});

test("restore also runs after a FAILED bridge turn", async () => {
  const fake = createFakeAppServer({ emitTurnLifecycle: false });
  const client = new CodexAppServerClient(fake.child, { logEvent: noop, clientName: "t", clientVersion: "0" });
  await client.initialize();
  const session = new ThreadSession({ client, binding: binding(), logEvent: noop, env: makeEnv() });
  await session.resume();
  await session.startTurn({ text: "will fail", clientUserMessageId: "msg-r2" });
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: session.activeTurnId, status: "failed" } });
  await waitFor(() => !session.turnActive);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 1);
  await client.close();
});

test("restore is SKIPPED when a foreign turn ran after our overrides (guarded restoration)", async () => {
  const events = [];
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false }, { logEvent: (l, e) => events.push(e) });
  await session.resume();
  await session.startTurn({ text: "ours", clientUserMessageId: "msg-r3" });
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: session.activeTurnId, status: "completed" } });
  await waitFor(() => !session.turnActive);
  // Foreign turn starts + completes after our overrides.
  fake.sendNotification("turn/started", { threadId: THREAD, turn: { id: "foreign-9" } });
  await waitFor(() => session.turnActive);
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: "foreign-9", status: "completed" } });
  await waitFor(() => !session.turnActive);
  await session.release();
  assert.equal(fake.settingsUpdates.length, 0, "no restore over a possible concurrent foreign change");
  assert.ok(events.includes("codex.settings_restore_skipped"));
  await client.close();
});

test("no restore when no overrides were sent; missing resume settings fail closed before turn/start", async () => {
  const { fake, client, session } = await makeSession();
  await session.resume();
  await session.release();
  assert.equal(fake.settingsUpdates.length, 0);
  await client.close();

  const bare = await makeSession({ resumeResult: (p) => ({ thread: { id: p.threadId } }) });
  await bare.session.resume();
  await assert.rejects(
    () => bare.session.startTurn({ text: "x", clientUserMessageId: "msg-r4" }),
    /no restorable settings/i,
  );
  assert.equal(bare.fake.requestsFor("turn/start").length, 0, "no sticky override leaves without a durable original snapshot");
  await bare.session.release();
  assert.equal(bare.fake.settingsUpdates.length, 0);
  await bare.client.close();
});

// ── Foreign turns / misc ────────────────────────────────────────────────────

test("foreign turn/started marks the thread busy (not ours)", async () => {
  const { fake, client, session } = await makeSession({ autoRespond: true, emitTurnLifecycle: false });
  await session.resume();
  fake.sendNotification("turn/started", { threadId: THREAD, turn: { id: "foreign-1" } });
  await waitFor(() => session.turnActive);
  assert.equal(session.activeTurnOurs, false);
  fake.sendNotification("turn/completed", { threadId: THREAD, turn: { id: "foreign-1", status: "completed" } });
  await waitFor(() => !session.turnActive);
  await client.close();
});

test("notifications for other threads are ignored", async () => {
  const { fake, client, session } = await makeSession({ emitTurnLifecycle: false });
  await session.resume();
  fake.sendNotification("turn/started", { threadId: "another-thread", turn: { id: "x" } });
  await tick();
  assert.equal(session.turnActive, false);
  await client.close();
});

test("error classifiers", () => {
  assert.equal(errorLooksTurnActive(new CodexRpcError({ code: -32000, message: "Turn already running" }, "turn/start")), true);
  assert.equal(errorLooksTurnActive(new Error("Turn already running")), false, "raw transport errors never become clean busy responses");
  assert.equal(errorLooksTurnActive(new Error("no thread found")), false);
  assert.equal(errorLooksInvalidParams(new Error("invalid params: missing field x")), true);
  assert.equal(errorLooksInvalidParams(new Error("boom")), false);
});

test("sandbox policy wire shapes", () => {
  assert.deepEqual(sandboxPolicyForMode("read-only", "/x"), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicyForMode("danger-full-access", "/x"), { type: "dangerFullAccess" });
  assert.deepEqual(sandboxPolicyForMode("workspace-write", null), {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
