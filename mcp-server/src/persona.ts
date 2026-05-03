/**
 * 4.0.0 — Persona resolution + cmdline-fallback for the agent-bridge MCP child.
 *
 * Identity model (locked, per Ethan voice 1922 + 1924 + 1926 + 1928 + 1929):
 *
 *   - `AGENT_BRIDGE_PERSONA` is the SINGLE env var that identifies this
 *     Claude Code instance for inbox routing. When set, the MCP child
 *     watches `~/.agent-bridge/inbox/claude-code/<persona>/` and keys its
 *     watcher lease by that persona.
 *
 *   - When `AGENT_BRIDGE_PERSONA` is unset, we fall back to parsing the
 *     parent process's command line. If `--channels plugin:agent-bridge`
 *     or `--dangerously-load-development-channels plugin:agent-bridge`
 *     is present we treat the parent as a Claude Code channel host and
 *     adopt persona `default`. Otherwise we run in tools-only mode (no
 *     inbox lease attempt, no watcher).
 *
 *   - Same-persona collision (two Claude Code instances with the same
 *     `AGENT_BRIDGE_PERSONA`): the watcher-lease layer in `watcher.ts`
 *     does the arbitration via `tryAcquireWatcherLease` — first writer
 *     wins, late starters demote to tools-only-for-life. Outbound
 *     `bridge_*` tools still work in the loser.
 *
 * Removed in 4.0.0: `AGENT_BRIDGE_ROLE`, `AGENT_BRIDGE_ALLOW_NON_CHANNEL_PARENT`,
 * `AGENT_BRIDGE_DISABLE_WATCHER`. They have NO effect; persona +
 * cmdline-fallback fully supersede the role-based decision tree.
 */

import { execFileSync } from 'node:child_process';
import {
  AGENT_BRIDGE_PERSONA_ENV,
  CLAUDE_CODE_TARGET,
  DEFAULT_PERSONA,
  claudeCodeTargetForPersona,
  isValidTarget,
} from './config.js';

/**
 * The shape returned by `resolveIdentity`. The caller uses `mode` to
 * decide whether to skip the watcher (`tools-only`) or attempt to claim
 * the inbox lease (`channel-owner`).
 */
export type PersonaResolution = {
  /**
   * `'channel-owner'` when this MCP child should attempt to own the
   * Claude Code inbox lease for `target`. `'tools-only'` when it should
   * NOT attempt any inbox claim — it still serves the outbound
   * `bridge_*` tools.
   */
  mode: 'channel-owner' | 'tools-only';
  /**
   * Persona string ("default", "yolo", etc.) when `mode` is
   * `'channel-owner'`; `null` otherwise.
   */
  persona: string | null;
  /**
   * Slash-joined target string ("claude-code/default", etc.) used for
   * inbox subdir routing AND watcher-lease keying. `null` when
   * `mode === 'tools-only'`.
   */
  target: string | null;
  /**
   * Why we picked the mode/persona. One of:
   *   - `'env_var'` — `AGENT_BRIDGE_PERSONA` was set in our process env.
   *   - `'cmdline_fallback'` — env var unset, parent cmdline matches.
   *   - `'tools_only_no_channel_flag'` — env var unset, parent cmdline
   *     does not advertise channel capability.
   *   - `'tools_only_no_parent_cmdline'` — env var unset, we couldn't
   *     read the parent cmdline (Windows, perms, etc.). Conservatively
   *     run tools-only so we never silently steal the lease.
   *   - `'env_var_invalid'` — `AGENT_BRIDGE_PERSONA` was set but failed
   *     `isValidTarget` for the composed `claude-code/<persona>` target.
   */
  reason:
    | 'env_var'
    | 'cmdline_fallback'
    | 'tools_only_no_channel_flag'
    | 'tools_only_no_parent_cmdline'
    | 'env_var_invalid';
  /**
   * Diagnostic copy of the parent command line we observed (or a
   * truncated empty string when we couldn't read it). Logged in
   * post-mortem events; never used to steer the decision after `mode`
   * is set.
   */
  parentCommandLine: string;
  /**
   * Raw `AGENT_BRIDGE_PERSONA` value as observed (trimmed). Empty
   * string when unset / whitespace-only. Useful for diagnostic logging
   * even when we end up in tools-only mode.
   */
  rawPersonaEnv: string;
};

/**
 * Read the parent process's command line. Best-effort: returns an empty
 * string on Windows (no `ps`) or when the lookup fails for any reason.
 *
 * Mirrors the helper that lives inline in `index.ts` for Patch F. Kept
 * separate here so unit tests can exercise the cmdline-fallback without
 * spawning the full server.
 */
export function readParentCommandLine(ppid: number = process.ppid): string {
  try {
    return execFileSync('ps', ['-p', String(ppid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Parse a parent command line and return `true` when it looks like a
 * Claude Code channel host (Claude Code desktop, VS Code Claude Code,
 * or any Claude Code session that loaded the agent-bridge channel
 * plugin via `--channels` / `--dangerously-load-development-channels`).
 *
 * 4.0.0 tightens the check to require the plugin name `agent-bridge` in
 * the channel flag's value when the flag is present at all. We don't
 * want to assume channel-capability from a host that loaded ONLY a
 * different channel plugin (e.g. `--channels plugin:telegram@...`) —
 * such a host has no agent-bridge channel handler and can't deliver
 * channel notifications even if it spawned us.
 *
 * The `/claude.app/Contents/MacOS/claude` and
 * `/anthropic.claude-code-…/resources/native-binary/claude` signatures
 * stay broad: when Claude Code is the parent, channel delivery is
 * negotiated over MCP regardless of cmdline flags, so the absence of
 * `--channels` doesn't disprove channel-capability.
 */
export function parentLooksChannelCapable(commandLine: string): boolean {
  if (!commandLine) return false;
  // Channel flag form: `--channels plugin:agent-bridge[@…]` or
  // `--dangerously-load-development-channels plugin:agent-bridge[@…]`.
  // The flag's value is whitespace-separated from the flag name on
  // current Claude Code builds (`--channels plugin:agent-bridge@bar`),
  // and we tolerate `=` for older builds.
  const channelFlagWithAB =
    /(?:--channels|--dangerously-load-development-channels)(?:\s+|=)\S*plugin:agent-bridge\b/i.test(
      commandLine,
    );
  if (channelFlagWithAB) return true;
  // Native Claude Code parent — channel capability is negotiated over
  // MCP, so the cmdline doesn't have to mention `--channels`.
  if (/\/claude\.app\/Contents\/MacOS\/claude(?:\s|$)/i.test(commandLine)) return true;
  if (/\/anthropic\.claude-code-[^\s/]+\/resources\/native-binary\/claude(?:\s|$)/i.test(commandLine)) {
    return true;
  }
  return false;
}

/**
 * 4.0.0 — Resolve this MCP child's identity (persona + mode) from
 * environment + parent cmdline. The decision is made ONCE at startup
 * and shared by Patch F's IIFE and `main()` so they never disagree.
 *
 * Inputs come from the process env + ppid by default; `opts` lets unit
 * tests inject deterministic values.
 */
export function resolveIdentity(opts?: {
  env?: NodeJS.ProcessEnv;
  parentCommandLine?: string;
}): PersonaResolution {
  const env = opts?.env ?? process.env;
  const parentCommandLine =
    opts?.parentCommandLine ?? readParentCommandLine();
  const rawPersonaEnv = (env[AGENT_BRIDGE_PERSONA_ENV] ?? '').trim();

  // ── Path 1: explicit persona env var ────────────────────────────────────
  if (rawPersonaEnv.length > 0) {
    const target = claudeCodeTargetForPersona(rawPersonaEnv);
    if (!isValidTarget(target)) {
      return {
        mode: 'tools-only',
        persona: null,
        target: null,
        reason: 'env_var_invalid',
        parentCommandLine,
        rawPersonaEnv,
      };
    }
    return {
      mode: 'channel-owner',
      persona: rawPersonaEnv,
      target,
      reason: 'env_var',
      parentCommandLine,
      rawPersonaEnv,
    };
  }

  // ── Path 2: cmdline-fallback ────────────────────────────────────────────
  // Env var unset. Inspect the parent cmdline.
  if (!parentCommandLine) {
    return {
      mode: 'tools-only',
      persona: null,
      target: null,
      reason: 'tools_only_no_parent_cmdline',
      parentCommandLine,
      rawPersonaEnv,
    };
  }
  if (parentLooksChannelCapable(parentCommandLine)) {
    return {
      mode: 'channel-owner',
      persona: DEFAULT_PERSONA,
      target: claudeCodeTargetForPersona(DEFAULT_PERSONA),
      reason: 'cmdline_fallback',
      parentCommandLine,
      rawPersonaEnv,
    };
  }
  return {
    mode: 'tools-only',
    persona: null,
    target: null,
    reason: 'tools_only_no_channel_flag',
    parentCommandLine,
    rawPersonaEnv,
  };
}

/**
 * 4.0.0 — Resolve the Claude Code target a sender should write to when
 * a peer addresses `target=claude-code` (the legacy form, no slash).
 * Always routes to the `default` persona's subdir on the receiver side
 * for backward compatibility with pre-4.0.0 senders.
 *
 * If `target` already includes a slash (e.g. `claude-code/foo`), it is
 * returned unchanged.
 */
export function normalizeClaudeCodeTarget(target: string): string {
  if (target === CLAUDE_CODE_TARGET) {
    return claudeCodeTargetForPersona(DEFAULT_PERSONA);
  }
  return target;
}
