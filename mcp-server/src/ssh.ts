/**
 * SSH execution wrapper for agent-bridge.
 * Runs commands on remote machines using the SSH keys from v1.
 *
 * Supports dual-endpoint fallback: tries LAN (host:port) first with a short
 * timeout, then falls back to internet_host:internet_port if configured.
 *
 * Logs all connection attempts and results.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type MachineConfig } from './config.js';
import { logDebug, logError, logInfo, logWarn } from './logger.js';
import { pathOrder, writePathCache, type PathKind } from './pathCache.js';

/** Timeout for the LAN attempt when an internet fallback is available. */
const LAN_CONNECT_TIMEOUT_S = 3;
/** Timeout for the internet fallback attempt. */
const INTERNET_CONNECT_TIMEOUT_S = 10;
/** Timeout when there is no fallback (single endpoint). */
const DEFAULT_CONNECT_TIMEOUT_S = 10;

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
function buildSSHArgs(
  machine: MachineConfig,
  host: string,
  port: number,
  connectTimeoutS: number,
  clientLogFile?: string,
): string[] {
  const args = [
    '-i', machine.key,
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
   * Force a LAN-first probe regardless of the last-reachable-path cache.
   * Used by status/health checks that want an authoritative answer.
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

function shellDoubleQuotePath(path: string): string {
  const escapeDoubleQuoted = (value: string): string =>
    value.replace(/(["\\$`])/g, '\\$1');
  if (path.startsWith('~/')) {
    return `"${'${HOME}'}/${escapeDoubleQuoted(path.slice(2))}"`;
  }
  return `"${escapeDoubleQuoted(path)}"`;
}

/**
 * Resolve the endpoint tuple for a given path attempt.
 */
function endpointFor(machine: MachineConfig, kind: PathKind): { host: string; port: number; timeoutS: number; label: string } {
  if (kind === 'lan') {
    return {
      host: machine.host,
      port: machine.port,
      timeoutS: machine.internetHost ? LAN_CONNECT_TIMEOUT_S : DEFAULT_CONNECT_TIMEOUT_S,
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
 * Run a command on a remote machine via SSH.
 *
 * When the machine has an internet_host configured, uses the last-reachable-
 * path cache to pick which endpoint to try first. A successful connection
 * (SSH exit code != 255) updates the cache. On connection failure (exit 255),
 * tries the alternate endpoint. Remote-command failures (non-255, non-zero)
 * are NOT treated as path failures — they're returned as-is.
 *
 * Pass `bypassPathCache: true` to force a LAN-first probe (used by status
 * checks).
 */
export async function sshExec(
  machine: MachineConfig,
  command: string,
  timeoutMs: number = 30000,
  opts: SSHExecOptions = {},
): Promise<SSHResult> {
  if (!existsSync(machine.key)) {
    throw new Error(`SSH key not found: ${machine.key}`);
  }

  const hasInternetFallback = !!machine.internetHost;
  logDebug(`SSH exec to ${machine.name} (${machine.host}:${machine.port}): ${command.substring(0, 200)}`);

  // No fallback configured — single endpoint path, but still cache the result
  // so future multi-path callers start from the right place. Retry on
  // transient client-side failures ("Address already in use") so a flaky
  // ephemeral-port allocation doesn't surface as an outright SSH failure.
  if (!hasInternetFallback) {
    const ep = endpointFor(machine, 'lan');
    let result: SSHResult | undefined;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
      const backoff = RETRY_BACKOFFS_MS[attempt];
      if (backoff > 0) {
        logDebug(`SSH to ${machine.name} (single-endpoint): transient failure, backing off ${backoff}ms before retry ${attempt}/${RETRY_BACKOFFS_MS.length - 1}`);
        await sleep(backoff);
      }
      result = await sshExecSingle(
        machine, ep.host, ep.port, ep.timeoutS, command, timeoutMs,
      );
      // If this looks like a transient client-side bind failure AND there
      // are retry slots left, loop. Otherwise hand back whatever we got.
      if (
        result.exitCode === 255 &&
        isConnectionFailure(result.stderr) &&
        isTransientClientFailure(result.stderr) &&
        attempt < RETRY_BACKOFFS_MS.length - 1
      ) {
        logWarn(`SSH to ${machine.name} (single-endpoint) hit transient client failure (${result.stderr.trim().split('\n').pop()}), retrying`);
        continue;
      }
      break;
    }
    // result is guaranteed defined because the loop always runs at least once.
    const finalResult = result!;
    // Exit 255 with stderr that doesn't look like an SSH-client connection
    // failure means the remote command connected and exited 255 on its own
    // — still a cache win. A genuine connection failure doesn't update cache.
    const connected = finalResult.exitCode !== 255 || !isConnectionFailure(finalResult.stderr);
    if (connected) {
      logDebug(`SSH to ${machine.name} connected via ${ep.label} (${ep.host}:${ep.port})`);
      try { writePathCache(machine.name, 'lan'); } catch { /* best effort */ }
    }
    return finalResult;
  }

  // Dual-endpoint mode. Respect the cache unless the caller asked to bypass.
  const order = pathOrder(machine.name, { bypass: opts.bypassPathCache });

  let lastErr: unknown;
  let lastResult: SSHResult | undefined;
  for (let i = 0; i < order.length; i++) {
    const kind = order[i];
    const ep = endpointFor(machine, kind);

    // Per-endpoint retry loop. Most attempts resolve on the first try; the
    // retry slots exist for transient client-side failures like "Address
    // already in use" where the kernel briefly can't allocate an ephemeral
    // source port. Real path-level failures (connection refused, no route,
    // DNS) break out immediately and fall through to the alternate path.
    let transientRetryUsed = false;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
      const backoff = RETRY_BACKOFFS_MS[attempt];
      if (backoff > 0) {
        logDebug(`SSH to ${machine.name} via ${ep.label}: transient failure, backing off ${backoff}ms before retry ${attempt}/${RETRY_BACKOFFS_MS.length - 1}`);
        await sleep(backoff);
      }

      try {
        const result = await sshExecSingle(
          machine, ep.host, ep.port, ep.timeoutS, command, timeoutMs,
        );
        lastResult = result;

        if (result.exitCode === 255) {
          // Ambiguous: could be a connection failure OR the remote command
          // itself exiting 255. Match only on SSH-client stderr signatures
          // before retrying — we must not replay a command that already ran
          // to completion.
          if (isConnectionFailure(result.stderr)) {
            // Distinguish transient client-side failures ("Address already
            // in use") from real path failures: the former retry on the
            // same endpoint, the latter fall through to the alternate path.
            if (isTransientClientFailure(result.stderr) && attempt < RETRY_BACKOFFS_MS.length - 1) {
              transientRetryUsed = true;
              logWarn(`SSH to ${machine.name} via ${ep.label} hit transient client failure (${result.stderr.trim().split('\n').pop()}), retrying on same path`);
              continue;
            }
            if (i === 0) {
              logWarn(`SSH to ${machine.name} via ${ep.label} failed (exit=255, connection failure${transientRetryUsed ? ' after retries' : ''}), trying alternate path...`);
            } else {
              logError(`SSH to ${machine.name} failed on both paths (last: ${ep.label}, exit=255)`);
            }
            break; // out of attempt loop -> next endpoint
          }
          // Remote command exited 255 on its own — SSH did connect. Record
          // the cache hit and hand back the result without retrying.
          logDebug(`SSH to ${machine.name} via ${ep.label}: remote command exited 255 (elapsed ${result.elapsedMs}ms)`);
          try { writePathCache(machine.name, kind); } catch { /* best effort */ }
          return result;
        }

        // SSH connected (even if the remote command returned non-zero). Cache the win.
        if (result.exitCode === 0) {
          logDebug(`SSH to ${machine.name} succeeded via ${ep.label} (${ep.host}:${ep.port})${transientRetryUsed ? ` after ${attempt} retry(s)` : ''}`);
        }
        try { writePathCache(machine.name, kind); } catch { /* best effort */ }
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastErr = err;

        // A process timeout is ambiguous: SSH may have connected and the command
        // may be running, so retrying could duplicate side effects. Do not update
        // the cache because this does not prove the path is healthy.
        if (errMsg.includes('timed out')) {
          logError(`SSH to ${machine.name} timed out on ${ep.label}: ${errMsg}`);
          throw err;
        }

        if (i === 0) {
          logWarn(`SSH to ${machine.name} via ${ep.label} failed (${errMsg}), trying alternate path...`);
        }
        break; // out of attempt loop -> next endpoint
      }
    }
  }

  // Both paths failed.
  if (lastResult?.exitCode === 255) {
    logError(`Machine ${machine.name} unreachable on both LAN (${machine.host}:${machine.port}) and internet (${machine.internetHost}:${machine.internetPort ?? 22})`);
    return lastResult;
  }
  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
  logError(`Machine ${machine.name} unreachable on both LAN and internet: ${errMsg}`);
  throw new Error(
    `Machine "${machine.name}" unreachable on both LAN and internet. ` +
    `LAN: ${machine.host}:${machine.port}, Internet: ${machine.internetHost}:${machine.internetPort ?? 22}`,
  );
}

/**
 * Check if a remote machine is reachable via SSH.
 *
 * Honors the last-reachable-path cache by default (fast off-LAN case). Pass
 * `bypassPathCache: true` to force a LAN-first probe — useful for "is my LAN
 * connectivity back?" style checks.
 */
export async function sshPing(
  machine: MachineConfig,
  opts: SSHExecOptions = {},
): Promise<boolean> {
  logDebug(`SSH ping to ${machine.name} (${machine.user}@${machine.host}:${machine.port})`);
  try {
    // Keep this above the 10s internet ConnectTimeout so connection failures
    // surface as SSH exit 255 and can fall back to the alternate path.
    const result = await sshExec(machine, 'echo pong', 15000, opts);
    const reachable = result.exitCode === 0 && result.stdout.trim() === 'pong';
    logInfo(`SSH ping ${machine.name}: ${reachable ? 'ONLINE' : 'OFFLINE'}`);
    return reachable;
  } catch {
    logInfo(`SSH ping ${machine.name}: OFFLINE (error)`);
    return false;
  }
}

/**
 * Write content to a file on a remote machine via SSH.
 * Uses base64 encoding for safe transport of arbitrary content
 * (JSON with quotes, newlines, backslashes, etc.).
 */
export async function sshWriteFile(
  machine: MachineConfig,
  remotePath: string,
  content: string,
  timeoutMs: number = 15000,
): Promise<SSHResult> {
  logDebug(`SSH write file to ${machine.name}: ${remotePath} (${content.length}B)`);
  // Base64-encode the content to avoid shell escaping issues with quotes,
  // newlines, backslashes, dollar signs, etc. in JSON payloads.
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const destExpr = shellDoubleQuotePath(remotePath);
  const tmpName = `.agent-bridge-${randomUUID()}.tmp`;
  // Write to a hidden temp file in the target directory and atomically rename
  // it into place. Native watchers listen for *.json creation, so direct writes
  // can expose partial JSON and lose a message if the watcher quarantines it.
  const command = [
    `dest=${destExpr}`,
    'dir="$(dirname "$dest")"',
    `tmp="$dir/${tmpName}"`,
    'mkdir -p "$dir"',
    'trap \'rm -f "$tmp"\' EXIT',
    `echo '${b64}' | base64 -d > "$tmp"`,
    'mv -f "$tmp" "$dest"',
  ].join(' && ');
  return sshExec(machine, command, timeoutMs);
}

/**
 * Read a file from a remote machine via SSH.
 */
export async function sshReadFile(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string> {
  const result = await sshExec(machine, `cat '${remotePath}'`, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read remote file ${remotePath}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * List files in a directory on a remote machine via SSH.
 */
export async function sshListFiles(
  machine: MachineConfig,
  remotePath: string,
  timeoutMs: number = 15000,
): Promise<string[]> {
  const result = await sshExec(
    machine,
    `ls -1 '${remotePath}' 2>/dev/null || true`,
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}
