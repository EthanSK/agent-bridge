#!/usr/bin/env node
/**
 * agent-bridge Codex channel CLI. Invoked as `agent-bridge codex <verb> …`
 * (the bash CLI resolves the repo checkout and execs this file) or directly.
 *
 * Verbs:
 *   bind      Opt a Codex task into agent-bridge: bind codex/<alias> to a thread
 *   rebind    Move an existing alias to a different thread id
 *   unbind    Remove a binding
 *   enable    Re-enable a disabled binding
 *   disable   Pause delivery for a binding (files queue in its inbox)
 *   list      List bindings
 *   status    Durable-state snapshot (service lease, queues, rollouts)
 *   doctor    status + environment checks (read-only)
 *   send      Send a BridgeMessage from this machine (works without MCP tools)
 *   service   run | ensure | stop | status
 */

import { readFileSync } from "node:fs";
import {
  bindAlias,
  getBinding,
  isValidThreadId,
  listBindings,
  normalizeThreadId,
  setBindingEnabled,
  unbindAlias,
  SANDBOX_MODES,
  APPROVAL_POLICIES,
} from "../src/bindings.js";
import { bindAutomaticCodexAlias } from "../src/auto-alias.js";
import { findRolloutForThread } from "../src/rollout.js";
import { buildStatusSnapshot, formatStatus, runDoctor, formatDoctor } from "../src/status.js";
import { describeEnsureResult, ensureService, leaseFresh, readLease, stopService } from "../src/service.js";
import {
  codexTargetForAlias,
  configFilePath,
  identityFilePath,
  inboxRoot,
  keysDirPath,
  machineNameFilePath,
  outboundDirPath,
  outboxDirPath,
} from "../src/paths.js";
import { isValidTargetPath } from "../src/envelope.js";
import { makeEventLogger } from "../src/log.js";
import { CHANNEL_VERSION } from "../src/version.js";
// Vendor copies for packaging self-containment (parity test-enforced; see
// codex-channel/src/vendor/README.md).
import {
  deliverReply,
  deliverReplyLocal,
  isLocalMachineName,
  localMachineName,
} from "../src/vendor/openclaw-outbound.js";
import { newMessageId } from "../src/vendor/openclaw-envelope.js";

const log = makeEventLogger({ env: process.env });

/**
 * Env-aware overrides for the openclaw-channel outbound helpers, whose
 * module-level defaults point at the real `~/.agent-bridge`. Passing these
 * explicitly keeps `AGENT_BRIDGE_HOME`-sandboxed runs (tests, restricted
 * harnesses) hermetic.
 */
const LOCAL_NAME_OPTS = {
  env: process.env,
  nameFilePath: machineNameFilePath(),
  identityPath: identityFilePath(),
};
const DELIVERY_PATH_OPTS = {
  inboxDir: inboxRoot(),
  outboxDir: outboxDirPath(),
  outboundDir: outboundDirPath(),
  configPath: configFilePath(),
  keysDir: keysDirPath(),
  localNameOpts: LOCAL_NAME_OPTS,
};

function out(text) {
  process.stdout.write(`${text}\n`);
}

function fail(text, code = 1) {
  process.stderr.write(`error: ${text}\n`);
  process.exit(code);
}

/** Tiny flag parser: --key value | --key=value | boolean --key. */
function parseArgs(argv, booleanFlags = new Set()) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = argv[i + 1];
      i += 1;
    }
  }
  return { flags, positional };
}

function resolveThreadId(flags) {
  const explicit = typeof flags["thread-id"] === "string" ? flags["thread-id"].trim() : "";
  if (explicit) return { threadId: normalizeThreadId(explicit), source: "flag" };
  const fromEnv = (process.env.CODEX_THREAD_ID ?? "").trim();
  if (fromEnv) return { threadId: normalizeThreadId(fromEnv), source: "env" };
  return { threadId: null, source: null };
}

async function cmdBind(argv, { rebind = false } = {}) {
  const booleans = new Set(["steering", "no-steering", "rebind", "force", "json", "no-ensure", "allow-shared-thread", "allow-danger", "no-ownership-guard"]);
  const { flags, positional } = parseArgs(argv, booleans);
  const aliasInput = typeof flags.alias === "string" ? flags.alias : positional[0];
  const explicitAlias = typeof aliasInput === "string" && aliasInput.trim() ? aliasInput.trim() : null;
  if (flags.alias !== undefined && explicitAlias === null) fail("--alias requires a non-empty name");
  const automaticAlias = explicitAlias === null;
  if (rebind && automaticAlias) fail("usage: agent-bridge codex rebind <alias> --thread-id <uuid>");

  const { threadId, source } = resolveThreadId(flags);
  if (!threadId) {
    fail(
      "no Codex thread id. Pass --thread-id <uuid>, or run this command from INSIDE the Codex task "
      + "(Codex exports CODEX_THREAD_ID to its shell commands, so `agent-bridge codex bind` "
      + "run by the task itself binds that exact task).",
    );
  }
  if (!isValidThreadId(threadId)) fail(`"${threadId}" is not a valid Codex thread id (uuid expected)`);

  // Existence validation against persisted rollouts — read-only, and safe to
  // run from inside the live task (we never attach an App Server here).
  const rollout = findRolloutForThread(threadId);
  if (!rollout && flags.force !== true) {
    fail(
      `no persisted rollout found for thread ${threadId} under $CODEX_HOME/sessions. `
      + "Double-check the id (codex CLI: /status inside the task, or `codex resume` picker). "
      + "Pass --force to bind anyway (e.g. custom CODEX_HOME).",
    );
  }

  const sandbox = typeof flags.sandbox === "string" ? flags.sandbox : undefined;
  if (sandbox !== undefined && !SANDBOX_MODES.includes(sandbox)) {
    fail(`--sandbox must be one of: ${SANDBOX_MODES.join(", ")}`);
  }
  if (sandbox === "danger-full-access" && flags["allow-danger"] !== true) {
    fail("--sandbox danger-full-access additionally requires --allow-danger (bridge-delivered turns would run unsandboxed)");
  }
  const approvalPolicy = typeof flags["approval-policy"] === "string" ? flags["approval-policy"] : undefined;
  if (approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(approvalPolicy)) {
    fail(`--approval-policy must be one of: ${APPROVAL_POLICIES.join(", ")}`);
  }

  const policy = {};
  if (flags.steering === true) policy.steering = true;
  if (flags["no-steering"] === true) policy.steering = false;
  if (flags["no-ownership-guard"] === true) policy.ownershipGuard = false;
  if (sandbox !== undefined) policy.sandbox = sandbox;
  if (approvalPolicy !== undefined) policy.approvalPolicy = approvalPolicy;

  let result;
  try {
    const common = {
      threadId,
      cwd: typeof flags.cwd === "string" ? flags.cwd : process.cwd(),
      boundBy: source === "env" ? "cli(CODEX_THREAD_ID)" : "cli",
      policy,
      allowDanger: flags["allow-danger"] === true,
    };
    result = automaticAlias
      ? await bindAutomaticCodexAlias({ ...common, env: process.env, logEvent: log })
      : bindAlias({
        ...common,
        alias: explicitAlias,
        rebind: rebind || flags.rebind === true,
        allowSharedThread: flags["allow-shared-thread"] === true,
      });
  } catch (err) {
    fail(err?.message ?? String(err));
  }

  const alias = result.binding.alias;
  const aliasResolution = result.aliasResolution ?? null;
  if (aliasResolution?.metadataWarning) {
    process.stderr.write(`warning: ${aliasResolution.metadataWarning}\n`);
  }
  const target = codexTargetForAlias(alias);
  log("info", "codex.binding_created", `Bound ${target} -> thread ${threadId}`, {
    alias,
    alias_automatic: automaticAlias,
    alias_source: aliasResolution?.source ?? "explicit",
    thread_id: threadId,
    thread_id_source: source,
    rebind: rebind || flags.rebind === true,
    rollout_found: Boolean(rollout),
  });

  let ensured = { spawned: false, pid: null };
  let ensureFailure = null;
  if (flags["no-ensure"] !== true) {
    try {
      ensured = await ensureService();
    } catch (err) {
      ensureFailure = `could not ensure codex-channel service: ${err?.message ?? err}`;
      process.stderr.write(`warning: ${ensureFailure}\n`);
    }
  }
  const ensureDescription = flags["no-ensure"] === true
    ? { ok: true, message: "codex-channel service not ensured (--no-ensure)" }
    : ensureFailure
      ? { ok: false, message: ensureFailure }
      : describeEnsureResult(ensured);
  if (!ensureDescription.ok && !ensureFailure) {
    process.stderr.write(`warning: ${ensureDescription.message}\n`);
  }

  if (flags.json === true) {
    out(JSON.stringify({
      ok: true,
      binding: result.binding,
      target,
      aliasAutomatic: automaticAlias,
      aliasSource: aliasResolution?.source ?? "explicit",
      aliasMetadataWarning: aliasResolution?.metadataWarning ?? null,
      serviceEnsured: { ...ensured, healthy: ensureDescription.ok, message: ensureDescription.message },
    }, null, 2));
    return;
  }
  out(`bound ${target} -> Codex thread ${threadId}${rollout ? "" : " (rollout not verified — bound with --force)"}`);
  if (automaticAlias) out(`  automatic alias: ${aliasResolution?.source ?? "fallback"}${aliasResolution?.title ? ` from task name ${JSON.stringify(aliasResolution.title)}` : ""}`);
  if (result.replaced && result.replaced.threadId !== threadId) out(`  (replaced previous thread ${result.replaced.threadId})`);
  out(`  cwd: ${result.binding.cwd}`);
  out(`  policy: sandbox=${result.binding.policy.sandbox} approvals=${result.binding.policy.approvalPolicy} steering=${result.binding.policy.steering ? "on" : "off"}`);
  out(`  ${ensureDescription.ok ? "" : "warning: "}${ensureDescription.message}`);
  out("");
  out("Any fleet machine can now reach this task:");
  out(`  bridge_send_message({ machine: "${localSafeName()}", target: "${target}", message: "…" })`);
  out("When THIS task sends outbound, identify itself for replies with:");
  out(`  from_target: "${target}"`);
}

function cmdUnbind(argv) {
  const { flags, positional } = parseArgs(argv, new Set(["json"]));
  const alias = positional[0] ?? flags.alias;
  if (!alias) fail("usage: agent-bridge codex unbind <alias>");
  const removed = unbindAlias(alias);
  if (!removed) fail(`no binding for alias "${alias}"`);
  log("info", "codex.binding_removed", `Unbound codex/${alias}`, { alias, thread_id: removed.threadId });
  if (flags.json === true) {
    out(JSON.stringify({ ok: true, removed }, null, 2));
    return;
  }
  out(`unbound codex/${alias} (was thread ${removed.threadId}).`);
  out("Staged/pending files for the alias are left on disk; re-binding the alias resumes them.");
}

function cmdEnableDisable(argv, enabled) {
  const { flags, positional } = parseArgs(argv, new Set(["json"]));
  const alias = positional[0] ?? flags.alias;
  if (!alias) fail(`usage: agent-bridge codex ${enabled ? "enable" : "disable"} <alias>`);
  const binding = setBindingEnabled(alias, enabled);
  if (!binding) fail(`no binding for alias "${alias}"`);
  log("info", enabled ? "codex.binding_enabled" : "codex.binding_disabled", `codex/${alias} ${enabled ? "enabled" : "disabled"}`, { alias });
  if (flags.json === true) out(JSON.stringify({ ok: true, binding }, null, 2));
  else out(`codex/${alias} is now ${enabled ? "ENABLED" : "DISABLED (messages queue in its inbox until re-enabled)"}`);
}

function cmdList(argv) {
  const { flags } = parseArgs(argv, new Set(["json"]));
  const bindings = listBindings();
  if (flags.json === true) {
    out(JSON.stringify({ bindings }, null, 2));
    return;
  }
  if (bindings.length === 0) {
    out("no codex bindings. From a Codex task, run: agent-bridge codex bind (the alias is automatic; --alias overrides it).");
    return;
  }
  for (const b of bindings) {
    out(`${codexTargetForAlias(b.alias)} -> ${b.threadId}${b.enabled ? "" : " [disabled]"}`);
  }
}

function cmdStatus(argv) {
  const { flags } = parseArgs(argv, new Set(["json"]));
  const snapshot = buildStatusSnapshot();
  if (flags.json === true) out(JSON.stringify(snapshot, null, 2));
  else out(formatStatus(snapshot));
}

function cmdDoctor(argv) {
  const { flags } = parseArgs(argv, new Set(["json"]));
  const result = runDoctor();
  if (flags.json === true) out(JSON.stringify(result, null, 2));
  else out(formatDoctor(result));
  if (result.checks.some((c) => !c.ok)) process.exitCode = 1;
}

async function cmdSend(argv) {
  const booleans = new Set(["json", "stdin", "one-way"]);
  const { flags } = parseArgs(argv, booleans);
  const machine = flags.machine;
  const target = flags.target;
  if (!machine || typeof machine !== "string") fail("--machine <name|local> is required");
  if (!target || typeof target !== "string") fail("--target <harness/alias> is required (e.g. claude-code/default)");
  if (!isValidTargetPath(target)) fail(`invalid --target ${JSON.stringify(target)} (expected e.g. "claude-code/default", "codex/<alias>")`);

  let content = typeof flags.message === "string" ? flags.message : null;
  if (flags.stdin === true) {
    content = readFileSync(0, "utf8");
  }
  if (content === null || content === "") fail("--message <text> or --stdin is required");

  let fromTarget = typeof flags["from-target"] === "string" ? flags["from-target"] : null;
  const fromAlias = typeof flags["from-alias"] === "string" ? flags["from-alias"] : null;
  if (fromAlias) {
    if (fromTarget) fail("pass either --from-alias or --from-target, not both");
    const binding = getBinding(fromAlias);
    if (!binding) fail(`--from-alias ${fromAlias}: no such binding (agent-bridge codex list)`);
    fromTarget = codexTargetForAlias(fromAlias);
  }
  if (flags["one-way"] === true && fromTarget) fail("--one-way cannot be combined with --from-alias/--from-target");

  const replyTo = typeof flags["reply-to"] === "string" ? flags["reply-to"] : null;
  const message = {
    id: newMessageId(),
    from: localSafeName(),
    to: machine,
    type: replyTo ? "reply" : "message",
    content,
    timestamp: Date.now(),
    replyTo,
    ttl: 86_400,
    target,
    ...(fromTarget ? { fromTarget } : {}),
    sourceAgentBridgeVersion: CHANNEL_VERSION,
  };

  log("info", "codex.send_start", `Sending ${message.id} to ${machine}/${target}`, {
    msg_id: message.id,
    to: machine,
    target,
    from_target: fromTarget ?? null,
    reply_to: replyTo ?? null,
    content_length: content.length,
  });
  try {
    if (isLocalMachineName(machine, LOCAL_NAME_OPTS)) {
      deliverReplyLocal({ message, toMachine: machine, logger: quietLogger(), ...DELIVERY_PATH_OPTS });
    } else {
      await deliverReply({ message, toMachine: machine, logger: quietLogger(), ...DELIVERY_PATH_OPTS });
    }
  } catch (err) {
    log("error", "codex.send_failed", `Send ${message.id} failed: ${err?.message ?? err}`, {
      msg_id: message.id, to: machine, target,
    });
    fail(`delivery failed: ${err?.message ?? err}`);
  }
  log("info", "codex.send_delivered", `Sent ${message.id} to ${machine}/${target}`, {
    msg_id: message.id, to: machine, target,
  });
  if (flags.json === true) out(JSON.stringify({ ok: true, id: message.id, machine, target, fromTarget }, null, 2));
  else out(`sent ${message.id} -> ${machine} target=${target}${fromTarget ? ` from_target=${fromTarget}` : " (one-way)"}`);
}

async function cmdService(argv) {
  const verb = argv[0] ?? "status";
  if (verb === "ensure") {
    const result = await ensureService();
    const described = describeEnsureResult(result);
    if (!described.ok) fail(described.message);
    out(described.message);
    return;
  }
  if (verb === "stop") {
    // Identity-safe: after live-ownership proof, publish a token-bound control
    // request and wait for normal shutdown + lease release. No PID signal.
    const result = await stopService();
    if (result.stopped) out(`codex-channel service pid ${result.pid} stopped via verified control request`);
    else if (result.reason === "not_running") out("codex-channel service is not running");
    else if (result.reason === "stale_lease_cleaned") out("stale codex-channel lease cleaned up (no live daemon addressed)");
    else fail(`stop failed: ${result.reason}`);
    return;
  }
  if (verb === "status") {
    const lease = readLease();
    if (lease?.unreadable) fail(`codex-channel service BLOCKED: unreadable/invalid lease at ${lease.path}`);
    else if (leaseFresh(lease)) out(`codex-channel service RUNNING (pid ${lease.pid}, v${lease.version ?? "?"})`);
    else out("codex-channel service NOT RUNNING");
    return;
  }
  if (verb === "run") {
    const { runService } = await import("../src/service.js");
    await runService({ mirror: process.stdout.isTTY ? (line) => process.stderr.write(`${line}\n`) : null });
    return;
  }
  fail(`unknown service verb "${verb}" (run | ensure | stop | status)`);
}

function cmdHelp() {
  out(`agent-bridge codex — first-class Codex support for Agent Bridge (v${CHANNEL_VERSION})

USAGE
  agent-bridge codex <verb> [options]

BIND THE CURRENT CODEX TASK (run inside the task's shell)
  agent-bridge codex bind
      Auto-discovers THIS task's thread id and user-facing name, derives a
      stable collision-safe alias, persists it, and starts the service. For
      example, task "Release Review" becomes codex/release-review. From then
      on, any fleet machine can message that target with bridge_send_message.

  agent-bridge codex bind --alias release-review
      Optional explicit alias override.
      and the codex-channel service resumes this exact thread to deliver it.

  Options:
    --alias <name>            override the automatic title-derived alias
    --thread-id <uuid>       bind an explicit thread instead of CODEX_THREAD_ID
    --cwd <dir>              turn working dir (default: current dir)
    --sandbox <mode>         read-only | workspace-write (default) | danger-full-access (needs --allow-danger)
    --approval-policy <p>    never (default) | on-request | untrusted
                             (Codex "granular" needs per-rule config this CLI does not expose;
                              legacy "on-failure" is not a Codex 0.145 policy and is rejected)
    --steering               opt-in: inject into an ACTIVE turn via guarded turn/steer
    --no-ownership-guard     do not defer when another Codex client is writing the thread
    --allow-shared-thread    permit two aliases on one thread (double-delivery risk)
    --force                  skip rollout existence validation
    --rebind                 allow overwriting an existing alias
    --no-ensure              do not auto-start the codex-channel service

OTHER VERBS
  rebind <alias> --thread-id <uuid>   move an alias to another thread
  unbind <alias>                      remove a binding
  enable <alias> | disable <alias>    pause/resume delivery
  list | status | doctor              inspect bindings, queues, environment
  send --machine <m> --target <t> --message <text>
       [--reply-to <id>] [--from-alias <alias> | --from-target <t>] [--stdin] [--one-way]
                                      send a BridgeMessage without MCP tools
  service run|ensure|stop|status      manage the push daemon

All verbs accept --json for machine-readable output.
Docs: codex-channel/README.md`);
}

function quietLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function localSafeName() {
  try {
    return localMachineName(LOCAL_NAME_OPTS);
  } catch {
    return "unknown";
  }
}

const [verb, ...rest] = process.argv.slice(2);
switch (verb) {
  case "bind": await cmdBind(rest); break;
  case "rebind": await cmdBind(rest, { rebind: true }); break;
  case "unbind": cmdUnbind(rest); break;
  case "enable": cmdEnableDisable(rest, true); break;
  case "disable": cmdEnableDisable(rest, false); break;
  case "list": cmdList(rest); break;
  case "status": cmdStatus(rest); break;
  case "doctor": cmdDoctor(rest); break;
  case "send": await cmdSend(rest); break;
  case "service": await cmdService(rest); break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    cmdHelp();
    break;
  default:
    fail(`unknown verb "${verb}". Run: agent-bridge codex help`, 2);
}
