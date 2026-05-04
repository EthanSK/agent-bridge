#!/usr/bin/env bash
# agent-bridge/scripts/install-periodic-update.sh
# -----------------------------------------------
# [PERIODIC-UPDATE 2026-05-04]
#
# Provisions a launchd LaunchAgent that runs scripts/agent-bridge-periodic-update.sh
# every 10 minutes (and at user login). This is the harness-INDEPENDENT half of
# auto-update: it fires whether or not Claude Code / OpenClaw is running.
#
# Idempotent: re-running tears down any prior agent under the same Label,
# regenerates the plist with up-to-date paths, then bootstraps fresh.
#
# Usage:
#   scripts/install-periodic-update.sh [--with-openclaw-mcp-repair]
#
# Options:
#   --with-openclaw-mcp-repair  pass through to the body script so each
#                               periodic run also re-asserts the OpenClaw MCP
#                               server entry against the dev clone's
#                               mcp-server/build/index.js.
#
# Plist:
#   ~/Library/LaunchAgents/com.ethansk.agent-bridge.periodic-update.plist
#
# Logs:
#   stdout/stderr → ~/.agent-bridge/logs/periodic-update.log

set -euo pipefail

WITH_OPENCLAW_MCP_REPAIR=0
for arg in "$@"; do
  case "$arg" in
    --with-openclaw-mcp-repair) WITH_OPENCLAW_MCP_REPAIR=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------- Resolve paths ---------------------------------------------------

# Resolve the real path of this script, following symlinks.
SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SRC" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
  SCRIPT_SRC="$(readlink "$SCRIPT_SRC")"
  [[ "$SCRIPT_SRC" != /* ]] && SCRIPT_SRC="$DIR/$SCRIPT_SRC"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BODY_SCRIPT="$REPO_ROOT/scripts/agent-bridge-periodic-update.sh"
[ -f "$BODY_SCRIPT" ] || { echo "ERROR: $BODY_SCRIPT not found" >&2; exit 1; }
chmod +x "$BODY_SCRIPT" 2>/dev/null || true

LABEL="com.ethansk.agent-bridge.periodic-update"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
LOG_DIR="$HOME/.agent-bridge/logs"
LOG_FILE="$LOG_DIR/periodic-update.log"

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

# ---------- Compose ProgramArguments ---------------------------------------

# Build the body-args XML once so the plist heredoc stays clean.
BODY_ARGS_XML="    <string>$BODY_SCRIPT</string>"
if [[ "$WITH_OPENCLAW_MCP_REPAIR" == "1" ]]; then
  BODY_ARGS_XML+=$'\n    <string>--with-openclaw-mcp-repair</string>'
fi

# Resolve a sensible PATH with nvm node prepended when present, mirroring the
# body script's own export.
NVM_NODE="$HOME/.nvm/versions/node/v22.22.2/bin"
PATH_VALUE="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -d "$NVM_NODE" ] && PATH_VALUE="$NVM_NODE:$PATH_VALUE"

# ---------- Write plist ----------------------------------------------------

PLIST_TMP="$(mktemp)"
cat > "$PLIST_TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
${BODY_ARGS_XML}
  </array>

  <key>StartInterval</key>
  <integer>600</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>AGENT_BRIDGE_REPO</key>
    <string>${REPO_ROOT}</string>
  </dict>
</dict>
</plist>
EOF

# Validate XML before installing (plutil is on every macOS).
if command -v plutil >/dev/null 2>&1; then
  if ! plutil -lint "$PLIST_TMP" >/dev/null 2>&1; then
    echo "ERROR: generated plist failed plutil -lint" >&2
    cat "$PLIST_TMP" >&2
    rm -f "$PLIST_TMP"
    exit 1
  fi
fi

mv "$PLIST_TMP" "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

# ---------- Bootstrap (idempotent: bootout first, then bootstrap) ----------

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
fi

if launchctl bootstrap "${DOMAIN}" "$PLIST_PATH"; then
  echo "[ok] LaunchAgent installed: $PLIST_PATH"
  echo "     Label:       $LABEL"
  echo "     Interval:    600s (also fires at login)"
  echo "     Body script: $BODY_SCRIPT"
  echo "     Log file:    $LOG_FILE"
  if [[ "$WITH_OPENCLAW_MCP_REPAIR" == "1" ]]; then
    echo "     OpenClaw MCP repair: ENABLED"
  fi
else
  rc=$?
  echo "ERROR: launchctl bootstrap failed (rc=$rc)" >&2
  exit "$rc"
fi
