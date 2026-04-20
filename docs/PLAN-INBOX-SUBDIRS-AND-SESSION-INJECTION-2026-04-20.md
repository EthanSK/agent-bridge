# Plan — Inbox subdir redesign + OpenClaw session injection

Date: 2026-04-20
Owners: Claude (MBP) + Mini-Claude (Mac Mini) for install/test
Status: drafted — implementation in progress

## Requirements (restated in my own words to prove understanding)

### A. Inbox subdir redesign

Today `~/.agent-bridge/inbox/` is a single global directory watched by both
harnesses (Claude Code's built-in agent-bridge channel plugin AND OpenClaw's
openclaw-channel plugin). That means every inbound message is seen by both,
with each harness racing to claim it. It's ambiguous and breaks fan-out.

New layout, per-harness-per-target:

```
~/.agent-bridge/inbox/
├── claude-code/              # Claude Code's channel plugin watches ONLY this
├── openclaw/
│   ├── default/              # OpenClaw @ClawdStationMiniBot session
│   ├── clawdiboi2/           # OpenClaw @Clawdiboi2bot session
│   └── clordlethird/         # OpenClaw @ClordLeThirdBot session
├── .archive/<target>/        # delivered msgs, per target (debug tail)
├── .failed/<target>/         # malformed / unrouted msgs
├── .processed                # (existing) dedup ledger — flat
└── .delivered                # (existing) channel-notify dedup — flat
```

- BridgeMessage JSON gains a new `target` field: a slash-delimited path like
  `"claude-code"` or `"openclaw/clawdiboi2"`.
- `bridge_send_message` MCP tool gets an optional `target` parameter. SCP
  destination becomes `~/.agent-bridge/inbox/<target>/<id>.json`.
- **No default routing.** Missing `target` → drop into
  `.failed/_unrouted/<id>.json` with a deprecation note; do NOT dispatch.
- **Backward-compat grace window.** Legacy flat files at the top level of
  `inbox/` get moved into `.failed/_unrouted/` on first sight with a warn log
  so the old bridge/openclaw-channel versions don't silently break pipelines
  for a week while people upgrade.

### B. Listeners scoped per target

- Claude Code's upstream channel plugin (anthropics/claude-plugins-official)
  watches `inbox/claude-code/` only. We don't own that plugin so we'd need a
  config flag or wrapper; see Phase D.
- openclaw-channel watches `inbox/openclaw/` recursively and routes on the
  subdir name (`default` / `clawdiboi2` / `clordlethird`) to pick which
  Telegram account-session to inject into.
- Listeners are independent processes — one crash doesn't cross-infect.
  Reinforce this in docs.

### C. OpenClaw session injection

Inject the message into an already-running Telegram-bound agent session so
the reply lands back in the SAME Telegram chat the user was talking in,
instead of spawning a new "agent-bridge" channel.

- Call `enqueueSystemEvent(text, { sessionKey, trusted: false })` from the
  plugin SDK.
- `sessionKey` format:
  `agent:main:telegram:<account>:direct:<peerId>`
  where `peerId = "6164541473"` (Ethan's Telegram user ID).
- **Omit `deliveryContext`** — the target session's own `lastChannel` drives
  reply routing (per Mini-Claude's session-injection research).
- Call `requestHeartbeatNow({ sessionKey, reason: "agent-bridge:inbound" })`
  after injection to wake an idle session.
- `trusted: false`. SSH pairing could in principle be compromised; treat the
  injected event as third-party input, not first-party system.
- Target mapping lives in `openclaw.json`:

```json
"channels": {
  "agent-bridge": {
    "enabled": true,
    "config": {
      "targets": {
        "default":      { "openclaw_channel": "telegram", "account": "default",      "peer_id": "6164541473" },
        "clawdiboi2":   { "openclaw_channel": "telegram", "account": "clawdiboi2",   "peer_id": "6164541473" },
        "clordlethird": { "openclaw_channel": "telegram", "account": "clordlethird", "peer_id": "6164541473" }
      }
    }
  }
}
```

Plugin flow:

1. Watcher sees `inbox/openclaw/clawdiboi2/msg-xxx.json`.
2. Plugin strips the `openclaw/` prefix (`clawdiboi2`), looks up
   `targets.clawdiboi2`, builds sessionKey
   `agent:main:telegram:clawdiboi2:direct:6164541473`.
3. Injects `<channel source="agent-bridge" from="..." ...>content</channel>`
   via `enqueueSystemEvent`.
4. `requestHeartbeatNow` to wake the session if idle.
5. Session's `lastChannel` is `telegram:clawdiboi2` → any reply lands in
   @Clawdiboi2bot Telegram chat, not back over the bridge.

If a target lookup fails (unknown subdir, missing config), move the message
to `.failed/<target>/` and log.

### D. Claude Code side

Ideally the Claude Code harness identifies itself with an
`--agent-bridge-target` flag so its built-in plugin watches only
`inbox/claude-code/` (or a tighter subdir like
`inbox/claude-code/laptop-main/`). But that plugin is upstream — we can't
modify `anthropics/claude-plugins-official/telegram`.

Approach: **document the pattern** in README / INSTRUCTIONS and leave the
per-session subdir split as future work. For the short term, the parent
Claude Code channel plugin can keep watching `inbox/claude-code/` wholesale
— there's usually only one Claude Code session on each physical machine at a
time so the routing collision isn't real.

### E. Docs

After code:

- `README.md` top level
- `INSTRUCTIONS.md`
- `AGENTS.md`
- `PLUGIN_DESIGN.md` (if present)
- `CHANGELOG.md` — entry for mcp-server 3.4.0 + openclaw-channel 2.1.0
- `openclaw-channel/README.md` + `ARCHITECTURE.md`
- `site/` — whatever mirrors the above (check later)

Version bumps:

- `mcp-server` → `3.4.0` (was 3.3.0)
- `openclaw-channel` → `2.1.0` (was 2.0.0)

## Implementation checklist

### Phase A — Inbox subdir redesign (mcp-server)

- [x] Add `target` field to `BridgeMessage` interface in `mcp-server/src/inbox.ts`.
- [x] Add `createMessage({ target })` plumbing.
- [x] `sendMessage` uses `<target>/<id>.json` as the remote SCP path instead of `<id>.json` at root, and `mkdir -p` the target subdir on the remote before writing.
- [x] Per-target `archive/` and `failed/` subdir helpers in `config.ts`.
- [x] `bridge_send_message` tool gains optional `target` param (string). Default: undefined → the tool rejects with an explicit error telling the caller "target is required".
- [x] Update tool description + examples.

### Phase A (cont.) — Inbox watcher changes (mcp-server watcher.ts)

- [x] `startWatcher` — watch each configured subdir (the watcher gets a list of subdirs to monitor + a router fn that knows which subdir means which downstream callback).
- [x] For this repo's half (Claude Code channel plugin), watch `inbox/claude-code/` only; legacy flat files in `inbox/` get scanned once on startup and moved to `.failed/_unrouted/`.
- [x] `replayUndeliveredMessages` scans only `inbox/claude-code/` (for the MCP-server half that feeds Claude Code's channel).

### Phase C — openclaw-channel session injection

- [x] Add `targets` support in `openclaw.plugin.json` configSchema.
- [x] `inbox-watcher.js` — watch `inbox/openclaw/<subdir>/` for each configured target.
- [x] `index.js` — on inbound, strip `openclaw/` prefix from message's target field (or derive from subdir), look up target config, build sessionKey `agent:main:telegram:<account>:direct:<peer_id>`, call `enqueueSystemEvent(body, { sessionKey, trusted: false })`, call `requestHeartbeatNow({ sessionKey, reason: "agent-bridge:inbound" })`.
- [x] `trusted: false` (was `trusted: true`).
- [x] Outbound adapter: when agent replies, we NO LONGER send back over agent-bridge by default — the session's `lastChannel` is Telegram, so the reply goes there. The current outbound `sendText` stays for reply-flows where the peer is on the bridge itself (cross-harness agent-to-agent, not the Telegram injection flow).

### Phase C (cont.) — graceful fallback

- [x] If `requestHeartbeatNow` isn't exported on the installed plugin-sdk, log and skip (don't fatal).
- [x] If `targets` missing from config, log a startup warning and fall back to the legacy single-default behaviour so existing installs don't hard-break. (DECISION LOG below: we ALSO support this mode because Ethan said "no default routing" but that only applies to incoming messages without a `target` field — legacy installs with no target-map config still need to keep working.)

### Phase D — Claude Code side (document-only)

- [x] Document the `inbox/claude-code/` subdir convention in INSTRUCTIONS.md and note the per-session split is upstream future-work.

### Phase E — Docs + versions

- [x] Bump `mcp-server/package.json` to 3.4.0.
- [x] Bump `openclaw-channel/package.json` to 2.1.0.
- [x] `CHANGELOG.md` entry.
- [x] `README.md` refresh.
- [x] `INSTRUCTIONS.md` refresh.
- [x] `AGENTS.md` refresh.
- [x] `PLUGIN_DESIGN.md` check.
- [x] `openclaw-channel/README.md` refresh.
- [x] `openclaw-channel/ARCHITECTURE.md` refresh.

### Phase F — Test plan (handed off to parent agent)

- [ ] `npm run build` clean on mcp-server.
- [ ] `node --check` clean on openclaw-channel src files.
- [ ] Mini-side: pull the repo, reinstall the OpenClaw plugin, `openclaw gateway` starts clean and logs `registered native channel id="agent-bridge"` + `watching inbox/openclaw targets: default,clawdiboi2,clordlethird`.
- [ ] `bridge_send_message({ machine: "Mac-Mini", message: "hello cross-machine", target: "openclaw/clawdiboi2" })` → message lands in @Clawdiboi2bot chat on Ethan's Telegram.
- [ ] Same for `clordlethird` and `default`.
- [ ] `bridge_send_message({ machine: "Mac-Mini", message: "hi", target: "claude-code" })` → Mac-Mini Claude Code receives it.
- [ ] `bridge_send_message({ machine: "Mac-Mini", message: "oops" })` (no target) → rejected at sender with an explicit error.
- [ ] Legacy flat file dropped directly into `inbox/` (bypass mcp-server) → logged + moved to `.failed/_unrouted/`.

### Phase G — Codex review (handed off to parent agent)

- [ ] Invoke `pre-commit-codex-review` skill in cost-save mode (Codex applies fixes).
- [ ] Loop until LGTM.
- [ ] Final sanity check.

### Phase H — Commit + sync (handed off to parent agent)

- [ ] Commit on MBP.
- [ ] Push to `origin/main`.
- [ ] `bridge_run_command Mac-Mini 'cd ~/Projects/agent-bridge && git pull'` to sync.
- [ ] Telegram Ethan.

## Decision log

- **2026-04-20 — no default routing, rejection-loud:** if a message arrives without `target`, the MCP server will REFUSE to send (error back to caller), not silently fallback to `claude-code`. Ethan's intent is "explicit only". Legacy messages that arrive via direct SCP without `target` get moved to `.failed/_unrouted/` (can't reject at send time because we didn't send them).
- **2026-04-20 — target mapping in openclaw.json, not a second config file:** Ethan's snippet lives in `channels["agent-bridge"].config.targets`. Matches existing plugin-cfg conventions, no new file surfaces.
- **2026-04-20 — `trusted: false` on injected events:** aligns with security principle that SSH pairing is not a system-level trust boundary. Injected content is third-party input.
- **2026-04-20 — `deliveryContext` omitted:** trust the session's `lastChannel` for reply routing (per Mini-Claude's research). Simpler, fewer moving parts.
- **2026-04-20 — openclaw-channel keeps outbound `sendText`:** cross-harness agent-to-agent messaging (MBP Claude Code → Mac Mini Claude Code) still needs a way to reply over the bridge when the peer ISN'T a Telegram session. So the outbound SCP path stays available; it just isn't what happens in the Telegram-injection flow. The session's `lastChannel` already handles that case.
- **2026-04-20 — legacy single-account fallback in openclaw-channel:** if `config.targets` is missing, plugin falls back to watching `inbox/openclaw/default/` with injection routed to `targets.default` or, if that's also missing, to the original `agent-bridge:<machine>` sessionKey (v2.0 behaviour). This prevents upgrade-cliff on existing installs.

### Refinements (2026-04-20, post-draft)

- **Refinement 1 — Unicode-aware `isValidTarget`:** `mcp-server/src/config.ts :: isValidTarget` (and the JS mirror in `openclaw-channel/src/outbound.js`) is loosened from ASCII-only `[A-Za-z0-9_./-]` to a Unicode-aware `[\p{L}\p{N}_./-]` regex. Same safety rules retained (no `..`, no leading/trailing `/`, no `//`, ≤256 chars, no control chars/spaces). Segment-based validation so each path component still looks sane.
- **Refinement 2 — Auto-discover openclaw-channel targets:** when `channels["agent-bridge"].config.targets` is absent or empty, the plugin now auto-discovers one target per entry in the OpenClaw global config's `channels.telegram.accounts` map. Explicit `targets` remains available as an advanced override. Peer ID resolution order: `targets.<name>.peer_id` → plugin-level `config.peer_id` → `meta.user_id` → first numeric `chat_id` in `channels.telegram.accounts[<name>].allowFrom`. Fails loudly (skips target + warn log) when no peer can be resolved. `openclaw.plugin.json` configSchema updated: `targets` now optional, new optional `peer_id` string. No Mini-side openclaw.json edit required for the happy path.
- **2026-04-20 ~11:58 BST — Dropped `requestHeartbeatNow`:** after verifying via direct SDK read that the built-in telegram channel source uses `enqueueSystemEvent(text, { sessionKey, contextKey })` alone and does NOT call `requestHeartbeatNow`, we removed the heartbeat call (and its optional import) from `openclaw-channel/src/index.js`. enqueueSystemEvent alone is sufficient — the event loop picks up queued events automatically. Earlier research that said "heartbeat required to wake idle sessions" was wrong (over-extrapolated from exec/notification channels). ARCHITECTURE.md updated to match. Supersedes the `requestHeartbeatNow` availability risk noted in "Known risks" below.
- **Refinement 3 — Round-trip bridge replies via `fromTarget`:** `BridgeMessage` gains an optional `fromTarget` field — the sender's OWN target-ID, so the receiver knows where to route a reply. `openclaw-channel/src/envelope.js :: buildReply(...)` resolves the outgoing `target` in this order: explicit arg → `incoming.fromTarget` → `"claude-code"` fallback. The in-memory `replyTargets` map in `index.js` now caches the whole incoming `BridgeMessage` and the target's own `ownTarget = "openclaw/<name>"` so `channel-plugin.js :: sendText` can populate `reply.target` + `reply.fromTarget` accurately. This enables OpenClaw ↔ Claude Code round-trip conversations, not just one-way injection.

## Known risks

- **Upstream Claude Code plugin.** If it doesn't handle the subdir path, legacy flat-file messages might still be the only way to reach it. Mitigation: keep the `.failed/_unrouted/` archival path and document a migration window.
- **`requestHeartbeatNow` availability.** Not every plugin-sdk ships it. Treat as optional; plugin logs and continues if absent.
- **sessionKey format drift.** `agent:main:telegram:<account>:direct:<peerId>` is based on Mini-Claude's observation of current OpenClaw builds. If OpenClaw upstream changes the key shape we have to track it. Mitigation: sessionKey is built in a single helper in `index.js` so we can patch one spot.
- **Multiple OpenClaw sessions with the same account.** If Ethan ever has two concurrent OpenClaw sessions per Telegram account (different agents), the direct peer session injection will be ambiguous. Out of scope for today.
