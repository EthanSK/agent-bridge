#!/usr/bin/env node
//
// agent-bridge/scripts/plugin-registry-rewire.mjs
// ------------------------------------------------
// [PLUGIN-REGISTRY-REWIRE 2026-05-01]
//
// Self-healing harness-side plugin-registry validation step.
//
// PROBLEM:
//   The auto-update flow (`scripts/update.sh`) only does `git pull && npm run
//   build`. It does NOT validate that the harness-side plugin registry entries
//   actually point at a path that exists on disk. After a manual rewire from
//   the cache path to a dev-clone path, stale cache-path entries can persist
//   for months, silently causing "/reload-plugins" errors and "stuck on old
//   version" failures across the fleet.
//
//   See Ethan's voice 6059 (2026-05-01): "Doesn't [agent-bridge] auto-update?
//   Does the auto-update not reinstall the plugin on the Claude path? It
//   should, and OpenClaw if it's a different path to the repo. When we
//   reinstall, it should make sure — add that rule. That's very important
//   because this keeps happening."
//
// WHAT THIS DOES:
//   Three phases of validation, all targeting ONLY the agent-bridge plugin:
//
//   Phase 1 — Claude Code registry (~/.claude/plugins/installed_plugins.json)
//     For each entry under `.plugins["agent-bridge@<marketplace>"]`:
//       * If `installPath` does not exist on disk:
//           - If a directory-source marketplace entry for "agent-bridge" exists
//             in ~/.claude/settings.json's extraKnownMarketplaces, REMOVE the
//             stale entry (Strategy B — marketplace handles the registration).
//           - Otherwise REWIRE installPath to the current dev-clone plugin-root
//             (Strategy A — the entry is the only registration channel).
//       * If `installPath` exists but is a stale cache path (e.g.
//         ~/.claude/plugins/cache/agent-bridge/agent-bridge/<old-version>) AND
//         the dev-clone is what's actually running, also rewire/remove per the
//         same decision tree.
//
//   Phase 2 — OpenClaw registry (~/.openclaw/openclaw.json)
//     * For each path in plugins.load.paths[] that mentions "agent-bridge",
//       check it exists. If stale, rewire to the current dev-clone's
//       openclaw-channel subdir.
//     * plugins.entries["agent-bridge"] is config-only — no path to validate.
//
//   Phase 3 — Marketplace registration (~/.claude/settings.json)
//     * Validate extraKnownMarketplaces["agent-bridge"].source.path exists.
//     * Only rewire if the registered path does not exist. If it exists but
//       points elsewhere, log a warn and do NOT rewrite — Ethan may be
//       deliberately using a different clone.
//
// SAFETY:
//   * Never touches entries for any plugin OTHER than agent-bridge.
//   * Backs up every JSON file to `<file>.bak.<unix-ts>` before modifying.
//   * Re-validates JSON post-edit; rolls back from backup on parse failure.
//   * Idempotent — re-running with no stale state is a clean no-op (a single
//     `auto_update_runner.plugin_registry_clean` event per harness).
//   * Failure of this step does NOT abort the auto-update flow. update.sh
//     continues on to the cache sync / openclaw / reload steps.
//
// USAGE:
//   node scripts/plugin-registry-rewire.mjs [--dry-run] [--verbose] [--repo-root=PATH]
//
//   --dry-run             Print what would change but write nothing.
//   --verbose             Verbose logging to stderr (also still emits NDJSON).
//   --repo-root=PATH      Override auto-detection of the repo root. Defaults to
//                         the parent of the script's directory (works because
//                         the script lives at <repo-root>/scripts/).
//
// EXIT CODES:
//   0 — success (clean OR rewired)
//   1 — internal error (filesystem, JSON parse, etc). update.sh should NOT
//       abort on this — log loud + continue.
//   2 — usage error (bad CLI args).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir, hostname, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

// ---------- CLI args --------------------------------------------------------

let DRY_RUN = false;
let VERBOSE = false;
let REPO_ROOT_OVERRIDE = null;

for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') DRY_RUN = true;
  else if (arg === '--verbose' || arg === '-v') VERBOSE = true;
  else if (arg.startsWith('--repo-root=')) REPO_ROOT_OVERRIDE = arg.slice('--repo-root='.length);
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write(readFileSync(SCRIPT_PATH, 'utf8').split('\n').slice(0, 80).join('\n') + '\n');
    process.exit(0);
  } else {
    process.stderr.write(`unknown arg: ${arg}\n`);
    process.exit(2);
  }
}

// ---------- Repo-root detection (no shell exec — safe on Windows) -----------

function detectRepoRoot() {
  if (REPO_ROOT_OVERRIDE) return resolve(REPO_ROOT_OVERRIDE);
  // Script lives at <repo-root>/scripts/plugin-registry-rewire.mjs.
  const guess = resolve(SCRIPT_DIR, '..');
  return guess;
}

const REPO_ROOT = detectRepoRoot();
const PLUGIN_ROOT = join(REPO_ROOT, 'mcp-server');
const OPENCLAW_PLUGIN_ROOT = join(REPO_ROOT, 'openclaw-channel');

// ---------- Logging ---------------------------------------------------------

const HOST = (() => {
  try { return hostname().split('.')[0]; }
  catch { return 'unknown'; }
})();

const LOG_DIR = process.env.SKILL_LOG_DIR || join(homedir(), '.claude', 'logs');
const LOG_FILE = process.env.SKILL_LOG_FILE || join(LOG_DIR, 'skills.log');
const LOG_MAX_BYTES = 50 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function log(level, event, context) {
  const record = {
    ts: nowIso(),
    host: HOST,
    component: 'agent-bridge',
    skill: 'auto-update-runner',
    event,
    level,
    context: context || {},
  };
  const line = JSON.stringify(record);

  if (VERBOSE) {
    process.stderr.write(`[plugin-registry-rewire] ${event} ${JSON.stringify(context || {})}\n`);
  }

  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    try {
      const st = statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* file may not exist yet; ignore */ }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Best-effort; never fail the flow on log error.
  }
}

// ---------- JSON file helpers (atomic + backup + rollback) ------------------

// Strip line + block comments and trailing commas so we tolerate JSONC variants
// of ~/.claude/settings.json and ~/.openclaw/openclaw.json. Strings are
// preserved verbatim — // and /* */ inside string literals must NOT be
// stripped, and trailing-comma stripping must skip over string contents.
//
// Codex-review fix (v3.14.1): strict JSON.parse() previously made the entire
// phase silently skip when settings.json had a stray comment or trailing
// comma. We now best-effort-tolerate it; if the JSONC stripping produces
// invalid JSON we still throw, so genuinely-broken files are still flagged.
function stripJsonc(raw) {
  let out = '';
  let i = 0;
  const n = raw.length;
  let inString = false;
  let stringQuote = '';
  let escape = false;

  while (i < n) {
    const ch = raw[i];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    // Block comment.
    if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      if (end === -1) { i = n; break; }
      i = end + 2;
      continue;
    }
    // Line comment.
    if (ch === '/' && raw[i + 1] === '/') {
      const nl = raw.indexOf('\n', i + 2);
      if (nl === -1) { i = n; break; }
      i = nl; // keep the newline so line numbers stay correct
      continue;
    }
    // Enter string.
    if (ch === '"' || ch === '\'') {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }

  // Trailing-comma strip — `,` followed by optional whitespace then `]` or `}`.
  // The earlier pass has already removed comments + preserved strings, so this
  // regex is safe against false positives within strings.
  out = out.replace(/,(\s*[\]}])/g, '$1');
  return out;
}

function parseJsonTolerant(raw) {
  try {
    return JSON.parse(raw);
  } catch (firstErr) {
    // Fall back to JSONC tolerance.
    try {
      return JSON.parse(stripJsonc(raw));
    } catch {
      // Throw the original error so the message matches the file's actual
      // syntax issue rather than the post-strip artifact.
      throw firstErr;
    }
  }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return { exists: false, data: null };
  try {
    const raw = readFileSync(path, 'utf8');
    return { exists: true, data: parseJsonTolerant(raw), raw };
  } catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      path, phase: 'read', error: String(err),
    });
    throw err;
  }
}

// Generate a collision-resistant suffix combining ms-resolution timestamp,
// PID, and crypto random bytes — guards against:
//   * two concurrent rewire runs landing on the same second
//   * Date-resolution clamping on filesystems with 1s mtime granularity
function uniqueSuffix() {
  const ms = Date.now();
  const pid = process.pid;
  const rand = randomBytes(4).toString('hex');
  return `${ms}-${pid}-${rand}`;
}

// Codex-review fix (v3.14.1): the previous backupAndWrite() did
// copyFileSync + writeFileSync in-place. That sequence is non-atomic — a
// concurrent reader could see a half-written or truncated file, two
// concurrent rewires within the same wall-clock second would clobber each
// other's backup, and a crash between copy and write would leave the real
// file empty. New flow:
//   1. cp original -> <file>.bak.<unique>
//   2. write candidate to <file>.tmp.<unique> (separate from real file)
//   3. re-parse the temp file (validate) BEFORE swapping
//   4. renameSync(temp, real) — atomic on POSIX, best-effort on Windows
//   5. on any failure between steps 2-4, unlink the temp + leave the real
//      file untouched. Rollback from backup remains the last-resort path.
function backupAndWrite(path, newObj) {
  const suffix = uniqueSuffix();
  const bakPath = `${path}.bak.${suffix}`;
  const tmpPath = `${path}.tmp.${suffix}`;

  // 1. Backup with a unique name (no collisions even at sub-second cadence).
  copyFileSync(path, bakPath);

  const newRaw = JSON.stringify(newObj, null, 2) + '\n';

  let renamed = false;
  try {
    // 2. Write candidate to side-file in same directory.
    writeFileSync(tmpPath, newRaw);

    // 3. Validate by re-parsing the temp file (NOT the real file — the real
    //    file hasn't been touched yet).
    JSON.parse(readFileSync(tmpPath, 'utf8'));

    // 4. Atomic swap. On POSIX rename is atomic when src+dst are on the same
    //    filesystem; tmpPath is in the same directory as path, so this holds.
    renameSync(tmpPath, path);
    renamed = true;
  } catch (err) {
    // Either write, parse, or rename failed.
    log('error', 'auto_update_runner.plugin_registry_error', {
      path, phase: 'atomic_write',
      error: String(err),
      action: renamed ? 'rolled_back_from_backup' : 'tmp_left_unswapped',
      backup: bakPath,
    });
    // Clean up the temp file if we wrote one but never renamed it.
    if (!renamed) {
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    } else {
      // Rename succeeded but a later step (none currently) might have failed.
      // Roll back from backup to the pre-swap state.
      try { copyFileSync(bakPath, path); } catch { /* best-effort */ }
    }
    throw err;
  }

  return bakPath;
}

// ---------- Path comparison helpers (cross-platform via node:path) ----------

const IS_WINDOWS = platform() === 'win32';

function pathExists(p) {
  try { return existsSync(p); } catch { return false; }
}

function normPath(p) {
  if (!p) return '';
  let r = resolve(p);
  if (r.endsWith(sep) && r.length > 1) r = r.slice(0, -1);
  return r;
}

// Codex-review fix (v3.14.1): on macOS the dev-clone may resolve through
// symlinks (`/Users/x/Projects/agent-bridge` vs. `/Users/x/Projects/.git-checkouts/...`)
// and on Windows resolve()'s output can differ in case (`C:\Repo` vs
// `c:\repo`). Either case made pathsEqual() return false even when both
// paths pointed at the same directory, causing false stale detection and
// breaking idempotent re-runs. We canonicalize via realpathSync.native when
// the path exists and lower-case on Windows for case-insensitive compare.
function canonicalize(p) {
  if (!p) return '';
  const r = normPath(p);
  if (!r) return '';
  let out = r;
  try {
    // Use realpathSync.native when available (proper Windows long-path
    // handling). Falls back to plain realpathSync on older Node builds.
    const real = realpathSync.native ? realpathSync.native(r) : realpathSync(r);
    if (real) out = real;
  } catch {
    // Path doesn't exist OR symlink target is missing OR EACCES — keep the
    // resolve()-only normalization. Callers already check pathExists()
    // separately for the "exists" decision.
  }
  if (IS_WINDOWS) out = out.toLowerCase();
  return out;
}

function pathsEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}

// Detect a Claude-plugins cache-style path:
//   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>
function isClaudePluginsCachePath(p) {
  if (!p) return false;
  const norm = normPath(p);
  return norm.includes(`${sep}.claude${sep}plugins${sep}cache${sep}`);
}

// ---------- Read current package version ------------------------------------

function currentPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// ---------- Phase 1: Claude Code registry -----------------------------------

const CLAUDE_INSTALLED_PLUGINS_PATH = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function hasDirectorySourceMarketplace(settingsData) {
  if (!settingsData || typeof settingsData !== 'object') return false;
  const ekm = settingsData.extraKnownMarketplaces;
  if (!ekm || typeof ekm !== 'object') return false;
  const ab = ekm['agent-bridge'];
  if (!ab || typeof ab !== 'object') return false;
  const src = ab.source;
  if (!src || typeof src !== 'object') return false;
  return src.source === 'directory' && typeof src.path === 'string' && src.path.length > 0;
}

function rewirePhase1ClaudeRegistry(stats) {
  const installed = readJsonSafe(CLAUDE_INSTALLED_PLUGINS_PATH);
  if (!installed.exists) {
    log('info', 'auto_update_runner.plugin_registry_skip', {
      harness: 'claude-code',
      reason: 'installed_plugins_json_missing',
      path: CLAUDE_INSTALLED_PLUGINS_PATH,
    });
    return;
  }

  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH);
  const hasMarketplace = hasDirectorySourceMarketplace(settings.exists ? settings.data : null);

  const data = installed.data;
  if (!data || typeof data !== 'object' || !data.plugins || typeof data.plugins !== 'object') {
    log('warn', 'auto_update_runner.plugin_registry_error', {
      harness: 'claude-code',
      reason: 'unexpected_shape',
      path: CLAUDE_INSTALLED_PLUGINS_PATH,
    });
    return;
  }

  // Find ALL agent-bridge keys (could be `agent-bridge@agent-bridge`,
  // `agent-bridge@<other-marketplace>`, etc.). Never touch anything else.
  const agentBridgeKeys = Object.keys(data.plugins).filter((k) => /^agent-bridge@/.test(k));
  if (agentBridgeKeys.length === 0) {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      reason: 'no_agent_bridge_entries',
    });
    return;
  }

  let mutated = false;
  const currentPluginRoot = normPath(PLUGIN_ROOT);
  const currentVersion = currentPluginVersion();

  for (const key of agentBridgeKeys) {
    const rawEntries = data.plugins[key];
    let entries;
    // Codex-review fix (v3.14.1): the previous code silently skipped
    // (`continue`d) on a non-array agent-bridge entry. That hid genuinely
    // malformed registry state for the very plugin this script owns. We now:
    //   - normalize a single object into a one-element array (some plugin
    //     hosts have historically written entries as either shape)
    //   - log a warn for any other type and SKIP (no normalization possible)
    if (Array.isArray(rawEntries)) {
      entries = rawEntries;
    } else if (rawEntries && typeof rawEntries === 'object') {
      log('warn', 'auto_update_runner.plugin_registry_error', {
        harness: 'claude-code',
        marketplace_key: key,
        reason: 'agent_bridge_entry_was_object_not_array',
        action: 'normalized_to_single_element_array',
      });
      entries = [rawEntries];
    } else {
      log('warn', 'auto_update_runner.plugin_registry_error', {
        harness: 'claude-code',
        marketplace_key: key,
        reason: 'agent_bridge_entry_unexpected_type',
        type: typeof rawEntries,
        action: 'skipped',
      });
      continue;
    }

    const kept = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        kept.push(entry);
        continue;
      }
      const before = entry.installPath || '';
      const beforeExists = pathExists(before);
      const isCachePath = isClaudePluginsCachePath(before);
      const matchesCurrent = pathsEqual(before, currentPluginRoot);

      // Two trigger conditions for action:
      //   (a) installPath doesn't exist (definitively stale)
      //   (b) installPath is a Claude-plugins cache path AND doesn't match
      //       the current dev-clone plugin-root (stale cache)
      let needsAction = false;
      let reason = '';
      if (!beforeExists) {
        needsAction = true;
        reason = 'missing_install_path';
      } else if (isCachePath && !matchesCurrent) {
        needsAction = true;
        reason = 'stale_cache_path_dev_clone_active';
      }

      if (!needsAction) {
        kept.push(entry);
        continue;
      }

      mutated = true;

      if (hasMarketplace) {
        // Strategy B — drop the entry; marketplace handles registration.
        log('info', 'auto_update_runner.plugin_registry_rewired', {
          harness: 'claude-code',
          plugin: 'agent-bridge',
          marketplace_key: key,
          action: 'removed',
          before_path: before,
          reason,
          dry_run: DRY_RUN,
        });
        // Drop (do not push to kept).
      } else {
        // Strategy A — rewire installPath to current dev-clone.
        const newEntry = { ...entry };
        newEntry.installPath = currentPluginRoot;
        if (currentVersion) newEntry.version = currentVersion;
        newEntry.lastUpdated = nowIso();
        log('info', 'auto_update_runner.plugin_registry_rewired', {
          harness: 'claude-code',
          plugin: 'agent-bridge',
          marketplace_key: key,
          action: 'rewired',
          before_path: before,
          after_path: currentPluginRoot,
          reason,
          dry_run: DRY_RUN,
        });
        kept.push(newEntry);
      }
    }

    if (kept.length === 0) {
      delete data.plugins[key];
    } else {
      data.plugins[key] = kept;
    }
  }

  if (mutated) {
    stats.claudeChanged = true;
    if (!DRY_RUN) {
      const bak = backupAndWrite(CLAUDE_INSTALLED_PLUGINS_PATH, data);
      log('info', 'auto_update_runner.plugin_registry_backup', {
        harness: 'claude-code',
        path: CLAUDE_INSTALLED_PLUGINS_PATH,
        backup: bak,
      });
    }
  } else {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      checked_keys: agentBridgeKeys,
    });
  }
}

// ---------- Phase 2: OpenClaw registry --------------------------------------

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

function rewirePhase2OpenClawRegistry(stats) {
  const oc = readJsonSafe(OPENCLAW_CONFIG_PATH);
  if (!oc.exists) {
    log('info', 'auto_update_runner.plugin_registry_skip', {
      harness: 'openclaw',
      reason: 'openclaw_json_missing',
      path: OPENCLAW_CONFIG_PATH,
    });
    return;
  }

  const data = oc.data;
  if (!data || typeof data !== 'object') {
    log('warn', 'auto_update_runner.plugin_registry_error', {
      harness: 'openclaw',
      reason: 'unexpected_shape',
      path: OPENCLAW_CONFIG_PATH,
    });
    return;
  }

  const plugins = data.plugins;
  if (!plugins || typeof plugins !== 'object') {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'openclaw',
      reason: 'no_plugins_section',
    });
    return;
  }

  let mutated = false;
  const currentOpenclawPluginRoot = normPath(OPENCLAW_PLUGIN_ROOT);

  // 2a. Validate plugins.load.paths[] entries that BELONG to agent-bridge.
  const loadPaths = plugins.load && Array.isArray(plugins.load.paths) ? plugins.load.paths : null;
  if (loadPaths) {
    const newPaths = [];
    for (const p of loadPaths) {
      if (typeof p !== 'string') {
        newPaths.push(p);
        continue;
      }
      // Strict ownership check — only treat a path as agent-bridge's if it
      // contains "agent-bridge" AND ends with "openclaw-channel". Anything
      // else (Repost-with-agent, agent-completion-chime, etc.) is left alone.
      const norm = normPath(p);
      const looksLikeAgentBridge =
        /(^|[\\/])agent-bridge([\\/]|$)/.test(norm) &&
        (norm.endsWith(`${sep}openclaw-channel`) || norm.endsWith(`${sep}openclaw-channel${sep}`));
      if (!looksLikeAgentBridge) {
        newPaths.push(p);
        continue;
      }

      const exists = pathExists(p);
      const matchesCurrent = pathsEqual(p, currentOpenclawPluginRoot);

      if (exists && matchesCurrent) {
        // Already pointing at the current dev-clone — keep as-is.
        newPaths.push(p);
        continue;
      }

      if (!exists) {
        // Stale — rewire.
        log('info', 'auto_update_runner.plugin_registry_rewired', {
          harness: 'openclaw',
          plugin: 'agent-bridge',
          field: 'plugins.load.paths',
          action: 'rewired',
          before_path: p,
          after_path: currentOpenclawPluginRoot,
          reason: 'missing_install_path',
          dry_run: DRY_RUN,
        });
        newPaths.push(currentOpenclawPluginRoot);
        mutated = true;
        continue;
      }

      // Path exists but does NOT match the current dev clone. Could be a
      // legitimate alternate clone. Log and leave alone.
      log('warn', 'auto_update_runner.plugin_registry_skip', {
        harness: 'openclaw',
        field: 'plugins.load.paths',
        before_path: p,
        current_dev_clone: currentOpenclawPluginRoot,
        reason: 'path_exists_but_does_not_match_current_dev_clone',
      });
      newPaths.push(p);
    }

    const changed = newPaths.length !== loadPaths.length ||
      newPaths.some((q, i) => q !== loadPaths[i]);
    if (changed) {
      plugins.load.paths = newPaths;
    }
  }

  // 2b. plugins.entries["agent-bridge"] — config-only, no path to validate.

  if (mutated) {
    stats.openclawChanged = true;
    if (!DRY_RUN) {
      const bak = backupAndWrite(OPENCLAW_CONFIG_PATH, data);
      log('info', 'auto_update_runner.plugin_registry_backup', {
        harness: 'openclaw',
        path: OPENCLAW_CONFIG_PATH,
        backup: bak,
      });
    }
  } else {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'openclaw',
    });
  }
}

// ---------- Phase 3: Marketplace registration -------------------------------

function rewirePhase3MarketplaceRegistration(stats) {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH);
  if (!settings.exists) {
    log('info', 'auto_update_runner.plugin_registry_skip', {
      harness: 'claude-code',
      phase: 'marketplace',
      reason: 'settings_json_missing',
    });
    return;
  }

  const data = settings.data;
  if (!data || typeof data !== 'object') {
    log('warn', 'auto_update_runner.plugin_registry_error', {
      harness: 'claude-code',
      phase: 'marketplace',
      reason: 'unexpected_shape',
    });
    return;
  }

  const ekm = data.extraKnownMarketplaces;
  if (!ekm || typeof ekm !== 'object') {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      phase: 'marketplace',
      reason: 'no_extra_known_marketplaces',
    });
    return;
  }

  const ab = ekm['agent-bridge'];
  if (!ab || typeof ab !== 'object') {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      phase: 'marketplace',
      reason: 'no_agent_bridge_marketplace_entry',
    });
    return;
  }

  const src = ab.source;
  if (!src || typeof src !== 'object' || src.source !== 'directory') {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      phase: 'marketplace',
      reason: 'not_directory_source',
    });
    return;
  }

  const before = src.path || '';
  if (pathExists(before) && pathsEqual(before, REPO_ROOT)) {
    log('info', 'auto_update_runner.plugin_registry_clean', {
      harness: 'claude-code',
      phase: 'marketplace',
      path: before,
    });
    return;
  }

  if (pathExists(before)) {
    // Path exists but doesn't match the current repo root. Leave alone.
    log('warn', 'auto_update_runner.plugin_registry_skip', {
      harness: 'claude-code',
      phase: 'marketplace',
      before_path: before,
      current_dev_clone: REPO_ROOT,
      reason: 'marketplace_path_exists_but_does_not_match_current_dev_clone',
    });
    return;
  }

  // Path does not exist. Rewire.
  src.path = normPath(REPO_ROOT);
  log('info', 'auto_update_runner.plugin_registry_rewired', {
    harness: 'claude-code',
    phase: 'marketplace',
    plugin: 'agent-bridge',
    action: 'rewired',
    before_path: before,
    after_path: src.path,
    reason: 'missing_install_path',
    dry_run: DRY_RUN,
  });

  stats.settingsChanged = true;
  if (!DRY_RUN) {
    const bak = backupAndWrite(CLAUDE_SETTINGS_PATH, data);
    log('info', 'auto_update_runner.plugin_registry_backup', {
      harness: 'claude-code',
      phase: 'marketplace',
      path: CLAUDE_SETTINGS_PATH,
      backup: bak,
    });
  }
}

// ---------- Main ------------------------------------------------------------

function main() {
  log('info', 'auto_update_runner.plugin_registry_start', {
    repo_root: REPO_ROOT,
    plugin_root: PLUGIN_ROOT,
    openclaw_plugin_root: OPENCLAW_PLUGIN_ROOT,
    dry_run: DRY_RUN,
  });

  const stats = {
    claudeChanged: false,
    openclawChanged: false,
    settingsChanged: false,
    // Codex-review fix (v3.14.1): track phase failures so exit code reflects
    // them. The previous code swallowed all phase errors and emitted a
    // "clean / idempotent" done event, which made update.sh's success-path
    // log a happy "rewire ok" even when the file was unparseable / unwritable.
    errors: [],
  };

  try { rewirePhase1ClaudeRegistry(stats); }
  catch (err) {
    stats.errors.push({ phase: 'claude_code', error: String(err) });
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'claude_code', error: String(err),
    });
  }

  try { rewirePhase2OpenClawRegistry(stats); }
  catch (err) {
    stats.errors.push({ phase: 'openclaw', error: String(err) });
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'openclaw', error: String(err),
    });
  }

  try { rewirePhase3MarketplaceRegistration(stats); }
  catch (err) {
    stats.errors.push({ phase: 'marketplace', error: String(err) });
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'marketplace', error: String(err),
    });
  }

  const anyChanged = stats.claudeChanged || stats.openclawChanged || stats.settingsChanged;
  const hadErrors = stats.errors.length > 0;

  if (hadErrors) {
    log('error', 'auto_update_runner.plugin_registry_done', {
      changed: anyChanged,
      claude_changed: stats.claudeChanged,
      openclaw_changed: stats.openclawChanged,
      settings_changed: stats.settingsChanged,
      errors: stats.errors,
      idempotent: false,
      dry_run: DRY_RUN,
    });
    if (VERBOSE) {
      process.stderr.write(`[plugin-registry-rewire] completed with ` +
        `${stats.errors.length} phase error(s) — see ${LOG_FILE}\n`);
    }
    // Codex-review fix (v3.14.1): exit non-zero so scripts/update.sh's
    // warn-path actually fires. update.sh deliberately does NOT abort the
    // overall auto-update on this exit code; it just surfaces the failure.
    process.exitCode = 1;
    return;
  }

  if (!anyChanged) {
    log('info', 'auto_update_runner.plugin_registry_done', {
      changed: false,
      idempotent: true,
    });
    if (VERBOSE) process.stderr.write('[plugin-registry-rewire] clean — nothing to do\n');
  } else {
    log('info', 'auto_update_runner.plugin_registry_done', {
      changed: true,
      claude_changed: stats.claudeChanged,
      openclaw_changed: stats.openclawChanged,
      settings_changed: stats.settingsChanged,
      dry_run: DRY_RUN,
    });
    if (VERBOSE) {
      process.stderr.write(`[plugin-registry-rewire] changes applied ` +
        `(claude=${stats.claudeChanged} openclaw=${stats.openclawChanged} ` +
        `settings=${stats.settingsChanged} dry_run=${DRY_RUN})\n`);
    }
  }
}

main();
