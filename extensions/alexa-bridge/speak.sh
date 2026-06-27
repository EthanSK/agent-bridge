#!/usr/bin/env bash
# ============================================================================
# speak.sh — the SPEAK-BACK leg of the Alexa fire-and-forget loop.
#
# Usage:  speak.sh "<text to announce on the Echo>"
#
# The Alexa receiver (src/server.mjs) injects a task into Claude Code and acks
# fast. When the agent FINISHES the task, it runs THIS script to ANNOUNCE the
# result on the Echo out-of-band — there is NO 8-second limit here because we
# talk to Amazon's UNOFFICIAL voice/announcement API directly, not through the
# Alexa skill request/response cycle.
#
# ── HOW THE SPEAK-BACK WORKS (external system: unofficial Amazon API) ────────
#   We wrap thorsten-gehrig's `alexa_remote_control.sh`
#   (https://github.com/thorsten-gehrig/alexa-remote-control), a community shell
#   tool that drives Amazon's PRIVATE Alexa web API using a logged-in cookie. We
#   invoke its TTS command:
#       alexa_remote_control.sh -d "<device>" -e "speak:<text>"
#   which makes the named Echo SPEAK the given text.
#
# ── ⚠️ UNOFFICIAL-API FRAGILITY (read this) ─────────────────────────────────
#   This leg is INHERENTLY fragile:
#     • It uses an UNDOCUMENTED Amazon API — Amazon can (and periodically does)
#       change endpoints / auth and break alexa_remote_control.sh.
#     • The login COOKIE expires periodically (often ~14 days) and must be
#       re-generated via a manual one-time auth (Amazon email + password + OTP).
#       Ethan must do that himself; no agent can complete the 2FA.
#   Because of all this, we ALWAYS have a safety net: if alexa_remote_control.sh
#   is MISSING, or returns non-zero, or its output smells like an auth failure,
#   we FALL BACK to posting the result to Telegram so the result is NEVER lost.
#
# ── CONFIG RESOLUTION ────────────────────────────────────────────────────────
#   Reads, in order of precedence:
#     1. Environment variables:  ALEXA_DEVICE, ALEXA_REMOTE_CONTROL_SH
#     2. A `speak.config` file next to this script (KEY="value" lines)
#     3. Built-in defaults
#   speak.config is git-ignored (it names your specific Echo) — see
#   speak.config.example for the template.
#
# Exit codes: 0 if the result was delivered SOMEHOW (Echo OR Telegram fallback);
#             non-zero only if BOTH the Echo speak AND the Telegram fallback
#             failed (truly nothing got through).
# ============================================================================

set -u

# ── Resolve this script's own dir so config/relative lookups are stable ──────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/speak.config"

# ── The text to speak is the single argument ─────────────────────────────────
TEXT="${1:-}"
if [ -z "$TEXT" ]; then
    echo "speak.sh: usage: speak.sh \"<text to announce>\"" >&2
    exit 2
fi

# ── Load speak.config if present (simple KEY=value sourcing) ─────────────────
# We `source` it so it can set ALEXA_DEVICE / ALEXA_REMOTE_CONTROL_SH. It's a
# trusted local file (git-ignored, written by Ethan), so sourcing is acceptable.
if [ -f "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
fi

# ── Resolve config with env > config-file > default precedence ───────────────
# ALEXA_DEVICE: the spoken/visible NAME of the target Echo (as it appears in the
# Alexa app). REQUIRED for a real speak; if unset we still attempt then fall back.
ALEXA_DEVICE="${ALEXA_DEVICE:-}"

# Path to alexa_remote_control.sh. Default to the stable install location the
# README/installer use. Override via env or speak.config.
ALEXA_REMOTE_CONTROL_SH="${ALEXA_REMOTE_CONTROL_SH:-$HOME/.config/alexa_remote_control/alexa_remote_control.sh}"

# ── Telegram fallback config (mirrors notify_telegram() in the watchdog) ─────
# Reads bot token from ~/.claude/channels/telegram/.env (TELEGRAM_BOT_TOKEN=...)
# and chat_id from the first entry of ~/.claude/channels/telegram/access.json
# allowFrom[]. Fails closed (returns non-zero) if either is missing.
TELEGRAM_ENV_FILE="$HOME/.claude/channels/telegram/.env"
TELEGRAM_ACCESS_FILE="$HOME/.claude/channels/telegram/access.json"

# ── HTML-escape helper for the Telegram message body ─────────────────────────
# Telegram is sent with parse_mode=HTML, so &, <, > in the result text would
# break the parser. Escape them. (Order matters: & first.)
html_escape() {
    local s="$1"
    s="${s//&/&amp;}"
    s="${s//</&lt;}"
    s="${s//>/&gt;}"
    printf '%s' "$s"
}

# ── send_telegram_fallback <reason> ──────────────────────────────────────────
# Posts the result to Telegram, prefixed so Ethan knows it's the Alexa result
# AND that the Echo speak-back did NOT fire (with the reason). Returns 0 on a
# successful Bot API call, non-zero otherwise. Fails closed if creds missing.
send_telegram_fallback() {
    local reason="$1"

    if [ ! -f "$TELEGRAM_ENV_FILE" ]; then
        echo "speak.sh: telegram fallback unavailable (no $TELEGRAM_ENV_FILE)" >&2
        return 1
    fi
    if [ ! -f "$TELEGRAM_ACCESS_FILE" ]; then
        echo "speak.sh: telegram fallback unavailable (no $TELEGRAM_ACCESS_FILE)" >&2
        return 1
    fi

    local bot_token chat_id
    bot_token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TELEGRAM_ENV_FILE" | head -1 | cut -d= -f2-)
    # Pull allowFrom[0] from the access JSON via python3 (bundled on macOS).
    chat_id=$(/usr/bin/python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('allowFrom') or [''])[0])" "$TELEGRAM_ACCESS_FILE" 2>/dev/null)

    if [ -z "$bot_token" ] || [ -z "$chat_id" ]; then
        echo "speak.sh: telegram fallback unavailable (missing token or chat_id)" >&2
        return 1
    fi

    # Build the HTML message. The bracket tag mirrors Ethan's Telegram-format
    # convention so it slots into his chat naturally.
    local safe_text safe_reason msg
    safe_text="$(html_escape "$TEXT")"
    safe_reason="$(html_escape "$reason")"
    msg="<b><i>[alexa-bridge]</i></b> 🔇 Echo speak-back failed; here's your agent result.

<b>Result:</b> ${safe_text}

<i>(Echo fallback reason: ${safe_reason})</i>"

    # Fire the Bot API call. Capture the response so failures are visible in logs.
    local resp
    resp=$(curl -s --max-time 10 \
        "https://api.telegram.org/bot${bot_token}/sendMessage" \
        --data-urlencode "chat_id=${chat_id}" \
        --data-urlencode "text=${msg}" \
        --data-urlencode "parse_mode=HTML" \
        --data-urlencode "disable_notification=false" 2>&1)

    # Telegram returns {"ok":true,...} on success. Grep for it.
    if printf '%s' "$resp" | grep -q '"ok":true'; then
        echo "speak.sh: delivered result via Telegram fallback" >&2
        return 0
    fi
    echo "speak.sh: telegram fallback POST failed: $(printf '%s' "$resp" | head -c 200)" >&2
    return 1
}

# ── Attempt the Echo speak via alexa_remote_control.sh ───────────────────────
# Returns 0 on a clean speak, non-zero on any failure (missing tool, non-zero
# exit, or output that smells like an auth lapse). We never let a failure here
# kill the script — the caller falls back to Telegram.
attempt_echo_speak() {
    # 1) Tool missing → can't speak.
    if [ ! -f "$ALEXA_REMOTE_CONTROL_SH" ]; then
        echo "speak.sh: alexa_remote_control.sh not found at $ALEXA_REMOTE_CONTROL_SH" >&2
        return 10
    fi

    # 2) No target device configured → we can't address an Echo reliably.
    if [ -z "$ALEXA_DEVICE" ]; then
        echo "speak.sh: ALEXA_DEVICE not set (env or speak.config) — cannot target an Echo" >&2
        return 11
    fi

    # 3) Run the speak command, capturing stdout+stderr so we can sniff for auth
    #    failures even when the tool exits 0 (it sometimes prints an error but
    #    still returns 0 when the cookie is stale).
    local out rc
    out=$(bash "$ALEXA_REMOTE_CONTROL_SH" -d "$ALEXA_DEVICE" -e "speak:${TEXT}" 2>&1)
    rc=$?

    # 4) Non-zero exit → failed.
    if [ "$rc" -ne 0 ]; then
        echo "speak.sh: alexa_remote_control.sh exited $rc: $(printf '%s' "$out" | head -c 300)" >&2
        return "$rc"
    fi

    # 5) Auth-lapse detection. The unofficial tool, when its cookie is expired,
    #    typically prints messages mentioning login / cookie / authentication /
    #    captcha rather than failing hard. Treat any such marker as a failure so
    #    we fall back to Telegram instead of silently announcing nothing.
    if printf '%s' "$out" | grep -qiE 'login|cookie.*(expired|invalid|missing)|authenticat|captcha|not.*logged|password'; then
        echo "speak.sh: alexa_remote_control.sh output indicates an auth lapse: $(printf '%s' "$out" | head -c 300)" >&2
        return 12
    fi

    echo "speak.sh: spoke on Echo '$ALEXA_DEVICE'" >&2
    return 0
}

# ── Main flow: try Echo, else Telegram fallback ──────────────────────────────
if attempt_echo_speak; then
    exit 0
fi

# Echo failed for some reason — capture a human reason string for the fallback.
ECHO_FAIL_REASON="alexa_remote_control.sh unavailable, errored, or not authenticated (cookie may have expired — re-run the one-time auth)"
if send_telegram_fallback "$ECHO_FAIL_REASON"; then
    # We delivered SOMEHOW (Telegram), so the loop succeeded from the user's POV.
    exit 0
fi

# Truly nothing got through — Echo AND Telegram both failed.
echo "speak.sh: FAILED to deliver result via Echo OR Telegram" >&2
exit 1
