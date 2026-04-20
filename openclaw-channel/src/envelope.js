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
 *   ttl?: 3600,
 *   target?: "claude-code",            // where the RECEIVER should deliver this
 *   fromTarget?: "openclaw/clawdiboi2" // where the SENDER wants replies routed
 * }
 *
 * `fromTarget` enables bidirectional round-trips (e.g. OpenClaw ↔ Claude Code):
 * when OpenClaw's agent replies via `bridge_send_message`, the reply envelope's
 * `target` is populated from the ORIGINAL incoming message's `fromTarget`
 * (falling back to "claude-code"). This keeps conversations landing back in
 * the session that started them instead of always flowing into `claude-code/`.
 */

import { randomUUID } from "node:crypto";

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
  const required = ["id", "from", "to", "content"];
  for (const k of required) {
    if (typeof obj[k] !== "string" || !obj[k]) return null;
  }
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
 * Routing resolution order for `target` (refinement 3 — 2026-04-20):
 *   1. Explicit `target` argument wins (advanced override).
 *   2. Else if `incoming` is supplied AND `incoming.fromTarget` is present,
 *      use that — this is the round-trip path. The original sender told us
 *      where to put replies; honour it.
 *   3. Else fall back to "claude-code" (the legacy default for the common
 *      "OpenClaw injects into Telegram, cross-harness reply loops back to
 *      Claude Code" flow).
 *
 * `fromTarget` on the OUTGOING reply is also populated (optional) from the
 * `ownTarget` argument so the peer on the other end can reply back in turn.
 */
export function buildReply({
  fromMachine,
  toMachine,
  replyToId,
  content,
  target,
  incoming,
  ownTarget,
}) {
  const resolvedTarget =
    target ?? incoming?.fromTarget ?? "claude-code";
  /** @type {Record<string, unknown>} */
  const reply = {
    id: newMessageId(),
    from: fromMachine,
    to: toMachine,
    type: "reply",
    content,
    timestamp: Date.now(),
    replyTo: replyToId,
    ttl: 3600,
    target: resolvedTarget,
  };
  if (typeof ownTarget === "string" && ownTarget) {
    reply.fromTarget = ownTarget;
  }
  return reply;
}
