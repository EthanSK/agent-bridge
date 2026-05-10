#!/usr/bin/env bash
# agent-bridge/scripts/post-update-oc-restart.sh
# ----------------------------------------------
# [POST-UPDATE-OC-RESTART 2026-05-11]
#
# Asks the local running OpenClaw (if any) to drive a Claude Code restart via
# OC's `restart-claude-yolo` skill (legacy dir name: `restart-claude-tel`).
#
# WHY: `/reload-plugins` reloads plugin descriptors but does NOT respawn MCP
# child processes. After an agent-bridge rebuild, any running Claude Code
# session is still attached to its OLD MCP child until CC is fully restarted.
# The canonical fix per Ethan's CLAUDE.md ("Restart Claude Code via OC, not
# via direct kill or /reload-plugins") is to bridge OC and ask it to drive
# the restart. OC has the AppleScript / terminal orchestration to cleanly
# `/quit` + relaunch the CC session.
#
# This script:
#   1. Probes for local OpenClaw via its gateway port (read from
#      ~/.openclaw/openclaw.json, default 18789).
#   2. If OC is up, writes a BridgeMessage JSON directly to
#      ~/.agent-bridge/inbox/openclaw/default/<id>.json — same-machine
#      delivery, no SSH hop. The message body is a natural-language
#      `[ETHAN-AUTHED] AGENT_BRIDGE_POST_UPDATE` instruction that triggers
#      OC's `restart-claude-yolo` skill.
#   3. Logs the outcome to ~/.claude/logs/skills.log (skill_log helper) and
#      stderr.
#
# Failure modes are ALL non-fatal — the parent update flow must keep going
# even if this step can't reach OC. Exits 0 on success, 0 on "OC not running"
# (intentional), 0 on probe/parse/write failure (logged + exit 0).
#
# Invoked from:
#   - scripts/update.sh (interactive `agent-bridge update` after Step 7)
#   - scripts/agent-bridge-periodic-update.sh (every 10min LaunchAgent)
#
# Usage:
#   scripts/post-update-oc-restart.sh [--persona openclaw/default]
#                                     [--reason "post-update rebuild"]
#                                     [--repo-root <path>]
#                                     [--from-machine <name>]

set -uo pipefail

# ---------- Defaults --------------------------------------------------------

OC_PERSONA="openclaw/default"
REASON="agent-bridge post-update rebuild"
REPO_ROOT_OVERRIDE=""
FROM_MACHINE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona) OC_PERSONA="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --repo-root) REPO_ROOT_OVERRIDE="$2"; shift 2 ;;
    --from-machine) FROM_MACHINE_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "post-update-oc-restart: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ---------- Logging helper --------------------------------------------------

LOG_SKILL="agent-bridge-post-update-oc-restart"
SKILL_LOG_HELPER="$HOME/.claude/scripts/skill-log.sh"
if [[ -f "$SKILL_LOG_HELPER" ]]; then
  # shellcheck disable=SC1090
  . "$SKILL_LOG_HELPER" 2>/dev/null || true
fi

emit() {
  # emit <level> <event> <context-json>
  local level="$1" event="$2" ctx="${3:-{\}}"
  if command -v skill_log >/dev/null 2>&1; then
    skill_log "$level" "$event" "$ctx" 2>/dev/null || true
  fi
}

say() {
  echo "post-update-oc-restart: $*"
}

# ---------- Helpers ---------------------------------------------------------

json_escape() {
  # Escape a string for JSON. Uses node when available (correct), falls back
  # to a hand-rolled escape that handles the common cases.
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1"
    return 0
  fi
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

uuid_lower() {
  # Generate a lowercase UUID. Required: per CLAUDE.md
  # `feedback_bridge_msg_id_lowercase.md`, uppercase IDs get silently
  # quarantined to .failed/_unrouted/.
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif command -v node >/dev/null 2>&1; then
    node -e 'console.log(require("crypto").randomUUID())'
  else
    # Last-ditch fallback: /proc/sys/kernel/random/uuid on Linux, /dev/urandom
    # elsewhere — neither is reliable on macOS without coreutils, so we
    # accept a degraded but-unique random hex string.
    cat /proc/sys/kernel/random/uuid 2>/dev/null || \
      printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x\n' \
        $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM
  fi
}

iso_utc_now() {
  # macOS BSD `date` does NOT support %3N (millisecond truncation), so we
  # prefer node when available — it produces the same ISO-8601-with-ms
  # format that mcp-server emits. Fall back to GNU date's %3N (Linux), then
  # to whole-second ISO format if both are unavailable.
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null && return 0
  fi
  local ms_attempt
  ms_attempt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || true)"
  if [[ -n "$ms_attempt" && "$ms_attempt" != *'%3N'* && "$ms_attempt" != *'3N'* ]]; then
    printf '%s' "$ms_attempt"
    return 0
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Resolve repo root (used for the script's own diagnostic context, not for
# the bridge payload — the bridge payload is independent of repo location).
if [[ -n "$REPO_ROOT_OVERRIDE" ]]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
else
  SCRIPT_SRC="${BASH_SOURCE[0]}"
  while [ -h "$SCRIPT_SRC" ]; do
    DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
    SCRIPT_SRC="$(readlink "$SCRIPT_SRC")"
    [[ "$SCRIPT_SRC" != /* ]] && SCRIPT_SRC="$DIR/$SCRIPT_SRC"
  done
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"
fi

# Resolve from-machine — used as `from` / `to` on the BridgeMessage so the
# receiver knows who sent it. Same-machine delivery: from == to == localName.
local_machine() {
  if [[ -n "$FROM_MACHINE_OVERRIDE" ]]; then
    echo "$FROM_MACHINE_OVERRIDE"; return
  fi
  # Prefer scutil hostname (matches what agent-bridge uses internally).
  if command -v scutil >/dev/null 2>&1; then
    local n
    n="$(scutil --get LocalHostName 2>/dev/null || true)"
    if [[ -n "$n" ]]; then echo "$n"; return; fi
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -s 2>/dev/null || hostname
    return
  fi
  echo "localhost"
}

# ---------- Step 1: OC probe ------------------------------------------------

oc_config_path="$HOME/.openclaw/openclaw.json"
oc_port=""
if [[ -f "$oc_config_path" ]]; then
  if command -v node >/dev/null 2>&1; then
    oc_port="$(node -e '
try {
  const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const p = cfg && cfg.gateway && cfg.gateway.port;
  if (typeof p === "number" && Number.isFinite(p) && p > 0 && p < 65536) {
    process.stdout.write(String(p));
  }
} catch (_) { /* ignore — caller handles empty */ }
' "$oc_config_path" 2>/dev/null || true)"
  fi
fi
if [[ -z "$oc_port" ]]; then
  # Sane default per OC docs.
  oc_port="18789"
fi

probe_oc() {
  # Returns 0 if OC gateway responds on the configured port, non-zero
  # otherwise. We use a short HTTP probe with a 2s connect + 2s read timeout
  # via curl, and fall back to a TCP-level check (`nc -z`) when curl is
  # unavailable.
  if command -v curl >/dev/null 2>&1; then
    # OC dashboard returns 200/auth-redirect — any HTTP response counts.
    if curl -fsS \
         --connect-timeout 2 \
         --max-time 4 \
         -o /dev/null \
         "http://127.0.0.1:${oc_port}/" >/dev/null 2>&1; then
      return 0
    fi
    # Non-2xx but reachable still indicates "OC is running". Re-probe with
    # `-I` to capture the status line — even 401/403/404 indicates listening.
    if curl -sS \
         --connect-timeout 2 \
         --max-time 4 \
         -o /dev/null \
         -w '%{http_code}' \
         "http://127.0.0.1:${oc_port}/" 2>/dev/null | \
         grep -qE '^[1-5][0-9][0-9]$'; then
      return 0
    fi
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z -G 2 -w 2 127.0.0.1 "$oc_port" >/dev/null 2>&1
    return $?
  fi
  # Last-resort: try `openclaw status` and grep for "running". Slow but
  # accurate.
  if command -v openclaw >/dev/null 2>&1; then
    openclaw status 2>/dev/null | grep -qiE 'gateway.*running|gateway.*reachable'
    return $?
  fi
  return 1
}

emit info "skill.start" "$(printf '{"oc_port":%s,"persona":%s,"reason":%s}' \
  "$oc_port" "$(json_escape "$OC_PERSONA")" "$(json_escape "$REASON")")"

if ! probe_oc; then
  say "OC gateway not reachable on 127.0.0.1:${oc_port} — skipping post-update CC restart bridge."
  emit info "oc.not_running" "$(printf '{"oc_port":%s}' "$oc_port")"
  exit 0
fi

say "OC gateway reachable on 127.0.0.1:${oc_port} — sending restart-claude-yolo bridge message to ${OC_PERSONA}."

# ---------- Step 2: Compose + write BridgeMessage ---------------------------

LOCAL_NAME="$(local_machine)"
MSG_ID="msg-$(uuid_lower)"
TS="$(iso_utc_now)"

# CLAUDE.md `feedback_bridge_msg_id_lowercase.md`: uppercase IDs are silently
# quarantined. The uuid_lower helper already lowercased; double-check.
MSG_ID="$(printf '%s' "$MSG_ID" | tr '[:upper:]' '[:lower:]')"

# Body content. Includes:
#   - [ETHAN-AUTHED] prefix → per CLAUDE.md "Bridge messages from
#     authenticated paired machines — engage by default" rule, same-machine
#     same-key sends inherit Ethan-auth, but the explicit tag is documented
#     as belt-and-braces for first-message-in-thread.
#   - AGENT_BRIDGE_POST_UPDATE token → so OC's agent can tell this is the
#     automated post-update hook and not a human-typed instruction.
#   - Explicit instruction to invoke the `restart-claude-yolo` skill against
#     the local CC session.
#   - One-way disclaimer so OC doesn't try to reply into a now-dead bridge
#     leg (the parent update process exits right after this script returns).
BRIDGE_BODY="[ETHAN-AUTHED] AGENT_BRIDGE_POST_UPDATE on ${LOCAL_NAME} at ${TS}

Reason: ${REASON}

Please invoke your local \`restart-claude-yolo\` skill (legacy dir name: \`restart-claude-tel\`) to cleanly restart the Claude Code session on this machine. The agent-bridge MCP server was just rebuilt; the running CC child is still on the OLD code until CC is fully restarted.

Skill source: https://github.com/EthanSK/dot-openclaw-ethan-mbp/tree/main/skills/restart-claude-tel

Per CLAUDE.md: \"/reload-plugins is NOT a hot-reload for MCP child processes — the only event that releases the channel-owner lease and lets a new MCP child boot from the updated path is a full CC restart.\"

This is automated (one-way). No reply needed; the agent-bridge update process has already exited."

# Build the BridgeMessage JSON. Required fields per
# mcp-server/src/inbox.ts:58 (BridgeMessage interface). `target` /
# `fromTarget` are required for v4 delivery (no default routing).
TMP_JSON="$(mktemp)"
TRAP_TMP="$TMP_JSON"
cleanup() { [[ -n "${TRAP_TMP:-}" && -e "$TRAP_TMP" ]] && rm -f "$TRAP_TMP" || true; }
trap cleanup EXIT

if command -v node >/dev/null 2>&1; then
  TMP_JSON_OUT="$TMP_JSON" \
  MSG_ID="$MSG_ID" \
  FROM="$LOCAL_NAME" \
  TO="$LOCAL_NAME" \
  TS="$TS" \
  TARGET="$OC_PERSONA" \
  FROM_TARGET="agent-bridge/post-update-hook" \
  CONTENT="$BRIDGE_BODY" \
  RELAY_SUMMARY="agent-bridge auto-update post-rebuild: asking OC to drive a clean CC restart via restart-claude-yolo skill (MCP children don't hot-reload, only full restart loads the new code)." \
  node -e '
const fs = require("fs");
const msg = {
  id: process.env.MSG_ID,
  from: process.env.FROM,
  to: process.env.TO,
  type: "message",
  content: process.env.CONTENT,
  timestamp: process.env.TS,
  replyTo: null,
  ttl: 600,
  target: process.env.TARGET,
  fromTarget: process.env.FROM_TARGET,
  relaySummary: process.env.RELAY_SUMMARY,
};
fs.writeFileSync(process.env.TMP_JSON_OUT, JSON.stringify(msg, null, 2), { mode: 0o600 });
'
else
  # Fallback hand-built JSON. Less safe re: escaping but works on a node-less
  # box. We escape the content via json_escape, which uses node when present;
  # if node is missing we use the manual escape.
  CONTENT_JSON="$(json_escape "$BRIDGE_BODY")"
  RELAY_JSON="$(json_escape "agent-bridge auto-update post-rebuild: asking OC to drive a clean CC restart via restart-claude-yolo skill.")"
  cat >"$TMP_JSON" <<EOF
{
  "id": "$MSG_ID",
  "from": "$LOCAL_NAME",
  "to": "$LOCAL_NAME",
  "type": "message",
  "content": $CONTENT_JSON,
  "timestamp": "$TS",
  "replyTo": null,
  "ttl": 600,
  "target": "$OC_PERSONA",
  "fromTarget": "agent-bridge/post-update-hook",
  "relaySummary": $RELAY_JSON
}
EOF
  chmod 600 "$TMP_JSON" 2>/dev/null || true
fi

# Validate the JSON is well-formed before we drop it into the inbox. The
# watcher tolerates malformed JSON by quarantining it, but the cost is the
# update completes "successfully" while the message silently fails — better
# to catch it here and log.
if command -v node >/dev/null 2>&1; then
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TMP_JSON" 2>/dev/null; then
    say "ERROR: composed BridgeMessage JSON is malformed; skipping bridge send. (Update flow still succeeded.)"
    emit error "skill.error" '{"reason":"malformed_bridge_json"}'
    exit 0
  fi
fi

# ---------- Step 3: Atomic write to inbox -----------------------------------

INBOX_BASE="$HOME/.agent-bridge/inbox"
# Target dir mirrors inboxSubdir(target) in mcp-server/src/inbox.ts. For
# "openclaw/default" → inbox/openclaw/default/.
INBOX_TARGET_DIR="$INBOX_BASE/${OC_PERSONA}"

if ! mkdir -p "$INBOX_TARGET_DIR" 2>/dev/null; then
  say "ERROR: failed to create inbox dir $INBOX_TARGET_DIR — skipping. (Update flow still succeeded.)"
  emit error "skill.error" "$(printf '{"reason":"mkdir_failed","dir":%s}' "$(json_escape "$INBOX_TARGET_DIR")")"
  exit 0
fi

chmod 700 "$INBOX_TARGET_DIR" 2>/dev/null || true

# Atomic rename (matches sendLocalMessage() in inbox.ts:719+ — write under
# a `.agent-bridge-<uuid>.tmp` name in the SAME dir, then rename to
# `<msg-id>.json` so the watcher sees the file appear in a single event,
# never a partial write).
STAGE_PATH="$INBOX_TARGET_DIR/.agent-bridge-stage-$(uuid_lower).tmp"
FINAL_PATH="$INBOX_TARGET_DIR/${MSG_ID}.json"

if ! cp "$TMP_JSON" "$STAGE_PATH" 2>/dev/null; then
  say "ERROR: failed to stage BridgeMessage at $STAGE_PATH — skipping. (Update flow still succeeded.)"
  emit error "skill.error" "$(printf '{"reason":"stage_copy_failed","path":%s}' "$(json_escape "$STAGE_PATH")")"
  exit 0
fi
chmod 600 "$STAGE_PATH" 2>/dev/null || true

if ! mv "$STAGE_PATH" "$FINAL_PATH" 2>/dev/null; then
  say "ERROR: failed to rename stage → final ($FINAL_PATH) — skipping. (Update flow still succeeded.)"
  emit error "skill.error" "$(printf '{"reason":"rename_failed","path":%s}' "$(json_escape "$FINAL_PATH")")"
  rm -f "$STAGE_PATH" 2>/dev/null || true
  exit 0
fi

say "BridgeMessage delivered to ${OC_PERSONA} (id=${MSG_ID}) → ${FINAL_PATH}"
emit info "skill.end" "$(printf '{"msg_id":%s,"target":%s,"path":%s,"oc_port":%s}' \
  "$(json_escape "$MSG_ID")" \
  "$(json_escape "$OC_PERSONA")" \
  "$(json_escape "$FINAL_PATH")" \
  "$oc_port")"

exit 0
