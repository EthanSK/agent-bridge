# google-home-matter — control Claude Code from a Google Nest speaker

An **agent-bridge extension** that lets a **Google Nest / Gemini-for-Home**
speaker drive a machine's running **Claude Code** session by voice.

It does this by exposing a small set of **virtual Matter devices** (smart
"lights"). When you say *"Hey Google, turn on Claude"* — or *"set Claude to
40%"* — Google flips that virtual device's state, and a handler **injects a
routed message into the local Claude Code session** through agent-bridge's own
local-delivery path. Claude then reads the message and acts on the mapped intent.

```
"Hey Google, turn on Claude"  /  "set Claude to 40%"
  → Nest speaker
  → Google Home Matter controller (a hub-class controller already in the home)
  → this extension's virtual Matter device (OnOff + optional dimmer)
  → onOff / level $Changed handler fires
  → inject() → agent-bridge sendLocalMessage()
  → ~/.agent-bridge/inbox/claude-code/default/msg-*.json  (atomic write)
  → agent-bridge file watcher (~2s)
  → <channel source="agent-bridge"> block pushed into the running Claude Code session
  → Claude reads the intent + acts
```

## Why Matter (and not emulated Hue)

Google removed local Philips-Hue/SSDP discovery back in 2017 — **emulated Hue is
Alexa-only now and does NOT work with Google Home**. The Google-native local
control path in 2026 is **Matter**. Google natively supports local Matter
devices, and the target home already has a Matter fabric + a hub-class
controller (confirmed: 2 commissioned `_matter._tcp` nodes on the LAN), so a new
virtual Matter device drops straight in.

## How it plugs into agent-bridge

The injection reuses agent-bridge's **own built module** — it imports
`mcp-server/build/inbox.js` and calls `sendLocalMessage()`, the exact same
function `bridge_send_message` uses internally for the `machine:"local"` case.

That function:
- builds a `msg-<uuid>` id,
- writes the message **atomically** (`.tmp` → rename) into
  `inbox/<target>/<id>.json`,
- stamps a **valid `target`** so the agent-bridge watcher accepts it and pushes
  it into the running session as a `<channel source="agent-bridge">` block.

> ⚠️ We never hand-write / move / SCP JSON into the inbox roots — that gets
> quarantined to `.failed/_unrouted/`. The only correct path is
> `sendLocalMessage()`, which this extension uses.

The path to `build/inbox.js` is resolved robustly (see `src/inject.mjs`):
1. `$AGENT_BRIDGE_INBOX_JS` if set,
2. repo-relative (`../../../mcp-server/build/inbox.js`),
3. the Mini's known dev-clone path,
4. the `/Users/ethansk` symlink form.

The first one that exists wins. **The core mcp-server must be built**
(`cd mcp-server && npm install && npm run build`) so `build/inbox.js` exists.

## Configure: `devices.json`

Each entry in `devices[]` becomes one virtual Matter device (one spoken name).
Edit this file to add/rename triggers and to change the prompts they inject.
**Restart the server after editing** (`launchctl kickstart -k …`).

Top-level keys:
- `target` — which inbox receives the injected messages (default
  `claude-code/default`).
- `ttlSeconds` — TTL stamped on each message (default `86400`; the watcher
  consumes within ~2s anyway).
- `fabricLabel` — the label Google shows for the Matter bridge.

Per-device keys:
- `name` — the spoken trigger ("Hey Google, turn on **Claude**").
- `dimmable` — `true` adds a brightness (LevelControl) cluster so 0–100% becomes
  an argument; `false` = plain on/off.
- `onTemplate` / `offTemplate` — the prompt injected on on / off. Empty string =
  inject nothing for that edge.
- `presets` — optional `label: [lowPct, highPct]` map for dimmables, used to
  fill the `{preset}` placeholder.

Template placeholders: `{name}`, `{state}` (`on`/`off`), `{brightness}` (raw
0–254), `{brightnessPct}` (0–100), `{preset}` (matched label or empty).

### Brightness-as-argument convention

Matter `LevelControl.currentLevel` is **0–254**. Google converts the spoken
percentage to that scale itself. The handler reads the level, computes a 0–100%,
matches it against the device's `presets` ranges, and substitutes both into the
template. So *"set Claude to 40%"* → `brightness=40`, and with the default
presets that lands in preset **B** (34–66%). Saying *"turn on Claude"* with no
percentage uses whatever the last level was (Google usually sends 100%).

## The 3 default triggers (placeholders — tune them)

These are sensible starters; edit `devices.json` to taste:

1. **Claude** (dimmable) — brightness selects a status-report preset:
   - **A** (1–33%) → "give me a current fleet status report"
   - **B** (34–66%) → "summarize what's running across my subagents"
   - **C** (67–100%) → "full deep status: fleet + subagents + blockers"
   - off → "stand down / pause the current preset task"
2. **Backup** (on/off) → "kick off the Engineering Dopamine → Google Drive backup"
3. **Standup** (on/off) → "post a short daily status summary to my Telegram"

## Run / install on the Mini

```bash
cd ~/Projects/agent-bridge

# Ensure the core module the inject path imports is built:
( cd mcp-server && npm install && npm run build )

# Install + start this extension:
cd extensions/google-home-matter
npm install

# Option A — run in the foreground (prints the pairing code, Ctrl-C to stop):
npm start

# Option B — install the always-on LaunchAgent (survives reboots):
./launchd/install.sh
tail -f ~/.agent-bridge/google-home-matter/logs/google-home-matter.out.log
```

The LaunchAgent (`com.ethansk.agent-bridge-google-home-matter`) uses
`RunAtLoad` + `KeepAlive`, and points Matter's storage at
`~/.agent-bridge/google-home-matter/storage` — a **stable, persistent** dir, so
commissioning survives restarts and reboots (the node comes back already paired).

Useful env overrides:
- `AGENT_BRIDGE_GHM_CONFIG` — path to a different `devices.json`.
- `AGENT_BRIDGE_GHM_STORAGE` — Matter storage dir.
- `AGENT_BRIDGE_GHM_PORT` — Matter operational port (default 5560).
- `AGENT_BRIDGE_GHM_PASSCODE` / `AGENT_BRIDGE_GHM_DISCRIMINATOR` — commissioning
  credentials (pinned so the pairing code is stable across restarts).
- `AGENT_BRIDGE_INBOX_JS` — force the path to agent-bridge's `build/inbox.js`.

## Commission into Google Home (one-time, your only manual step)

On first start (empty storage), the server prints a **manual pairing code** and
a **QR URL** (also in the log). Then:

1. Open the **Google Home** app on your phone (same Wi-Fi / LAN as the Mini).
2. Tap **+ Add** → **Set up device** → **Matter-enabled device**.
3. Either scan the QR URL or choose **"Set up without QR code"** and **enter the
   11-digit manual pairing code**.
4. Google commissions the bridge; the 3 sub-devices (Claude / Backup / Standup)
   appear. Assign them to a room.
5. Now say *"Hey Google, turn on Claude"* — the Mini's Claude Code session
   receives the `<channel source="agent-bridge">` block within ~2 seconds.

After commissioning, **no pairing code is printed on subsequent starts** — that's
expected; the node is already on Google's fabric and just resumes advertising
over mDNS (`_matter._tcp`).

## The finite-vocabulary ceiling

This is **not** free-form voice control. Google only knows the device names you
commissioned plus on/off + a 0–100% number. So the vocabulary is exactly:
`turn on/off <name>` and `set <name> to N%`. Each named device = one fixed
intent (+ an optional numeric argument via brightness). To add a new command,
add a new device to `devices.json` and restart (Google may need a moment to
sync the new sub-device). There's no way to speak arbitrary prompts — the
expressive range is "which preset device" × "a number 0–100".

## Test

```bash
# Round-trip WITHOUT Matter/Google — inject directly, then check the session:
node src/inject.mjs Claude on 102   # 102/254 ≈ 40% → preset B

# Confirm the device advertises on the LAN (alongside existing Matter nodes):
timeout 5 dns-sd -B _matter._tcp
```

## Files

- `src/server.mjs` — the Matter bridge server (devices, commissioning lifecycle,
  $Changed handlers, debounce).
- `src/inject.mjs` — the agent-bridge injection path (+ a CLI test mode).
- `devices.json` — the editable trigger config.
- `launchd/` — LaunchAgent plist template + `install.sh`.
