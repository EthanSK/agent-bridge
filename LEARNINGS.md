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
**Date:** 2026-07-14T19:34:44Z
**Trigger:** Ethan voice: global agent bridge shared context feature build 2026-07-14
**Symptom:** Needed a fleet-wide SHARED CONTEXT store: learnings/findings any agent on any paired machine can search + must contribute globally-applicable learnings to (the missing layer above per-repo LEARNINGS.md and per-harness memory)
**Root cause:** N/A new feature (4.9.0). KEY DESIGN: replication rides the sshExec SIDE-EFFECT path (like bridge_notify), NEVER the inbox/watcher path — a replica write must not depend on a live remote channel-owner. Store = append-only NDJSON full replica per machine (~/.agent-bridge/shared-context/learnings.ndjson), deduped by LOWERCASE-uuid id so push-on-write + sync reconciliation + replays are all idempotent. remove is local-only by design (no tombstones); remove --fleet repeats it everywhere.
**Fix:** mcp-server/src/learnings.ts (store ops + buildRemoteIngestCommand) + bridge_learnings_add/search in tools.ts + SHARED CONTEXT section in index.ts server instructions; cmd_learnings verbs (add/search/list/show/ingest/sync/remove) in the bash CLI — mirrored bash/TS pair like the notify renderer. GOTCHAS HIT: (1) bash add was not deduping tags while TS was — caught by parity tests; (2) test/cli-learnings.sh MUST pin AGENT_BRIDGE_HOME because the 4.4.0 sandboxed-HOME fallback silently repoints an empty $TMP sandbox at the REAL user store (it wrote 2 test entries into the live store before the pin); (3) jq-in-assignment under set -e/pipefail needs '|| true' guards (head -1 SIGPIPEs jq); (4) grep for printf-%q-escaped ssh argv with grep -qF 'learnings\ ingest' not plain spaces; (5) Mini→MBP push failed because Mini cannot SSH to MBP (LAN 192.168.1.208 timeout, pre-existing asymmetry) — sync FROM the reachable side is the designed workaround and worked. E2E verified both directions across MBP/Mac-Mini/OldMacBookPro; SHITTYWINDOWS is an SSH-endpoint-only peer with no agent-bridge CLI so learnings replication to it always no-ops gracefully. PR #5, merge commit 17723d9.
**Commit:** 17723d9
**Guard:** mcp-server/test/learnings-store.test.mjs (real-shell hostile-body round-trip vs stubbed remote CLI, dedupe idempotency, corrupt-line resilience) + test/cli-learnings.sh (10 cases incl. push-on-write over stubbed ssh, uppercase-id normalization)
---

---
**Date:** 2026-06-27T22:05:13Z
**Trigger:** alexa-bridge callback refinement (teammate session) 2026-06-27
**Symptom:** Alexa fire-and-forget result callback should not depend on the fragile unofficial Echo speak-back
**Root cause:** Design refinement. Echo speak-back (alexa_remote_control.sh) is unofficial + cookie expires ~2wk. The reliable replacement is agent-bridge v4.8.0's notify verb (native macOS banner, SSHes to target Mac) + a Telegram message. Both are official/reliable paths.
**Fix:** src/server.mjs: NOTIFY_TARGET env (default MacBookPro) baked into buildInjectContent prompt -> agent runs 'agent-bridge notify <target> --title ... --message ... --sound default' AND Telegram, with speak.sh Echo demoted to optional. inject.mjs CLI mirrors it; speak.sh + README reframed (Echo optional, cookie auth not a blocker).
**Commit:** da567a7
**Guard:** Boot log prints notify target; injected prompt verified on Mini to carry notify+telegram-required + speak.sh-optional; agent-bridge notify confirmed present (v4.8.0). NOTE: a parallel teammate session pushed da567a7 on top of my 0f0f81a (which had the real source changes) — da567a7 only touched package-lock; final origin/main state correct. Watch for fast-forward races when two sessions ship the same refinement.
---

---
**Date:** 2026-06-27T21:48:27Z
**Trigger:** alexa fire-and-forget agent loop build 2026-06-27
**Symptom:** Want to speak a freeform task to an Amazon Echo and have an agent do it + report back, but Alexa custom skills must respond within ~8s while agent work takes minutes
**Root cause:** N/A new feature. KEY DESIGN: fire-and-forget split — the Alexa request can ONLY ack (8s deadline), so inject the task via agent-bridge sendLocalMessage (fast atomic file write, does NOT await agent work) and return the ack immediately; the long result comes back on a SEPARATE leg (speak.sh) not bound by 8s. speak-back uses Amazon's UNOFFICIAL API (alexa_remote_control.sh) which is fragile (cookie expires ~2wk, Amazon can break it) so Telegram fallback is the guarantee. AMAZON.SearchQuery slots cannot be the entire utterance — need carrier words in samples.
**Fix:** extensions/alexa-bridge: src/server.mjs (Node-stdlib HTTP receiver, POST /alexa fire-and-forget inject + fast ack, GET /health, optional ?secret= gate); src/inject.mjs (reuses build/inbox.js sendLocalMessage, robust path resolution, never raw-writes inbox); speak.sh (alexa_remote_control.sh -e speak: with auth-lapse detection + Telegram fallback); skill.json (interaction model); launchd KeepAlive agent + install.sh
**Commit:** dcd645c
**Guard:** Verified locally: /health 200, mock IntentRequest returns ack AND writes msg into inbox/claude-code/default via sendLocalMessage (log: delivered locally), speak.sh falls back to Telegram when arc.sh absent. inject failures caught -> graceful ack never an Alexa error. README documents speak-back fragility + Ethan-only Amazon cookie auth.
---

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

