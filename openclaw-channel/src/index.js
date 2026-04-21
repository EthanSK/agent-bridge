/**
 * OpenClaw plugin entry point for @agent-bridge/openclaw-channel.
 *
 * v2.3.1 — sender-derived replyVia default (2026-04-21)
 * ------------------------------------------------------
 * The replyVia fallback no longer hardcodes "telegram" when nothing else is
 * configured. Instead it mirrors the arrival channel: if `msg.fromTarget`
 * is present (stamped by agent-bridge outbound senders as e.g.
 * "claude-code" or "openclaw/<acct>") the message arrived via agent-bridge,
 * so the reply goes back via agent-bridge. Otherwise fall back to
 * "telegram". This gives "reply on the channel it came in on" semantics
 * with zero config. Explicit per-message / per-target / plugin-level
 * settings still win — see precedence block at the resolution site.
 *
 * v2.3.0 — replyVia mode (2026-04-20)
 * ------------------------------------
 * Inbound bridge messages can now be dispatched into EITHER of two session
 * topologies depending on `target.replyVia` (or the plugin-level default):
 *
 *   replyVia: "telegram" — the original v2.2.x behaviour. Inbound message
 *     injects into `agent:main:telegram:<account>:direct:<peerId>` with
 *     Provider/OriginatingChannel=telegram, so the agent's reply flows
 *     back through the live Telegram outbound and Ethan's phone pings.
 *
 *   replyVia: "agent-bridge" — peer-to-peer back-channel. Inbound message
 *     injects into `agent:main:agent-bridge:default:direct:<senderMachine>`
 *     with Provider/OriginatingChannel=agent-bridge, so the agent's reply
 *     flows back through the NATIVE agent-bridge channel (channel-plugin.js
 *     :: sendText), which SCPs a BridgeMessage to the sender machine. No
 *     Telegram traffic is generated. Use for agent-to-agent conversations
 *     that should be invisible to Ethan's phone.
 *
 *   Precedence: per-message `msg.replyVia` > per-target override >
 *   plugin-level `replyVia` > sender-derived (agent-bridge if fromTarget
 *   present, else telegram). Per-message override lets an inbound
 *   BridgeMessage flip the mode without reconfiguring the target — useful
 *   for quick back-channel probes.
 *
 * v2.2.0 — Architectural correction (2026-04-20)
 * ------------------------------------------------
 * STOP using `enqueueSystemEvent`. It's pure queueing: it prepends a
 * `System:` line to the NEXT naturally-scheduled turn's prompt but does NOT
 * trigger an agent turn. See full analysis in
 * `docs/ACTUAL-SESSION-INJECTION-RESEARCH-2026-04-20.md` §4. This means
 * every bridge message injected via the v2.1.x path was silently swallowed
 * unless Ethan happened to then DM the real Telegram bot (at which point
 * our queued text appeared as a `System: ...` line on THAT unrelated turn
 * — wrong semantic).
 *
 * v2.2.0 instead uses `dispatchInboundReplyWithBase` from
 * `openclaw/plugin-sdk/compat`, which is the SAME dispatch primitive the
 * native IRC and Nextcloud Talk channel plugins use, and which drives the
 * same `dispatchReplyFromConfig` path the native telegram bot drives.
 * This actually runs a synchronous agent turn for our synthetic
 * ctxPayload, and replies are routed back through the originating channel
 * because we set `Provider` + `OriginatingChannel` + `OriginatingTo` on
 * the ctxPayload (see `route-reply-CQe8rYFT.js:17-23` docstring re:
 * originating-channel priority).
 *
 * References:
 * - Dispatch primitive source: `plugin-sdk/inbound-reply-dispatch-0KQ4b86b.js:29-65`
 * - IRC reference impl: `extensions/irc/src/inbound.ts:278-362`
 * - sessionKey shape (for dmScope=per-account-channel-peer):
 *   `agent:main:<channel>:<account>:direct:<peerId>`
 *   (built automatically by `runtime.channel.routing.resolveAgentRoute`
 *   via `plugin-sdk/session-key-CbP51u9x.js:175` — do NOT hand-build it;
 *   Ethan's live dmScope setting might change)
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
    "First-class OpenClaw channel for cross-machine agent-to-agent messaging over SSH. Per-target subdir routing + dispatchInboundReplyWithBase session injection so bridge replies land in the same Telegram chat.",

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
    // knows which machine to SCP a reply to when the agent replies in-turn
    // via our NATIVE agent-bridge channel (cross-harness flows). This is
    // irrelevant for the Telegram-injection path — replies there travel
    // back through telegram automatically via OriginatingChannel routing.
    const replyTargets = new Map();

    // Register the native channel FIRST — this is the primary v2 contract
    // for the cross-harness bridge case, and must happen regardless of
    // gateway vs CLI so the channel shows up in `openclaw channels list`.
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

    // OpenClaw plugin api fields (from plugin-sdk/plugins/types.d.ts:312):
    //   api.config  -- OpenClawConfig (full global cfg)
    //   api.runtime -- PluginRuntime (has channel.{routing,reply,session,...})
    const runtime = api?.runtime;
    const hostCfg = api?.config;
    if (!runtime || !runtime.channel) {
      log.error(
        "api.runtime.channel is unavailable — plugin-sdk version is too old. "
        + "Need a host build that exposes runtime.channel.{routing,reply,session}. "
        + "Refusing to start the watcher.",
      );
      return;
    }
    if (!hostCfg || typeof hostCfg !== "object") {
      log.error(
        "api.config is unavailable — cannot resolve session routing. "
        + "Refusing to start the watcher.",
      );
      return;
    }

    // Resolve targets. Precedence:
    //   1. Explicit `pluginCfg.targets` (advanced override).
    //   2. Auto-discovery from the global OpenClaw config's
    //      `channels.telegram.accounts` map — each account becomes a target
    //      named after the account, routing to `telegram:<account>`.
    //   3. Legacy fallback: a single `default` target with warn log.
    const targets = resolveTargets({
      pluginCfg,
      openclawGlobalCfg: hostCfg,
      log,
    });
    const agentId = pluginCfg.agentId ?? DEFAULT_AGENT_ID;

    // Load the compat dispatch primitive. We MUST have this — enqueueSystemEvent
    // doesn't trigger a turn (see module-level comment).
    let stopWatcher = () => {};
    loadDispatchRuntime(log)
      .then(({ dispatchInboundReplyWithBase }) => {
        const inboxRoot = pluginCfg.inboxRoot
          ?? pluginCfg.inboxDir // legacy field name, v2.0.x
          ?? join(homedir(), ".agent-bridge", "inbox");
        const pollIntervalMs = pluginCfg.pollIntervalMs;

        log.info(
          `dispatch mode: agentId="${agentId}", inboxRoot=${inboxRoot}, targets=[${Object.keys(targets).join(", ")}]`,
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
            const rawContent = String(msg.content ?? "");

            // Resolve replyVia mode. Precedence:
            //   1. Per-message `msg.replyVia` (sender-controlled override).
            //   2. Per-target `target.config.replyVia`.
            //   3. Plugin-level `pluginCfg.replyVia`.
            //   4. Sender-derived default: if `msg.fromTarget` is present the
            //      inbound hop was via agent-bridge (outbound senders stamp
            //      it as e.g. "claude-code" or "openclaw/<acct>"), so mirror
            //      the arrival channel and reply back over agent-bridge.
            //      Otherwise assume the message arrived via Telegram (or
            //      platform default) and reply via Telegram. This gives
            //      "reply on the channel it came in on" semantics with no
            //      config required.
            //   5. Absolute fallback: "telegram" (unreachable as a literal —
            //      senderDerived already covers both branches — but kept
            //      inside normalizeReplyVia for unknown-value coercion).
            const senderDerived = msg.fromTarget ? "agent-bridge" : "telegram";
            const replyVia = normalizeReplyVia(
              msg.replyVia
                ?? target.config.replyVia
                ?? pluginCfg.replyVia
                ?? senderDerived,
              log,
              target.name,
            );

            const account = target.config.account ?? target.name;
            const telegramPeerId = target.config.peer_id;

            // Legacy: targets flagged as legacy_session bypass session
            // injection and rely purely on the native agent-bridge channel.
            // Register reply target and return early.
            if (target.config.legacy_session) {
              const sessionKey = `${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`;
              registerReplyTarget(replyTargets, {
                sessionKey,
                fromMachine,
                incoming: msg,
                target,
              });
              log.warn(
                `inbound ${msg.id} from ${fromMachine} target=${target.name} `
                + `is legacy_session — no session injection performed. `
                + `Configure a real openclaw_channel + peer_id to enable dispatch.`,
              );
              return;
            }

            // Figure out the targetChannel + peer identity to inject as.
            //   telegram mode:    channel=telegram, peer=<Ethan's telegram id>
            //   agent-bridge mode: channel=agent-bridge, peer=<sender machine>
            let targetChannel;
            let peerId;
            if (replyVia === "agent-bridge") {
              targetChannel = AGENT_BRIDGE_CHANNEL_ID; // "agent-bridge"
              peerId = String(fromMachine);
              if (!peerId || peerId === "unknown") {
                throw new Error(
                  `replyVia=agent-bridge target="${target.name}": cannot resolve sender machine from msg.from — refusing to dispatch`,
                );
              }
            } else {
              targetChannel = target.config.openclaw_channel ?? "telegram";
              peerId = telegramPeerId;
              if (!peerId) {
                throw new Error(
                  `target "${target.name}" has no peer_id — cannot resolve session`,
                );
              }
            }

            // Resolve the canonical agent route. This uses the SDK's
            // dmScope-aware session-key builder (session-key-CbP51u9x.js:175),
            // so we don't need to hand-build the key.
            //
            // In agent-bridge mode the `accountId` parameter is our native
            // channel's implicit "default" account (see channel-plugin.js ::
            // DEFAULT_ACCOUNT_ID), not the OpenClaw target name.
            const routeAccountId =
              replyVia === "agent-bridge" ? "default" : account;
            const route = runtime.channel.routing.resolveAgentRoute({
              cfg: hostCfg,
              channel: targetChannel,
              accountId: routeAccountId,
              peer: {
                kind: "direct",
                id: String(peerId),
              },
            });

            const storePath = runtime.channel.session.resolveStorePath(
              hostCfg?.session?.store,
              { agentId: route.agentId },
            );

            // Build the synthetic inbound ctxPayload. Provider/Surface and
            // OriginatingChannel/OriginatingTo steer the reply back through
            // the chosen outbound (Telegram's or our native agent-bridge
            // channel's) — same mechanism either way, just different
            // targetChannel.
            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
              Body: body,
              RawBody: rawContent,
              CommandBody: rawContent,
              From: `${targetChannel}:${peerId}`,
              To: `${targetChannel}:${peerId}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct",
              ConversationLabel: String(fromMachine ?? "agent-bridge"),
              SenderId: String(peerId),
              SenderName: String(fromMachine ?? "agent-bridge"),
              Provider: targetChannel,
              Surface: targetChannel,
              MessageSid: msg.id,
              Timestamp: msg.timestamp
                ? (Number.isFinite(Number(msg.timestamp))
                  ? Number(msg.timestamp)
                  : Date.parse(msg.timestamp) || Date.now())
                : Date.now(),
              OriginatingChannel: targetChannel,
              OriginatingTo: `${targetChannel}:${peerId}`,
              // CommandAuthorized defaults via finalizeInboundContext; bridge
              // content is untrusted, so we don't flip it on.
            });

            // Track reply target so the outbound adapters can route correctly:
            //  - In telegram mode, our native agent-bridge channel is NOT on
            //    the outbound path; this map entry is a belt-and-braces hint
            //    in case the agent replies via our channel tool by hand.
            //  - In agent-bridge mode, our channel-plugin.js :: sendText
            //    consults this map (via ctx.threadId/accountId/to hints) to
            //    resolve `fromMachine` for the SCP destination. The key
            //    MUST include the sessionKey AND the sender machine, which
            //    registerReplyTarget already does.
            registerReplyTarget(replyTargets, {
              sessionKey: route.sessionKey,
              fromMachine,
              incoming: msg,
              target,
              ownTarget: `openclaw/${target.name}`,
            });

            log.info(
              `about to dispatch ${msg.id} from ${fromMachine} target=${target.name} replyVia=${replyVia} `
              + `route.sessionKey=${route.sessionKey} channel=${targetChannel} accountId=${route.accountId}`,
            );

            try {
              await dispatchInboundReplyWithBase({
                cfg: hostCfg,
                channel: targetChannel,
                accountId: route.accountId,
                route,
                storePath,
                ctxPayload,
                core: runtime,
                deliver: async (payload) => {
                  // For targetChannel="telegram" we delegate to the live
                  // telegram outbound registered on the host. For
                  // targetChannel="agent-bridge" we delegate to our own
                  // registered channel's sendText (channel-plugin.js), which
                  // SCPs a BridgeMessage back to the sender machine. Either
                  // way it goes through runtime.channel.outbound.loadAdapter.
                  const deliverFn = resolveProviderDeliver({
                    runtime,
                    targetChannel,
                  });
                  if (!deliverFn) {
                    throw new Error(
                      `no outbound delivery function for channel="${targetChannel}" on this host`,
                    );
                  }
                  const text = payload?.text ?? "";
                  if (!text.trim()) return;
                  await deliverFn({
                    // For telegram, `peerId` is the numeric Telegram user id.
                    // For agent-bridge, `peerId` is the sender machine name,
                    // which is exactly what channel-plugin.js :: sendText
                    // expects on ctx.to.
                    to: String(peerId),
                    text,
                    cfg: hostCfg,
                    accountId: route.accountId,
                    replyToId: payload?.replyToId,
                  });
                },
                onRecordError: (err) => {
                  log.error(
                    `dispatch ${msg.id}: recordInboundSession failed sessionKey=${route.sessionKey}: `
                    + `${err?.message ?? err} — stack: ${err?.stack ?? "(no stack)"}`,
                  );
                },
                onDispatchError: (err, info) => {
                  log.error(
                    `dispatch ${msg.id}: ${info?.kind ?? "reply"} failed sessionKey=${route.sessionKey}: `
                    + `${err?.message ?? err} — stack: ${err?.stack ?? "(no stack)"}`,
                  );
                },
              });
            } catch (err) {
              log.error(
                `dispatchInboundReplyWithBase threw for ${msg.id} sessionKey=${route.sessionKey} `
                + `target=${target.name}: ${err?.message ?? err} — `
                + `stack: ${err?.stack ?? "(no stack)"}`,
              );
              throw err;
            }

            log.info(
              `dispatched ${msg.id} from ${fromMachine} target=${target.name} sessionKey=${route.sessionKey}`,
            );
          },
        });
      })
      .catch((err) => {
        log.error(
          `failed to load plugin-sdk dispatch primitives: ${err?.stack || err}`,
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
 * Register reply-target hints for the outbound SCP path. Keyed by a few
 * plausible lookup shapes so the outbound adapter can find the origin
 * machine regardless of which ctx field the host passes through.
 */
function registerReplyTarget(replyTargets, { sessionKey, fromMachine, incoming, target, ownTarget }) {
  const hit = { fromMachine, incoming, ownTarget };
  if (sessionKey) replyTargets.set(sessionKey, hit);
  if (fromMachine) replyTargets.set(String(fromMachine), hit);
  if (fromMachine) {
    replyTargets.set(`${AGENT_BRIDGE_CHANNEL_ID}:${fromMachine}`, hit);
  }
  if (target?.name) replyTargets.set(target.name, hit);
}

/**
 * Resolve the provider-specific outbound delivery function for the given
 * channel. Returns a uniform `async (args) => Promise<void>` or null.
 *
 * Two strategies, tried in order:
 *
 * 1. **2026.4.15+ generic path.** `runtime.channel.outbound.loadAdapter(
 *    channelId)` returns a `ChannelOutboundAdapter` whose `sendText(ctx)`
 *    we invoke. Same adapter the dispatcher uses internally for cross-
 *    channel `routeReply`. Works for any registered provider channel.
 * 2. **≤ 2026.4.14 provider-namespaced path.** Earlier SDKs exposed
 *    per-provider functions like `runtime.channel.telegram.sendMessageTelegram`
 *    directly. Fall back to that if `outbound.loadAdapter` isn't there.
 *
 * Args: `{ to, text, cfg, accountId, replyToId }`.
 */
function resolveProviderDeliver({ runtime, targetChannel }) {
  // Strategy 1: 2026.4.15+ generic adapter loader.
  const loadAdapter = runtime?.channel?.outbound?.loadAdapter;
  if (typeof loadAdapter === "function") {
    return async ({ to, text, cfg, accountId, replyToId }) => {
      const adapter = await loadAdapter(targetChannel);
      if (!adapter || typeof adapter.sendText !== "function") {
        throw new Error(
          `channel.outbound.loadAdapter("${targetChannel}") returned no sendText adapter`,
        );
      }
      await adapter.sendText({
        cfg,
        to: String(to),
        text,
        accountId: accountId ?? null,
        replyToId: replyToId ?? null,
      });
    };
  }

  // Strategy 2: legacy per-provider function.
  if (targetChannel === "telegram") {
    const sendMessageTelegram = runtime?.channel?.telegram?.sendMessageTelegram;
    if (typeof sendMessageTelegram === "function") {
      return async ({ to, text, cfg, accountId, replyToId }) => {
        await sendMessageTelegram(String(to), text, {
          cfg,
          accountId,
          replyToMessageId: replyToId ? Number(replyToId) || undefined : undefined,
        });
      };
    }
  }
  // Future: discord/slack/signal/whatsapp legacy fields — only if we ever
  // need to support a host that old.
  return null;
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
    // Allow agent-bridge replyVia to skip the peer_id requirement — peer
    // identity comes from the sender machine at message time, not from
    // config. Telegram replyVia (the default) still needs a peer_id so the
    // Telegram outbound knows which chat to answer in.
    const targetReplyVia = cfg.replyVia ?? pluginCfg.replyVia ?? "telegram";
    const peerId = cfg.peer_id ?? pluginPeerId ?? null;
    if (!peerId && targetReplyVia !== "agent-bridge") {
      log.warn(
        `target "${name}" missing peer_id (and no plugin-level fallback `
        + `pluginConfig.peer_id is set) — skipping. Either add peer_id or set replyVia="agent-bridge".`,
      );
      continue;
    }
    out[name] = {
      openclaw_channel: cfg.openclaw_channel ?? "telegram",
      account: cfg.account ?? name,
      peer_id: peerId,
      agent_id: cfg.agent_id ?? null,
      replyVia: cfg.replyVia ?? null,
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
    const firstAllowChatId = firstNumericAllowEntry(allowFrom);
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
      // Auto-discovered targets inherit the plugin-level replyVia default
      // (which falls back to "telegram" at the onMessage boundary). We
      // don't attempt per-account replyVia discovery — OpenClaw's Telegram
      // account config doesn't have a natural place for that, and if Ethan
      // wants per-account back-channel routing he can switch to an
      // explicit `targets` map.
      replyVia: null,
      auto_discovered: true,
    };
  }
  return out;
}

/**
 * Coerce a replyVia value to a known mode. Unknown values fall back to
 * "telegram" with a warn log so misconfigurations don't silently reroute.
 */
function normalizeReplyVia(raw, log, targetName) {
  if (raw == null) return "telegram";
  const v = String(raw).toLowerCase().trim();
  if (v === "telegram" || v === "agent-bridge") return v;
  log?.warn?.(
    `replyVia="${raw}" on target "${targetName}" is not a known mode — `
    + `falling back to "telegram". Valid values: "telegram", "agent-bridge".`,
  );
  return "telegram";
}

/**
 * allowFrom entries can be strings like "telegram:6164541473" or bare
 * numerics. Pull the first one that's usable as a numeric Telegram id.
 */
function firstNumericAllowEntry(allowFrom) {
  for (const raw of allowFrom) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    // Strip a "telegram:" / "tg:" prefix if present.
    const stripped = s.replace(/^telegram:/i, "").replace(/^tg:/i, "");
    if (/^-?\d+$/.test(stripped)) return stripped;
  }
  return null;
}

function isValidTargetName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
  );
}

/**
 * Dynamically import the plugin-sdk dispatch primitives. Same resolver
 * strategy as v2.1.x loadSystemEvents — try bare `openclaw/plugin-sdk/...`
 * ESM first, then walk upwards from the openclaw CLI entry to find a
 * node_modules root we can `createRequire` from.
 *
 * Returns `{ dispatchInboundReplyWithBase, recordInboundSessionAndDispatchReply }`.
 */
async function loadDispatchRuntime(log) {
  // On openclaw 2026.4.15+ `plugin-sdk/compat` no longer re-exports the
  // dispatch primitives (OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning +
  // functions removed from the re-export list). Use the focused subpath
  // `plugin-sdk/inbound-reply-dispatch` first, then fall back to `compat`
  // for older hosts (2026.3.x) that still re-export through it.
  const subpaths = [
    "plugin-sdk/inbound-reply-dispatch", // new canonical (2026.4.15+)
    "plugin-sdk/compat",                 // legacy fallback (≤ 2026.4.14)
  ];
  const errors = [];

  const mergeExports = (mod) => ({
    dispatchInboundReplyWithBase: mod.dispatchInboundReplyWithBase,
    recordInboundSessionAndDispatchReply: mod.recordInboundSessionAndDispatchReply,
  });

  const isValid = (mod) =>
    typeof mod?.dispatchInboundReplyWithBase === "function";

  // Strategy 1: direct `openclaw/...` ESM import.
  for (const sub of subpaths) {
    const spec = `openclaw/${sub}`;
    try {
      const mod = await import(spec);
      if (isValid(mod)) return mergeExports(mod);
      errors.push(`${spec}: loaded but missing dispatchInboundReplyWithBase`);
    } catch (err) {
      errors.push(`${spec}: ${err?.message || err}`);
    }
  }

  // Strategy 2: resolve via the host's own node_modules. Walk up from the
  // openclaw CLI entry.
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
                if (isValid(mod)) return mergeExports(mod);
                errors.push(`resolved ${modPath}: missing dispatchInboundReplyWithBase`);
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
    `unable to load plugin-sdk dispatch primitives (dispatchInboundReplyWithBase): ${errors.join("; ")}`,
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
