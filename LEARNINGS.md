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
**Date:** 2026-06-27T19:23:01Z
**Trigger:** Nest-to-Mini build task 2026-06-27
**Symptom:** Want a Google Nest / Gemini-for-Home speaker to control a machine's Claude Code by voice; emulated Hue does not work with Google Home
**Root cause:** Google removed local Hue/SSDP discovery in 2017 (emulated Hue is Alexa-only). Google-native local control in 2026 is Matter. Also: matter.js @matter/main 0.17.x StorageService.location is read-only (set env var storage.path instead), and a Matter 'bridge' is built as deviceType.with(BridgedDeviceBasicInformationServer) added to an AggregatorEndpoint — NOT BridgedNodeEndpoint.with(deviceType) (that throws 'Behavior type has no ID')
**Fix:** extensions/google-home-matter: matter.js virtual Matter bridge (Aggregator + BridgedNode per device, OnOff + optional dimmer). On state change, inject() reuses agent-bridge's own build/inbox.js sendLocalMessage() (same as bridge_send_message machine:local) to atomically write inbox/<target>/<id>.json — never raw-drop into inbox roots (quarantined to _unrouted). Brightness 0-254 -> 0-100% -> configurable presets. Config-driven via devices.json; LaunchAgent keeps it alive; persistent storage dir keeps commissioning across reboots
**Commit:** 79a348d
**Guard:** Pinned commissioning passcode/discriminator = stable pairing code; robust build/inbox.js path resolution (env -> repo-relative -> Mini path -> /Users/ethansk symlink); inject failures logged not fatal; README documents finite-vocabulary ceiling
---

