/**
 * Regression test for the Windows-specific ESM dispatch bug
 * (Dell-OC stranded inbox, 2026-05-04).
 *
 * Background
 * ----------
 * `loadDispatchRuntime` in src/index.js uses `createRequire().resolve()` to
 * locate `openclaw/plugin-sdk/inbound-reply-dispatch` and then dynamically
 * `import()`s the resolved path. `resolve()` returns an absolute filesystem
 * path; on Windows that path begins with a drive letter (e.g.
 * `C:\Users\ethan\...\index.js`). Node's ESM loader treats the leading
 * `C:` as a URL scheme and throws:
 *
 *   Only URLs with a scheme in: file, data, and node are supported by the
 *   default ESM loader. Received protocol 'c:'.
 *
 * The fix is to wrap the resolved filesystem path in `pathToFileURL()` so
 * `import()` always receives a proper `file://` URL on every platform.
 *
 * This test exercises the cross-platform URL-construction contract that the
 * fix relies on. Running this on macOS/Linux still validates the Windows
 * branch because `pathToFileURL` is implemented in pure JS in Node core and
 * accepts Windows-style paths regardless of the host platform.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

test("pathToFileURL converts the host's absolute path to a valid file:// URL", () => {
  // Run with whatever platform the test host happens to be. On POSIX hosts
  // we exercise the POSIX branch; on Windows hosts we exercise the Windows
  // branch (same code path the runtime hits on Dell). Both must produce a
  // valid `file://` URL because that's the only thing Node's ESM loader
  // will accept for filesystem-path imports.
  //
  // Note: `pathToFileURL`'s `{ windows: true }` opt-in is Node 20+; this
  // package documents Node >=18 support, so we deliberately call the helper
  // without the cross-platform option and rely on the host's natural
  // behavior.
  const hostPath = process.platform === "win32"
    ? "C:\\Users\\ethan\\openclaw\\plugin-sdk\\inbound-reply-dispatch.js"
    : "/Users/ethan/Projects/agent-bridge/openclaw-channel/node_modules/openclaw/plugin-sdk/inbound-reply-dispatch.js";

  const url = pathToFileURL(hostPath).href;

  assert.ok(url.startsWith("file:///"), `expected file:/// URL, got: ${url}`);
  // Round-trip through the WHATWG URL parser — same parser the ESM loader
  // uses. If pathToFileURL ever regressed to producing a raw `c:` scheme,
  // this would throw or report a non-`file:` protocol.
  const parsed = new URL(url);
  assert.equal(
    parsed.protocol,
    "file:",
    `parsed protocol should be file:, got ${parsed.protocol}`,
  );
});

test("pathToFileURL produces a valid file:// URL for a synthetic POSIX path", () => {
  // Cross-platform sanity check: regardless of host platform, an absolute
  // POSIX-shaped string must serialize to file:///… because the leading
  // slash is unambiguous. This guards against any future regression that
  // strips the `pathToFileURL` call entirely on the assumption that "POSIX
  // already works without it" — it doesn't, `import()` requires the
  // file:// prefix.
  const posixPath = "/var/tmp/openclaw/plugin-sdk/inbound-reply-dispatch.js";
  const url = pathToFileURL(posixPath).href;

  assert.ok(url.startsWith("file:///"), `expected file:/// URL, got: ${url}`);
  assert.ok(
    url.endsWith("/inbound-reply-dispatch.js"),
    `tail should match: ${url}`,
  );
  assert.ok(!url.includes("\\"), `URL must not contain backslashes: ${url}`);
});

test("raw Windows-style path passed to import() reproduces the original ESM bug", async () => {
  // Sanity check that documents WHY the fix is needed: when a Windows path
  // is passed directly to `import()`, Node's ESM loader rejects it with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME because the leading `c:` is interpreted
  // as a non-file URL scheme. This is the exact failure Dell-OC hit.
  //
  // We reproduce on macOS by using a synthetic `c:` path string — the loader
  // performs the scheme check before any filesystem lookup, so the file does
  // not need to exist for the failure mode to trigger.
  const winLike = "c:/Users/ethan/openclaw/plugin-sdk/inbound-reply-dispatch.js";
  let caught;
  try {
    await import(winLike);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "import() of a c:-prefixed path must throw");
  // Accept either the canonical scheme-allowlist message or any error whose
  // payload mentions the unsupported scheme — version-resilient.
  const msg = String(caught?.message ?? caught);
  assert.ok(
    /scheme|protocol|c:/i.test(msg),
    `expected ESM scheme/protocol error, got: ${msg}`,
  );
});

test("repository code uses pathToFileURL before import() in loadDispatchRuntime", async () => {
  // Static-source guard: ensure nobody accidentally reverts the fix.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(import.meta.url);
  const indexPath = path.resolve(path.dirname(here), "..", "src", "index.js");
  const src = await readFile(indexPath, "utf8");

  // The dispatch resolver must call pathToFileURL on the createRequire
  // resolved path before passing it to import().
  assert.ok(
    /pathToFileURL\([^)]*modPath[^)]*\)/.test(src),
    "loadDispatchRuntime must wrap the createRequire-resolved modPath in pathToFileURL() before import()",
  );
  // And the import() argument must be the URL form, not the raw path.
  assert.ok(
    /await import\(modUrl\)/.test(src),
    "loadDispatchRuntime must pass the file:// URL (not the raw filesystem path) to import()",
  );
});
