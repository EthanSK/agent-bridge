#!/usr/bin/env node
/**
 * agent-bridge codex-channel daemon entrypoint.
 *
 *   node codex-channel/service.mjs run       # foreground service loop
 *   node codex-channel/service.mjs --ensure  # spawn detached daemon if none
 *   node codex-channel/service.mjs stop      # request token-bound graceful stop
 *
 * Same daemon conventions as chime/service.mjs: single instance per machine
 * via ~/.agent-bridge/locks/codex-channel.lock.json, unified NDJSON logging
 * to ~/.agent-bridge/logs/agent-bridge.log (component: codex-channel).
 */

import { describeEnsureResult, ensureService, runService, stopService } from "./src/service.js";

const argv = process.argv.slice(2);
const verb = argv.find((a) => !a.startsWith("--")) ?? (argv.includes("--ensure") ? "ensure" : "run");

if (verb === "ensure" || argv.includes("--ensure")) {
  const result = await ensureService();
  const described = describeEnsureResult(result);
  const stream = described.ok ? process.stdout : process.stderr;
  stream.write(`${described.message}\n`);
  if (!described.ok) process.exitCode = 1;
} else if (verb === "stop") {
  // Identity-safe stop: after live-ownership proof, the daemon receives a
  // token-bound control request and releases itself normally. No PID signal.
  const result = await stopService();
  if (result.stopped) {
    process.stdout.write(`codex-channel service pid ${result.pid} stopped via verified control request\n`);
  } else if (result.reason === "not_running") {
    process.stdout.write("codex-channel service is not running\n");
  } else if (result.reason === "stale_lease_cleaned") {
    process.stdout.write("stale codex-channel lease cleaned up (no live daemon addressed)\n");
  } else {
    process.stderr.write(`stop failed: ${result.reason}\n`);
    process.exitCode = 1;
  }
} else if (verb === "run") {
  const foregroundMirror = process.stdout.isTTY ? (line) => process.stderr.write(`${line}\n`) : null;
  await runService({ mirror: foregroundMirror });
} else {
  process.stderr.write(`unknown verb "${verb}" (expected: run | ensure | stop)\n`);
  process.exitCode = 2;
}
