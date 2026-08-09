/**
 * TypeScript ambient declarations for the shared relay-notice formatter.
 * The implementation lives in `relay-notice.js` (plain ESM JS); this file
 * exists so the `mcp-server/` TypeScript build can import it with proper
 * type checking.
 */

export interface RelayNoticeMessage {
  id?: string | null;
  from?: string | null;
  to?: string | null;
  fromTarget?: string | null;
  target?: string | null;
  /** Sender-side Agent Bridge version, when carried on the BridgeMessage. */
  sourceAgentBridgeVersion?: string | null;
  /** Back-compat sender-side aliases accepted from custom/older peers. */
  agentBridgeVersion?: string | null;
  agent_bridge_version?: string | null;
  /** Optional source-authored relay summary. */
  relaySummary?: string | null;
  /** Snake-case alias accepted from custom harnesses. */
  relay_summary?: string | null;
}

export interface RelayNoticeOpts {
  /** Local target name (OC fallback when msg.target is empty). */
  targetName?: string;
  /** OC-only relay-expand id. */
  expandId?: string;
  /** Reply-path channels (string or array). */
  replyVia?: string | string[];
  /** Sender-side Agent Bridge version, when known. */
  sourceAgentBridgeVersion?: string;
  /** Receiver-side Agent Bridge version, when known. */
  destinationAgentBridgeVersion?: string;
  /** Back-compat alias for destinationAgentBridgeVersion. */
  agentBridgeVersion?: string;
  /** Alias for destinationAgentBridgeVersion. */
  version?: string;
  /**
   * 1-3 sentence Summary string.
   * - non-empty string: embedded as `<blockquote><b>Summary:</b> ...</blockquote>`.
   * - null: a `{{SUMMARY_PLACEHOLDER}}` sentinel is appended.
   * - undefined: msg.relaySummary is used when present, otherwise omitted.
   */
  summary?: string | null;
}

export const SUMMARY_PLACEHOLDER: string;
export const RELAY_SCAFFOLD_START: string;
export const RELAY_SCAFFOLD_END: string;

export function relayNoticeEnabled(
  pluginCfg?: Record<string, unknown>,
  targetCfg?: Record<string, unknown>,
): boolean;

export function relayNoticePreview(
  content: unknown,
  maxChars?: number,
): string;

export function formatRelayNotice(
  msg: RelayNoticeMessage | null | undefined,
  opts?: RelayNoticeOpts,
): string;

/**
 * Wraps `formatRelayNotice` output with `[RELAY-SCAFFOLD-START]` /
 * `[RELAY-SCAFFOLD-END]` fences. Uses msg.relaySummary / opts.summary when
 * present; otherwise emits a `{{SUMMARY_PLACEHOLDER}}` sentinel.
 */
export function formatRelayScaffold(
  msg: RelayNoticeMessage | null | undefined,
  opts?: RelayNoticeOpts,
): string;

export const __testing: {
  DEFAULT_PREVIEW_CHARS: number;
};
