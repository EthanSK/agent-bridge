#!/usr/bin/env bash
#
# agent-bridge/scripts/update.sh
# ------------------------------
# One-shot updater for a cloned agent-bridge checkout.
#
# Steps:
#   1. git fetch + fast-forward pull on main
#   2. npm install + npm run build in mcp-server/ (unified tools + channel)
#   3. archive stale Claude Code plugin cache copies when safe
#   4. sync any installed Claude Code plugin cache copies
#   5. (optional) restart the OpenClaw gateway
#   6. (macOS only) trigger /reload-plugins in the running Claude Code terminal
#      if ~/.claude/skills/self-reload-plugins is present
#
# 3.7.0+: the dedicated claude-code-channel package was deleted and merged
# back into mcp-server/. There's nothing else to build for Claude Code.
#
# Usage:
#   scripts/update.sh [--yes] [--auto] [--skip-openclaw] [--skip-reload]
#
# Options:
#   -y, --yes         answer yes to interactive prompts
#   --auto           SessionStart-safe mode: implies --yes --skip-openclaw,
#                    stays silent when no commits are pulled and no rebuild is
#                    needed, and only prints on real changes or errors
#   --skip-openclaw  skip the OpenClaw gateway restart step
#   --skip-reload    skip Claude Code /reload-plugins automation
#
# Cache cleanup:
#   After a successful pull + rebuild, older inactive Claude Code plugin cache
#   version directories under
#   ~/.claude/plugins/cache/agent-bridge/agent-bridge/ are archived to
#   .archive/<version>-<timestamp>/. A cache dir is kept if a running process is
#   still using agent-bridge/agent-bridge/<version>/build/index.js.
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
AUTO=0
SKIP_OPENCLAW=0
SKIP_RELOAD=0

usage() {
  sed -n '2,36p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --auto)
      AUTO=1
      ASSUME_YES=1
      SKIP_OPENCLAW=1
      ;;
    --skip-openclaw) SKIP_OPENCLAW=1 ;;
    --skip-reload) SKIP_RELOAD=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: $0 [--yes] [--auto] [--skip-openclaw] [--skip-reload]" >&2
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

# ---------- Helpers ---------------------------------------------------------

AUTO_VERBOSE=0
ARCHIVE_CHANGED=0

say() {
  if (( AUTO )) && (( ! AUTO_VERBOSE )); then
    return 0
  fi
  echo "$@"
}

warn() {
  echo "WARN: $*" >&2
}

confirm() {
  local prompt="$1"
  if (( ASSUME_YES )); then
    say "$prompt [auto-yes]"
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

hr() {
  if (( AUTO )) && (( ! AUTO_VERBOSE )); then
    return 0
  fi
  printf -- '------------------------------------------------------------\n'
}

is_semver_dir() {
  [[ "$1" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]
}

semver_lt() {
  local left="$1"
  local right="$2"
  local l_major l_minor l_patch r_major r_minor r_patch

  IFS=. read -r l_major l_minor l_patch <<< "$left"
  IFS=. read -r r_major r_minor r_patch <<< "$right"

  l_major=$((10#$l_major))
  l_minor=$((10#$l_minor))
  l_patch=$((10#$l_patch))
  r_major=$((10#$r_major))
  r_minor=$((10#$r_minor))
  r_patch=$((10#$r_patch))

  (( l_major < r_major )) && return 0
  (( l_major > r_major )) && return 1
  (( l_minor < r_minor )) && return 0
  (( l_minor > r_minor )) && return 1
  (( l_patch < r_patch ))
}

package_version() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("./mcp-server/package.json").version)' 2>/dev/null && return 0
  fi
  sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' mcp-server/package.json | head -1
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '"%s"' "$value"
}

json_array() {
  local first=1
  local item
  printf '['
  for item in "$@"; do
    if (( first )); then
      first=0
    else
      printf ','
    fi
    json_string "$item"
  done
  printf ']'
}

log_archive_result() {
  local archived_json="$1"
  local kept_json="$2"
  local payload="{\"archived\":$archived_json,\"kept\":$kept_json}"

  if [[ -f "$HOME/.claude/scripts/skill-log.sh" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.claude/scripts/skill-log.sh" || true
  fi

  if declare -F skill_log >/dev/null 2>&1; then
    skill_log info "agent-bridge.update.archive" "$payload"
  else
    echo "agent-bridge.update.archive $payload" >&2
  fi
}

archive_stale_plugin_caches() {
  ARCHIVE_CHANGED=0

  local cache_root="$HOME/.claude/plugins/cache/agent-bridge/agent-bridge"
  [[ -d "$cache_root" ]] || return 0

  local current_version
  current_version="$(package_version || true)"
  if ! is_semver_dir "$current_version"; then
    warn "could not determine current mcp-server package version; skipping stale plugin cache archive."
    return 0
  fi

  local archive_root="$cache_root/.archive"
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local archived=()
  local kept=()
  local dir version dest active_pattern

  while IFS= read -r -d '' dir; do
    version="$(basename "$dir")"
    is_semver_dir "$version" || continue
    semver_lt "$version" "$current_version" || continue

    active_pattern="agent-bridge/agent-bridge/${version}/build/index.js"
    if pgrep -f "$active_pattern" >/dev/null 2>&1; then
      kept+=("$version")
      continue
    fi

    dest="$archive_root/${version}-${timestamp}"
    if mkdir -p "$archive_root" && mv "$dir" "$dest"; then
      archived+=("$version")
      ARCHIVE_CHANGED=1
    else
      warn "failed to archive stale Claude plugin cache $dir to $dest; continuing."
    fi
  done < <(find "$cache_root" -mindepth 1 -maxdepth 1 -type d -print0)

  if (( ${#archived[@]} || ${#kept[@]} )); then
    # macOS still ships bash 3.2, where expanding an empty array with
    # `set -u` as a function argument (`"${empty[@]}"`) raises "unbound
    # variable". Build the JSON strings only when the arrays are non-empty.
    local archived_json="[]"
    local kept_json="[]"
    if (( ${#archived[@]} )); then
      archived_json="$(json_array "${archived[@]}")"
    fi
    if (( ${#kept[@]} )); then
      kept_json="$(json_array "${kept[@]}")"
    fi
    log_archive_result "$archived_json" "$kept_json"
  fi

  if (( ${#archived[@]} )); then
    AUTO_VERBOSE=1
    say "==> Archived stale Claude plugin cache version$([[ "${#archived[@]}" == 1 ]] && printf '' || printf 's'): ${archived[*]}"
  fi

  if (( ${#kept[@]} )) && (( ! AUTO )); then
    say "==> Kept active stale Claude plugin cache version$([[ "${#kept[@]}" == 1 ]] && printf '' || printf 's'): ${kept[*]}"
  fi
}

run_git_quiet_if_auto() {
  local output_file="$1"
  shift

  if (( AUTO )); then
    "$@" >>"$output_file" 2>&1
  else
    "$@"
  fi
}

if (( ! AUTO )); then
  say "==> agent-bridge repo: $REPO_ROOT"
fi

# ---------- 1. Git pull -----------------------------------------------------

hr
say "==> Step 1/6: git fetch + pull"

# Capture HEAD before + after so later steps can early-exit if nothing changed.
HEAD_BEFORE="$(git rev-parse HEAD)"

GIT_OUTPUT="$(mktemp)"
trap 'rm -f "$GIT_OUTPUT"' EXIT

if ! run_git_quiet_if_auto "$GIT_OUTPUT" git fetch origin; then
  cat "$GIT_OUTPUT" >&2
  echo "ERROR: git fetch failed. Resolve network or remote state, then re-run." >&2
  exit 1
fi

# Fast-forward only — refuse to clobber local work.
if ! run_git_quiet_if_auto "$GIT_OUTPUT" git pull --ff-only origin main; then
  cat "$GIT_OUTPUT" >&2
  echo "ERROR: git pull --ff-only failed. Resolve local state first (stash, rebase, or reset), then re-run." >&2
  exit 1
fi

HEAD_AFTER="$(git rev-parse HEAD)"

if [[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]]; then
  NOTHING_CHANGED=1
  say "==> Already up to date (no new commits)."
else
  AUTO_VERBOSE=1
  if (( AUTO )); then
    say "==> agent-bridge repo: $REPO_ROOT"
  fi
  say "==> Pulled $(git log --oneline "$HEAD_BEFORE..$HEAD_AFTER" | wc -l | tr -d ' ') commit(s)."
  NOTHING_CHANGED=0
fi

BUILD_NEEDED=0
if [[ -d "mcp-server" && -f "mcp-server/package.json" ]]; then
  if (( ! NOTHING_CHANGED )) || [[ ! -d "mcp-server/build" ]]; then
    BUILD_NEEDED=1
  fi
fi

if (( AUTO )) && (( NOTHING_CHANGED )) && (( ! BUILD_NEEDED )); then
  exit 0
fi

if (( AUTO )) && (( BUILD_NEEDED )) && (( ! AUTO_VERBOSE )); then
  AUTO_VERBOSE=1
  say "==> agent-bridge repo: $REPO_ROOT"
fi

# ---------- 2. MCP server rebuild -------------------------------------------

hr
say "==> Step 2/6: rebuild mcp-server (tools-only)"

if [[ ! -d "mcp-server" ]]; then
  say "no mcp-server/ dir — skipping (this repo layout is unexpected)"
else
  pushd mcp-server >/dev/null
  if [[ ! -f package.json ]]; then
    say "no mcp-server/package.json — skipping"
  else
    if (( ! BUILD_NEEDED )); then
      say "no new commits AND build/ already exists — skipping npm install+build"
    else
      say "    running: npm install"
      npm install --no-fund --no-audit
      say "    running: npm run build"
      npm run build
    fi
  fi
  popd >/dev/null
fi

# ---------- 3. Stale Claude plugin cache archive ----------------------------

hr
say "==> Step 3/6: stale Claude plugin cache archive"
archive_stale_plugin_caches

# ---------- 4. Claude plugin cache sync -------------------------------------

hr
say "==> Step 4/6: Claude plugin cache sync"

# 3.7.0+: clean up any old claude-code-channel install if it's still around.
if [[ -d "claude-code-channel" ]]; then
  say "    found legacy claude-code-channel/ dir — this was deleted in 3.7.0; ignoring"
fi

copy_dir_clean() {
  local src="$1"
  local dst="$2"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src/" "$dst/"
    return
  fi

  local node_bin
  node_bin="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_bin" ]]; then
    warn "rsync and node are both unavailable; cannot sync $src to $dst."
    return 1
  fi

  SRC_DIR="$src" DST_DIR="$dst" "$node_bin" <<'NODE'
const fs = require('fs');

const src = process.env.SRC_DIR;
const dst = process.env.DST_DIR;
if (!src || !dst) {
  throw new Error('SRC_DIR and DST_DIR are required');
}
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
fs.cpSync(src, dst, { recursive: true, force: true });
NODE
}

sync_cache_dir() {
  local cache_dir="$1"
  mkdir -p "$cache_dir/build" "$cache_dir/src" "$cache_dir/.claude-plugin"
  copy_dir_clean "$REPO_ROOT/mcp-server/build" "$cache_dir/build"
  copy_dir_clean "$REPO_ROOT/mcp-server/src" "$cache_dir/src"
  cp "$REPO_ROOT/mcp-server/package.json" "$cache_dir/package.json"
  cp "$REPO_ROOT/mcp-server/package-lock.json" "$cache_dir/package-lock.json"
  cp "$REPO_ROOT/mcp-server/tsconfig.json" "$cache_dir/tsconfig.json"
  cp "$REPO_ROOT/mcp-server/.mcp.json" "$cache_dir/.mcp.json"
  cp "$REPO_ROOT/mcp-server/.claude-plugin/plugin.json" "$cache_dir/.claude-plugin/plugin.json"
}

CACHE_ROOT="$HOME/.claude/plugins/cache/agent-bridge/agent-bridge"
if [[ ! -d "$CACHE_ROOT" ]]; then
  say "no Claude plugin cache found at $CACHE_ROOT — skipping."
else
  synced=0
  while IFS= read -r -d '' cache_dir; do
    cache_version="$(basename "$cache_dir")"
    is_semver_dir "$cache_version" || continue
    say "    syncing cache: $cache_dir"
    sync_cache_dir "$cache_dir"
    synced=$((synced + 1))
  done < <(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
  say "==> Synced $synced cache director$([[ "$synced" == 1 ]] && printf 'y' || printf 'ies')."
fi

# ---------- 5. OpenClaw gateway restart -------------------------------------

hr
say "==> Step 5/6: OpenClaw gateway restart"

if (( SKIP_OPENCLAW )); then
  say "--skip-openclaw — skipping."
elif ! command -v openclaw >/dev/null 2>&1; then
  say "openclaw CLI not on \$PATH — skipping gateway restart. (Plugin changes won't take effect until the next gateway start.)"
elif (( NOTHING_CHANGED )); then
  say "no new commits — gateway restart is not needed."
else
  if confirm "Restart the OpenClaw gateway now? (interrupts any running OpenClaw session briefly)"; then
    # Best-effort restart. `openclaw gateway restart` may or may not exist; fall
    # back to stop+start.
    if openclaw gateway --help 2>&1 | grep -qE '^\s+restart'; then
      openclaw gateway restart
    else
      say "    openclaw gateway restart not available — trying stop + start"
      openclaw gateway stop 2>/dev/null || true
      openclaw gateway start
    fi
  else
    say "    declined — you'll need to restart the gateway manually to pick up openclaw-channel changes."
  fi
fi

# ---------- 6. /reload-plugins via self-reload-plugins skill ----------------

hr
say "==> Step 6/6: Claude Code /reload-plugins"

if (( SKIP_RELOAD )); then
  say "--skip-reload — skipping."
elif [[ "$(uname -s)" != "Darwin" ]]; then
  say "not macOS — skipping /reload-plugins automation."
elif [[ ! -x "$HOME/.claude/skills/self-reload-plugins/scripts/reload.sh" ]]; then
  say "self-reload-plugins skill not installed (missing ~/.claude/skills/self-reload-plugins/scripts/reload.sh) — skipping."
  say "    If you're in an active Claude Code session, run /reload-plugins yourself so MCP tools reconnect to the new build."
else
  if confirm "Trigger /reload-plugins in the running Claude Code terminal via the self-reload-plugins skill?"; then
    bash "$HOME/.claude/skills/self-reload-plugins/scripts/reload.sh" || \
      say "    self-reload-plugins script exited non-zero — reload manually via /reload-plugins."
  else
    say "    declined — run /reload-plugins manually so MCP tools reconnect to the new build."
  fi
fi

hr
say "==> Done."
if (( NOTHING_CHANGED )); then
  say "    Nothing changed. Repo was already at $(git rev-parse --short HEAD)."
else
  say "    Now at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))."
fi
