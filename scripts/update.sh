#!/usr/bin/env bash
#
# agent-bridge/scripts/update.sh
# ------------------------------
# One-shot updater for a cloned agent-bridge checkout.
#
# Steps:
#   1. git fetch + fast-forward pull on main
#   2. npm install + npm run build in mcp-server/ (unified tools + channel)
#   3. sync any installed Claude Code plugin cache copies
#   4. (optional) restart the OpenClaw gateway
#   5. (macOS only) trigger /reload-plugins in the running Claude Code terminal
#      if ~/.claude/skills/self-reload-plugins is present
#
# 3.7.0+: the dedicated claude-code-channel package was deleted and merged
# back into mcp-server/. There's nothing else to build for Claude Code.
#
# Usage:
#   scripts/update.sh [--yes] [--skip-openclaw] [--skip-reload]
#
# Exit codes:
#   0 — success (even if nothing changed)
#   1 — git/build failure
#   2 — user declined a prompt
#
# Safe to run from anywhere — the script cd's to its own repo root before doing
# anything destructive.

set -euo pipefail

# ---------- Arg parsing -----------------------------------------------------

ASSUME_YES=0
SKIP_OPENCLAW=0
SKIP_RELOAD=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --skip-openclaw) SKIP_OPENCLAW=1 ;;
    --skip-reload) SKIP_RELOAD=1 ;;
    -h|--help)
      sed -n '2,24p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: $0 [--yes] [--skip-openclaw] [--skip-reload]" >&2
      exit 2
      ;;
  esac
done

# ---------- Locate repo root ------------------------------------------------

# Resolve the real path of this script, following symlinks.
SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SRC" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
  SCRIPT_SRC="$(readlink "$SCRIPT_SRC")"
  [[ "$SCRIPT_SRC" != /* ]] && SCRIPT_SRC="$DIR/$SCRIPT_SRC"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$REPO_ROOT/.git" ]]; then
  echo "ERROR: $REPO_ROOT is not a git checkout. This script must live inside a cloned agent-bridge repo." >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "==> agent-bridge repo: $REPO_ROOT"

# ---------- Helpers ---------------------------------------------------------

confirm() {
  local prompt="$1"
  if (( ASSUME_YES )); then
    echo "$prompt [auto-yes]"
    return 0
  fi
  local reply
  read -r -p "$prompt [Y/n] " reply
  reply="${reply:-y}"
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

hr() { printf -- '------------------------------------------------------------\n'; }

# ---------- 1. Git pull -----------------------------------------------------

hr
echo "==> Step 1/4: git fetch + pull"

# Capture HEAD before + after so later steps can early-exit if nothing changed.
HEAD_BEFORE="$(git rev-parse HEAD)"

git fetch origin
# Fast-forward only — refuse to clobber local work.
if ! git pull --ff-only origin main; then
  echo "ERROR: git pull --ff-only failed. Resolve local state first (stash, rebase, or reset), then re-run." >&2
  exit 1
fi

HEAD_AFTER="$(git rev-parse HEAD)"

if [[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]]; then
  echo "==> Already up to date (no new commits)."
  NOTHING_CHANGED=1
else
  echo "==> Pulled $(git log --oneline "$HEAD_BEFORE..$HEAD_AFTER" | wc -l | tr -d ' ') commit(s)."
  NOTHING_CHANGED=0
fi

# ---------- 2. MCP server rebuild -------------------------------------------

hr
echo "==> Step 2/5: rebuild mcp-server (tools-only)"

if [[ ! -d "mcp-server" ]]; then
  echo "no mcp-server/ dir — skipping (this repo layout is unexpected)"
else
  pushd mcp-server >/dev/null
  if [[ ! -f package.json ]]; then
    echo "no mcp-server/package.json — skipping"
  else
    if (( NOTHING_CHANGED )) && [[ -d build ]]; then
      echo "no new commits AND build/ already exists — skipping npm install+build"
    else
      echo "    running: npm install"
      npm install --no-fund --no-audit
      echo "    running: npm run build"
      npm run build
    fi
  fi
  popd >/dev/null
fi

# ---------- 3. Claude plugin cache sync -------------------------------------

hr
echo "==> Step 3/5: Claude plugin cache sync"

# 3.7.0+: clean up any old claude-code-channel install if it's still around.
if [[ -d "claude-code-channel" ]]; then
  echo "    found legacy claude-code-channel/ dir — this was deleted in 3.7.0; ignoring"
fi

sync_cache_dir() {
  local cache_dir="$1"
  mkdir -p "$cache_dir/build" "$cache_dir/src" "$cache_dir/.claude-plugin"
  rsync -a --delete "$REPO_ROOT/mcp-server/build/" "$cache_dir/build/"
  rsync -a --delete "$REPO_ROOT/mcp-server/src/" "$cache_dir/src/"
  cp "$REPO_ROOT/mcp-server/package.json" "$cache_dir/package.json"
  cp "$REPO_ROOT/mcp-server/package-lock.json" "$cache_dir/package-lock.json"
  cp "$REPO_ROOT/mcp-server/tsconfig.json" "$cache_dir/tsconfig.json"
  cp "$REPO_ROOT/mcp-server/.mcp.json" "$cache_dir/.mcp.json"
  cp "$REPO_ROOT/mcp-server/.claude-plugin/plugin.json" "$cache_dir/.claude-plugin/plugin.json"
}

CACHE_ROOT="$HOME/.claude/plugins/cache/agent-bridge/agent-bridge"
if [[ ! -d "$CACHE_ROOT" ]]; then
  echo "no Claude plugin cache found at $CACHE_ROOT — skipping."
else
  synced=0
  while IFS= read -r -d '' cache_dir; do
    echo "    syncing cache: $cache_dir"
    sync_cache_dir "$cache_dir"
    synced=$((synced + 1))
  done < <(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
  echo "==> Synced $synced cache director$([[ "$synced" == 1 ]] && printf 'y' || printf 'ies')."
fi

# ---------- 5. OpenClaw gateway restart -------------------------------------

hr
echo "==> Step 4/5: OpenClaw gateway restart"

if (( SKIP_OPENCLAW )); then
  echo "--skip-openclaw — skipping."
elif ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not on \$PATH — skipping gateway restart. (Plugin changes won't take effect until the next gateway start.)"
elif (( NOTHING_CHANGED )); then
  echo "no new commits — gateway restart is not needed."
else
  if confirm "Restart the OpenClaw gateway now? (interrupts any running OpenClaw session briefly)"; then
    # Best-effort restart. `openclaw gateway restart` may or may not exist; fall
    # back to stop+start.
    if openclaw gateway --help 2>&1 | grep -qE '^\s+restart'; then
      openclaw gateway restart
    else
      echo "    openclaw gateway restart not available — trying stop + start"
      openclaw gateway stop 2>/dev/null || true
      openclaw gateway start
    fi
  else
    echo "    declined — you'll need to restart the gateway manually to pick up openclaw-channel changes."
  fi
fi

# ---------- 6. /reload-plugins via self-reload-plugins skill ----------------

hr
echo "==> Step 5/5: Claude Code /reload-plugins"

if (( SKIP_RELOAD )); then
  echo "--skip-reload — skipping."
elif [[ "$(uname -s)" != "Darwin" ]]; then
  echo "not macOS — skipping /reload-plugins automation."
elif [[ ! -x "$HOME/.claude/skills/self-reload-plugins/scripts/reload.sh" ]]; then
  echo "self-reload-plugins skill not installed (missing ~/.claude/skills/self-reload-plugins/scripts/reload.sh) — skipping."
  echo "    If you're in an active Claude Code session, run /reload-plugins yourself so MCP tools reconnect to the new build."
else
  if confirm "Trigger /reload-plugins in the running Claude Code terminal via the self-reload-plugins skill?"; then
    bash "$HOME/.claude/skills/self-reload-plugins/scripts/reload.sh" || \
      echo "    self-reload-plugins script exited non-zero — reload manually via /reload-plugins."
  else
    echo "    declined — run /reload-plugins manually so MCP tools reconnect to the new build."
  fi
fi

hr
echo "==> Done."
if (( NOTHING_CHANGED )); then
  echo "    Nothing changed. Repo was already at $(git rev-parse --short HEAD)."
else
  echo "    Now at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))."
fi
