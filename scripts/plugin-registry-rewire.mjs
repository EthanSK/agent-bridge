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
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

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

function readJsonSafe(path) {
  if (!existsSync(path)) return { exists: false, data: null };
  try {
    const raw = readFileSync(path, 'utf8');
    return { exists: true, data: JSON.parse(raw), raw };
  } catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      path, phase: 'read', error: String(err),
    });
    throw err;
  }
}

function backupAndWrite(path, newObj) {
  const ts = Math.floor(Date.now() / 1000);
  const bakPath = `${path}.bak.${ts}`;
  copyFileSync(path, bakPath);

  const newRaw = JSON.stringify(newObj, null, 2) + '\n';
  writeFileSync(path, newRaw);

  // Validate by re-parsing.
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      path, phase: 'post_write_parse',
      error: String(err),
      action: 'rolled_back_from_backup',
      backup: bakPath,
    });
    copyFileSync(bakPath, path);
    throw err;
  }

  return bakPath;
}

// ---------- Path comparison helpers (cross-platform via node:path) ----------

function pathExists(p) {
  try { return existsSync(p); } catch { return false; }
}

function normPath(p) {
  if (!p) return '';
  let r = resolve(p);
  if (r.endsWith(sep) && r.length > 1) r = r.slice(0, -1);
  return r;
}

function pathsEqual(a, b) {
  return normPath(a) === normPath(b);
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
    const entries = data.plugins[key];
    if (!Array.isArray(entries)) continue;

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

  const stats = { claudeChanged: false, openclawChanged: false, settingsChanged: false };

  try { rewirePhase1ClaudeRegistry(stats); }
  catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'claude_code', error: String(err),
    });
  }

  try { rewirePhase2OpenClawRegistry(stats); }
  catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'openclaw', error: String(err),
    });
  }

  try { rewirePhase3MarketplaceRegistration(stats); }
  catch (err) {
    log('error', 'auto_update_runner.plugin_registry_error', {
      phase: 'marketplace', error: String(err),
    });
  }

  if (!stats.claudeChanged && !stats.openclawChanged && !stats.settingsChanged) {
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
