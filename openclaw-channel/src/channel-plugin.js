/**
 * Minimal ChannelPlugin shape for the "agent-bridge" channel.
 *
 * We build this as a plain object (JS, no TS) so we can be loaded via the
 * OpenClawPluginApi.registerChannel() path without any build step.
 *
 * The goal is to register as a native channel with enough surface that the
 * host's channel registry accepts us, while keeping the real behaviour in
 * our own inbox-watcher + outbound SCP pipeline.
 *
 * Key pieces of the ChannelPlugin contract we satisfy:
 *   - id, meta          : identity + docs metadata
 *   - capabilities      : advertised chat types (direct)
 *   - config            : account resolver (we treat the config block as one
 *                         implicit "default" account)
 *   - setup             : applyAccountConfig (no-op for us — config is owned
 *                         by the top-level channels.agent-bridge block, not
 *                         per-account)
 *   - outbound          : direct-delivery sendText that SCPs a BridgeMessage
 *                         back to the sender machine
 *
 * Everything else (security, groups, pairing, doctor, status) is intentionally
 * omitted. Channels are allowed to ship without those surfaces — the host
 * treats them as "no-op adapter available" and uses its defaults.
 */

import { deliverReply, localMachineName } from "./outbound.js";
import { buildReply } from "./envelope.js";

const CHANNEL_ID = "agent-bridge";
const DEFAULT_ACCOUNT_ID = "default";

/**
 * Build the ChannelPlugin. The returned object is passed straight to
 * api.registerChannel(plugin).
 *
 * @param {object} opts
 * @param {object} opts.logger
 * @param {() => Map<string, {fromMachine: string}>} opts.getReplyTargets
 *   Lookup for which machine to SCP a reply to, keyed by sessionKey.
 *   Populated by index.js when an inbound message is injected.
 * @param {() => object} [opts.getPluginConfig]
 */
export function createAgentBridgeChannelPlugin(opts) {
  const log = opts.logger;
  const getReplyTargets = opts.getReplyTargets;
  const getPluginConfig = opts.getPluginConfig ?? (() => ({}));

  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Agent Bridge",
      selectionLabel: "Agent Bridge (cross-machine)",
      docsPath: "/channels/agent-bridge",
      docsLabel: "agent-bridge",
      blurb:
        "Cross-machine agent-to-agent messaging over SSH. Talk to the running agent on a paired machine.",
      order: 900,
      aliases: ["bridge"],
      systemImage: "link.circle",
      markdownCapable: true,
      exposure: { configured: true, setup: false, docs: true },
      showConfigured: true,
      showInSetup: false,
    },
    capabilities: {
      chatTypes: ["direct"],
      reactions: false,
      reply: true,
      threads: false,
      media: false,
      nativeCommands: false,
      groupManagement: false,
    },
    reload: {
      configPrefixes: [`channels.${CHANNEL_ID}`, `plugins.entries.${CHANNEL_ID}`],
    },

    config: {
      listAccountIds(_cfg) {
        return [DEFAULT_ACCOUNT_ID];
      },
      resolveAccount(_cfg, accountId) {
        return {
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          enabled: true,
        };
      },
      defaultAccountId() {
        return DEFAULT_ACCOUNT_ID;
      },
      isEnabled(account) {
        return account?.enabled !== false;
      },
      isConfigured() {
        return true;
      },
      describeAccount(account) {
        return {
          accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
          enabled: true,
          configured: true,
          linked: true,
        };
      },
    },

    /**
     * Required adapter. We don't expose a setup wizard flow — the channel is
     * implicitly configured by the agent-bridge CLI `pair` command, which
     * writes ~/.agent-bridge/config.
     */
    setup: {
      applyAccountConfig({ cfg }) {
        // No-op: per-account config is owned by agent-bridge config, not openclaw.json.
        return cfg;
      },
      resolveAccountId({ accountId }) {
        return accountId ?? DEFAULT_ACCOUNT_ID;
      },
    },

    outbound: {
      deliveryMode: "direct",
      async sendText(ctx) {
        // ctx.to is the outbound target. For us, this is expected to be the
        // machine name of the paired peer (e.g. "Ethans-MacBook-Pro"). When
        // the current reply is an in-turn response to an earlier inbound
        // message we prefer the fromMachine we captured on inbound (via
        // ctx.accountId/threadId -> getReplyTargets).
        const target = resolveOutboundTarget(ctx, getReplyTargets);
        if (!target) {
          throw new Error(
            `agent-bridge outbound: cannot resolve target machine for to="${ctx.to}"`,
          );
        }
        const msg = buildReply({
          fromMachine: localMachineName(),
          toMachine: target,
          replyToId: ctx.replyToId ?? null,
          content: ctx.text ?? "",
        });
        const pluginCfg = getPluginConfig() ?? {};
        await deliverReply({
          message: msg,
          toMachine: target,
          keysDir: pluginCfg.keysDir,
          logger: log,
        });
        return {
          channel: CHANNEL_ID,
          to: target,
          messageId: msg.id,
        };
      },
    },
  };
}

function resolveOutboundTarget(ctx, getReplyTargets) {
  // Prefer the captured fromMachine we stashed for this session.
  const targets = getReplyTargets?.();
  if (targets) {
    const sessionHints = [ctx.threadId, ctx.accountId, ctx.to]
      .filter((v) => v != null)
      .map((v) => String(v));
    for (const hint of sessionHints) {
      const hit = targets.get(hint);
      if (hit?.fromMachine) return hit.fromMachine;
    }
  }
  // Fallback: treat ctx.to as the machine name directly (bridge messages
  // often encode that explicitly).
  if (typeof ctx.to === "string" && ctx.to.trim()) {
    return ctx.to.trim();
  }
  return null;
}

export const AGENT_BRIDGE_CHANNEL_ID = CHANNEL_ID;
