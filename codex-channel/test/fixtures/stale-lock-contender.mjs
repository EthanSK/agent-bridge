import { existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withRegistryLock } from "../../src/bindings.js";
import { withLeaseMutex } from "../../src/service.js";

const [mode, barrierPath, criticalPath, resultDir] = process.argv.slice(2);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

process.stdout.write("ready\n");
while (!existsSync(barrierPath)) sleep(2);

const runLocked = mode === "registry"
  ? (fn) => withRegistryLock(fn, { env: process.env, timeoutMs: 15_000 })
  : mode === "lease"
    ? (fn) => withLeaseMutex(process.env, fn)
    : null;

if (!runLocked) throw new Error(`unknown lock mode ${mode}`);

runLocked(() => {
  let markerOwned = false;
  try {
    mkdirSync(criticalPath);
    markerOwned = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    writeFileSync(join(resultDir, `overlap-${process.pid}`), "overlap\n");
  }
  sleep(75);
  if (markerOwned) rmdirSync(criticalPath);
});

process.stdout.write("done\n");
