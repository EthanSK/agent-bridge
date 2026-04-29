import test from "node:test";
import assert from "node:assert/strict";

import { buildSftpBatch, normalizeSftpPath, sftpParentDirs } from "../src/outbound.js";

test("normalizeSftpPath strips ~/ for Windows OpenSSH SFTP compatibility", () => {
  assert.equal(
    normalizeSftpPath("~/.agent-bridge/inbox/claude-code/msg.json"),
    ".agent-bridge/inbox/claude-code/msg.json",
  );
  assert.equal(normalizeSftpPath("~"), ".");
  assert.equal(
    normalizeSftpPath("/Users/ethan/.agent-bridge/inbox/claude-code/msg.json"),
    "/Users/ethan/.agent-bridge/inbox/claude-code/msg.json",
  );
});

test("sftpParentDirs walks nested target directories", () => {
  assert.deepEqual(
    sftpParentDirs(".agent-bridge/inbox/openclaw/clawdiboi2/msg.json"),
    [
      ".agent-bridge",
      ".agent-bridge/inbox",
      ".agent-bridge/inbox/openclaw",
      ".agent-bridge/inbox/openclaw/clawdiboi2",
    ],
  );
});

test("buildSftpBatch uses SFTP operations only, no remote shell syntax", () => {
  const batch = buildSftpBatch(
    "/tmp/local payload.json",
    ".agent-bridge/inbox/claude-code/msg.json.tmp.abc",
    ".agent-bridge/inbox/claude-code/msg.json",
  );

  assert.match(batch, /-mkdir "\.agent-bridge\/inbox\/claude-code"/);
  assert.match(batch, /put "\/tmp\/local payload\.json" "\.agent-bridge\/inbox\/claude-code\/msg\.json\.tmp\.abc"/);
  assert.match(batch, /rename "\.agent-bridge\/inbox\/claude-code\/msg\.json\.tmp\.abc" "\.agent-bridge\/inbox\/claude-code\/msg\.json"/);
  assert.match(batch, /bye\n$/);

  assert.doesNotMatch(batch, /mkdir -p/);
  assert.doesNotMatch(batch, /\$HOME/);
  assert.doesNotMatch(batch, /\bmv\b/);
  assert.doesNotMatch(batch, /&&|\|/);
});
