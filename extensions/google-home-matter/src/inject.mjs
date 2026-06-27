// ============================================================================
// inject.mjs — the "inject a message into the local Claude Code session" path.
//
// This is the CRUX of the whole extension. It reuses agent-bridge's OWN built
// module (mcp-server/build/inbox.js) and calls `sendLocalMessage()` — the exact
// same function `bridge_send_message` uses internally for the `machine:"local"`
// case (see mcp-server/src/tools.ts where `isLocal` → `sendLocalMessage(msg)`).
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
// Exposes `inject({ target, content, ttlSeconds })` for the Matter server to
// call in-process, AND a CLI mode (`node inject.mjs <name> <on|off> <bri0-254>`)
// for manual round-trip testing without touching Matter / Google.
// ============================================================================

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Resolve the agent-bridge BUILT module path robustly ─────────────────────
// We import the *built* JS (build/inbox.js), never the TS source. We try, in
// order: an explicit env override, the repo-relative path (this extension lives
// at <repo>/extensions/google-home-matter/src/, so the build is four dirs up +
// mcp-server/build/inbox.js), then the Mini's known absolute path as a last
// resort. The FIRST one that exists on disk wins. This survives the repo being
// checked out at a different absolute path on a different machine.
function resolveInboxModulePath() {
  const candidates = [
    // 1) Explicit override — set AGENT_BRIDGE_INBOX_JS to force a path.
    process.env.AGENT_BRIDGE_INBOX_JS,
    // 2) Repo-relative: extensions/google-home-matter/src → up 3 to repo root.
    //    src(0) → google-home-matter(1) → extensions(2) → repo-root(3).
    resolve(__dirname, '..', '..', '..', 'mcp-server', 'build', 'inbox.js'),
    // 3) The Mini's known dev-clone build path (prior research verified this).
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

// ── The in-process inject entry point the Matter server calls ───────────────
// Builds a routed BridgeMessage and hands it to sendLocalMessage(). Returns the
// generated message id so the caller can log it. `target` defaults to the
// default Claude Code persona inbox.
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
// `node src/inject.mjs <name> <on|off> <bri0-254>` — builds a simple message
// and injects it, mirroring what a real Matter device toggle would send. Lets
// you verify the round-trip (a <channel> block should surface in the running
// Claude Code session within ~2s) WITHOUT needing Matter or Google Home.
const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const [name = 'Claude', state = 'on', briRaw = ''] = process.argv.slice(2);
  const bri = briRaw === '' ? '' : Number(briRaw);
  const briPct = bri === '' ? '' : Math.round((Number(bri) / 254) * 100);
  const content =
    `[google-home] trigger=${name} state=${state}`
    + (briPct === '' ? '' : ` brightness=${briPct}`)
    + `. Manual CLI test injection from the google-home-matter extension. Treat as a routed Nest voice command.`;

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
