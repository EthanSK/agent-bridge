#!/usr/bin/env bash
# Tests for the `agent-bridge notify` CLI verb (4.8.0+).
#
# Coverage:
#   • `notify --local`               → renders locally via terminal-notifier
#                                       (stubbed), exit 0, correct flags passed
#   • `notify <local-name>`          → same local render path (is_local_machine)
#   • missing --title / --message    → dies (non-zero exit)
#   • terminal-notifier ABSENT       → falls back to osascript (stubbed)
#   • free-form fields with spaces/quotes survive into the stub verbatim
#
# We stub BOTH terminal-notifier and osascript on PATH so the test never pops a
# real banner and can assert exactly what was invoked. `notify --local` must
# NOT touch ssh, so we also stub ssh to fail loudly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.agent-bridge" "$TMP/bin"

# Stub ssh so any accidental invocation is loud (notify --local must be local-only).
cat >"$TMP/bin/ssh" <<'SSH'
#!/usr/bin/env bash
echo "FAIL: ssh should not be invoked for notify --local" >&2
exit 99
SSH
chmod +x "$TMP/bin/ssh"

# Stub terminal-notifier — records its args to a file so we can assert on them.
cat >"$TMP/bin/terminal-notifier" <<TN
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$TMP/tn-args.txt"
exit 0
TN
chmod +x "$TMP/bin/terminal-notifier"

run_cli() {
  HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost \
    "$ROOT/agent-bridge" "$@"
}

# --- 1. notify --local renders via terminal-notifier, exit 0 ---------------
set +e
OUT="$(run_cli notify --local --title "Build done" --message "all green" --subtitle "from MBP" --sound default 2>&1)"
EXIT=$?
set -e
[ "$EXIT" -eq 0 ] || { echo "FAIL: notify --local should exit 0 (got $EXIT): $OUT"; exit 1; }
[ -f "$TMP/tn-args.txt" ] || { echo "FAIL: terminal-notifier was not invoked"; exit 1; }
grep -qx -- '-title' "$TMP/tn-args.txt"   || { echo "FAIL: missing -title"; exit 1; }
grep -qx -- 'Build done' "$TMP/tn-args.txt" || { echo "FAIL: title value not passed verbatim"; exit 1; }
grep -qx -- 'all green' "$TMP/tn-args.txt"  || { echo "FAIL: message value not passed verbatim"; exit 1; }
grep -qx -- 'from MBP' "$TMP/tn-args.txt"   || { echo "FAIL: subtitle value not passed verbatim"; exit 1; }
grep -qx -- '-sound' "$TMP/tn-args.txt"     || { echo "FAIL: -sound flag missing for default"; exit 1; }
grep -qx -- 'agent-bridge' "$TMP/tn-args.txt" || { echo "FAIL: default -group agent-bridge missing"; exit 1; }

# --- 2. notify <local-name> takes the local render path too ----------------
rm -f "$TMP/tn-args.txt"
set +e
OUT="$(run_cli notify TestHost --title "T" --message "M" 2>&1)"
EXIT=$?
set -e
[ "$EXIT" -eq 0 ] || { echo "FAIL: notify <local-name> should exit 0 (got $EXIT): $OUT"; exit 1; }
[ -f "$TMP/tn-args.txt" ] || { echo "FAIL: local-name route did not render locally"; exit 1; }

# --- 3. --sound none => silent (no -sound flag) ----------------------------
rm -f "$TMP/tn-args.txt"
run_cli notify --local --title "T" --message "M" --sound none >/dev/null 2>&1
if grep -qx -- '-sound' "$TMP/tn-args.txt"; then
  echo "FAIL: --sound none should omit the -sound flag"; exit 1
fi

# --- 4. missing --title dies -----------------------------------------------
set +e
run_cli notify --local --message "M" >/dev/null 2>&1
EXIT=$?
set -e
[ "$EXIT" -ne 0 ] || { echo "FAIL: missing --title should be a non-zero error"; exit 1; }

# --- 5. missing --message dies ---------------------------------------------
set +e
run_cli notify --local --title "T" >/dev/null 2>&1
EXIT=$?
set -e
[ "$EXIT" -ne 0 ] || { echo "FAIL: missing --message should be a non-zero error"; exit 1; }

# --- 6. osascript fallback when terminal-notifier absent -------------------
# Remove the terminal-notifier stub from PATH and add an osascript stub.
rm -f "$TMP/bin/terminal-notifier"
cat >"$TMP/bin/osascript" <<OSA
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$TMP/osa-args.txt"
exit 0
OSA
chmod +x "$TMP/bin/osascript"
# Use a PATH that has the stub dir + base system dirs (so bash/sed/printf work)
# but EXCLUDES Homebrew (/opt/homebrew/bin) so the real terminal-notifier is not
# found and the osascript fallback is exercised.
set +e
OUT="$(HOME="$TMP" PATH="$TMP/bin:/usr/bin:/bin" AGENT_BRIDGE_MACHINE_NAME=TestHost \
  bash "$ROOT/agent-bridge" notify --local --title "Hi" --message "there" --subtitle "sub" 2>&1)"
EXIT=$?
set -e
[ "$EXIT" -eq 0 ] || { echo "FAIL: osascript fallback should exit 0 (got $EXIT): $OUT"; exit 1; }
[ -f "$TMP/osa-args.txt" ] || { echo "FAIL: osascript fallback was not invoked"; exit 1; }
# Subtitle must be folded into the title as "Hi — sub" in the script body.
grep -q 'Hi — sub' "$TMP/osa-args.txt" || { echo "FAIL: subtitle not folded into title on osascript fallback"; exit 1; }

echo "cli-notify.sh: all checks passed"
