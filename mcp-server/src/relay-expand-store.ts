/**
 * Re-export shim for the shared relay-expand-store.
 *
 * Canonical source lives at `<repo>/lib/relay-expand-store.js` (plain ESM JS).
 * Both consumers — the OpenClaw `openclaw-channel/` plugin and this Claude
 * Code `mcp-server/` channel plugin — import the same module so the on-disk
 * relay-expand store under `~/.agent-bridge/relay-expand/` is byte-identical
 * across the fleet, and the `agent-bridge relay-expand <id>` CLI verb can
 * resolve entries written by either harness.
 *
 * Added in agent-bridge 4.7.1 as part of CC's relay-expand parity work: prior
 * to 4.7.1, only OpenClaw populated the store. CC's inbound-channel handler
 * now calls `storeRelayExpandMessage` so its relay scaffolds can also include
 * `expand id: NN` + `expand: agent-bridge relay-expand NN` lines, matching
 * OC's emit shape.
 *
 * IMPORTANT runtime note: this re-export resolves at the relative path
 * `../../lib/relay-expand-store.js` from the compiled `build/index.js`,
 * which requires the mcp-server plugin to run from a checkout of the full
 * agent-bridge repo (so `lib/` is a sibling of `mcp-server/`). That's the
 * documented production posture (see CLAUDE.md "Stale / out-of-date plugin
 * install" + `agent-bridge plugin-registry-rewire`).
 */

export {
  DEFAULT_RELAY_EXPAND_TTL_MS,
  DEFAULT_RELAY_EXPAND_MAX_ENTRIES,
  DEFAULT_RELAY_EXPAND_ID_SPACE,
  defaultRelayExpandDir,
  defaultRelayExpandStorePath,
  normalizeExpandId,
  storeRelayExpandMessage,
  readRelayExpandEntry,
  formatRelayExpandEntry,
} from '../../lib/relay-expand-store.js';

export type {
  RelayExpandBridgeMessage,
  RelayExpandMetadata,
  RelayExpandStoreOpts,
  RelayExpandRecord,
} from '../../lib/relay-expand-store.js';
