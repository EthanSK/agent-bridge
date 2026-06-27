// ============================================================================
// server.mjs — the Alexa custom-skill HTTP endpoint (the "receiver").
//
// WHAT THIS DOES (the big picture):
//   You say to an Echo: "Alexa, ask my agent to <freeform task>"
//     → Amazon's Alexa cloud invokes our custom skill, captures the freeform
//       task in an AMAZON.SearchQuery slot, and POSTs an Alexa request JSON to
//       THIS server (its public HTTPS endpoint, e.g. via Tailscale Funnel).
//     → We FIRE-AND-FORGET inject() the task into the local machine's running
//       Claude Code session via agent-bridge sendLocalMessage() (fast atomic
//       file write — see src/inject.mjs).
//     → We return a fast spoken ack ("On it — I'll let you know when it's
//       done.") WELL within Alexa's ~8-second response deadline.
//     → The Mini's Claude agent works as long as it needs, then runs
//       speak.sh "<result>" to ANNOUNCE the result on the Echo (via the
//       unofficial alexa_remote_control.sh API, which has NO 8s limit), with a
//       Telegram fallback if Echo auth has lapsed.
//
// ── THE 8-SECOND CONSTRAINT (the central design driver) ─────────────────────
//   Alexa custom skills MUST return an HTTP response within ~8 seconds or Alexa
//   says "there was a problem with the requested skill's response" and the user
//   hears an error. Real agent work takes minutes. So we CANNOT do the work
//   inside the request — we acknowledge fast and do the work out-of-band. That's
//   the whole reason for the fire-and-forget split: inject() is a fast atomic
//   file write (no awaiting the agent), and the long result comes back later via
//   the separate speak-back leg (speak.sh), which is NOT bound by the 8s rule.
//
// ── THE ALEXA REQUEST/RESPONSE CONTRACT (external system) ───────────────────
//   Request (POST body, JSON): {
//     version: "1.0",
//     session: {...},
//     context: {...},
//     request: {
//       type: "LaunchRequest" | "IntentRequest" | "SessionEndedRequest",
//       // for IntentRequest:
//       intent: { name: "...", slots: { query: { name:"query", value:"..." } } }
//     }
//   }
//   Response (what we send back, JSON): {
//     version: "1.0",
//     response: {
//       outputSpeech: { type: "PlainText", text: "..." },
//       shouldEndSession: true
//     }
//   }
//   - LaunchRequest = "Alexa, open my agent" with no task → we prompt for one
//     and KEEP the session open (shouldEndSession:false) so the next utterance
//     is captured.
//   - IntentRequest = the user spoke a task → we extract the SearchQuery slot
//     ("query"), inject it, and end the session with the ack.
//   - SessionEndedRequest = Alexa telling us the session closed → we just 200.
//
// ── SECURITY POSTURE (why we don't do full Alexa signature verification) ────
//   The "proper" way to authenticate that a request genuinely came from Amazon
//   is to verify the SignatureCertChainUrl + Signature headers (download Amazon's
//   cert, validate the chain, verify the request-body signature, check the
//   timestamp). That's a meaningful chunk of crypto code and a maintenance
//   burden. For a PERSONAL single-user bridge, we instead rely on:
//     1. The endpoint URL being an obscure, hard-to-guess Funnel/tunnel URL.
//     2. An OPTIONAL shared secret (ALEXA_BRIDGE_SECRET): if set, the request
//        must carry ?secret=<value> (query string) OR an x-alexa-bridge-secret
//        header. Alexa skill endpoints can't easily send arbitrary custom
//        headers, but the endpoint URL itself can carry the ?secret= query
//        param, so the query-string form is the practical one.
//   The worst case if someone guesses the URL is they can inject a task into the
//   agent (annoying, not catastrophic for a personal setup). If you want the
//   stronger guarantee, add full Alexa request-signature verification here.
// ============================================================================

import http from 'node:http';
import { inject } from './inject.mjs';

// ── Config from env ─────────────────────────────────────────────────────────
// Port the receiver listens on (the tunnel forwards public HTTPS → this port).
const PORT = Number(process.env.ALEXA_BRIDGE_PORT || 8787);
// Which inbox (persona) the injected task lands in.
const TARGET = process.env.ALEXA_BRIDGE_TARGET || 'claude-code/default';
// TTL stamped on the injected message (the watcher consumes within ~2s anyway).
const TTL_SECONDS = Number(process.env.ALEXA_BRIDGE_TTL || 86400);
// Optional shared secret (see SECURITY POSTURE above). Empty = no check.
const SECRET = process.env.ALEXA_BRIDGE_SECRET || '';
// Cap request body size to avoid abuse / memory blowups. Alexa bodies are tiny
// (a few KB); 64 KB is a generous ceiling that still rejects garbage floods.
const MAX_BODY_BYTES = 64 * 1024;

// Absolute path to speak.sh, embedded into the injected instruction so the agent
// can run it regardless of its cwd. speak.sh lives at the extension root.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEAK_SH = resolve(__dirname, '..', 'speak.sh');

// ── Small logging helper ────────────────────────────────────────────────────
// Every line goes to stdout so the LaunchAgent's StandardOutPath captures it.
// We prefix [alexa-bridge] + an ISO timestamp so log greps are easy.
function log(...args) {
  console.log(`[alexa-bridge] ${new Date().toISOString()}`, ...args);
}

// ── Build the standard Alexa "spoken response" JSON ─────────────────────────
// `endSession` controls whether Alexa keeps the mic open for a follow-up. We end
// the session on a real ack (one-shot fire-and-forget), but keep it open when we
// need the user to actually say the task (bare LaunchRequest).
function alexaSpeech(text, endSession = true) {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: endSession,
    },
  };
}

// ── Read + size-cap + JSON-parse the request body ───────────────────────────
// Returns a Promise that resolves to the parsed object, or rejects with an Error
// (oversized body, or invalid JSON). We hard-abort the stream if it exceeds the
// cap so a malicious client can't stream us into an OOM.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Destroy the socket so we stop reading; reject so the handler 413s.
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        reject(new Error('empty body'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('invalid JSON: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

// ── Validate that a body is a plausible Alexa request ───────────────────────
// We don't do full signature verification (see SECURITY POSTURE), but we DO
// sanity-check the shape so random POSTs don't get treated as commands. A real
// Alexa request always has `version` and a `request` object with a `type`.
function looksLikeAlexaRequest(body) {
  return (
    body
    && typeof body === 'object'
    && typeof body.version === 'string'
    && body.request
    && typeof body.request === 'object'
    && typeof body.request.type === 'string'
  );
}

// ── Shared-secret gate ──────────────────────────────────────────────────────
// If ALEXA_BRIDGE_SECRET is set, require a matching secret on the request.
// Accept it via ?secret=<value> (the practical path — Alexa puts it in the
// endpoint URL) OR an x-alexa-bridge-secret header (handy for curl tests).
// Returns true if allowed, false if the secret is set but doesn't match.
function secretOk(req, urlObj) {
  if (!SECRET) return true; // No secret configured → no check.
  const fromQuery = urlObj.searchParams.get('secret');
  const fromHeader = req.headers['x-alexa-bridge-secret'];
  return fromQuery === SECRET || fromHeader === SECRET;
}

// ── Extract the freeform task text from an IntentRequest ─────────────────────
// The skill model (skill.json) defines an intent with an AMAZON.SearchQuery slot
// named "query". Alexa fills body.request.intent.slots.query.value with whatever
// the user said. We defensively walk the path (any level can be missing if the
// user triggered the intent without filling the slot) and return "" if absent.
function extractTaskText(body) {
  const slots = body?.request?.intent?.slots;
  const value = slots?.query?.value;
  return typeof value === 'string' ? value.trim() : '';
}

// ── Build the fire-and-forget prompt we inject into Claude Code ──────────────
// This is the message the running agent session SEES. It contains:
//   1. The freeform task (prefixed [alexa] so the agent knows the source).
//   2. An explicit instruction to speak the result back via speak.sh, including
//      the absolute path, AND the note that speak.sh auto-falls-back to Telegram
//      so the agent should ALWAYS run it (never skip the result report).
function buildInjectContent(taskText) {
  return (
    `[alexa] ${taskText} — when done, speak the result back to the Echo by running: `
    + `bash ${SPEAK_SH} "<your concise result>". `
    + `If the Echo speak-back fails it auto-falls-back to Telegram, so always run it.`
  );
}

// ── The main request router ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Parse the URL once (gives us pathname + query params). The base is a dummy
  // because Node's URL needs an absolute base; we only use pathname/searchParams.
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // ── GET /health — liveness probe for curl + LaunchAgent sanity ──
  // Returns 200 + a tiny JSON so `curl .../health` confirms the receiver is up
  // (used both locally and through the public tunnel for end-to-end checks).
  if (req.method === 'GET' && pathname === '/health') {
    const payload = JSON.stringify({
      ok: true,
      service: 'agent-bridge-alexa-bridge',
      port: PORT,
      target: TARGET,
      secretRequired: Boolean(SECRET),
      ts: new Date().toISOString(),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
    log(`GET /health → 200`);
    return;
  }

  // ── POST /alexa — the Alexa skill endpoint ──
  if (req.method === 'POST' && pathname === '/alexa') {
    // Shared-secret gate first (cheap reject before reading the body).
    if (!secretOk(req, urlObj)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      log(`POST /alexa → 403 (bad/missing secret)`);
      return;
    }

    // Read + parse the body (size-capped). On failure, 400 with a spoken error
    // so even a malformed request that DID come from Alexa degrades gracefully.
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(alexaSpeech('Sorry, I could not read that request.')));
      log(`POST /alexa → 400 (${err.message})`);
      return;
    }

    // Shape check — reject obviously-non-Alexa payloads.
    if (!looksLikeAlexaRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(alexaSpeech("Sorry, that did not look like a valid request.")));
      log(`POST /alexa → 400 (not an Alexa request shape)`);
      return;
    }

    const requestType = body.request.type;

    // ── LaunchRequest: "Alexa, open my agent" with no task yet ──
    // Prompt the user to actually say a task, and KEEP the session open so the
    // next utterance gets routed to our intent.
    if (requestType === 'LaunchRequest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(alexaSpeech(
        "What would you like me to do? Just tell me the task.",
        false, // keep the mic open for the follow-up
      )));
      log(`POST /alexa → 200 (LaunchRequest, prompted for task)`);
      return;
    }

    // ── SessionEndedRequest: Alexa telling us the session closed ──
    // Per the Alexa contract you must NOT return speech here; just 200 empty.
    if (requestType === 'SessionEndedRequest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      log(`POST /alexa → 200 (SessionEndedRequest)`);
      return;
    }

    // ── IntentRequest: the user spoke a task ──
    if (requestType === 'IntentRequest') {
      const intentName = body?.request?.intent?.name || '(unknown)';
      const taskText = extractTaskText(body);

      // Built-in Stop/Cancel intents → polite goodbye, no inject.
      if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(alexaSpeech('Okay.')));
        log(`POST /alexa → 200 (${intentName})`);
        return;
      }
      // Built-in Help intent → explain how to use it.
      if (intentName === 'AMAZON.HelpIntent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(alexaSpeech(
          'Just tell me a task, like: ask my agent to check the build status. '
          + "I'll work on it and let you know when it's done.",
          false,
        )));
        log(`POST /alexa → 200 (HelpIntent)`);
        return;
      }

      // No task captured (empty slot) → ask the user to repeat, keep mic open.
      if (!taskText) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(alexaSpeech(
          "I didn't catch the task. Please say it again.",
          false,
        )));
        log(`POST /alexa → 200 (IntentRequest ${intentName}, empty query slot)`);
        return;
      }

      // ── FIRE-AND-FORGET INJECT ──
      // Wrap inject in try/catch so a bridge failure NEVER turns into an Alexa
      // error — we always return a graceful spoken ack (mentioning trouble if
      // the inject threw). Awaiting inject is fine: it's a fast atomic file
      // write, well under the 8s budget. We do NOT await any agent work.
      const content = buildInjectContent(taskText);
      let injectedId = null;
      let injectError = null;
      try {
        injectedId = await inject({ target: TARGET, content, ttlSeconds: TTL_SECONDS });
      } catch (err) {
        injectError = err;
        // Comment: if we land here the inbox write failed (e.g. build/inbox.js
        // missing). The task did NOT reach the agent. We still ack gracefully so
        // the user isn't left with an Alexa error, but we say there was trouble.
      }

      // Log the full picture for the LaunchAgent log (method, path, request
      // type, intent, the extracted task, and the injected message id).
      log(
        `POST /alexa → 200 (IntentRequest ${intentName})`,
        `task="${taskText}"`,
        injectError ? `INJECT_FAILED=${injectError.message}` : `injected=${injectedId}`,
      );

      // Fast spoken ack. If inject failed, say so honestly but briefly.
      const ackText = injectError
        ? "I heard you, but I had trouble starting the task. Please try again."
        : "On it — I'll let you know when it's done.";
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(alexaSpeech(ackText)));
      return;
    }

    // ── Any other request type → benign 200 so Alexa doesn't error ──
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(alexaSpeech('Okay.')));
    log(`POST /alexa → 200 (unhandled request type: ${requestType})`);
    return;
  }

  // ── Anything else → 404 ──
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
  log(`${req.method} ${pathname} → 404`);
});

// ── Boot ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`listening on http://0.0.0.0:${PORT}`);
  log(`  inject target: ${TARGET}`);
  log(`  speak.sh:      ${SPEAK_SH}`);
  log(`  secret gate:   ${SECRET ? 'ENABLED (?secret= or x-alexa-bridge-secret)' : 'disabled'}`);
  log(`  Alexa endpoint path: POST /alexa   (point your skill here, behind the public HTTPS tunnel)`);
});

// Graceful shutdown so launchd restarts cleanly.
const shutdown = () => {
  log('shutting down…');
  server.close(() => process.exit(0));
  // Force-exit if close hangs on a slow connection.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
