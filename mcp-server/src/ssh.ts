/**
 * SSH execution wrapper for agent-bridge.
 * Runs commands on remote machines using the SSH keys from v1.
 *
 * Policy (3.4.2+): If `internet_host` is configured, ALWAYS use it — no LAN
 * fallback. Tailscale works from any network, LAN only works from home.
 * If `internet_host` is absent, LAN is the only path.
 *
 * Logs all connection attempts and results.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type MachineConfig } from './config.js';
import { logDebug, logError, logInfo, logWarn } from './logger.js';
import { writePathCache, type PathKind } from './pathCache.js';

/** Timeout for the internet (Tailscale) attempt. */
const INTERNET_CONNECT_TIMEOUT_S = 10;
/** Timeout when using the LAN endpoint (no internet configured). */
const LAN_CONNECT_TIMEOUT_S = 10;

export interface SSHResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Wall-clock milliseconds the ssh process ran for, used to disambiguate a
   * connection-timeout 255 from a remote command that returned 255 on its
   * own. Not all callers care about this — single-endpoint callers can ignore.
   */
  elapsedMs?: number;
}

/**
 * Build the common SSH argument list for a machine.
 *
 * `clientLogFile` (optional) captures ssh client-side diagnostics via `-E` at
 * INFO level so we can reliably distinguish a connection-level failure (which
 * writes well-known messages to this log) from a remote command exit. Without
 * this, SSH's default `LogLevel=ERROR` path writes some connection failures
 * silently, making exit 255 ambiguous.
 */
function identityFileFor(machine: MachineConfig): string {
  return machine.identityFile ?? machine.key;
}

export function buildSSHArgs(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  clientLogFile?: string,
): string[] {
  const identityFile = identityFileFor(machine);
  const args = [
    // [OC-FIX-CODEX-XPLAT 2026-04-29] Always pair the explicit IdentityFile
    // with IdentitiesOnly so probes do not exhaust/fall through to agent or
    // default keys before trying the bridge key.
    '-i', identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutS}`,
    '-o', 'LogLevel=ERROR',
    '-p', String(port),
  ];
  if (clientLogFile) {
    // -E writes SSH client logs to a file; -o LogLevel=INFO raises the level
    // enough to include "Connection timed out", "Permission denied", etc.
    // without polluting stderr for the caller.
    args.push('-E', clientLogFile, '-o', 'LogLevel=INFO');
  }
  args.push(`${machine.user}@${host}`);
  return args;
}

/**
 * Execute an SSH command against a specific host:port.
 * Internal helper — does not do fallback.
 */
function sshExecSingle(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  command: string,
  timeoutMs: number,
): Promise<SSHResult> {
  // Capture ssh client diagnostics into a tmpfile so we can reliably detect
  // connection failures even when the default LogLevel=ERROR path would
  // otherwise write nothing to stderr.
  const tmpDir = mkdtempSync(join(tmpdir(), 'ab-ssh-'));
  const clientLog = join(tmpDir, 'client.log');
  const args = [...buildSSHArgs(machine, host, port, connectTimeoutS, clientLog), command];

  const startedAt = Date.now();
  return new Promise<SSHResult>((resolve, reject) => {
    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      // Fold the client log into stderr so downstream classification uses a
      // single stream. If the read fails, we just get whatever stderr was.
      let clientLogText = '';
      try { clientLogText = readFileSync(clientLog, 'utf8'); } catch { /* noop */ }
      cleanup();
      resolve({
        exitCode,
        stdout,
        stderr: stderr + clientLogText,
        elapsedMs: Date.now() - startedAt,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

/** Options for tuning a single sshExec call. */
export interface SSHExecOptions {
  /**
   * Compatibility flag retained from the old cache/probe era. 3.4.2+ endpoint
   * selection remains `internet_host` when configured, otherwise LAN; callers
   * may still pass this without changing endpoint selection.
   */
  bypassPathCache?: boolean;
}

/**
 * SSH exit 255 is ambiguous: it can mean "ssh itself failed to connect" OR
 * "ssh connected fine and the remote command returned 255 on its own." For
 * non-interactive exec paths we must not retry a command that actually ran
 * to completion, so we match ONLY explicit client-emitted connection-failure
 * phrases. We deliberately avoid elapsed-time heuristics here — a
 * long-running remote command that eventually exits 255 would otherwise be
 * misclassified as a slow ConnectTimeout.
 *
 * In practice OpenSSH always prints "ssh: connect to host X port Y: ..."
 * or similar on real connection failures, so stderr sniffing is sufficient.
 */
function isConnectionFailure(stderr: string): boolean {
  // Only match phrases the ssh *client* itself emits for its own failures.
  // Generic strings like "Permission denied" or "Broken pipe" are avoided
  // because remote commands can legitimately write them to stderr.
  const patterns = [
    'ssh: connect to host',
    'ssh: Could not resolve hostname',
    'ssh_exchange_identification:',
    'kex_exchange_identification:',
    'Host key verification failed',
    'Permission denied (publickey',
    'No route to host',
    'Network is unreachable',
    'Name or service not known',
  ];
  return !!stderr && patterns.some(p => stderr.includes(p));
}

/**
 * Transient client-side failures that may succeed if retried after a brief
 * backoff. "Address already in use" shows up when the kernel transiently
 * can't bind an ephemeral source port (port-range exhaustion, lingering
 * TIME_WAIT sockets, or macOS's firewall/VPN stack churning). It's NOT a
 * path-health signal — the remote endpoint is fine, the client just couldn't
 * open a socket this instant.
 */
function isTransientClientFailure(stderr: string): boolean {
  if (!stderr) return false;
  return (
    stderr.includes('Address already in use') ||
    // Match BOTH the Linux ("Cannot assign requested address") and macOS
    // ("Can't assign requested address") wordings of EADDRNOTAVAIL by
    // checking the shared suffix.
    stderr.includes('assign requested address') ||
    stderr.includes('Resource temporarily unavailable')
  );
}

/** Sleep helper for exp-backoff retries. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delays between retry attempts within a single endpoint.
 * First attempt is at delay[0] = 0 (immediate). Subsequent attempts back off
 * at 500ms, 1500ms. Kept modest so a two-path failure finishes in under ~6s
 * including connection timeouts.
 */
const RETRY_BACKOFFS_MS = [0, 500, 1500] as const;

/**
 * Resolve the endpoint tuple for a given path attempt.
 */
function endpointFor(machine: MachineConfig, kind: PathKind): { host: string; port: number; timeoutS: number; label: string } {
  if (kind === 'lan') {
    return {
      host: machine.host,
      port: machine.port,
      timeoutS: LAN_CONNECT_TIMEOUT_S,
      label: 'LAN',
    };
  }
  return {
    host: machine.internetHost!,
    port: machine.internetPort ?? 22,
    timeoutS: INTERNET_CONNECT_TIMEOUT_S,
    label: 'internet',
  };
}

/**
 * Pick the single endpoint kind to use for this machine.
 *
 * 3.4.2+ policy: Tailscale-first, no fallback.
 *   - `internetHost` configured    -> 'internet'
 *   - `internetHost` absent        -> 'lan'
 */
function preferredEndpointKind(machine: MachineConfig): PathKind {
  return machine.internetHost ? 'internet' : 'lan';
}

/**
 * Run a command on a remote machine via SSH.
 *
 * 3.4.2+ policy: Tailscale-first, no fallback.
 *   - If `internet_host` is configured, it is the ONLY endpoint we try.
 *   - Otherwise, LAN (host:port) is the ONLY endpoint we try.
 *
 * Remote-command failures (non-255, non-zero) are returned as-is. Transient
 * client-side bind failures ("Address already in use", "Cannot assign
 * requested address", etc.) are retried a few times on the same endpoint.
 * Real connection failures are returned — callers should surface them
 * rather than silently retrying a different path.
 *
 * The `bypassPathCache` option is retained for API compatibility but is a
 * no-op in the new policy.
 */
export async function sshExec(
  machine: MachineConfig,
  command: string,
  timeoutMs: number = 30000,
  _opts: SSHExecOptions = {},
): Promise<SSHResult> {
  const identityFile = identityFileFor(machine);
  if (!existsSync(identityFile)) {
    throw new Error(`SSH key not found: ${identityFile}`);
  }

  const kind = preferredEndpointKind(machine);
  const ep = endpointFor(machine, kind);
  logDebug(
    `SSH exec to ${machine.name} via ${ep.label} (${ep.host}:${ep.port}): ` +
    `${command.substring(0, 200)}`,
  );

  // Single-endpoint path with transient-retry loop. "Address already in use"
  // and friends retry on the same endpoint; real connection failures or
  // remote-command exits are returned as-is (no fallback).
  let result: SSHResult | undefined;
  for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
    const backoff = RETRY_BACKOFFS_MS[attempt];
    if (backoff > 0) {
      logDebug(
        `SSH to ${machine.name} via ${ep.label}: transient failure, ` +
        `backing off ${backoff}ms before retry ${attempt}/${RETRY_BACKOFFS_MS.length - 1}`,
      );
      await sleep(backoff);
    }
    result = await sshExecSingle(
      machine, ep.host, ep.port, ep.timeoutS, command, timeoutMs,
    );
    if (
      result.exitCode === 255 &&
      isConnectionFailure(result.stderr) &&
      isTransientClientFailure(result.stderr) &&
      attempt < RETRY_BACKOFFS_MS.length - 1
    ) {
      logWarn(
        `SSH to ${machine.name} via ${ep.label} hit transient client failure ` +
        `(${result.stderr.trim().split('\n').pop()}), retrying on same path`,
      );
      continue;
    }
    break;
  }

  const finalResult = result!;
  const connected =
    finalResult.exitCode !== 255 || !isConnectionFailure(finalResult.stderr);
  if (connected) {
    logDebug(
      `SSH to ${machine.name} connected via ${ep.label} ` +
      `(${ep.host}:${ep.port})`,
    );
    try { writePathCache(machine.name, kind); } catch { /* best effort */ }
  } else {
    logError(
      `SSH to ${machine.name} via ${ep.label} failed ` +
      `(connection failure, ${ep.host}:${ep.port}, no fallback)`,
    );
  }
  return finalResult;
}

/** Result of `sshPingDetailed` — reachability plus which path was used. */
export interface SSHPingResult {
  reachable: boolean;
  /** The endpoint kind that was attempted (the only one we try in 3.4.2+). */
  kind: PathKind;
  /** Human-readable label matching the kind ('LAN' or 'internet'). */
  label: string;
  /** Endpoint host:port that was tried. */
  host: string;
  port: number;
}

/**
 * Check if a remote machine is reachable via SSH and report which path was
 * used. 3.4.2+ policy: single endpoint (Tailscale when configured, LAN
 * otherwise) — no fallback.
 */
export async function sshPingDetailed(
  machine: MachineConfig,
  opts: SSHExecOptions = {},
): Promise<SSHPingResult> {
  const kind = preferredEndpointKind(machine);
  const ep = endpointFor(machine, kind);
  logDebug(
    `SSH ping to ${machine.name} via ${ep.label} ` +
    `(${machine.user}@${ep.host}:${ep.port})`,
  );
  try {
    // Keep this above the 10s internet ConnectTimeout so connection failures
    // surface as SSH exit 255 rather than a top-level process timeout.
    const result = await sshExec(machine, 'echo pong', 15000, opts);
    const reachable = result.exitCode === 0 && result.stdout.trim() === 'pong';
    logInfo(`SSH ping ${machine.name}: ${reachable ? 'ONLINE' : 'OFFLINE'} via ${ep.label}`);
    return { reachable, kind, label: ep.label, host: ep.host, port: ep.port };
  } catch {
    logInfo(`SSH ping ${machine.name}: OFFLINE via ${ep.label} (error)`);
    return { reachable: false, kind, label: ep.label, host: ep.host, port: ep.port };
  }
}

/**
 * Back-compat boolean wrapper around `sshPingDetailed`. Prefer the detailed
 * variant in new call sites so the UI can surface which path was used.
 */
export async function sshPing(
  machine: MachineConfig,
  opts: SSHExecOptions = {},
): Promise<boolean> {
  return (await sshPingDetailed(machine, opts)).reachable;
}

/**
 * Normalize a remote path for SFTP delivery.
 *
 * SFTP uses forward slashes on the wire; Windows OpenSSH-sftp-server normalizes
 * forward slashes to backslashes server-side. A leading `~/` is NOT expanded by
 * Windows OpenSSH's sftp implementation — strip it and rely on the per-user
 * home directory being the SFTP session's starting cwd on every platform.
 *
 * Examples:
 *   `~/.agent-bridge/inbox/claude-code/m.json`
 *     → `.agent-bridge/inbox/claude-code/m.json`
 *   `/Users/foo/.agent-bridge/inbox/...`
 *     → `/Users/foo/.agent-bridge/inbox/...`  (left alone — absolute)
 */
export function normalizeSftpPath(remotePath: string): string {
  if (remotePath.startsWith('~/')) {
    return remotePath.slice(2);
  }
  if (remotePath === '~') {
    return '.';
  }
  return remotePath;
}

function sftpLines(lines: string[]): string {
  // [SFTP-CD-TILDE-FIX 2026-04-29] Do NOT prepend `cd ~` — SFTP starts in the
  // connecting user's home dir by default, and `cd ~` is server-implementation-
  // dependent: it works on some macOS sftp builds but fails on others (saw a
  // confirmed reproducer where `cd ~` returned "stat remote: No such file or
  // directory" against MBP while succeeding against Mac mini, blocking every
  // bridge_send_message and bridge_run_command from Windows-Claude to MBP).
  // Relative paths from CWD (= home) work consistently across all supported
  // OpenSSH-sftp-server implementations.
  return [...lines, 'bye'].join('\n') + '\n';
}

/**
 * Split a normalized SFTP path into its parent directory chain and filename.
 * Returns the list of progressive directory paths (so we can `-mkdir` each
 * one in turn — sftp's `mkdir` is single-level, not recursive). Hidden dirs
 * (`.agent-bridge`) are included; if any directory already exists `-mkdir`
 * silently ignores the error thanks to the leading `-`.
 */
export function sftpParentDirs(path: string): string[] {
  const parts = path.split('/').filter(p => p.length > 0 && p !== '.');
  // Drop the filename (last segment) — keep only directory components.
  parts.pop();
  if (parts.length === 0) return [];
  const acc: string[] = [];
  let prefix = path.startsWith('/') ? '' : '';
  for (const p of parts) {
    prefix = prefix ? `${prefix}/${p}` : (path.startsWith('/') ? `/${p}` : p);
    acc.push(prefix);
  }
  return acc;
}

/**
 * Run `sftp` against a specific endpoint with a batch script piped on stdin.
 * Internal helper — does not do endpoint fallback (mirrors sshExecSingle).
 */
export function buildSftpArgs(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
): string[] {
  const identityFile = identityFileFor(machine);
  return [
    // [OC-FIX-CODEX-XPLAT 2026-04-29] Match ssh probes: explicit key plus
    // IdentitiesOnly. SFTP bypasses the remote login shell entirely.
    '-i', identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutS}`,
    '-o', 'LogLevel=ERROR',
    '-P', String(port),
    '-b', '-', // read batch from stdin
    `${machine.user}@${host}`,
  ];
}

function sftpExecSingle(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  batch: string,
  timeoutMs: number,
): Promise<SSHResult> {
  // sftp(1) shares most flags with ssh (`-i / -o / -P`), except port is `-P`
  // instead of `-p` and the user@host is the LAST arg. We do NOT pass `-E
  // <logfile>`: macOS ships an older OpenSSH fork whose sftp(1) does not
  // accept `-E`, and adding it makes every send fail with
  // `sftp: illegal option -- E` (regression introduced in 3.8.1, fixed in
  // 3.8.2). Modern Linux/Windows OpenSSH-portable 8.6+ supports `-E` on sftp,
  // but we don't need it — the spawn stdout/stderr capture below already
  // surfaces any errors. If verbose logging is needed for ad-hoc debugging,
  // add `-v` (universally supported) instead.
  const args = buildSftpArgs(machine, host, port, connectTimeoutS);

  const startedAt = Date.now();
  return new Promise<SSHResult>((resolve, reject) => {
    const proc = spawn('sftp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`SFTP command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Write the batch script to stdin and close it so sftp processes it.
    proc.stdin.write(batch);
    proc.stdin.end();
  });
}

/** Run an SFTP batch against the preferred endpoint with transient retries. */
async function sftpExec(
  machine: MachineConfig,
  batch: string,
  timeoutMs: number,
): Promise<SSHResult> {
  const identityFile = identityFileFor(machine);
  if (!existsSync(identityFile)) {
    throw new Error(`SSH key not found: ${identityFile}`);
  }

  const kind = preferredEndpointKind(machine);
  const ep = endpointFor(machine, kind);

  let result: SSHResult | undefined;
  for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
    const backoff = RETRY_BACKOFFS_MS[attempt];
    if (backoff > 0) {
      logDebug(
        `SFTP to ${machine.name} via ${ep.label}: transient failure, ` +
        `backing off ${backoff}ms before retry ${attempt}/${RETRY_BACKOFFS_MS.length - 1}`,
      );
      await sleep(backoff);
    }
    result = await sftpExecSingle(
      machine, ep.host, ep.port, ep.timeoutS, batch, timeoutMs,
    );
    if (
      result.exitCode !== 0 &&
      isConnectionFailure(result.stderr) &&
      isTransientClientFailure(result.stderr) &&
      attempt < RETRY_BACKOFFS_MS.length - 1
    ) {
      logWarn(
        `SFTP to ${machine.name} via ${ep.label} hit transient client ` +
        `failure (${result.stderr.trim().split('\n').pop()}), retrying`,
      );
      continue;
    }
    break;
  }
  return result!;
}

function quoteSftpPath(path: string): string {
  return `"${path.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Build the SFTP batch script for an atomic file delivery.
 *
 * `localFile` is the local source path (already populated). `remoteTmp` is a
 * hidden tmp filename next to the destination. `remoteFinal` is the
 * destination filename. We `-mkdir` each ancestor directory (errors ignored
 * via the leading `-`), `put` to tmp, then `rename` tmp → final so the
 * destination appears atomically.
 *
 * Exported for unit testing; do not call directly outside of tests.
 */
export function buildSftpBatch(
  localFile: string,
  remoteTmp: string,
  remoteFinal: string,
): string {
  // [OC-FIX-CODEX-XPLAT 2026-04-29] + [SFTP-CD-TILDE-FIX 2026-04-29] Use SFTP
  // protocol operations only. Paths are relative to the connecting user's
  // home (which is sftp's CWD on connect) — DO NOT prepend `cd ~` because that
  // is server-dependent and breaks against some macOS sftp builds. Create
  // parent dirs one level at a time, upload to a temp path, then rename
  // atomically.
  const lines: string[] = [];
  for (const d of sftpParentDirs(remoteFinal)) {
    lines.push(`-mkdir ${quoteSftpPath(d)}`);
  }
  lines.push(`put ${quoteSftpPath(localFile)} ${quoteSftpPath(remoteTmp)}`);
  lines.push(`rename ${quoteSftpPath(remoteTmp)} ${quoteSftpPath(remoteFinal)}`);
  return sftpLines(lines);
}

export function buildSftpGetBatch(remotePath: string, localFile: string): string {
  return sftpLines([
    `get ${quoteSftpPath(normalizeSftpPath(remotePath))} ${quoteSftpPath(localFile)}`,
  ]);
}

export function buildSftpListBatch(remotePath: string): string {
  return sftpLines([`ls -1 ${quoteSftpPath(normalizeSftpPath(remotePath))}`]);
}

/**
 * Write content to a file on a remote machine via SFTP (3.8.1+).
 *
 * Why SFTP and not `ssh "cat > $dest"`?
 *   The previous implementation built a POSIX shell pipeline (`dest=...; mkdir
 *   -p "$dir"; ... mv -f "$tmp" "$dest"`) and ran it via `ssh`. Windows
 *   OpenSSH-server defaults to `cmd.exe` as the login shell, which doesn't
 *   know `cat`, `mv`, `mkdir -p`, or `$dest` syntax — every Windows-target
 *   send blew up with "'dest' is not recognized as an internal or external
 *   command" before any bytes hit the disk. Switching to SFTP works because:
 *
 *   1. `sftp` runs the SFTP subsystem on the remote (sftp-server.exe on
 *      Windows), bypassing the login shell entirely. Same pre-installed
 *      subsystem on macOS, Linux, and Windows OpenSSH.
 *   2. SFTP has native `put` and `rename` operations — atomic delivery
 *      doesn't need a shell-level `mv`.
 *   3. Forward-slash paths are normalized to native separators server-side
 *      on Windows. `~/` doesn't expand on Windows-sftp, so we strip it and
 *      rely on the SFTP session starting in the user's home dir on every
 *      platform.
 *
 * Atomicity: write to a hidden `.tmp.<uuid>` filename next to the destination,
 * then `rename` to the final path. Native inbox watchers listen for `*.json`
 * creation; the rename event is what they see. No `*.tmp` file ever appears
 * with the `.json` extension, so partial reads can't quarantine the message.
 *
 * The `SSHResult` shape is preserved so callers (only `inbox.ts:sendMessage`
 * today) don't need to change — `exitCode === 0` means delivered.
 */
export async function sshWriteFile(
  machine: MachineConfig,
  remotePath: string,
  content: string,
  timeoutMs: number = 15000,
): Promise<SSHResult> {
  const identityFile = identityFileFor(machine);
  if (!existsSync(identityFile)) {
    throw new Error(`SSH key not found: ${identityFile}`);
  }
  logDebug(`SFTP write file to ${machine.name}: ${remotePath} (${content.length}B)`);

  // 1. Stage the message JSON in a local temp file. SFTP's `put` reads from
  //    the local FS — we don't want to keep the bytes in argv or stdin.
  const localTmpDir = mkdtempSync(join(tmpdir(), 'ab-sftp-payload-'));
  const localFile = join(localTmpDir, `payload-${randomUUID()}.json`);
  writeFileSync(localFile, content, { mode: 0o600 });

  try {
    const normalized = normalizeSftpPath(remotePath);
    const remoteTmp = `${normalized}.tmp.${randomUUID()}`;
    const batch = buildSftpBatch(localFile, remoteTmp, normalized);

    // 2. Pick the same endpoint sshExec would (Tailscale-first, no fallback)
    //    but use SFTP so no remote login shell is involved.
    return await sftpExec(machine, batch, timeoutMs);
  } finally {
    try { rmSync(localTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Read a file from a remote machine via SFTP.
 */
export async function sshReadFile(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string> {
  // [OC-FIX-CODEX-XPLAT 2026-04-29] Remote file reads are SFTP-only; `cat`
  // depends on the target's login shell and fails under Windows cmd.exe.
  const localTmpDir = mkdtempSync(join(tmpdir(), 'ab-sftp-read-'));
  const localFile = join(localTmpDir, `payload-${randomUUID()}`);
  try {
    const result = await sftpExec(machine, buildSftpGetBatch(remotePath, localFile), timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read remote file ${remotePath}: ${result.stderr}`);
    }
    return readFileSync(localFile, 'utf8');
  } finally {
    try { rmSync(localTmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * List files in a directory on a remote machine via SFTP.
 */
export async function sshListFiles(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string[]> {
  // [OC-FIX-CODEX-XPLAT 2026-04-29] Directory listing uses the SFTP protocol,
  // not `ls`, so Windows targets with cmd.exe shells behave the same as Unix.
  const result = await sftpExec(machine, buildSftpListBatch(remotePath), timeoutMs);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}
