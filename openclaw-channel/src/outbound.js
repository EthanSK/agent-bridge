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
 * Returns { user, host, port, key, internetHost?, internetPort? } or null.
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
    internetHost: entry.internet_host ?? entry.internetHost ?? null,
    internetPort: entry.internet_port ?? entry.internetPort ?? null,
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
    internetHost: fields.internet_host || null,
    internetPort: Number.parseInt(fields.internet_port ?? "", 10) || null,
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
 * @param {number} [opts.commandTimeoutMs]
 * @param {object} [opts.logger]
 */
export async function deliverReply(opts) {
  const log = opts.logger ?? console;
  const keysDir = opts.keysDir ?? DEFAULT_KEYS_DIR;
  const outboundDir = opts.outboundDir ?? DEFAULT_OUTBOUND;
  const configPath = opts.configPath ?? DEFAULT_CONFIG;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
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

  // Mirror mcp-server / CLI policy (3.4.2+): if `internet_host` is configured,
  // use it as the sole endpoint. Otherwise use the LAN host.
  const endpointHost = target.internetHost || target.host;
  const endpointPort = target.internetHost
    ? (target.internetPort ?? target.port ?? 22)
    : (target.port ?? 22);

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
    String(endpointPort),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `${target.user}@${endpointHost}`,
  ];
  const scpArgs = [
    "-i",
    keyPath,
    "-P",
    String(endpointPort),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    tmpPath,
    `${target.user}@${endpointHost}:${remoteTmp}`,
  ];

  log.debug?.(`scp -> ${target.user}@${endpointHost}:${remoteInbox}`);

  try {
    await runCommand("ssh", [
      ...sshBaseArgs,
      `mkdir -p "$HOME/.agent-bridge/inbox/${targetName}"`,
    ], log, commandTimeoutMs);
    await runCommand("scp", scpArgs, log, commandTimeoutMs);
    await runCommand("ssh", [
      ...sshBaseArgs,
      `mv -f "$HOME/.agent-bridge/inbox/${targetName}/${remoteTmpName}" "$HOME/.agent-bridge/inbox/${targetName}/${msg.id}.json"`,
    ], log, commandTimeoutMs);
    log.info?.(
      `agent-bridge reply delivered id=${msg.id} to=${toMachine} target=${targetName}`
      + (msg.replyTo ? ` replyTo=${msg.replyTo}` : ""),
    );
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

function runCommand(cmd, args, log, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
        killTimer.unref?.();
      } catch {
        /* ignore */
      }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    child.stdout.on("data", (b) => log.debug?.(String(b).trim()));
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    child.on("error", (err) => finish(reject, err));
    child.on("exit", (code) => {
      if (code === 0) return finish(resolve);
      finish(reject, new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
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
