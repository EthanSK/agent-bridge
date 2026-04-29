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
#                     [--fan-out] [--dry-run]
#
# Options:
#   -y, --yes         answer yes to interactive prompts
#   --auto           SessionStart-safe mode: implies --yes --skip-openclaw,
#                    stays silent when no commits are pulled and no rebuild is
#                    needed, and only prints on real changes or errors
#   --skip-openclaw  skip the OpenClaw gateway restart step
#   --skip-reload    skip Claude Code /reload-plugins automation
#   --fan-out        after the local update finishes, propagate to every paired
#                    peer in ~/.agent-bridge/config (SSH + remote update.sh,
#                    falling back to a manual rebuild on failure), then drop a
#                    [MATRIX-UPDATE-DONE] BridgeMessage into each peer's
#                    inbox/claude-code/ subdir asking it to /reload-plugins.
#                    Implies --auto. Continues on per-peer failures.
#   --dry-run        print what would happen without doing it. With --fan-out,
#                    skips the local update steps AND the per-peer SSH /
#                    BridgeMessage dispatch — just prints the plan. Useful
#                    for verifying which peers would be touched.
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
FAN_OUT=0
DRY_RUN=0

usage() {
  sed -n '2,46p' "$0"
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
    --fan-out)
      # [MATRIX-FAN-OUT 2026-04-29] Fan-out propagates the update to every
      # paired peer over SSH and then asks each peer to /reload-plugins via
      # a BridgeMessage drop into inbox/claude-code/. --fan-out implies
      # --auto so the local pass stays SessionStart-safe.
      FAN_OUT=1
      AUTO=1
      ASSUME_YES=1
      SKIP_OPENCLAW=1
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      echo "usage: $0 [--yes] [--auto] [--skip-openclaw] [--skip-reload] [--fan-out] [--dry-run]" >&2
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

# [MATRIX-FAN-OUT 2026-04-29] In --dry-run mode the local update is a no-op too
# — the user is asking "what would this do", not "do most of it". The fan-out
# planner below still prints its plan after this short-circuit.
if (( DRY_RUN )); then
  AUTO_VERBOSE=1
  say "==> [dry-run] would: git fetch + git pull --ff-only origin main in $REPO_ROOT"
  say "==> [dry-run] would: rebuild mcp-server (npm install + npm run build) if commits arrived or build/ missing"
  say "==> [dry-run] would: archive stale Claude plugin caches under $HOME/.claude/plugins/cache/agent-bridge/agent-bridge"
  say "==> [dry-run] would: sync mcp-server build into each cache version dir"
  if (( SKIP_OPENCLAW )); then
    say "==> [dry-run] would: SKIP OpenClaw gateway restart (--skip-openclaw / --auto / --fan-out)"
  else
    say "==> [dry-run] would: restart OpenClaw gateway if commits arrived"
  fi
  if (( SKIP_RELOAD )); then
    say "==> [dry-run] would: SKIP /reload-plugins (--skip-reload)"
  else
    say "==> [dry-run] would: trigger /reload-plugins via self-reload-plugins skill on macOS"
  fi
fi

if (( ! DRY_RUN )); then

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

fi  # end: if (( ! DRY_RUN ))

# ---------- 7. Fan-out to paired peers --------------------------------------
# [MATRIX-FAN-OUT 2026-04-29]
#
# When --fan-out is passed, propagate the update to every paired peer:
#   1. Parse ~/.agent-bridge/config to enumerate top-level [Machine] sections.
#   2. Skip the local machine and any ".lan" suffixed sub-sections (they're
#      LAN-fallback duplicates of the same peer).
#   3. SSH to each peer using its identity_file with IdentitiesOnly=yes (matches
#      the [OC-FIX-CODEX-XPLAT] pattern in mcp-server/src/ssh.ts) and
#      Tailscale-first endpoint selection (internet_host if set, else host).
#   4. Run the remote update.sh --auto under one of the canonical repo paths
#      (~/Projects/agent-bridge OR ~/.openclaw/workspace/agent-bridge). On
#      remote update failure, fall back to a manual rebuild against the same
#      repo path.
#   5. After the SSH pass, drop a [MATRIX-UPDATE-DONE] BridgeMessage JSON file
#      into each peer's ~/.agent-bridge/inbox/claude-code/<id>.json via SFTP
#      so the running Claude Code session sees a request to /reload-plugins.
#
# Continues on per-peer failures — one bad peer must not block the others.
# --dry-run prints the plan and skips all remote work.

if (( FAN_OUT )); then
  AUTO_VERBOSE=1
  hr
  if (( DRY_RUN )); then
    say "==> Step 7/7: --fan-out (DRY RUN — no remote work)"
  else
    say "==> Step 7/7: --fan-out — propagating to paired peers"
  fi

  CONFIG_FILE_FAN="$HOME/.agent-bridge/config"
  if [[ ! -f "$CONFIG_FILE_FAN" ]]; then
    warn "no $CONFIG_FILE_FAN — nothing to fan out to."
  else
    # Determine the local machine name so we can skip self.
    LOCAL_NAME="${AGENT_BRIDGE_MACHINE_NAME:-}"
    if [[ -z "$LOCAL_NAME" && -f "$HOME/.agent-bridge/machine-name" ]]; then
      LOCAL_NAME="$(tr -d '[:space:]' <"$HOME/.agent-bridge/machine-name" 2>/dev/null || true)"
    fi
    if [[ -z "$LOCAL_NAME" ]]; then
      LOCAL_NAME="$(hostname 2>/dev/null | sed 's/\.local$//' || printf 'unknown')"
    fi

    # ---- helpers (scoped to fan-out only) -----------------------------------

    # Read a single key from a [section] in the config file. Echoes value to
    # stdout, returns 0 on hit, 1 on miss. Same case-sensitivity as cfg_get
    # in agent-bridge: section match is case-insensitive, key match is exact.
    _peer_cfg_get() {
      local section="$1" key="$2" line in_section=0 lower_section
      lower_section="$(printf '%s' "$section" | tr '[:upper:]' '[:lower:]')"
      while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
          local s_lower
          s_lower="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
          if [[ "$s_lower" == "$lower_section" ]]; then
            in_section=1
          else
            in_section=0
          fi
          continue
        fi
        if (( in_section )) && [[ "$line" =~ ^${key}=(.*)$ ]]; then
          printf '%s' "${BASH_REMATCH[1]}"
          return 0
        fi
      done < "$CONFIG_FILE_FAN"
      return 1
    }

    # Enumerate top-level peer section names (skip *.lan duplicates).
    _peer_list() {
      local line section
      while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ "$line" =~ ^\[(.+)\]$ ]]; then
          section="${BASH_REMATCH[1]}"
          # Skip the LAN sub-section flavour (e.g. "MacBookPro.lan") — the
          # main section already carries the same key/host pair plus an
          # optional internet_host for Tailscale.
          [[ "$section" == *.lan ]] && continue
          printf '%s\n' "$section"
        fi
      done < "$CONFIG_FILE_FAN"
    }

    # Build the SSH arg list for a peer using the same identity/Identity-only
    # pattern as mcp-server/src/ssh.ts buildSSHArgs().
    _peer_ssh() {
      local name="$1"
      shift
      local host port user keypath identity_file endpoint
      host="$(_peer_cfg_get "$name" host || true)"
      port="$(_peer_cfg_get "$name" port || printf 22)"
      user="$(_peer_cfg_get "$name" user || true)"
      identity_file="$(_peer_cfg_get "$name" identity_file || true)"
      keypath="$(_peer_cfg_get "$name" key || true)"
      [[ -z "$identity_file" ]] && identity_file="$keypath"
      # Tailscale-first endpoint selection.
      endpoint="$(_peer_cfg_get "$name" internet_host || true)"
      [[ -z "$endpoint" ]] && endpoint="$host"

      if [[ -z "$endpoint" || -z "$user" || -z "$identity_file" ]]; then
        return 99  # malformed config
      fi
      ssh \
        -i "$identity_file" \
        -o IdentitiesOnly=yes \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o LogLevel=ERROR \
        -p "$port" \
        "${user}@${endpoint}" \
        "$@"
    }

    # SFTP a local file into ~/.agent-bridge/inbox/claude-code/<basename> on
    # the peer using the same Tailscale-first endpoint selection as _peer_ssh.
    # Mirrors the OC-FIX-CODEX-XPLAT SFTP pattern.
    _peer_sftp_put_inbox() {
      local name="$1" local_file="$2" remote_basename="$3"
      local host port user keypath identity_file endpoint
      host="$(_peer_cfg_get "$name" host || true)"
      port="$(_peer_cfg_get "$name" port || printf 22)"
      user="$(_peer_cfg_get "$name" user || true)"
      identity_file="$(_peer_cfg_get "$name" identity_file || true)"
      keypath="$(_peer_cfg_get "$name" key || true)"
      [[ -z "$identity_file" ]] && identity_file="$keypath"
      endpoint="$(_peer_cfg_get "$name" internet_host || true)"
      [[ -z "$endpoint" ]] && endpoint="$host"

      if [[ -z "$endpoint" || -z "$user" || -z "$identity_file" ]]; then
        return 99
      fi
      local remote_tmp="${remote_basename}.tmp.$$"
      local batch
      batch=$'-mkdir ".agent-bridge"\n-mkdir ".agent-bridge/inbox"\n-mkdir ".agent-bridge/inbox/claude-code"\n'
      batch+="put \"$local_file\" \".agent-bridge/inbox/claude-code/${remote_tmp}\""$'\n'
      batch+="rename \".agent-bridge/inbox/claude-code/${remote_tmp}\" \".agent-bridge/inbox/claude-code/${remote_basename}\""$'\n'
      batch+="bye"$'\n'
      printf '%s' "$batch" | sftp \
        -i "$identity_file" \
        -o IdentitiesOnly=yes \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o LogLevel=ERROR \
        -P "$port" \
        -b - \
        "${user}@${endpoint}"
    }

    # Generate a tolerable UUID-ish id without depending on uuidgen.
    _peer_msg_id() {
      if command -v uuidgen >/dev/null 2>&1; then
        printf 'msg-%s' "$(uuidgen | tr '[:upper:]' '[:lower:]')"
      else
        printf 'msg-%s-%s-%s' "$(date -u +%s)" "$$" "$RANDOM$RANDOM"
      fi
    }

    # ---- main fan-out loop --------------------------------------------------

    # Remote update payload: probe both canonical repo paths, run update.sh
    # --auto under whichever exists, and on failure fall back to a manual
    # rebuild + cache-version copy. Source ~/.zshrc and prepend the usual
    # node locations so non-interactive PATH still finds npm.
    REMOTE_PAYLOAD='set -u
# Source common shell init so npm/node/etc are on PATH for non-interactive ssh.
[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc" >/dev/null 2>&1 || true
[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Add the latest nvm node bin if nvm is installed but not yet on PATH.
if [ -d "$HOME/.nvm/versions/node" ]; then
  latest_node="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$latest_node" ]; then
    export PATH="$HOME/.nvm/versions/node/$latest_node/bin:$PATH"
  fi
fi
candidates="$HOME/Projects/agent-bridge $HOME/.openclaw/workspace/agent-bridge"
target=""
for c in $candidates; do
  if [ -d "$c/.git" ] && [ -f "$c/scripts/update.sh" ]; then
    target="$c"
    break
  fi
done
if [ -z "$target" ]; then
  echo "fan-out: no agent-bridge repo found in $candidates" >&2
  exit 90
fi
cd "$target" || exit 91
echo "fan-out: target=$target"
git pull --ff-only origin main || {
  echo "fan-out: git pull failed at $target — refusing to rebuild" >&2
  exit 92
}
if bash scripts/update.sh --auto; then
  echo "fan-out: update.sh --auto succeeded at $target"
  exit 0
fi
echo "fan-out: update.sh --auto failed at $target — falling back to manual rebuild" >&2
cd "$target/mcp-server" || exit 93
npm install --no-fund --no-audit || exit 94
npm run build || exit 95
NEW_VERSION="$(node -e "process.stdout.write(require(\"./package.json\").version)" 2>/dev/null || true)"
if [ -n "$NEW_VERSION" ]; then
  CACHE_DIR="$HOME/.claude/plugins/cache/agent-bridge/agent-bridge/$NEW_VERSION"
  if [ -d "$HOME/.claude/plugins/cache/agent-bridge/agent-bridge" ] && [ ! -d "$CACHE_DIR" ]; then
    mkdir -p "$CACHE_DIR/build" "$CACHE_DIR/src" "$CACHE_DIR/.claude-plugin" || true
    cp -R build/. "$CACHE_DIR/build/" 2>/dev/null || true
    cp -R src/. "$CACHE_DIR/src/" 2>/dev/null || true
    cp package.json package-lock.json tsconfig.json .mcp.json "$CACHE_DIR/" 2>/dev/null || true
    [ -f .claude-plugin/plugin.json ] && cp .claude-plugin/plugin.json "$CACHE_DIR/.claude-plugin/plugin.json"
    echo "fan-out: manual cache primed at $CACHE_DIR"
  fi
fi
echo "fan-out: manual rebuild succeeded at $target"
exit 0
'

    # macOS bash 3.2 + `set -u` quirk: expanding "${arr[@]}" on an empty array
    # raises "unbound variable". Initialize to a safe empty state and gate
    # iterations on the length, never bare expansion.
    PEER_RESULTS=()
    PEER_NAMES=()
    while IFS= read -r peer; do
      [[ -z "$peer" ]] && continue
      # Skip self.
      if [[ "$(printf '%s' "$peer" | tr '[:upper:]' '[:lower:]')" == \
            "$(printf '%s' "$LOCAL_NAME" | tr '[:upper:]' '[:lower:]')" ]]; then
        say "    skipping self ($peer)"
        continue
      fi
      PEER_NAMES+=("$peer")

      if (( DRY_RUN )); then
        say "    [dry-run] would: ssh to $peer and run remote update payload (probe ~/Projects/agent-bridge then ~/.openclaw/workspace/agent-bridge, run update.sh --auto, fall back to manual rebuild)"
        PEER_RESULTS+=("$peer:dryrun")
        continue
      fi

      say "    ==> $peer: dispatching remote update"
      set +e
      _peer_ssh "$peer" bash -lc "$REMOTE_PAYLOAD" 2>&1 | sed "s/^/    [$peer] /"
      ec=${PIPESTATUS[0]}
      set -e
      if (( ec == 0 )); then
        say "    ==> $peer: remote update OK"
        PEER_RESULTS+=("$peer:ok")
      else
        warn "$peer: remote update failed (ssh exit $ec) — continuing with remaining peers"
        PEER_RESULTS+=("$peer:fail($ec)")
      fi
    done < <(_peer_list)

    # ---- BridgeMessage drop ([MATRIX-UPDATE-DONE]) -------------------------

    if (( ${#PEER_NAMES[@]} == 0 )); then
      say "==> No remote peers to message."
    else
      hr
      if (( DRY_RUN )); then
        say "==> [dry-run] would: deliver [MATRIX-UPDATE-DONE] BridgeMessage to each peer's inbox/claude-code/"
      else
        say "==> Delivering [MATRIX-UPDATE-DONE] BridgeMessages"
      fi
      # bash 3.2 + set -u: only iterate when array is non-empty.
      if (( ${#PEER_NAMES[@]} )); then
      for peer in "${PEER_NAMES[@]}"; do
        # Mark fail-status messages too — let the receiver see the result.
        peer_status="unknown"
        if (( ${#PEER_RESULTS[@]} )); then
          for r in "${PEER_RESULTS[@]}"; do
            [[ "$r" == "${peer}:"* ]] && peer_status="${r#*:}"
          done
        fi
        msg_id="$(_peer_msg_id)"
        ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        content="[MATRIX-UPDATE-DONE 2026-04-29] agent-bridge update fan-out from ${LOCAL_NAME} reached this peer (status=${peer_status}). Please run /reload-plugins so the channel plugin reconnects to the new build."
        # Build BridgeMessage JSON. Use python3 for safe JSON escaping when
        # available; fall back to a hand-rolled writer (good enough for the
        # fixed strings we generate here — no user-controlled content).
        local_msg_file="$(mktemp -t agent-bridge-fanout-msg.XXXXXX)"
        if command -v python3 >/dev/null 2>&1; then
          python3 - "$msg_id" "$LOCAL_NAME" "$peer" "$content" "$ts" >"$local_msg_file" <<'PY'
import json, sys
mid, sender, to, content, ts = sys.argv[1:6]
msg = {
    "id": mid,
    "from": sender,
    "to": to,
    "type": "message",
    "content": content,
    "timestamp": ts,
    "replyTo": None,
    "ttl": 86400,
    "target": "claude-code",
    "fromTarget": "claude-code",
}
print(json.dumps(msg))
PY
        else
          # Hand-rolled (only used on systems without python3 — modern macOS
          # always ships python3; this is a safety net).
          esc_content="${content//\\/\\\\}"
          esc_content="${esc_content//\"/\\\"}"
          {
            printf '{'
            printf '"id":"%s",' "$msg_id"
            printf '"from":"%s",' "$LOCAL_NAME"
            printf '"to":"%s",' "$peer"
            printf '"type":"message",'
            printf '"content":"%s",' "$esc_content"
            printf '"timestamp":"%s",' "$ts"
            printf '"replyTo":null,'
            printf '"ttl":86400,'
            printf '"target":"claude-code",'
            printf '"fromTarget":"claude-code"'
            printf '}'
          } >"$local_msg_file"
        fi

        if (( DRY_RUN )); then
          say "    [dry-run] $peer: would SFTP $local_msg_file -> ~/.agent-bridge/inbox/claude-code/${msg_id}.json"
          rm -f "$local_msg_file"
          continue
        fi

        say "    -> $peer: delivering ${msg_id}.json"
        set +e
        _peer_sftp_put_inbox "$peer" "$local_msg_file" "${msg_id}.json" >/dev/null 2>&1
        sftp_ec=$?
        set -e
        rm -f "$local_msg_file"
        if (( sftp_ec == 0 )); then
          say "    -> $peer: BridgeMessage delivered"
        else
          warn "$peer: BridgeMessage SFTP failed (exit $sftp_ec) — peer will not auto-/reload-plugins"
        fi
      done
      fi  # end: if (( ${#PEER_NAMES[@]} ))
    fi

    # ---- summary ------------------------------------------------------------

    hr
    say "==> Fan-out summary:"
    if (( ${#PEER_RESULTS[@]} == 0 )); then
      say "    no peers"
    else
      for r in "${PEER_RESULTS[@]}"; do
        say "    - $r"
      done
    fi
  fi
fi
