#!/usr/bin/env bash
set -euo pipefail

# agent-bridge installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.sh | bash

REPO_BASE="https://raw.githubusercontent.com/EthanSK/agent-bridge/main"
REPO="$REPO_BASE/agent-bridge"
REWIRE_SCRIPT_URL="$REPO_BASE/scripts/plugin-registry-rewire.mjs"
INSTALL_DIR="/usr/local/bin"
BIN_NAME="agent-bridge"
REWIRE_SCRIPT_NAME="plugin-registry-rewire.mjs"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

printf '\n'
printf "${BOLD}${CYAN}  agent-bridge installer${RESET}\n"
printf '\n'

# Check for curl or wget
if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  printf "${RED}  Error: curl or wget required.${RESET}\n"
  exit 1
fi

# Download
printf "${DIM}  Downloading agent-bridge...${RESET}\n"
TMPFILE="$(mktemp)"
$FETCH "$REPO" > "$TMPFILE"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "$INSTALL_DIR/$BIN_NAME"
  chmod +x "$INSTALL_DIR/$BIN_NAME"
else
  printf "${DIM}  Installing to %s (requires sudo)...${RESET}\n" "$INSTALL_DIR"
  sudo mv "$TMPFILE" "$INSTALL_DIR/$BIN_NAME"
  sudo chmod +x "$INSTALL_DIR/$BIN_NAME"
fi

# Create backward-compat symlink
if [ -w "$INSTALL_DIR" ]; then
  ln -sf "$INSTALL_DIR/$BIN_NAME" "$INSTALL_DIR/claude-bridge" 2>/dev/null || true
else
  sudo ln -sf "$INSTALL_DIR/$BIN_NAME" "$INSTALL_DIR/claude-bridge" 2>/dev/null || true
fi

# Bundle plugin-registry-rewire.mjs next to the bin so the CLI can find it
# on installations that don't have a workspace clone in a known location.
# (CLI also searches dev-clone paths; this is the bin-bundled fallback.)
TMPREWIRE="$(mktemp)"
if $FETCH "$REWIRE_SCRIPT_URL" > "$TMPREWIRE" 2>/dev/null && [ -s "$TMPREWIRE" ]; then
  if [ -w "$INSTALL_DIR" ]; then
    mv "$TMPREWIRE" "$INSTALL_DIR/$REWIRE_SCRIPT_NAME"
    chmod +x "$INSTALL_DIR/$REWIRE_SCRIPT_NAME"
  else
    sudo mv "$TMPREWIRE" "$INSTALL_DIR/$REWIRE_SCRIPT_NAME"
    sudo chmod +x "$INSTALL_DIR/$REWIRE_SCRIPT_NAME"
  fi
else
  rm -f "$TMPREWIRE"
  printf "${DIM}  (note: could not fetch plugin-registry-rewire.mjs; CLI will fall back to dev-clone search)${RESET}\n"
fi

printf '\n'
printf "${GREEN}${BOLD}  [ok] agent-bridge installed to %s/%s${RESET}\n" "$INSTALL_DIR" "$BIN_NAME"
printf '\n'

# --------------------------------------------------------------------------
# Optional: register the agent-bridge plugin in ~/.claude/settings.json so
# Claude Code auto-loads bridge_send_message + the inbound channel watcher
# on next session start.
#
# Mirrors the Windows install.ps1 logic: directory-source plugin
# marketplace + enabledPlugins entry. Idempotent. Skips silently if the
# user is not a Claude Code user (no ~/.claude/) or if a local clone with
# .claude-plugin/marketplace.json cannot be located.
# --------------------------------------------------------------------------
CLAUDE_DIR="$HOME/.claude"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"

if [ -d "$CLAUDE_DIR" ]; then
  PLUGIN_SOURCE=""
  # Try the directory containing this install.sh (cloned repo case).
  SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/.claude-plugin/marketplace.json" ]; then
    PLUGIN_SOURCE="$SCRIPT_DIR"
  elif [ -f "$HOME/Projects/agent-bridge/.claude-plugin/marketplace.json" ]; then
    PLUGIN_SOURCE="$HOME/Projects/agent-bridge"
  fi

  if [ -z "$PLUGIN_SOURCE" ]; then
    printf "${DIM}  [skip] No local agent-bridge clone with .claude-plugin/marketplace.json found —${RESET}\n"
    printf "${DIM}         skipping Claude Code plugin registration. Clone the repo and re-run${RESET}\n"
    printf "${DIM}         install.sh to enable bridge_send_message in Claude Code.${RESET}\n"
  else
    PYBIN=""
    if command -v python3 >/dev/null 2>&1; then PYBIN=python3
    elif command -v python  >/dev/null 2>&1; then PYBIN=python
    fi

    if [ -z "$PYBIN" ]; then
      printf "${DIM}  [skip] python3 not found — cannot edit settings.json safely. See README, \"MCP server registration\", for the manual JSON snippet.${RESET}\n"
    else
      PLUGIN_SOURCE="$PLUGIN_SOURCE" SETTINGS_PATH="$SETTINGS_PATH" "$PYBIN" - <<'PYEOF'
import json, os, pathlib, sys
p = pathlib.Path(os.environ["SETTINGS_PATH"])
src = os.environ["PLUGIN_SOURCE"]
if p.exists():
    data = json.loads(p.read_text(encoding="utf-8"))
else:
    data = {}
data.setdefault("extraKnownMarketplaces", {})
data.setdefault("enabledPlugins", {})
changed = False
if "agent-bridge" not in data["extraKnownMarketplaces"]:
    data["extraKnownMarketplaces"]["agent-bridge"] = {
        "source": {"source": "directory", "path": src}
    }
    changed = True
if not data["enabledPlugins"].get("agent-bridge@agent-bridge"):
    data["enabledPlugins"]["agent-bridge@agent-bridge"] = True
    changed = True
if changed:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print("registered")
else:
    print("already")
PYEOF
      RC=$?
      if [ $RC -eq 0 ]; then
        printf "${GREEN}  [ok] Registered agent-bridge plugin in %s${RESET}\n" "$SETTINGS_PATH"
        printf "${GREEN}       Restart Claude Code to load bridge_send_message.${RESET}\n"
      else
        printf "${DIM}  [warn] Could not auto-register Claude Code plugin (rc=%s). See README.${RESET}\n" "$RC"
      fi
    fi
  fi
fi

printf '\n'
printf "  Get started:\n"
printf "${DIM}    agent-bridge setup${RESET}\n"
printf "${DIM}    agent-bridge help${RESET}\n"
printf '\n'
