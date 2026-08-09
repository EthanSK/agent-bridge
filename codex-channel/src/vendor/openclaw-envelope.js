/**
 * BridgeMessage envelope helpers.
 *
 * A BridgeMessage JSON (written by the mcp-server or the CLI) looks like:
 * {
 *   id: "msg-<uuid>",
 *   from: "Ethans-MacBook-Pro",
 *   to: "Mac-Mini",
 *   type: "message" | "reply" | "command" | "response",
 *   content: string,
 *   timestamp: 1712345678901,
 *   replyTo?: "msg-<uuid>",
 *   ttl?: 86400,
 *   target?: "claude-code",              // where the RECEIVER should deliver this
 *   fromTarget?: "openclaw/clawdiboi2",  // where the SENDER wants replies routed
 *   sourceAgentBridgeVersion?: "4.5.0",  // sender-side Agent Bridge runtime
 *   relaySummary?: string,               // optional source-authored relay summary
 *   replyVia?: "telegram" | "agent-bridge" // per-message override for how the
 *                                          // openclaw target should route its
 *                                          // reply (v2.3.0+). Ignored by the
 *                                          // claude-code receiver.
 * }
 *
 * `fromTarget` enables bidirectional round-trips (e.g. OpenClaw ↔ Claude Code):
 * when OpenClaw's agent replies via `bridge_send_message`, the reply envelope's
 * `target` is populated from the ORIGINAL incoming message's `fromTarget`.
 * There is no implicit back-channel fallback target. If the original sender
 * did not state where replies should go, the reply envelope is emitted without
 * a bridge target and the outbound path will fail loudly instead of silently
 * routing to some shared default inbox.
 *
 * `replyVia` (v2.3.0+, openclaw-channel-specific) lets the sender force the
 * replyVia mode on a single incoming message — handy for quick back-channel
 * probes without reconfiguring the receiver's target. Valid values are
 * "telegram" (reply goes back through the Telegram chat — Ethan's phone
 * pings) and "agent-bridge" (reply is SFTP-delivered back as a BridgeMessage, no
 * Telegram traffic). Unrecognised values fall back to the target's configured
 * default.
 */

import { randomUUID } from "node:crypto";

const DEFAULT_TTL_SECONDS = 86400;

/** Generate a stable id compatible with the rest of agent-bridge. */
export function newMessageId() {
  return `msg-${randomUUID()}`;
}

/** Parse + shape-check a raw JSON string. Returns null if invalid. */
export function parseBridgeMessage(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const required = ["id", "from", "to"];
  for (const k of required) {
    if (typeof obj[k] !== "string" || !obj[k]) return null;
  }
  if (typeof obj.content !== "string") return null;
  // timestamp is permitted as a number (epoch ms) or an ISO-8601 string.
  if (
    obj.timestamp != null &&
    typeof obj.timestamp !== "number" &&
    typeof obj.timestamp !== "string"
  ) {
    return null;
  }
  return obj;
}

/**
 * Build a reply BridgeMessage envelope.
 *
 * Routing resolution order for `target`:
 *   1. Explicit `target` argument wins (advanced override).
 *   2. Else if `incoming` is supplied AND `incoming.fromTarget` is present,
 *      use that — this is the round-trip path. The original sender told us
 *      where to put replies; honour it.
 *   3. Else leave `target` unset. Agent-bridge reply delivery is explicit-only
 *      and must fail loudly when no return target was provided.
 *
 * `fromTarget` on the OUTGOING reply is also populated (optional) from the
 * `ownTarget` argument so the peer on the other end can reply back in turn.
 * `sourceAgentBridgeVersion` is populated by current senders so receivers can
 * render source and destination versions separately in relay notices. Older
 * peers omit it and receivers display the source version as unknown.
 *
 * `relaySummary` is optional source-authored text for the user-facing relay
 * receipt. Receivers can use it to post a complete notice from code before the
 * destination agent turn runs.
 */
export function buildReply({
  fromMachine,
  toMachine,
  replyToId,
  content,
  target,
  incoming,
  ownTarget,
  sourceAgentBridgeVersion,
  relaySummary,
}) {
  const resolvedTarget = target ?? incoming?.fromTarget;
  /** @type {Record<string, unknown>} */
  const reply = {
    id: newMessageId(),
    from: fromMachine,
    to: toMachine,
    type: "reply",
    content,
    timestamp: Date.now(),
    replyTo: replyToId,
    ttl: DEFAULT_TTL_SECONDS,
  };
  if (typeof resolvedTarget === "string" && resolvedTarget) {
    reply.target = resolvedTarget;
  }
  if (typeof ownTarget === "string" && ownTarget) {
    reply.fromTarget = ownTarget;
  }
  if (typeof sourceAgentBridgeVersion === "string" && sourceAgentBridgeVersion) {
    reply.sourceAgentBridgeVersion = sourceAgentBridgeVersion;
  }
  const cleanedRelaySummary = cleanRelaySummary(relaySummary);
  if (cleanedRelaySummary) {
    reply.relaySummary = cleanedRelaySummary;
  }
  return reply;
}

function cleanRelaySummary(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
