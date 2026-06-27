# Learnings

Per-repo institutional memory for fixes. Every entry below is a real bug we hit + how we solved it. Check this file BEFORE attempting a same-looking fix.

Maintained by the `learnings` skill — see `~/.claude/skills/learnings/skill.md`.

## Format

Each entry looks like:

```
---
**Date:** YYYY-MM-DDTHH:MM:SSZ
**Trigger:** <voice N / message snippet / null>
**Symptom:** <what was visible>
**Root cause:** <what we actually found>
**Fix:** <file:line + short prose + commit SHA>
**Guard:** <test / lint / watchdog / comment that prevents regression — or 'none'>
---
```

## Entries

(newest first)

---
**Date:** 2026-06-27T20:00:00Z
**Trigger:** bridge_notify macOS-notify design build 2026-06-27
**Symptom:** Needed a way to pop a native macOS notification on any paired Mac (tell the user an agent finished a task on whichever Mac they're at)
**Root cause:** N/A (new feature). Key DESIGN DECISION worth remembering: a notification is a FIRE-AND-FORGET SIDE EFFECT, not an agent message — do NOT route it through the inbox/watcher path (that needs a live remote channel-owner and is async). The inbox path is the wrong tool for banners.
**Fix:** New `bridge_notify` MCP tool + `agent-bridge notify` CLI verb. Routing: machine=local renders in-process (terminal-notifier, osascript fallback); machine=remote runs `sshExec(m, "agent-bridge notify --local …")` so the REMOTE machine's own CLI renders natively there (decides terminal-notifier-vs-osascript by what IT has installed — fallback is load-bearing, Mini may lack terminal-notifier). Renderer lives in TWO mirrored places that must stay byte-identical: `_render_local_notification` (bash) + `renderLocalNotification` (mcp-server/src/notify.ts). Free-form notification text MUST be shell-quoted before entering the SSH command string — `qq()` = `printf '%q'` in bash, `shellQuoteForSsh()` in TS — this is the one place it breaks if done naively. osascript has no subtitle field so subtitle folds into title as "title — subtitle". Files: mcp-server/src/notify.ts (new), mcp-server/src/tools.ts (bridge_notify), agent-bridge (cmd_notify + _render_local_notification + qq). CLI is testable immediately (no MCP restart); the MCP tool calls the same code paths so passing CLI tests imply a working tool.
**Commit:** <see PR>
**Guard:** mcp-server/test/notify-quoting.test.mjs (shellQuoteForSsh round-trips hostile strings through a real shell; buildRemoteNotifyCommand word-split parity) + test/cli-notify.sh (notify --local renders via stubbed terminal-notifier; --sound none silent; missing flags die; osascript fallback when terminal-notifier absent). Version-pin test in unified-channel.test.mjs now references EXPECTED_VERSION constant so future bumps only touch one line.
---
**Date:** 2026-06-27T19:23:01Z
**Trigger:** Nest-to-Mini build task 2026-06-27
**Symptom:** Want a Google Nest / Gemini-for-Home speaker to control a machine's Claude Code by voice; emulated Hue does not work with Google Home
**Root cause:** Google removed local Hue/SSDP discovery in 2017 (emulated Hue is Alexa-only). Google-native local control in 2026 is Matter. Also: matter.js @matter/main 0.17.x StorageService.location is read-only (set env var storage.path instead), and a Matter 'bridge' is built as deviceType.with(BridgedDeviceBasicInformationServer) added to an AggregatorEndpoint — NOT BridgedNodeEndpoint.with(deviceType) (that throws 'Behavior type has no ID')
**Fix:** extensions/google-home-matter: matter.js virtual Matter bridge (Aggregator + BridgedNode per device, OnOff + optional dimmer). On state change, inject() reuses agent-bridge's own build/inbox.js sendLocalMessage() (same as bridge_send_message machine:local) to atomically write inbox/<target>/<id>.json — never raw-drop into inbox roots (quarantined to _unrouted). Brightness 0-254 -> 0-100% -> configurable presets. Config-driven via devices.json; LaunchAgent keeps it alive; persistent storage dir keeps commissioning across reboots
**Commit:** 79a348d
**Guard:** Pinned commissioning passcode/discriminator = stable pairing code; robust build/inbox.js path resolution (env -> repo-relative -> Mini path -> /Users/ethansk symlink); inject failures logged not fatal; README documents finite-vocabulary ceiling
---

