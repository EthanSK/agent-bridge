/**
 * OpenClaw plugin entry point for @agent-bridge/openclaw-channel.
 *
 * v2.1.0 changes
 * --------------
 * - Watches per-target subdirs under `~/.agent-bridge/inbox/openclaw/` rather
 *   than the flat `~/.agent-bridge/inbox/` root. Each subdir corresponds to a
 *   configured `targets.<name>` block in openclaw.json.
 * - Injects inbound messages into the already-running Telegram-bound agent
 *   session (via `enqueueSystemEvent`) so the reply lands in the SAME
 *   Telegram chat the user was already talking in, rather than spawning a
 *   separate "agent-bridge" channel.
 * - `sessionKey` is built as `agent:<agentId>:telegram:<account>:direct:<peer_id>`
 *   so the target's own `lastChannel` state drives reply routing.
 * - `trusted: false` on injected events — SSH-pairing is not a first-party
 *   trust boundary, so we treat inbound bridge content as third-party input.
 * - Uses `enqueueSystemEvent` alone (no heartbeat call) — matches the built-in
 *   telegram channel's pattern. The event loop picks up queued events
 *   automatically, so no explicit session wake-up is needed.
 *
 * The previous v2.0.x `registerChannel` flow is retained for the rare case
 * where a paired peer is also an agent-bridge-aware harness (e.g. a cross-
 * machine Claude Code ↔ OpenClaw reply loop) — the outbound SCP path is still
 * available, it just isn't the primary path for the Telegram-injection flow.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { makeLogger } from "./log.js";
import { startInboxWatcher } from "./inbox-watcher.js";
import {
  createAgentBridgeChannelPlugin,
  AGENT_BRIDGE_CHANNEL_ID,
} from "./channel-plugin.js";
import { localMachineName } from "./outbound.js";

const PLUGIN_ID = "agent-bridge";
const PLUGIN_NAME = "Agent Bridge (Channel v2)";
const DEFAULT_AGENT_ID = "main";

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "First-class OpenClaw channel for cross-machine agent-to-agent messaging over SSH. Per-target subdir routing + running-session injection so bridge replies land in the same Telegram chat.",

  register(api) {
    const log = makeLogger(api?.logger);
    const pluginCfg = api?.pluginConfig ?? {};

    if (pluginCfg.enabled === false) {
      log.info("disabled via pluginConfig.enabled=false");
      return;
    }

    // Short-lived CLI contexts (help, inspect, list, setup --help, etc.) also
    // load plugins. Skip the watcher for those to avoid stalled processes.
    const argv = process.argv.join(" ");
    const isGateway =
      argv.includes(" gateway ") ||
      argv.endsWith(" gateway") ||
      argv.includes("/gateway ") ||
      argv.includes("gateway-run") ||
      argv.includes("/entry.js gateway") ||
      process.env.OPENCLAW_ROLE === "gateway";

    const regMode = api?.registrationMode;
    const isSetupOnly = regMode === "cli-metadata" || regMode === "setup-only";

    // Map of session-key-ish hint -> { fromMachine } so the outbound adapter
    // knows which machine to SCP a reply to when the agent replies in-turn.
    const replyTargets = new Map();

    // Register the native channel FIRST — this is the primary v2 contract,
    // and must happen regardless of gateway vs CLI so the channel shows up
    // in `openclaw channels list` etc.
    try {
      const channelPlugin = createAgentBridgeChannelPlugin({
        logger: log,
        getReplyTargets: () => replyTargets,
        getPluginConfig: () => pluginCfg,
      });

      if (typeof api?.registerChannel === "function") {
        api.registerChannel({ plugin: channelPlugin });
        log.info(`registered native channel id="${AGENT_BRIDGE_CHANNEL_ID}"`);
      } else {
        log.warn(
          "api.registerChannel is not available on this host. Skipping native channel registration (falling back to watcher-only mode). Upgrade OpenClaw to a build that supports registerChannel.",
        );
      }
    } catch (err) {
      log.error(`registerChannel failed: ${err?.stack || err}`);
    }

    // Stop here for non-gateway / setup-only hosts. Watcher + dispatch only
    // make sense inside the long-lived gateway process.
    if (!isGateway || isSetupOnly) {
      log.debug(
        `skipping inbox watcher (isGateway=${isGateway}, registrationMode=${regMode ?? "?"})`,
      );
      return;
    }

    // Resolve targets. Precedence (refinement 2 — 2026-04-20):
    //   1. Explicit `pluginCfg.targets` (advanced override).
    //   2. Auto-discovery from the global OpenClaw config's
    //      `channels.telegram.accounts` map — each account becomes a target
    //      named after the account, routing to `telegram:<account>`.
    //   3. Legacy fallback: a single `default` target with warn log so
    //      pre-2.1.0 installs don't hard-break on upgrade.
    //
    // Peer ID resolution (in order):
    //   a. Explicit `targets.<name>.peer_id` on the override block.
    //   b. `pluginCfg.peer_id` (plugin-level default).
    //   c. Derive from OpenClaw meta / the first allowlisted chat id on the
    //      corresponding `channels.telegram.accounts[<name>].allowFrom` list.
    //   d. Fail loudly: we log `peer_id missing for target "<name>"` and
    //      skip that target rather than silently injecting to the wrong chat.
    const openclawGlobalCfg = resolveOpenClawConfig(api);
    const targets = resolveTargets({
      pluginCfg,
      openclawGlobalCfg,
      log,
    });
    const agentId = pluginCfg.agentId ?? DEFAULT_AGENT_ID;

    // Start the inbox watcher — one poll loop over all configured targets.
    let stopWatcher = () => {};
    loadSystemEvents(log)
      .then((runtime) => {
        const enqueueSystemEvent = runtime.enqueueSystemEvent;

        const inboxRoot = pluginCfg.inboxRoot
          ?? pluginCfg.inboxDir // legacy field name, v2.0.x
          ?? join(homedir(), ".agent-bridge", "inbox");
        const pollIntervalMs = pluginCfg.pollIntervalMs;

        log.info(
          `session-injection mode: agentId="${agentId}", inboxRoot=${inboxRoot}, targets=[${Object.keys(targets).join(", ")}]`,
        );

        stopWatcher = startInboxWatcher({
          inboxRoot,
          pollIntervalMs,
          logger: log,
          targets,
          async onMessage(msg, ctx) {
            const target = ctx.target;
            const fromMachine = msg.from ?? "unknown";
            const body = formatInboundBody(msg);

            // Session key format: agent:<agentId>:<channel>:<account>:direct:<peerId>.
            // Matches the format OpenClaw uses internally for direct-peer
            // sessions; we build it here so bridge inbound messages join the
            // existing conversation rather than spawning a new one.
            const sessionKey = target.config.legacy_session
              ? `${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`
              : buildSessionKey({
                  agentId: target.config.agent_id ?? agentId,
                  channel: target.config.openclaw_channel ?? "telegram",
                  account: target.config.account ?? target.name,
                  peerId: target.config.peer_id,
                });

            // Remember the origin machine for in-session outbound replies,
            // in case the agent DOES reply over the bridge (the Telegram
            // session's lastChannel is normally Telegram, but cross-harness
            // bridge replies still need to route).
            //
            // Also stash the incoming BridgeMessage and the OpenClaw target's
            // own ID so channel-plugin.js :: sendText can populate
            // `reply.target` from `incoming.fromTarget` for proper round-trip
            // routing back to the ORIGINAL sender's session
            // (refinement 3 — 2026-04-20).
            const ownTarget = `openclaw/${target.name}`;
            const hit = { fromMachine, incoming: msg, ownTarget };
            replyTargets.set(sessionKey, hit);
            replyTargets.set(String(fromMachine), hit);
            // Keyed by target subdir name too, so `ctx.accountId` hints in
            // the outbound adapter still resolve.
            replyTargets.set(`${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`, hit);
            replyTargets.set(target.name, hit);

            // Security: trusted=false — SSH pairing is not a first-party
            // trust boundary, so inbound content is treated as third-party.
            const enqueueOpts = {
              sessionKey,
              contextKey: fromMachine,
              trusted: false,
            };

            // Pre-inject diagnostics: log sessionKey + any session-lookup
            // hint before the enqueueSystemEvent call so, if the call hangs
            // or the session doesn't exist, we at least see what we tried.
            // OpenClaw's plugin-sdk currently exposes no `hasSession` /
            // `getSession` helper to us, so we log the resolved key plus a
            // note that existence is confirmed by the boolean return.
            const sessionProbe = probeSession(api, sessionKey);
            log.info(
              `about to inject ${msg.id} from ${fromMachine} target=${target.name} `
              + `sessionKey=${sessionKey} probe=${sessionProbe}`,
            );

            let ok = false;
            try {
              ok = enqueueSystemEvent(body, enqueueOpts);
            } catch (err) {
              // Bug 3: surface the exception with full context, then rethrow
              // so the watcher moves the file to .failed/ rather than
              // re-processing it on every poll.
              log.error(
                `enqueueSystemEvent threw for ${msg.id} sessionKey=${sessionKey} `
                + `target=${target.name}: ${err?.message ?? err} — `
                + `stack: ${err?.stack ?? "(no stack)"}`,
              );
              throw err;
            }
            if (!ok) {
              log.warn(
                `inbound ${msg.id} from ${fromMachine} target=${target.name} was NOT enqueued `
                + `(host rejected, possibly no active session for sessionKey=${sessionKey}) — `
                + `file will be moved to .failed/`,
              );
              throw new Error(
                `enqueueSystemEvent rejected ${msg.id} for session ${sessionKey}`,
              );
            }
            log.info(
              `inbound ${msg.id} from ${fromMachine} target=${target.name} injected into session ${sessionKey}`,
            );
          },
        });
      })
      .catch((err) => {
        log.error(
          `failed to load plugin-sdk system-events dispatcher: ${err?.stack || err}`,
        );
      });

    const disposeAll = () => {
      try {
        stopWatcher();
      } catch {
        /* ignore */
      }
    };
    process.once("SIGTERM", disposeAll);
    process.once("SIGINT", disposeAll);
    process.once("beforeExit", disposeAll);
  },
};

/**
 * Resolve the global OpenClaw config off the plugin `api` object. Different
 * OpenClaw host builds expose this under different keys; we try the common
 * shapes and fall back to `{}` (auto-discovery simply yields no targets).
 */
function resolveOpenClawConfig(api) {
  if (!api || typeof api !== "object") return {};
  const candidates = [
    api.openclawConfig,
    api.hostConfig,
    api.globalConfig,
    api.config,
    typeof api.getConfig === "function" ? safeCall(api.getConfig) : null,
    typeof api.getHostConfig === "function" ? safeCall(api.getHostConfig) : null,
  ];
  for (const cfg of candidates) {
    if (cfg && typeof cfg === "object") return cfg;
  }
  return {};
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Resolve the final target map for the watcher. See the precedence note in
 * `register()` above.
 *
 * Target config shape (as stored in-memory, post-resolution):
 *
 *   {
 *     openclaw_channel: "telegram",
 *     account: "<accountId>",
 *     peer_id: "<numeric telegram user id>",
 *     agent_id: "main" | null,
 *     legacy_session?: boolean,       // true ⇒ use legacy agent-bridge sessionKey
 *     auto_discovered?: boolean       // true ⇒ came from channels.telegram.accounts
 *   }
 */
function resolveTargets({ pluginCfg, openclawGlobalCfg, log }) {
  // 1. Explicit override wins.
  if (
    pluginCfg.targets &&
    typeof pluginCfg.targets === "object" &&
    Object.keys(pluginCfg.targets).length > 0
  ) {
    return normalizeExplicitTargets(pluginCfg, log);
  }

  // 2. Auto-discover from channels.telegram.accounts.
  const discovered = autoDiscoverFromTelegram({ pluginCfg, openclawGlobalCfg, log });
  if (Object.keys(discovered).length > 0) {
    log.info(
      `auto-discovered ${Object.keys(discovered).length} target(s) from `
      + `channels.telegram.accounts: ${Object.keys(discovered).join(", ")}`,
    );
    return discovered;
  }

  // 3. Legacy fallback.
  log.warn(
    `channels["agent-bridge"].config.targets is missing AND no telegram accounts `
    + `could be auto-discovered. Falling back to legacy target "default" at `
    + `inbox/openclaw/default/. Either add a targets map or populate `
    + `channels.telegram.accounts in openclaw.json.`,
  );
  return {
    default: {
      openclaw_channel: AGENT_BRIDGE_CHANNEL_ID,
      account: "default",
      peer_id: null,
      agent_id: null,
      legacy_session: true,
    },
  };
}

function normalizeExplicitTargets(pluginCfg, log) {
  const raw = pluginCfg.targets;
  const pluginPeerId = pluginCfg.peer_id;
  const out = {};
  for (const name of Object.keys(raw)) {
    if (!isValidTargetName(name)) {
      log.warn(`target "${name}" has an invalid subdir name — skipping`);
      continue;
    }
    const cfg = raw[name];
    if (!cfg || typeof cfg !== "object") {
      log.warn(`target "${name}" has no config object — skipping`);
      continue;
    }
    const peerId = cfg.peer_id ?? pluginPeerId ?? null;
    if (!peerId) {
      log.warn(
        `target "${name}" missing peer_id (and no plugin-level fallback `
        + `pluginConfig.peer_id is set) — skipping`,
      );
      continue;
    }
    out[name] = {
      openclaw_channel: cfg.openclaw_channel ?? "telegram",
      account: cfg.account ?? name,
      peer_id: peerId,
      agent_id: cfg.agent_id ?? null,
    };
  }
  return out;
}

/**
 * Build targets from the OpenClaw global config's
 * `channels.telegram.accounts` map. Each account becomes one target.
 *
 * Peer ID precedence (per-target):
 *   a. `pluginCfg.targets[name].peer_id` is handled by the explicit path.
 *   b. `pluginCfg.peer_id` (plugin-level default).
 *   c. `openclawGlobalCfg.meta.user_id` / `.owner_id`.
 *   d. First `chat_id` in `channels.telegram.accounts[name].allowFrom` list
 *      (covers the most common single-user setup).
 */
function autoDiscoverFromTelegram({ pluginCfg, openclawGlobalCfg, log }) {
  const out = {};
  const channels = openclawGlobalCfg?.channels;
  if (!channels || typeof channels !== "object") return out;
  const telegram = channels.telegram;
  if (!telegram || typeof telegram !== "object") return out;
  const accounts = telegram.accounts;
  if (!accounts || typeof accounts !== "object") return out;

  const meta = openclawGlobalCfg?.meta ?? {};
  const metaPeer =
    meta.user_id ?? meta.owner_id ?? meta.telegram_user_id ?? null;
  const pluginPeer = pluginCfg?.peer_id ?? null;

  for (const accountName of Object.keys(accounts)) {
    if (!isValidTargetName(accountName)) {
      log.warn?.(
        `telegram account "${accountName}" has an invalid subdir name — skipping`,
      );
      continue;
    }
    const account = accounts[accountName] ?? {};
    const allowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : [];
    const firstAllowChatId = allowFrom.find(
      (v) => typeof v === "string" || typeof v === "number",
    );
    const peerId =
      pluginPeer ??
      account.peer_id ??
      metaPeer ??
      (firstAllowChatId != null ? String(firstAllowChatId) : null);

    if (!peerId) {
      log.warn?.(
        `auto-discovery: target "${accountName}" has no resolvable peer_id `
        + `(checked pluginConfig.peer_id, meta.user_id, allowFrom[0]) — skipping. `
        + `Set channels.agent-bridge.config.peer_id or add a numeric id to `
        + `channels.telegram.accounts["${accountName}"].allowFrom.`,
      );
      continue;
    }
    out[accountName] = {
      openclaw_channel: "telegram",
      account: accountName,
      peer_id: String(peerId),
      agent_id: null,
      auto_discovered: true,
    };
  }
  return out;
}

function isValidTargetName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
  );
}

function buildSessionKey({ agentId, channel, account, peerId }) {
  // agent:main:telegram:<account>:direct:<peerId>
  return `agent:${agentId}:${channel}:${account}:direct:${peerId}`;
}

/**
 * Best-effort peek at host-side session existence for the given sessionKey.
 * OpenClaw's plugin-sdk doesn't currently expose a stable lookup API, so we
 * probe a few plausible names and fall back to "unknown" without throwing.
 * Used purely for diagnostic logging.
 */
function probeSession(api, sessionKey) {
  if (!api || typeof sessionKey !== "string") return "unknown(no-api)";
  const candidates = [
    api.hasSession,
    api.getSession,
    api.lookupSession,
    api.sessions && api.sessions.has ? api.sessions.has.bind(api.sessions) : null,
    api.sessions && api.sessions.get ? api.sessions.get.bind(api.sessions) : null,
  ];
  for (const fn of candidates) {
    if (typeof fn !== "function") continue;
    try {
      const r = fn(sessionKey);
      if (r === true) return "exists";
      if (r === false) return "missing(will-create)";
      if (r && typeof r === "object") return "exists";
      if (r == null) return "missing(will-create)";
      return `unknown(${typeof r})`;
    } catch (err) {
      return `probe-error(${err?.message ?? err})`;
    }
  }
  return "unknown(no-lookup-api)";
}

/**
 * Dynamically import the plugin-sdk dispatch API. We import lazily so that
 * `node --check src/index.js` succeeds even when the plugin-sdk isn't on the
 * resolver path (e.g. in CI or during local type-check).
 *
 * Returns `{ enqueueSystemEvent }`. Matches the built-in telegram channel's
 * pattern — enqueueSystemEvent alone is sufficient; the event loop picks up
 * queued events automatically.
 */
async function loadSystemEvents(log) {
  // enqueueSystemEvent is re-exported from several plugin-sdk subpaths
  // depending on host version. Try them in order of most-likely to work.
  const subpaths = [
    "plugin-sdk/infra-runtime",
    "plugin-sdk/channel-runtime",
    "plugin-sdk/channel-core",
    "plugin-sdk/channel-inbound",
  ];
  const errors = [];

  const mergeExports = (mod) => ({
    enqueueSystemEvent: mod.enqueueSystemEvent,
  });

  // Strategy 1: direct `openclaw/...` ESM import. Works when the plugin is
  // loaded via a mechanism that gives it access to the host's node_modules
  // (npm link, npm install, or a host that injects node_modules into the
  // plugin's resolution root).
  for (const sub of subpaths) {
    const spec = `openclaw/${sub}`;
    try {
      const mod = await import(spec);
      if (typeof mod.enqueueSystemEvent === "function") {
        return mergeExports(mod);
      }
      errors.push(`${spec}: loaded but missing enqueueSystemEvent`);
    } catch (err) {
      errors.push(`${spec}: ${err?.message || err}`);
    }
  }

  // Strategy 2: resolve via the host's own node_modules. On a typical install
  // `openclaw` is a globally linked package whose absolute path we can walk
  // up from `process.argv[1]` (the openclaw CLI entry) or discover via the
  // parent `openclaw` binary/module on disk.
  try {
    const { createRequire } = await import("node:module");
    const { dirname, resolve: resolvePath } = await import("node:path");
    const { existsSync, realpathSync } = await import("node:fs");

    const hostCandidates = [];
    if (process.argv[1]) {
      try {
        hostCandidates.push(realpathSync(process.argv[1]));
      } catch {
        hostCandidates.push(process.argv[1]);
      }
    }
    hostCandidates.push("/opt/homebrew/bin/openclaw");
    hostCandidates.push("/usr/local/bin/openclaw");

    for (const entry of hostCandidates) {
      if (!entry || !existsSync(entry)) continue;
      let resolved;
      try {
        resolved = realpathSync(entry);
      } catch {
        resolved = entry;
      }

      let cursor = dirname(resolved);
      for (let i = 0; i < 8; i += 1) {
        const pkgPath = resolvePath(cursor, "package.json");
        if (existsSync(pkgPath)) {
          try {
            const req = createRequire(pkgPath);
            for (const sub of subpaths) {
              try {
                const modPath = req.resolve(`openclaw/${sub}`);
                const mod = await import(modPath);
                if (typeof mod.enqueueSystemEvent === "function") {
                  return mergeExports(mod);
                }
                errors.push(`resolved ${modPath}: missing enqueueSystemEvent`);
              } catch (err) {
                errors.push(
                  `createRequire(${pkgPath}) → openclaw/${sub}: ${err?.message || err}`,
                );
              }
            }
          } catch (err) {
            errors.push(`createRequire failed at ${pkgPath}: ${err?.message || err}`);
          }
          break;
        }
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
  } catch (err) {
    errors.push(`dynamic host-resolve path failed: ${err?.message || err}`);
  }

  throw new Error(
    `unable to load plugin-sdk dispatch API (enqueueSystemEvent): ${errors.join("; ")}`,
  );
}

/**
 * Shape the inbound BridgeMessage as a <channel> block — parity with the
 * Claude Code channel plugin so the agent sees the same envelope on both
 * sides of the bridge.
 */
function formatInboundBody(msg) {
  const machine = localMachineName();
  const attrs = [
    `source="agent-bridge"`,
    `from="${escapeAttr(msg.from)}"`,
    `to="${escapeAttr(msg.to ?? machine)}"`,
    `message_id="${escapeAttr(msg.id)}"`,
    msg.target ? `target="${escapeAttr(msg.target)}"` : null,
    msg.fromTarget ? `from_target="${escapeAttr(msg.fromTarget)}"` : null,
    msg.timestamp ? `ts="${msg.timestamp}"` : null,
    msg.replyTo ? `reply_to="${escapeAttr(msg.replyTo)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `<channel ${attrs}>${msg.content ?? ""}</channel>`;
}

function escapeAttr(v) {
  return String(v ?? "").replace(/"/g, '\\"');
}
