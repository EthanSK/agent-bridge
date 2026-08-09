// mcp-server/test/install-periodic-update.test.mjs
// -------------------------------------------------
// [PERIODIC-UPDATE 2026-05-04]
//
// Tests for the bundled harness-INDEPENDENT periodic auto-updater:
//   scripts/agent-bridge-periodic-update.sh    (macOS / Linux body)
//   scripts/agent-bridge-periodic-update.ps1   (Windows body)
//   scripts/install-periodic-update.sh         (macOS provisioner)
//   scripts/install-periodic-update.ps1        (Windows provisioner)
//
// We don't actually exercise launchd or Get-ScheduledTask in CI — that would
// require platform-specific privileges and would mutate the host. Instead the
// tests:
//   1. Lint the macOS body script with `bash -n` (syntax) and confirm the
//      expected key blocks exist (lock, fetch, build-when-needed,
//      registry-rewire, optional OC repair).
//   2. Lint the Windows body with PowerShell tokenizer if pwsh is available;
//      otherwise smoke-check structural markers.
//   3. Lint install-periodic-update.sh and assert the generated plist (when
//      we run the script in a sandbox HOME with a stub launchctl) is valid
//      XML, contains the right Label, StartInterval=600, and points at the
//      correct body script. Also asserts idempotent re-run leaves a single
//      plist.
//   4. Smoke-check install-periodic-update.ps1 structurally (Register-
//      ScheduledTask call, 10-min RepetitionInterval, AtLogOn trigger).
//
// All tests are gated to skip on platforms that can't run them.

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
  chmodSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scripts/ lives at <repo-root>/scripts/. Test file at <repo-root>/mcp-server/test/.
const REPO_ROOT = resolve(__dirname, '..', '..');
const BODY_SH = join(REPO_ROOT, 'scripts', 'agent-bridge-periodic-update.sh');
const BODY_PS1 = join(REPO_ROOT, 'scripts', 'agent-bridge-periodic-update.ps1');
const INSTALL_SH = join(REPO_ROOT, 'scripts', 'install-periodic-update.sh');
const INSTALL_PS1 = join(REPO_ROOT, 'scripts', 'install-periodic-update.ps1');

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';
const hasBash = !isWindows;  // Git-Bash on Windows would also work, but skipping for CI simplicity.

function findPowerShell() {
  const candidates = isWindows ? ['pwsh', 'powershell.exe'] : ['pwsh'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$null'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const powerShell = findPowerShell();

function teardown(...paths) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function extractPowerShellFunction(source, name) {
  const start = source.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `missing PowerShell function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated PowerShell function ${name}`);
}

// ---------- 1. macOS body syntax + structural checks -----------------------

test('agent-bridge-periodic-update.sh: bash syntax is valid', { skip: !hasBash }, () => {
  assert.ok(existsSync(BODY_SH), `body script missing: ${BODY_SH}`);
  const res = spawnSync('bash', ['-n', BODY_SH], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test('agent-bridge-periodic-update.sh: contains expected blocks', () => {
  const src = readFileSync(BODY_SH, 'utf8');
  // Lock + repo guard
  assert.match(src, /mkdir "\$LOCK_DIR"/, 'missing lock directory creation');
  assert.match(src, /\$REPO\/\.git/, 'missing .git guard');
  // Step 1: fetch
  assert.match(src, /git fetch origin --prune/, 'missing git fetch step');
  // Step 2: pull (clean only)
  assert.match(src, /git pull --ff-only origin main/, 'missing git pull step');
  assert.match(src, /dirty=1/, 'missing dirty-tree detection');
  // Step 3: build-when-needed
  assert.match(src, /npm install && npm run build/, 'missing build step');
  assert.match(src, /BUILT_HEAD_FILE/, 'missing built-head sentinel');
  // Step 4: registry rewire
  assert.match(src, /plugin-registry-rewire/, 'missing plugin-registry-rewire call');
  // Step 5 (optional): OC MCP repair
  assert.match(src, /WITH_OPENCLAW_MCP_REPAIR/, 'missing OpenClaw MCP repair flag');
  assert.match(src, /openclaw mcp set agent-bridge/, 'missing OpenClaw MCP set call');
  // Step 7 (4.10.0): codex-channel service refresh, gated on bindings registry
  assert.match(src, /codex-channel\/service\.mjs" --ensure/, 'missing codex-channel service ensure step');
  assert.match(src, /codex\/bindings\.json/, 'codex ensure must be gated on the bindings registry');
  assert.match(src, /codex\/pending-settings/, 'pending settings journals must also trigger recovery');
  assert.match(src, /AGENT_BRIDGE_CODEX_NO_ENSURE/, 'persistent no-ensure policy must win');
  assert.match(src, /BRIDGE_HOME="\$\(resolve_bridge_home\)"/, 'periodic paths must normalize AGENT_BRIDGE_HOME');
  // Log path
  assert.match(src, /\.agent-bridge\/logs\/periodic-update\.log/, 'missing log path');
});

test('agent-bridge-periodic-update.sh: recovery-work gate honors enabled bindings, journals, custom home, and NO_ENSURE', { skip: !hasBash }, () => {
  const root = mkdtempSync(join(tmpdir(), 'periodic-codex-gate-'));
  const home = join(root, 'profile');
  const overrideParent = join(root, 'custom-state-parent');
  const bridgeHome = join(overrideParent, '.agent-bridge');
  const fakeRepo = join(root, 'repo');
  const stubBin = join(home, 'bin');
  const serviceCalls = join(root, 'service-calls.log');
  const head = '1111111111111111111111111111111111111111';
  mkdirSync(join(fakeRepo, '.git'), { recursive: true });
  mkdirSync(join(fakeRepo, 'mcp-server', 'build'), { recursive: true });
  mkdirSync(join(fakeRepo, 'codex-channel'), { recursive: true });
  mkdirSync(join(bridgeHome, 'codex'), { recursive: true });
  mkdirSync(join(bridgeHome, 'state'), { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(fakeRepo, 'mcp-server', 'build', 'index.js'), '');
  writeFileSync(join(fakeRepo, 'mcp-server', 'package.json'), '{"version":"4.10.0"}\n');
  writeFileSync(join(fakeRepo, 'codex-channel', 'service.mjs'), '');
  writeFileSync(join(bridgeHome, 'state', 'built-head.txt'), `${head}\n`);

  // The updater prepends $HOME/bin to PATH. Keep inline `node -e` / `node -p`
  // real, but record service ensures instead of spawning a daemon.
  writeFileSync(join(stubBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == "-e" || "\${1:-}" == "-p" ]]; then exec "$REAL_NODE" "$@"; fi
if [[ "\${1:-}" == */codex-channel/service.mjs && "\${2:-}" == "--ensure" ]]; then
  printf 'ensure\\n' >> "$SERVICE_CALL_LOG"
  exit 0
fi
exec "$REAL_NODE" "$@"
`);
  writeFileSync(join(stubBin, 'git'), `#!/bin/bash
case "\${1:-}" in
  rev-parse) printf '${head}\\n' ;;
  fetch|pull|diff|ls-files) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(stubBin, 'node'), 0o755);
  chmodSync(join(stubBin, 'git'), 0o755);

  const bindingsPath = join(bridgeHome, 'codex', 'bindings.json');
  const pendingDir = join(bridgeHome, 'codex', 'pending-settings');
  const baseEnv = {
    ...process.env,
    HOME: home,
    AGENT_BRIDGE_HOME: overrideParent, // parent form must normalize to bridgeHome
    AGENT_BRIDGE_REPO: fakeRepo,
    AGENT_BRIDGE_MACHINE_NAME: 'Periodic-Test',
    REAL_NODE: process.execPath,
    SERVICE_CALL_LOG: serviceCalls,
  };
  const runBody = (extraEnv = {}) => spawnSync('/bin/bash', [BODY_SH, '--skip-oc-restart'], {
    env: { ...baseEnv, ...extraEnv },
    encoding: 'utf8',
  });

  try {
    writeFileSync(bindingsPath, JSON.stringify({ bindings: { paused: { enabled: false } } }));
    let res = runBody();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(serviceCalls), false, 'all-disabled registry alone must not ensure');

    writeFileSync(bindingsPath, JSON.stringify({ bindings: { active: { enabled: true } } }));
    res = runBody();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(serviceCalls, 'utf8'), 'ensure\n', 'enabled binding triggers ensure');

    rmSync(serviceCalls, { force: true });
    writeFileSync(bindingsPath, JSON.stringify({ bindings: {} }));
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, 'removed.json'), '{}\n');
    res = runBody();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(serviceCalls, 'utf8'), 'ensure\n', 'journal-only recovery triggers ensure');

    rmSync(serviceCalls, { force: true });
    res = runBody({ AGENT_BRIDGE_CODEX_NO_ENSURE: '1' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(serviceCalls), false, 'NO_ENSURE wins over pending recovery work');
    assert.ok(existsSync(join(bridgeHome, 'logs', 'periodic-update.log')),
      'parent-form AGENT_BRIDGE_HOME is normalized for updater state and logs');
    assert.equal(existsSync(join(overrideParent, 'logs')), false,
      'updater never treats the parent form itself as the state dir');
  } finally {
    teardown(root);
  }
});

test('Unix updater/provisioner reject cwd-dependent AGENT_BRIDGE_HOME roots', { skip: !hasBash }, () => {
  const home = mkdtempSync(join(tmpdir(), 'periodic-relative-home-'));
  try {
    for (const invalid of ['state', '../state', 'C:state', '\\state', '\\\\server']) {
      for (const script of [BODY_SH, INSTALL_SH]) {
        const args = script === BODY_SH ? [script, '--skip-oc-restart'] : [script];
        const res = spawnSync('/bin/bash', args, {
          env: { ...process.env, HOME: home, AGENT_BRIDGE_HOME: invalid },
          encoding: 'utf8',
        });
        assert.notEqual(res.status, 0, `${script} accepted ${invalid}`);
        assert.match(res.stderr, /must resolve to an absolute path/, `${script}: ${invalid}`);
      }
    }
  } finally {
    teardown(home);
  }
});

// ---------- 2. Windows body structural checks ------------------------------

test('PowerShell installers/updater: parser accepts every script', { skip: !powerShell }, () => {
  for (const path of [join(REPO_ROOT, 'install.ps1'), BODY_PS1, INSTALL_PS1]) {
    const escaped = path.replaceAll("'", "''");
    const command = `$tokens=$null; $errors=$null; `
      + `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors); `
      + `if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`;
    const res = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${path} failed PowerShell parse: ${res.stderr}${res.stdout}`);
  }
});

test('PowerShell bridge-home matrix accepts fully qualified roots and rejects cwd-dependent roots', { skip: !isWindows || !powerShell }, () => {
  for (const path of [join(REPO_ROOT, 'install.ps1'), BODY_PS1, INSTALL_PS1]) {
    const source = readFileSync(path, 'utf8');
    const functions = [
      extractPowerShellFunction(source, 'Test-AgentBridgeAbsolutePath'),
      extractPowerShellFunction(source, 'Resolve-AgentBridgeHome'),
    ].join('\n\n');
    const command = `${functions}
$env:USERPROFILE = 'C:\\Users\\BridgeTest'
$accepted = @{
  'C:\\Bridge\\state\\' = 'C:\\Bridge\\state\\.agent-bridge'
  'C:\\Bridge\\.AGENT-BRIDGE\\' = 'C:\\Bridge\\.AGENT-BRIDGE'
  '~\\state\\' = 'C:\\Users\\BridgeTest\\state\\.agent-bridge'
  '\\\\server\\share\\state' = '\\\\server\\share\\state\\.agent-bridge'
}
foreach ($entry in $accepted.GetEnumerator()) {
  $env:AGENT_BRIDGE_HOME = $entry.Key
  $actual = Resolve-AgentBridgeHome
  if ($actual -cne $entry.Value) { throw "unexpected normalization: $($entry.Key) -> $actual" }
}
foreach ($value in @('state', '..\\state', 'C:state', '\\state', '\\\\server')) {
  $env:AGENT_BRIDGE_HOME = $value
  $rejected = $false
  try { $null = Resolve-AgentBridgeHome } catch { $rejected = $true }
  if (-not $rejected) { throw "relative root accepted: $value" }
}`;
    const res = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${path} normalization matrix failed: ${res.stderr}${res.stdout}`);
  }
});

test('agent-bridge-periodic-update.ps1: contains expected blocks', () => {
  assert.ok(existsSync(BODY_PS1), `body script missing: ${BODY_PS1}`);
  const src = readFileSync(BODY_PS1, 'utf8');
  assert.match(src, /WithOpenclawMcpRepair/, 'missing OC MCP repair param');
  assert.match(src, /git fetch origin --prune/, 'missing git fetch step');
  assert.match(src, /git pull --ff-only origin main/, 'missing git pull step');
  assert.match(src, /npm.*install/i, 'missing npm install step');
  assert.match(src, /npm.*run.*build/i, 'missing npm run build step');
  assert.match(src, /plugin-registry-rewire/, 'missing plugin-registry-rewire call');
  assert.match(src, /periodic-update\.log/, 'missing log path');
  assert.match(src, /periodic-update\.lock/, 'missing lock dir');
  // Step 6 (4.10.0): codex-channel service refresh, gated on recovery work
  assert.match(src, /codex-channel\\service\.mjs/, 'missing codex-channel service path');
  assert.match(src, /codex\\bindings\.json/, 'codex ensure must inspect the bindings registry under the resolved bridge home');
  assert.match(src, /codex\\pending-settings/, 'pending settings journals must also trigger recovery');
  assert.match(src, /AGENT_BRIDGE_CODEX_NO_ENSURE/, 'persistent no-ensure policy must win');
  assert.match(src, /Resolve-AgentBridgeHome/, 'periodic paths must normalize AGENT_BRIDGE_HOME');
  assert.match(src, /Test-AgentBridgeAbsolutePath/, 'periodic paths reject cwd-dependent bridge homes');
});

// ---------- 2b. Installer lifecycle structure (4.10.0 codex runtime) -------
// Behavioral Unix coverage lives in codex-channel/test/installer.test.mjs
// (runs the real install.sh hermetically). These structural checks pin the
// override surface + stage/swap/rollback + actionable failure wording on
// BOTH installers; Codex executes the Windows behavior on the fleet.

test('install.sh: hermetic overrides, stage-swap runtime install, actionable failure', () => {
  const src = readFileSync(join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.match(src, /AGENT_BRIDGE_INSTALL_DIR/, 'install dir override');
  assert.match(src, /AGENT_BRIDGE_REPO_BASE/, 'repo base override (file:// fixtures)');
  assert.match(src, /AGENT_BRIDGE_RUNTIME_SRC_DIR/, 'local runtime source override');
  assert.match(src, /AGENT_BRIDGE_RUNTIME_TARBALL_URL/, 'runtime tarball override');
  assert.match(src, /BRIDGE_HOME="\$\(resolve_bridge_home\)"/, 'runtime follows normalized AGENT_BRIDGE_HOME');
  assert.match(src, /codex-channel\.new/, 'staged install');
  assert.match(src, /codex-channel\.old/, 'swap keeps the previous runtime for rollback');
  assert.match(src, /\[warn\] Codex support NOT installed/, 'runtime failure is loud, not implied success');
  assert.match(src, /AGENT_BRIDGE_SOURCE_DIR/, 'failure message names the recovery lever');
  assert.match(src, /pending-settings/, 'journal-only recovery triggers ensure');
  assert.match(src, /AGENT_BRIDGE_CODEX_NO_ENSURE/, 'installer honors no-ensure policy');
});

test('install.ps1: stage-swap with rollback, LASTEXITCODE-safe periodic step, actionable failure', () => {
  const src = readFileSync(join(REPO_ROOT, 'install.ps1'), 'utf8');
  assert.match(src, /codex-channel\.new/, 'staged install');
  assert.match(src, /codex-channel\.old/, 'previous runtime kept for rollback');
  assert.match(src, /Move-Item -Path \$DestNew -Destination \$Dest/, 'atomic-ish swap via rename');
  assert.match(src, /\[warn\] Codex support NOT installed/, 'runtime failure is loud');
  assert.match(src, /AGENT_BRIDGE_SOURCE_DIR/, 'failure message names the recovery lever');
  assert.match(src, /Resolve-AgentBridgeHome/, 'runtime follows normalized AGENT_BRIDGE_HOME');
  assert.match(src, /Test-AgentBridgeAbsolutePath/, 'installer rejects cwd-dependent bridge homes');
  assert.match(src, /pending-settings/, 'journal-only recovery triggers ensure');
  assert.match(src, /AGENT_BRIDGE_CODEX_NO_ENSURE/, 'installer honors no-ensure policy');
  assert.match(src, /codex-channel\\service\.mjs'\) --ensure/, 'newly installed runtime is version-ensured after the swap');
  assert.match(src, /\$env:AGENT_BRIDGE_HOME = \$BridgeHome[\s\S]*codex-channel\\service\.mjs/, 'ensured runtime receives the normalized bridge home');
  assert.match(src, /\$PreviousBridgeHome[\s\S]*Remove-Item Env:AGENT_BRIDGE_HOME/, 'installer restores the caller process override after ensure');
  const periodic = readFileSync(BODY_PS1, 'utf8');
  assert.match(periodic, /\$LASTEXITCODE -eq 0[\s\S]*codex-channel service ensured/, 'native exit codes checked before logging success');
});

// ---------- 3. macOS provisioner: plist generation -------------------------

test('install-periodic-update.sh: bash syntax is valid', { skip: !hasBash }, () => {
  assert.ok(existsSync(INSTALL_SH), `provisioner missing: ${INSTALL_SH}`);
  const res = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test('install-periodic-update.sh: generates valid plist with correct fields (sandbox)', { skip: !isMac }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-install-test-'));
  const launchAgentsDir = join(sandboxHome, 'Library', 'LaunchAgents');
  mkdirSync(launchAgentsDir, { recursive: true });

  // Stub `launchctl` so the installer doesn't try to talk to real launchd.
  // We point PATH at a temp bin/ that exposes a no-op launchctl.
  const stubBin = mkdtempSync(join(tmpdir(), 'periodic-install-bin-'));
  writeFileSync(join(stubBin, 'launchctl'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(stubBin, 'launchctl'), 0o755);

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      AGENT_BRIDGE_HOME: join(sandboxHome, 'custom-bridge-parent'),
      AGENT_BRIDGE_CODEX_NO_ENSURE: '1',
      PATH: `${stubBin}:${process.env.PATH || ''}`,
    };
    const res = spawnSync('/bin/bash', [INSTALL_SH], { env, encoding: 'utf8' });
    assert.equal(res.status, 0, `installer exited non-zero: ${res.stderr}\n${res.stdout}`);

    const plistPath = join(launchAgentsDir, 'com.ethansk.agent-bridge.periodic-update.plist');
    assert.ok(existsSync(plistPath), `plist not written: ${plistPath}`);

    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /<\?xml version="1\.0"/, 'plist missing XML preamble');
    assert.match(plist, /<key>Label<\/key>\s*<string>com\.ethansk\.agent-bridge\.periodic-update<\/string>/, 'wrong Label');
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/, 'wrong StartInterval');
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/, 'missing RunAtLoad=true');
    assert.match(plist, new RegExp(`<string>${BODY_SH.replace(/[.\/]/g, '\\$&')}</string>`), 'plist missing body script path');
    assert.match(plist, /<key>WorkingDirectory<\/key>/, 'missing WorkingDirectory');
    assert.match(
      plist,
      new RegExp(`<key>AGENT_BRIDGE_HOME<\\/key>\\s*<string>${join(sandboxHome, 'custom-bridge-parent', '.agent-bridge').replace(/[.\/]/g, '\\$&')}<\\/string>`),
      'normalized AGENT_BRIDGE_HOME is preserved in the LaunchAgent',
    );
    assert.match(plist, /<key>AGENT_BRIDGE_CODEX_NO_ENSURE<\/key>\s*<string>1<\/string>/,
      'no-ensure policy is preserved in the LaunchAgent');

    // Validate XML via plutil.
    const plutilRes = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(plutilRes.status, 0, `plutil -lint failed: ${plutilRes.stdout}${plutilRes.stderr}`);

    // Idempotent re-run: still exactly one plist, still passes lint.
    const res2 = spawnSync('/bin/bash', [INSTALL_SH], { env, encoding: 'utf8' });
    assert.equal(res2.status, 0, `re-run failed: ${res2.stderr}`);
    const entries = readdirSync(launchAgentsDir).filter((f) => f.startsWith('com.ethansk.agent-bridge'));
    assert.equal(entries.length, 1, `expected exactly 1 plist after idempotent re-run, got ${entries.length}`);
    const plutilRes2 = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(plutilRes2.status, 0, `plutil -lint after re-run failed: ${plutilRes2.stdout}`);
  } finally {
    teardown(sandboxHome, stubBin);
  }
});

test('install-periodic-update.sh: --with-openclaw-mcp-repair propagates to plist', { skip: !isMac }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-install-test-'));
  mkdirSync(join(sandboxHome, 'Library', 'LaunchAgents'), { recursive: true });
  const stubBin = mkdtempSync(join(tmpdir(), 'periodic-install-bin-'));
  writeFileSync(join(stubBin, 'launchctl'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(stubBin, 'launchctl'), 0o755);

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      PATH: `${stubBin}:${process.env.PATH || ''}`,
    };
    const res = spawnSync('/bin/bash', [INSTALL_SH, '--with-openclaw-mcp-repair'], {
      env, encoding: 'utf8',
    });
    assert.equal(res.status, 0, `installer failed: ${res.stderr}\n${res.stdout}`);

    const plistPath = join(sandboxHome, 'Library', 'LaunchAgents', 'com.ethansk.agent-bridge.periodic-update.plist');
    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /<string>--with-openclaw-mcp-repair<\/string>/, 'plist did not include OC MCP repair flag');
  } finally {
    teardown(sandboxHome, stubBin);
  }
});

// ---------- 4. Windows provisioner structural checks -----------------------

test('install-periodic-update.ps1: structural markers present', () => {
  assert.ok(existsSync(INSTALL_PS1), `provisioner missing: ${INSTALL_PS1}`);
  const src = readFileSync(INSTALL_PS1, 'utf8');
  assert.match(src, /Register-ScheduledTask/, 'missing Register-ScheduledTask call');
  assert.match(src, /Unregister-ScheduledTask/, 'missing Unregister-ScheduledTask (idempotency)');
  assert.match(src, /AgentBridge Periodic Update/, 'missing task name');
  assert.match(src, /New-TimeSpan -Minutes 10/, 'missing 10-min interval');
  assert.match(src, /AtLogOn/, 'missing logon trigger');
  assert.match(src, /WithOpenclawMcpRepair/, 'missing OC MCP repair switch param');
  assert.match(src, /AgentBridgeHome/, 'custom bridge home forwarded to task body');
  assert.match(src, /CodexNoEnsure/, 'no-ensure policy forwarded to task body');
  assert.match(src, /Resolve-AgentBridgeHome/, 'provisioner normalizes bridge home');
  assert.match(src, /Test-AgentBridgeAbsolutePath/, 'provisioner rejects cwd-dependent bridge homes');
});

// ---------- 5. Stale-lock reclaim behaviour --------------------------------

test('agent-bridge-periodic-update.sh: reclaims stale lock with dead pid', { skip: !hasBash }, () => {
  // We can't run the full body (it would actually `git fetch` against the
  // real repo), but we CAN test the lock-reclaim logic in isolation by
  // sourcing the script with a guard that exits before the repo guard.
  //
  // Strategy: stage a sandbox HOME with a stale lock containing a definitely-
  // dead PID, run the body with AGENT_BRIDGE_REPO pointing at a non-git
  // directory (so it exits with rc=1 at the repo guard step AFTER the lock
  // logic ran), and verify the lock was reclaimed.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // PID 999999999 is virtually guaranteed to not exist (Linux limits PIDs to
  // <= 4 million; macOS similar).
  writeFileSync(join(lockDir, 'pid'), '999999999\n');

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));
  // Intentionally NOT a git repo — body will exit with the repo guard after
  // the lock reclaim path executes.

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      AGENT_BRIDGE_REPO: fakeRepo,
    };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    // Exits 1 at the repo-missing guard, but the human log should show the
    // stale-lock reclaim happened.
    assert.equal(res.status, 1, `expected rc=1 from repo guard, got ${res.status}: ${res.stderr}`);

    const logPath = join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log');
    assert.ok(existsSync(logPath), 'log file not created');
    const logContents = readFileSync(logPath, 'utf8');
    assert.match(logContents, /stale lock: pid=999999999 no longer alive; reclaiming/, 'lock reclaim log not emitted');
    assert.match(logContents, /ERROR: repo missing/, 'repo guard did not run after reclaim');
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: reclaims pid-less lock once aged past threshold', { skip: !hasBash }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // No `pid` file — orphan from an old version or interrupted write.
  // We use AGENT_BRIDGE_PERIODIC_STALE_LOCK_SEC=0 to make ANY age old enough
  // for reclaim — testing the orphan branch deterministically without
  // sleep().

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      AGENT_BRIDGE_REPO: fakeRepo,
      AGENT_BRIDGE_PERIODIC_STALE_LOCK_SEC: '0',
    };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    assert.equal(res.status, 1);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    assert.match(logContents, /stale lock: missing\/malformed pid file \(age \d+s\); reclaiming/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: pid-less lock that is FRESH is treated as contended', { skip: !hasBash }, () => {
  // Race-window protection: when a peer mkdir's the lock but hasn't yet
  // written the pid file, a second invocation must NOT reclaim it.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // Default stale threshold is 1800s; the freshly-created dir is 0s old.

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = { ...process.env, HOME: sandboxHome, AGENT_BRIDGE_REPO: fakeRepo };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    // Should be a graceful skip (rc=0), NOT exit 1 from repo guard.
    assert.equal(res.status, 0, `expected graceful skip on contended pid-less lock, got rc=${res.status}: ${res.stderr}\n${res.stdout}`);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    assert.match(logContents, /already running \(lock (held by live previous invocation|contended)\)/);
    // Did NOT proceed to repo guard.
    assert.doesNotMatch(logContents, /ERROR: repo missing/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: live PID lock is NEVER reclaimed by age alone', { skip: !hasBash }, () => {
  // Codex review 0e763a3 round 2: a long-running legitimate update (slow
  // npm install) must not be evicted purely because the lock is old.
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'pid'), String(process.pid) + '\n');

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = {
      ...process.env,
      HOME: sandboxHome,
      AGENT_BRIDGE_REPO: fakeRepo,
      // Threshold=0 means "any age qualifies" — but live PID must STILL win.
      AGENT_BRIDGE_PERIODIC_STALE_LOCK_SEC: '0',
    };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    assert.equal(res.status, 0, `live PID must win over stale-age threshold, got rc=${res.status}: ${res.stdout}`);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    // Skip reason logged.
    assert.match(logContents, /already running \(lock (held by live previous invocation|contended)\)/);
    // Did NOT reclaim, did NOT proceed.
    assert.doesNotMatch(logContents, /reclaim/i);
    assert.doesNotMatch(logContents, /ERROR: repo missing/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});

test('agent-bridge-periodic-update.sh: skips when lock held by live pid', { skip: !hasBash }, () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'periodic-lock-test-'));
  const runDir = join(sandboxHome, '.agent-bridge', 'run');
  const lockDir = join(runDir, 'periodic-update.lock');
  mkdirSync(lockDir, { recursive: true });
  // Use the test process's own PID — guaranteed alive AND owned by the same
  // user (so `kill -0` works without privilege issues).
  writeFileSync(join(lockDir, 'pid'), String(process.pid) + '\n');

  const fakeRepo = mkdtempSync(join(tmpdir(), 'periodic-lock-fakerepo-'));

  try {
    const env = { ...process.env, HOME: sandboxHome, AGENT_BRIDGE_REPO: fakeRepo };
    const res = spawnSync('/bin/bash', [BODY_SH], { env, encoding: 'utf8' });
    // Should exit 0 (graceful skip), not 1 (repo guard didn't run).
    assert.equal(res.status, 0, `expected graceful skip (rc=0), got ${res.status}: ${res.stderr}\n${res.stdout}`);

    const logContents = readFileSync(join(sandboxHome, '.agent-bridge', 'logs', 'periodic-update.log'), 'utf8');
    assert.match(logContents, /already running \(lock held by live previous invocation\)/);
    // Confirm we did NOT proceed to repo guard.
    assert.doesNotMatch(logContents, /ERROR: repo missing/);
  } finally {
    teardown(sandboxHome, fakeRepo);
  }
});
