// ============================================================================
// inject.mjs — the "inject a message into the local Claude Code session" path.
//
// This is the CRUX of the whole extension (identical strategy to the
// google-home-matter extension's inject.mjs — deliberately kept consistent so
// both extensions share one well-tested injection path). It reuses
// agent-bridge's OWN built module (mcp-server/build/inbox.js) and calls
// `sendLocalMessage()` — the exact same function `bridge_send_message` uses
// internally for the `machine:"local"` case (see mcp-server/src/tools.ts where
// `isLocal` → `sendLocalMessage(msg)`).
//
// WHY reuse the module instead of writing JSON ourselves:
//   - sendLocalMessage builds a `msg-<uuid>` id, writes ATOMICALLY (.tmp →
//     rename) into inbox/<target>/<id>.json, and stamps a VALID `target` so the
//     agent-bridge file watcher accepts it and pushes it into the running
//     session as a <channel source="agent-bridge"> block.
//   - Hand-writing / SCPing JSON into inbox roots gets QUARANTINED to
//     `.failed/_unrouted/` (target-routing migration path) and never reaches
//     the session. So we MUST go through sendLocalMessage. Verified live on Mini.
//
// Exposes `inject({ target, content, ttlSeconds })` for the Alexa receiver to
// call in-process, AND a CLI mode (`node src/inject.mjs "<task text>"`) for
// manual round-trip testing without touching Alexa / Amazon.
// ============================================================================

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Resolve the agent-bridge BUILT module path robustly ─────────────────────
// We import the *built* JS (build/inbox.js), never the TS source. We try, in
// order: an explicit env override, the repo-relative path (this extension lives
// at <repo>/extensions/alexa-bridge/src/, so the build is three dirs up +
// mcp-server/build/inbox.js), then the homedir path, then the /Users/ethansk
// symlink form. The FIRST one that exists on disk wins. This survives the repo
// being checked out at a different absolute path on a different machine.
function resolveInboxModulePath() {
  const candidates = [
    // 1) Explicit override — set AGENT_BRIDGE_INBOX_JS to force a path.
    process.env.AGENT_BRIDGE_INBOX_JS,
    // 2) Repo-relative: extensions/alexa-bridge/src → up 3 to repo root.
    //    src(0) → alexa-bridge(1) → extensions(2) → repo-root(3).
    resolve(__dirname, '..', '..', '..', 'mcp-server', 'build', 'inbox.js'),
    // 3) The homedir dev-clone build path (works on any machine, any user).
    join(homedir(), 'Projects', 'agent-bridge', 'mcp-server', 'build', 'inbox.js'),
    // 4) Same, but the /Users/ethansk symlink form used cross-machine.
    '/Users/ethansk/Projects/agent-bridge/mcp-server/build/inbox.js',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not locate agent-bridge build/inbox.js. Build the core mcp-server '
      + '(cd mcp-server && npm install && npm run build) or set AGENT_BRIDGE_INBOX_JS '
      + 'to the absolute path of build/inbox.js. Tried:\n  ' + candidates.join('\n  '),
  );
}

// Lazily import the agent-bridge module once and cache the exports. We also pull
// in getLocalMachineName from config.js so the message's from/to fields carry
// the real agent-bridge machine name (e.g. "Ethans-Mac-mini") rather than a
// hardcoded guess — keeps outbox/receiver identifiers stable.
let _mod = null;
async function loadBridge() {
  if (_mod) return _mod;
  const inboxPath = resolveInboxModulePath();
  const inbox = await import(pathToFileURL(inboxPath).href);

  // config.js sits next to inbox.js in the same build/ dir.
  const configPath = join(dirname(inboxPath), 'config.js');
  let getLocalMachineName = null;
  if (existsSync(configPath)) {
    try {
      const config = await import(pathToFileURL(configPath).href);
      getLocalMachineName = config.getLocalMachineName ?? null;
    } catch {
      // Non-fatal: fall back to a generic name below.
    }
  }

  _mod = { inbox, getLocalMachineName, inboxPath };
  return _mod;
}

// ── The in-process inject entry point the Alexa receiver calls ──────────────
// Builds a routed BridgeMessage and hands it to sendLocalMessage(). Returns the
// generated message id so the caller can log it. `target` defaults to the
// default Claude Code persona inbox.
//
// IMPORTANT (fire-and-forget rationale): sendLocalMessage is a fast ATOMIC FILE
// WRITE — it does NOT wait for the Claude session to read or act on the message.
// That's exactly what we want for the Alexa 8-second-ack constraint: we drop the
// task into the inbox and return immediately, while the agent picks it up async.
export async function inject({ target = 'claude-code/default', content, ttlSeconds = 86400 }) {
  if (!content || typeof content !== 'string') {
    throw new Error('inject(): `content` (string) is required');
  }
  const { inbox, getLocalMachineName } = await loadBridge();

  // Real local machine name when available (identity-key derived); else generic.
  const localName = (getLocalMachineName && getLocalMachineName()) || 'local-machine';

  // createMessage(from, to, type, content, replyTo, ttl, target, fromTarget).
  // We set fromTarget = target so the receiving session CAN reply over the
  // bridge (e.g. ack back) if it wants — same convention bridge_send_message
  // uses for local sends.
  const msg = inbox.createMessage(
    localName,        // from  — this machine
    localName,        // to    — also this machine (local delivery)
    'message',        // type
    content,          // content — the human-readable prompt the session sees
    null,             // replyTo
    ttlSeconds,       // ttl
    target,           // target — which inbox (which persona) receives it
    target,           // fromTarget — lets the session reply over the bridge
  );

  inbox.sendLocalMessage(msg);
  return msg.id;
}

// ── CLI mode (manual testing) ───────────────────────────────────────────────
// `node src/inject.mjs "<task text>"` — wraps the given text in the same
// fire-and-forget framing the receiver uses (macOS-notify + Telegram callbacks,
// with the Echo speak-back optional) and injects it. Lets you verify the
// round-trip (a <channel>
// block should surface in the running Claude Code session within ~2s) WITHOUT
// needing Alexa / Amazon / an Echo.
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  // Everything after the script name is the task text (joined so quoting is lax).
  const taskText = process.argv.slice(2).join(' ').trim() || 'what time is it';

  // Resolve the absolute path to speak.sh so the injected instruction is
  // copy-pasteable regardless of the agent's cwd. speak.sh lives one dir up.
  const speakSh = resolve(__dirname, '..', 'speak.sh');
  // Notify target = the Mac to pop the macOS banner on (default MacBookPro).
  const notifyTarget = process.env.ALEXA_BRIDGE_NOTIFY_TARGET || 'MacBookPro';

  // Mirror the EXACT callback framing server.mjs uses (macOS notify + Telegram
  // required; Echo speak-back optional) so a CLI test is representative.
  const content =
    `[alexa] ${taskText}\n\n`
    + `When you finish this task, report the result back to me over BOTH of these reliable channels (do BOTH, do not skip either):\n`
    + `1. Pop a native macOS notification on the Mac I'm at by running: `
    + `agent-bridge notify ${notifyTarget} --title "Alexa task done" --message "<your concise one-line result>" --sound default\n`
    + `2. Send me a Telegram message with the FULL result (your normal Telegram reply path).\n`
    + `Optionally, ONLY if the Echo speak-back is set up, you may ALSO announce a short result on the Echo by running: `
    + `bash ${speakSh} "<your concise result>" — but this is optional/secondary; the macOS notification + Telegram are the required callbacks. `
    + `(Manual CLI test injection from the alexa-bridge extension.)`;

  inject({ content })
    .then((id) => {
      console.log(`injected ${id} → ${content}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('inject failed:', err.message);
      process.exit(1);
    });
}
