/**
 * Re-export shim for the shared relay-expand-store.
 *
 * Canonical source lives at `<repo>/lib/relay-expand-store.js` (plain ESM JS).
 * Both consumers — this OpenClaw `openclaw-channel/` plugin AND the Claude
 * Code `mcp-server/` channel plugin — import the same module so the on-disk
 * relay-expand store under `~/.agent-bridge/relay-expand/` is byte-identical
 * across the fleet, and the `agent-bridge relay-expand <id>` CLI verb can
 * resolve entries written by either harness.
 *
 * Pre-4.7.1 the canonical source lived here in `openclaw-channel/src/`; it
 * moved to `lib/` in 4.7.1 as part of the Claude Code parity work that gave
 * CC its own relay-expand store population. This shim keeps existing imports
 * inside `openclaw-channel/` (and the test suite) working unchanged.
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
  __testing,
} from "../../lib/relay-expand-store.js";
