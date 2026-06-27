#!/usr/bin/env bash
# ============================================================================
# install.sh — install (or reinstall) the google-home-matter LaunchAgent.
#
# Renders the plist template with this machine's real paths, drops it into
# ~/Library/LaunchAgents, and (re)bootstraps it so the Matter server runs now
# and on every login/reboot.
#
# Idempotent: re-running re-renders + reloads. Safe to run after a `git pull`.
#
# Usage:   ./launchd/install.sh
# Logs:    ~/.agent-bridge/google-home-matter/logs/google-home-matter.{out,err}.log
# Stop:    launchctl bootout gui/$(id -u)/com.ethansk.agent-bridge-google-home-matter
# Restart: launchctl kickstart -k gui/$(id -u)/com.ethansk.agent-bridge-google-home-matter
# ============================================================================
set -euo pipefail

LABEL="com.ethansk.agent-bridge-google-home-matter"

# Resolve paths relative to this script so it works wherever the repo lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"           # the extension root
SERVER_JS="$EXT_DIR/src/server.mjs"
TEMPLATE="$SCRIPT_DIR/${LABEL}.plist.template"

# Find node robustly (Homebrew first, then PATH).
NODE_BIN="$(command -v node || true)"
if [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node; fi
if [ -z "$NODE_BIN" ]; then echo "ERROR: node not found on PATH" >&2; exit 1; fi

# Persistent dirs for Matter commissioning state + logs.
STORAGE_DIR="$HOME/.agent-bridge/google-home-matter/storage"
LOG_DIR="$HOME/.agent-bridge/google-home-matter/logs"
mkdir -p "$STORAGE_DIR" "$LOG_DIR"

PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "Rendering LaunchAgent plist…"
echo "  node:    $NODE_BIN"
echo "  server:  $SERVER_JS"
echo "  storage: $STORAGE_DIR"

# Render the template → dest, substituting the placeholders.
sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__SERVER_JS__|$SERVER_JS|g" \
  -e "s|__WORKDIR__|$EXT_DIR|g" \
  -e "s|__STORAGE_DIR__|$STORAGE_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$PLIST_DEST"

# (Re)load. bootout first (ignore failure if not loaded), then bootstrap.
echo "Reloading LaunchAgent…"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "Installed + started: $LABEL"
echo "Tail logs with: tail -f $LOG_DIR/google-home-matter.out.log"
