/**
 * Filesystem-only status/doctor snapshots for the Codex channel.
 *
 * Everything here reads durable state (bindings registry, service lease,
 * inbox/staging/dead-letter dirs, Codex rollout files, ~/.codex/config.toml)
 * WITHOUT talking to the daemon or the App Server, so the same snapshot is
 * available to:
 *   - `agent-bridge codex status|doctor` (CLI), and
 *   - the `bridge_codex_status` MCP tool (mcp-server, any mode).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listBindings } from "./bindings.js";
import { readLease, readTeardownPoison, leaseFresh } from "./service.js";
import { findRolloutForThread } from "./rollout.js";
import {
  CODEX_HARNESS_PREFIX,
  codexHome,
  codexInboxDir,
  codexPendingAckDir,
  exhaustedDir,
  inboxRoot,
  serviceLeasePath,
  serviceTeardownPoisonPath,
} from "./paths.js";
import { CHANNEL_VERSION } from "./version.js";

function countJson(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".meta.json")).length;
  } catch {
    return 0;
  }
}

/** Full machine-readable snapshot. */
export function buildStatusSnapshot({ env = process.env } = {}) {
  const bindings = listBindings({ env });
  const lease = readLease(env);
  const teardownPoison = readTeardownPoison(env);
  const leaseUnreadable = lease?.unreadable === true;
  const serviceRunning = !leaseUnreadable && leaseFresh(lease);

  const aliases = bindings.map((binding) => {
    const rollout = findRolloutForThread(binding.threadId, { env });
    return {
      alias: binding.alias,
      target: `${CODEX_HARNESS_PREFIX}/${binding.alias}`,
      threadId: binding.threadId,
      enabled: binding.enabled,
      cwd: binding.cwd,
      policy: binding.policy,
      pendingInbox: countJson(codexInboxDir(binding.alias, env)),
      staged: countJson(codexPendingAckDir(binding.alias, env)),
      rolloutFound: Boolean(rollout),
      rolloutMtime: rollout ? new Date(rollout.mtimeMs).toISOString() : null,
      updatedAt: binding.updatedAt,
    };
  });

  // Alias inbox dirs that have pending files but NO binding — messages that
  // will never be delivered until someone binds the alias.
  const unboundAliasDirs = [];
  try {
    const root = join(inboxRoot(env), CODEX_HARNESS_PREFIX);
    const bound = new Set(bindings.map((b) => b.alias));
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (bound.has(entry.name)) continue;
      const pending = countJson(join(root, entry.name));
      if (pending > 0) unboundAliasDirs.push({ alias: entry.name, pending });
    }
  } catch { /* inbox/codex may not exist yet */ }

  return {
    channelVersion: CHANNEL_VERSION,
    service: {
      running: serviceRunning,
      pid: serviceRunning ? lease.pid : null,
      leaseVersion: lease?.version ?? null,
      leasePath: serviceLeasePath(env),
      staleLease: Boolean(lease) && !serviceRunning,
      leaseUnreadable,
      leaseError: leaseUnreadable ? lease.error ?? "invalid lease" : null,
      teardownPoisoned: Boolean(teardownPoison),
      teardownPoisonPath: serviceTeardownPoisonPath(env),
      teardownPoison,
    },
    bindings: aliases,
    unboundAliasDirs,
    deadLetterCount: countJson(exhaustedDir(env)),
  };
}

/** Human-readable status text. */
export function formatStatus(snapshot) {
  const lines = [];
  lines.push(`codex-channel v${snapshot.channelVersion}`);
  if (snapshot.service.teardownPoisoned) {
    lines.push(`service: BLOCKED (unverified prior App Server teardown at ${snapshot.service.teardownPoisonPath})`);
  } else if (snapshot.service.leaseUnreadable) {
    lines.push(`service: BLOCKED (unreadable/invalid lease at ${snapshot.service.leasePath})`);
  } else if (snapshot.service.running) {
    lines.push(`service: RUNNING (pid ${snapshot.service.pid}, lease v${snapshot.service.leaseVersion ?? "?"})`);
  } else if (snapshot.service.staleLease) {
    lines.push(`service: NOT RUNNING (stale lease at ${snapshot.service.leasePath} — next start will take over)`);
  } else {
    lines.push("service: NOT RUNNING (start: agent-bridge codex service ensure)");
  }
  if (snapshot.bindings.length === 0) {
    lines.push("bindings: none. From the Codex task, run: agent-bridge codex bind (automatic alias; --alias overrides it).");
  } else {
    lines.push(`bindings (${snapshot.bindings.length}):`);
    for (const b of snapshot.bindings) {
      const flags = [
        b.enabled ? null : "DISABLED",
        b.policy.steering ? "steering" : null,
        `sandbox=${b.policy.sandbox}`,
        `approvals=${b.policy.approvalPolicy}`,
      ].filter(Boolean).join(", ");
      lines.push(`  - ${b.target} -> thread ${b.threadId}`);
      lines.push(`      ${flags}`);
      lines.push(`      pending=${b.pendingInbox} staged=${b.staged} rollout=${b.rolloutFound ? `found (mtime ${b.rolloutMtime})` : "NOT FOUND"}`);
    }
  }
  for (const u of snapshot.unboundAliasDirs) {
    lines.push(`  ! inbox/codex/${u.alias}/ has ${u.pending} pending message(s) but NO binding — bind the alias or the messages will sit.`);
  }
  if (snapshot.deadLetterCount > 0) {
    lines.push(`dead letters: ${snapshot.deadLetterCount} file(s) in inbox/.failed/.exhausted/ (inspect + re-send manually)`);
  }
  return lines.join("\n");
}

/**
 * Doctor: status + environment checks. Read-only.
 * @returns {{ snapshot: object, checks: Array<{name, ok, detail}> }}
 */
export function runDoctor({ env = process.env } = {}) {
  const snapshot = buildStatusSnapshot({ env });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // Codex home present?
  const home = codexHome(env);
  add("codex_home", existsSync(home), existsSync(home) ? home : `${home} not found — is Codex installed for this user?`);

  // Bindings' rollout files resolvable?
  for (const b of snapshot.bindings) {
    add(
      `rollout:${b.alias}`,
      b.rolloutFound,
      b.rolloutFound
        ? `thread ${b.threadId} rollout present`
        : `no rollout file found for thread ${b.threadId} under ${home}/sessions — the thread may be deleted/archived; delivery will fail with thread_not_found`,
    );
  }

  // Service freshness.
  add(
    "appserver_teardown_fence",
    !snapshot.service.teardownPoisoned,
    snapshot.service.teardownPoisoned
      ? `startup blocked at ${snapshot.service.teardownPoisonPath}; verify/reboot so the old App Server tree is gone, then remove this file explicitly`
      : "no unverified prior App Server teardown",
  );

  add(
    "service_lease",
    !snapshot.service.teardownPoisoned
      && !snapshot.service.leaseUnreadable
      && (snapshot.service.running || (!snapshot.service.staleLease && snapshot.bindings.length === 0)),
    snapshot.service.teardownPoisoned
      ? "service startup is fenced by an unverified prior App Server teardown"
      : snapshot.service.leaseUnreadable
        ? `lease is unreadable/invalid at ${snapshot.service.leasePath}; inspect and recover it explicitly`
      : snapshot.service.running
      ? `daemon pid ${snapshot.service.pid} healthy`
      : snapshot.service.staleLease
        ? "stale lease on disk; run: agent-bridge codex service ensure"
        : snapshot.bindings.length > 0
          ? "no daemon running but bindings exist; run: agent-bridge codex service ensure"
          : "no daemon (no bindings yet — fine)",
  );

  // MCP registration for outbound tools inside Codex tasks (advisory).
  const configToml = join(home, "config.toml");
  let mcpRegistered = false;
  try {
    const raw = readFileSync(configToml, "utf8");
    mcpRegistered = /\[mcp_servers\.[^\]]*agent[-_]bridge[^\]]*\]/i.test(raw) || /agent-bridge\/mcp-server\/build\/index\.js/.test(raw);
  } catch { /* missing config.toml */ }
  add(
    "codex_mcp_registration",
    mcpRegistered,
    mcpRegistered
      ? "agent-bridge MCP server appears registered in ~/.codex/config.toml"
      : "agent-bridge MCP server not detected in ~/.codex/config.toml — outbound bridge_send_message from Codex tasks needs it (see codex-channel/README.md). CLI fallback `agent-bridge codex send` still works.",
  );

  // Dead letters.
  add(
    "dead_letters",
    snapshot.deadLetterCount === 0,
    snapshot.deadLetterCount === 0
      ? "none"
      : `${snapshot.deadLetterCount} dead-lettered message(s) in inbox/.failed/.exhausted/`,
  );

  for (const u of snapshot.unboundAliasDirs) {
    add(`unbound_inbox:${u.alias}`, false, `${u.pending} pending message(s) for unbound alias "${u.alias}"`);
  }

  return { snapshot, checks };
}

export function formatDoctor({ snapshot, checks }) {
  const lines = [formatStatus(snapshot), "", "doctor checks:"];
  for (const c of checks) {
    lines.push(`  [${c.ok ? "ok" : "!!"}] ${c.name}: ${c.detail}`);
  }
  const failing = checks.filter((c) => !c.ok).length;
  lines.push("");
  lines.push(failing === 0 ? "all checks passed" : `${failing} check(s) need attention`);
  return lines.join("\n");
}
