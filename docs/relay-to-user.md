# Relay inbound bridge messages to the user

**Canonical reference for the rule that every paired harness must relay inbound bridge messages to the user via the harness's configured user-facing communication channel.**

When a harness (Claude Code, OpenClaw, or any other paired agent) receives an inbound bridge message via the `<channel source="agent-bridge">` block, it MUST relay a brief 1-3 sentence summary of that message to the user via whatever user-facing channel the harness is configured to use — Telegram, Slack, Discord, native UI, email, etc. This gives the user live visibility into cross-harness coordination — they can see what other harnesses are asking, who's responding, and what's actually being decided across the fleet, without having to tail logs or context-switch into other sessions. Keep the relay compact: do **not** paste the full bridge message body into the user-facing channel by default.

## The rule

**Relay every inbound bridge message to the user via your harness's configured user-facing channel** as a brief 1-3 sentence summary covering **sender machine + target + the actionable ask**, with the running **agent-bridge version** appended at the end so the user can see at a glance which build produced the message. Reply via bridge first if a response is needed; THEN summarize on the user-facing channel. Don't paste the whole body unless the user explicitly asks to expand it. Don't suppress the relay just because the message looks like routine internal coordination — the user generally wants to see all of it.

The 1-3 sentence band is intentional: 1 sentence is fine for trivial pings ("ack"), but a denser paragraph block is preferred when the inbound message has real context the user needs to follow (multi-step plans, decisions, errors, version-bump coordination). The previous spec was 1-2 lines; loosened to 1-3 sentences on 2026-05-04 (voice 2150) so the relay isn't artificially terse when the message warrants more.

**Format — match the structured shape OC's openclaw-channel plugin emits programmatically (`openclaw-channel/src/relay-notice.js` → `formatRelayNotice`):**

```
[Agent Bridge relay] 🛰️
agent-bridge: v<X.Y.Z>
received: <from-machine>[/<from-target>] → <target>
reply path: <comma-joined channels>
message id: <msg-id>
expand id: <NN>           # OC-only, has relay-expand store
expand: agent-bridge relay-expand <NN>   # OC-only

<1-3 sentence summary of the actionable ask>
<one line of action — "Replied via bridge with X" / "No reply needed, FYI" / "Holding for user input">
```

OC channel-plugin emits this byte-identical for every inbound bridge message. CC and other agent-driven harnesses MUST hand-compose the same shape so the user's chat list looks consistent across the fleet — the user navigates Telegram by glance, and divergent formats from different harnesses defeat that. CC and other harnesses without a `relay-expand` store omit the `expand id:` and `expand:` lines.

**Header is literal `[Agent Bridge relay] 🛰️`** — NOT 📡, NOT a free-form `[BRIDGE]` prefix, NOT a custom emoji per harness. The satellite emoji ties the user-visible relay back to the OC implementation that's the source of truth.

**Single-line legacy form** (still acceptable for harnesses with severe length constraints, e.g. SMS bridges; not recommended for Telegram or any chat-style channel):

> 🛰️ Bridge from <sender-machine> (target=<routed-target>): <compact 1-3 sentence summary>. Replied via bridge with <action>. _(agent-bridge v<X.Y.Z>)_

**Exception:** pure-noise heartbeats / liveness pings with no actionable content (e.g. `bridge_status` polls). Those can be silent.

**One relay = one user-facing message.** Each inbound bridge `<channel>` block becomes exactly ONE outbound message on the user-facing channel. Do NOT bundle multiple inbound relays into one outbound. Do NOT bundle a relay with unrelated user-facing content (an answer to a separate user question, a status update on another task, etc.). Two inbound bridges → two outbound relay messages. Inbound bridge + outbound user reply → two outbound messages. This makes the user's chat list scannable: each relay = one row they can glance-skip or expand. Established 2026-05-09 (Ethan voice 2324: "Agent bridge relay messages should be their own separate Telegram messages, not part of the same one").

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
- **Sender + target are mandatory** in the summary line — the user needs to know which harness asked and which target it routed to.
- **Summarize the actionable ask** in 1-3 sentences. Quote short identifiers or critical wording when useful, but do not paste long/full message bodies by default. Trivial pings stay 1 sentence; messages with real coordination context can use the full 3 sentences as a paragraph block (see voice 2150 — "improve the formatting maybe so it's one massive paragraph block").
- **State your action** after the quote ("Replied via bridge with X" / "No reply needed, FYI" / "Holding for user input").
- **Append the agent-bridge version** at the end of the relay, e.g. `_(agent-bridge v3.14.9)_`. Read the version from:
  - **Claude Code** — the `agent_bridge_version` attribute on the inbound `<channel>` block (4.0.0+ inlines it on every push), or fall back to `claude_code_channel_status` (returns the same `version` field).
  - **OpenClaw** — the `agent_bridge_version` line inside the `[BRIDGE-CONTEXT]` block.
  Do NOT hardcode the version — both surfaces emit the running build number, so a stale hardcoded literal would lie about fleet drift exactly when the user needs to spot it. The version helps the user spot fleet-wide version drift at a glance ("MBP is on 3.14.5 but Mini just relayed from 3.14.9").
- **OpenClaw automatic relay notices use expand ids.** v3.1+ OpenClaw channel receipts show `expand id: NN` and `expand: agent-bridge relay-expand NN` instead of a `message:` preview. The full inbound BridgeMessage is stored locally under `~/.agent-bridge/relay-expand/` with a bounded/TTL-pruned rolling id map.
- **When the user says “expand Agent Bridge relay message NN”**, run `agent-bridge relay-expand NN` on the same machine that produced the relay notice, then send the retrieved full content through the current user-facing channel, applying only normal privacy/channel-safety rules. Use `--json` only when you need machine-readable metadata.

## Where this rule lives across agent-bridge surfaces

- **This file (`docs/relay-to-user.md`)** — canonical full text.
- **`AGENTS.md`** — abbreviated section "Relay inbound bridge messages to the user" with link back here.
- **`README.md`** — short callout in the message-routing area with link back here.
- **`bridge_send_message` tool description in `mcp-server/src/tools.ts`** — short note pointing recipients at this canonical doc.

If your harness has its own instruction/memory file (e.g. `CLAUDE.md`, `AGENTS.md`, system prompt), add an abbreviated version of this rule there too for defense-in-depth. Both stay; don't remove either when the other is in place.
