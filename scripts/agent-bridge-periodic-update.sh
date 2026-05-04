#!/usr/bin/env bash
# agent-bridge/scripts/agent-bridge-periodic-update.sh
# ----------------------------------------------------
# [PERIODIC-UPDATE 2026-05-04]
#
# Harness-INDEPENDENT periodic auto-updater for an agent-bridge dev clone.
# Runs every 10 minutes via a launchd LaunchAgent (macOS) — see
# scripts/install-periodic-update.sh.
#
# This is the COMPLEMENT to the in-process 3-hour probe in mcp-server
# (`armAutoUpdateProbe()`). The probe only runs when a Claude Code / OpenClaw
# harness is alive; this LaunchAgent runs whether ANY harness is up or not, so
# fresh logins / unattended Macs still pick up new code.
#
# Steps:
#   1. git fetch origin --prune
#   2. If origin/main differs from HEAD AND the working tree is clean:
#        git pull --ff-only origin main
#   3. If pulled OR mcp-server/build/index.js is missing OR HEAD changed
#      since last build → npm install + npm run build inside mcp-server/
#   4. agent-bridge plugin-registry-rewire (self-heal harness-side registry
#      drift; idempotent no-op if everything's fine)
#   5. (Optional, when invoked with --with-openclaw-mcp-repair) repair the
#      OpenClaw `agent-bridge` MCP server entry to point at the dev clone's
#      mcp-server/build/index.js.
#
# Deliberately does NOT:
#   - Restart the OpenClaw gateway (interactive / heavy-handed).
#   - Type into Claude Code's terminal (/reload-plugins). The user can
#     restart Claude Code at their own cadence — see CLAUDE.md
#     "/reload-plugins is NOT a hot-reload" rule.
#
# Idempotent + safe to re-run. Logs to:
#   ~/.agent-bridge/logs/periodic-update.log               (human readable)
#   ~/.claude/logs/skills.log                              (NDJSON, optional)
#
# Lock prevents concurrent runs (LaunchAgent fires every 10m, while a build
# may still be in progress).

set -uo pipefail

# Resolve PATH for non-interactive launchd context. nvm node lives outside
# the launchd default $PATH on most setups.
export PATH="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"

# ---------- Arg parsing -----------------------------------------------------

WITH_OPENCLAW_MCP_REPAIR=0
for arg in "$@"; do
  case "$arg" in
    --with-openclaw-mcp-repair) WITH_OPENCLAW_MCP_REPAIR=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------- Config / paths --------------------------------------------------

REPO="${AGENT_BRIDGE_REPO:-$HOME/Projects/agent-bridge}"
LOG_DIR="$HOME/.agent-bridge/logs"
RUN_DIR="$HOME/.agent-bridge/run"
STATE_DIR="$HOME/.agent-bridge/state"
LOG_FILE="$LOG_DIR/periodic-update.log"
LOCK_DIR="$RUN_DIR/periodic-update.lock"
BUILT_HEAD_FILE="$STATE_DIR/built-head.txt"

mkdir -p "$LOG_DIR" "$RUN_DIR" "$STATE_DIR"
chmod 700 "$LOG_DIR" "$RUN_DIR" "$STATE_DIR" 2>/dev/null || true

# Tee stdout+stderr to the human-readable log while also keeping output for
# launchd's StandardOutPath / StandardErrorPath redirection (which points at
# the same file — duplication is fine, we want one source of truth).
exec >>"$LOG_FILE" 2>&1

# ---------- NDJSON event log helper ----------------------------------------
#
# Source ~/.claude/scripts/skill-log.sh if it exists so we get the same
# unified log used by every other ~/.claude/ skill. Falls through silently
# when running on a machine without dot-claude.

LOG_SKILL="agent-bridge-periodic-update"
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

# ---------- Helpers ---------------------------------------------------------

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo "=== $(now_iso) agent-bridge periodic-update start ==="
emit info "skill.start" "{\"repo\":\"$REPO\",\"with_openclaw_mcp_repair\":$WITH_OPENCLAW_MCP_REPAIR}"

# ---------- Lock ------------------------------------------------------------

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "already running (lock held by previous invocation); exiting"
  emit info "skill.skip" '{"reason":"lock_held"}'
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# ---------- Repo guard ------------------------------------------------------

if [[ ! -d "$REPO/.git" ]]; then
  echo "ERROR: repo missing or not a git checkout: $REPO"
  emit error "skill.error" "{\"reason\":\"repo_missing\",\"path\":\"$REPO\"}"
  exit 1
fi

cd "$REPO"

# ---------- Step 1: fetch ---------------------------------------------------

if ! git fetch origin --prune; then
  echo "ERROR: git fetch failed"
  emit error "skill.error" '{"reason":"git_fetch_failed"}'
  exit 1
fi

before="$(git rev-parse HEAD)"
remote="$(git rev-parse origin/main)"
changed=0

# ---------- Step 2: pull (only when clean) ----------------------------------

dirty=0
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  dirty=1
fi

if [[ "$before" != "$remote" ]]; then
  if [[ "$dirty" == "1" ]]; then
    echo "repo has local changes; skipping auto-pull: $before -> $remote"
    emit warn "skill.skip" "{\"reason\":\"dirty_working_tree\",\"local\":\"$before\",\"remote\":\"$remote\"}"
  else
    echo "updating repo: $before -> $remote"
    if git pull --ff-only origin main; then
      changed=1
      emit info "git.pulled" "{\"before\":\"$before\",\"after\":\"$remote\"}"
    else
      echo "ERROR: git pull --ff-only failed"
      emit error "skill.error" '{"reason":"git_pull_failed"}'
      exit 1
    fi
  fi
else
  echo "repo already current: $before"
fi

chmod +x "$REPO/agent-bridge" 2>/dev/null || true

# ---------- Step 3: build (when needed) -------------------------------------

head_now="$(git rev-parse HEAD)"
built_head=""
if [[ -f "$BUILT_HEAD_FILE" ]]; then
  built_head="$(cat "$BUILT_HEAD_FILE" 2>/dev/null || true)"
fi

if [[ "$changed" == "1" || ! -f "$REPO/mcp-server/build/index.js" || "$built_head" != "$head_now" ]]; then
  echo "building mcp-server (head=$head_now)"
  if (cd "$REPO/mcp-server" && npm install && npm run build); then
    echo "$head_now" > "$BUILT_HEAD_FILE"
    emit info "build.ok" "{\"head\":\"$head_now\"}"
  else
    echo "ERROR: mcp-server build failed"
    emit error "skill.error" "{\"reason\":\"build_failed\",\"head\":\"$head_now\"}"
    exit 1
  fi
else
  echo "build exists and head unchanged; skipping rebuild"
fi

# ---------- Step 4: plugin-registry-rewire ---------------------------------

if [[ -x "$REPO/agent-bridge" ]]; then
  if "$REPO/agent-bridge" plugin-registry-rewire; then
    emit info "registry.rewire_ok" '{}'
  else
    rc=$?
    echo "WARN: plugin-registry-rewire exited rc=$rc (non-fatal; update still landed)"
    emit warn "registry.rewire_failed" "{\"rc\":$rc}"
  fi
else
  echo "WARN: $REPO/agent-bridge not executable; skipping plugin-registry-rewire"
  emit warn "registry.rewire_skipped" '{"reason":"agent-bridge_not_executable"}'
fi

# ---------- Step 5 (optional): OpenClaw MCP repair --------------------------

if [[ "$WITH_OPENCLAW_MCP_REPAIR" == "1" ]]; then
  expected_path="$REPO/mcp-server/build/index.js"
  expected_json="{\"command\":\"node\",\"args\":[\"$expected_path\"],\"env\":{\"AGENT_BRIDGE_ROLE\":\"tools-only\"}}"

  if command -v openclaw >/dev/null 2>&1; then
    if ! openclaw mcp show agent-bridge 2>/dev/null | grep -Fq "$expected_path" || \
       ! openclaw mcp show agent-bridge 2>/dev/null | grep -Fq '"AGENT_BRIDGE_ROLE": "tools-only"'; then
      echo "repairing OpenClaw MCP config for agent-bridge"
      if openclaw mcp set agent-bridge "$expected_json"; then
        emit info "openclaw.mcp_repaired" "{\"path\":\"$expected_path\"}"
      else
        echo "WARN: openclaw mcp set failed"
        emit warn "openclaw.mcp_repair_failed" '{}'
      fi
    else
      echo "OpenClaw MCP config already points at AgentBridge tools-only server"
    fi
  else
    echo "openclaw CLI not found on PATH; skipping OpenClaw MCP repair"
    emit info "openclaw.mcp_repair_skipped" '{"reason":"openclaw_cli_missing"}'
  fi
fi

# ---------- Summary --------------------------------------------------------

cli_version="$(./agent-bridge --version 2>/dev/null || true)"
mcp_version="$(node -p "require('./mcp-server/package.json').version" 2>/dev/null || true)"
head="$(git rev-parse HEAD)"

echo "cli=$cli_version mcp-server=$mcp_version head=$head changed=$changed"
emit info "skill.end" "{\"changed\":$changed,\"cli\":\"$cli_version\",\"mcp\":\"$mcp_version\",\"head\":\"$head\"}"

echo "=== $(now_iso) agent-bridge periodic-update done ==="
