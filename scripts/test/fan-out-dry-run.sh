#!/usr/bin/env bash
# [MATRIX-FAN-OUT 2026-04-29] Tests for `scripts/update.sh --fan-out --dry-run`.
#
# Verifies:
#   - --fan-out and --dry-run flags parse without error.
#   - --dry-run short-circuits the local update steps (prints "[dry-run] would:"
#     for git pull / rebuild / cache sync / openclaw / reload-plugins).
#   - With --fan-out + --dry-run, the planner enumerates each peer in
#     ~/.agent-bridge/config (skipping *.lan duplicates and the local machine
#     name) and prints what it would do for each peer + the BridgeMessage drop.
#   - No real ssh/sftp invocation happens (we shadow both with stubs that
#     loudly fail if reached).
#   - --help mentions the new flags.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UPDATE_SH="$REPO_ROOT/scripts/update.sh"

if [[ ! -x "$UPDATE_SH" ]] && [[ ! -f "$UPDATE_SH" ]]; then
  echo "FAIL: $UPDATE_SH not found" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.agent-bridge" "$TMP/bin"

# Loud stubs — fan-out --dry-run must NOT call ssh/sftp.
cat >"$TMP/bin/ssh" <<'SSH'
#!/usr/bin/env bash
echo "FAIL: ssh should not be invoked in --dry-run mode" >&2
exit 99
SSH
chmod +x "$TMP/bin/ssh"
cat >"$TMP/bin/sftp" <<'SFTP'
#!/usr/bin/env bash
echo "FAIL: sftp should not be invoked in --dry-run mode" >&2
exit 99
SFTP
chmod +x "$TMP/bin/sftp"

# Synthetic ~/.agent-bridge/config with three peers:
#   - Alpha             (top-level, distinct host)
#   - Alpha.lan         (LAN sub-section duplicate — must be skipped)
#   - Beta              (top-level, with internet_host)
#   - TestHost          (top-level — matches AGENT_BRIDGE_MACHINE_NAME below
#                        and must be skipped as self)
mkdir -p "$TMP/.agent-bridge/keys"
touch "$TMP/.agent-bridge/keys/alpha-key" "$TMP/.agent-bridge/keys/beta-key" "$TMP/.agent-bridge/keys/self-key"
cat >"$TMP/.agent-bridge/config" <<EOF
[Alpha]
host=192.0.2.10
user=alice
port=22
identity_file=$TMP/.agent-bridge/keys/alpha-key
paired_at=2026-04-29T00:00:00Z

[Alpha.lan]
host=192.0.2.10
user=alice
port=22
identity_file=$TMP/.agent-bridge/keys/alpha-key
paired_at=2026-04-29T00:00:00Z

[Beta]
host=192.0.2.20
user=bob
port=22
identity_file=$TMP/.agent-bridge/keys/beta-key
internet_host=100.64.0.20
paired_at=2026-04-29T00:00:00Z

[TestHost]
host=192.0.2.30
user=ethan
port=22
identity_file=$TMP/.agent-bridge/keys/self-key
paired_at=2026-04-29T00:00:00Z
EOF

OUT_FILE="$TMP/out.txt"

# Note: we set HOME so update.sh's fan-out picks up our synthetic config and
# does NOT touch the real ~/.agent-bridge. AGENT_BRIDGE_MACHINE_NAME tells the
# planner which peer is "self" (must skip).
set +e
HOME="$TMP" \
PATH="$TMP/bin:$PATH" \
AGENT_BRIDGE_MACHINE_NAME=TestHost \
  bash "$UPDATE_SH" --fan-out --dry-run >"$OUT_FILE" 2>&1
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "FAIL: update.sh --fan-out --dry-run exited $rc" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

# 1. Local-step dry-run lines must be present.
grep -q "\[dry-run\] would: git fetch" "$OUT_FILE" \
  || { echo "FAIL: missing [dry-run] git fetch line" >&2; cat "$OUT_FILE" >&2; exit 1; }
grep -q "\[dry-run\] would: rebuild mcp-server" "$OUT_FILE" \
  || { echo "FAIL: missing [dry-run] rebuild line" >&2; cat "$OUT_FILE" >&2; exit 1; }

# 2. Each top-level peer (Alpha, Beta) must show up in the dry-run plan.
grep -q "\[dry-run\] would: ssh to Alpha" "$OUT_FILE" \
  || { echo "FAIL: Alpha not in dry-run plan" >&2; cat "$OUT_FILE" >&2; exit 1; }
grep -q "\[dry-run\] would: ssh to Beta" "$OUT_FILE" \
  || { echo "FAIL: Beta not in dry-run plan" >&2; cat "$OUT_FILE" >&2; exit 1; }

# 3. The .lan sub-section must NOT be enumerated as its own peer.
if grep -q "\[dry-run\] would: ssh to Alpha\.lan" "$OUT_FILE"; then
  echo "FAIL: Alpha.lan should be skipped (it's the LAN duplicate of Alpha)" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

# 4. Self (TestHost) must be skipped.
if grep -q "\[dry-run\] would: ssh to TestHost" "$OUT_FILE"; then
  echo "FAIL: TestHost should be skipped (it's the local machine)" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi
grep -q "skipping self (TestHost)" "$OUT_FILE" \
  || { echo "FAIL: 'skipping self (TestHost)' marker missing" >&2; cat "$OUT_FILE" >&2; exit 1; }

# 5. BridgeMessage drop must appear in the dry-run plan for both peers, with
#    the inbox/claude-code/ subdir target.
grep -q "\[dry-run\] would: deliver \[MATRIX-UPDATE-DONE\] BridgeMessage" "$OUT_FILE" \
  || { echo "FAIL: missing [MATRIX-UPDATE-DONE] dry-run line" >&2; cat "$OUT_FILE" >&2; exit 1; }
grep -q "\[dry-run\] Alpha: would SFTP .*inbox/claude-code/" "$OUT_FILE" \
  || { echo "FAIL: missing Alpha SFTP dry-run plan" >&2; cat "$OUT_FILE" >&2; exit 1; }
grep -q "\[dry-run\] Beta: would SFTP .*inbox/claude-code/" "$OUT_FILE" \
  || { echo "FAIL: missing Beta SFTP dry-run plan" >&2; cat "$OUT_FILE" >&2; exit 1; }

# 6. Summary must list both peers as dryrun, neither marked ok/fail.
grep -q "Alpha:dryrun" "$OUT_FILE" \
  || { echo "FAIL: Alpha:dryrun missing from summary" >&2; cat "$OUT_FILE" >&2; exit 1; }
grep -q "Beta:dryrun" "$OUT_FILE" \
  || { echo "FAIL: Beta:dryrun missing from summary" >&2; cat "$OUT_FILE" >&2; exit 1; }

# 7. --help must mention --fan-out and --dry-run.
HELP_OUT="$(bash "$UPDATE_SH" --help)"
grep -q -- "--fan-out" <<<"$HELP_OUT" \
  || { echo "FAIL: --help does not mention --fan-out" >&2; printf '%s\n' "$HELP_OUT" >&2; exit 1; }
grep -q -- "--dry-run" <<<"$HELP_OUT" \
  || { echo "FAIL: --help does not mention --dry-run" >&2; printf '%s\n' "$HELP_OUT" >&2; exit 1; }

# 8. Bare --dry-run (no --fan-out) must also exit 0 and short-circuit (no ssh).
set +e
HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost \
  bash "$UPDATE_SH" --dry-run >"$TMP/bare.txt" 2>&1
bare_rc=$?
set -e
[[ $bare_rc -eq 0 ]] \
  || { echo "FAIL: bare --dry-run exited $bare_rc" >&2; cat "$TMP/bare.txt" >&2; exit 1; }
grep -q "\[dry-run\] would: git fetch" "$TMP/bare.txt" \
  || { echo "FAIL: bare --dry-run missing git fetch plan" >&2; cat "$TMP/bare.txt" >&2; exit 1; }
# No fan-out planner in bare mode.
if grep -q "Step 7/7: --fan-out" "$TMP/bare.txt"; then
  echo "FAIL: bare --dry-run should not run the fan-out planner" >&2
  cat "$TMP/bare.txt" >&2
  exit 1
fi

echo "fan-out-dry-run.sh: all checks passed"
