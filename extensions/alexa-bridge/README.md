# alexa-bridge — control Claude Code from an Amazon Echo (fire-and-forget)

An **agent-bridge extension** that lets you **speak a freeform task to an Amazon
Echo** and have it injected into a machine's running **Claude Code** session.
The agent works for as long as it needs, then **speaks the result back to the
Echo** (with a Telegram fallback).

Unlike a normal Alexa skill — which must answer within ~8 seconds — this uses a
**fire-and-forget** design: Alexa acks instantly ("On it — I'll let you know
when it's done."), the agent does the slow work out-of-band, and the result is
announced later via Amazon's unofficial announcement API.

```
"Alexa, ask my agent to <freeform task>"
  → Echo
  → Alexa cloud (custom skill, AMAZON.SearchQuery slot captures the task)
  → POST https://<public-tunnel>/alexa   (the receiver, src/server.mjs)
  → FIRE-AND-FORGET inject() → agent-bridge sendLocalMessage()   (fast, <8s)
  → ~/.agent-bridge/inbox/claude-code/default/msg-*.json  (atomic write)
  → agent-bridge file watcher (~2s)
  → <channel source="agent-bridge"> block pushed into the running Claude Code session
  → Claude works as long as it needs…
  → …then runs:  speak.sh "<result>"
       → alexa_remote_control.sh -d "<Echo>" -e "speak:<result>"   (unofficial API, NO 8s limit)
       → if that fails (missing / not authed / Amazon changed the API):
            → Telegram fallback (result is never lost)
  → "On it — I'll let you know when it's done."  (the instant ack, spoken first)
```

## Why fire-and-forget (the 8-second constraint)

Alexa custom skills MUST return an HTTP response within **~8 seconds** or the
user hears an error. Real agent work takes minutes. So the receiver **cannot do
the work inside the request** — it injects the task (a fast atomic file write)
and acks immediately. The long result comes back on a **separate leg**
(`speak.sh`), which talks to Amazon's announcement API directly and is **not**
bound by the 8s rule.

## How it plugs into agent-bridge

The injection reuses agent-bridge's **own built module** — it imports
`mcp-server/build/inbox.js` and calls `sendLocalMessage()`, the exact same
function `bridge_send_message` uses internally for the `machine:"local"` case.

That function builds a `msg-<uuid>` id, writes **atomically** (`.tmp` → rename)
into `inbox/<target>/<id>.json`, and stamps a **valid `target`** so the
agent-bridge watcher accepts it and pushes it into the running session as a
`<channel source="agent-bridge">` block.

> ⚠️ We never hand-write / move / SCP JSON into the inbox roots — that gets
> quarantined to `.failed/_unrouted/`. The only correct path is
> `sendLocalMessage()`, which `src/inject.mjs` uses.

The path to `build/inbox.js` is resolved robustly (env override
`AGENT_BRIDGE_INBOX_JS` → repo-relative → homedir → `/Users/ethansk` symlink).
**The core mcp-server must be built** (`cd mcp-server && npm install && npm run
build`) so `build/inbox.js` exists.

## Components

- `src/server.mjs` — the Alexa skill HTTP receiver (Node built-in `http`, zero
  deps). Routes `POST /alexa` (LaunchRequest / IntentRequest / SessionEnded) and
  `GET /health`.
- `src/inject.mjs` — the agent-bridge injection path (+ a CLI test mode).
- `speak.sh` — the speak-back leg: `alexa_remote_control.sh` with a Telegram
  fallback.
- `speak.config.example` — copy to `speak.config` (git-ignored) and set your
  Echo name.
- `skill.json` — ready-to-import Alexa interaction model.
- `launchd/` — LaunchAgent plist template + `install.sh`.

## Environment variables (receiver)

- `ALEXA_BRIDGE_PORT` — port the receiver binds (default `8787`).
- `ALEXA_BRIDGE_TARGET` — inbox the task lands in (default `claude-code/default`).
- `ALEXA_BRIDGE_TTL` — TTL stamped on each message (default `86400`).
- `ALEXA_BRIDGE_SECRET` — optional shared secret. If set, `POST /alexa` requires
  `?secret=<value>` (in the endpoint URL) or an `x-alexa-bridge-secret` header.
- `AGENT_BRIDGE_INBOX_JS` — force the path to agent-bridge's `build/inbox.js`.

## Run the receiver (on the machine where Claude Code is running)

```bash
cd ~/Projects/agent-bridge

# Ensure the core module the inject path imports is built:
( cd mcp-server && npm install && npm run build )

cd extensions/alexa-bridge
npm install            # zero/near-zero deps — uses Node stdlib

# Option A — foreground (prints logs, Ctrl-C to stop):
npm start

# Option B — always-on LaunchAgent (survives reboots):
./launchd/install.sh
tail -f ~/.agent-bridge/alexa-bridge/logs/alexa-bridge.out.log

# Verify it's listening:
curl -s http://localhost:8787/health
```

## Public HTTPS endpoint (Tailscale Funnel preferred)

Alexa needs a **public HTTPS** URL with a valid cert. Two options:

### Option A — Tailscale Funnel (preferred)

On the machine running the receiver:

```bash
tailscale funnel --help          # check current syntax for your version
tailscale funnel --bg 8787       # expose localhost:8787 publicly over HTTPS
tailscale funnel status          # shows the https://<host>.ts.net URL
```

The Alexa endpoint is then `https://<host>.ts.net/alexa`.

> Funnel is gated behind your Tailscale **admin console**: it needs the
> `funnel` node attribute (ACL `nodeAttrs`), **MagicDNS**, and **HTTPS
> certificates** enabled for the tailnet. If `tailscale funnel` errors with a
> permissions/attribute message, enable those in the admin console
> (https://login.tailscale.com/admin) → DNS (MagicDNS + HTTPS certs) and ACLs
> (`nodeAttrs` granting `funnel` to this node), then retry.
>
> **On Ethan's Mac Mini specifically:** `tailscaled` runs in
> userspace-networking mode with a NON-default socket, so the CLI needs an
> explicit `--socket` flag:
> `tailscale --socket=/Users/ethansk/.local/share/tailscale/tailscaled.sock funnel --bg 8787`.
> As of this deploy Funnel is **NOT yet enabled** on the tailnet — running it
> printed: *"Funnel is not enabled on your tailnet. To enable, visit:
> https://login.tailscale.com/f/funnel?node=nE3XVFaGcG11CNTRL"*. Ethan must open
> that URL (one click, signed in) to grant the node Funnel; then the Mini's
> stable endpoint becomes `https://mac-mini.tail52aa3c.ts.net/alexa`.

### Option B — cloudflared (fallback)

```bash
brew install cloudflared          # if not present
cloudflared tunnel --url http://localhost:8787
```

This prints a `https://<random>.trycloudflare.com` URL (ephemeral — changes each
run; for a stable URL set up a **named tunnel** with a Cloudflare account). The
Alexa endpoint is `https://<random>.trycloudflare.com/alexa`.

> ⚠️ **The quick tunnel is ephemeral and not supervised** — a `nohup
> cloudflared …` started from a shell dies when that shell tree tears down, and
> the URL changes on every restart (so you'd have to re-paste it into the Alexa
> console each time). For a durable setup either (a) enable Tailscale Funnel
> (preferred — stable URL, no extra service), or (b) create a cloudflared
> **named tunnel** and run it under its own LaunchAgent (`brew services start
> cloudflared` with a `~/.cloudflared/config.yml`). The quick tunnel is fine for
> testing only.

Confirm end-to-end: `curl -s https://<public-host>/health` should return the
health JSON.

## Import the Alexa skill (one-time, in the Alexa Developer Console)

1. Go to https://developer.amazon.com/alexa/console/ask → **Create Skill**.
2. Name it (e.g. "My Agent"), model **Custom**, host **Provision your own**.
3. **Build → Interaction Model → JSON Editor** → paste the contents of
   `skill.json` → **Save Model** → **Build Model**.
4. **Build → Endpoint** → choose **HTTPS**. Set the Default Region endpoint to
   your public URL **+ `/alexa`** (e.g. `https://<host>.ts.net/alexa` — append
   `?secret=<value>` if you set `ALEXA_BRIDGE_SECRET`). For the SSL certificate
   type choose **"My development endpoint is a sub-domain of a domain that has a
   wildcard certificate from a certificate authority"** (Funnel/Cloudflare URLs
   have valid CA certs, so the wildcard-subdomain option is correct — do NOT
   choose the self-signed option).
5. **Save Endpoints**, then **Build → Invocation** to confirm the invocation
   name is **"my agent"**.
6. **Test** tab → enable testing in **Development**. Now say (or type in the
   simulator): *"ask my agent to what time is it"*.

## One-time alexa_remote_control auth (ONLY Ethan can do this)

`speak.sh` wraps thorsten-gehrig's `alexa_remote_control.sh`, which needs a
logged-in Amazon **cookie**. Generating it requires **Ethan's Amazon login +
2FA (OTP)** — no agent can complete this.

The installer (deploy step) already downloaded the script to
`~/.config/alexa_remote_control/alexa_remote_control.sh` on the Mini (this is
**v0.23**, which uses Amazon's modern **refresh-token** auth, not the old
email/password cookie). To authenticate:

```bash
ARC=~/.config/alexa_remote_control/alexa_remote_control.sh

# 1) Set your Amazon region domains near the top of the script. For a UK account:
#       SET_AMAZON='amazon.co.uk'
#       SET_ALEXA='alexa.amazon.co.uk'
#    (defaults are the German .de domains — change them.)
$EDITOR "$ARC"

# 2) Generate the refresh token. v0.23 supports a guided login:
bash "$ARC" -login
#    Follow the prompts — this is where your Amazon EMAIL + PASSWORD + OTP/2FA
#    are entered (only YOU can complete the 2FA). It writes the refresh token /
#    cookie into ~/.alexa.* so subsequent runs are non-interactive.
#    (Alternative: paste a SET_REFRESH_TOKEN='...' value into the script if you
#    already have one from the alexa-cookie-cli / browser flow.)

# 3) Confirm it works + see your Echo's exact name:
bash "$ARC" -a            # list available devices

# 4) Put that name into speak.config:
cd ~/Projects/agent-bridge/extensions/alexa-bridge
cp speak.config.example speak.config
$EDITOR speak.config       # set ALEXA_DEVICE="<your Echo name from step 3>"
```

The token/cookie lives under `~/.alexa.*` and **re-auths periodically (~every
couple of weeks)** — when speak-back stops working, re-run step 2. Until then,
results fall back to **Telegram** automatically (so you never lose a result).

## Telegram fallback

If `alexa_remote_control.sh` is missing, errors, or its cookie has lapsed,
`speak.sh` posts the result to **Telegram** instead (so the result is never
lost). It reads the bot token from `~/.claude/channels/telegram/.env`
(`TELEGRAM_BOT_TOKEN=`) and the chat id from the first `allowFrom[]` entry in
`~/.claude/channels/telegram/access.json` — the same pattern the dot-claude
watchdogs use. The message is prefixed so you know the Echo speak-back didn't
fire.

## Test

```bash
# Inject a task DIRECTLY (no Alexa needed) — a <channel> block should surface in
# the running Claude Code session within ~2s:
node src/inject.mjs "what time is it"

# Mock an Alexa IntentRequest against the local receiver:
curl -s -X POST http://localhost:8787/alexa \
  -H 'content-type: application/json' \
  -d '{"version":"1.0","request":{"type":"IntentRequest","intent":{"name":"DelegateTaskIntent","slots":{"query":{"name":"query","value":"what time is it"}}}}}'
# Expect: {"version":"1.0","response":{"outputSpeech":{"type":"PlainText","text":"On it — I'll let you know when it's done."},"shouldEndSession":true}}

# Exercise the speak-back + Telegram fallback (no Amazon auth → falls back):
bash speak.sh "test result from alexa-bridge"
```

## ⚠️ Honest note: the speak-back leg is fragile

The **inject leg** (Alexa → agent) is robust — it's plain HTTP + agent-bridge's
own delivery path.

The **speak-back leg** (agent → Echo) relies on `alexa_remote_control.sh`, an
**unofficial** tool driving Amazon's **private** API with a login cookie. This
means:

- Amazon can change their API at any time and break the speak-back.
- The cookie **expires periodically** (~2 weeks) and needs a manual re-auth
  (Amazon login + OTP).

That's exactly why the **Telegram fallback exists** — it's the safety net so you
always get your result even when the Echo announcement can't fire. Treat Echo
speak-back as best-effort and Telegram as the guarantee.
