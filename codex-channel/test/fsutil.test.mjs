import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishExclusiveFile, writeFileDurable } from "../src/fsutil.js";

test("writeFileDurable loops until every byte is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fsutil-short-write-"));
  const path = join(dir, "state.json");
  const expected = "four-byte 🛰 payload and trailing bytes";
  let calls = 0;
  writeFileDurable(path, expected, {
    writeSync(fd, buffer, offset, length, position) {
      calls += 1;
      return writeSync(fd, buffer, offset, Math.min(length, 3), position);
    },
  });
  assert.ok(calls > 1, "fixture forced multiple short writes");
  assert.equal(readFileSync(path, "utf8"), expected);
});

test("writeFileDurable propagates file fsync failures and never publishes the destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fsutil-fsync-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  const failure = Object.assign(new Error("simulated storage I/O error"), { code: "EIO" });
  assert.throws(
    () => writeFileDurable(path, "important", { fsyncSync: () => { throw failure; } }),
    (err) => err === failure,
  );
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".tmp-")), []);
});

test("publishExclusiveFile exposes only complete fsynced identity bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fsutil-exclusive-"));
  const path = join(dir, "owner.lock");
  const expected = JSON.stringify({ pid: 123, token: "complete" });
  let shortWrites = 0;
  let linkedBytes = null;
  publishExclusiveFile(path, expected, {
    writeSync(fd, buffer, offset, length, position) {
      shortWrites += 1;
      return writeSync(fd, buffer, offset, Math.min(length, 2), position);
    },
    linkSync(source, destination) {
      linkedBytes = readFileSync(source, "utf8");
      linkSync(source, destination);
    },
  });
  assert.ok(shortWrites > 1);
  assert.equal(linkedBytes, expected, "fixed name is linked only after the unique owner file is complete");
  assert.equal(readFileSync(path, "utf8"), expected);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".owner-")), []);
});

test("an abandoned unique owner file never blocks exclusive lock publication", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-fsutil-owner-orphan-"));
  const path = join(dir, "owner.lock");
  writeFileSync(`${path}.owner-abandoned`, "partial", "utf8");
  publishExclusiveFile(path, "complete");
  assert.equal(readFileSync(path, "utf8"), "complete");
  assert.equal(readFileSync(`${path}.owner-abandoned`, "utf8"), "partial");
});
