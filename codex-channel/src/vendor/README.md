# Vendored shared modules (packaging self-containment)

`codex-channel` must be shippable as a standalone artifact (npm tarball,
installed runtime under `~/.agent-bridge/runtime/`, isolated plugin caches)
where sibling repo packages like `openclaw-channel/` do not exist. The two
shared modules it depends on are therefore VENDORED here as byte-identical
copies of their canonical sources:

| vendor copy               | canonical source                    |
|---------------------------|-------------------------------------|
| `openclaw-envelope.js`    | `openclaw-channel/src/envelope.js`  |
| `openclaw-outbound.js`    | `openclaw-channel/src/outbound.js`  |

Rules:

- **Never edit these copies directly.** Edit the canonical file, then run
  `node scripts/sync-codex-vendor.mjs` to refresh the copies.
- Drift is a test failure: `codex-channel/test/vendor-parity.test.mjs`
  asserts byte equality whenever the canonical files are present (i.e. in
  every full-repo checkout / CI run). Isolated artifacts skip the check —
  they carry only the snapshot, which is exactly the point.
