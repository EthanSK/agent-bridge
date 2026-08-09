/**
 * Path constants + resolution for the agent-bridge Codex channel.
 *
 * Every path is derived from the bridge state dir so tests (and sandboxed
 * harnesses) can point the whole component at a scratch dir via
 * `AGENT_BRIDGE_HOME`. Mirrors the layout conventions used by
 * `mcp-server/src/config.ts` and `openclaw-channel/src/inbox-watcher.js`:
 *
 *   inbox/codex/<alias>/<id>.json          pending bridge messages
 *   inbox/.pending-ack/codex/<alias>/      staged (claimed) messages + meta
 *   inbox/.archive/codex/<alias>/          delivered messages (debug tail)
 *   inbox/.failed/codex/<alias>/           malformed / mis-targeted quarantine
 *   inbox/.failed/.exhausted/              retry-exhausted dead letters
 *   codex/bindings.json                    alias -> thread binding registry
 *   codex/pending-settings/<alias>.json     crash-safe sticky-settings restore
 *   locks/codex-channel.lock.json          single-daemon lease
 *   locks/codex-channel.teardown-poison.json durable unknown-child fence
 *   codex/delivered/<shard>/<hash>.id      non-expiring delivered-id tombstones
 *   .codex-channel-delivered               legacy delivered-id ledger (read-only migration)
 *
 * Platform-neutral: node:path joins only, no hardcoded separators.
 */

import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export const CODEX_HARNESS_PREFIX = "codex";

function isAbsoluteBridgePath(value, platform, pathApi) {
  if (platform !== "win32") return pathApi.isAbsolute(value);
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  // win32.isAbsolute() treats root-relative paths and incomplete UNC hosts as
  // absolute even though they still depend on ambient drive/cwd state. A
  // bridge root must include both UNC server and share components.
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(value);
}

/**
 * Resolve the bridge state dir (`~/.agent-bridge` by default).
 *
 * `AGENT_BRIDGE_HOME` may point either at the state dir itself or at a parent
 * home dir — same normalization contract as the bash CLI's
 * `_ab_normalize_bridge_home_override`, kept lenient here: if the override's
 * basename is already `.agent-bridge` use it as-is, otherwise append. Tilde
 * forms and either trailing separator are normalized here because this module
 * also runs from the standalone Windows runtime, outside the bash CLI.
 */
export function bridgeHome(env = process.env, platform = process.platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const configuredHome = platform === "win32"
    ? (env.USERPROFILE?.trim() || env.HOME?.trim() || homedir())
    : (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
  const fallbackHome = isAbsoluteBridgePath(configuredHome, platform, pathApi)
    ? configuredHome
    : homedir();
  const override = typeof env.AGENT_BRIDGE_HOME === "string" ? env.AGENT_BRIDGE_HOME.trim() : "";
  if (override) {
    let expanded = override;
    if (expanded === "~") {
      expanded = fallbackHome;
    } else if (/^~[\\/]/.test(expanded)) {
      const suffix = expanded.slice(2).replace(/[\\/]+/g, pathApi.sep);
      expanded = suffix ? pathApi.join(fallbackHome, suffix) : fallbackHome;
    }

    const root = pathApi.parse(expanded).root;
    while (expanded.length > root.length && /[\\/]$/.test(expanded)) {
      expanded = expanded.slice(0, -1);
    }
    if (!isAbsoluteBridgePath(expanded, platform, pathApi)) {
      throw new Error(`AGENT_BRIDGE_HOME must resolve to an absolute path; received ${JSON.stringify(override)}`);
    }
    const leaf = pathApi.basename(expanded);
    const isStateDir = platform === "win32"
      ? leaf.toLowerCase() === ".agent-bridge"
      : leaf === ".agent-bridge";
    return isStateDir ? expanded : pathApi.join(expanded, ".agent-bridge");
  }
  return pathApi.join(fallbackHome, ".agent-bridge");
}

export function codexStateDir(env = process.env) {
  return join(bridgeHome(env), "codex");
}

export function bindingsFilePath(env = process.env) {
  return join(codexStateDir(env), "bindings.json");
}

export function pendingSettingsDir(env = process.env) {
  return join(codexStateDir(env), "pending-settings");
}

export function pendingSettingsPath(alias, env = process.env) {
  return join(pendingSettingsDir(env), `${alias}.json`);
}

export function inboxRoot(env = process.env) {
  return join(bridgeHome(env), "inbox");
}

export function codexInboxDir(alias, env = process.env) {
  return join(inboxRoot(env), CODEX_HARNESS_PREFIX, alias);
}

export function codexPendingAckDir(alias, env = process.env) {
  return join(inboxRoot(env), ".pending-ack", CODEX_HARNESS_PREFIX, alias);
}

export function codexArchiveDir(alias, env = process.env) {
  return join(inboxRoot(env), ".archive", CODEX_HARNESS_PREFIX, alias);
}

export function codexFailedDir(alias, env = process.env) {
  return join(inboxRoot(env), ".failed", CODEX_HARNESS_PREFIX, alias);
}

export function exhaustedDir(env = process.env) {
  return join(inboxRoot(env), ".failed", ".exhausted");
}

export function unroutedDir(env = process.env) {
  return join(inboxRoot(env), ".failed", "_unrouted");
}

export function deliveredLedgerPath(env = process.env) {
  return join(bridgeHome(env), ".codex-channel-delivered");
}

export function deliveredTombstonesDir(env = process.env) {
  return join(codexStateDir(env), "delivered");
}

export function locksDir(env = process.env) {
  return join(bridgeHome(env), "locks");
}

export function serviceLeasePath(env = process.env) {
  return join(locksDir(env), "codex-channel.lock.json");
}

export function serviceControlPath(env = process.env) {
  return join(locksDir(env), "codex-channel.control.json");
}

export function serviceTeardownPoisonPath(env = process.env) {
  return join(locksDir(env), "codex-channel.teardown-poison.json");
}

export function logsDir(env = process.env) {
  return join(bridgeHome(env), "logs");
}

// Env-aware equivalents of the shared agent-bridge layout, passed into the
// openclaw-channel outbound helpers (whose module-level defaults are real-home
// based) so tests and sandboxed harnesses stay hermetic.
export function configFilePath(env = process.env) {
  return join(bridgeHome(env), "config");
}

export function keysDirPath(env = process.env) {
  return join(bridgeHome(env), "keys");
}

export function outboundDirPath(env = process.env) {
  return join(bridgeHome(env), "outbound");
}

export function outboxDirPath(env = process.env) {
  return join(bridgeHome(env), "outbox");
}

export function machineNameFilePath(env = process.env) {
  return join(bridgeHome(env), "machine-name");
}

export function identityFilePath(env = process.env) {
  return join(bridgeHome(env), ".identity");
}

export function unifiedLogPath(env = process.env) {
  return join(logsDir(env), "agent-bridge.log");
}

/** Codex home (sessions, config.toml). Honors CODEX_HOME like Codex itself. */
export function codexHome(env = process.env) {
  const override = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (override) return override;
  return join(homedir(), ".codex");
}

export function codexSessionsDir(env = process.env) {
  return join(codexHome(env), "sessions");
}

/** Compose the bridge routing target for an alias, e.g. "codex/release-review". */
export function codexTargetForAlias(alias) {
  return `${CODEX_HARNESS_PREFIX}/${alias}`;
}
