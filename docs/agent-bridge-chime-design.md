# Agent Bridge Chime Design

This is legacy design documentation for the optional Fleet Chime add-on. The module still lives in `agent-bridge` because it depends on the bridge transport, but it is disabled by default and should be treated as legacy / effectively abandoned rather than core Agent Bridge functionality.

## Implemented Shape

- Chime now lives inside `agent-bridge` as an optional internal module under [`chime/`](../chime/), and is disabled by default for new setups.
- Lifecycle events are sent over the existing Agent Bridge file transport using a dedicated target: `agent-bridge/chime`.
- One configured master machine plays sounds; peers forward lifecycle events to that master over the bridge. Standalone/local playback remains possible by config.
- Active locks are still TTL-bounded local JSON files, so a crashed harness cannot keep the all-complete state stuck forever.
- OpenClaw uses the documented plugin hooks `subagent_spawning` and `subagent_ended`.
- Claude Code remains hook-driven because its lifecycle surface is external to the bridge plugin; the bridge CLI exposes `agent-bridge chime start|end` helpers for that.

## Architecture Answers

1. Offline peers / stale entries

- State is keyed per `machine + sourceId`, not one global counter.
- Sources emit lifecycle events (`agent.start`, `agent.end`, `chime.register`, `chime.heartbeat`) and mirror active agents into TTL-bounded lock files.
- A stale peer with active locks remains blocking only until the active-lock TTL expires.
- The TTL defaults to 30 minutes (`activeLockTtlSeconds: 1800`) so a crashed or disconnected harness cannot block Hero forever; operators can raise it toward an hour if needed.
- A stale peer with no active locks is ignored for zero-transition decisions.

2. Zero-transition / debounce

- Hero fires once on a strict transition from `fleetActiveCount > 0` to `0`.
- Cooldown is configurable with `allCompleteCooldownSeconds` and defaults to 4 seconds.
- Re-observing zero without a prior non-zero state does not replay Hero.

3. Harness vs opaque ids

- Fleet state tracks both.
- `sourceId` is the durable authority key for a local emitter, while each active agent also keeps `harness`, `agentId`, and optional `label` for diagnostics.
- Local active agents are mirrored as JSON lock files in `~/.agent-bridge/chime/active/`; each lock contains machine/source/harness/agent metadata plus `playbackHost`, `startedAt`, `updatedAt`, and `expiresAt`.

4. OpenClaw lifecycle hook point

- The primary OpenClaw integration is the plugin hook API:
  - `api.on("subagent_spawning", ...)`
  - `api.on("subagent_ended", ...)`
- The old `~/.openclaw/subagents/runs.json` watcher remains useful as fallback evidence, but it is not the primary lifecycle integration anymore.

5. Distributed vs leader counter

- Implemented as distributed per-source lifecycle events and TTL-bounded locks, not a raw global increment/decrement counter.
- Each source is authoritative only for its own local active set.
- Playback has a configured master/peer policy. There is no elected leader or central cloud service; the master is just the sole audio output for the human at the desk.

6. Sound playback locality

- Playback is intentionally centralized when `masterMachine` is configured: the master plays for the fleet, and peers suppress local playback after forwarding events.
- Peer-originated events can use `remotePitchRate` so the master can audibly distinguish local vs remote completions.
- If the master is unreachable, peer emitters may mark a local fallback event so some sound still fires rather than silently dropping the completion cue.
- We do not fan out explicit "play now" commands to every host.

## Config

The chime feature uses `~/.agent-bridge/chime/config.json` instead of extending
`~/.agent-bridge/config` directly.

Reason:

- `~/.agent-bridge/config` is currently an INI-style peer registry used by the bash CLI and MCP/OpenClaw runtime code.
- Adding a nested JSON-style `chime: { ... }` block there would have required a larger config-format migration than the chime feature itself.

Current keys:

```json
{
  "enabled": false,
  "scope": "fleet",
  "playback": "local",
  "perAgentSound": "Glass",
  "allCompleteSound": "Hero",
  "volume": 1.0,
  "stalePeerSeconds": 90,
  "activeLockTtlSeconds": 1800,
  "heartbeatSeconds": 30,
  "allCompleteCooldownSeconds": 4,
  "historyLimit": 200,
  "masterMachine": "Ethans-Mac-mini",
  "remotePitchRate": 1.05,
  "sayBotName": true,
  "botNamesByMachine": {}
}
```

## Operational Notes

- The local service inbox is `~/.agent-bridge/inbox/agent-bridge/chime/`.
- Active local agent lock files live under `~/.agent-bridge/chime/active/`.
- Archived chime control messages land under `~/.agent-bridge/archive/agent-bridge/chime/`.
- Durable state lives in `~/.agent-bridge/chime/state.json`.
- Chime service transition logs append to `~/.agent-bridge/chime/chime.log`.
- Audible demo logs append to `~/.agent-bridge/chime/e2e-audible-demo.log`.
- Manual controls include `agent-bridge chime status`, `agent-bridge chime test per-agent`, `agent-bridge chime test all-complete`, and `agent-bridge chime reset`.
- The hard kill-switch is `~/.agent-bridge/chime/.kill-switch`; disabled config drains inbox files without playback.
