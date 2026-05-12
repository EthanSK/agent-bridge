# Relay inbound bridge messages to the user

**Canonical reference for the rule that every paired harness must relay inbound bridge messages to the user via the harness's configured user-facing communication channel.**

When a harness (Claude Code, OpenClaw, or any other paired agent) receives an inbound bridge message via the `<channel source="agent-bridge">` block, it MUST relay a brief 1-3 sentence summary of that message to the user via whatever user-facing channel the harness is configured to use — Telegram, Slack, Discord, native UI, email, etc. This gives the user live visibility into cross-harness coordination — they can see what other harnesses are asking, who's responding, and what's actually being decided across the fleet, without having to tail logs or context-switch into other sessions. Keep the relay compact: do **not** paste the full bridge message body into the user-facing channel by default.

## The rule

**Relay every inbound bridge message to the user via your harness's configured user-facing channel** as a brief 1-3 sentence summary covering **sender machine + source target + destination machine + destination target + the actionable ask**, with **both source-side and destination-side agent-bridge versions** shown when available so the user can spot fleet-wide drift at a glance. Reply via bridge first if a response is needed; THEN summarize on the user-facing channel. Don't paste the whole body unless the user explicitly asks to expand it. Don't suppress the relay just because the message looks like routine internal coordination — the user generally wants to see all of it.

The 1-3 sentence band is intentional: 1 sentence is fine for trivial pings ("ack"), but a denser paragraph block is preferred when the inbound message has real context the user needs to follow (multi-step plans, decisions, errors, version-bump coordination). The previous spec was 1-2 lines; loosened to 1-3 sentences on 2026-05-04 (voice 2150) so the relay isn't artificially terse when the message warrants more.

**Format — structural fields emitted programmatically by harness channel plugins via the shared formatter at `lib/relay-notice.js` (`formatRelayNotice` / `formatRelayScaffold`).** OC's `openclaw-channel/src/relay-notice.js` and CC's `mcp-server/src/relay-notice.ts` are thin re-export shims around that single source of truth (agent-bridge 4.2.0 / openclaw-channel 3.2.0 onward). As of agent-bridge 4.5.2, senders can attach `relaySummary` / `relay_summary` to the BridgeMessage; OpenClaw uses that source-authored summary to post the visible relay receipt from code before the destination agent turn runs. If no source summary is present, the scaffold fallback still carries `{{SUMMARY_PLACEHOLDER}}` for the destination agent to fill. The structural fields below are produced for you:

```
[Agent Bridge relay] 🛰️
source: <from-machine>[/<from-target>] (agent-bridge v<X.Y.Z>|unknown)
destination: <to-machine>/<target> (agent-bridge v<A.B.C>|unknown)
received: <from-machine>[/<from-target>] → <to-machine>/<target>
reply path: <comma-joined channels>
message id: <msg-id>
expand id: <NN>           # populated by every harness with a relay-expand store (OC + CC since 4.7.1)
expand: agent-bridge relay-expand <NN>

<1-3 sentence summary of the actionable ask>
<one line of action — "Replied via bridge with X" / "No reply needed, FYI" / "Holding for user input">
```

Both OC and CC channel plugins emit this byte-identical structural shape via the shared `lib/relay-notice.js` formatter. CC delivers a `[RELAY-SCAFFOLD-START] ... [RELAY-SCAFFOLD-END]` fenced block prepended to the inbound `<channel source="agent-bridge">` content (also exposed as `meta.relay_scaffold`). If the source supplied `relaySummary`, that scaffold already contains the completed Summary blockquote; otherwise it contains `{{SUMMARY_PLACEHOLDER}}` for the agent to replace before sending via the harness's user-facing reply tool. OC (4.5.2+) posts the same completed relay notice directly through the configured user-facing channel when `relaySummary` is present, then dispatches the destination agent turn without a duplicate scaffold. If code-posting is unavailable or the source omitted `relaySummary`, OC falls back to prepending the fenced scaffold to the destination agent body. Third-party agent-driven harnesses without a channel plugin can hand-compose the same shape, but the canonical path is to import the shared formatter. Harnesses without a `relay-expand` store omit the `expand id:` and `expand:` lines.

**Header is literal `[Agent Bridge relay] 🛰️`** — NOT 📡, NOT a free-form `[BRIDGE]` prefix, NOT a custom emoji per harness. The satellite emoji is hard-coded in the shared `formatRelayNotice` helper at `lib/relay-notice.js`, so every harness that imports it gets exactly the same header.

**Where the structural scaffold comes from on each harness:**
- **OpenClaw (4.5.2+)** — `openclaw-channel/src/index.js` stores the relay-expand record, reads source/destination version metadata, then code-posts a completed `[Agent Bridge relay] 🛰️` notice to the primary user-facing channel when the BridgeMessage carries `relaySummary`. The Summary is source-authored, not destination-synthesized. If the source omitted `relaySummary` or the code-post fails, OC falls back to `formatRelayScaffold(msg, opts)` inside `formatInboundBody` so the destination agent can fill the placeholder and send naturally.
- **Claude Code** — `mcp-server/src/index.ts` calls `formatRelayScaffold(msg, opts)` at inbound-channel-push time and prepends the fenced scaffold to `message.content`. If the source included `relaySummary`, the scaffold is already complete; otherwise the agent reads it inside the `<channel source="agent-bridge">` block, fills in `{{SUMMARY_PLACEHOLDER}}`, and sends via the Telegram plugin's `reply` tool.
- **Other harnesses** — fall back to hand-composing the same shape (or, ideally, import the shared formatter directly).

**Fallback if the scaffold isn't delivered.** If for some reason the structural scaffold is absent (older agent-bridge / openclaw-channel version, custom harness, channel-content stripped by some intermediate layer), the agent must hand-compose the same format from the inbound channel meta — the literal example block above remains the contract.

**Single-line legacy form** (still acceptable for harnesses with severe length constraints, e.g. SMS bridges; not recommended for Telegram or any chat-style channel):

> 🛰️ Bridge from <sender-machine>/<source-target> (source v<X.Y.Z|unknown>) to <destination-machine>/<destination-target> (destination v<A.B.C|unknown>): <compact 1-3 sentence summary>. Replied via bridge with <action>.

**Exception:** pure-noise heartbeats / liveness pings with no actionable content (e.g. `bridge_status` polls). Those can be silent.

**One relay = one user-facing message.** Each inbound bridge `<channel>` block becomes exactly ONE outbound message on the user-facing channel. Do NOT bundle multiple inbound relays into one outbound. Do NOT bundle a relay with unrelated user-facing content (an answer to a separate user question, a status update on another task, etc.). Two inbound bridges → two outbound relay messages. Inbound bridge + outbound user reply → two outbound messages. This makes the user's chat list scannable: each relay = one row they can glance-skip or expand. Established 2026-05-09 (Ethan voice 2324: "Agent bridge relay messages should be their own separate Telegram messages, not part of the same one").

**Summary blockquote on relays.** Every bridge-relay user-facing message ends with a `<blockquote><b>Summary:</b> 1-3 sentence summary</blockquote>` block — distilling the actionable ask + the action you took. Goes AFTER the structured `[Agent Bridge relay] 🛰️` field block (not inside it). The body's natural summary line + action line do NOT replace this — the Summary blockquote is its own colored block on Telegram, visually distinct from the body. Same shape as the regular per-message Summary rule the user follows for non-relay replies. Established 2026-05-09 (Ethan voice 2335: "The summary for Agent Bridge should be 1 to 3 sentences max, and in a Telegram block quote, similar to the summary for normal messages").

**MANDATORY: send the completed scaffold via the harness's user-facing reply tool — do NOT just leave it in the conversation.** When the routing layer emits a structured scaffold into the inbound `<channel>` block (or you compose one yourself), your job is to **relay it to the user**. After filling in the Summary blockquote placeholder (and any other empty fields), you MUST send the completed scaffold as a fresh user-facing message via the harness's configured user-facing channel reply tool:
- **Claude Code (Telegram channel)** — call the Telegram plugin's `reply` tool (`mcp__plugin_telegram_telegram__reply`) with the completed scaffold as the `text` argument and the active `chat_id`.
- **OpenClaw** — call the equivalent user-facing channel reply tool (e.g. the OC Telegram channel reply tool, or whatever user-facing channel is bound to the running OC session).
- **Any other harness** — call its user-facing reply tool (Slack post, Discord send, native UI emit, email send, etc.).

The agent's role is to RELAY the scaffold to the user, not to acknowledge it in-conversation and stop. Acknowledgement-without-send means the user sees nothing; the scaffold sat in the agent's transcript only. Sending via the reply tool is the entire point of the relay rule. Established 2026-05-09 (Ethan voice 2348: "This also needs to say to relay it to the Telegram so the agent can do that").

## Why this matters

Without this rule, cross-harness traffic is invisible to the user unless they open a session and read the channel block themselves. Bridge messages are an internal coordination layer; without an outward relay the user has no idea what their fleet is doing. The relay turns the bridge from a hidden side-channel into a glance-able activity feed.

Some harnesses already do this consistently; others were inconsistent — sometimes folding bridge traffic into broader status updates, sometimes going silent on purely-internal coordination chatter on the assumption that "internal" meant "uninteresting." That assumption is wrong. Relay all of it; the user can scan-skip what they don't care about.

## What counts as a relayable inbound message

- Any `<channel source="agent-bridge" ...>` block delivered into the running agent session
- From any paired machine, regardless of `from_target`
- Any `target` value (`claude-code`, `<harness>/<account>`, custom harness)
- Authenticated AND unauthenticated (relay both — if unauthenticated, mention that)

## What can be silent

- Pure liveness / heartbeat pings (`bridge_status` poll responses, ack-only no-content messages)
- Echo / ack of a previous message you yourself just sent (avoid feedback loops)
- Test pings during a deliberate fleet-test session, if the user has explicitly said "go quiet on the user-facing channel while I run this test"

When in doubt, relay. Over-relaying is fine; under-relaying defeats the rule.

## Order of operations

1. **Read the inbound message** carefully — same as you would if it had come over the user-facing channel directly.
2. **Reply via bridge** first if the message asks something that needs a bridge-side response. The reply should be the substantive answer, not "ack, will check user-side too."
3. **Summarize on the user-facing channel** as a separate message: any project/context tag your harness uses, 1-3 sentence compact summary, what you replied (or "no reply needed"). Use the format example above as a template.

If the message is purely informational and needs no bridge reply, skip step 2 and just relay (step 3).

## Format guidance

- **Lead with whatever tag/header convention your harness uses** for user-facing messages (project tag, status emoji, etc.).
- **Use the satellite emoji 🛰️** as the inline indicator for bridge-relay messages — that's what OC's `formatRelayNotice` emits programmatically, and the fleet should match. Earlier guidance suggested 📡 (radar) was acceptable; that's now considered legacy. New harnesses + agent-driven relays should standardize on 🛰️.
- **Sender/source target + destination machine/target are mandatory** in the summary line — the user needs to know which harness asked, which source persona/account it came from, and which destination persona/account received it.
- **Summarize the actionable ask** in 1-3 sentences. Quote short identifiers or critical wording when useful, but do not paste long/full message bodies by default. Trivial pings stay 1 sentence; messages with real coordination context can use the full 3 sentences as a paragraph block (see voice 2150 — "improve the formatting maybe so it's one massive paragraph block").
- **State your action** after the quote ("Replied via bridge with X" / "No reply needed, FYI" / "Holding for user input").
- **Show both source and destination agent-bridge versions** in the structural fields. The shared scaffold already renders this as `source: ... (agent-bridge vX)` and `destination: ... (agent-bridge vY)`. If the scaffold is missing and you must compose manually, read:
  - **Claude Code** — `source_agent_bridge_version` and `destination_agent_bridge_version` attributes on the inbound `<channel>` meta; fall back to legacy `agent_bridge_version` as the destination/local version or call `claude_code_channel_status`.
  - **OpenClaw** — `source_agent_bridge_version` and `destination_agent_bridge_version` lines inside `[BRIDGE-CONTEXT]`; legacy `agent_bridge_version` remains a destination/local alias.
  Older peers may not send a source version; write `agent-bridge unknown` for that side rather than guessing. Do NOT hardcode versions — stale literals would hide exactly the fleet drift the relay is meant to expose.
- **Relay notices use expand ids on every harness with a relay-expand store.** OpenClaw (v3.1+) and Claude Code (agent-bridge 4.7.1+) channel receipts show `expand id: NN` and `expand: agent-bridge relay-expand NN` instead of a `message:` preview. The full inbound BridgeMessage is stored locally under `~/.agent-bridge/relay-expand/` with a bounded/TTL-pruned rolling id map (shared formatter at `lib/relay-expand-store.js`).
- **When the user says “expand Agent Bridge relay message NN”**, run `agent-bridge relay-expand NN` on the same machine that produced the relay notice, then send the retrieved full content through the current user-facing channel, applying only normal privacy/channel-safety rules. Use `--json` only when you need machine-readable metadata.

## Where this rule lives across agent-bridge surfaces

- **This file (`docs/relay-to-user.md`)** — canonical full text.
- **`AGENTS.md`** — abbreviated section "Relay inbound bridge messages to the user" with link back here.
- **`README.md`** — short callout in the message-routing area with link back here.
- **`bridge_send_message` tool description in `mcp-server/src/tools.ts`** — short note pointing recipients at this canonical doc.

If your harness has its own instruction/memory file (e.g. `CLAUDE.md`, `AGENTS.md`, system prompt), add an abbreviated version of this rule there too for defense-in-depth. Both stay; don't remove either when the other is in place.
