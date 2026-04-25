#!/usr/bin/env bash
# Tests for same-machine delivery CLI behaviour (3.5.0+).
#
# • `agent-bridge status local`        → reports LOCAL, exit 0, no ssh call
# • `agent-bridge status <hostname>`   → reports LOCAL when the name matches
# • `agent-bridge run local …`         → errors out (no SSH loopback)
# • `agent-bridge connect local`       → errors out (no SSH loopback)
# • `agent-bridge pair --name local …` → errors out (reserved alias)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.agent-bridge" "$TMP/bin"

# Stub ssh so any accidental invocation is loud.
cat >"$TMP/bin/ssh" <<'SSH'
#!/usr/bin/env bash
echo "FAIL: ssh should not be invoked for local-machine routes" >&2
exit 99
SSH
chmod +x "$TMP/bin/ssh"

# `agent-bridge status local` — must succeed and not call ssh.
OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" status local)"
grep -q 'LOCAL' <<<"$OUTPUT" || { echo "FAIL: status local should print LOCAL"; exit 1; }
grep -q 'TestHost' <<<"$OUTPUT" || { echo "FAIL: status local should print local machine name"; exit 1; }

# `agent-bridge status TestHost` — same as `local`.
OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" status TestHost)"
grep -q 'LOCAL' <<<"$OUTPUT" || { echo "FAIL: status <local-name> should print LOCAL"; exit 1; }

# `agent-bridge run local …` — must die with a helpful message.
set +e
RUN_OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" run local "ls" 2>&1)"
RUN_EXIT=$?
set -e
[ "$RUN_EXIT" -ne 0 ] || { echo "FAIL: run local should exit non-zero"; exit 1; }
grep -q 'local machine' <<<"$RUN_OUTPUT" || { echo "FAIL: run local should mention local machine"; exit 1; }

# `agent-bridge connect local` — must die.
set +e
CONNECT_OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" connect local 2>&1)"
CONNECT_EXIT=$?
set -e
[ "$CONNECT_EXIT" -ne 0 ] || { echo "FAIL: connect local should exit non-zero"; exit 1; }

# `agent-bridge pair --name local …` — must die before touching config.
set +e
PAIR_OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" pair --name local --host 1.2.3.4 --user u --token t --pubkey "ssh-ed25519 AAA" 2>&1)"
PAIR_EXIT=$?
set -e
[ "$PAIR_EXIT" -ne 0 ] || { echo "FAIL: pair --name local should exit non-zero"; exit 1; }
grep -q 'reserved' <<<"$PAIR_OUTPUT" || { echo "FAIL: pair error should explain alias is reserved"; exit 1; }

echo "cli-local-status.sh: all checks passed"
