#!/usr/bin/env bash
# Tests for the `agent-bridge learnings` CLI verbs (4.9.0+) — the bash half of
# the mirrored bash/TS shared-context store (TS half is pinned by
# mcp-server/test/learnings-store.test.mjs).
#
# Coverage:
#   • add --no-push          → NDJSON entry with lowercase uuid id, tags
#                              normalized, scope=global; no ssh touched
#   • add (with a paired machine) → push-on-write SSHes the peer with
#                              `learnings ingest --json …` (stubbed ssh)
#   • add missing --title    → dies
#   • search                 → keyword hit, --tag filter, miss message
#   • list --json            → raw store lines (sync's bulk-fetch endpoint)
#   • show <id>              → renders the entry
#   • ingest --json          → duplicate id is a counted no-op (idempotency)
#   • ingest --stdin         → batch: new + duplicate + invalid all counted,
#                              bad lines never abort the batch
#   • ingest UPPERCASE id    → lowercased on ingest (bridge id convention)
#   • remove <id>            → entry gone; unknown id dies
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.agent-bridge" "$TMP/bin"
STORE="$TMP/.agent-bridge/shared-context/learnings.ndjson"

# Stub ssh — records its full argv so the push-on-write test can assert on the
# remote command, and exits 0 so add treats the peer as reachable. Tests that
# must NOT touch ssh check the recording file stays absent.
cat >"$TMP/bin/ssh" <<SSH
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$TMP/ssh-args.txt"
exit 0
SSH
chmod +x "$TMP/bin/ssh"

run_cli() {
  # AGENT_BRIDGE_HOME pins the state dir explicitly: without it, the CLI's
  # sandboxed-HOME fallback (4.4.0) sees no config under $TMP and silently
  # repoints at the REAL user home — which would make this test write into
  # the developer's live learnings store.
  HOME="$TMP" AGENT_BRIDGE_HOME="$TMP/.agent-bridge" PATH="$TMP/bin:$PATH" \
    AGENT_BRIDGE_MACHINE_NAME=TestHost "$ROOT/agent-bridge" "$@"
}

# --- 1. add --no-push writes a valid entry, never touches ssh ---------------
run_cli learnings add --no-push --title "Surfshark IKEv2 dialog loop" \
  --body $'Symptom: password dialog loop\nFix: switch to WireGuard' \
  --tags "VPN, macos , vpn" >/dev/null
[ -f "$STORE" ] || { echo "FAIL: store file not created"; exit 1; }
[ "$(wc -l < "$STORE" | tr -d ' ')" = "1" ] || { echo "FAIL: expected exactly 1 line"; exit 1; }
[ ! -f "$TMP/ssh-args.txt" ] || { echo "FAIL: --no-push must not invoke ssh"; exit 1; }
ID="$(jq -r '.id' "$STORE")"
[ "$ID" = "$(printf '%s' "$ID" | tr '[:upper:]' '[:lower:]')" ] || { echo "FAIL: id not lowercase"; exit 1; }
[ "$(jq -r '.scope' "$STORE")" = "global" ] || { echo "FAIL: scope != global"; exit 1; }
[ "$(jq -r '.machine' "$STORE")" = "TestHost" ] || { echo "FAIL: machine attribution wrong"; exit 1; }
# tags: lowercased, trimmed, deduped → ["vpn","macos"]
[ "$(jq -c '.tags | sort' "$STORE")" = '["macos","vpn"]' ] || { echo "FAIL: tags not normalized: $(jq -c '.tags' "$STORE")"; exit 1; }
echo "ok 1 - add --no-push"

# --- 2. add missing --title dies --------------------------------------------
set +e
run_cli learnings add --no-push --body "b" >/dev/null 2>&1
EXIT=$?
set -e
[ "$EXIT" -ne 0 ] || { echo "FAIL: add without --title should die"; exit 1; }
echo "ok 2 - missing --title dies"

# --- 3. search: keyword hit, tag filter, miss --------------------------------
OUT="$(run_cli learnings search wireguard)"
printf '%s' "$OUT" | grep -q "Surfshark IKEv2" || { echo "FAIL: search by body keyword missed"; exit 1; }
OUT="$(run_cli learnings search --tag macos)"
printf '%s' "$OUT" | grep -q "Surfshark IKEv2" || { echo "FAIL: search by tag missed"; exit 1; }
OUT="$(run_cli learnings search zzznotthere)"
printf '%s' "$OUT" | grep -qi "no matching" || { echo "FAIL: miss message absent"; exit 1; }
echo "ok 3 - search"

# --- 4. list --json emits the raw store line ---------------------------------
OUT="$(run_cli learnings list --json)"
[ "$OUT" = "$(cat "$STORE")" ] || { echo "FAIL: list --json != raw store"; exit 1; }
echo "ok 4 - list --json"

# --- 5. show <id> renders the entry ------------------------------------------
OUT="$(run_cli learnings show "$ID")"
printf '%s' "$OUT" | grep -q "Surfshark IKEv2" || { echo "FAIL: show missed title"; exit 1; }
printf '%s' "$OUT" | grep -q "id: $ID" || { echo "FAIL: show missed id"; exit 1; }
echo "ok 5 - show"

# --- 6. ingest --json duplicate is a counted no-op ---------------------------
OUT="$(run_cli learnings ingest --json "$(cat "$STORE")")"
printf '%s' "$OUT" | grep -q "duplicate=1" || { echo "FAIL: duplicate not counted: $OUT"; exit 1; }
[ "$(wc -l < "$STORE" | tr -d ' ')" = "1" ] || { echo "FAIL: duplicate ingest appended"; exit 1; }
echo "ok 6 - ingest duplicate no-op"

# --- 7. ingest --stdin batch: new + duplicate + invalid ----------------------
NEW='{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","ts":"2026-07-14T00:00:00Z","machine":"Other","harness":"openclaw/x","title":"batch new","body":"b","tags":[],"scope":"global","v":1}'
OUT="$(printf '%s\n%s\nGARBAGE NOT JSON\n' "$NEW" "$(cat "$STORE" | head -1)" | run_cli learnings ingest --stdin)"
printf '%s' "$OUT" | grep -q "ingested=1 duplicate=1 invalid=1" || { echo "FAIL: batch counts wrong: $OUT"; exit 1; }
[ "$(wc -l < "$STORE" | tr -d ' ')" = "2" ] || { echo "FAIL: batch should net exactly 1 new line"; exit 1; }
echo "ok 7 - ingest --stdin batch"

# --- 8. ingest UPPERCASE id gets lowercased (bridge id convention) -----------
UP='{"id":"FFFFFFFF-1111-2222-3333-444444444444","ts":"2026-07-14T00:00:00Z","machine":"M","harness":"h","title":"upper id","body":"b"}'
run_cli learnings ingest --json "$UP" >/dev/null
grep -q 'ffffffff-1111-2222-3333-444444444444' "$STORE" || { echo "FAIL: uppercase id not lowercased"; exit 1; }
grep -q 'FFFFFFFF' "$STORE" && { echo "FAIL: uppercase id stored verbatim"; exit 1; }
echo "ok 8 - uppercase id normalized"

# --- 9. remove <id> deletes; unknown id dies ---------------------------------
run_cli learnings remove aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee >/dev/null
grep -q 'aaaaaaaa-bbbb' "$STORE" && { echo "FAIL: removed entry still present"; exit 1; }
set +e
run_cli learnings remove aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee >/dev/null 2>&1
EXIT=$?
set -e
[ "$EXIT" -ne 0 ] || { echo "FAIL: removing unknown id should die"; exit 1; }
echo "ok 9 - remove"

# --- 10. add with a paired machine push-on-writes over (stubbed) ssh ---------
cat >"$TMP/.agent-bridge/config" <<CFG
[FakePeer]
host=192.0.2.1
user=test
port=22
CFG
rm -f "$TMP/ssh-args.txt"
run_cli learnings add --title "push test" --body "b" >/dev/null 2>&1
[ -f "$TMP/ssh-args.txt" ] || { echo "FAIL: add did not attempt peer push"; exit 1; }
# The remote command arrives printf-%q escaped (spaces become "\ "), so match
# the escaped literal with grep -F.
grep -qF 'learnings\ ingest\ --json' "$TMP/ssh-args.txt" || { echo "FAIL: push did not run remote ingest: $(cat "$TMP/ssh-args.txt")"; exit 1; }
grep -q "test@192.0.2.1" "$TMP/ssh-args.txt" || { echo "FAIL: push did not target the peer"; exit 1; }
echo "ok 10 - push-on-write"

echo "ALL cli-learnings tests passed"
