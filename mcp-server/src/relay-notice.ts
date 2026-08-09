/**
 * Re-export shim for the shared agent-bridge relay-notice formatter.
 *
 * Canonical source lives at `<repo>/lib/relay-notice.js` (plain ESM JS).
 * Both consumers — the OpenClaw `openclaw-channel/` plugin and this Claude
 * Code `mcp-server/` channel plugin — import the same module so the
 * structural shape of bridge-relay user-facing notices is byte-identical
 * across the fleet.
 *
 * The Summary blockquote (which requires LLM judgment per inbound message)
 * stays agent-driven in BOTH harnesses: pass `summary: null` to embed a
 * `{{SUMMARY_PLACEHOLDER}}` sentinel that the agent replaces before sending
 * the relay to the user-facing channel. Canonical user-facing format spec:
 * `docs/relay-to-user.md`.
 *
 * 4.10.0 [CODEX-CHANNEL packaging] runtime note: this re-export resolves the
 * PACKAGE-LOCAL vendor snapshot (`mcp-server/vendor/relay-notice.js`,
 * refreshed from `lib/relay-notice.js` by the npm `prebuild` sync and
 * parity-tested), so the marketplace/cache artifact — which contains the
 * mcp-server directory ALONE — is self-contained. In a full repo checkout
 * the snapshot is always byte-identical to the canonical `lib/` source.
 */

export {
  formatRelayNotice,
  formatRelayScaffold,
  relayNoticeEnabled,
  relayNoticePreview,
  SUMMARY_PLACEHOLDER,
  RELAY_SCAFFOLD_START,
  RELAY_SCAFFOLD_END,
} from '../vendor/relay-notice.js';

export type { RelayNoticeMessage, RelayNoticeOpts } from '../vendor/relay-notice.js';
