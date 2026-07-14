/**
 * Configuration loader for agent-bridge.
 * Reads the INI-style config from ~/.agent-bridge/config
 * and SSH key paths from ~/.agent-bridge/keys/
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, hostname } from 'os';
import { basename, join } from 'path';

/**
 * 4.0.0 — semver string for the agent-bridge MCP server build. Single source
 * of truth shared between `index.ts` (server.version + status tool) and
 * `watcher.ts` (lease file `version` field used by Patch F's stale-version
 * peer-kill path). Bump this in lockstep with `package.json`,
 * `.claude-plugin/plugin.json`, and the bash CLI's VERSION constant.
 *
 * 4.0.0 (breaking) — persona-based multi-session inbox routing. The
 * `inbox/claude-code/` singleton is now `inbox/claude-code/<persona>/`.
 * Senders that still address `target=claude-code` are routed to the
 * `default` persona's subdir on the receiver side. Multiple Claude Code
 * sessions on the same machine can now coexist via distinct
 * `AGENT_BRIDGE_PERSONA` values without racing for one shared inbox.
 * `AGENT_BRIDGE_ROLE`, `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`, and
 * `AGENT_BRIDGE_DISABLE_WATCHER` were removed in 4.0.0; persona +
 * cmdline-fallback fully supersede them.
 */
export const MCP_SERVER_VERSION = '4.9.2';

/**
 * 4.0.0 — persona env var that identifies this Claude Code instance for
 * inbox routing. Set this in your shell alias / `.zshrc` next to the
 * `--channels plugin:agent-bridge` flag, e.g.:
 *
 *   alias claude='AGENT_BRIDGE_PERSONA=default claude'
 *   alias claude-yolo='AGENT_BRIDGE_PERSONA=yolo claude'
 *
 * When unset and the parent process command line includes
 * `--channels plugin:agent-bridge` (or
 * `--dangerously-load-development-channels plugin:agent-bridge`), the
 * MCP child falls back to persona `default`. When unset and no channel
 * flag is present, the MCP child runs in tools-only mode (no inbox
 * lease attempt, no watcher).
 */
export const AGENT_BRIDGE_PERSONA_ENV = 'AGENT_BRIDGE_PERSONA';

/**
 * Default persona used when:
 *   - `AGENT_BRIDGE_PERSONA` is unset AND the cmdline-fallback positively
 *     matches a Claude Code channel-capable parent, OR
 *   - A sender addresses the legacy `target=claude-code` (no slash) and
 *     the receiver routes to the default persona for backward
 *     compatibility with pre-4.0.0 senders.
 */
export const DEFAULT_PERSONA = 'default';

export const BRIDGE_DIR = join(homedir(), '.agent-bridge');
export const CONFIG_FILE = join(BRIDGE_DIR, 'config');
export const KEYS_DIR = join(BRIDGE_DIR, 'keys');
export const INBOX_DIR = join(BRIDGE_DIR, 'inbox');
export const OUTBOX_DIR = join(BRIDGE_DIR, 'outbox');
export const LOGS_DIR = join(BRIDGE_DIR, 'logs');
export const LOCKS_DIR = join(BRIDGE_DIR, 'locks');
export const MACHINE_NAME_FILE = join(BRIDGE_DIR, 'machine-name');
export const IDENTITY_FILE = join(BRIDGE_DIR, '.identity');
export const FAILED_DIR = join(INBOX_DIR, '.failed');
export const ARCHIVE_DIR = join(INBOX_DIR, '.archive');
export const UNROUTED_DIR = join(FAILED_DIR, '_unrouted');
/**
 * 3.9.0 [CONSUME-RACE] — Pending-ack staging area. After the channel callback
 * resolves (stdout JSON-RPC write succeeded) the file is moved here from the
 * inbox/<target>/ subdir while we wait for evidence the harness actually
 * rendered the message. Files in this directory are owned by the watcher
 * lease holder and are recovered on lease handover by `replayUndeliveredMessages`.
 */
export const PENDING_ACK_DIR = join(INBOX_DIR, '.pending-ack');
/** 3.9.0 [CONSUME-RACE] — exhausted retries land in `.failed/.exhausted/` */
export const EXHAUSTED_DIR = join(FAILED_DIR, '.exhausted');
export const PROCESSED_FILE = join(INBOX_DIR, '.processed');
export const DELIVERED_FILE = join(INBOX_DIR, '.delivered');

/**
 * Per-harness/per-target subdir under INBOX_DIR. Example targets:
 *   "claude-code"            — legacy alias for the default persona's inbox
 *                              (backward-compat for pre-4.0.0 senders;
 *                              receiver routes it to claude-code/default/)
 *   "claude-code/default"    — Claude Code's default persona inbox (4.0.0+)
 *   "claude-code/yolo"       — Claude Code's "yolo" persona inbox
 *   "openclaw/default"       — OpenClaw @ClawdStationMiniBot
 *   "openclaw/clawdiboi2"    — OpenClaw @Clawdiboi2bot
 *   "openclaw/clordlethird"  — OpenClaw @ClordLeThirdBot
 *
 * The MCP server (this repo) is concerned only with the `claude-code/<persona>`
 * branch; the openclaw-channel plugin owns the `openclaw/*` branch. The
 * target field on a BridgeMessage is free-form so third-party harnesses can
 * register their own subdirs without a code change here.
 *
 * 4.0.0 — `CLAUDE_CODE_TARGET` is the legacy *prefix* (still useful as the
 * harness identifier in target strings). For inbox routing always use
 * `claudeCodeTargetForPersona(persona)`.
 */
export const CLAUDE_CODE_TARGET = 'claude-code';

/**
 * 4.0.0 — Compose the persona-scoped Claude Code target string used for
 * inbox subdir routing and lease keying. e.g. persona="default" →
 * "claude-code/default", persona="yolo" → "claude-code/yolo".
 */
export function claudeCodeTargetForPersona(persona: string): string {
  return `${CLAUDE_CODE_TARGET}/${persona}`;
}

/**
 * 4.0.0 — Lease key for a given target. Slashes are folded to `__` so the
 * resulting filename is a single path segment under `LOCKS_DIR`. Keeping
 * the function in `config.ts` so both `index.ts` (Patch F lease lookup)
 * and `watcher.ts` (`tryAcquireWatcherLease`) compute the same path.
 */
export function leaseFileNameForTarget(target: string): string {
  return `${target.replaceAll('/', '__')}.watcher-lock.json`;
}

/** Per-target inbox subdir. */
export function inboxSubdir(target: string): string {
  return join(INBOX_DIR, target);
}

/** Per-target archive subdir (for delivered messages, debug tail). */
export function archiveSubdir(target: string): string {
  return join(ARCHIVE_DIR, target);
}

/** Per-target failed subdir. */
export function failedSubdir(target: string): string {
  return join(FAILED_DIR, target);
}

/**
 * 3.9.0 [CONSUME-RACE] — Per-target pending-ack subdir. Files here are
 * post-callback-resolve but pre-finalize: the channel notification has been
 * written to stdout, but we have not yet confirmed the harness actually
 * rendered the message. The hybrid AC tick either finalizes (archive +
 * markDelivered) after the early-defer window with positive alive-evidence,
 * or re-injects back into inbox/<target>/ after the 60 s safety-net window
 * with no alive-evidence.
 */
export function pendingAckSubdir(target: string): string {
  return join(PENDING_ACK_DIR, target);
}

/**
 * Validate a target string. Allowed chars: Unicode letters + Unicode digits +
 * `_`, `.`, `-`, `/`. Control chars, spaces, and filesystem-nasties are
 * rejected. Must not start or end with a slash, must not contain `..`, must
 * not contain `//`, must not be empty, and must fit within 256 chars.
 *
 * The Unicode-aware regex lets target names carry non-ASCII identifiers
 * (handy for multilingual harness names) while keeping the subdir layout
 * predictable and avoiding path traversal via a crafted `target` field on a
 * BridgeMessage from a paired machine.
 */
export function isValidTarget(target: string): boolean {
  if (!target || typeof target !== 'string') return false;
  if (target.length > 256) return false;
  if (target.includes('..')) return false;
  if (target.startsWith('/') || target.endsWith('/')) return false;
  if (target.includes('//')) return false;
  const segmentPattern = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_\.-]*[\p{L}\p{N}_])?$/u;
  return target.split('/').every(segment => segmentPattern.test(segment));
}

/** Pruning / TTL settings (overridable via environment variables) */
export const PRUNE_MAX_AGE_MS = parseInt(
  process.env.BRIDGE_PRUNE_MAX_AGE_MS ?? String(24 * 60 * 60 * 1000),
  10,
); // 24 hours
export const PRUNE_MAX_INBOX_SIZE = parseInt(
  process.env.BRIDGE_PRUNE_MAX_INBOX ?? '100',
  10,
);
export const PRUNE_INTERVAL_MS = parseInt(
  process.env.BRIDGE_PRUNE_INTERVAL_MS ?? String(5 * 60 * 1000),
  10,
); // 5 minutes
export const DEFAULT_TTL_SECONDS = parseInt(
  process.env.BRIDGE_DEFAULT_TTL ?? '86400',
  10,
); // 1 day
export const PROCESSED_FILE_MAX_SIZE = 512 * 1024; // 512 KB — rotate when exceeded
export const OUTBOX_MAX_AGE_MS = parseInt(
  process.env.BRIDGE_OUTBOX_MAX_AGE_MS ?? String(7 * 24 * 60 * 60 * 1000),
  10,
); // 7 days — outbox copies are for debugging only
export const LOG_ROTATION_MAX_FILES = parseInt(
  process.env.BRIDGE_LOG_ROTATION_MAX_FILES ?? '5',
  10,
); // keep at most N rotated log files

export interface MachineConfig {
  name: string;
  host: string;
  user: string;
  port: number;
  /** SSH private key path used for this peer. Kept for backward compatibility with pre-identity_file configs. */
  key: string;
  /** Explicit OpenSSH IdentityFile path. Preferred over `key` when both are present. */
  identityFile?: string;
  pairedAt: string;
  /** Optional internet-reachable host (e.g. a Tailscale 100.x.y.z IP or other stable overlay address). */
  internetHost?: string;
  /** Optional internet-reachable port (default: 22). */
  internetPort?: number;
}

/**
 * Ensure all required directories exist.
 */
export function ensureDirectories(): void {
  // 4.0.0 — we no longer pre-create the persona-scoped Claude Code subdirs
  // here. The watcher/inbox layers create `inbox/claude-code/<persona>/`
  // (and the archive/failed/pending-ack siblings) lazily when they know
  // their persona. Pre-creating `inbox/claude-code/` itself is still
  // useful so the legacy-migration scan in `inbox.ts` finds an existing
  // directory rather than ENOENT.
  for (const dir of [
    BRIDGE_DIR,
    INBOX_DIR,
    OUTBOX_DIR,
    LOGS_DIR,
    LOCKS_DIR,
    FAILED_DIR,
    ARCHIVE_DIR,
    UNROUTED_DIR,
    PENDING_ACK_DIR,
    EXHAUSTED_DIR,
    inboxSubdir(CLAUDE_CODE_TARGET),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * Parse the INI-style config file and return all machine configs.
 */
export function loadConfig(): MachineConfig[] {
  if (!existsSync(CONFIG_FILE)) {
    return [];
  }

  const content = readFileSync(CONFIG_FILE, 'utf8');
  return parseConfigContent(content);
}

/**
 * Parse the INI-style config content. Exported for tests.
 */
export function parseConfigContent(content: string): MachineConfig[] {
  const machines: MachineConfig[] = [];
  let current: Partial<MachineConfig> | null = null;

  const pushCurrent = () => {
    if (!current?.name) return;
    // [OC-FIX-CODEX-XPLAT 2026-04-29] Prefer the explicit identity_file
    // schema field while preserving the historical `key=` name so old configs
    // and older CLIs continue to interoperate.
    if (current.identityFile && !current.key) current.key = current.identityFile;
    if (current.key && !current.identityFile) current.identityFile = current.key;
    machines.push(current as MachineConfig);
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();

    // Section header: [MachineName]
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      pushCurrent();
      current = { name: sectionMatch[1] };
      continue;
    }

    // Key=value pair
    if (current) {
      const kvMatch = line.match(/^(\w+)=(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        switch (key) {
          case 'host':
            current.host = value;
            break;
          case 'user':
            current.user = value;
            break;
          case 'port':
            current.port = parseInt(value, 10) || 22;
            break;
          case 'key':
            current.key = value;
            if (!current.identityFile) current.identityFile = value;
            break;
          case 'identity_file':
            current.identityFile = value;
            if (!current.key) current.key = value;
            break;
          case 'paired_at':
            current.pairedAt = value;
            break;
          case 'internet_host':
            current.internetHost = value;
            break;
          case 'internet_port':
            current.internetPort = parseInt(value, 10) || 22;
            break;
        }
      }
    }
  }

  // Push the last machine
  pushCurrent();

  // Validate that all required fields are present; skip incomplete entries
  return machines.filter(m => {
    if (!m.host || !m.user || !m.port || !m.key) {
      return false;
    }
    return true;
  });
}

/**
 * Get a specific machine by name (case-insensitive).
 *
 * Returns `undefined` for the local machine name and the reserved aliases —
 * those route through `sendLocalMessage` (no SSH), not the SSH path. Callers
 * should check `isLocalMachineName()` before falling back to "machine not
 * found" semantics.
 */
export function getMachine(name: string): MachineConfig | undefined {
  if (isLocalMachineName(name)) return undefined;
  const machines = loadConfig();
  const lower = name.toLowerCase();
  return machines.find(m => m.name.toLowerCase() === lower);
}

/**
 * Reserved machine-name aliases that always resolve to the local machine.
 *
 * Same-machine delivery (3.5.0+) lets `bridge_send_message` write directly to
 * `~/.agent-bridge/inbox/<target>/<id>.json` without going through SSH. The
 * local machine is identified by EITHER:
 *   - its real name (matches `getLocalMachineName()`, case-insensitive), or
 *   - one of these reserved aliases.
 *
 * Aliases exist so callers don't have to know the local machine's hostname —
 * useful for harness scripts and inline MCP calls. The aliases are only ever
 * routes to the local machine; pairing a remote with one of these names is
 * rejected up-front.
 */
export const LOCAL_MACHINE_ALIASES = ['local', 'self', 'localhost'] as const;

/**
 * Return true when `name` refers to the local machine — either the real
 * machine name or a reserved alias like "local" / "self" / "localhost".
 *
 * Case-insensitive. Empty / whitespace / non-string inputs return false so the
 * caller can keep its "machine not found" path for those cases.
 */
export function isLocalMachineName(name: string | undefined | null): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if ((LOCAL_MACHINE_ALIASES as readonly string[]).includes(lower)) return true;
  return lower === getLocalMachineName().toLowerCase();
}

/**
 * Get the local machine name from the config directory.
 * Falls back to hostname.
 */
export function getLocalMachineName(): string {
  const override = process.env.AGENT_BRIDGE_MACHINE_NAME?.trim();
  if (override) return override;

  const pinnedName = readNonEmptyFile(MACHINE_NAME_FILE);
  if (pinnedName) return pinnedName;

  const identityName = machineNameFromIdentity(IDENTITY_FILE);
  if (identityName) return identityName;

  return normalizeHostname(hostname());
}

function readNonEmptyFile(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function machineNameFromIdentity(identityPath: string): string {
  const keyPath = readNonEmptyFile(identityPath);
  if (!keyPath) return '';
  const base = basename(expandHome(keyPath));
  if (!base.startsWith('agent-bridge_')) return '';
  return base.slice('agent-bridge_'.length).trim();
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/\.local$/i, '');
}
