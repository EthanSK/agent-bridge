# Agent Bridge Chime Design

This note records the design and implementation decisions for moving
`agent-completion-chime` into `agent-bridge` as a fleet-aware feature.

## Source Context

Verbatim voice transcript from Ethan, preserved exactly:

> "No, idiot, send me an example of a fucking page that you made that within a parent that has exactly what the end result would be so I can test it. Are you sure your thinking is max? Why are you so dumb? I didn't hear any sound. Can you make sure the volume on my Mac Mini is max? Also, what's the output device right now? Is it the system? Mac Mini? If not, change it to that and then play the sounds again. And for chime, have you looked up the right way of doing it for OpenClaw? Because obviously Clawed Code is different. Ask your local OpenAI to— just see, open local OpenClaw to make sure it's correct over AgentBridge. Also If you didn't clock already, this needs to be shared between the, the, the Clawed Code and OpenClaw somehow across all the machines. That this should work with Agent Bridge. Actually, this should be like an add-on for Agent Bridge. So it requires Agent Bridge running and set up, and then it uses Agent Bridge to figure out what other harnesses across what machines are actually connected. And we also need to modify Agent Bridge, I guess, to support this. But all the machines need to be able to— you know what, fuck it. Let you know what, this is so dependent on Agent Bridge. Let's just Do this in Agent Bridge, the project Agent Bridge. Okay. The repo. So, yeah, let's start over. Well, not really start over, but like, just do it in Agent Bridge, modify Agent Bridge to be configured with a Chime. The whole point of the global one is when all the harnesses across the machines all finish. So what they can do is they can send a ping over SSH, whatever, Tailscale. Over Tailscale. Alexa, stop. Sorry, I just talked to Alexa there. Yeah, it's like a counter increment decrement. What agents are currently running and then have an ex— or like maybe like keep tracking a file. Whatever the best architecture is for that, what do you think? Okay, this is a big project. So actually, I want you to forward all this new information and everything we've been working on for the Chime thing over to Claude Station Mini, OpenClaw, local OpenClaw over Agent Bridge. I want you to send it, everything I've said word for word and all what we've been working on and the instructions of putting it into Agent Bridge, uh, the new stuff, and just get it to message me on Telegram once it understands. Do this in a long-running sub-agent, make sure you get every single thing I said as well."

## Implemented Shape

- Chime now lives inside `agent-bridge` as an internal module under [`chime/`](../chime/).
- Lifecycle events are sent over the existing Agent Bridge file transport using a dedicated target: `agent-bridge/chime`.
- One leased local service owns playback and fleet-state reconciliation per machine, even if both Claude Code and OpenClaw are running there.
- OpenClaw uses the documented plugin hooks `subagent_spawning` and `subagent_ended`.
- Claude Code remains hook-driven because its lifecycle surface is external to the bridge plugin; the bridge CLI now exposes `agent-bridge chime start|end` helpers for that.

## Architecture Answers

1. Offline peers / stale entries

- State is authoritative per `machine + sourceId`, not one global counter.
- Each source publishes full snapshots, not raw increments, so reconnect replaces drift cleanly.
- A stale peer with `activeCount > 0` remains blocking only until the active-lock TTL expires.
- The TTL defaults to 30 minutes (`activeLockTtlSeconds: 1800`) so a crashed or disconnected harness cannot block Hero forever; operators can raise it toward an hour if needed.
- A stale peer with `activeCount == 0` is ignored for zero-transition decisions.

2. Zero-transition / debounce

- Hero fires once on a strict transition from `fleetActiveCount > 0` to `0`.
- Cooldown is configurable with `allCompleteCooldownSeconds` and defaults to 4 seconds.
- Re-observing zero without a prior non-zero state does not replay Hero.

3. Harness vs opaque ids

- Fleet state tracks both.
- `sourceId` is the durable authority key for a local emitter, while each active agent also keeps `harness`, `agentId`, and optional `label` for diagnostics.
- Local active agents are mirrored as JSON lock files in `~/.agent-bridge/chime/active/`; each lock contains machine/source/harness/agent metadata plus `startedAt`, `updatedAt`, and `expiresAt`.

4. OpenClaw lifecycle hook point

- The primary OpenClaw integration is the plugin hook API:
  - `api.on("subagent_spawning", ...)`
  - `api.on("subagent_ended", ...)`
- The old `~/.openclaw/subagents/runs.json` watcher remains useful as fallback evidence, but it is not the primary lifecycle integration anymore.

5. Distributed vs leader counter

- Implemented as distributed per-source snapshots.
- Each source is authoritative only for its own local active set.
- Peers merge snapshots independently; there is no elected leader or central counter.

6. Sound playback locality

- Playback is local.
- Every machine computes the same fleet transition from replicated state and may play its own sound locally.
- We do not fan out explicit "play now" commands.

## Config

The chime feature uses `~/.agent-bridge/chime/config.json` instead of extending
`~/.agent-bridge/config` directly.

Reason:

- `~/.agent-bridge/config` is currently an INI-style peer registry used by the bash CLI and MCP/OpenClaw runtime code.
- Adding a nested JSON-style `chime: { ... }` block there would have required a larger config-format migration than the chime feature itself.

Current keys:

```json
{
  "enabled": true,
  "scope": "fleet",
  "playback": "local",
  "perAgentSound": "Glass",
  "allCompleteSound": "Hero",
  "volume": 1.0,
  "stalePeerSeconds": 90,
  "activeLockTtlSeconds": 1800,
  "heartbeatSeconds": 30,
  "allCompleteCooldownSeconds": 4,
  "historyLimit": 200
}
```

## Operational Notes

- The local service inbox is `~/.agent-bridge/inbox/agent-bridge/chime/`.
- Active local agent lock files live under `~/.agent-bridge/chime/active/`.
- Archived chime control messages land under `~/.agent-bridge/archive/agent-bridge/chime/`.
- Durable state lives in `~/.agent-bridge/chime/state.json`.
- Manual recovery is `agent-bridge chime reset`.
