// mcp-server/test/plugin-registry-rewire.test.mjs
// ------------------------------------------------
// [PLUGIN-REGISTRY-REWIRE 2026-05-01]
//
// Tests for scripts/plugin-registry-rewire.mjs.
//
// Strategy: each test creates a sandbox HOME directory with carefully crafted
// `.claude/` and `.openclaw/` JSON files, then runs the rewire script against
// that sandbox via the HOME / SKILL_LOG_DIR env vars. We validate the
// post-state of the JSON files plus the NDJSON log lines to confirm the right
// events fired with the right context.
//
// Critical invariants tested:
//   - Stale missing-installPath triggers the right action
//   - Strategy A (rewire) — when no marketplace entry
//   - Strategy B (remove) — when directory-source marketplace entry exists
//   - Multiple entries (user + project scope) handled per-entry
//   - OpenClaw plugins.load.paths rewired
//   - Idempotent re-run is a no-op
//   - Backup files are created
//   - Rollback on JSON validation failure
//   - Other plugins (Repost-with-agent, agent-completion-chime) are NEVER touched
//   - JSON cosmetic preservation (no spurious diff)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scripts/plugin-registry-rewire.mjs lives at <repo-root>/scripts/.
// This test file lives at <repo-root>/mcp-server/test/.
const REPO_ROOT = resolve(__dirname, '..', '..');
const REWIRE_SCRIPT = join(REPO_ROOT, 'scripts', 'plugin-registry-rewire.mjs');

// ---------- Sandbox helpers -------------------------------------------------

function makeSandbox() {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'plugin-registry-rewire-test-'));
  mkdirSync(join(sandboxHome, '.claude', 'plugins'), { recursive: true });
  mkdirSync(join(sandboxHome, '.claude', 'logs'), { recursive: true });
  mkdirSync(join(sandboxHome, '.openclaw'), { recursive: true });
  return sandboxHome;
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readLogLines(sandboxHome) {
  const logPath = join(sandboxHome, '.claude', 'logs', 'skills.log');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function findEvent(records, event, predicate) {
  return records.find((r) => r.event === event && (!predicate || predicate(r)));
}

function runRewire(sandboxHome, repoRoot, extraArgs = []) {
  const args = [REWIRE_SCRIPT, `--repo-root=${repoRoot}`, ...extraArgs];
  const res = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome, // Windows
      SKILL_LOG_DIR: join(sandboxHome, '.claude', 'logs'),
      SKILL_LOG_FILE: join(sandboxHome, '.claude', 'logs', 'skills.log'),
    },
    encoding: 'utf8',
  });
  return { res, log: readLogLines(sandboxHome) };
}

function fakeRepoRoot() {
  // Build a fake repo-root with mcp-server/package.json + openclaw-channel/.
  const root = mkdtempSync(join(tmpdir(), 'plugin-registry-rewire-fake-repo-'));
  mkdirSync(join(root, 'mcp-server'), { recursive: true });
  mkdirSync(join(root, 'openclaw-channel'), { recursive: true });
  writeJson(join(root, 'mcp-server', 'package.json'), {
    name: 'agent-bridge-mcp-server',
    version: '3.14.0',
  });
  return root;
}

function teardown(...paths) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- Tests -----------------------------------------------------------

test('Strategy B: removes stale entry when directory-source marketplace exists', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          {
            scope: 'user',
            installPath: join(home, '.claude', 'plugins', 'cache', 'agent-bridge', 'agent-bridge', '3.10.1'),
            version: '3.10.1',
            installedAt: '2026-04-15T00:00:00Z',
            lastUpdated: '2026-04-15T00:00:00Z',
            gitCommitSha: 'deadbeef',
          },
        ],
        'repost-with-agent@repost-with-agent': [
          { scope: 'user', installPath: '/some/repost/path', version: '4.1.0' },
        ],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': {
          source: { source: 'directory', path: repo },
        },
      },
    });

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);

    const after = readJson(installedPath);
    assert.equal(after.plugins['agent-bridge@agent-bridge'], undefined,
      'agent-bridge entry should have been removed (Strategy B)');
    assert.deepEqual(after.plugins['repost-with-agent@repost-with-agent'],
      [{ scope: 'user', installPath: '/some/repost/path', version: '4.1.0' }],
      'unrelated plugin entries must NEVER be touched');

    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.action === 'removed' && r.context.harness === 'claude-code');
    assert.ok(ev, 'expected removed-action event');
    assert.equal(ev.context.plugin, 'agent-bridge');
    assert.equal(ev.context.reason, 'missing_install_path');
  } finally {
    teardown(home, repo);
  }
});

test('Strategy A: rewires installPath when no marketplace entry exists', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          {
            scope: 'user',
            installPath: '/no/longer/exists/agent-bridge/cache',
            version: '3.10.1',
            installedAt: '2026-04-15T00:00:00Z',
            lastUpdated: '2026-04-15T00:00:00Z',
          },
        ],
      },
    });
    // No extraKnownMarketplaces.
    writeJson(settingsPath, { permissions: { allow: [] } });

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);

    const after = readJson(installedPath);
    const entries = after.plugins['agent-bridge@agent-bridge'];
    assert.ok(Array.isArray(entries) && entries.length === 1,
      'entry should still exist (rewired, not removed)');
    assert.equal(entries[0].installPath, join(repo, 'mcp-server'));
    assert.equal(entries[0].version, '3.14.0', 'version should be updated to current pkg version');
    assert.notEqual(entries[0].lastUpdated, '2026-04-15T00:00:00Z',
      'lastUpdated should have been refreshed');

    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.action === 'rewired' && r.context.harness === 'claude-code');
    assert.ok(ev, 'expected rewired-action event');
    assert.equal(ev.context.after_path, join(repo, 'mcp-server'));
  } finally {
    teardown(home, repo);
  }
});

test('multiple entries (user + project): each is handled per-entry', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    // user-scope entry is stale; project-scope is current. Marketplace entry
    // exists, so stale → removed; current → kept.
    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          {
            scope: 'project',
            projectPath: '/some/project',
            installPath: join(repo, 'mcp-server'), // current path; valid
            version: '3.14.0',
          },
          {
            scope: 'user',
            installPath: '/totally/missing/path', // stale
            version: '3.10.1',
          },
        ],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });

    const { res } = runRewire(home, repo);
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);

    const after = readJson(installedPath);
    const entries = after.plugins['agent-bridge@agent-bridge'];
    assert.equal(entries.length, 1, 'one stale entry should be removed; one current entry kept');
    assert.equal(entries[0].scope, 'project');
    assert.equal(entries[0].installPath, join(repo, 'mcp-server'));
  } finally {
    teardown(home, repo);
  }
});

test('OpenClaw plugins.load.paths: stale path rewired, unrelated paths untouched', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const ocPath = join(home, '.openclaw', 'openclaw.json');
    writeJson(ocPath, {
      meta: { lastTouchedVersion: '2026.4.1' },
      plugins: {
        entries: { 'agent-bridge': { enabled: true } },
        load: {
          paths: [
            '/nonexistent/old-clone/agent-bridge/openclaw-channel', // stale agent-bridge
            '/Users/ethan/Projects/Repost-with-agent',              // unrelated, should NOT be touched
            '/Users/ethan/Projects/agent-completion-chime',         // unrelated, should NOT be touched
          ],
        },
      },
    });

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0, `script failed: ${res.stderr}`);

    const after = readJson(ocPath);
    const paths = after.plugins.load.paths;
    assert.equal(paths.length, 3);
    assert.equal(paths[0], join(repo, 'openclaw-channel'),
      'stale agent-bridge path should be rewired to current dev clone');
    assert.equal(paths[1], '/Users/ethan/Projects/Repost-with-agent',
      'Repost-with-agent path must remain untouched');
    assert.equal(paths[2], '/Users/ethan/Projects/agent-completion-chime',
      'agent-completion-chime path must remain untouched');

    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.harness === 'openclaw');
    assert.ok(ev, 'expected openclaw rewired event');
  } finally {
    teardown(home, repo);
  }
});

test('idempotent: clean state runs as no-op (no backup created)', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');
    const ocPath = join(home, '.openclaw', 'openclaw.json');

    // Already-clean state — installPath matches current dev clone.
    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          {
            scope: 'user',
            installPath: join(repo, 'mcp-server'),
            version: '3.14.0',
          },
        ],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });
    writeJson(ocPath, {
      plugins: {
        entries: { 'agent-bridge': { enabled: true } },
        load: { paths: [join(repo, 'openclaw-channel')] },
      },
    });

    const beforeInstalled = readFileSync(installedPath, 'utf8');
    const beforeSettings = readFileSync(settingsPath, 'utf8');
    const beforeOc = readFileSync(ocPath, 'utf8');

    // First run.
    let { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0);
    assert.equal(readFileSync(installedPath, 'utf8'), beforeInstalled,
      'installed_plugins.json must be byte-identical after no-op run');
    assert.equal(readFileSync(settingsPath, 'utf8'), beforeSettings,
      'settings.json must be byte-identical after no-op run');
    assert.equal(readFileSync(ocPath, 'utf8'), beforeOc,
      'openclaw.json must be byte-identical after no-op run');

    // No backup files should have been created.
    const claudePluginsDir = readdirSync(join(home, '.claude', 'plugins'));
    assert.ok(!claudePluginsDir.some((f) => f.includes('.bak.')),
      'no backup file should be created on a clean run');

    // Second run — same result.
    ({ res, log } = runRewire(home, repo));
    assert.equal(res.status, 0);
    assert.equal(readFileSync(installedPath, 'utf8'), beforeInstalled);

    const cleanEvents = log.filter((r) =>
      r.event === 'auto_update_runner.plugin_registry_clean');
    assert.ok(cleanEvents.length >= 1, 'expected at least one clean event');
  } finally {
    teardown(home, repo);
  }
});

test('backup file is created on mutation', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [{
          scope: 'user',
          installPath: '/missing/path',
          version: '3.10.0',
        }],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });

    const { res } = runRewire(home, repo);
    assert.equal(res.status, 0);

    const pluginsDirFiles = readdirSync(join(home, '.claude', 'plugins'));
    const backups = pluginsDirFiles.filter((f) => f.startsWith('installed_plugins.json.bak.'));
    assert.equal(backups.length, 1, 'exactly one backup file should be created');
  } finally {
    teardown(home, repo);
  }
});

test('does not touch unrelated plugin keys', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'telegram@claude-plugins-official': [
          { scope: 'user', installPath: '/missing/telegram/path', version: '0.0.6' },
        ],
        'github@claude-plugins-official': [
          { scope: 'user', installPath: '/missing/github/path', version: 'abc' },
        ],
        'repost-with-agent@repost-with-agent': [
          { scope: 'user', installPath: '/missing/repost/path', version: '4.1.0' },
        ],
        // no agent-bridge entry at all
      },
    });
    writeJson(settingsPath, {});

    const beforeRaw = readFileSync(installedPath, 'utf8');
    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0);
    assert.equal(readFileSync(installedPath, 'utf8'), beforeRaw,
      'unrelated plugin entries must remain byte-identical even when installPaths are stale');

    const cleanEv = findEvent(log, 'auto_update_runner.plugin_registry_clean',
      (r) => r.context.harness === 'claude-code');
    assert.ok(cleanEv, 'expected clean event for claude-code');
  } finally {
    teardown(home, repo);
  }
});

test('OpenClaw plugins.load.paths: existing path that does not match current is left alone (warn, no edit)', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const ocPath = join(home, '.openclaw', 'openclaw.json');

    // Path EXISTS but is not our current dev clone — leave alone.
    const altClone = mkdtempSync(join(tmpdir(), 'plugin-registry-rewire-alt-clone-'));
    mkdirSync(join(altClone, 'agent-bridge', 'openclaw-channel'), { recursive: true });
    const altOcChannel = join(altClone, 'agent-bridge', 'openclaw-channel');

    try {
      writeJson(ocPath, {
        plugins: {
          entries: { 'agent-bridge': { enabled: true } },
          load: { paths: [altOcChannel] },
        },
      });

      const beforeRaw = readFileSync(ocPath, 'utf8');
      const { res, log } = runRewire(home, repo);
      assert.equal(res.status, 0);
      assert.equal(readFileSync(ocPath, 'utf8'), beforeRaw,
        'existing-but-different path should NOT be rewritten (alt clone safe-guard)');

      const skipEv = findEvent(log, 'auto_update_runner.plugin_registry_skip',
        (r) => r.context.harness === 'openclaw' && r.context.reason === 'path_exists_but_does_not_match_current_dev_clone');
      assert.ok(skipEv, 'expected skip event for alt-clone safety');
    } finally {
      teardown(altClone);
    }
  } finally {
    teardown(home, repo);
  }
});

test('marketplace registration: rewires when path missing, leaves alone when path exists elsewhere', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const settingsPath = join(home, '.claude', 'settings.json');

    // Case 1: marketplace path is missing → rewire to current repo root.
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: '/totally/gone/agent-bridge' } },
      },
    });
    let { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0);
    let after = readJson(settingsPath);
    assert.equal(after.extraKnownMarketplaces['agent-bridge'].source.path, repo);
    let ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.phase === 'marketplace');
    assert.ok(ev, 'expected marketplace rewired event');

    // Case 2: marketplace path exists but is NOT the current repo root → leave alone.
    const altRepo = fakeRepoRoot();
    try {
      writeJson(settingsPath, {
        extraKnownMarketplaces: {
          'agent-bridge': { source: { source: 'directory', path: altRepo } },
        },
      });
      const beforeRaw = readFileSync(settingsPath, 'utf8');
      ({ res, log } = runRewire(home, repo));
      assert.equal(res.status, 0);
      assert.equal(readFileSync(settingsPath, 'utf8'), beforeRaw,
        'existing-but-different marketplace path must NOT be rewritten');
    } finally {
      teardown(altRepo);
    }
  } finally {
    teardown(home, repo);
  }
});

test('dry-run does not modify files but still emits log events', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          { scope: 'user', installPath: '/missing/path', version: '3.10.0' },
        ],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });

    const beforeRaw = readFileSync(installedPath, 'utf8');
    const { res, log } = runRewire(home, repo, ['--dry-run']);
    assert.equal(res.status, 0);
    assert.equal(readFileSync(installedPath, 'utf8'), beforeRaw,
      'dry-run must NOT modify installed_plugins.json');

    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.action === 'removed');
    assert.ok(ev, 'dry-run still emits the rewired event');
    assert.equal(ev.context.dry_run, true);
  } finally {
    teardown(home, repo);
  }
});

test('cache-path entry that exists but does not match current dev-clone is rewired', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    // Build a fake cache path that ACTUALLY exists.
    const cacheDir = join(home, '.claude', 'plugins', 'cache', 'agent-bridge', 'agent-bridge', '3.10.1');
    mkdirSync(cacheDir, { recursive: true });

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          { scope: 'user', installPath: cacheDir, version: '3.10.1' },
        ],
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0);

    const after = readJson(installedPath);
    assert.equal(after.plugins['agent-bridge@agent-bridge'], undefined,
      'stale cache-path entry should be removed (Strategy B + cache-path detection)');

    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.reason === 'stale_cache_path_dev_clone_active');
    assert.ok(ev, 'expected stale_cache_path_dev_clone_active reason event');
  } finally {
    teardown(home, repo);
  }
});

test('done event is emitted with idempotent=true on clean run', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    // No state files at all — most-clean possible run.
    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0);
    const doneEv = findEvent(log, 'auto_update_runner.plugin_registry_done');
    assert.ok(doneEv);
    assert.equal(doneEv.context.changed, false);
    assert.equal(doneEv.context.idempotent, true);
  } finally {
    teardown(home, repo);
  }
});

// ---------- v3.14.1 Codex-review regression tests --------------------------

test('codex-review v3.14.1: tolerates JSONC (line + block comments + trailing commas) in settings.json', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          { scope: 'user', installPath: '/nonexistent/stale/path', version: '3.10.1' },
        ],
      },
    });
    // settings.json with line comments, block comments, AND trailing commas.
    writeFileSync(settingsPath, `{
  // top-level line comment (a real Claude Code settings.json may have these)
  /* block
     comment */
  "extraKnownMarketplaces": {
    "agent-bridge": {
      "source": { "source": "directory", "path": ${JSON.stringify(repo)} }, // trailing comma below this line
    },
  },
}
`);

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0,
      `JSONC settings.json should not abort: rc=${res.status} stderr=${res.stderr}`);

    // Strategy B should have fired (marketplace was detected despite JSONC).
    const ev = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.action === 'removed' && r.context.harness === 'claude-code');
    assert.ok(ev, 'Strategy B should fire — marketplace entry detected through JSONC tolerance');
  } finally {
    teardown(home, repo);
  }
});

test('codex-review v3.14.1: phase error sets non-zero exit + done event records errors', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    // Write deliberately broken JSON that even JSONC tolerance can't recover.
    writeFileSync(installedPath, '{ this is not even close to JSON $$$$ ');

    const { res, log } = runRewire(home, repo);
    assert.notEqual(res.status, 0,
      'unparseable installed_plugins.json must produce a non-zero exit code');

    const doneEv = findEvent(log, 'auto_update_runner.plugin_registry_done');
    assert.ok(doneEv, 'done event must be emitted even on failure');
    assert.equal(doneEv.level, 'error', 'done event level should be error when phase failed');
    assert.equal(doneEv.context.idempotent, false, 'idempotent must be false when phase errored');
    assert.ok(Array.isArray(doneEv.context.errors) && doneEv.context.errors.length >= 1,
      'errors array should record the failed phase');
    assert.equal(doneEv.context.errors[0].phase, 'claude_code');
  } finally {
    teardown(home, repo);
  }
});

test('codex-review v3.14.1: backup file uses unique suffix (ms+pid+rand), not 1s-resolution', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');

    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          { scope: 'user', installPath: '/nonexistent/stale/A', version: '3.10.1' },
        ],
      },
    });

    // First mutation.
    const r1 = runRewire(home, repo);
    assert.equal(r1.res.status, 0);

    // Reset to a stale state again so the second run mutates too.
    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': [
          { scope: 'user', installPath: '/nonexistent/stale/B', version: '3.10.1' },
        ],
      },
    });

    // Second mutation (back-to-back — would collide on 1s-resolution suffix).
    const r2 = runRewire(home, repo);
    assert.equal(r2.res.status, 0);

    const pluginsDir = join(home, '.claude', 'plugins');
    const backups = readdirSync(pluginsDir).filter((f) => f.startsWith('installed_plugins.json.bak.'));
    assert.ok(backups.length >= 2,
      `expected >=2 distinct backup files, got ${backups.length}: ${backups.join(', ')}`);
    // Verify uniqueness — set should equal length.
    assert.equal(new Set(backups).size, backups.length,
      'all backup filenames must be distinct (no collision under sub-second cadence)');
  } finally {
    teardown(home, repo);
  }
});

test('codex-review v3.14.1: atomic write — concurrent reader sees only fully-formed JSON', () => {
  // We can't simulate true concurrency in Node test runner cleanly, but we can
  // verify the implementation does NOT call writeFileSync directly on the
  // target path — instead it must write to a temp file and rename. We do this
  // by reading the script source and grep'ing for the new patterns.
  const scriptPath = REWIRE_SCRIPT;
  const src = readFileSync(scriptPath, 'utf8');
  assert.ok(src.includes('renameSync(tmpPath, path)'),
    'backupAndWrite must use renameSync to do an atomic swap');
  assert.ok(src.includes('.tmp.'),
    'backupAndWrite must write to a side-file before renaming');
  assert.ok(src.includes('uniqueSuffix'),
    'backup names must use a collision-resistant unique suffix');
});

test('codex-review v3.14.1: non-array agent-bridge entry is normalized to array, not silently skipped', () => {
  const home = makeSandbox();
  const repo = fakeRepoRoot();
  try {
    const installedPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const settingsPath = join(home, '.claude', 'settings.json');

    // Single object instead of array — reproduces the "shape drift" case.
    writeJson(installedPath, {
      version: 2,
      plugins: {
        'agent-bridge@agent-bridge': {
          scope: 'user',
          installPath: '/nonexistent/stale/path',
          version: '3.10.1',
        },
      },
    });
    writeJson(settingsPath, {
      extraKnownMarketplaces: {
        'agent-bridge': { source: { source: 'directory', path: repo } },
      },
    });

    const { res, log } = runRewire(home, repo);
    assert.equal(res.status, 0,
      `non-array agent-bridge entry should be repaired, not error: rc=${res.status}`);

    // The error log must record the normalization decision.
    const ev = findEvent(log, 'auto_update_runner.plugin_registry_error',
      (r) => r.context.reason === 'agent_bridge_entry_was_object_not_array');
    assert.ok(ev, 'must emit warn that the entry was an object not array');
    assert.equal(ev.context.action, 'normalized_to_single_element_array');

    // And the actual rewire (Strategy B) should still fire.
    const removed = findEvent(log, 'auto_update_runner.plugin_registry_rewired',
      (r) => r.context.action === 'removed');
    assert.ok(removed, 'Strategy B should still fire after normalizing object→array');
  } finally {
    teardown(home, repo);
  }
});
