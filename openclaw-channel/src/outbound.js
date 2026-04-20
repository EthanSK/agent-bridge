/**
 * Outbound delivery: SCP a BridgeMessage reply to the originating machine.
 *
 * We avoid any npm dependency and reuse the same SSH key layout as the rest
 * of agent-bridge:
 *   ~/.agent-bridge/keys/agent-bridge_<remote-name>  (private key)
 *   ~/.agent-bridge/config                            (pairing registry)
 *
 * To deliver a reply we:
 *   1. Resolve the remote machine by name via the pairing registry.
 *   2. Write the reply JSON to a temp file under ~/.agent-bridge/outbound/.
 *   3. `scp -i <key> <tmp> <user>@<host>:~/.agent-bridge/inbox/<id>.json`
 *
 * The remote's inbox-watcher (or Claude Code channel plugin) then picks it up
 * and pushes it into the running session.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const AGENT_BRIDGE_HOME = join(homedir(), ".agent-bridge");
const DEFAULT_OUTBOUND = join(AGENT_BRIDGE_HOME, "outbound");
const DEFAULT_KEYS_DIR = join(AGENT_BRIDGE_HOME, "keys");
const DEFAULT_CONFIG = join(AGENT_BRIDGE_HOME, "config");

/**
 * Look up a paired machine in ~/.agent-bridge/config.
 * Returns { user, host, port } or null.
 */
export function resolvePairedMachine(name, configPath = DEFAULT_CONFIG) {
  if (!existsSync(configPath)) return null;
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  const machines = cfg?.machines ?? {};
  const entry = machines[name];
  if (!entry) return null;
  return {
    user: entry.user ?? entry.username ?? "root",
    host: entry.host ?? entry.address ?? null,
    port: entry.port ?? 22,
  };
}

/**
 * SCP a BridgeMessage to `<remote>:~/.agent-bridge/inbox/<id>.json`.
 *
 * @param {object} opts
 * @param {object} opts.message - BridgeMessage envelope
 * @param {string} opts.toMachine
 * @param {string} [opts.keysDir]
 * @param {string} [opts.outboundDir]
 * @param {string} [opts.configPath]
 * @param {object} [opts.logger]
 */
export async function deliverReply(opts) {
  const log = opts.logger ?? console;
  const keysDir = opts.keysDir ?? DEFAULT_KEYS_DIR;
  const outboundDir = opts.outboundDir ?? DEFAULT_OUTBOUND;
  const configPath = opts.configPath ?? DEFAULT_CONFIG;
  const msg = opts.message;
  const toMachine = opts.toMachine;

  const target = resolvePairedMachine(toMachine, configPath);
  if (!target || !target.host) {
    throw new Error(`paired machine "${toMachine}" not found in ${configPath}`);
  }

  const keyPath = join(keysDir, `agent-bridge_${toMachine}`);
  if (!existsSync(keyPath)) {
    throw new Error(`no SSH key for machine "${toMachine}" at ${keyPath}`);
  }

  mkdirSync(outboundDir, { recursive: true });
  const tmpPath = join(outboundDir, `${msg.id}.json`);
  writeFileSync(tmpPath, JSON.stringify(msg, null, 2));

  const remoteInbox = `~/.agent-bridge/inbox/${msg.id}.json`;
  const scpArgs = [
    "-i",
    keyPath,
    "-P",
    String(target.port ?? 22),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    tmpPath,
    `${target.user}@${target.host}:${remoteInbox}`,
  ];

  log.debug?.(`scp -> ${target.user}@${target.host}:${remoteInbox}`);

  try {
    await runCommand("scp", scpArgs, log);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function runCommand(cmd, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (b) => log.debug?.(String(b).trim()));
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export function localMachineName() {
  // Prefer an env override so users running on renamed hosts can pin it.
  return process.env.AGENT_BRIDGE_MACHINE_NAME || hostname();
}
