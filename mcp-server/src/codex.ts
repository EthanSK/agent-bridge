/**
 * Codex support surface for the agent-bridge MCP server — LAZY loader.
 *
 * PACKAGING INVARIANT: this module must import cleanly with NO codex-channel
 * present. The Claude marketplace/cache artifact contains only `mcp-server/`,
 * so a static `../../codex-channel` import chain would crash the whole
 * server before ANY tool registers (breaking existing Claude/OpenClaw tools).
 * All codex-channel access therefore happens through `getCodexSupport()`,
 * which resolves the runtime at call time from, in order:
 *
 *   1. `AGENT_BRIDGE_SOURCE_DIR` (explicit override — always honored),
 *   2. the sibling repo layout (`<repo>/codex-channel/` next to mcp-server —
 *      the documented dev-clone posture),
 *   3. the installed runtime `~/.agent-bridge/runtime/codex-channel/`
 *      (dropped by install.sh / install.ps1),
 *   4. well-known dev-clone locations.
 *
 * When nothing resolves, the codex tools stay REGISTERED (stable tool
 * catalog) but their handlers return an actionable error — existing tools
 * are never affected.
 *
 * No persona/lease involvement: everything here is plain tool-call work
 * against durable files plus an optional detached daemon spawn.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Loose runtime types (runtime is dynamically imported, not compiled-in) ──

export interface CodexBindingPolicy {
  steering: boolean;
  ownershipGuard: boolean;
  approvalPolicy: string;
  sandbox: string;
  turnTimeoutMs: number | null;
}

export interface CodexBinding {
  alias: string;
  threadId: string;
  cwd: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  boundBy: string;
  policy: CodexBindingPolicy;
}

export interface CodexEnsureResult {
  spawned: boolean;
  pid: number | null;
  skipped?: boolean;
  staleVersion?: boolean;
  unverified?: boolean;
  teardownPoisoned?: boolean;
  poison?: Record<string, unknown>;
}

export interface CodexEnsureStatus extends CodexEnsureResult {
  healthy: boolean;
  message: string;
  error?: string;
}

export interface CodexSupport {
  bindAlias: (params: Record<string, unknown>) => { binding: CodexBinding; replaced: CodexBinding | null };
  bindAutomaticCodexAlias: (params: Record<string, unknown>) => Promise<{
    binding: CodexBinding;
    replaced: CodexBinding | null;
    aliasResolution: {
      source: string;
      reused: boolean;
      title: string | null;
      metadataWarning: string | null;
    };
  }>;
  getBinding: (alias: string, opts?: Record<string, unknown>) => CodexBinding | null;
  listBindings: (opts?: Record<string, unknown>) => CodexBinding[];
  unbindAlias: (alias: string, opts?: Record<string, unknown>) => CodexBinding | null;
  codexTargetForAlias: (alias: string) => string;
  isValidThreadId: (threadId: string) => boolean;
  normalizeThreadId: (threadId: string) => string;
  SANDBOX_MODES: readonly string[];
  APPROVAL_POLICIES: readonly string[];
  findRolloutForThread: (threadId: string, opts?: Record<string, unknown>) => { path: string; mtimeMs: number } | null;
  buildStatusSnapshot: (opts?: Record<string, unknown>) => Record<string, unknown> & {
    service: { running: boolean; pid: number | null };
    bindings: Array<Record<string, unknown>>;
    deadLetterCount: number;
  };
  formatStatus: (snapshot: Record<string, unknown>) => string;
  ensureService: (opts?: Record<string, unknown>) => Promise<CodexEnsureResult>;
  describeEnsureResult: (result: CodexEnsureResult) => { ok: boolean; message: string };
  /** Absolute dir the runtime was loaded from (diagnostics). */
  runtimeDir: string;
}

let cachedSupport: CodexSupport | null = null;
let cachedError: string | null = null;

function isAbsoluteBridgePath(value: string, platform: string, pathApi: typeof posix | typeof win32): boolean {
  if (platform !== 'win32') return pathApi.isAbsolute(value);
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  // Require a complete UNC server/share. Root-relative and drive-relative
  // paths vary with cwd/drive and can split the singleton service lease.
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(value);
}

/**
 * Resolve the bridge state dir. Honors AGENT_BRIDGE_HOME (either the state
 * dir itself or a parent home dir — same normalization as the bash CLI and
 * codex-channel/src/paths.js), then HOME / USERPROFILE, then os.homedir().
 */
export function resolveBridgeHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  const configuredHome = platform === 'win32'
    ? (env.USERPROFILE?.trim() || env.HOME?.trim() || homedir())
    : (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
  const fallbackHome = isAbsoluteBridgePath(configuredHome, platform, pathApi)
    ? configuredHome
    : homedir();
  const override = env.AGENT_BRIDGE_HOME?.trim();
  if (override) {
    let expanded = override;
    if (expanded === '~') {
      expanded = fallbackHome;
    } else if (/^~[\\/]/.test(expanded)) {
      const suffix = expanded.slice(2).replace(/[\\/]+/g, pathApi.sep);
      expanded = suffix ? pathApi.join(fallbackHome, suffix) : fallbackHome;
    }

    const root = pathApi.parse(expanded).root;
    while (expanded.length > root.length && /[\\/]$/.test(expanded)) {
      expanded = expanded.slice(0, -1);
    }
    if (!isAbsoluteBridgePath(expanded, platform, pathApi)) {
      throw new Error(`AGENT_BRIDGE_HOME must resolve to an absolute path; received ${JSON.stringify(override)}`);
    }
    const leaf = pathApi.basename(expanded);
    const isStateDir = platform === 'win32'
      ? leaf.toLowerCase() === '.agent-bridge'
      : leaf === '.agent-bridge';
    return isStateDir ? expanded : pathApi.join(expanded, '.agent-bridge');
  }
  return pathApi.join(fallbackHome, '.agent-bridge');
}

/** Bindings registry path for the resolved bridge home. */
export function codexBindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBridgeHome(env), 'codex', 'bindings.json');
}

/** Pending sticky-settings journals that require daemon recovery work. */
export function codexPendingSettingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBridgeHome(env), 'codex', 'pending-settings');
}

/**
 * Whether startup supervision must ensure the codex-channel daemon.
 *
 * Enabled bindings need normal inbox delivery. Pending settings journals are
 * equally actionable even when their binding was disabled or removed: a
 * prior bridge process may have crashed after applying per-turn settings, so
 * the daemon must restart to restore them before the task is used again.
 */
export function codexEnsureRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const parsed = JSON.parse(readFileSync(codexBindingsPath(env), 'utf8')) as {
      bindings?: Record<string, { enabled?: boolean }>;
    };
    if (Object.values(parsed.bindings ?? {}).some(binding => binding && binding.enabled !== false)) {
      return true;
    }
  } catch { /* absent/unreadable registry has no enabled binding signal */ }

  try {
    return readdirSync(codexPendingSettingsDir(env), { withFileTypes: true })
      .some(entry => entry.isFile() && entry.name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Candidate codex-channel roots, in priority order. Exported for tests. */
export function codexRuntimeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const push = (v: string | undefined | null) => {
    if (typeof v === 'string' && v.trim() && !candidates.includes(v)) candidates.push(v.trim());
  };
  const override = env.AGENT_BRIDGE_SOURCE_DIR?.trim();
  if (override) push(join(override, 'codex-channel'));
  // Repo layout relative to the COMPILED build dir: build/codex.js -> ../../codex-channel
  try {
    push(fileURLToPath(new URL('../../codex-channel/', import.meta.url)));
  } catch { /* non-file URL host — skip repo-relative candidate */ }
  // Installed self-contained runtime under the RESOLVED bridge home
  // (AGENT_BRIDGE_HOME / HOME / USERPROFILE aware — required for
  // no-checkout installs to restart the daemon after reboot).
  push(join(resolveBridgeHome(env), 'runtime', 'codex-channel'));
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  push(join(home, 'Projects', 'agent-bridge', 'codex-channel'));
  push(join(home, '.openclaw', 'workspace', 'agent-bridge', 'codex-channel'));
  return candidates.filter(Boolean);
}

/**
 * Candidate daemon entrypoints (`service.mjs`) matching the runtime
 * candidates — used by index.ts's startup auto-ensure so installed-runtime
 * machines (no source checkout) still restart the daemon after reboot.
 */
export function codexServiceScriptCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return codexRuntimeCandidates(env).map((dir) => join(dir, 'service.mjs'));
}

/**
 * Resolve + dynamically import the codex-channel runtime. Cached after the
 * first success. Throws an actionable Error when unavailable — handlers
 * catch it and return a clean tool error instead of failing the server.
 */
export async function getCodexSupport(env: NodeJS.ProcessEnv = process.env): Promise<CodexSupport> {
  if (cachedSupport) return cachedSupport;
  const candidates = codexRuntimeCandidates(env);
  const failures: string[] = [];
  for (const dir of candidates) {
    try {
      if (!existsSync(join(dir, 'src', 'bindings.js'))) {
        failures.push(`${dir}: not present`);
        continue;
      }
      const mod = (spec: string) => import(pathToFileURL(join(dir, 'src', spec)).href);
      const [bindings, autoAlias, rollout, status, service] = await Promise.all([
        mod('bindings.js'),
        mod('auto-alias.js'),
        mod('rollout.js'),
        mod('status.js'),
        mod('service.js'),
      ]);
      cachedSupport = {
        bindAlias: bindings.bindAlias,
        bindAutomaticCodexAlias: autoAlias.bindAutomaticCodexAlias,
        getBinding: bindings.getBinding,
        listBindings: bindings.listBindings,
        unbindAlias: bindings.unbindAlias,
        codexTargetForAlias: bindings.codexTargetForAlias,
        isValidThreadId: bindings.isValidThreadId,
        normalizeThreadId: bindings.normalizeThreadId,
        SANDBOX_MODES: bindings.SANDBOX_MODES,
        APPROVAL_POLICIES: bindings.APPROVAL_POLICIES,
        findRolloutForThread: rollout.findRolloutForThread,
        buildStatusSnapshot: status.buildStatusSnapshot,
        formatStatus: status.formatStatus,
        ensureService: service.ensureService,
        describeEnsureResult: service.describeEnsureResult,
        runtimeDir: dir,
      };
      cachedError = null;
      return cachedSupport;
    } catch (err) {
      failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  cachedError = `codex-channel runtime not found. Searched: ${failures.join(' | ')}. `
    + 'Install it with the agent-bridge installer (which drops ~/.agent-bridge/runtime/codex-channel/), '
    + 'clone the agent-bridge repo, or set AGENT_BRIDGE_SOURCE_DIR to a checkout.';
  throw new Error(cachedError);
}

/** Test hook: clear the loader cache. */
export function _resetCodexSupportCacheForTesting(): void {
  cachedSupport = null;
  cachedError = null;
}

/**
 * Resolve the Codex thread id for a bind request: explicit tool argument,
 * then the `CODEX_THREAD_ID` env var of THIS MCP process (best-effort — the
 * always-works alternative is running `agent-bridge codex bind` inside the
 * task's own shell). Pure — needs no runtime.
 */
export function resolveCodexThreadId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { threadId: string | null; source: 'arg' | 'env' | null } {
  const fromArg = (explicit ?? '').trim();
  if (fromArg) return { threadId: fromArg.toLowerCase(), source: 'arg' };
  const fromEnv = (env.CODEX_THREAD_ID ?? '').trim();
  if (fromEnv) return { threadId: fromEnv.toLowerCase(), source: 'env' };
  return { threadId: null, source: null };
}

export interface CodexBindRequest {
  alias?: string;
  threadId?: string;
  cwd?: string;
  steering?: boolean;
  sandbox?: string;
  approvalPolicy?: string;
  rebind?: boolean;
  allowSharedThread?: boolean;
  force?: boolean;
  noEnsure?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexBindOutcome {
  binding: CodexBinding;
  replaced: CodexBinding | null;
  target: string;
  threadIdSource: 'arg' | 'env';
  aliasAutomatic: boolean;
  aliasSource: string;
  aliasTitle: string | null;
  aliasMetadataWarning: string | null;
  rolloutFound: boolean;
  serviceEnsured: CodexEnsureStatus;
}

/**
 * Shared bind flow for the MCP tool (mirrors the CLI's cmdBind semantics).
 * Throws Error with an actionable message on any validation failure —
 * including "codex-channel runtime unavailable".
 */
export async function performCodexBind(
  request: CodexBindRequest,
  supportOverride?: CodexSupport,
): Promise<CodexBindOutcome> {
  const env = request.env ?? process.env;
  const support = supportOverride ?? await getCodexSupport(env);
  const { threadId, source } = resolveCodexThreadId(request.threadId, env);
  if (!threadId) {
    throw new Error(
      'No Codex thread id available. Pass thread_id explicitly, or run `agent-bridge codex bind` '
      + 'from INSIDE the Codex task\'s shell (Codex exports CODEX_THREAD_ID there and the alias is automatic).',
    );
  }
  if (!support.isValidThreadId(threadId)) {
    throw new Error(`"${threadId}" is not a valid Codex thread id (uuid expected).`);
  }
  const rollout = support.findRolloutForThread(threadId, { env });
  if (!rollout && request.force !== true) {
    throw new Error(
      `No persisted rollout found for thread ${threadId} under $CODEX_HOME/sessions. `
      + 'Double-check the id, or pass force=true to bind anyway (e.g. custom CODEX_HOME).',
    );
  }
  if (request.sandbox !== undefined && !support.SANDBOX_MODES.includes(request.sandbox)) {
    throw new Error(`sandbox must be one of: ${support.SANDBOX_MODES.join(', ')}`);
  }
  const explicitAlias = request.alias?.trim() || null;
  const existingBinding = explicitAlias
    ? support.getBinding(explicitAlias, { env })
    : support.listBindings({ env }).find(binding => binding.threadId === threadId) ?? null;
  const effectiveSandbox = request.sandbox ?? existingBinding?.policy?.sandbox ?? 'workspace-write';
  if (effectiveSandbox === 'danger-full-access') {
    throw new Error(
      'effective sandbox=danger-full-access is not allowed via the MCP tool (including inheritance from an existing alias; '
      + 'bridge-delivered turns would run unsandboxed). Explicitly choose workspace-write/read-only, or use the CLI with '
      + 'explicit consent: agent-bridge codex bind --sandbox danger-full-access --allow-danger',
    );
  }
  if (request.approvalPolicy !== undefined && !support.APPROVAL_POLICIES.includes(request.approvalPolicy)) {
    throw new Error(`approval_policy must be one of: ${support.APPROVAL_POLICIES.join(', ')}`);
  }

  const policy: Record<string, unknown> = {};
  if (request.steering !== undefined) policy.steering = request.steering === true;
  if (request.sandbox !== undefined) policy.sandbox = request.sandbox;
  if (request.approvalPolicy !== undefined) policy.approvalPolicy = request.approvalPolicy;

  const boundBy = source === 'env' ? 'mcp(CODEX_THREAD_ID)' : 'mcp';
  let bound: { binding: CodexBinding; replaced: CodexBinding | null };
  let aliasResolution: {
    source: string;
    reused: boolean;
    title: string | null;
    metadataWarning: string | null;
  } | null = null;
  if (explicitAlias) {
    bound = support.bindAlias({
      alias: explicitAlias,
      threadId,
      cwd: request.cwd ?? null,
      boundBy,
      policy,
      rebind: request.rebind === true,
      allowSharedThread: request.allowSharedThread === true,
      env,
    });
  } else {
    const automatic = await support.bindAutomaticCodexAlias({
      threadId,
      cwd: request.cwd ?? null,
      boundBy,
      policy,
      allowDanger: false,
      env,
    });
    bound = automatic;
    aliasResolution = automatic.aliasResolution;
  }
  const { binding, replaced } = bound;

  let serviceEnsured: CodexBindOutcome['serviceEnsured'];
  if (request.noEnsure === true) {
    serviceEnsured = {
      spawned: false,
      pid: null,
      skipped: true,
      healthy: true,
      message: 'codex-channel service not ensured (no_ensure=true)',
    };
  } else {
    try {
      const ensured = await support.ensureService({ env });
      const described = support.describeEnsureResult(ensured);
      serviceEnsured = {
        ...ensured,
        healthy: described.ok,
        message: described.message,
      };
    } catch (err) {
      // Non-fatal: the binding is durable; the service can be started later.
      const error = err instanceof Error ? err.message : String(err);
      serviceEnsured = {
        spawned: false,
        pid: null,
        healthy: false,
        message: `could not ensure codex-channel service: ${error}`,
        error,
      };
    }
  }

  return {
    binding,
    replaced,
    target: support.codexTargetForAlias(binding.alias),
    threadIdSource: source as 'arg' | 'env',
    aliasAutomatic: explicitAlias === null,
    aliasSource: aliasResolution?.source ?? 'explicit',
    aliasTitle: aliasResolution?.title ?? null,
    aliasMetadataWarning: aliasResolution?.metadataWarning ?? null,
    rolloutFound: Boolean(rollout),
    serviceEnsured,
  };
}
