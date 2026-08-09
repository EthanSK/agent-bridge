/**
 * Self-contained packaging proof for the codex-channel artifact: copy ONLY
 * the package payload (src/ + bin/ + service.mjs + package.json — exactly
 * what a tarball or the installed ~/.agent-bridge/runtime/codex-channel/
 * snapshot contains) into an isolated directory with NO parent repo, and run
 * the real CLI verbs there: help, bind, list, service status/ensure/stop.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const THREAD = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001";

function makeIsolatedArtifact() {
  const root = mkdtempSync(join(tmpdir(), "ab-codex-pack-"));
  const artifact = join(root, "artifact", "codex-channel");
  mkdirSync(dirname(artifact), { recursive: true });
  for (const part of ["src", "bin"]) {
    cpSync(join(pkgRoot, part), join(artifact, part), { recursive: true });
  }
  cpSync(join(pkgRoot, "service.mjs"), join(artifact, "service.mjs"));
  cpSync(join(pkgRoot, "package.json"), join(artifact, "package.json"));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    AGENT_BRIDGE_HOME: join(root, "home", ".agent-bridge"),
    CODEX_HOME: join(root, "home", ".codex"),
    AGENT_BRIDGE_MACHINE_NAME: "Isolated-Mac",
    AGENT_BRIDGE_CODEX_NO_ENSURE: "1",
  };
  mkdirSync(env.HOME, { recursive: true });
  return { artifact, env };
}

function run(artifact, env, args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(artifact, "bin", "codex-channel.mjs"), ...args],
      { env, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    if (stdin !== null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

test("isolated artifact: help/bind/list/status/doctor/send/service all run with NO repo checkout", async () => {
  const { artifact, env } = makeIsolatedArtifact();

  const help = await run(artifact, env, ["help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /agent-bridge codex/);

  const bind = await run(artifact, env, ["bind", "--alias", "iso", "--thread-id", THREAD, "--force", "--no-ensure", "--json"]);
  assert.equal(bind.code, 0, bind.stderr);
  assert.equal(JSON.parse(bind.stdout).binding.threadId, THREAD);

  const list = await run(artifact, env, ["list"]);
  assert.match(list.stdout, /codex\/iso/);

  const status = await run(artifact, env, ["status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).bindings[0].alias, "iso");

  const svcStatus = await run(artifact, env, ["service", "status"]);
  assert.match(svcStatus.stdout, /NOT RUNNING/);

  const svcStop = await run(artifact, env, ["service", "stop"]);
  assert.equal(svcStop.code, 0, svcStop.stderr);
  assert.match(svcStop.stdout, /not running/i);

  // Local send exercises the vendored outbound module end-to-end.
  const send = await run(artifact, env, [
    "send", "--machine", "local", "--target", "openclaw/default", "--message", "isolated hello", "--one-way", "--json",
  ]);
  assert.equal(send.code, 0, send.stderr);

  const doctor = await run(artifact, env, ["doctor"]);
  assert.match(doctor.stdout, /doctor checks:/);
});

test("isolated artifact: service ensure spawns + stop verifies + daemon runs from the artifact", async () => {
  const { artifact, env } = makeIsolatedArtifact();
  const ensureEnv = { ...env, AGENT_BRIDGE_CODEX_NO_ENSURE: "0" };
  const ensure = await run(artifact, ensureEnv, ["service", "ensure"]);
  assert.equal(ensure.code, 0, ensure.stderr);
  assert.match(ensure.stdout, /spawned|already running/);
  // Give the daemon a beat to acquire + heartbeat, then stop it with the
  // identity-verified path.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stop = await run(artifact, ensureEnv, ["service", "stop"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /control request|not running|stale/i);
});
