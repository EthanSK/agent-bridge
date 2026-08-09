/**
 * Scriptable in-process fake Codex App Server.
 *
 * Presents the child-process shape `CodexAppServerClient` expects
 * ({ stdin, stdout, stderr, once, on, kill, exitCode, signalCode, pid })
 * while running entirely in-process for deterministic tests.
 *
 * Behavior is driven by an options object; every RPC the client sends is
 * recorded in `received` for assertions.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

export const FAKE_USER_AGENT = "codex/0.145.0 (Test OS 1.0; arm64) fake";

export function createFakeAppServer(options = {}) {
  const opts = {
    userAgent: FAKE_USER_AGENT,
    codexHome: "/tmp/fake-codex-home",
    autoRespond: true,
    /** Original thread settings exposed on thread/resume (capture/restore). */
    originalCwd: "/original/cwd",
    originalApprovalPolicy: "on-request",
    originalSandboxPolicy: { type: "workspaceWrite", writableRoots: ["/original/cwd"], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    originalActivePermissionProfile: null,
    /** map threadId -> behavior overrides */
    resumeResult: null,            // (params) => result | throws
    dropResumeResponse: false,     // accept/subscribe, but simulate a lost RPC response
    resumeDelayMs: 0,
    turnStartResult: null,         // (params) => result | throws
    dropTurnStartResponse: false,  // accept/persist, but simulate a lost RPC response
    turnSteerResult: null,
    threadReadResult: null,
    turnsListResult: null,
    settingsUpdateDelayMs: 0,
    dropSettingsUpdateResponse: false,
    settingsUpdateResult: null,
    unsubscribeDelayMs: 0,
    dropUnsubscribeResponse: false,
    unsubscribeResult: null,
    /** if set, emit these notifications right after turn/start response */
    emitTurnLifecycle: true,
    /** server->client request to send during a turn (e.g. approval) */
    turnServerRequest: null,       // { method, params } — response recorded
    turnCompletedDelayMs: 0,
    killDelayMs: 0,
    respondToInitialized: true,
    ...options,
  };

  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received = [];
  const serverRequestResponses = [];
  /** Inputs of every ACCEPTED turn/start (persisted-history simulation). */
  const acceptedTurnInputs = [];
  /** Every thread/settings/update params, in order. */
  const settingsUpdates = [];
  let nextServerRequestId = 1000;
  const pendingServerRequests = new Map();
  let closed = false;

  /**
   * Real-Codex semantics for thread/read: turns/items are ONLY populated
   * when includeTurns:true was requested. Without it, the response contains
   * just the bare thread — a probe that forgets includeTurns finds nothing.
   */
  function buildThreadReadResult(params) {
    if (params?.includeTurns !== true) {
      return { thread: { id: params.threadId } };
    }
    return {
      thread: {
        id: params.threadId,
        turns: acceptedTurnInputs
          .filter((t) => t.threadId === params.threadId)
          .map((t, i) => ({
            id: t.turnId ?? `turn-hist-${i}`,
            items: [{ type: "userMessage", clientId: t.clientId ?? null, text: t.text }],
          })),
      },
    };
  }

  /**
   * Real thread/items/list semantics: paginated `data` of item entries in
   * the real userMessage shape ({ type, id, clientId, content });
   * sortDirection "desc" returns newest first; `nextCursor` is a string
   * cursor or null when exhausted. The default page source is the recorded
   * accepted-turn history; `opts.itemsListResult(params)` scripts custom
   * pages (loops, caps, rejections).
   */
  function buildItemsListPage(params) {
    const all = acceptedTurnInputs
      .filter((t) => t.threadId === params.threadId)
      .map((t, i) => ({
        turnId: t.turnId ?? `turn-hist-${i}`,
        item: {
          type: "userMessage",
          id: `item-${i}`,
          clientId: t.clientId ?? null,
          content: [{ type: "inputText", text: t.text }],
        },
      }));
    if (params?.sortDirection === "desc") all.reverse();
    const limit = Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : 100;
    const start = params?.cursor !== undefined && params?.cursor !== null ? Number(params.cursor) : 0;
    const page = all.slice(start, start + limit);
    const nextStart = start + page.length;
    return {
      data: page,
      nextCursor: nextStart < all.length ? String(nextStart) : null,
      backwardsCursor: page.length > 0 ? String(start) : null,
    };
  }

  function buildTurnsListPage(params) {
    const all = acceptedTurnInputs
      .filter((t) => t.threadId === params.threadId)
      .map((t) => ({
        id: t.turnId,
        items: [],
        itemsView: "summary",
        status: t.status ?? "completed",
        error: null,
        startedAt: null,
        completedAt: t.status === "inProgress" ? null : 0,
        durationMs: null,
      }));
    if (params?.sortDirection === "desc") all.reverse();
    const limit = Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : 100;
    const start = params?.cursor !== undefined && params?.cursor !== null ? Number(params.cursor) : 0;
    const page = all.slice(start, start + limit);
    const nextStart = start + page.length;
    return {
      data: page,
      nextCursor: nextStart < all.length ? String(nextStart) : null,
      backwardsCursor: page.length > 0 ? String(start) : null,
    };
  }

  const child = emitter;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 424242;

  function writeFrame(frame) {
    if (closed) return;
    stdout.write(`${JSON.stringify(frame)}\n`);
  }

  /** Send a raw string (for malformed/fragmentation tests). */
  function writeRaw(text) {
    if (closed) return;
    stdout.write(text);
  }

  function sendNotification(method, params) {
    writeFrame({ method, params });
  }

  function sendServerRequest(method, params, { timeoutMs = 2000 } = {}) {
    const id = nextServerRequestId++;
    // Register the resolver BEFORE writing: PassThrough delivers 'data'
    // synchronously when the consumer is flowing, so the client's response
    // can arrive inside the writeFrame call below. Registering afterwards
    // (the original bug) dropped the response and left the promise pending
    // forever. The ref'd timeout gives every server request a real bounded
    // lifecycle: a broken response path rejects loudly instead of letting
    // the event loop drain with the test promise still pending.
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingServerRequests.delete(id)) {
          reject(new Error(`fake app server: no response to ${method} (id ${id}) within ${timeoutMs}ms`));
        }
      }, timeoutMs);
      pendingServerRequests.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    writeFrame({ id, method, params });
    return promise;
  }

  function exit(code = 0, signal = null) {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    stdout.end();
    emitter.emit("exit", code, signal);
  }

  child.kill = (signal = "SIGTERM") => {
    if (opts.killDelayMs > 0) setTimeout(() => exit(null, signal), opts.killDelayMs);
    else exit(null, signal);
    return true;
  };

  const handleClientFrame = (msg) => {
    received.push(msg);
    // Responses to OUR server->client requests:
    if (msg.id !== undefined && msg.method === undefined) {
      const resolver = pendingServerRequests.get(msg.id);
      if (resolver) {
        pendingServerRequests.delete(msg.id);
        serverRequestResponses.push(msg);
        resolver(msg);
      }
      return;
    }
    if (!opts.autoRespond) return;
    const { id, method, params } = msg;
    const respond = (result) => writeFrame({ id, result });
    const respondError = (error) => writeFrame({ id, error });

    if (method === "initialize") {
      respond({
        userAgent: opts.userAgent,
        codexHome: opts.codexHome,
        platformFamily: "test",
        platformOs: "testos",
      });
      return;
    }
    if (method === "initialized") return; // notification
    if (method === "thread/resume") {
      const finishResume = () => {
        try {
          const result = opts.resumeResult
            ? opts.resumeResult(params)
            : {
            // Real ThreadResumeResponse shape: thread carries id + status
            // (+ legacy turns array); the paginated recent history rides in
            // initialTurnsPage when the client requested it; the thread's
            // ORIGINAL settings are exposed for capture/restore.
            thread: {
              id: params.threadId,
              status: { type: opts.threadStatusType ?? "idle" },
              turns: opts.legacyTurns ?? [],
            },
            ...(params.initialTurnsPage
              ? { initialTurnsPage: { data: opts.initialTurnsData ?? [], nextCursor: null } }
              : {}),
            cwd: opts.originalCwd,
            approvalPolicy: opts.originalApprovalPolicy,
            sandbox: opts.originalSandboxPolicy,
            activePermissionProfile: opts.originalActivePermissionProfile,
            };
          if (!opts.dropResumeResponse) respond(result);
          sendNotification("thread/started", { thread: { id: params.threadId } });
        } catch (err) {
          respondError({ code: err.rpcCode ?? -32000, message: err.message });
        }
      };
      if (opts.resumeDelayMs > 0) setTimeout(finishResume, opts.resumeDelayMs);
      else finishResume();
      return;
    }
    if (method === "thread/unsubscribe") {
      if (opts.dropUnsubscribeResponse) return;
      const finishUnsubscribe = () => {
        try {
          const result = opts.unsubscribeResult ? opts.unsubscribeResult(params) : { status: "unsubscribed" };
          respond(result);
        } catch (err) {
          respondError({ code: err.rpcCode ?? -32000, message: err.message });
        }
      };
      if (opts.unsubscribeDelayMs > 0) setTimeout(finishUnsubscribe, opts.unsubscribeDelayMs);
      else finishUnsubscribe();
      return;
    }
    if (method === "thread/settings/update") {
      settingsUpdates.push(params);
      try {
        const result = opts.settingsUpdateResult
          ? opts.settingsUpdateResult(params, settingsUpdates.length)
          : {};
        if (opts.dropSettingsUpdateResponse) return;
        if (opts.settingsUpdateDelayMs > 0) setTimeout(() => respond(result), opts.settingsUpdateDelayMs);
        else respond(result);
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
      }
      return;
    }
    if (method === "thread/items/list") {
      try {
        const result = opts.itemsListResult
          ? opts.itemsListResult(params)
          : buildItemsListPage(params);
        respond(result);
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
      }
      return;
    }
    if (method === "thread/turns/list") {
      try {
        const result = opts.turnsListResult
          ? opts.turnsListResult(params)
          : buildTurnsListPage(params);
        respond(result);
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
      }
      return;
    }
    if (method === "thread/read") {
      try {
        const result = opts.threadReadResult
          ? opts.threadReadResult(params)
          : buildThreadReadResult(params);
        respond(result);
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
      }
      return;
    }
    if (method === "turn/start") {
      let result;
      try {
        result = opts.turnStartResult
          ? opts.turnStartResult(params)
          : { turn: { id: `turn-${received.length}` } };
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
        return;
      }
      // Record the ACCEPTED input as persisted thread history so the
      // thread/read dedupe probe behaves like real Codex (which only
      // returns turns/items when includeTurns:true is requested).
      const accepted = {
        threadId: params.threadId,
        turnId: result?.turn?.id ?? null,
        clientId: params.clientUserMessageId ?? null,
        text: params.input?.[0]?.text ?? "",
        status: "inProgress",
      };
      acceptedTurnInputs.push(accepted);
      if (!opts.dropTurnStartResponse) respond(result);
      const turnId = result?.turn?.id;
      if (turnId && opts.emitTurnLifecycle) {
        sendNotification("turn/started", { threadId: params.threadId, turn: { id: turnId } });
        const finishTurn = async () => {
          if (opts.turnServerRequest) {
            await sendServerRequest(opts.turnServerRequest.method, {
              threadId: params.threadId,
              turnId,
              ...opts.turnServerRequest.params,
            });
          }
          sendNotification("item/completed", {
            threadId: params.threadId,
            turnId,
            item: { id: "item-1", type: "agentMessage", text: "ack from fake codex" },
          });
          sendNotification("turn/completed", {
            threadId: params.threadId,
            turn: { id: turnId, status: "completed", items: [] },
          });
          accepted.status = "completed";
        };
        if (opts.turnCompletedDelayMs > 0) {
          setTimeout(() => { void finishTurn(); }, opts.turnCompletedDelayMs).unref?.();
        } else {
          void finishTurn();
        }
      }
      return;
    }
    if (method === "turn/steer") {
      try {
        const result = opts.turnSteerResult ? opts.turnSteerResult(params) : {};
        respond(result);
      } catch (err) {
        respondError({ code: err.rpcCode ?? -32000, message: err.message });
      }
      return;
    }
    respondError({ code: -32601, message: `fake app server: unknown method ${method}` });
  };

  let inputBuffer = "";
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      inputBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = inputBuffer.indexOf("\n")) >= 0) {
        const line = inputBuffer.slice(0, idx);
        inputBuffer = inputBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          handleClientFrame(JSON.parse(line));
        } catch {
          /* fake server ignores malformed client frames */
        }
      }
      cb();
    },
  });
  child.stdin.on("error", () => {});

  return {
    child,
    received,
    serverRequestResponses,
    acceptedTurnInputs,
    settingsUpdates,
    sendNotification,
    sendServerRequest,
    writeFrame,
    writeRaw,
    writeStderr: (text) => stderr.write(text),
    exit,
    requestsFor: (method) => received.filter((m) => m.method === method),
  };
}
