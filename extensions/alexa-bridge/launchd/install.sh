#!/usr/bin/env bash
# ============================================================================
# install.sh — install (or reinstall) the alexa-bridge receiver LaunchAgent.
#
# Renders the plist template with this machine's real paths, drops it into
# ~/Library/LaunchAgents, and (re)bootstraps it so the Alexa receiver runs now
# and on every login/reboot.
#
# Idempotent: re-running re-renders + reloads. Safe to run after a `git pull`.
#
# Env you can set before running:
#   ALEXA_BRIDGE_PORT    → port the receiver binds (default 8787)
#   ALEXA_BRIDGE_SECRET  → optional shared secret baked into the plist (default empty)
#
# Usage:   ./launchd/install.sh
# Logs:    ~/.agent-bridge/alexa-bridge/logs/alexa-bridge.{out,err}.log
# Stop:    launchctl bootout gui/$(id -u)/com.ethansk.agent-bridge-alexa-bridge
# Restart: launchctl kickstart -k gui/$(id -u)/com.ethansk.agent-bridge-alexa-bridge
# ============================================================================
set -euo pipefail

LABEL="com.ethansk.agent-bridge-alexa-bridge"

# Resolve paths relative to this script so it works wherever the repo lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"           # the extension root
SERVER_JS="$EXT_DIR/src/server.mjs"
TEMPLATE="$SCRIPT_DIR/${LABEL}.plist.template"

# Find node robustly (Homebrew first, then PATH).
NODE_BIN="$(command -v node || true)"
if [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node; fi
if [ -z "$NODE_BIN" ]; then echo "ERROR: node not found on PATH" >&2; exit 1; fi

# Port + optional secret (env-overridable; defaults match server.mjs).
PORT="${ALEXA_BRIDGE_PORT:-8787}"
SECRET="${ALEXA_BRIDGE_SECRET:-}"

# Persistent log dir.
LOG_DIR="$HOME/.agent-bridge/alexa-bridge/logs"
mkdir -p "$LOG_DIR"

PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "Rendering LaunchAgent plist…"
echo "  node:    $NODE_BIN"
echo "  server:  $SERVER_JS"
echo "  port:    $PORT"
echo "  secret:  $([ -n "$SECRET" ] && echo '(set)' || echo '(none)')"

# Render the template → dest, substituting the placeholders.
# NOTE: we use a non-/ sed delimiter (|) because paths contain /.
sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__SERVER_JS__|$SERVER_JS|g" \
  -e "s|__WORKDIR__|$EXT_DIR|g" \
  -e "s|__PORT__|$PORT|g" \
  -e "s|__SECRET__|$SECRET|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$PLIST_DEST"

# (Re)load. bootout first (ignore failure if not loaded), then bootstrap.
echo "Reloading LaunchAgent…"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "Installed + started: $LABEL"
echo "Health check: curl -s http://localhost:${PORT}/health"
echo "Tail logs with: tail -f $LOG_DIR/alexa-bridge.out.log"
