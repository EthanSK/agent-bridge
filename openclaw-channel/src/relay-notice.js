/**
 * Telegram-visible relay receipts for inbound Agent Bridge messages.
 *
 * These are intentionally short, human-glanceable notices sent to the
 * configured OpenClaw chat before/while the synthetic agent turn runs. They
 * let Ethan see that a bridge/harness message landed even when the agent's
 * actual reply routes back over the silent agent-bridge back-channel.
 *
 * Full message bodies are no longer included in the notice. Instead the
 * OpenClaw channel stores the full inbound BridgeMessage locally under
 * ~/.agent-bridge/relay-expand/ and includes a short expand id here.
 */

const DEFAULT_PREVIEW_CHARS = 3000;

export function relayNoticeEnabled(pluginCfg = {}, targetCfg = {}) {
  const raw = targetCfg.relayNotice ?? pluginCfg.relayNotice;
  if (raw === false) return false;
  if (raw && typeof raw === "object" && raw.enabled === false) return false;
  return true;
}

/**
 * Kept as a tiny compatibility helper for older tests/integrations that import
 * it directly. The default relay notice formatter deliberately does NOT call it.
 */
export function relayNoticePreview(content, maxChars = DEFAULT_PREVIEW_CHARS) {
  const text = String(content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const limit = Math.max(20, Number(maxChars) || DEFAULT_PREVIEW_CHARS);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function formatRelayNotice(msg, opts = {}) {
  const fromMachine = clean(msg?.from) || "unknown";
  const fromTarget = clean(msg?.fromTarget);
  const target = clean(msg?.target) || (opts.targetName ? `openclaw/${opts.targetName}` : "openclaw/?");
  const id = clean(msg?.id);
  const expandId = clean(opts.expandId);
  const replyVia = formatReplyViaList(opts.replyVia);
  const agentBridgeVersion = clean(opts.agentBridgeVersion ?? opts.version);

  const from = fromTarget ? `${fromMachine}/${fromTarget}` : fromMachine;
  const lines = ["[Agent Bridge relay] 🛰️"];
  if (agentBridgeVersion) lines.push(`agent-bridge: v${agentBridgeVersion}`);
  lines.push(`received: ${from} → ${target}`);
  if (replyVia) lines.push(`reply path: ${replyVia}`);
  if (id) lines.push(`message id: ${id}`);
  if (expandId) {
    lines.push(`expand id: ${expandId}`);
    lines.push(`expand: agent-bridge relay-expand ${expandId}`);
  }
  return lines.join("\n");
}

/**
 * Render a `replyVia` value (string OR array) for inclusion in the relay
 * notice. Arrays are comma-joined so multi-channel fan-outs read cleanly
 * ("reply path: telegram, agent-bridge"). Empty / unknown input yields "".
 */
function formatReplyViaList(value) {
  if (Array.isArray(value)) {
    const cleaned = value.map((v) => clean(v)).filter(Boolean);
    return cleaned.join(", ");
  }
  return clean(value);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export const __testing = {
  DEFAULT_PREVIEW_CHARS,
};
