/**
 * Outbound delivery: SFTP a BridgeMessage reply to the originating machine.
 *
 * We avoid any npm dependency and reuse the same SSH key layout as the rest
 * of agent-bridge:
 *   ~/.agent-bridge/keys/agent-bridge_<remote-name>  (private key)
 *   ~/.agent-bridge/config                            (pairing registry)
 *
 * To deliver a reply we:
 *   1. Resolve the remote machine by name via the pairing registry.
 *   2. Write the reply JSON to a temp file under ~/.agent-bridge/outbound/.
 *   3. `sftp -b - <user>@<host>` with an atomic put-to-tmp + rename into
 *      `~/.agent-bridge/inbox/<target>/<id>.json`.
 *
 * The remote's inbox-watcher (or Claude Code channel plugin) then picks it up
 * and pushes it into the running session.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const AGENT_BRIDGE_HOME = join(homedir(), ".agent-bridge");
const DEFAULT_OUTBOUND = join(AGENT_BRIDGE_HOME, "outbound");
const DEFAULT_KEYS_DIR = join(AGENT_BRIDGE_HOME, "keys");
const DEFAULT_CONFIG = join(AGENT_BRIDGE_HOME, "config");
const DEFAULT_INBOX = join(AGENT_BRIDGE_HOME, "inbox");
const DEFAULT_OUTBOX = join(AGENT_BRIDGE_HOME, "outbox");
const DEFAULT_MACHINE_NAME_FILE = join(AGENT_BRIDGE_HOME, "machine-name");
const DEFAULT_IDENTITY = join(AGENT_BRIDGE_HOME, ".identity");

/**
 * Reserved machine-name aliases that always resolve to the local machine.
 * Mirror of mcp-server/src/config.ts :: LOCAL_MACHINE_ALIASES — keep in sync.
 *
 * Same-machine delivery (3.5.1+) lets `deliverReply` write the BridgeMessage
 * JSON straight to `~/.agent-bridge/inbox/<target>/<id>.json` without any SSH
 * hop when the target machine resolves to this host. The local machine is
 * identified by EITHER its real name (matches `localMachineName()`,
 * case-insensitive) or one of these reserved aliases.
 */
export const LOCAL_MACHINE_ALIASES = ["local", "self", "localhost"];

/**
 * Return true when `name` refers to the local machine — either the real
 * machine name or a reserved alias like "local" / "self" / "localhost".
 *
 * Mirror of mcp-server/src/config.ts :: isLocalMachineName — keep in sync.
 *
 * @param {string|undefined|null} name
 * @param {object} [opts] - same shape as `localMachineName(opts)` for tests
 * @returns {boolean}
 */
export function isLocalMachineName(name, opts = {}) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (LOCAL_MACHINE_ALIASES.includes(lower)) return true;
  return lower === localMachineName(opts).toLowerCase();
}

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
 * Deliver a BridgeMessage reply to the local machine — no SSH.
 *
 * Same-machine delivery (3.5.1+) writes directly to
 * `~/.agent-bridge/inbox/<target>/<id>.json` using an atomic temp-file +
 * rename, mirroring `mcp-server/src/inbox.ts :: sendLocalMessage`. Use this
 * when the reply target resolves to this host (matches `localMachineName()`
 * or one of `LOCAL_MACHINE_ALIASES`).
 *
 * @param {object} opts
 * @param {object} opts.message - BridgeMessage envelope (must include `target`)
 * @param {string} opts.toMachine - the machine name supplied by the caller (logging only)
 * @param {string} [opts.inboxDir]
 * @param {string} [opts.outboxDir]
 * @param {object} [opts.logger]
 */
export function deliverReplyLocal(opts) {
  const log = opts.logger ?? console;
  const inboxDir = opts.inboxDir ?? DEFAULT_INBOX;
  const outboxDir = opts.outboxDir ?? DEFAULT_OUTBOX;
  const msg = opts.message;
  const toMachine = opts.toMachine;
  const targetName = msg.target;

  if (!isValidTarget(targetName)) {
    throw new Error(`BridgeMessage.target is required for agent-bridge delivery and must be explicit. Got: ${JSON.stringify(targetName ?? null)}`);
  }

  const targetDir = join(inboxDir, targetName);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }

  const finalPath = join(targetDir, `${msg.id}.json`);
  // Atomic write: temp file in the same directory, then rename. Mirrors
  // mcp-server's sendLocalMessage so the inbox watcher sees a fully-formed
  // JSON file appear in a single rename event — never a partial write.
  const tmpPath = join(targetDir, `.agent-bridge-${randomUUID()}.tmp`);
  const content = JSON.stringify(msg, null, 2);

  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`Failed to deliver agent-bridge reply locally: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Best-effort outbox copy for debugging, mirroring the SSH path.
  try {
    if (!existsSync(outboxDir)) {
      mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(outboxDir, `${msg.id}.json`), content, { mode: 0o600 });
  } catch (err) {
    log.debug?.(`outbox copy skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  log.info?.(
    `agent-bridge reply delivered locally id=${msg.id} to=${toMachine} target=${targetName}`
    + (msg.replyTo ? ` replyTo=${msg.replyTo}` : ""),
  );
}

/**
 * SFTP a BridgeMessage to `<remote>:~/.agent-bridge/inbox/<target>/<id>.json`.
 *
 * As of 3.5.1 this also handles the same-machine case: when `toMachine`
 * resolves to the local host (real name or one of `LOCAL_MACHINE_ALIASES`),
 * the call short-circuits to `deliverReplyLocal` — no SSH, no paired-machine
 * lookup. Cross-machine delivery uses the SFTP subsystem rather than remote
 * shell commands so Windows OpenSSH targets work even when the login shell is
 * cmd.exe.
 *
 * @param {object} opts
 * @param {object} opts.message - BridgeMessage envelope
 * @param {string} opts.toMachine
 * @param {string} [opts.keysDir]
 * @param {string} [opts.outboundDir]
 * @param {string} [opts.configPath]
 * @param {string} [opts.inboxDir]
 * @param {string} [opts.outboxDir]
 * @param {object} [opts.localNameOpts] - forwarded to `localMachineName` for tests
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

  // Same-machine fast path (3.5.1+): if the reply target is this host, write
  // straight to the local inbox. Avoids the "paired machine not found" error
  // when an OpenClaw embedded agent replies to a same-machine sender (e.g.
  // Mini-Claude on the same box).
  if (isLocalMachineName(toMachine, opts.localNameOpts)) {
    deliverReplyLocal({
      message: msg,
      toMachine,
      inboxDir: opts.inboxDir,
      outboxDir: opts.outboxDir,
      logger: log,
    });
    return;
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

  const remoteInbox = `~/.agent-bridge/inbox/${targetName}/${msg.id}.json`;
  const normalizedRemoteInbox = normalizeSftpPath(remoteInbox);
  const remoteTmp = `${normalizedRemoteInbox}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  const sftpBatch = buildSftpBatch(tmpPath, remoteTmp, normalizedRemoteInbox);
  const sftpArgs = [
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-P",
    String(endpointPort),
    "-b",
    "-",
    `${target.user}@${endpointHost}`,
  ];

  log.debug?.(`sftp -> ${target.user}@${endpointHost}:${remoteInbox}`);

  try {
    await runCommand("sftp", sftpArgs, log, commandTimeoutMs, sftpBatch);
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

/**
 * Normalize a remote path for SFTP delivery.
 *
 * Windows OpenSSH's SFTP subsystem does not expand a leading `~/`, while
 * Unix-like SFTP servers normally start the session in the user's home
 * directory. Strip the prefix and use a home-relative path that works on
 * macOS, Linux, and Windows.
 */
export function normalizeSftpPath(remotePath) {
  if (remotePath.startsWith("~/")) return remotePath.slice(2);
  if (remotePath === "~") return ".";
  return remotePath;
}

/**
 * Return the progressive parent directories for an SFTP destination. SFTP's
 * `mkdir` is not recursive, so the batch emits `-mkdir` for each ancestor.
 */
export function sftpParentDirs(path) {
  const parts = path.split("/").filter((part) => part.length > 0 && part !== ".");
  parts.pop();
  if (parts.length === 0) return [];
  const acc = [];
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : (path.startsWith("/") ? `/${part}` : part);
    acc.push(prefix);
  }
  return acc;
}

function quoteSftpPath(path) {
  return `"${String(path).replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Build an SFTP batch script for atomic delivery: create parent directories,
 * upload to a hidden temporary path, then rename to the final `.json`.
 */
export function buildSftpBatch(localFile, remoteTmp, remoteFinal) {
  const lines = [];
  for (const dir of sftpParentDirs(remoteFinal)) {
    lines.push(`-mkdir ${quoteSftpPath(dir)}`);
  }
  lines.push(`put ${quoteSftpPath(localFile)} ${quoteSftpPath(remoteTmp)}`);
  lines.push(`rename ${quoteSftpPath(remoteTmp)} ${quoteSftpPath(remoteFinal)}`);
  lines.push("bye");
  return lines.join("\n") + "\n";
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

function runCommand(cmd, args, log, timeoutMs, stdin = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
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
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
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
