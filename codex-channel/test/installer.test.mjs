/**
 * Hermetic Unix installer lifecycle proof: run the REAL install.sh against a
 * temporary writable install dir + a local file:// fixture (no sudo, no
 * network, no live paths), then drive the INSTALLED `agent-bridge codex`
 * verbs — help, bind, service ensure, service stop — with NO source checkout
 * anywhere near the installed layout.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";

function which(cmd) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", `command -v ${cmd}`], (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

function run(cmd, args, env, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test("install.sh -> installed agent-bridge codex help/bind/service ensure/stop, with no checkout", async (t) => {
  if (process.platform === "win32") { t.skip("Unix installer test"); return; }
  if (!(await which("bash")) || !(await which("curl"))) { t.skip("bash/curl unavailable"); return; }

  const root = mkdtempSync(join(tmpdir(), "ab-installer-"));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const fixture = join(root, "fixture");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  // file:// fixture serving exactly what install.sh fetches.
  cpSync(join(repoRoot, "agent-bridge"), join(fixture, "agent-bridge"));
  cpSync(join(repoRoot, "scripts", "plugin-registry-rewire.mjs"), join(fixture, "scripts", "plugin-registry-rewire.mjs"));
  // Local runtime source (skips fetch+tar) — a copy, so the repo is never
  // touched by the installer.
  const runtimeSrc = join(fixture, "codex-channel");
  cpSync(join(repoRoot, "codex-channel"), runtimeSrc, {
    recursive: true,
    filter: (src) => !src.includes(`${join("codex-channel", "test")}`),
  });

  const installEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_BRIDGE_INSTALL_DIR: binDir,
    AGENT_BRIDGE_REPO_BASE: pathToFileURL(fixture).href,
    AGENT_BRIDGE_RUNTIME_SRC_DIR: runtimeSrc,
  };
  mkdirSync(binDir, { recursive: true });
  const install = await run("bash", [join(repoRoot, "install.sh")], installEnv);
  assert.equal(install.code, 0, `install.sh failed: ${install.stderr}\n${install.stdout}`);
  assert.match(install.stdout, /codex-channel runtime installed/);
  assert.ok(existsSync(join(binDir, "agent-bridge")), "CLI installed");
  assert.ok(existsSync(join(home, ".agent-bridge", "runtime", "codex-channel", "bin", "codex-channel.mjs")),
    "self-contained runtime installed under the bridge home");

  // Drive the INSTALLED CLI. No repo checkout is reachable from binDir; the
  // codex dispatcher must resolve the installed runtime via CONFIG_DIR.
  const cli = join(binDir, "agent-bridge");
  const cliEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CODEX_THREAD_ID: THREAD,
    AGENT_BRIDGE_MACHINE_NAME: "Installed-Mac",
  };

  const help = await run(cli, ["codex", "help"], cliEnv);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /agent-bridge codex/);

  const bind = await run(cli, ["codex", "bind", "--alias", "installed", "--force", "--no-ensure", "--json"], cliEnv);
  assert.equal(bind.code, 0, bind.stderr);
  assert.equal(JSON.parse(bind.stdout).binding.threadId, THREAD);

  const ensure = await run(cli, ["codex", "service", "ensure"], cliEnv);
  assert.equal(ensure.code, 0, ensure.stderr);
  assert.match(ensure.stdout, /spawned|already running/);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stop = await run(cli, ["codex", "service", "stop"], cliEnv);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /control request|not running|stale/i);
});

test("install.sh rejects cwd-dependent AGENT_BRIDGE_HOME roots before installing", async (t) => {
  if (process.platform === "win32") { t.skip("Unix installer test"); return; }
  if (!(await which("bash"))) { t.skip("bash unavailable"); return; }
  const home = mkdtempSync(join(tmpdir(), "ab-installer-relative-home-"));
  for (const invalid of ["state", "../state", "C:state", "\\state", "\\\\server"]) {
    const result = await run("bash", [join(repoRoot, "install.sh")], {
      PATH: process.env.PATH,
      HOME: home,
      AGENT_BRIDGE_HOME: invalid,
    });
    assert.notEqual(result.code, 0, `relative root was accepted: ${invalid}`);
    assert.match(result.stderr, /must resolve to an absolute path/, invalid);
  }
});

test("install.sh normalizes AGENT_BRIDGE_HOME and auto-ensures for enabled bindings or pending journals", async (t) => {
  if (process.platform === "win32") { t.skip("Unix installer test"); return; }
  if (!(await which("bash")) || !(await which("curl"))) { t.skip("bash/curl unavailable"); return; }

  for (const recoverySignal of ["enabled-binding", "pending-journal"]) {
    const root = mkdtempSync(join(tmpdir(), `ab-installer-home-${recoverySignal}-`));
    const home = join(root, "profile");
    const overrideParent = recoverySignal === "enabled-binding"
      ? join(home, "custom-state-parent")
      : join(root, "custom-state-parent");
    const bridgeHome = join(overrideParent, ".agent-bridge");
    // Exercise both accepted override forms plus Windows-style tilde/trailing
    // separators, even when the Unix installer receives them.
    const override = recoverySignal === "enabled-binding"
      ? "~\\custom-state-parent\\"
      : `${bridgeHome}\\`;
    const binDir = join(root, "bin");
    const fixture = join(root, "fixture");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "agent-bridge"), join(fixture, "agent-bridge"));
    cpSync(join(repoRoot, "scripts", "plugin-registry-rewire.mjs"), join(fixture, "scripts", "plugin-registry-rewire.mjs"));
    const runtimeSrc = join(fixture, "codex-channel");
    cpSync(join(repoRoot, "codex-channel"), runtimeSrc, {
      recursive: true,
      filter: (src) => !src.includes(`${join("codex-channel", "test")}`),
    });

    if (recoverySignal === "enabled-binding") {
      const bindingsPath = join(bridgeHome, "codex", "bindings.json");
      mkdirSync(dirname(bindingsPath), { recursive: true });
      writeFileSync(bindingsPath, JSON.stringify({
        version: 1,
        bindings: {
          active: { alias: "active", threadId: THREAD, enabled: true, policy: {} },
        },
      }));
    } else {
      const journalPath = join(bridgeHome, "codex", "pending-settings", "removed.json");
      mkdirSync(dirname(journalPath), { recursive: true });
      writeFileSync(journalPath, JSON.stringify({
        version: 1,
        state: "resolved",
        token: "installer-journal",
        alias: "removed",
        threadId: THREAD,
        originalSettings: {},
        expectedOverrides: {},
      }));
    }

    const env = {
      PATH: process.env.PATH,
      HOME: home,
      AGENT_BRIDGE_HOME: override,
      AGENT_BRIDGE_INSTALL_DIR: binDir,
      AGENT_BRIDGE_REPO_BASE: pathToFileURL(fixture).href,
      AGENT_BRIDGE_RUNTIME_SRC_DIR: runtimeSrc,
      AGENT_BRIDGE_NO_PERIODIC_UPDATE: "1",
      CODEX_HOME: join(root, ".codex"),
      AGENT_BRIDGE_MACHINE_NAME: "Installed-Custom-Home",
    };
    mkdirSync(binDir, { recursive: true });
    const cli = join(binDir, "agent-bridge");

    try {
      const install = await run("bash", [join(repoRoot, "install.sh")], env);
      assert.equal(install.code, 0, `install.sh failed (${recoverySignal}): ${install.stderr}\n${install.stdout}`);
      assert.match(install.stdout, /service ensured from the installed runtime/);
      assert.ok(existsSync(join(bridgeHome, "runtime", "codex-channel", "bin", "codex-channel.mjs")),
        "runtime installed under normalized AGENT_BRIDGE_HOME");
      assert.equal(existsSync(join(home, ".agent-bridge", "runtime", "codex-channel")), false,
        "default HOME is not used when AGENT_BRIDGE_HOME is explicit");

      const help = await run(cli, ["codex", "help"], env);
      assert.equal(help.code, 0, help.stderr);
      const status = await run(cli, ["codex", "service", "status"], env);
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stdout, /RUNNING/, `${recoverySignal} must trigger automatic ensure`);
    } finally {
      // Identity-verified stop waits for the daemon heartbeat if necessary.
      await run(cli, ["codex", "service", "stop"], env);
    }
  }
});

test("install.sh honors AGENT_BRIDGE_CODEX_NO_ENSURE after installing the runtime", async (t) => {
  if (process.platform === "win32") { t.skip("Unix installer test"); return; }
  if (!(await which("bash")) || !(await which("curl"))) { t.skip("bash/curl unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "ab-installer-no-ensure-"));
  const home = join(root, "home");
  const bridgeHome = join(root, "state", ".agent-bridge");
  const fixture = join(root, "fixture");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "agent-bridge"), join(fixture, "agent-bridge"));
  cpSync(join(repoRoot, "scripts", "plugin-registry-rewire.mjs"), join(fixture, "scripts", "plugin-registry-rewire.mjs"));
  const runtimeSrc = join(fixture, "codex-channel");
  cpSync(join(repoRoot, "codex-channel"), runtimeSrc, { recursive: true });
  const bindingsPath = join(bridgeHome, "codex", "bindings.json");
  mkdirSync(dirname(bindingsPath), { recursive: true });
  writeFileSync(bindingsPath, JSON.stringify({
    version: 1,
    bindings: { active: { alias: "active", threadId: THREAD, enabled: true, policy: {} } },
  }));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_BRIDGE_HOME: bridgeHome,
    AGENT_BRIDGE_INSTALL_DIR: binDir,
    AGENT_BRIDGE_REPO_BASE: pathToFileURL(fixture).href,
    AGENT_BRIDGE_RUNTIME_SRC_DIR: runtimeSrc,
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
    AGENT_BRIDGE_NO_PERIODIC_UPDATE: "1",
  };
  mkdirSync(binDir, { recursive: true });
  const install = await run("bash", [join(repoRoot, "install.sh")], env);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /AGENT_BRIDGE_CODEX_NO_ENSURE=1/);
  const status = await run(join(binDir, "agent-bridge"), ["codex", "service", "status"], env);
  assert.match(status.stdout, /NOT RUNNING/);
});

test("install.sh: runtime failure is loudly actionable, install still succeeds", async (t) => {
  if (process.platform === "win32") { t.skip("Unix installer test"); return; }
  if (!(await which("bash")) || !(await which("curl"))) { t.skip("bash/curl unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "ab-installer-warn-"));
  const home = join(root, "home");
  const fixture = join(root, "fixture");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "agent-bridge"), join(fixture, "agent-bridge"));
  cpSync(join(repoRoot, "scripts", "plugin-registry-rewire.mjs"), join(fixture, "scripts", "plugin-registry-rewire.mjs"));
  const emptyRuntime = join(fixture, "empty-runtime");
  mkdirSync(emptyRuntime, { recursive: true });
  writeFileSync(join(emptyRuntime, "README.md"), "not a codex-channel package");

  const install = await run("bash", [join(repoRoot, "install.sh")], {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_BRIDGE_INSTALL_DIR: join(root, "bin"),
    AGENT_BRIDGE_REPO_BASE: pathToFileURL(fixture).href,
    AGENT_BRIDGE_RUNTIME_SRC_DIR: emptyRuntime,
  });
  assert.equal(install.code, 0, "CLI install itself still succeeds");
  assert.match(install.stdout, /\[warn\] Codex support NOT installed/);
  assert.match(install.stdout, /AGENT_BRIDGE_SOURCE_DIR/, "failure message is actionable");
  assert.ok(!existsSync(join(home, ".agent-bridge", "runtime", "codex-channel")), "no half-installed runtime");
});
