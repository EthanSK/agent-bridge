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
 *   ttl?: 3600
 * }
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
  if (obj.timestamp != null && typeof obj.timestamp !== "number") return null;
  return obj;
}

/** Build a reply BridgeMessage envelope. */
export function buildReply({ fromMachine, toMachine, replyToId, content }) {
  return {
    id: newMessageId(),
    from: fromMachine,
    to: toMachine,
    type: "reply",
    content,
    timestamp: Date.now(),
    replyTo: replyToId,
    ttl: 3600,
  };
}
