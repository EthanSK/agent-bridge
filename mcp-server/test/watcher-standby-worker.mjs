import { startWatcher } from '../build/watcher.js';

const label = process.argv[2] ?? 'worker';
try {
  await startWatcher(
    () => {},
    async () => {},
    { role: 'channel-owner' },
  );
  process.stderr.write(`worker ${label} ready pid=${process.pid}\n`);
  setInterval(() => {}, 1_000);
} catch (err) {
  process.stderr.write(`worker ${label} failed: ${err?.stack || err}\n`);
  process.exit(1);
}
