#!/usr/bin/env bash
# Tests for sandboxed-HOME auto-detect (4.4.0+).
#
# When the CLI is invoked with `$HOME` pointing at a sandbox dir that has no
# `.agent-bridge/config` (e.g. OpenClaw/Codex agent subprocesses), the CLI
# must transparently fall back to the real user home — discovered via
# getent/dscl/`eval echo ~$USER` — provided that real home DOES have a
# config. AGENT_BRIDGE_HOME is honoured as an explicit state-dir override.
#
# Cases covered:
#   • Sandboxed HOME with no config + real home with config → uses real home.
#   • AGENT_BRIDGE_HOME state-dir override beats both.
#   • AGENT_BRIDGE_HOME parent-home override is accepted for convenience.
#   • Sandboxed HOME with no real-home config → no fallback (fresh install
#     should still see "no machines paired", not crash).
#   • Normal HOME path (config present) is untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Set up two fake homes:
#   $TMP/realhome  — has a .agent-bridge/config with one paired machine.
#   $TMP/sandbox   — empty home with no .agent-bridge dir.
mkdir -p "$TMP/realhome/.agent-bridge" "$TMP/sandbox" "$TMP/bin"

cat >"$TMP/realhome/.agent-bridge/config" <<'CONFIG'
[real-peer]
host=127.0.0.99
user=test
port=22
key=(system default)
CONFIG

# Stub ssh — the listing code path must NOT hit ssh. Status would, so we make
# ssh return success with no output (treated as reachable).
cat >"$TMP/bin/ssh" <<'SSH'
#!/usr/bin/env bash
exit 0
SSH
chmod +x "$TMP/bin/ssh"

# Stub `getent` so we can pretend the real user home is $TMP/realhome on
# Linux-shaped tests. On macOS we rely on dscl / `eval echo ~$USER`. To make
# the test fully deterministic across platforms, we shadow `getent`, `dscl`,
# and force USER to a value whose `eval echo` will resolve to $TMP/realhome
# via... no, we can't reliably mutate /etc/passwd. Instead: stub getent +
# dscl, AND set HOME=$TMP/sandbox + USER=__ab_test_user, then export a tiny
# wrapper that resolves _real_user_home via getent.
cat >"$TMP/bin/getent" <<GETENT
#!/usr/bin/env bash
# Pretend uid \$(id -u) maps to a passwd line whose home is $TMP/realhome.
if [ "\${1:-}" = "passwd" ]; then
  printf '%s:x:%s:%s::%s:/bin/bash\n' "\${USER:-test}" "\${2:-1000}" "\${2:-1000}" "$TMP/realhome"
  exit 0
fi
exit 1
GETENT
chmod +x "$TMP/bin/getent"

# Also stub dscl so macOS path returns the same value.
cat >"$TMP/bin/dscl" <<DSCL
#!/usr/bin/env bash
# Match: dscl . -read /Users/<user> NFSHomeDirectory
if [ "\${4:-}" = "NFSHomeDirectory" ]; then
  printf 'NFSHomeDirectory: %s\n' "$TMP/realhome"
  exit 0
fi
exit 0
DSCL
chmod +x "$TMP/bin/dscl"

run_cli() {
  HOME="$1" PATH="$TMP/bin:$PATH" USER="${USER:-test}" \
    AGENT_BRIDGE_VERBOSE=0 \
    AGENT_BRIDGE_MACHINE_NAME=TestHost \
    "$ROOT/agent-bridge" list 2>&1
}

# -- Case 1: sandboxed HOME → falls back to real home --
OUTPUT="$(run_cli "$TMP/sandbox")"
grep -q 'real-peer' <<<"$OUTPUT" \
  || { echo "FAIL: sandboxed HOME did not fall back to real user home"; echo "$OUTPUT"; exit 1; }

# -- Case 2: AGENT_BRIDGE_HOME explicit state-dir override wins --
OUTPUT="$(HOME="$TMP/sandbox" AGENT_BRIDGE_HOME="$TMP/realhome/.agent-bridge" \
  PATH="$TMP/bin:$PATH" USER="${USER:-test}" AGENT_BRIDGE_VERBOSE=0 \
  AGENT_BRIDGE_MACHINE_NAME=TestHost \
  "$ROOT/agent-bridge" list 2>&1)"
grep -q 'real-peer' <<<"$OUTPUT" \
  || { echo "FAIL: AGENT_BRIDGE_HOME state-dir override did not direct to real home"; echo "$OUTPUT"; exit 1; }

# -- Case 2b: AGENT_BRIDGE_HOME parent-home override is accepted too --
OUTPUT="$(HOME="$TMP/sandbox" AGENT_BRIDGE_HOME="$TMP/realhome" \
  PATH="$TMP/bin:$PATH" USER="${USER:-test}" AGENT_BRIDGE_VERBOSE=0 \
  AGENT_BRIDGE_MACHINE_NAME=TestHost \
  "$ROOT/agent-bridge" list 2>&1)"
grep -q 'real-peer' <<<"$OUTPUT" \
  || { echo "FAIL: AGENT_BRIDGE_HOME parent-home override did not direct to real home"; echo "$OUTPUT"; exit 1; }

# -- Case 3: HOME with config present is untouched (normal path) --
# Use $TMP/realhome directly. getent stub still points to realhome, so even
# if the fallback fired the answer is the same — the assertion is that the
# pre-existing config is read.
OUTPUT="$(run_cli "$TMP/realhome")"
grep -q 'real-peer' <<<"$OUTPUT" \
  || { echo "FAIL: normal HOME with config did not list paired machine"; echo "$OUTPUT"; exit 1; }

# -- Case 4: no config anywhere → no crash, just empty/no-pairings --
EMPTY_TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$EMPTY_TMP"' EXIT
mkdir -p "$EMPTY_TMP/sandbox" "$EMPTY_TMP/realhome" "$EMPTY_TMP/bin"
cp "$TMP/bin/ssh" "$EMPTY_TMP/bin/ssh"
# Stub getent / dscl pointing to empty realhome so neither has a config.
cat >"$EMPTY_TMP/bin/getent" <<GETENT
#!/usr/bin/env bash
if [ "\${1:-}" = "passwd" ]; then
  printf '%s:x:%s:%s::%s:/bin/bash\n' "\${USER:-test}" "\${2:-1000}" "\${2:-1000}" "$EMPTY_TMP/realhome"
  exit 0
fi
exit 1
GETENT
chmod +x "$EMPTY_TMP/bin/getent"
cat >"$EMPTY_TMP/bin/dscl" <<DSCL
#!/usr/bin/env bash
if [ "\${4:-}" = "NFSHomeDirectory" ]; then
  printf 'NFSHomeDirectory: %s\n' "$EMPTY_TMP/realhome"
fi
exit 0
DSCL
chmod +x "$EMPTY_TMP/bin/dscl"

set +e
OUTPUT="$(HOME="$EMPTY_TMP/sandbox" PATH="$EMPTY_TMP/bin:$PATH" \
  USER="${USER:-test}" AGENT_BRIDGE_VERBOSE=0 \
  AGENT_BRIDGE_MACHINE_NAME=TestHost \
  "$ROOT/agent-bridge" list 2>&1)"
EXIT=$?
set -e
[ "$EXIT" -eq 0 ] || { echo "FAIL: empty homes case crashed (exit=$EXIT)"; echo "$OUTPUT"; exit 1; }
grep -qiE 'no.*paired|no machines' <<<"$OUTPUT" \
  || { echo "FAIL: empty homes case should report no paired machines"; echo "$OUTPUT"; exit 1; }

echo "cli-sandboxed-home.sh: all checks passed"
