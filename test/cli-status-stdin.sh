#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.agent-bridge" "$TMP/bin"
cat >"$TMP/.agent-bridge/config" <<'CONFIG'
[one]
host=127.0.0.1
user=test
port=22
key=(system default)

[two]
host=127.0.0.2
user=test
port=22
key=(system default)
CONFIG

cat >"$TMP/bin/ssh" <<'SSH'
#!/usr/bin/env bash
cat >/dev/null
exit 0
SSH
chmod +x "$TMP/bin/ssh"

OUTPUT="$(HOME="$TMP" PATH="$TMP/bin:$PATH" "$ROOT/agent-bridge" status)"

grep -q 'one' <<<"$OUTPUT"
grep -q 'two' <<<"$OUTPUT"
grep -q '2/2 remote machines reachable' <<<"$OUTPUT"
# 3.5.0+: status output now includes the local pseudo-machine line as well.
grep -q 'LOCAL' <<<"$OUTPUT"
