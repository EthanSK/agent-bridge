/**
 * Minimal ChannelPlugin shape for the "agent-bridge" channel.
 *
 * We build this as a plain object (JS, no TS) so we can be loaded via the
 * OpenClawPluginApi.registerChannel() path without any build step.
 *
 * The goal is to register as a native channel with enough surface that the
 * host's channel registry accepts us, while keeping the real behaviour in
 * our own inbox-watcher + outbound SFTP pipeline.
 *
 * Key pieces of the ChannelPlugin contract we satisfy:
 *   - id, meta          : identity + docs metadata
 *   - capabilities      : advertised chat types (direct)
 *   - config            : account resolver (we treat the config block as one
 *                         implicit "default" account)
 *   - setup             : applyAccountConfig (no-op for us — config is owned
 *                         by the top-level channels.agent-bridge block, not
 *                         per-account)
 *   - gateway/status    : keep a passive runtime alive so OpenClaw marks the
 *                         account as running instead of repeatedly restarting
 *                         it as "stopped"
 *   - outbound          : direct-delivery sendText that SFTP-delivers a BridgeMessage
 *                         back to the sender machine
 */

import { deliverReply, localMachineName } from "./outbound.js";
import { buildReply } from "./envelope.js";
import { decodeBridgePeerId, normalizeBridgePeerId } from "./bridge-peer.js";

const CHANNEL_ID = "agent-bridge";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_RUNTIME = {
  accountId: DEFAULT_ACCOUNT_ID,
  running: false,
  connected: false,
  lastConnectedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
};

function waitUntilAbort(signal) {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Build the ChannelPlugin. The returned object is passed straight to
 * api.registerChannel(plugin).
 *
 * @param {object} opts
 * @param {object} opts.logger
 * @param {() => Map<string, {fromMachine: string}>} opts.getReplyTargets
 *   Lookup for which machine to SFTP-deliver a reply to, keyed by sessionKey.
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

    gateway: {
      async startAccount(ctx) {
        const accountId = ctx.accountId ?? ctx.account?.accountId ?? DEFAULT_ACCOUNT_ID;
        const now = Date.now();
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId,
          running: true,
          connected: true,
          lastConnectedAt: now,
          lastEventAt: now,
          lastError: null,
        });
        log?.info?.(`[${accountId}] agent-bridge channel runtime marked ready`);
        try {
          await waitUntilAbort(ctx.abortSignal);
        } finally {
          ctx.setStatus({
            ...ctx.getStatus(),
            accountId,
            running: false,
            connected: false,
            lastStopAt: Date.now(),
          });
        }
      },
    },

    status: {
      defaultRuntime: { ...DEFAULT_RUNTIME },
      skipStaleSocketHealthCheck: true,
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastError: snapshot.lastError ?? null,
      }),
      buildAccountSnapshot: ({ account, runtime }) => ({
        accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
        enabled: account?.enabled !== false,
        configured: true,
        linked: true,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastError: runtime?.lastError ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      }),
    },

    outbound: {
      deliveryMode: "direct",
      async sendText(ctx) {
        // ctx.to is either a legacy machine name or an encoded agent-bridge
        // peer id containing both the sender machine and the sender's
        // `fromTarget`. The encoded form is authoritative because it is
        // persisted in OpenClaw's session route and survives gateway restarts.
        const hit = resolveOutboundTarget(ctx, getReplyTargets);
        const toMachine = hit?.fromMachine;
        const returnTarget = hit?.returnTarget ?? hit?.incoming?.fromTarget;
        if (!toMachine) {
          throw new Error(
            `agent-bridge outbound: cannot resolve target machine for to="${ctx.to}"`,
          );
        }
        if (!returnTarget) {
          throw new Error(
            `agent-bridge outbound: cannot resolve return target for to="${ctx.to}". `
            + `Inbound bridge messages must carry fromTarget (for example "claude-code" or "openclaw/default").`,
          );
        }
        const pluginCfg = getPluginConfig() ?? {};
        const accountId =
          typeof ctx.accountId === "string" ? ctx.accountId.trim() : "";
        const ownTarget =
          hit?.ownTarget ??
          (accountId ? `openclaw/${accountId}` : undefined);
        const msg = buildReply({
          fromMachine: localMachineName(),
          toMachine,
          replyToId: ctx.replyToId ?? hit?.replyToId ?? hit?.incoming?.id ?? null,
          content: ctx.text ?? "",
          target: returnTarget,
          incoming: hit?.incoming,
          ownTarget,
        });
        await deliverReply({
          message: msg,
          toMachine,
          keysDir: pluginCfg.keysDir,
          logger: log,
        });
        return {
          channel: CHANNEL_ID,
          to: toMachine,
          messageId: msg.id,
        };
      },
    },
  };
}

function resolveOutboundTarget(ctx, getReplyTargets) {
  // Prefer the captured fromMachine we stashed for this session. We return
  // the WHOLE hit object (not just fromMachine) so the caller can read the
  // captured incoming BridgeMessage and the OpenClaw target's own ID for
  // round-trip routing (refinement 3 — 2026-04-20).
  const targets = getReplyTargets?.();
  const accountId =
    typeof ctx.accountId === "string" ? ctx.accountId.trim() : "";
  const normalizedTo = normalizeBridgePeerId(ctx.to);
  const decodedTo = decodeBridgePeerId(normalizedTo);
  const mergeHit = (hit) => {
    if (!hit && !decodedTo?.fromMachine) return null;
    const hitReturnTarget = hit?.returnTarget ?? hit?.incoming?.fromTarget ?? null;
    const decodedConflictsWithHit =
      Boolean(decodedTo?.encoded && hit) &&
      (
        (hit?.fromMachine && hit.fromMachine !== decodedTo.fromMachine) ||
        (hitReturnTarget && hitReturnTarget !== decodedTo.returnTarget)
      );
    const effectiveHit = decodedConflictsWithHit ? null : hit;
    return {
      ...(effectiveHit ?? {}),
      fromMachine: decodedTo?.fromMachine ?? effectiveHit?.fromMachine,
      returnTarget:
        decodedTo?.returnTarget ??
        effectiveHit?.returnTarget ??
        effectiveHit?.incoming?.fromTarget ??
        null,
      replyToId: effectiveHit?.replyToId ?? effectiveHit?.incoming?.id ?? null,
      ownTarget:
        effectiveHit?.ownTarget ??
        (accountId ? `openclaw/${accountId}` : undefined),
    };
  };

  if (targets) {
    const machineTargetHint =
      decodedTo?.fromMachine && decodedTo?.returnTarget
        ? `${decodedTo.fromMachine}|${decodedTo.returnTarget}`
        : null;
    const sessionHints = [ctx.threadId, ctx.to, normalizedTo, machineTargetHint, ctx.accountId]
      .filter((v) => v != null)
      .map((v) => String(v));
    for (const hint of sessionHints) {
      const hit = targets.get(hint);
      if (hit?.fromMachine) return mergeHit(hit);
    }
    if (accountId) {
      const hit = targets.get(accountId);
      if (hit?.fromMachine) return mergeHit(hit);
      const ownTarget = `openclaw/${accountId}`;
      for (const candidate of targets.values()) {
        if (candidate?.fromMachine && candidate.ownTarget === ownTarget) {
          return mergeHit(candidate);
        }
      }
    }
  }

  return mergeHit(null);
}

export const AGENT_BRIDGE_CHANNEL_ID = CHANNEL_ID;
export const __testing = {
  resolveOutboundTarget,
};
