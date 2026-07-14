// Tests for sshExecWithEndpointFallback (4.9.1) — the endpoint-fallback path
// used by learnings replication (bridge_learnings_add's peer pushes).
//
// Real incident this pins (2026-07-14): peers carry TWO addresses (LAN `host`
// + Tailscale `internet_host`) and either can be individually dead — a stale
// LAN IP nobody refreshes, or a flaky tailnet path. The 3.4.2+ policy is
// single-endpoint-no-fallback, which is right for status probes but wrong for
// idempotent side-effect writes like learnings ingest. The helper must:
//   • use the preferred endpoint when it works (no fallback attempt),
//   • fall back internet→LAN ONLY on an ssh CONNECTION failure (exit 255 +
//     client-emitted failure phrases),
//   • NOT fall back when the remote command itself failed (it already ran),
//   • report failure when both endpoints are dead.
//
// We stub the `ssh` binary on PATH (spawn('ssh', …) resolves via PATH from
// process.env, which openSshChildEnv() copies) so no real network is touched.
// The stub decides success/failure by which user@host token it received.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'ab-sshfb-'));
process.env.HOME = SANDBOX;

// -- ssh stub -----------------------------------------------------------------
// Behavior by target host token:
//   user@100.77.0.9  → connection-dead tailnet: exit 255 + client failure text
//   user@10.0.0.5    → healthy LAN: prints marker incl. which host served it
//   user@100.66.0.6  → healthy tailnet (for the no-fallback-needed case)
//   user@10.0.0.66   → remote COMMAND failure: exit 7 (must NOT trigger fallback)
const stubDir = join(SANDBOX, 'stub-bin');
mkdirSync(stubDir, { recursive: true });
writeFileSync(
  join(stubDir, 'ssh'),
  `#!/bin/sh
# find the user@host argv token
for a in "$@"; do case "$a" in tester@*) target="$a";; esac; done
case "$target" in
  tester@100.77.0.9) echo "ssh: connect to host 100.77.0.9 port 22: Operation timed out" >&2; exit 255 ;;
  tester@10.0.0.5)   echo "SERVED-BY-LAN"; exit 0 ;;
  tester@100.66.0.6) echo "SERVED-BY-TAILNET"; exit 0 ;;
  tester@10.0.0.66)  echo "remote command blew up" >&2; exit 7 ;;
  *)                 echo "ssh: connect to host unknown port 22: No route to host" >&2; exit 255 ;;
esac
`,
  'utf8',
);
chmodSync(join(stubDir, 'ssh'), 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;

// Import AFTER the PATH/HOME setup so the module (and its spawns) see them.
const ssh = await import('../build/ssh.js');

// A dummy identity file — sshExec throws early if the key path doesn't exist.
const keyFile = join(SANDBOX, 'fake-key');
writeFileSync(keyFile, 'not a real key', 'utf8');

// Machine fixture factory — internetHost varies per test.
function machine(overrides = {}) {
  return {
    name: 'FakePeer',
    host: '10.0.0.5',
    port: 22,
    user: 'tester',
    key: keyFile,
    identityFile: keyFile,
    pairedAt: '2026-07-14T00:00:00Z',
    internetHost: '100.77.0.9',
    ...overrides,
  };
}

test('falls back internet→LAN when the tailnet endpoint is connection-dead', async () => {
  const res = await ssh.sshExecWithEndpointFallback(machine(), 'echo hi', 10000);
  assert.equal(res.exitCode, 0, `expected success via fallback, got ${res.exitCode}: ${res.stderr}`);
  assert.match(res.stdout, /SERVED-BY-LAN/, 'the LAN endpoint served the command');
  assert.equal(res.endpointUsed, 'fallback');
});

test('uses the preferred (tailnet) endpoint when it works — no fallback attempt', async () => {
  const res = await ssh.sshExecWithEndpointFallback(
    machine({ internetHost: '100.66.0.6' }), 'echo hi', 10000,
  );
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /SERVED-BY-TAILNET/);
  assert.equal(res.endpointUsed, 'preferred');
});

test('coordinator scenario: dead LAN host + working internet address → push succeeds', async () => {
  // Tailscale-first preference means the dead LAN host is never even tried
  // when a healthy internet_host exists — pin that this keeps working.
  const res = await ssh.sshExecWithEndpointFallback(
    machine({ host: '10.9.9.9', internetHost: '100.66.0.6' }), 'echo hi', 10000,
  );
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /SERVED-BY-TAILNET/);
  assert.equal(res.endpointUsed, 'preferred');
});

test('remote COMMAND failure does NOT trigger fallback (command already ran)', async () => {
  const res = await ssh.sshExecWithEndpointFallback(
    machine({ internetHost: undefined, host: '10.0.0.66' }), 'exit 7', 10000,
  );
  assert.equal(res.exitCode, 7, 'remote exit code passed through');
  assert.equal(res.endpointUsed, 'preferred', 'preferred endpoint answered — the command ran');
});

test('LAN-only peer with dead host: fails cleanly, no phantom fallback', async () => {
  const res = await ssh.sshExecWithEndpointFallback(
    machine({ internetHost: undefined, host: '10.255.255.1' }), 'echo hi', 10000,
  );
  assert.equal(res.exitCode, 255);
  assert.equal(res.endpointUsed, undefined, 'no endpoint served it');
});

test('both endpoints dead: last failure returned, preferred failure appended for diagnosis', async () => {
  const res = await ssh.sshExecWithEndpointFallback(
    machine({ internetHost: '100.77.0.9', host: '10.255.255.1' }), 'echo hi', 10000,
  );
  assert.equal(res.exitCode, 255);
  assert.equal(res.endpointUsed, undefined);
  assert.match(res.stderr, /\[endpoint-fallback\] preferred \(internet\) also failed/);
});
