/**
 * 4.0.x — Orphan-suicide check tests.
 *
 * Separate from the 5s 3-poll orphan watchdog. The orphan-suicide check
 * fires every 30s after a 60s grace period and exits when `process.ppid`
 * is 1 (reparented to launchd/init), regardless of whether the captured
 * original parent PID is still considered "alive" by kill(0).
 *
 * Cases:
 *   1. Healthy child (ppid > 1) — interval fires, no exit.
 *   2. Orphaned child (mock ppid === 1) AFTER grace — exits cleanly with code 0.
 *   3. Orphaned child (mock ppid === 1) DURING grace — does NOT exit yet.
 *
 * Note: `process.ppid` is a getter, so we cannot reassign it. We override
 * it from inside a tiny preload script (see `ppidPreload`) that runs
 * before the MCP server entrypoint via `node --import` so the spawned
 * agent-bridge child sees ppid===1 as if launchd had adopted it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'build', 'index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(home, env = {}, extraArgs = []) {
  const child = spawn(process.execPath, [...extraArgs, indexPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_MACHINE_NAME: 'test-orphan-suicide',
      // Disable the OTHER parent-liveness paths so this test isolates the
      // orphan-suicide check. The 5s 3-poll watchdog and the parent-PID
      // probe both watch unrelated signals (kill(originalParentPid, 0),
      // stdin destroyed, lease takeover) and would otherwise terminate
      // the child before we can observe the suicide path.
      AGENT_BRIDGE_DISABLE_PARENT_CHECK: '1',
      AGENT_BRIDGE_DISABLE_ORPHAN_WATCHDOG: '1',
      AGENT_BRIDGE_PERSONA: '',
      // The orphan-suicide check is independently controlled via
      // AGENT_BRIDGE_DISABLE_ORPHAN_SUICIDE; disabling the 3-poll watchdog
      // above does NOT also disable suicide (intentional — they're separate
      // concerns and tests for the suicide path want it left active).
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.stdout.resume();
  return child;
}

async function readEvents(home) {
  const logFile = join(home, '.agent-bridge', 'logs', 'agent-bridge.log');
  try {
    const raw = await readFile(logFile, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Preload module that overrides `process.ppid` to 1.
//
// `mode === 'sync'`: override at module load time (BEFORE main() runs and
// BEFORE parentPid is captured). Simulates the legitimate
// init-parent-from-boot config (LaunchAgent / systemd / detached
// diagnostic run) where parentPid is 1 from startup — suicide must skip.
//
// `mode === 'deferred'`: override after `delayMs` ms. Simulates true
// reparenting: parentPid is captured as the real test-runner pid (>1)
// and only LATER does process.ppid flip to 1. Suicide must fire after
// the grace window.
//
// Default deferred delay: 300ms — comfortably after main()'s parentPid
// capture but well before any sane test grace period.
async function writePpidPreload(home, mode = 'deferred', delayMs = 300) {
  const preloadPath = join(home, 'ppid-preload.mjs');
  const body =
    mode === 'sync'
      ? 'Object.defineProperty(process, "ppid", { get: () => 1, configurable: true });\n'
      : `setTimeout(() => {\n` +
        `  Object.defineProperty(process, "ppid", { get: () => 1, configurable: true });\n` +
        `}, ${delayMs});\n`;
  await writeFile(preloadPath, body, 'utf8');
  return preloadPath;
}

test('source-level wiring is present in shipped build', async () => {
  const indexSrc = await readFile(indexPath, 'utf8');
  assert.ok(
    indexSrc.includes('ORPHAN_SUICIDE_INTERVAL_MS'),
    'ORPHAN_SUICIDE_INTERVAL_MS constant must exist',
  );
  assert.ok(
    indexSrc.includes('ORPHAN_SUICIDE_GRACE_MS'),
    'ORPHAN_SUICIDE_GRACE_MS constant must exist',
  );
  assert.ok(
    /30_000|30000/.test(indexSrc.match(/ORPHAN_SUICIDE_INTERVAL_MS[\s\S]{0,200}/)?.[0] ?? ''),
    'orphan suicide interval must default to 30s',
  );
  assert.ok(
    /60_000|60000/.test(indexSrc.match(/ORPHAN_SUICIDE_GRACE_MS[\s\S]{0,200}/)?.[0] ?? ''),
    'orphan suicide grace must default to 60s',
  );
  assert.ok(
    indexSrc.includes("event: 'orphan_suicide.detected'"),
    'orphan_suicide.detected log event must be wired',
  );
  assert.ok(
    indexSrc.includes('process.ppid === 1'),
    'orphan suicide must check process.ppid === 1',
  );
  assert.ok(
    /shutdown\(['"`]orphan-suicide:/.test(indexSrc),
    'orphan suicide must call shutdown() (clean lease release), not bare process.exit()',
  );
  assert.ok(
    /orphanSuicide\s*[:.]?\s*[A-Za-z.]*unref\(\)/.test(indexSrc),
    'orphan-suicide interval must be unref()ed',
  );
  // Codex P2 — init-parent-from-boot skip: if parentPid===1 at startup
  // (LaunchAgent / systemd / detached diagnostic run), suicide must
  // short-circuit without arming the interval.
  assert.ok(
    indexSrc.includes("event: 'orphan_suicide.skipped_init_parent'"),
    'orphan_suicide.skipped_init_parent log event must be wired',
  );
  // The skip gate must use STARTUP_PPID (module-load snapshot), NOT the
  // late parentPid capture inside main() — otherwise an MCP host that
  // dies during async startup would set parentPid=1 by the time the
  // gate runs and erroneously skip suicide on a true orphan.
  // Codex P2 round 3: STARTUP_PPID lives in its own dependency-free
  // bootstrap-ppid module imported FIRST in index.ts, so its body
  // executes before any other import (zod, MCP SDK) — the very
  // earliest user-code in the entrypoint graph.
  const bootstrapPath = join(__dirname, '..', 'build', 'bootstrap-ppid.js');
  const bootstrapSrc = await readFile(bootstrapPath, 'utf8');
  assert.ok(
    /STARTUP_PPID[^\n]*=\s*process\.ppid/.test(bootstrapSrc),
    'bootstrap-ppid.js must capture STARTUP_PPID = process.ppid at module body',
  );
  // It must be the FIRST import in index.ts so its body runs before any
  // other import body in the dependency graph.
  const firstImportLine = indexSrc.split('\n').find((l) => /^import\s+/.test(l));
  assert.ok(
    firstImportLine && /bootstrap-ppid/.test(firstImportLine),
    `first static import must be ./bootstrap-ppid for earliest-possible ppid capture — got: ${firstImportLine}`,
  );
  assert.ok(
    /STARTUP_PPID\s*===\s*1/.test(indexSrc),
    'orphan-suicide skip gate must guard on STARTUP_PPID === 1, not the late parentPid',
  );
});

test('case 1: healthy child (ppid > 1) does NOT exit', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-healthy-'));
  // Aggressive timing: grace=500ms, interval=500ms. With a real ppid
  // (parent === this test process) the suicide check must NEVER fire,
  // no matter how short the timing is.
  const server = startServer(home, {
    AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '500',
    AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '500',
  });
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(5_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `healthy child must remain alive — got ${JSON.stringify(exited)}`,
    );
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.equal(
      detected.length,
      0,
      `orphan_suicide.detected must NOT fire for healthy ppid — got: ${JSON.stringify(detected.map((d) => d.context))}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 2: orphaned child (ppid === 1) AFTER grace exits cleanly', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-after-'));
  const preloadPath = await writePpidPreload(home);
  // grace=1s, interval=500ms. After 1s the next interval tick (≤500ms
  // later) should detect ppid===1 and call shutdown().
  const server = startServer(
    home,
    {
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '500',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '1000',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(8_000).then(() => null),
    ]);
    assert.ok(
      exited !== null,
      'orphaned child (ppid=1) must exit after the grace period',
    );
    assert.equal(exited.code, 0, `orphan suicide must exit cleanly with code 0 — got ${JSON.stringify(exited)}`);
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.ok(
      detected.length >= 1,
      `orphan_suicide.detected must fire at least once — got events: ${JSON.stringify(events.map((e) => e.event))}`,
    );
    assert.equal(detected[0].context?.ppid, 1, 'logged ppid context must be 1');
    // Confirm the shutdown reason carries the orphan-suicide prefix.
    const shutdownEvent = events.find((e) => e.event === 'server.shutdown');
    assert.ok(
      shutdownEvent && /orphan-suicide/.test(shutdownEvent.context?.reason ?? ''),
      `server.shutdown reason must include orphan-suicide — got: ${JSON.stringify(shutdownEvent?.context)}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 5 (Codex P2 regression): parent dies during startup — late parentPid=1 must NOT mask true orphan', { timeout: 18_000 }, async () => {
  // Codex P2 follow-up. If the MCP host dies during the multi-await main()
  // startup window, `process.ppid` will already be 1 by the time main()
  // captures `parentPid`. The skip gate must NOT use that late capture,
  // because the process is genuinely orphaned. We use the module-load
  // snapshot `STARTUP_PPID` (sampled before any await) which still
  // reflects the real launch-time parent.
  //
  // We simulate this with a very-early deferred override (delay=5ms):
  // ppid stays as the real test-runner pid only for the synchronous
  // top-level capture of STARTUP_PPID, then flips to 1 well before
  // main()'s async `parentPid = process.ppid` runs. The late parentPid
  // observed in the orphan_suicide.detected event is therefore 1, but
  // STARTUP_PPID is the original test-runner pid > 1 — so suicide MUST
  // fire after the grace window.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-startup-die-'));
  const preloadPath = await writePpidPreload(home, 'deferred', 5);
  const server = startServer(
    home,
    {
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '500',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '1000',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(8_000).then(() => null),
    ]);
    assert.ok(exited !== null, 'true orphan must still exit even when late parentPid=1');
    assert.equal(exited.code, 0, `clean exit code expected — got ${JSON.stringify(exited)}`);
    const events = await readEvents(home);
    // The skip path must NOT have been taken (would have logged
    // orphan_suicide.skipped_init_parent and never armed the timer).
    const skipped = events.filter((e) => e.event === 'orphan_suicide.skipped_init_parent');
    assert.equal(
      skipped.length,
      0,
      `init-parent skip must NOT fire when STARTUP_PPID > 1 — got: ${JSON.stringify(skipped.map((s) => s.context))}`,
    );
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.ok(detected.length >= 1, 'orphan_suicide.detected must fire on true orphan');
    // STARTUP_PPID logged in the event must be > 1 (the genuine
    // launch-time parent), proving the gate did not depend on the
    // late `parentPid` capture which by this point is 1.
    assert.ok(
      typeof detected[0].context?.startupPpid === 'number' && detected[0].context.startupPpid > 1,
      `startupPpid in detected event must be the real parent (>1) — got: ${JSON.stringify(detected[0].context)}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 4: init-parent-from-boot (ppid === 1 at startup) skips suicide entirely', { timeout: 12_000 }, async () => {
  // Codex P2 fix: when the MCP child is started directly under launchd,
  // systemd, or a container with PID 1 as its parent (LaunchAgent wrapper,
  // detached diagnostic run, etc.), `parentPid` is ALREADY 1 at startup
  // and there is no reparenting event. Suicide must NOT fire — the parent
  // IS init, that's the legitimate config. We simulate this with a
  // preload that overrides ppid IMMEDIATELY (delay=0) so the parentPid
  // capture itself sees 1.
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-init-parent-'));
  // 'sync' mode — override is set at module-load time (BEFORE main()
  // captures parentPid). Exercises the init-parent-from-boot skip path.
  const preloadPath = await writePpidPreload(home, 'sync');
  const server = startServer(
    home,
    {
      // Aggressive timing — if the suicide were to fire it would happen
      // within ~600ms. We wait 3s and assert still alive.
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '300',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '300',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(3_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `init-parented child must remain alive — got ${JSON.stringify(exited)}`,
    );
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.equal(detected.length, 0, 'orphan_suicide.detected must NOT fire when ppid=1 from boot');
    const skipped = events.filter((e) => e.event === 'orphan_suicide.skipped_init_parent');
    assert.ok(
      skipped.length >= 1,
      `orphan_suicide.skipped_init_parent must be logged — got events: ${JSON.stringify(events.map((e) => e.event))}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});

test('case 3: orphaned child (ppid === 1) DURING grace does NOT exit yet', { timeout: 12_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-orphan-suicide-grace-'));
  const preloadPath = await writePpidPreload(home);
  // grace=5s, interval=200ms. We wait 2s then assert still alive +
  // no detected event yet — grace is protecting the child.
  const server = startServer(
    home,
    {
      AGENT_BRIDGE_ORPHAN_SUICIDE_INTERVAL_MS: '200',
      AGENT_BRIDGE_ORPHAN_SUICIDE_GRACE_MS: '5000',
    },
    ['--import', pathToFileURL(preloadPath).href],
  );
  try {
    const exited = await Promise.race([
      new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
      sleep(2_000).then(() => null),
    ]);
    assert.equal(
      exited,
      null,
      `child with ppid=1 must remain alive during grace window — got ${JSON.stringify(exited)}`,
    );
    const events = await readEvents(home);
    const detected = events.filter((e) => e.event === 'orphan_suicide.detected');
    assert.equal(
      detected.length,
      0,
      `orphan_suicide.detected must NOT fire during grace — got: ${JSON.stringify(detected.map((d) => d.context))}`,
    );
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(100);
    await rm(home, { recursive: true, force: true });
  }
});
