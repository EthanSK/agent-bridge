#!/usr/bin/env bash
#
# agent-bridge/scripts/check-update.sh
# ------------------------------------
# [AUTO-UPDATE-CHECK 2026-04-29]
# [AUTO-UPDATE-COORD-LOCK 2026-04-30]
#
# Cheap "is there an update available" probe. Runs `git fetch` against the
# agent-bridge source checkout, compares HEAD to origin/main, and — if origin
# is ahead — drops a [BRIDGE-UPDATE-AVAILABLE] message into the local
# agent-bridge inbox so the running harness (Claude Code via the channel
# plugin, OpenClaw, or anything else watching its own inbox subdir) sees it
# and can decide whether to apply.
#
# Designed to be safe to run from cron / SessionStart / a poll loop / the
# MCP server's startup path:
#
#   - Silent when there's nothing new (no log spam).
#   - Idempotent: tracks the last origin SHA we notified about in
#     ~/.agent-bridge/.last-update-notified-head so we don't drop the same
#     message every minute.
#   - Network-cheap: just `git fetch --quiet` + a couple of rev-parse calls.
#     No `git pull`, no rebuild — the harness decides when (and whether) to
#     actually run scripts/update.sh.
#   - Multi-target: by default drops one message into every inbox subdir
#     under ~/.agent-bridge/inbox/* that already exists (claude-code,
#     openclaw/*, etc.) so any harness on this host that polls its own
#     subdir will see it. Receivers coordinate with
#     scripts/auto-update-coord.sh before running pull/build/reload so this
#     fan-out does not create same-host git/npm/plugin-cache races.
#   - Kill switch: AGENT_BRIDGE_AUTO_UPDATE_CHECK=0 (or false/off/no) makes
#     this script exit 0 silently without doing anything. Default = on.
#
# Usage:
#   scripts/check-update.sh                  # cheap probe; silent unless update
#   scripts/check-update.sh --verbose        # always print status
#   scripts/check-update.sh --force          # ignore the sentinel and re-notify
#   scripts/check-update.sh --target=NAME    # drop only into the named inbox
#                                              subdir (e.g. claude-code,
#                                              openclaw/clawdiboi2). Without
#                                              this flag, fan out to all
#                                              existing subdirs.
#   scripts/check-update.sh --dry-run        # print what would happen, but
#                                              do not write any files
#
# Environment:
#   AGENT_BRIDGE_AUTO_UPDATE_CHECK
#       Set to 0 / false / off / no to skip the check entirely (silent exit 0).
#       Any other value (including unset) leaves the check enabled. This is
#       the kill switch the user asked for in voice 327 — on by default,
#       opt-out via env var.
#
# Exit codes:
#   0 — success (whether or not anything was new)
#   1 — git or filesystem error
#   2 — not a git checkout / unusable repo

set -euo pipefail

# ---------- Kill switch ------------------------------------------------------

case "${AGENT_BRIDGE_AUTO_UPDATE_CHECK:-1}" in
  0|false|FALSE|False|off|OFF|Off|no|NO|No|disabled|DISABLED)
    exit 0
    ;;
esac

# ---------- Args -------------------------------------------------------------

VERBOSE=0
FORCE=0
DRY_RUN=0
TARGET_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --target=*) TARGET_OVERRIDE="${arg#--target=}" ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

say() { (( VERBOSE )) && echo "$@" >&2 || true; }
warn() { echo "WARN: $*" >&2; }

shell_quote() {
  # Single-quote a string for display in a copy/pasteable shell command.
  # This is intentionally tiny/portable (macOS bash 3.2 compatible).
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# ---------- Locate repo root -------------------------------------------------

SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SRC" ]; do
  D="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
  SCRIPT_SRC="$(readlink "$SCRIPT_SRC")"
  [[ "$SCRIPT_SRC" != /* ]] && SCRIPT_SRC="$D/$SCRIPT_SRC"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SRC")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$REPO_ROOT/.git" ]]; then
  warn "$REPO_ROOT is not a git checkout — skipping update check."
  exit 2
fi

cd "$REPO_ROOT"

# ---------- Probe origin -----------------------------------------------------

# Best-effort fetch. A network failure should not be fatal — if origin is
# unreachable we just exit silently (the next invocation will retry).
if ! git fetch --quiet origin main 2>/dev/null; then
  say "git fetch origin main failed (offline?) — skipping."
  exit 0
fi

LOCAL_HEAD="$(git rev-parse HEAD 2>/dev/null || echo "")"
ORIGIN_HEAD="$(git rev-parse origin/main 2>/dev/null || echo "")"
if [[ -z "$LOCAL_HEAD" || -z "$ORIGIN_HEAD" ]]; then
  warn "could not resolve HEAD or origin/main — skipping."
  exit 1
fi

if [[ "$LOCAL_HEAD" == "$ORIGIN_HEAD" ]]; then
  say "agent-bridge up to date at ${LOCAL_HEAD:0:7}"
  exit 0
fi

# Only care when origin is STRICTLY AHEAD of us (i.e. there are commits we
# don't have). If we're ahead of origin or have diverged, that's a developer
# state — leave it alone.
if ! git merge-base --is-ancestor "$LOCAL_HEAD" "$ORIGIN_HEAD" 2>/dev/null; then
  say "local HEAD ${LOCAL_HEAD:0:7} not an ancestor of origin/main ${ORIGIN_HEAD:0:7} — local is ahead or diverged; skipping notification."
  exit 0
fi

BEHIND="$(git rev-list --count "$LOCAL_HEAD..$ORIGIN_HEAD" 2>/dev/null || echo "?")"

# ---------- Sentinel ---------------------------------------------------------

SENTINEL="$HOME/.agent-bridge/.last-update-notified-head"
if (( ! FORCE )) && [[ -f "$SENTINEL" ]]; then
  PREV="$(tr -d '[:space:]' < "$SENTINEL" 2>/dev/null || echo "")"
  if [[ "$PREV" == "$ORIGIN_HEAD" ]]; then
    say "already notified about ${ORIGIN_HEAD:0:7}; skipping (use --force to re-notify)."
    exit 0
  fi
fi

# ---------- Build the message ------------------------------------------------

MACHINE_FILE="$HOME/.agent-bridge/machine-name"
if [[ -f "$MACHINE_FILE" ]]; then
  MACHINE="$(tr -d '[:space:]' < "$MACHINE_FILE")"
else
  MACHINE="$(hostname 2>/dev/null || echo "agent-bridge-host")"
  MACHINE="${MACHINE%%.*}"
fi
[[ -z "$MACHINE" ]] && MACHINE="agent-bridge-host"

ID="msg-update-$(date -u +%Y%m%dT%H%M%SZ)-${ORIGIN_HEAD:0:8}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
SUBJECTS="$(git log --format='  %h %s' "$LOCAL_HEAD..$ORIGIN_HEAD" 2>/dev/null | head -10)"

# ---------- Coordination helper details --------------------------------------

COORD_HELPER="$SCRIPT_DIR/auto-update-coord.sh"
COORD_COMMAND=""
COORD_STATUS=""
COORD_LOCK_PATH=""
if [[ -x "$COORD_HELPER" ]]; then
  quoted_repo="$(shell_quote "$REPO_ROOT")"
  quoted_cycle="$(shell_quote "$ORIGIN_HEAD")"
  COORD_COMMAND="cd $quoted_repo && ./scripts/auto-update-coord.sh run --source-dir $quoted_repo --cycle $quoted_cycle -- ./scripts/update.sh --auto"
  COORD_STATUS="$("$COORD_HELPER" status --source-dir "$REPO_ROOT" --cycle "$ORIGIN_HEAD" --plain 2>/dev/null || true)"
  COORD_LOCK_PATH="$(printf '%s\n' "$COORD_STATUS" | sed -n 's/^lock_path=//p' | head -1)"
else
  COORD_COMMAND="cd $(shell_quote "$REPO_ROOT") && ./scripts/update.sh --auto"
fi

CONTENT_HEADER="[BRIDGE-UPDATE-AVAILABLE] agent-bridge has $BEHIND new commit(s) on origin/main since ${LOCAL_HEAD:0:7} (now ${ORIGIN_HEAD:0:7})."
CONTENT_BODY="Receiver subagents MUST coordinate before applying this update so same-host Claude Code/OpenClaw listeners do not race on git, npm, or plugin-cache writes. Preferred command:

${COORD_COMMAND}

Only the receiver that acquires the local coord lock should pull/build/reload. Exit 73 means another local receiver is already handling this checkout; exit 75 means the minimum retry interval has not elapsed for this same origin SHA. The check is idempotent — the same origin SHA will not re-notify until a newer one lands. Disable entirely with AGENT_BRIDGE_AUTO_UPDATE_CHECK=0."

# Use node to assemble the JSON payload — agent-bridge already requires node,
# and node handles all the escaping (multiline content, quotes, etc.) safely.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  warn "node not on PATH — cannot serialize update notification JSON. Skipping."
  exit 1
fi

JSON_PAYLOAD="$(
  AB_ID="$ID" \
  AB_FROM="$MACHINE" \
  AB_HEADER="$CONTENT_HEADER" \
  AB_BODY="$CONTENT_BODY" \
  AB_SUBJECTS="$SUBJECTS" \
  AB_COORD_STATUS="$COORD_STATUS" \
  AB_COORD_LOCK_PATH="$COORD_LOCK_PATH" \
  AB_TIMESTAMP="$TIMESTAMP" \
  "$NODE_BIN" -e '
    const subjects = process.env.AB_SUBJECTS || "";
    const coordStatus = process.env.AB_COORD_STATUS || "";
    const coordLockPath = process.env.AB_COORD_LOCK_PATH || "";
    const coordLines = [];
    if (coordLockPath) {
      coordLines.push(`Coord lock: ${coordLockPath}`);
    }
    if (coordStatus) {
      const state = Object.fromEntries(coordStatus.split(/\n/).filter(Boolean).map((line) => {
        const idx = line.indexOf("=");
        return idx === -1 ? [line, ""] : [line.slice(0, idx), line.slice(idx + 1)];
      }));
      coordLines.push(`Coord state: ${state.lock_state || "unknown"}` + (state.last_attempt_iso ? `; last attempt ${state.last_attempt_iso}` : ""));
    }
    const content = [
      process.env.AB_HEADER,
      "",
      "Incoming commits:",
      subjects,
      "",
      process.env.AB_BODY,
      ...(coordLines.length ? ["", ...coordLines] : []),
    ].join("\n");
    const payload = {
      id: process.env.AB_ID,
      from: process.env.AB_FROM,
      to: process.env.AB_FROM,
      type: "message",
      content,
      timestamp: process.env.AB_TIMESTAMP,
      replyTo: null,
      ttl: 3600,
      target: "PLACEHOLDER_TARGET",
      fromTarget: "agent-bridge-auto-update",
    };
    process.stdout.write(JSON.stringify(payload, null, 2));
  '
)"

# ---------- Pick targets -----------------------------------------------------

INBOX_ROOT="$HOME/.agent-bridge/inbox"
mkdir -p "$INBOX_ROOT"

declare -a TARGETS=()
if [[ -n "$TARGET_OVERRIDE" ]]; then
  TARGETS+=("$TARGET_OVERRIDE")
else
  # Always notify claude-code (the canonical channel-owner inbox) even if the
  # subdir doesn't exist yet — create it on demand.
  TARGETS+=("claude-code")

  # Also fan out to any other harness LEAF subdirs already present (e.g.
  # openclaw/<account>). Skip:
  #   - dotfile dirs (.archive, .processed, etc.) and _unrouted
  #   - claude-code (already covered above)
  #   - non-leaf dirs (intermediate namespace prefixes like `openclaw/`
  #     when openclaw/<account> exists). A "leaf" here = inbox subdir with
  #     no further subdirs of its own; only those represent real harness
  #     inboxes that a watcher would scan.
  while IFS= read -r -d '' dir; do
    rel="${dir#$INBOX_ROOT/}"
    case "$rel" in
      .*|*/.*|_*|*/_*) continue ;;
      claude-code) continue ;;
    esac
    # Skip if this dir has any subdirectories (intermediate namespace).
    if [[ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null)" ]]; then
      continue
    fi
    TARGETS+=("$rel")
  done < <(find "$INBOX_ROOT" -mindepth 1 -maxdepth 2 -type d -print0 2>/dev/null)
fi

# ---------- Drop messages ----------------------------------------------------

DROPPED=0
for target in "${TARGETS[@]}"; do
  inbox_dir="$INBOX_ROOT/$target"
  mkdir -p "$inbox_dir"

  payload="${JSON_PAYLOAD/PLACEHOLDER_TARGET/$target}"
  tmp="$inbox_dir/$ID.json.tmp"
  final="$inbox_dir/$ID.json"

  if (( DRY_RUN )); then
    say "[dry-run] would write $final ($BEHIND commits behind, target=$target)"
    DROPPED=$((DROPPED + 1))
    continue
  fi

  if printf '%s\n' "$payload" > "$tmp" && mv -f "$tmp" "$final"; then
    say "dropped update notification → $final"
    DROPPED=$((DROPPED + 1))
  else
    warn "failed to write $final"
    rm -f "$tmp" 2>/dev/null || true
  fi
done

# Mark sentinel only if at least one drop succeeded (or dry-run, since the
# user explicitly asked to see what would happen).
if (( DROPPED > 0 )) && (( ! DRY_RUN )); then
  mkdir -p "$(dirname "$SENTINEL")"
  printf '%s\n' "$ORIGIN_HEAD" > "$SENTINEL"
fi

if (( VERBOSE )); then
  say "agent-bridge: $BEHIND commit(s) behind origin/main; notified $DROPPED inbox(es)."
fi

exit 0
