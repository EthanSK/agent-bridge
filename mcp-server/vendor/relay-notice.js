/**
 * Shared relay-notice scaffold formatter (canonical source-of-truth).
 *
 * Imported by BOTH:
 *   - `openclaw-channel/src/relay-notice.js` (re-export shim) — used by the
 *     OpenClaw channel plugin to programmatically emit Telegram-visible bridge
 *     receipts via `sendBridgeRelayNotice` (gateway delivery).
 *   - `mcp-server/src/relay-notice.ts` (TS re-export shim) — used by the
 *     Claude Code channel plugin to emit a structured "relay scaffold" inside
 *     each inbound `<channel source="agent-bridge">` push so the agent fills in
 *     a Summary blockquote + sends via the Telegram MCP plugin (agent delivery).
 *
 * The function builds the deterministic STRUCTURAL part of the relay notice
 * (header, source/destination endpoint + version lines, received line, reply
 * path, message id, optional expand id). The Summary blockquote can either be
 * source-provided on the BridgeMessage (`relaySummary`) or caller-provided via
 * `opts.summary`; pass `summary: null` when the destination agent must fill a
 * `{{SUMMARY_PLACEHOLDER}}` before forwarding to the user.
 *
 * Canonical user-facing format spec: `docs/relay-to-user.md`.
 *
 * IMPORTANT: this module is plain ESM JavaScript with NO transpilation step.
 * Both consumers run from the dev-clone repo (OpenClaw via plugin path,
 * Claude Code via `agent-bridge plugin-registry-rewire`) so the relative
 * import `../../lib/relay-notice.js` resolves at runtime.
 */

const DEFAULT_PREVIEW_CHARS = 3000;

/**
 * Sentinel inserted in place of the Summary blockquote when the caller does
 * NOT pass a `summary` string. The agent (LLM) is expected to replace it with
 * `<blockquote><b>Summary:</b> 1-3 sentence summary</blockquote>` before the
 * relay is sent to the user-facing channel. See `docs/relay-to-user.md`.
 */
export const SUMMARY_PLACEHOLDER = "{{SUMMARY_PLACEHOLDER}}";

/**
 * Marker fence around the structural scaffold when emitted into a CC channel
 * push. Lets the agent reliably extract / reuse the scaffold verbatim and
 * just substitute the Summary placeholder.
 */
export const RELAY_SCAFFOLD_START = "[RELAY-SCAFFOLD-START]";
export const RELAY_SCAFFOLD_END = "[RELAY-SCAFFOLD-END]";

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

/**
 * Format the structural part of a bridge-relay user-facing notice.
 *
 * @param {object} msg                   Inbound BridgeMessage (id, from,
 *                                       to, fromTarget, target, ...).
 * @param {object} [opts]
 * @param {string} [opts.targetName]     Local target name (OC fallback when
 *                                       msg.target is empty).
 * @param {string} [opts.expandId]       OC-only relay-expand id.
 * @param {string|string[]} [opts.replyVia]  Reply-path channels (string or
 *                                           comma-joined array).
 * @param {string} [opts.sourceAgentBridgeVersion]  Sender-side agent-bridge
 *                                                  version, when known.
 * @param {string} [opts.destinationAgentBridgeVersion] Receiver-side
 *                                                     agent-bridge version.
 * @param {string} [opts.agentBridgeVersion]  Back-compat alias for the
 *                                            destination-side version.
 * @param {string} [opts.version]         Alias for destinationAgentBridgeVersion.
 * @param {string|null} [opts.summary]    Optional 1-3 sentence Summary string
 *                                        to embed in a `<blockquote>` block at
 *                                        the end of the notice. When omitted,
 *                                        msg.relaySummary is used if present;
 *                                        when null, a `{{SUMMARY_PLACEHOLDER}}`
 *                                        sentinel is appended instead so the
 *                                        agent can fill it in before sending.
 * @returns {string}                      The formatted notice text.
 */
export function formatRelayNotice(msg, opts = {}) {
  const fromMachine = clean(msg?.from) || "unknown";
  const fromTarget = clean(msg?.fromTarget);
  const toMachine = clean(msg?.to);
  const target = clean(msg?.target) || (opts.targetName ? `openclaw/${opts.targetName}` : "openclaw/?");
  const id = clean(msg?.id);
  const expandId = clean(opts.expandId);
  const replyVia = formatReplyViaList(opts.replyVia);
  const sourceAgentBridgeVersion = clean(
    opts.sourceAgentBridgeVersion
      ?? msg?.sourceAgentBridgeVersion
      ?? msg?.agentBridgeVersion
      ?? msg?.agent_bridge_version,
  );
  const destinationAgentBridgeVersion = clean(
    opts.destinationAgentBridgeVersion
      ?? opts.agentBridgeVersion
      ?? opts.version,
  );

  const from = formatEndpointLabel(fromMachine, fromTarget);
  const destination = formatEndpointLabel(toMachine, target);
  const lines = ["[Agent Bridge relay] 🛰️"];
  lines.push(`source: ${formatEndpointWithVersion(from, sourceAgentBridgeVersion)}`);
  lines.push(`destination: ${formatEndpointWithVersion(destination, destinationAgentBridgeVersion)}`);
  lines.push(`received: ${from} → ${destination}`);
  if (replyVia) lines.push(`reply path: ${replyVia}`);
  if (id) lines.push(`message id: ${id}`);
  if (expandId) {
    lines.push(`expand id: ${expandId}`);
    lines.push(`expand: agent-bridge relay-expand ${expandId}`);
  }

  const body = lines.join("\n");

  const summaryInput = Object.prototype.hasOwnProperty.call(opts, "summary")
    ? opts.summary
    : (msg?.relaySummary ?? msg?.relay_summary);

  // Summary handling. Four modes:
  //   1. summary is a non-empty string -> append `<blockquote>` block.
  //   2. summary === null             -> append placeholder sentinel.
  //   3. summary === undefined        -> legacy mode: omit entirely.
  //   4. summary is an empty string   -> treat as placeholder request.
  if (typeof summaryInput === "string") {
    const summary = cleanSummary(summaryInput);
    if (summary) {
      return `${body}\n<blockquote><b>Summary:</b> ${escapeHtml(summary)}</blockquote>`;
    }
    // Empty string -> treat as placeholder request.
    return `${body}\n${SUMMARY_PLACEHOLDER}`;
  }
  if (summaryInput === null) {
    return `${body}\n${SUMMARY_PLACEHOLDER}`;
  }
  return body;
}

/**
 * Format the structural scaffold wrapped in the RELAY-SCAFFOLD fences and
 * with a `{{SUMMARY_PLACEHOLDER}}` sentinel where the agent should write
 * the Summary blockquote. This is the shape Claude Code's channel plugin
 * embeds in each inbound `<channel source="agent-bridge">` push.
 *
 * The agent's responsibility — documented in `docs/relay-to-user.md` and the
 * `bridge` / `openclaw` skills — is to:
 *
 *   1. Lift the scaffold verbatim out of the channel block.
 *   2. Replace `{{SUMMARY_PLACEHOLDER}}` with
 *      `<blockquote><b>Summary:</b> ...1-3 sentences...</blockquote>`.
 *   3. Send via the harness's user-facing channel (Telegram for CC).
 *
 * @param {object} msg
 * @param {object} [opts]   Same opts as `formatRelayNotice`. Pass
 *                          `summary`/`msg.relaySummary` to embed a completed
 *                          Summary blockquote; otherwise placeholder mode is
 *                          used for destination-agent fill.
 * @returns {string}        The fenced scaffold block, including newline-
 *                          delimited fields and a trailing placeholder line,
 *                          but NO trailing newline (callers add their own).
 */
export function formatRelayScaffold(msg, opts = {}) {
  const hasCallerSummary = Object.prototype.hasOwnProperty.call(opts, "summary");
  const messageSummary = msg?.relaySummary ?? msg?.relay_summary;
  const summary = hasCallerSummary ? opts.summary : (messageSummary ?? null);
  const inner = formatRelayNotice(msg, { ...opts, summary });
  return [RELAY_SCAFFOLD_START, inner, RELAY_SCAFFOLD_END].join("\n");
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

function formatEndpointLabel(machine, target) {
  const cleanedMachine = clean(machine);
  const cleanedTarget = clean(target);
  if (cleanedMachine && cleanedTarget) return `${cleanedMachine}/${cleanedTarget}`;
  return cleanedMachine || cleanedTarget || "unknown";
}

function formatEndpointWithVersion(label, version) {
  const cleanedVersion = clean(version);
  if (cleanedVersion) return `${label} (agent-bridge v${cleanedVersion})`;
  return `${label} (agent-bridge unknown)`;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanSummary(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const __testing = {
  DEFAULT_PREVIEW_CHARS,
};
