#!/usr/bin/env node
/**
 * Refresh codex-channel's vendored copies of shared openclaw-channel modules.
 *
 * codex-channel must be self-contained as a packaged artifact, so it imports
 * byte-identical VENDOR copies instead of reaching into ../../openclaw-channel
 * at runtime. Canonical sources stay the single place edits happen; this
 * script (plus codex-channel/test/vendor-parity.test.mjs) keeps the copies
 * honest.
 *
 * Usage: node scripts/sync-codex-vendor.mjs [--check]
 *   --check  exit 1 when any copy is out of date (no writes)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAIRS = [
  // codex-channel artifact: shared openclaw-channel modules.
  {
    canonical: join(repoRoot, "openclaw-channel", "src", "envelope.js"),
    vendor: join(repoRoot, "codex-channel", "src", "vendor", "openclaw-envelope.js"),
  },
  {
    canonical: join(repoRoot, "openclaw-channel", "src", "outbound.js"),
    vendor: join(repoRoot, "codex-channel", "src", "vendor", "openclaw-outbound.js"),
  },
  // mcp-server artifact: shared lib/ modules (the marketplace/cache payload
  // is the mcp-server directory ALONE, so ../../lib is not shippable).
  // Runs as mcp-server's npm `prebuild`, so the vendor snapshot is always
  // fresh before tsc compiles the shims that import it.
  {
    canonical: join(repoRoot, "lib", "relay-expand-store.js"),
    vendor: join(repoRoot, "mcp-server", "vendor", "relay-expand-store.js"),
  },
  {
    canonical: join(repoRoot, "lib", "relay-expand-store.d.ts"),
    vendor: join(repoRoot, "mcp-server", "vendor", "relay-expand-store.d.ts"),
  },
  {
    canonical: join(repoRoot, "lib", "relay-notice.js"),
    vendor: join(repoRoot, "mcp-server", "vendor", "relay-notice.js"),
  },
  {
    canonical: join(repoRoot, "lib", "relay-notice.d.ts"),
    vendor: join(repoRoot, "mcp-server", "vendor", "relay-notice.d.ts"),
  },
];

const checkOnly = process.argv.includes("--check");
let stale = 0;
for (const { canonical, vendor } of PAIRS) {
  if (!existsSync(canonical)) {
    process.stderr.write(`sync-codex-vendor: canonical missing: ${canonical}\n`);
    process.exitCode = 2;
    continue;
  }
  const same = existsSync(vendor)
    && readFileSync(canonical, "utf8") === readFileSync(vendor, "utf8");
  if (same) continue;
  stale += 1;
  if (checkOnly) {
    process.stderr.write(`sync-codex-vendor: STALE ${vendor}\n`);
  } else {
    mkdirSync(dirname(vendor), { recursive: true });
    copyFileSync(canonical, vendor);
    process.stdout.write(`sync-codex-vendor: refreshed ${vendor}\n`);
  }
}
if (checkOnly && stale > 0) process.exitCode = 1;
if (stale === 0) process.stdout.write("sync-codex-vendor: all vendor copies current\n");
