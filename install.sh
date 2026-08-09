#!/usr/bin/env bash
set -euo pipefail

# agent-bridge installer
# Usage: curl -fsSL https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.sh | bash

# Overridable for hermetic testing / custom layouts (defaults unchanged for
# the documented one-line install):
#   AGENT_BRIDGE_REPO_BASE            file:// or https:// base for CLI fetches
#   AGENT_BRIDGE_INSTALL_DIR          bin dir (default /usr/local/bin)
#   AGENT_BRIDGE_RUNTIME_SRC_DIR      local codex-channel dir (skips fetch+tar)
#   AGENT_BRIDGE_RUNTIME_TARBALL_URL  repo tarball for the runtime snapshot
#   AGENT_BRIDGE_HOME                 bridge state dir, or its parent home dir
REPO_BASE="${AGENT_BRIDGE_REPO_BASE:-https://raw.githubusercontent.com/EthanSK/agent-bridge/main}"
REPO="$REPO_BASE/agent-bridge"
REWIRE_SCRIPT_URL="$REPO_BASE/scripts/plugin-registry-rewire.mjs"
INSTALL_DIR="${AGENT_BRIDGE_INSTALL_DIR:-/usr/local/bin}"
BIN_NAME="agent-bridge"
REWIRE_SCRIPT_NAME="plugin-registry-rewire.mjs"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Match the root CLI / MCP Codex loader contract: AGENT_BRIDGE_HOME accepts
# either the state directory itself (.../.agent-bridge) or its parent.
bridge_home_is_complete_unc() {
  local normalized="${1//\\//}" server rest share
  case "$normalized" in //*) ;; *) return 1 ;; esac
  normalized="${normalized#//}"
  server="${normalized%%/*}"
  [ "$server" != "$normalized" ] || return 1
  rest="${normalized#*/}"
  share="${rest%%/*}"
  [ -n "$server" ] && [ -n "$share" ]
}

bridge_home_is_absolute() {
  case "$1" in
    [A-Za-z]:[\\/]*) return 0 ;;
    //*) bridge_home_is_complete_unc "$1"; return ;;
    \\*) bridge_home_is_complete_unc "$1"; return ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_bridge_home() {
  local raw="${AGENT_BRIDGE_HOME:-}"
  if [ -z "$raw" ]; then
    printf '%s' "$HOME/.agent-bridge"
    return
  fi
  case "$raw" in
    "~") raw="$HOME" ;;
    "~/"*) raw="$HOME/${raw#~/}" ;;
    "~\\"*)
      raw="${raw#~\\}"
      raw="$HOME/${raw//\\//}"
      ;;
  esac
  if ! bridge_home_is_absolute "$raw"; then
    printf 'install.sh: AGENT_BRIDGE_HOME must resolve to an absolute path: %s\n' "$raw" >&2
    return 2
  fi
  case "$raw" in
    [A-Za-z]:[\\/]*|\\*)
      if command -v cygpath >/dev/null 2>&1; then
        raw="$(cygpath -u "$raw")"
      else
        printf 'install.sh: native Windows AGENT_BRIDGE_HOME requires cygpath (Git Bash): %s\n' "$raw" >&2
        return 2
      fi
      ;;
  esac
  while [ "$raw" != "/" ]; do
    case "$raw" in
      */|*\\) raw="${raw%?}" ;;
      *) break ;;
    esac
  done
  local leaf="${raw##*/}"
  leaf="${leaf##*\\}"
  if [ "$leaf" = ".agent-bridge" ]; then
    printf '%s' "$raw"
  else
    printf '%s/.agent-bridge' "$raw"
  fi
}

if ! BRIDGE_HOME="$(resolve_bridge_home)"; then exit 2; fi

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

# A custom install directory may not exist yet. Create it directly when its
# parent is writable; fall back to sudo only for system-owned locations.
if [ ! -d "$INSTALL_DIR" ]; then
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    sudo mkdir -p "$INSTALL_DIR"
  fi
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

# --------------------------------------------------------------------------
# Self-contained codex-channel runtime (4.10.0). `agent-bridge codex ...`
# needs the codex-channel package; the CLI prefers AGENT_BRIDGE_SOURCE_DIR /
# a local clone, and otherwise uses this self-contained snapshot at
# <resolved-bridge-home>/runtime/codex-channel/ (no sudo — user-writable). The
# package is fully self-contained (vendored shared modules, zero npm deps),
# so the snapshot alone is enough to run bind/status/doctor/send/service.
# Non-fatal: install still succeeds without it.
# --------------------------------------------------------------------------
RUNTIME_DIR="$BRIDGE_HOME/runtime"
TARBALL_URL="${AGENT_BRIDGE_RUNTIME_TARBALL_URL:-https://codeload.github.com/EthanSK/agent-bridge/tar.gz/refs/heads/main}"

# install_codex_runtime <src-dir>: stage next to the live dir, then swap with
# rollback — no remove-then-empty gap for a daemon that restarts mid-install.
install_codex_runtime() {
  src_dir="$1"
  mkdir -p "$RUNTIME_DIR"
  rm -rf "$RUNTIME_DIR/codex-channel.new" "$RUNTIME_DIR/codex-channel.old"
  cp -R "$src_dir" "$RUNTIME_DIR/codex-channel.new"
  if [ ! -f "$RUNTIME_DIR/codex-channel.new/bin/codex-channel.mjs" ]; then
    rm -rf "$RUNTIME_DIR/codex-channel.new"
    return 1
  fi
  if [ -d "$RUNTIME_DIR/codex-channel" ]; then
    mv "$RUNTIME_DIR/codex-channel" "$RUNTIME_DIR/codex-channel.old"
  fi
  if mv "$RUNTIME_DIR/codex-channel.new" "$RUNTIME_DIR/codex-channel"; then
    rm -rf "$RUNTIME_DIR/codex-channel.old"
    return 0
  fi
  # Roll back the previous runtime if the swap failed.
  if [ -d "$RUNTIME_DIR/codex-channel.old" ]; then
    mv "$RUNTIME_DIR/codex-channel.old" "$RUNTIME_DIR/codex-channel" 2>/dev/null || true
  fi
  return 1
}

codex_runtime_warn() {
  printf "${YELLOW:-}  [warn] Codex support NOT installed: %s${RESET}\n" "$1"
  printf "${DIM}         'agent-bridge codex ...' needs the codex-channel runtime. Fix: clone the repo,${RESET}\n"
  printf "${DIM}         set AGENT_BRIDGE_SOURCE_DIR to a checkout, or re-run install.sh with network access.${RESET}\n"
}

# True when supervision has actionable work: a normal enabled binding OR a
# crash-safe sticky-settings journal left by a prior daemon. Journals must be
# recovered even after their binding was disabled or removed.
codex_recovery_work_exists() {
  node -e '
    const fs = require("fs");
    let needed = false;
    try {
      const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      needed = Object.values(reg.bindings ?? {}).some(b => b && b.enabled !== false);
    } catch {}
    try {
      needed ||= fs.readdirSync(process.argv[2], { withFileTypes: true })
        .some(e => e.isFile() && e.name.endsWith(".json"));
    } catch {}
    process.exit(needed ? 0 : 1);
  ' "$BRIDGE_HOME/codex/bindings.json" "$BRIDGE_HOME/codex/pending-settings" >/dev/null 2>&1
}

CODEX_RUNTIME_OK=0
if [ -n "${AGENT_BRIDGE_RUNTIME_SRC_DIR:-}" ]; then
  if [ -f "$AGENT_BRIDGE_RUNTIME_SRC_DIR/bin/codex-channel.mjs" ] \
     && install_codex_runtime "$AGENT_BRIDGE_RUNTIME_SRC_DIR"; then
    CODEX_RUNTIME_OK=1
  else
    codex_runtime_warn "AGENT_BRIDGE_RUNTIME_SRC_DIR did not contain a valid codex-channel package"
  fi
elif command -v tar >/dev/null 2>&1; then
  TMPTAR="$(mktemp -d)"
  if $FETCH "$TARBALL_URL" > "$TMPTAR/repo.tgz" 2>/dev/null && [ -s "$TMPTAR/repo.tgz" ] \
     && tar -xzf "$TMPTAR/repo.tgz" -C "$TMPTAR" 2>/dev/null; then
    SRC_DIR="$(find "$TMPTAR" -mindepth 2 -maxdepth 2 -type d -name codex-channel 2>/dev/null | head -n 1)"
    if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/bin/codex-channel.mjs" ] \
       && install_codex_runtime "$SRC_DIR"; then
      CODEX_RUNTIME_OK=1
    else
      codex_runtime_warn "codex-channel not present/installable from the repo tarball"
    fi
  else
    codex_runtime_warn "could not fetch the repo tarball from $TARBALL_URL"
  fi
  rm -rf "$TMPTAR"
else
  codex_runtime_warn "tar is not available on this system"
fi
if [ "$CODEX_RUNTIME_OK" = "1" ]; then
  printf "${GREEN}  [ok] codex-channel runtime installed to %s/codex-channel${RESET}\n" "$RUNTIME_DIR"
  # Re-running the one-line installer is also an update. Refresh a live older
  # daemon from the newly swapped runtime, including journal-only recovery
  # machines. A deliberate NO_ENSURE policy always wins.
  if [ "${AGENT_BRIDGE_CODEX_NO_ENSURE:-0}" = "1" ]; then
    printf "${DIM}  [skip] AGENT_BRIDGE_CODEX_NO_ENSURE=1 — codex-channel service not ensured.${RESET}\n"
  elif command -v node >/dev/null 2>&1 && codex_recovery_work_exists; then
    if AGENT_BRIDGE_HOME="$BRIDGE_HOME" node "$RUNTIME_DIR/codex-channel/service.mjs" --ensure >/dev/null 2>&1; then
      printf "${GREEN}  [ok] codex-channel service ensured from the installed runtime${RESET}\n"
    else
      printf "${YELLOW:-}  [warn] codex-channel runtime installed, but service ensure failed; run 'agent-bridge codex service ensure'.${RESET}\n"
    fi
  fi
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

# --------------------------------------------------------------------------
# [PERIODIC-UPDATE 2026-05-04] Install the harness-INDEPENDENT periodic
# auto-updater (launchd LaunchAgent every 10 min). Default ON for fresh
# installs. Opt-out via AGENT_BRIDGE_NO_PERIODIC_UPDATE=1.
#
# Skipped if no local clone with scripts/install-periodic-update.sh is
# reachable (e.g. when this installer was piped via curl|bash and the user
# hasn't cloned the repo yet — they can re-run after cloning, or run
# `agent-bridge install-periodic-update` manually).
# --------------------------------------------------------------------------
if [ "${AGENT_BRIDGE_NO_PERIODIC_UPDATE:-0}" = "1" ]; then
  printf "${DIM}  [skip] AGENT_BRIDGE_NO_PERIODIC_UPDATE=1 — skipping periodic-update LaunchAgent.${RESET}\n"
else
  # The periodic-update body operates on a dev clone (git fetch + pull +
  # build), so it requires a local clone to exist. Search candidate clones in
  # priority order:
  #   1. The dir containing this install.sh (cloned-repo invocation).
  #   2. ~/Projects/agent-bridge (Ethan's standard layout).
  #   3. ~/.openclaw/workspace/agent-bridge (OC workspace clone).
  PROVISIONER=""
  if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$SCRIPT_DIR/scripts/install-periodic-update.sh" ]; then
    PROVISIONER="$SCRIPT_DIR/scripts/install-periodic-update.sh"
  elif [ -f "$HOME/Projects/agent-bridge/scripts/install-periodic-update.sh" ]; then
    PROVISIONER="$HOME/Projects/agent-bridge/scripts/install-periodic-update.sh"
  elif [ -f "$HOME/.openclaw/workspace/agent-bridge/scripts/install-periodic-update.sh" ]; then
    PROVISIONER="$HOME/.openclaw/workspace/agent-bridge/scripts/install-periodic-update.sh"
  fi

  if [ -n "$PROVISIONER" ]; then
    printf "${DIM}  Installing periodic-update LaunchAgent (10 min interval)...${RESET}\n"
    if /bin/bash "$PROVISIONER"; then
      :
    else
      printf "${DIM}  [warn] Periodic-update provisioner failed (rc=%s). Run 'agent-bridge install-periodic-update' manually to retry.${RESET}\n" "$?"
    fi
  else
    # curl|bash bootstrap path: no clone yet. The periodic body needs a clone
    # to operate on; we cannot meaningfully install the LaunchAgent without
    # one. Emit a loud, actionable hint and continue (non-fatal).
    printf "${BOLD}${DIM}  [skip] Harness-independent auto-update not installed.${RESET}\n"
    printf "${DIM}         The periodic updater needs a local agent-bridge clone (it runs${RESET}\n"
    printf "${DIM}         git fetch + pull + build every 10 min). After cloning, run:${RESET}\n"
    printf "${DIM}             git clone https://github.com/EthanSK/agent-bridge ~/Projects/agent-bridge${RESET}\n"
    printf "${DIM}             agent-bridge install-periodic-update${RESET}\n"
  fi
fi

printf '\n'
printf "  Get started:\n"
printf "${DIM}    agent-bridge setup${RESET}\n"
printf "${DIM}    agent-bridge help${RESET}\n"
printf '\n'
