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
 *   3. `scp -i <key> <tmp> <user>@<host>:~/.agent-bridge/inbox/<target>/<id>.json`
 *
 * The remote's inbox-watcher (or Claude Code channel plugin) then picks it up
 * and pushes it into the running session.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

const AGENT_BRIDGE_HOME = join(homedir(), ".agent-bridge");
const DEFAULT_OUTBOUND = join(AGENT_BRIDGE_HOME, "outbound");
const DEFAULT_KEYS_DIR = join(AGENT_BRIDGE_HOME, "keys");
const DEFAULT_CONFIG = join(AGENT_BRIDGE_HOME, "config");
const DEFAULT_MACHINE_NAME_FILE = join(AGENT_BRIDGE_HOME, "machine-name");
const DEFAULT_IDENTITY = join(AGENT_BRIDGE_HOME, ".identity");

/**
 * Look up a paired machine in ~/.agent-bridge/config.
 * Returns { user, host, port, key } or null.
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
    return resolvePairedMachineFromIni(name, raw);
  }
  const machines = cfg?.machines ?? {};
  const entry = machines[name];
  if (!entry) return null;
  return {
    user: entry.user ?? entry.username ?? "root",
    host: entry.host ?? entry.address ?? null,
    port: entry.port ?? 22,
    key: entry.key ? expandHome(entry.key) : null,
  };
}

function resolvePairedMachineFromIni(name, raw) {
  const targetName = String(name).toLowerCase();
  let inSection = false;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inSection = section[1].toLowerCase() === targetName;
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(/^(\w+)=(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  if (!fields.host || !fields.user) return null;
  return {
    user: fields.user,
    host: fields.host,
    port: Number.parseInt(fields.port ?? "22", 10) || 22,
    key: fields.key ? expandHome(fields.key) : null,
  };
}

function expandHome(path) {
  if (typeof path !== "string") return path;
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * SCP a BridgeMessage to `<remote>:~/.agent-bridge/inbox/<target>/<id>.json`.
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
  const targetName = msg.target;

  if (!isValidTarget(targetName)) {
    throw new Error(`BridgeMessage.target is required for agent-bridge delivery and must be explicit. Got: ${JSON.stringify(targetName ?? null)}`);
  }

  const target = resolvePairedMachine(toMachine, configPath);
  if (!target || !target.host) {
    throw new Error(`paired machine "${toMachine}" not found in ${configPath}`);
  }

  const keyPath = target.key ?? join(keysDir, `agent-bridge_${toMachine}`);
  if (!existsSync(keyPath)) {
    throw new Error(`no SSH key for machine "${toMachine}" at ${keyPath}`);
  }

  mkdirSync(outboundDir, { recursive: true });
  const tmpPath = join(outboundDir, `${msg.id}.json`);
  writeFileSync(tmpPath, JSON.stringify(msg, null, 2));

  const remoteDir = `~/.agent-bridge/inbox/${targetName}`;
  const remoteTmpName = `.${msg.id}.${process.pid}.${Date.now()}.tmp`;
  const remoteTmp = `${remoteDir}/${remoteTmpName}`;
  const remoteInbox = `${remoteDir}/${msg.id}.json`;
  const sshBaseArgs = [
    "-i",
    keyPath,
    "-p",
    String(target.port ?? 22),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `${target.user}@${target.host}`,
  ];
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
    `${target.user}@${target.host}:${remoteTmp}`,
  ];

  log.debug?.(`scp -> ${target.user}@${target.host}:${remoteInbox}`);

  try {
    await runCommand("ssh", [
      ...sshBaseArgs,
      `mkdir -p "$HOME/.agent-bridge/inbox/${targetName}"`,
    ], log);
    await runCommand("scp", scpArgs, log);
    await runCommand("ssh", [
      ...sshBaseArgs,
      `mv -f "$HOME/.agent-bridge/inbox/${targetName}/${remoteTmpName}" "$HOME/.agent-bridge/inbox/${targetName}/${msg.id}.json"`,
    ], log);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function isValidTarget(target) {
  // Mirror of mcp-server/src/config.ts :: isValidTarget — Unicode-aware. Keep in sync.
  if (typeof target !== "string" || !target) return false;
  if (target.length > 256) return false;
  if (target.includes("..")) return false;
  if (target.startsWith("/") || target.endsWith("/")) return false;
  if (target.includes("//")) return false;
  const segmentPattern = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_\.-]*[\p{L}\p{N}_])?$/u;
  return target.split("/").every((segment) => segmentPattern.test(segment));
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

export function localMachineName(opts = {}) {
  const env = opts.env ?? process.env;
  const nameFilePath = opts.nameFilePath ?? DEFAULT_MACHINE_NAME_FILE;
  const identityPath = opts.identityPath ?? DEFAULT_IDENTITY;
  const getHostname = opts.getHostname ?? hostname;

  // Explicit override wins, unchanged.
  const override =
    typeof env?.AGENT_BRIDGE_MACHINE_NAME === "string"
      ? env.AGENT_BRIDGE_MACHINE_NAME.trim()
      : "";
  if (override) return override;

  // Match the MCP server / README contract for a pinned local name.
  const pinnedName = readNonEmptyFile(nameFilePath);
  if (pinnedName) return pinnedName;

  // Reuse the setup-time identity when available so reply labels stay stable
  // even if the OS hostname later changes.
  const identityName = machineNameFromIdentity(identityPath);
  if (identityName) return identityName;

  // Final fallback mirrors the CLI's get_machine_name() behavior.
  return normalizeHostname(getHostname());
}

function readNonEmptyFile(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function machineNameFromIdentity(identityPath) {
  const keyPath = readNonEmptyFile(identityPath);
  if (!keyPath) return "";
  const base = basename(expandHome(keyPath));
  if (!base.startsWith("agent-bridge_")) return "";
  return base.slice("agent-bridge_".length).trim();
}

function normalizeHostname(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\.local$/i, "");
}
