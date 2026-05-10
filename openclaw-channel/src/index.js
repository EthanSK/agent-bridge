/**
 * OpenClaw plugin entry point for @agent-bridge/openclaw-channel.
 *
 * Agent-driven reply routing (v3.0 of openclaw-channel — 2026-05-04)
 * -------------------------------------------------------------------
 * **Architectural pivot:** the plugin no longer auto-fans-out the agent's
 * reply across multiple OUTBOUND channels. Instead it:
 *
 *   1. Surfaces the inbound bridge message to the OC agent inside the
 *      session bound to the user-facing channel (typically Telegram). The
 *      synthetic ctxPayload's body includes a structured BRIDGE-CONTEXT
 *      block listing `from_target`, the recommended bridge-reply target,
 *      the configured user-facing channel, and the additionalReplyChannels
 *      hint.
 *   2. Runs ONE agent turn via `dispatchInboundReplyWithBase`. The agent's
 *      natural turn output flows through the primary session-bound outbound
 *      adapter — i.e. straight into the configured Telegram chat the user
 *      reads. No `deliver` fan-out anymore.
 *   3. Trusts the agent to reply to the originating bridge peer EXPLICITLY
 *      via the `bridge_send_message` MCP tool, using the `from_target` we
 *      surfaced. The agent decides whether to also send a `telegram_reply`
 *      (or whatever user-facing reply tool the harness exposes), based on
 *      the `additionalReplyChannels` hint.
 *
 * This unifies the OC behavior with the Claude Code channel: both surface
 * inbound messages to the running agent and let the agent's tool calls drive
 * the actual reply legs. No more harness-specific auto-routing logic.
 *
 * Config (per-target OR plugin-level):
 *
 *   `additionalReplyChannels: ["telegram"]`
 *     Hint to the agent about which user-facing channel(s) it should ALSO
 *     send a reply through, in addition to the implicit bridge reply to
 *     `from_target`. Default: `["telegram"]` for any target whose
 *     `openclaw_channel` is `"telegram"` (i.e. the user already has Telegram
 *     wired up to that account); `[]` for headless targets. The plugin does
 *     NOT mechanically fan out the reply — it ONLY tells the agent in the
 *     prompt-context which user-facing channels are configured. The agent
 *     remains in control.
 *
 *   `additionalReplyChannels: []`
 *     Quiet mode. Inbound bridge turn surfaces fromTarget but no
 *     user-facing channel is suggested.
 *
 *   `additionalReplyChannels: ["telegram", "discord"]`
 *     The agent sees both as suggested user-facing legs. It can call each
 *     channel's reply tool independently if those tools are registered.
 *
 * Bridge reply to `from_target` is IMPLICIT and ALWAYS expected when the
 * inbound carries `from_target`. The agent is reminded of this in the
 * prompt-context — and the `agent-bridge` channel-plugin outbound adapter
 * (channel-plugin.js :: sendText) is still wired up so explicit
 * `bridge_send_message` tool calls can SFTP-deliver replies back.
 *
 * Migration from `replyVia` (≤ v2.4.x):
 *   - `replyVia: "agent-bridge"` configs trigger a deprecation warning at
 *     load time. The plugin no longer interprets the field. Migrate by
 *     deleting the `replyVia` key. The agent now decides at turn time
 *     whether to reply over the bridge (via `bridge_send_message`) and/or
 *     Telegram (natural turn output / `telegram_reply` tool).
 *   - `replyVia: "telegram"` was the visible-on-phone default — that's
 *     STILL the default behavior (the synthetic turn injects into the
 *     Telegram session), so the only change is the deprecation warning.
 *   - Per-target / plugin-level / per-message `replyVia` are all warned-on
 *     and ignored. Clear the field at your convenience.
 *
 * For the architecture motivation see Ethan's spec voice 2096 (2026-05-04):
 *   "I want them to behave identically. Agents should choose where the
 *    reply goes, not the routing layer."
 *
 * Historical notes (kept for context):
 *   v2.4.x — multi-channel `replyVia` array + implicit bridge fallback.
 *   v2.3.x — `replyVia: "telegram" | "agent-bridge"` per-target/plugin/message.
 *   v2.2.0 — switched to `dispatchInboundReplyWithBase` (the same dispatch
 *            primitive native IRC and Nextcloud Talk channels use).
 *   v2.1.0 — per-target inbox subdirs + auto-discovery from telegram accounts.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeLogger } from "./log.js";
import { startInboxWatcher } from "./inbox-watcher.js";
import {
  createAgentBridgeChannelPlugin,
  AGENT_BRIDGE_CHANNEL_ID,
} from "./channel-plugin.js";
import { localMachineName } from "./outbound.js";
import { encodeBridgePeerId } from "./bridge-peer.js";
import {
  formatRelayNotice,
  formatRelayScaffold,
  relayNoticeEnabled,
} from "./relay-notice.js";
import { storeRelayExpandMessage } from "./relay-expand-store.js";
import { emitLifecycleEvent, ensureService as ensureChimeService } from "../../chime/emitter.mjs";

const PLUGIN_ID = "agent-bridge";
const PLUGIN_NAME = "Agent Bridge (Channel v3 — agent-driven routing)";
const DEFAULT_AGENT_ID = "main";
const PROCESS_STATE_KEY = Symbol.for("agent-bridge.openclaw-channel.process-state");

// Channels we know how to surface as a user-facing reply hint. Extend this
// list as new harness reply tools are added. The list is purely informational
// for the prompt-context block — actually delivering on the reply is the
// agent's job.
const KNOWN_USER_FACING_CHANNELS = new Set(["telegram", "slack", "discord", "imessage"]);

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "First-class OpenClaw channel for cross-machine agent-to-agent messaging over SSH. v3.0 surfaces inbound bridge messages to the running OC agent and lets it decide which reply tools to call (bridge_send_message for the implicit bridge leg, telegram_reply / etc. for additional user-facing legs).",

  register(api) {
    const log = makeLogger(api?.logger);
    const pluginCfg = api?.pluginConfig ?? {};

    if (pluginCfg.enabled === false) {
      log.info("disabled via pluginConfig.enabled=false");
      return;
    }

    // Surface a deprecation warning if any legacy `replyVia` config is still
    // present. Don't abort — just log so existing deployments keep working
    // through the migration window.
    warnOnLegacyReplyVia(pluginCfg, log);

    // Short-lived CLI contexts (help, inspect, list, `gateway status`, etc.)
    // also load plugins. Only start the inbox watcher for the long-lived
    // gateway daemon itself; otherwise ad-hoc CLI processes can briefly start
    // competing watchers and race the real gateway over inbox files.
    const argvTail = process.argv.slice(2);
    const gatewaySubcommand = argvTail[0] === "gateway";
    const gatewayControlTokens = new Set([
      "status",
      "start",
      "stop",
      "restart",
      "help",
      "doctor",
      "--help",
      "-h",
    ]);
    const gatewayLooksLikeControlCommand = gatewaySubcommand
      && argvTail.slice(1).some((arg) => gatewayControlTokens.has(String(arg)));
    const isGateway =
      process.env.OPENCLAW_ROLE === "gateway"
      || argvTail[0] === "gateway-run"
      || (gatewaySubcommand && !gatewayLooksLikeControlCommand);

    const regMode = api?.registrationMode;
    const isSetupOnly = regMode === "cli-metadata" || regMode === "setup-only";

    const processState = getProcessState();

    // Map of session-key-ish hint -> { fromMachine } so the outbound adapter
    // knows which machine to SFTP-deliver a reply to when the agent calls
    // `bridge_send_message` to reply through the native agent-bridge channel
    // (cross-harness flows). Even though we no longer auto-fan-out, we keep
    // the registry primed so the channel-plugin's outbound can resolve the
    // sender machine when the agent does call the tool.
    const replyTargets = processState.replyTargets;

    // Register the native channel FIRST — this is the primary v2 contract
    // for the cross-harness bridge case, and must happen regardless of
    // gateway vs CLI so the channel shows up in `openclaw channels list`.
    try {
      const channelPlugin = createAgentBridgeChannelPlugin({
        logger: log,
        getReplyTargets: () => replyTargets,
        getPluginConfig: () => pluginCfg,
        getAgentBridgeVersion: resolveAgentBridgeVersion,
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

    try {
      ensureChimeService();
    } catch (err) {
      log.warn(`failed to ensure chime service: ${err?.message ?? err}`);
    }

    try {
      api.on("subagent_spawning", async (event) => {
        emitLifecycleEvent({
          kind: "agent.start",
          sourceId: "openclaw-subagents",
          harness: "openclaw",
          agentId: event.childSessionKey,
          label: event.label ?? null,
        });
      });
      api.on("subagent_ended", async (event) => {
        if (!event?.targetSessionKey) return;
        emitLifecycleEvent({
          kind: "agent.end",
          sourceId: "openclaw-subagents",
          harness: "openclaw",
          agentId: event.targetSessionKey,
          label: null,
        });
      });
    } catch (err) {
      log.warn(`failed to register chime subagent hooks: ${err?.message ?? err}`);
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
    loadDispatchRuntime(log)
      .then(({ dispatchInboundReplyWithBase }) => {
        const inboxRoot = pluginCfg.inboxRoot
          ?? pluginCfg.inboxDir // legacy field name, v2.0.x
          ?? join(homedir(), ".agent-bridge", "inbox");
        const pollIntervalMs = pluginCfg.pollIntervalMs;

        log.info(
          `dispatch mode: agentId="${agentId}", inboxRoot=${inboxRoot}, targets=[${Object.keys(targets).join(", ")}]`,
        );

        startOrReuseWatcher({
          processState,
          agentId,
          inboxRoot,
          pollIntervalMs,
          targets,
          pluginCfg,
          log,
          start: () => startInboxWatcher({
          inboxRoot,
          pollIntervalMs,
          logger: log,
          targets,
          async onMessage(msg, ctx) {
            const target = ctx.target;
            const fromMachine = msg.from ?? "unknown";
            const rawContent = String(msg.content ?? "");

            // Resolve which user-facing channels the agent should ALSO send
            // a reply through. Returns a deduped, order-preserving array.
            // Empty array == quiet mode (only suggest the bridge reply).
            const additionalReplyChannels = resolveAdditionalReplyChannels({
              msg,
              target,
              pluginCfg,
              log,
            });

            const account = target.config.account ?? target.name;
            const telegramPeerId = target.config.peer_id;

            // [RELAY-SCAFFOLD-IN-OC 2026-05-09 — agent-bridge 4.3.0]
            // Pre-4.3.0 the OC plugin emitted the user-facing relay receipt
            // BEFORE the agent turn ran ("pre-flight" sendBridgeRelayNotice
            // → gateway-direct sendText to Telegram). That path produced a
            // structurally-correct receipt but had NO Summary blockquote
            // (the gateway has no LLM in the loop, and the formatter's
            // `summary` opt was never wired through), which Ethan flagged
            // as inconsistent with CC's agent-fill-Summary behavior.
            //
            // We now mirror CC's pattern: build the scaffold here, populate
            // the relay-expand store as before, then INJECT the scaffold
            // into the agent's session via `formatInboundBody` so the agent
            // fills `{{SUMMARY_PLACEHOLDER}}` and emits the completed relay
            // through its natural turn output to the primary channel
            // (Telegram when wired up). The agent now owns the entire
            // user-facing relay emission — single source of Summary
            // judgment across CC + OC.
            const relayCtx = prepareBridgeRelayContext({
              hostCfg,
              pluginCfg,
              target,
              msg,
              additionalReplyChannels,
              log,
            });

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

            // Pick the ONE primary session to inject the inbound message
            // into. This determines which conversation the agent reads it
            // in and which outbound the agent's natural turn output flows
            // through. We do NOT fan out — the agent calls reply tools
            // explicitly for any additional legs.
            //
            // Selection logic:
            //   - If "telegram" is in additionalReplyChannels AND the target
            //     has a Telegram peer_id wired up → primary = Telegram (so
            //     natural turn output goes to the user's phone).
            //   - Otherwise → primary = agent-bridge (silent peer-to-peer
            //     back-channel; agent's natural turn output SFTPs back to
            //     the originating bridge peer).
            let primary;
            try {
              primary = pickPrimaryChannel({
                msg,
                target,
                additionalReplyChannels,
                fromMachine,
                account,
                telegramPeerId,
                runtime,
                hostCfg,
              });
            } catch (err) {
              log.error(
                `pickPrimaryChannel failed for ${msg.id} target=${target.name}: ${err?.message ?? err}`,
              );
              throw err;
            }

            await dispatchAgentTurn({
              primary,
              msg,
              rawContent,
              fromMachine,
              account,
              target,
              additionalReplyChannels,
              relayCtx,
              runtime,
              hostCfg,
              replyTargets,
              dispatchInboundReplyWithBase,
              log,
            });
          },
          }),
        });
      })
      .catch((err) => {
        log.error(
          `failed to load plugin-sdk dispatch primitives: ${err?.stack || err}`,
        );
      });

    if (!processState.cleanupInstalled) {
      const disposeAll = () => {
        const activeState = getProcessState();
        try {
          activeState.watcherStop?.();
        } catch {
          /* ignore */
        }
        activeState.watcherStop = null;
        activeState.watcherSignature = null;
      };
      process.once("SIGTERM", disposeAll);
      process.once("SIGINT", disposeAll);
      process.once("beforeExit", disposeAll);
      processState.cleanupInstalled = true;
    }
  },
};

/**
 * Resolve the user-facing reply channels the agent should consider as
 * ADDITIONAL legs (on top of the implicit bridge reply to `from_target`).
 *
 * Returns a non-empty-or-empty deduped array of normalized channel names.
 * Empty array = "no user-facing leg suggested; agent only needs to bridge
 * back". Default policy when nothing is configured:
 *
 *   - Target has `openclaw_channel = "telegram"` → ["telegram"].
 *   - Otherwise → [].
 *
 * Precedence (highest first):
 *   1. Per-message `msg.additionalReplyChannels` (sender override; rare —
 *      think "this one debug message: no Telegram echo please").
 *   2. Per-target `target.config.additionalReplyChannels`.
 *   3. Plugin-level `pluginCfg.additionalReplyChannels`.
 *   4. Default policy (above).
 *
 * Each value is normalized through `normalizeUserFacingChannel`, which
 * lowercases / trims and validates against `KNOWN_USER_FACING_CHANNELS`.
 * Unknown values fall back to "telegram" with a warn log so misconfigs
 * don't silently silence the user-facing notification.
 *
 * Special string sentinels accepted at any precedence level:
 *   - `"none"` / `"silent"` → return [].
 *   - `"default"` → fall through to the next precedence level.
 */
function resolveAdditionalReplyChannels({ msg, target, pluginCfg, log }) {
  const layered = [
    msg?.additionalReplyChannels,
    target?.config?.additionalReplyChannels,
    pluginCfg?.additionalReplyChannels,
  ];

  for (const raw of layered) {
    const resolved = coerceAdditionalReplyChannelsLevel(raw, log, target?.name);
    if (resolved !== null) {
      return resolved;
    }
  }

  // Default policy: if the target's underlying outbound is Telegram, suggest
  // Telegram as the additional user-facing leg. Otherwise empty.
  const outboundChannel = target?.config?.openclaw_channel;
  if (outboundChannel === "telegram") {
    return ["telegram"];
  }
  return [];
}

/**
 * Coerce a single precedence-level value into a deduped, normalized array
 * (or null if "fall through to the next level"). Accepts:
 *
 *   - undefined / null  → null (fall through)
 *   - "default"         → null (fall through)
 *   - "none" / "silent" → [] (explicit quiet)
 *   - string            → [normalized]
 *   - array of strings  → normalized + deduped
 */
function coerceAdditionalReplyChannelsLevel(raw, log, targetName) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "default") return null;
    if (v === "none" || v === "silent" || v === "off") return [];
    return dedupeChannels([normalizeUserFacingChannel(v, log, targetName)]);
  }
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((v) => (v == null ? null : String(v).trim().toLowerCase()))
      .filter((v) => v != null && v !== "");
    if (cleaned.length === 0) return [];
    if (cleaned.some((v) => v === "default")) return null;
    if (cleaned.every((v) => v === "none" || v === "silent" || v === "off")) {
      return [];
    }
    return dedupeChannels(
      cleaned
        .filter((v) => v !== "none" && v !== "silent" && v !== "off")
        .map((v) => normalizeUserFacingChannel(v, log, targetName)),
    );
  }
  // Unknown shape — fall through to next level rather than crash.
  log?.warn?.(
    `additionalReplyChannels on target "${targetName}" has an unsupported shape `
    + `(${typeof raw}); ignoring this level and falling through.`,
  );
  return null;
}

function dedupeChannels(channels) {
  const seen = new Set();
  const out = [];
  for (const c of channels) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Pick the ONE primary session to inject the inbound message into. Returns
 * `{ targetChannel, peerId, returnTarget, route, storePath }`.
 *
 * The primary determines: (a) the conversation/session memory the agent
 * sees this message in, (b) where the agent's natural turn output flows.
 * The agent ALSO calls `bridge_send_message` to reply over the bridge —
 * that's the "implicit bridge reply" leg, independent of which session
 * we inject into.
 */
function pickPrimaryChannel({
  msg,
  target,
  additionalReplyChannels,
  fromMachine,
  account,
  telegramPeerId,
  runtime,
  hostCfg,
}) {
  const returnTarget =
    typeof msg.fromTarget === "string" && msg.fromTarget.trim()
      ? msg.fromTarget.trim()
      : "";

  // Prefer the target's bound user-facing channel (Telegram, Slack, Discord,
  // etc.) when:
  //   (a) `additionalReplyChannels` includes it (i.e. the agent should reply
  //       through it), AND
  //   (b) the target has a peer_id wired up so the outbound knows where to
  //       answer in.
  // Fall back to the silent agent-bridge back-channel otherwise.
  const targetUserChannel = target.config.openclaw_channel;
  const wantUserChannel =
    typeof targetUserChannel === "string" &&
    targetUserChannel !== AGENT_BRIDGE_CHANNEL_ID &&
    additionalReplyChannels.includes(targetUserChannel) &&
    Boolean(telegramPeerId); // `telegramPeerId` here is the target's peer_id (named legacy-style; semantically it's the per-channel peer id)

  let targetChannel;
  let peerId;
  if (wantUserChannel) {
    targetChannel = targetUserChannel;
    peerId = telegramPeerId;
  } else {
    targetChannel = AGENT_BRIDGE_CHANNEL_ID;
    if (!fromMachine || fromMachine === "unknown") {
      throw new Error(
        `cannot resolve primary channel for target="${target.name}": no user-facing leg `
        + `available AND msg.from is missing (cannot fall back to agent-bridge).`,
      );
    }
    if (!returnTarget) {
      throw new Error(
        `cannot resolve primary channel for target="${target.name}": no user-facing leg `
        + `available AND msg.fromTarget is missing (cannot fall back to agent-bridge).`,
      );
    }
    peerId = encodeBridgePeerId(fromMachine, returnTarget);
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: hostCfg,
    channel: targetChannel,
    accountId: account,
    peer: {
      kind: "direct",
      id: String(peerId),
    },
  });

  const storePath = runtime.channel.session.resolveStorePath(
    hostCfg?.session?.store,
    { agentId: route.agentId },
  );

  return {
    targetChannel,
    peerId,
    returnTarget,
    route,
    storePath,
  };
}

/**
 * Run a single agent turn for the inbound bridge message. The agent reads
 * the message in the primary session's context (Telegram if wired, else
 * agent-bridge back-channel) and is reminded — via the BRIDGE-CONTEXT block
 * appended to the message body — to:
 *
 *   1. Reply to the originating bridge peer via `bridge_send_message`
 *      (the implicit bridge leg, ALWAYS expected when from_target is set).
 *   2. Optionally also reply via the additional user-facing channel(s) we
 *      surface in the hint. (For Telegram this happens NATURALLY because we
 *      injected into the Telegram session — the agent's normal turn output
 *      flows there. For other channels, the agent must call the matching
 *      reply tool.)
 *
 * No `deliver` fan-out happens here. The dispatch primitive's natural
 * delivery (a single sendText to the primary channel's outbound) is all we
 * need.
 */
async function dispatchAgentTurn({
  primary,
  msg,
  rawContent,
  fromMachine,
  account,
  target,
  additionalReplyChannels,
  relayCtx,
  runtime,
  hostCfg,
  replyTargets,
  dispatchInboundReplyWithBase,
  log,
}) {
  const { targetChannel, peerId, route, storePath } = primary;

  // Register reply-target hints so the channel-plugin outbound (used when the
  // agent calls bridge_send_message in-turn) can resolve fromMachine + return
  // target regardless of which sessionKey lookup the host emits.
  //
  // ownTarget mirrors the addressable target alias used in the BRIDGE-CONTEXT
  // (target.name) — NOT the underlying channel account id. Explicit-target
  // setups can have `targets.bot-alpha.account = "default"`, and the peer's
  // follow-up must come back to `inbox/openclaw/bot-alpha`, not /default.
  // (Codex review P2, 2026-05-04, rounds 5-6.)
  const ownTargetAlias = `openclaw/${target?.name ?? account}`;
  registerReplyTarget(replyTargets, {
    sessionKey: route.sessionKey,
    fromMachine,
    incoming: msg,
    target,
    accountId: account,
    ownTarget: ownTargetAlias,
    peerId: String(peerId),
    returnTarget: primary.returnTarget,
  });

  const body = formatInboundBody({
    msg,
    target,
    additionalReplyChannels,
    primaryChannel: targetChannel,
    relayCtx,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext(buildInboundContextPayloadInput({
    body,
    rawContent,
    targetChannel,
    peerId,
    route,
    fromMachine,
    accountId: route.accountId,
    msg,
  }));

  log.info(
    `about to dispatch ${msg.id} from ${fromMachine} target=${target.name} `
    + `primary=${targetChannel} additionalReplyChannels=[${additionalReplyChannels.join(",")}] `
    + `route.sessionKey=${route.sessionKey} accountId=${route.accountId}`,
  );

  await dispatchInboundReplyWithBase({
    cfg: hostCfg,
    channel: targetChannel,
    accountId: route.accountId,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      // Single-channel natural delivery via the primary outbound. No
      // multi-channel fan-out — the agent's tool calls drive any additional
      // legs (bridge_send_message for the implicit bridge reply,
      // telegram_reply / etc. for non-primary user-facing channels).
      const text = payload?.text ?? "";
      if (!text.trim()) return;
      const deliverFn = resolveProviderDeliver({
        runtime,
        targetChannel,
      });
      if (!deliverFn) {
        throw new Error(
          `no outbound delivery function for primary channel="${targetChannel}" on this host`,
        );
      }
      await deliverFn({
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

  log.info(
    `dispatched ${msg.id} from ${fromMachine} target=${target.name} `
    + `primary=${targetChannel} sessionKey=${route.sessionKey}`,
  );
}

function buildInboundContextPayloadInput({
  body,
  rawContent,
  targetChannel,
  peerId,
  route,
  fromMachine,
  accountId,
  msg,
}) {
  return {
    Body: body,
    // OpenClaw's inbound context finalizer prefers BodyForAgent when present,
    // then falls back to CommandBody/RawBody before Body. Keep the scaffolded
    // bridge context in the agent-visible field while preserving raw content
    // for command parsing and transcript/debug fields.
    BodyForAgent: body,
    RawBody: rawContent,
    CommandBody: rawContent,
    From: `${targetChannel}:${peerId}`,
    To: `${targetChannel}:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
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
    // CommandAuthorized defaults via finalizeInboundContext; bridge content
    // is untrusted, so we don't flip it on.
  };
}

function getProcessState() {
  const g = globalThis;
  if (!g[PROCESS_STATE_KEY]) {
    g[PROCESS_STATE_KEY] = {
      replyTargets: new Map(),
      watcherStop: null,
      watcherSignature: null,
      cleanupInstalled: false,
    };
  }
  return g[PROCESS_STATE_KEY];
}

function buildWatcherSignature({ agentId, inboxRoot, pollIntervalMs, targets, pluginCfg }) {
  const normalizedTargets = Object.keys(targets)
    .sort()
    .map((name) => {
      const cfg = targets[name] ?? {};
      return [
        name,
        cfg.openclaw_channel ?? null,
        cfg.account ?? null,
        cfg.peer_id ?? null,
        normalizeArcKey(cfg.additionalReplyChannels),
        cfg.relayNotice ?? null,
        cfg.relayNoticeChannel ?? null,
        cfg.relayNoticePeerId ?? null,
        Boolean(cfg.legacy_session),
      ];
    });
  // Plugin-level additionalReplyChannels feeds the resolution fallback for
  // any target whose own config is null, so a hot-reload that ONLY changes
  // the plugin-level value must invalidate the signature too — otherwise
  // startOrReuseWatcher() reuses the stale closure with the old pluginCfg.
  // Same logic for the plugin-level relayNotice* fields, which similarly
  // back-fill per-target defaults.
  const pluginLevel = pluginCfg
    ? {
        additionalReplyChannels: normalizeArcKey(pluginCfg.additionalReplyChannels),
        relayNotice: pluginCfg.relayNotice ?? null,
        relayNoticeChannel: pluginCfg.relayNoticeChannel ?? null,
        relayNoticePeerId: pluginCfg.relayNoticePeerId ?? null,
      }
    : null;
  return JSON.stringify({
    agentId,
    inboxRoot,
    pollIntervalMs: pollIntervalMs ?? null,
    targets: normalizedTargets,
    pluginLevel,
  });
}

function normalizeArcKey(arc) {
  if (Array.isArray(arc)) return arc.slice().sort().join(",");
  return arc ?? null;
}

function startOrReuseWatcher({
  processState,
  agentId,
  inboxRoot,
  pollIntervalMs,
  targets,
  pluginCfg,
  log,
  start,
}) {
  const watcherSignature = buildWatcherSignature({
    agentId,
    inboxRoot,
    pollIntervalMs,
    targets,
    pluginCfg,
  });

  if (
    processState.watcherSignature === watcherSignature &&
    typeof processState.watcherStop === "function"
  ) {
    log.info(
      `watcher already active for agentId="${agentId}" inboxRoot=${inboxRoot} — skipping duplicate startup`,
    );
    return "reused";
  }

  if (typeof processState.watcherStop === "function") {
    log.warn(
      `watcher config changed for agentId="${agentId}" inboxRoot=${inboxRoot} — restarting inbox watcher`,
    );
    try {
      processState.watcherStop();
    } catch (err) {
      log.warn(`failed to stop prior watcher cleanly: ${err?.message ?? err}`);
    }
    processState.watcherStop = null;
    processState.watcherSignature = null;
  }

  processState.watcherStop = start();
  processState.watcherSignature = watcherSignature;
  return "started";
}

/**
 * Register reply-target hints for the outbound SFTP path. Keyed by a few
 * plausible lookup shapes so the outbound adapter can find the origin
 * machine regardless of which ctx field the host passes through.
 */
function registerReplyTarget(replyTargets, { sessionKey, fromMachine, incoming, target, accountId, ownTarget, peerId, returnTarget }) {
  const hit = {
    fromMachine,
    incoming,
    ownTarget,
    accountId,
    peerId,
    returnTarget: returnTarget ?? incoming?.fromTarget ?? null,
    replyToId: incoming?.id ?? null,
  };
  if (sessionKey) replyTargets.set(sessionKey, hit);
  if (peerId) replyTargets.set(String(peerId), hit);
  if (accountId) replyTargets.set(String(accountId), hit);
  if (ownTarget) replyTargets.set(String(ownTarget), hit);
  if (fromMachine) replyTargets.set(String(fromMachine), hit);
  if (fromMachine && hit.returnTarget) {
    replyTargets.set(`${fromMachine}|${hit.returnTarget}`, hit);
  }
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

/**
 * Build the relay-context bundle (relay-expand store record + reply-path
 * display + agent-bridge version) for this inbound message.
 *
 * Pre-4.3.0 (`sendBridgeRelayNotice`) this function ALSO emitted the
 * Telegram-visible `[Agent Bridge relay] 🛰️` notice via a gateway-direct
 * `sendText` BEFORE the agent turn ran. That path is gone — the agent now
 * owns user-facing relay emission via the scaffold injected into
 * `formatInboundBody`. This helper is now strictly preparatory:
 *   - Populates the relay-expand store (so `agent-bridge relay-expand NN`
 *     keeps resolving long-form bodies).
 *   - Returns the data the inbound-body formatter needs to embed the
 *     scaffold (expandId, replyPathDisplay, agentBridgeVersion).
 *
 * Returns `null` when relay notices are disabled for this target — callers
 * MUST handle null and skip scaffold injection accordingly.
 */
function prepareBridgeRelayContext({ hostCfg, pluginCfg, target, msg, additionalReplyChannels, log }) {
  if (!relayNoticeEnabled(pluginCfg, target.config)) return null;

  // The relay-notice helper still accepts a `replyVia` field for the human-
  // readable "reply path" line. Map our `additionalReplyChannels` model to
  // that legacy shape: list "agent-bridge" first (always implicit when
  // from_target is set) plus every additional user-facing channel.
  const replyPathDisplay = formatReplyPathForNotice({
    msg,
    additionalReplyChannels,
  });

  const agentBridgeVersion = resolveAgentBridgeVersion();
  const sourceAgentBridgeVersion = cleanString(
    msg?.sourceAgentBridgeVersion
      ?? msg?.agentBridgeVersion
      ?? msg?.agent_bridge_version,
  );
  let expandRecord = null;
  try {
    expandRecord = storeRelayExpandMessage(msg, {
      targetName: target.name,
      replyVia: replyPathDisplay,
      sourceAgentBridgeVersion,
      destinationAgentBridgeVersion: agentBridgeVersion,
      agentBridgeVersion,
    });
  } catch (err) {
    log?.warn?.(
      `bridge relay expand-id store failed for ${target.name}/${msg.id}: ${err?.message ?? err}`,
    );
  }

  return {
    expandId: expandRecord?.expandId ?? null,
    replyPathDisplay,
    sourceAgentBridgeVersion,
    destinationAgentBridgeVersion: agentBridgeVersion,
    agentBridgeVersion,
    targetName: target.name,
  };
}

/**
 * Build the human-readable "reply path: ..." line for the relay notice.
 * "agent-bridge" is implicit whenever the inbound carries from_target.
 * Additional user-facing channels follow.
 */
function formatReplyPathForNotice({ msg, additionalReplyChannels }) {
  const parts = [];
  if (msg?.fromTarget) parts.push("agent-bridge");
  for (const c of additionalReplyChannels) {
    if (!parts.includes(c)) parts.push(c);
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts;
}

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
 *     additionalReplyChannels?: string[] | string | null
 *   }
 */
export const __testing = {
  getProcessState,
  buildWatcherSignature,
  startOrReuseWatcher,
  normalizeExplicitTargets,
  resolveAdditionalReplyChannels,
  coerceAdditionalReplyChannelsLevel,
  normalizeUserFacingChannel,
  warnOnLegacyReplyVia,
  isLegacyBridgeOnlyReplyVia,
  pickPrimaryChannel,
  formatInboundBody,
  formatReplyPathForNotice,
  buildInboundContextPayloadInput,
};

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
    // Headless targets (openclaw_channel === "agent-bridge") don't need a
    // Telegram peer_id — the peer is derived from the sender machine at
    // message time. Any Telegram-bound target still needs peer_id so the
    // outbound knows which chat to answer in.
    const peerId = cfg.peer_id ?? pluginPeerId ?? null;
    // Backward-compat for v2.x bridge-only targets: a target that omitted
    // peer_id AND inherited (or explicitly set) `replyVia: "agent-bridge"`
    // (string OR an array containing only "agent-bridge") was a valid
    // headless config in v2.x. v3.0 dropped `replyVia` interpretation,
    // but to avoid silently dropping these targets on upgrade we treat
    // that legacy shape as `openclaw_channel: "agent-bridge"` for the
    // purpose of normalization.
    //
    // CRITICAL: this inference ONLY kicks in when there is NO peer_id.
    // Targets that had `replyVia: "agent-bridge"` AND a peer_id were
    // ALREADY routable (peer_id was just silenced); in v3 they should
    // simply ignore the deprecated field and continue using their
    // user-facing channel. (Codex review P2 round 7, 2026-05-04.)
    //
    // We check both the per-target replyVia AND the plugin-level
    // fallback, since v2.x targets often inherited the mode from
    // `pluginCfg.replyVia` rather than restating it. The deprecation
    // warning emitted by `warnOnLegacyReplyVia()` is still the user's
    // cue to migrate the field properly.
    const inheritedReplyVia = cfg.replyVia ?? pluginCfg.replyVia;
    const legacyBridgeOnly = !peerId && isLegacyBridgeOnlyReplyVia(inheritedReplyVia);
    const outboundChannel = cfg.openclaw_channel
      ?? (legacyBridgeOnly ? AGENT_BRIDGE_CHANNEL_ID : "telegram");
    const isHeadless = outboundChannel === AGENT_BRIDGE_CHANNEL_ID;
    if (!peerId && !isHeadless) {
      log.warn(
        `target "${name}" missing peer_id (and no plugin-level fallback `
        + `pluginConfig.peer_id is set) — skipping. Either add peer_id or set `
        + `openclaw_channel="agent-bridge" for a headless target.`,
      );
      continue;
    }
    out[name] = {
      openclaw_channel: outboundChannel,
      account: cfg.account ?? name,
      peer_id: peerId,
      agent_id: cfg.agent_id ?? null,
      legacy_session: Boolean(cfg.legacy_session),
      additionalReplyChannels: cfg.additionalReplyChannels ?? null,
      relayNotice: cfg.relayNotice ?? pluginCfg.relayNotice ?? null,
      relayNoticeChannel: cfg.relayNoticeChannel ?? pluginCfg.relayNoticeChannel ?? null,
      relayNoticePeerId: cfg.relayNoticePeerId ?? pluginCfg.relayNoticePeerId ?? null,
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
      // Auto-discovered targets default to the plugin-level
      // additionalReplyChannels (which falls back to ["telegram"] at
      // resolution time when the target's openclaw_channel === "telegram").
      additionalReplyChannels: null,
      relayNotice: pluginCfg.relayNotice ?? null,
      relayNoticeChannel: pluginCfg.relayNoticeChannel ?? null,
      relayNoticePeerId: pluginCfg.relayNoticePeerId ?? null,
      auto_discovered: true,
    };
  }
  return out;
}

/**
 * Coerce a user-facing channel name to a known mode. Unknown values fall
 * back to "telegram" with a warn log so misconfigurations don't silently
 * silence the user-facing notification.
 */
function normalizeUserFacingChannel(raw, log, targetName) {
  if (raw == null) return "telegram";
  const v = String(raw).toLowerCase().trim();
  if (KNOWN_USER_FACING_CHANNELS.has(v)) return v;
  log?.warn?.(
    `additionalReplyChannels entry "${raw}" on target "${targetName}" is not a `
    + `known user-facing channel — falling back to "telegram". Valid values: `
    + `${[...KNOWN_USER_FACING_CHANNELS].join(", ")}.`,
  );
  return "telegram";
}

/**
 * Detect the v2.x "bridge-only target without peer_id" shape so we can keep
 * upgrading deployments running. The legacy shape was:
 *
 *   { account: "...", replyVia: "agent-bridge" }   // peer_id omitted
 *   { account: "...", replyVia: ["agent-bridge"] } // ditto, array form
 *
 * In v2.x this skipped the peer_id requirement because the peer was derived
 * from `msg.fromTarget` at message time. v3.0 ignores `replyVia` entirely,
 * but for one upgrade window we keep the relaxation alive: a legacy
 * bridge-only `replyVia` value lets `normalizeExplicitTargets` infer
 * `openclaw_channel: "agent-bridge"` instead of skipping the target.
 *
 * Treats unknown channel names as non-bridge-only (consistent with the v2.x
 * `isBridgeOnlyReplyVia` semantics).
 */
function isLegacyBridgeOnlyReplyVia(value) {
  if (value == null) return false;
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return false;
  for (const raw of list) {
    if (raw == null) return false;
    const v = String(raw).toLowerCase().trim();
    if (v !== AGENT_BRIDGE_CHANNEL_ID) return false;
  }
  return true;
}

/**
 * Surface a deprecation warning if any legacy `replyVia` config is still
 * present at plugin-level OR per-target. The plugin no longer interprets
 * `replyVia` — agent-driven routing takes over (see module-level docstring).
 *
 * We only warn ONCE per process start to avoid log spam; that's
 * accomplished by `warnOnLegacyReplyVia` being called from `register()`,
 * which is called once per plugin load.
 */
function warnOnLegacyReplyVia(pluginCfg, log) {
  const offenders = [];
  if (pluginCfg && Object.prototype.hasOwnProperty.call(pluginCfg, "replyVia")) {
    offenders.push("plugin-level config.replyVia");
  }
  const targetsCfg = pluginCfg?.targets;
  if (targetsCfg && typeof targetsCfg === "object") {
    for (const name of Object.keys(targetsCfg)) {
      const t = targetsCfg[name];
      if (t && typeof t === "object" && Object.prototype.hasOwnProperty.call(t, "replyVia")) {
        offenders.push(`targets["${name}"].replyVia`);
      }
    }
  }
  if (offenders.length === 0) return;
  log?.warn?.(
    `[deprecation] \`replyVia\` is no longer interpreted as of openclaw-channel v3.0.0. `
    + `The plugin now surfaces inbound bridge messages to the running agent and lets `
    + `tool calls drive replies (bridge_send_message for the implicit bridge leg, `
    + `telegram_reply / etc. for additional user-facing legs). Found stale config at: `
    + `${offenders.join(", ")}. Replace with \`additionalReplyChannels: ["telegram"]\` `
    + `(or \`[]\` for quiet mode) and delete the \`replyVia\` key. `
    + `IMPORTANT: if a target was previously bridge-only (\`replyVia: "agent-bridge"\` `
    + `with no \`peer_id\`), ALSO set \`openclaw_channel: "agent-bridge"\` on that target — `
    + `otherwise the upgrade defaults it back to "telegram" and the missing peer_id `
    + `causes the target to be skipped at startup. See openclaw-channel/README.md `
    + `"Reply routing in v3.0+".`,
  );
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
    const { pathToFileURL } = await import("node:url");

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
                // `req.resolve()` returns an absolute filesystem path. On
                // Windows that path starts with a drive letter (e.g.
                // `C:\Users\...\index.js`); Node's ESM `import()` interprets
                // the leading `C:` as a URL scheme and rejects it with
                // ERR_UNSUPPORTED_ESM_URL_SCHEME. Convert to a `file://` URL
                // first — `pathToFileURL` is a no-op-ish on POSIX (still
                // produces `file:///abs/path`) so the fix is cross-platform.
                const modUrl = pathToFileURL(modPath).href;
                const mod = await import(modUrl);
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
 * Format the inbound bridge message as a `<channel>` block (parity with the
 * Claude Code channel plugin) followed by an optional BRIDGE-CONTEXT block
 * that nudges the agent toward the correct reply pattern:
 *
 *   - When `from_target` is set: reply over the bridge via
 *     `bridge_send_message` (the implicit bridge leg).
 *   - When `additionalReplyChannels` is non-empty: reply ALSO via those
 *     user-facing channels. The primary channel's natural turn output
 *     handles its own leg automatically.
 *
 * The BRIDGE-CONTEXT block is intentionally compact and machine-readable
 * (key: value lines) so the agent has unambiguous data to act on.
 */
function formatInboundBody({ msg, target, additionalReplyChannels, primaryChannel, relayCtx }) {
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

  const channelBlock = `<channel ${attrs}>${msg.content ?? ""}</channel>`;

  // Build an agent-facing context block. Keep this short — the agent's
  // existing system prompt covers tool semantics.
  const ctxLines = ["[BRIDGE-CONTEXT]"];
  ctxLines.push(`source: agent-bridge`);
  ctxLines.push(`from_machine: ${msg.from ?? "unknown"}`);
  if (msg.fromTarget) {
    ctxLines.push(`from_target: ${msg.fromTarget}`);
    // OPENCLAW PIVOT: when this OC session calls bridge_send_message to
    // reply, it MUST pass `from_target` set to its OWN OC target id
    // (`openclaw/<account>`). Otherwise the MCP server's default kicks in
    // and stamps the outgoing message with `claude-code/default`, which
    // means any follow-up from the remote peer routes back to the local
    // Claude Code inbox instead of THIS OC session.
    // The return target is the ADDRESSABLE target alias (the inbox subdir
    // name), NOT the underlying channel account id. Explicit-target setups
    // can have `targets.bot-alpha.account = "default"` where `bot-alpha`
    // is what peers address; replies must come back to `openclaw/bot-alpha`,
    // not `openclaw/default`. Falls back to the account id only if the
    // target lacks a name, then to "default" as a last resort.
    const ownReturnTarget = `openclaw/${target?.name ?? target?.config?.account ?? "default"}`;
    ctxLines.push(
      `bridge_reply_target: ${msg.fromTarget}  # call bridge_send_message with target=${msg.fromTarget}, machine=${msg.from ?? "<sender>"}, from_target=${ownReturnTarget} to reply over the bridge`,
    );
    ctxLines.push(`own_return_target: ${ownReturnTarget}  # always set this on bridge_send_message so the peer's reply lands back here, not in claude-code/default`);
  } else {
    ctxLines.push(`bridge_reply_target: <none — sender did not include from_target; bridge reply not routable>`);
  }
  ctxLines.push(`primary_user_channel: ${primaryChannel}  # your natural turn output flows here`);
  if (additionalReplyChannels.length === 0) {
    ctxLines.push(`additional_user_channels: none`);
  } else {
    ctxLines.push(`additional_user_channels: ${additionalReplyChannels.join(", ")}`);
  }
  ctxLines.push(`local_target: ${target?.name ?? "?"}`);
  // [AGENT-BRIDGE-DUAL-VERSION-RELAY 2026-05-10]
  // Surface both source and destination version identity. Older senders omit
  // sourceAgentBridgeVersion, so keep the legacy agent_bridge_version alias
  // as the destination/local version for agents that have not learned the
  // split fields yet. Canonical doc: docs/relay-to-user.md.
  const sourceAgentBridgeVersion = cleanString(
    msg?.sourceAgentBridgeVersion
      ?? msg?.agentBridgeVersion
      ?? msg?.agent_bridge_version,
  );
  const destinationAgentBridgeVersion = relayCtx?.destinationAgentBridgeVersion
    ?? relayCtx?.agentBridgeVersion
    ?? resolveAgentBridgeVersion();
  if (sourceAgentBridgeVersion) {
    ctxLines.push(
      `source_agent_bridge_version: ${sourceAgentBridgeVersion}  # source-side Agent Bridge/runtime version from the sender`,
    );
  } else {
    ctxLines.push(
      `source_agent_bridge_version: <unknown — sender did not include sourceAgentBridgeVersion>`,
    );
  }
  if (destinationAgentBridgeVersion) {
    ctxLines.push(
      `destination_agent_bridge_version: ${destinationAgentBridgeVersion}  # local destination-side Agent Bridge/runtime version`,
    );
    ctxLines.push(
      `agent_bridge_version: ${destinationAgentBridgeVersion}  # legacy alias for destination_agent_bridge_version`,
    );
  }

  // [RELAY-SCAFFOLD-IN-OC 2026-05-09 — agent-bridge 4.3.0]
  // When the primary channel is a user-facing channel (Telegram, Slack,
  // Discord, etc.), the agent's natural turn output flows there — that's
  // the user-facing relay leg. Prepend a `formatRelayScaffold` block so
  // the agent sees the deterministic structural fields and a
  // `{{SUMMARY_PLACEHOLDER}}` it must replace with a 1-3 sentence Summary
  // blockquote before sending. This mirrors CC's pattern (mcp-server
  // prepends the same scaffold to the inbound `<channel>` push) and
  // gives OC + CC a single source of Summary judgment in the agent.
  //
  // When the primary channel is the silent agent-bridge back-channel,
  // there is no user reading the output — no scaffold injection needed.
  // The relay-expand store is still populated upstream so
  // `agent-bridge relay-expand NN` keeps working for ad-hoc lookups.
  const isUserFacingPrimary =
    primaryChannel &&
    primaryChannel !== AGENT_BRIDGE_CHANNEL_ID;

  let scaffoldPrefix = "";
  if (isUserFacingPrimary && relayCtx) {
    try {
      const scaffold = formatRelayScaffold(msg, {
        targetName: relayCtx.targetName ?? target?.name,
        replyVia: relayCtx.replyPathDisplay,
        sourceAgentBridgeVersion: relayCtx.sourceAgentBridgeVersion,
        destinationAgentBridgeVersion: relayCtx.destinationAgentBridgeVersion,
        expandId: relayCtx.expandId ?? undefined,
      });
      scaffoldPrefix = `${scaffold}\n\n`;
    } catch {
      // Defensive — never let a scaffold formatting bug block dispatch.
      scaffoldPrefix = "";
    }
  }

  return `${scaffoldPrefix}${channelBlock}\n\n${ctxLines.join("\n")}`;
}

function escapeAttr(v) {
  return String(v ?? "").replace(/"/g, '\\"');
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the `version` field from `mcp-server/package.json` (the canonical
 * agent-bridge version source — same field the bash CLI's VERSION constant
 * tracks via config.ts). Cached after the first successful read so we don't
 * re-stat per inbound message. Returns "" if the file can't be located /
 * parsed; callers must handle the empty-string fallback.
 */
let _cachedAgentBridgeVersion = null;
function resolveAgentBridgeVersion() {
  if (_cachedAgentBridgeVersion !== null) return _cachedAgentBridgeVersion;
  // From this file (openclaw-channel/src/index.js) the canonical version
  // lives at ../../mcp-server/package.json. We also walk a few extra
  // candidate paths to handle weird install layouts (e.g. when the plugin
  // is loaded from a flattened cache dir).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "mcp-server", "package.json"),
    join(here, "..", "..", "package.json"),
    join(here, "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const json = JSON.parse(readFileSync(p, "utf8"));
      if (json && typeof json.version === "string" && json.version.length > 0) {
        // Only accept if this is the agent-bridge mcp-server package — we
        // don't want the openclaw-channel package's own 3.0.0 leaking in
        // as the "agent-bridge version" the user sees in their relay.
        const name = typeof json.name === "string" ? json.name : "";
        if (name.includes("agent-bridge-mcp-server") || name === "agent-bridge") {
          _cachedAgentBridgeVersion = json.version;
          return _cachedAgentBridgeVersion;
        }
      }
    } catch { /* try next candidate */ }
  }
  _cachedAgentBridgeVersion = "";
  return _cachedAgentBridgeVersion;
}

// Exposed for tests so they can reset the cache between cases. Attached to
// the existing `__testing` export below at module-evaluation time via a
// post-init mutation (the `export const __testing = { ... }` declaration
// above was already used for other internal helpers; we additively augment
// rather than reshape it).
export function __resetVersionCache() {
  _cachedAgentBridgeVersion = null;
}
export { resolveAgentBridgeVersion };
