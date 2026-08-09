/**
 * Minimal Codex App Server JSON-RPC client over stdio.
 *
 * Public-interface only: spawns `codex app-server` (the documented
 * bidirectional JSON-RPC host surface, newline-delimited JSON both ways) and
 * speaks the same handshake the installed `@openclaw/codex` reference proved
 * against Codex 0.145.0:
 *
 *   -> request  initialize { clientInfo, capabilities: { experimentalApi } }
 *   <- response { userAgent: "codex/0.145.0 (…)", codexHome, … }
 *   -> notify   initialized
 *
 * Version negotiation: the Codex version is parsed from `userAgent`;
 * anything below MIN_CODEX_VERSION (or unparseable) is rejected with a
 * `CodexVersionError` so callers can surface an actionable upgrade message
 * instead of failing deep inside thread calls.
 *
 * Robustness properties (each covered by tests):
 *  - stdio fragmentation: StringDecoder preserves split UTF-8 code points;
 *    partial lines and complete frames are bounded (over-cap => close, never OOM).
 *  - malformed frames: non-JSON lines are counted + logged, never fatal.
 *  - server->client REQUESTS (approvals, user-input) are answered via the
 *    registered handler or a JSON-RPC method-not-found error — never left
 *    hanging.
 *  - close semantics: child exit / stream errors reject every pending
 *    request with a connection-closed error carrying a redacted stderr tail.
 *  - shutdown: close() ends stdin, then terminates the exact owned process
 *    tree (Unix process group or Windows taskkill /T) with a bounded grace.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { buildElicitationDecline, buildEmptyUserInputAnswers, buildLegacyApprovalDecline } from "./session.js";

/**
 * 0.145.0 is the only validated floor: the channel's correctness depends on
 * 0.145 surfaces (initialTurnsPage resume hydration and
 * clientUserMessageId echoed as userMessage.clientId). The generated 0.145
 * schema also exposes thread/items/list pagination, although an installed
 * 0.145 runtime may return -32601; the session layer therefore keeps an
 * exact-hit-only thread/read fallback. No equally safe older path is
 * implemented, so older builds are rejected at initialize rather than
 * degraded unsafely.
 */
export const MIN_CODEX_VERSION = "0.145.0";
const LINE_BUFFER_MAX = 1_000_000; // 1 MB maximum per newline-delimited frame
const STDERR_TAIL_MAX = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Hard ceiling on any single RPC wait — guarantees every request settles. */
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 2000;

export class CodexVersionError extends Error {
  constructor(detected) {
    super(
      `Codex ${MIN_CODEX_VERSION}+ is required for the agent-bridge codex-channel, but `
      + `${detected ? `detected ${detected}` : "the running Codex version could not be determined"}. `
      + `Update Codex (e.g. \`npm i -g @openai/codex\` or your installer) and retry.`,
    );
    this.name = "CodexVersionError";
    this.detectedVersion = detected;
  }
}

/** Request was refused by a local ownership fence before any bytes were sent. */
export class CodexDispatchFencedError extends Error {
  constructor(method) {
    super(`local dispatch fence refused ${method} before write`);
    this.name = "CodexDispatchFencedError";
    this.method = method;
  }
}

export class CodexRpcError extends Error {
  constructor(error, method) {
    super(`${method} failed: ${error?.message ?? "unknown app-server error"}`);
    this.name = "CodexRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class CodexConnectionClosedError extends Error {
  constructor(detail) {
    super(`codex app-server connection closed${detail ? `: ${detail}` : ""}`);
    this.name = "CodexConnectionClosedError";
  }
}

/** Exact owned App Server process tree could not be proven terminated. */
export class CodexChildTeardownError extends Error {
  constructor(detail) {
    super(`codex app-server child teardown could not be verified${detail ? `: ${detail}` : ""}`);
    this.name = "CodexChildTeardownError";
  }
}

/** Extracts "0.145.0" from "codex/0.145.0 (Mac OS …)". */
export function parseCodexVersionFromUserAgent(userAgent) {
  if (typeof userAgent !== "string") return null;
  const m = userAgent.match(/^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/);
  return m ? m[1] : null;
}

/** semver-ish compare on numeric dotted parts (prerelease sorts lower). */
export function compareVersions(left, right) {
  const parse = (v) => {
    const [core] = String(v).split("+", 1);
    const dashIdx = core.indexOf("-");
    const numeric = (dashIdx >= 0 ? core.slice(0, dashIdx) : core)
      .split(".")
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
    return { numeric, unstable: dashIdx >= 0 || String(v).includes("+") };
  };
  const l = parse(left);
  const r = parse(right);
  for (let i = 0; i < Math.max(l.numeric.length, r.numeric.length); i += 1) {
    const a = l.numeric[i] ?? 0;
    const b = r.numeric[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (l.unstable && !r.unstable) return -1;
  if (!l.unstable && r.unstable) return 1;
  return 0;
}

/**
 * Resolve the codex executable candidates in priority order. Not
 * Homebrew-specific: env override, channel config, PATH lookup (platform
 * spellings), then well-known absolute locations.
 */
export function codexBinaryCandidates({ env = process.env, configuredBin = null } = {}) {
  const candidates = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim() && !candidates.includes(v.trim())) candidates.push(v.trim());
  };
  // A PINNED binary is exclusive: when the user names an exact executable
  // (env var first, then channel config), we must never silently fall back
  // to a DIFFERENT codex build — that would defeat the point of pinning and
  // could attach the channel to an unexpected version. Errors on a pinned
  // binary surface as errors.
  push(env.AGENT_BRIDGE_CODEX_BIN);
  if (candidates.length > 0) return candidates;
  push(configuredBin);
  if (candidates.length > 0) return candidates;
  if (process.platform === "win32") {
    // .exe first: npm shims are .cmd and require shell-mode spawning on
    // Node >= 18.20 (EINVAL otherwise) — handled by the spawn fallback below.
    push("codex.exe");
    push("codex.cmd");
    push("codex");
  } else {
    push("codex");
    push("/opt/homebrew/bin/codex");
    push("/usr/local/bin/codex");
  }
  return candidates;
}

/**
 * Shell-quote a command for the win32 `shell: true` retry. Only applied to
 * OUR resolved binary path (never message data); quoting guards paths with
 * spaces like %LOCALAPPDATA% installs.
 */
function winShellCommand(bin) {
  return /\s/.test(bin) ? `"${bin}"` : bin;
}

function redactLine(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>")
    .replace(/("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi, "$1<redacted>$3")
    .slice(0, 500);
}

/**
 * Global fail-closed defaults for interactive server requests that NO
 * registered handler claimed (unknown thread context, released session,
 * or no sessions at all). Every shape is the exact schema-compatible safe
 * decline for the installed Codex 0.145 protocol — nothing here can ever
 * approve anything. Unknown non-interactive methods return null and get a
 * JSON-RPC method-not-found error instead.
 */
export function failClosedServerResponse(method, params) {
  const m = String(method ?? "");
  if (m === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (m === "applyPatchApproval" || m === "execCommandApproval") {
    return buildLegacyApprovalDecline();
  }
  if (/requestApproval$/i.test(m)) {
    return { decision: "decline" };
  }
  if (m === "item/tool/requestUserInput" || /userinput|user_input/i.test(m)) {
    return buildEmptyUserInputAnswers(params);
  }
  if (m === "mcpServer/elicitation/request") {
    return buildElicitationDecline();
  }
  if (m === "item/tool/call") {
    return {
      contentItems: [{ type: "inputText", text: "agent-bridge codex-channel does not expose dynamic tools." }],
      success: false,
    };
  }
  return null;
}

/**
 * JSON-RPC stdio client wrapper around an already-spawned child (or a fake
 * transport with { stdin, stdout, stderr, once, kill } for tests).
 */
export class CodexAppServerClient {
  constructor(child, {
    logEvent = () => {},
    clientName = "agent-bridge-codex-channel",
    clientVersion = "0.0.0",
    platform = process.platform,
    spawnProcess = spawn,
    processKill = process.kill.bind(process),
    ownsProcessGroup = false,
    killGraceMs = KILL_GRACE_MS,
    reapGraceMs = 200,
  } = {}) {
    this.child = child;
    this.logEvent = logEvent;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.processKill = processKill;
    this.ownsProcessGroup = ownsProcessGroup;
    this.killGraceMs = killGraceMs;
    this.reapGraceMs = reapGraceMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.closeError = null;
    this.initialized = false;
    this.serverVersion = null;
    this.runtimeIdentity = null;
    this.notificationHandlers = new Set();
    /**
     * Multi-session request dispatch (insertion-ordered). Each ThreadSession
     * registers a handler that CLAIMS requests for its own thread context
     * (returning null otherwise); unclaimed requests hit the global
     * fail-closed defaults below, so releasing one session never orphans
     * another session's requests and nothing is ever approved accidentally.
     */
    this.requestHandlers = new Set();
    this.closeHandlers = new Set();
    this.parseFailures = 0;
    this.stderrTail = "";
    this._lineBuffer = "";
    this._stdoutDecoder = new StringDecoder("utf8");
    this._stdoutDecoderFinished = false;
    this._teardownPromise = null;

    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stdout.on("end", () => this._onStdoutEnd());
    child.stdout.on("error", (err) => this._closeUnexpected(new CodexConnectionClosedError(String(err?.message ?? err))));
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_MAX);
    });
    child.stderr?.on("error", () => { /* stderr loss is non-fatal */ });
    child.stdin?.on?.("error", (err) => this._closeUnexpected(new CodexConnectionClosedError(String(err?.message ?? err))));
    child.once("error", (err) => this._closeUnexpected(new CodexConnectionClosedError(String(err?.message ?? err))));
    child.once("exit", (code, signal) => {
      const detail = `exit code=${code ?? "null"} signal=${signal ?? "null"}`
        + (this.stderrTail.trim() ? ` stderr=${JSON.stringify(redactLine(this.stderrTail))}` : "");
      this._closeWith(new CodexConnectionClosedError(detail));
    });
  }

  /**
   * Spawn `codex app-server`, trying binary candidates in order (ENOENT falls
   * through to the next candidate; any other spawn error is fatal).
   */
  static async spawn({ env = process.env, configuredBin = null, logEvent = () => {}, clientName, clientVersion } = {}) {
    const candidates = codexBinaryCandidates({ env, configuredBin });
    const trySpawn = (bin, useShell) => new Promise((resolve, reject) => {
      const spawned = useShell
        ? spawn(winShellCommand(bin), ["app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
          env,
          windowsHide: true,
          shell: true,
        })
        : spawn(bin, ["app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
          env,
          windowsHide: true,
          // On Unix, make the exact App Server tree its own process group so
          // a configured shell wrapper cannot leave descendants subscribed
          // after only the wrapper exits.
          detached: process.platform !== "win32",
        });
      const onError = (err) => reject(err);
      spawned.once("error", onError);
      spawned.once("spawn", () => {
        spawned.removeListener("error", onError);
        resolve(spawned);
      });
    });
    let lastError = null;
    for (const bin of candidates) {
      // Absolute paths we can pre-check cheaply; bare names go to PATH.
      const looksPathy = bin.includes("/") || bin.includes("\\");
      if (looksPathy && !existsSync(bin)) continue;
      try {
        let child;
        try {
          child = await trySpawn(bin, false);
        } catch (err) {
          // Node >= 18.20 refuses .cmd/.bat without a shell (EINVAL). Retry
          // the SAME candidate in shell mode — args are our fixed literal
          // ["app-server"], never message data, so shell mode is safe here.
          if (process.platform === "win32" && err?.code === "EINVAL") {
            child = await trySpawn(bin, true);
          } else {
            throw err;
          }
        }
        logEvent("info", "codex.appserver_spawned", `Spawned codex app-server via ${bin}`, { bin, pid: child.pid });
        return new CodexAppServerClient(child, {
          logEvent,
          clientName,
          clientVersion,
          ownsProcessGroup: process.platform !== "win32",
        });
      } catch (err) {
        lastError = err;
        if (err?.code === "ENOENT" || err?.code === "EINVAL") continue;
        throw err;
      }
    }
    throw new Error(
      `codex binary not found (tried: ${candidates.join(", ")}). `
      + `Install Codex or set AGENT_BRIDGE_CODEX_BIN to the executable path. `
      + `${lastError ? `Last error: ${lastError.message}` : ""}`.trim(),
    );
  }

  _onStdout(chunk) {
    if (this._stdoutDecoderFinished) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this._consumeStdoutText(this._stdoutDecoder.write(bytes));
  }

  _onStdoutEnd() {
    if (this._stdoutDecoderFinished) return;
    this._stdoutDecoderFinished = true;
    this._consumeStdoutText(this._stdoutDecoder.end());
    if (!this.closed) {
      this._closeUnexpected(new CodexConnectionClosedError("stdout ended"));
    }
  }

  _consumeStdoutText(text) {
    if (this.closed || !text) return;
    this._lineBuffer += text;
    let idx;
    while ((idx = this._lineBuffer.indexOf("\n")) >= 0) {
      const rawLine = this._lineBuffer.slice(0, idx);
      this._lineBuffer = this._lineBuffer.slice(idx + 1);
      if (Buffer.byteLength(rawLine, "utf8") > LINE_BUFFER_MAX) {
        this._lineBuffer = "";
        this._closeUnexpected(new CodexConnectionClosedError(`stdout line exceeded ${LINE_BUFFER_MAX} bytes`));
        return;
      }
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) continue;
      this._handleLine(line);
    }
    if (Buffer.byteLength(this._lineBuffer, "utf8") > LINE_BUFFER_MAX) {
      this._lineBuffer = "";
      this._closeUnexpected(new CodexConnectionClosedError(`stdout line exceeded ${LINE_BUFFER_MAX} bytes`));
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.parseFailures += 1;
      this.logEvent("warn", "codex.appserver_parse_failed", "Unparseable app-server frame", {
        preview: redactLine(line),
        error: String(err?.message ?? err),
        parse_failures: this.parseFailures,
      });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new CodexRpcError(msg.error, entry.method));
      else entry.resolve(msg.result);
      return;
    }

    // Server -> client REQUEST (has both id and method). Must be answered.
    if (msg.id !== undefined && typeof msg.method === "string") {
      this._handleServerRequest(msg);
      return;
    }

    // Notification.
    if (typeof msg.method === "string") {
      for (const handler of Array.from(this.notificationHandlers)) {
        try {
          handler(msg);
        } catch (err) {
          this.logEvent("warn", "codex.notification_handler_error", "Notification handler threw", {
            method: msg.method,
            error: String(err?.message ?? err),
          });
        }
      }
    }
  }

  async _handleServerRequest(msg) {
    let response = null;
    for (const handler of Array.from(this.requestHandlers)) {
      try {
        // First non-null response wins (handlers claim by thread context).
        // A throwing handler is logged and treated as "did not claim" so the
        // fail-closed defaults still answer the request safely.
        // eslint-disable-next-line no-await-in-loop
        const candidate = await handler(msg);
        if (candidate !== null && candidate !== undefined) {
          response = candidate;
          break;
        }
      } catch (err) {
        this.logEvent("warn", "codex.request_handler_error", `Request handler threw for ${msg.method}`, {
          method: msg.method,
          error: String(err?.message ?? err),
        });
      }
    }
    if (response === null || response === undefined) {
      response = failClosedServerResponse(msg.method, msg.params);
      if (response !== null) {
        this.logEvent("warn", "codex.request_fail_closed", `Fail-closed default answered ${msg.method}`, {
          method: msg.method,
        });
      }
    }
    if (response === null || response === undefined) {
      this._write({
        id: msg.id,
        error: { code: -32601, message: `agent-bridge codex-channel does not handle ${msg.method}` },
      });
      return;
    }
    this._write({ id: msg.id, result: response });
  }

  _write(message, onError = null) {
    if (this.closed) {
      if (onError) onError(this.closeError ?? new CodexConnectionClosedError());
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err && onError) onError(err);
      });
    } catch (err) {
      if (onError) onError(err);
    }
  }

  request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, dispatchFence = null } = {}) {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new CodexConnectionClosedError());
    }
    // Every request carries a bounded timeout (default 30 s, hard cap 10 min):
    // an unanswerable RPC MUST still settle its promise, both so callers can
    // apply their own recovery and so the process can exit cleanly.
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.max(100, timeoutMs), MAX_REQUEST_TIMEOUT_MS)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        fn(value);
      };
      const entry = { method, resolve: finish(resolve), reject: finish(reject) };
      this.pending.set(id, entry);
      // Deliberately NOT unref'd: an outstanding RPC is real work. The timer
      // is cleared the moment the request settles (response, connection
      // close, or timeout), so it never outlives the request — but while the
      // request is pending it must keep the event loop alive so the promise
      // is guaranteed to settle before the process can exit.
      timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        entry.reject(new Error(`${method} timed out after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
      const dispatch = () => this._write({ id, method, params }, (err) => {
        if (this.pending.has(id)) entry.reject(err instanceof Error ? err : new Error(String(err)));
      });
      try {
        if (dispatchFence && dispatchFence(dispatch, { method, params }) !== true) {
          entry.reject(new CodexDispatchFencedError(method));
          return;
        }
        if (!dispatchFence) dispatch();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method, params) {
    this._write(params === undefined ? { method } : { method, params });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Register a server-request handler (insertion-ordered). Returns disposer. */
  addRequestHandler(handler) {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  /** Back-compat alias for addRequestHandler (multi-dispatch since 4.10.0). */
  setRequestHandler(handler) {
    return this.addRequestHandler(handler);
  }

  onClose(handler) {
    if (this.closed) {
      try { handler(this.closeError); } catch { /* ignore */ }
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Handshake + version floor. Throws CodexVersionError on unsupported/
   * undeterminable versions (the connection is closed first so an unsupported
   * server never lingers).
   */
  async initialize({ timeoutMs = 15_000 } = {}) {
    if (this.initialized) return this.runtimeIdentity;
    const response = await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: "Agent Bridge",
        version: this.clientVersion,
      },
      capabilities: { experimentalApi: true },
    }, { timeoutMs });
    const detected = parseCodexVersionFromUserAgent(response?.userAgent);
    if (!detected || compareVersions(detected, MIN_CODEX_VERSION) < 0) {
      this.logEvent("error", "codex.appserver_unsupported_version", "Unsupported Codex app-server version", {
        detected: detected ?? null,
        minimum: MIN_CODEX_VERSION,
        user_agent: typeof response?.userAgent === "string" ? response.userAgent.slice(0, 200) : null,
      });
      await this.close();
      throw new CodexVersionError(detected);
    }
    this.serverVersion = detected;
    this.runtimeIdentity = {
      serverVersion: detected,
      userAgent: typeof response?.userAgent === "string" ? response.userAgent : null,
      codexHome: typeof response?.codexHome === "string" ? response.codexHome : null,
      platformOs: typeof response?.platformOs === "string" ? response.platformOs : null,
    };
    this.notify("initialized");
    this.initialized = true;
    this.logEvent("info", "codex.appserver_initialized", `Codex app-server initialized (v${detected})`, {
      server_version: detected,
    });
    return this.runtimeIdentity;
  }

  _closeWith(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const entry of this.pending.values()) {
      try { entry.reject(error); } catch { /* ignore */ }
    }
    this.pending.clear();
    for (const handler of Array.from(this.closeHandlers)) {
      try { handler(error); } catch { /* ignore */ }
    }
    this.closeHandlers.clear();
  }

  /**
   * A fatal transport/framing failure can leave the child itself alive even
   * though this JSON-RPC client is deaf. Mark the logical connection closed
   * with the ORIGINAL error, then synchronously initiate one bounded child
   * teardown so subscriptions cannot survive while the service opens a
   * replacement App Server.
   */
  _closeUnexpected(error) {
    this._closeWith(error);
    // A later close()/replacement attempt awaits the same promise and must
    // observe a failed process-tree teardown. Suppress only this background
    // observer so a rejection is not reported as an unhandled promise.
    void this._terminateChild().catch(() => {});
  }

  /** Idempotent bounded child teardown shared by explicit and fatal close. */
  _terminateChild() {
    if (this._teardownPromise) return this._teardownPromise;
    const child = this.child;
    const windowsTreeKill = this.platform === "win32" && Number.isInteger(child?.pid) && child.pid > 0;
    const unixGroupKill = this.platform !== "win32" && this.ownsProcessGroup
      && Number.isInteger(child?.pid) && child.pid > 0;
    // A wrapper's own exit is not proof that its inherited App Server tree is
    // gone. Unix can verify the owned process group; Windows must re-run the
    // exact /PID /T cleanup and fail closed if that ownership cannot be
    // established. Only a direct, non-tree child may use its exit as proof.
    if (!child || (!windowsTreeKill && !unixGroupKill && (child.exitCode !== null || child.signalCode))) {
      this._teardownPromise = Promise.resolve();
      return this._teardownPromise;
    }
    this._teardownPromise = new Promise((resolve, reject) => {
      let settled = false;
      let killTimer = null;
      let reapTimer = null;
      const groupSignal = (signal) => this.processKill(-child.pid, signal);
      const groupAlive = () => {
        try {
          groupSignal(0);
          return true;
        } catch (error) {
          if (error?.code === "ESRCH") return false;
          if (error?.code === "EPERM") return true;
          throw error;
        }
      };
      const done = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (reapTimer) clearTimeout(reapTimer);
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (reapTimer) clearTimeout(reapTimer);
        reject(error);
      };
      // Register exit handling before dispatching termination: fake/in-process
      // transports and a fast real child may emit exit synchronously. On
      // Windows, wrapper exit alone is NOT proof its Codex descendant died;
      // only a successful exact-tree taskkill completes teardown.
      child.once("exit", () => {
        if (unixGroupKill) {
          try { if (!groupAlive()) done(); } catch (error) { fail(new CodexChildTeardownError(String(error?.message ?? error))); }
        } else if (!windowsTreeKill) done();
      });
      try { child.stdin?.end(); } catch { /* ignore */ }
      if (windowsTreeKill) {
        // npm commonly exposes Codex as codex.cmd. Node's shell:true child is
        // then cmd.exe, and child.kill() is not guaranteed to terminate its
        // Codex grandchild. taskkill is constrained to this exact owned PID
        // and /T closes only its process tree — never a name-wide kill.
        killTimer = setTimeout(() => {
          fail(new CodexChildTeardownError(`taskkill timed out for owned pid ${child.pid}`));
        }, this.killGraceMs);
        try {
          const killer = this.spawnProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.once("exit", (code) => {
            if (code === 0) {
              done();
              return;
            }
            fail(new CodexChildTeardownError(`taskkill exited ${code ?? "unknown"} for owned pid ${child.pid}`));
          });
          killer.once("error", (err) => {
            fail(new CodexChildTeardownError(`taskkill failed for owned pid ${child.pid}: ${String(err?.message ?? err)}`));
          });
        } catch (err) {
          fail(new CodexChildTeardownError(`taskkill could not start for owned pid ${child.pid}: ${String(err?.message ?? err)}`));
        }
      } else if (unixGroupKill) {
        const pollGroupReaped = (deadline) => {
          let alive;
          try { alive = groupAlive(); } catch (error) {
            fail(new CodexChildTeardownError(`process-group verification failed: ${String(error?.message ?? error)}`));
            return;
          }
          if (!alive) {
            done();
            return;
          }
          if (Date.now() >= deadline) {
            fail(new CodexChildTeardownError(`owned process group ${child.pid} survived SIGKILL`));
            return;
          }
          reapTimer = setTimeout(() => pollGroupReaped(deadline), 20);
        };
        try {
          groupSignal("SIGTERM");
          if (!groupAlive()) {
            done();
            return;
          }
        } catch (error) {
          if (error?.code === "ESRCH") {
            done();
            return;
          }
          fail(new CodexChildTeardownError(`process-group SIGTERM failed: ${String(error?.message ?? error)}`));
          return;
        }
        killTimer = setTimeout(() => {
          try {
            if (!groupAlive()) {
              done();
              return;
            }
            groupSignal("SIGKILL");
          } catch (error) {
            if (error?.code === "ESRCH") {
              done();
              return;
            }
            fail(new CodexChildTeardownError(`process-group SIGKILL failed: ${String(error?.message ?? error)}`));
            return;
          }
          pollGroupReaped(Date.now() + this.reapGraceMs);
        }, this.killGraceMs);
      } else {
        killTimer = setTimeout(() => {
          try {
            const sent = child.kill("SIGKILL");
            if (sent === false) {
              fail(new CodexChildTeardownError("SIGKILL was refused and no child exit was observed"));
              return;
            }
          } catch (err) {
            fail(new CodexChildTeardownError(`SIGKILL failed: ${String(err?.message ?? err)}`));
            return;
          }
          // kill(2) success only means the signal was sent. Replacement is
          // safe after the owned child actually exits; a silent non-exit is
          // an ownership failure, never a successful bounded reap.
          reapTimer = setTimeout(() => {
            fail(new CodexChildTeardownError("no child exit observed after SIGKILL"));
          }, this.reapGraceMs);
        }, this.killGraceMs);
        try {
          const sent = child.kill("SIGTERM");
          if (sent === false && child.exitCode === null && !child.signalCode) {
            fail(new CodexChildTeardownError("SIGTERM was refused and no child exit was observed"));
          }
        } catch (err) {
          if (child.exitCode === null && !child.signalCode) {
            fail(new CodexChildTeardownError(`SIGTERM failed: ${String(err?.message ?? err)}`));
          }
        }
        if (child.exitCode !== null || child.signalCode) done();
      }
    });
    return this._teardownPromise;
  }

  /**
   * Deterministic shutdown: mark closed, end stdin (lets a healthy app-server
   * exit on its own), SIGTERM, and SIGKILL after a bounded grace period.
   * Safe to call multiple times.
   */
  async close() {
    this._closeWith(new CodexConnectionClosedError("closed by client"));
    await this._terminateChild();
  }
}
