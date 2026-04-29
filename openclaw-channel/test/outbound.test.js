import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSftpArgs,
  buildSftpBatch,
  localMachineName,
  normalizeSftpPath,
  resolvePairedMachine,
} from "../src/outbound.js";

function normBatch(s) {
  return s.replace(/\r\n/g, "\n");
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-openclaw-channel-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("AGENT_BRIDGE_MACHINE_NAME override wins unchanged", () => {
  withTempDir((dir) => {
    const nameFilePath = join(dir, "machine-name");
    const identityPath = join(dir, ".identity");
    writeFileSync(nameFilePath, "PinnedName\n");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_IdentityName"));

    assert.equal(
      localMachineName({
        env: { AGENT_BRIDGE_MACHINE_NAME: "MacBookPro.lan" },
        nameFilePath,
        identityPath,
        getHostname: () => "HostName.local",
      }),
      "MacBookPro.lan",
    );
  });
});

test("machine-name file beats identity and hostname fallback", () => {
  withTempDir((dir) => {
    const nameFilePath = join(dir, "machine-name");
    const identityPath = join(dir, ".identity");
    writeFileSync(nameFilePath, "PinnedName\n");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_IdentityName"));

    assert.equal(
      localMachineName({
        env: {},
        nameFilePath,
        identityPath,
        getHostname: () => "HostName.local",
      }),
      "PinnedName",
    );
  });
});

test("setup identity yields a stable machine label when available", () => {
  withTempDir((dir) => {
    const identityPath = join(dir, ".identity");
    writeFileSync(identityPath, join(dir, "keys", "agent-bridge_MacBookPro"));

    assert.equal(
      localMachineName({
        env: {},
        nameFilePath: join(dir, "missing-machine-name"),
        identityPath,
        getHostname: () => "Ethans-MacBook-Pro.local",
      }),
      "MacBookPro",
    );
  });
});

test("hostname fallback strips .local", () => {
  assert.equal(
    localMachineName({
      env: {},
      nameFilePath: join(tmpdir(), "definitely-missing-machine-name"),
      identityPath: join(tmpdir(), "definitely-missing-identity"),
      getHostname: () => "Ethans-MacBook-Pro.local",
    }),
    "Ethans-MacBook-Pro",
  );
});

test("resolvePairedMachine parses identity_file and prefers it for explicit identity", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "config");
    writeFileSync(
      configPath,
      [
        "[WinPeer]",
        "host=192.0.2.10",
        "user=ethan",
        "port=2222",
        "key=/legacy/key",
        "identity_file=/bridge/identity",
        "paired_at=2026-04-29T00:00:00Z",
        "",
      ].join("\n"),
    );

    const peer = resolvePairedMachine("WinPeer", configPath);
    assert.equal(peer.key, "/legacy/key");
    assert.equal(peer.identityFile, "/bridge/identity");
  });
});

test("OpenClaw outbound SFTP batch is home-relative and shell-free", () => {
  const remoteFinal = normalizeSftpPath("~/.agent-bridge/inbox/openclaw/default/msg-1.json");
  const batch = buildSftpBatch(
    "/local/payload.json",
    `${remoteFinal}.tmp.abc`,
    remoteFinal,
  );

  // [SFTP-CD-TILDE-FIX 2026-04-29] No `cd ~` — server-dependent.
  assert.deepEqual(normBatch(batch).trim().split("\n"), [
    '-mkdir ".agent-bridge"',
    '-mkdir ".agent-bridge/inbox"',
    '-mkdir ".agent-bridge/inbox/openclaw"',
    '-mkdir ".agent-bridge/inbox/openclaw/default"',
    'put "/local/payload.json" ".agent-bridge/inbox/openclaw/default/msg-1.json.tmp.abc"',
    'rename ".agent-bridge/inbox/openclaw/default/msg-1.json.tmp.abc" ".agent-bridge/inbox/openclaw/default/msg-1.json"',
    "bye",
  ]);
  assert.equal(batch.includes("cd ~"), false, "regression guard: no `cd ~`");

  for (const banned of ["$HOME", "mkdir -p", "mv -f", "cat <<", "scp "]) {
    assert.equal(batch.includes(banned), false, `unexpected shell construct ${banned}`);
  }
});

test("OpenClaw outbound SFTP args force configured identity only", () => {
  const args = buildSftpArgs({
    keyPath: "/bridge/identity",
    user: "ethan",
    host: "192.0.2.10",
    port: 2222,
  });

  assert.equal(args[0], "-i");
  assert.equal(args[1], "/bridge/identity");
  assert.ok(args.includes("IdentitiesOnly=yes"), args.join(" "));
  assert.equal(args.includes("-E"), false, "sftp args must not include macOS-unsupported -E");
});
