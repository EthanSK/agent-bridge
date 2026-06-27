/**
 * notify.ts — native macOS notification rendering + remote-notify command
 * building for the `bridge_notify` MCP tool.
 *
 * ============================================================================
 * WHY THIS EXISTS / THE BIG ARCHITECTURAL DECISION (read this first)
 * ============================================================================
 *
 * A notification is a FIRE-AND-FORGET SIDE EFFECT — "pop a banner on a Mac" —
 * NOT an agent message. So we deliberately do NOT route notifications through
 * the inbox/watcher path (the path `bridge_send_message` uses). That path is
 * designed to wake a *running* agent that then decides what to do; it is
 * async, needs a live channel-owner on the target, and would make a simple
 * banner depend on the remote Claude session being alive and processing.
 *
 * Instead we reuse the path that already executes side effects on a remote
 * machine: `sshExec` (the engine behind `bridge_run_command`). The remote
 * machine runs its OWN `agent-bridge notify --local ...` CLI verb, which pops
 * the banner directly using whatever notifier it has installed locally. So:
 *
 *   • Local notify  = render in-process here (spawn terminal-notifier /
 *                     osascript). No SSH, no inbox.
 *   • Remote notify = sshExec(machine, 'agent-bridge notify --local ...').
 *                     The remote's CLI renders natively on THAT Mac, deciding
 *                     terminal-notifier-vs-osascript by what's installed there.
 *
 * Net result: no watcher changes, no new message type, no receiver-agent
 * involvement, fully synchronous (we get a real success/failure back), and
 * CLI-testable immediately without restarting any MCP child.
 *
 * The renderer logic lives in TWO mirrored places that MUST stay byte-identical
 * in their output:
 *   1. `_render_local_notification` (bash) in the `agent-bridge` CLI — used by
 *      the CLI verb AND by every REMOTE render (the remote runs the CLI).
 *   2. `renderLocalNotification` (this file) — used only by the MCP tool's
 *      LOCAL path, so we avoid a node→bash→node hop when notifying this Mac.
 * If you change the mapping in one, change it in the other.
 * ============================================================================
 */

import { execFileSync } from 'node:child_process';

/** Fields that describe a single notification, shared by local + remote paths. */
export interface NotifyParams {
  title: string;
  message: string;
  subtitle?: string;
  /**
   * Sound name. "default" plays the system default; "none" (or undefined)
   * means silent; any named system sound ("Glass", "Ping", ...) passes through.
   */
  sound?: string;
  /**
   * Collapse/group id. terminal-notifier replaces a prior notification with
   * the same -group instead of stacking duplicates. Defaults to "agent-bridge".
   */
  group?: string;
}

/** Default group id so repeated agent-bridge notifications collapse, not stack. */
export const DEFAULT_NOTIFY_GROUP = 'agent-bridge';

/**
 * shellQuoteForSsh — the TypeScript equivalent of bash `printf '%q'`.
 *
 * THIS IS THE SINGLE MOST IMPORTANT CORRECTNESS DETAIL for the remote path.
 * Notification text is free-form user/agent content: it can contain spaces,
 * single/double quotes, `$`, backticks, newlines, backslashes — anything. When
 * we build the remote command string `agent-bridge notify --local --title X
 * --message Y ...` and hand it to `sshExec`, that whole string is interpreted
 * by the REMOTE shell. If we don't quote each field, a title like
 * `Done; rm -rf ~` or `cost is $5 (cheap)` would break the command or worse.
 *
 * Strategy: wrap the value in single quotes (inside which the shell treats
 * everything literally) and escape any embedded single quote using the classic
 * POSIX idiom `'\''` (close quote, escaped literal quote, reopen quote). This
 * matches what `printf '%q'` produces for arbitrary strings on bash and is
 * safe for every POSIX shell. Empty string becomes `''`.
 */
export function shellQuoteForSsh(value: string): string {
  if (value === '') return "''";
  // Replace each ' with '\'' then wrap the whole thing in single quotes.
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * buildRemoteNotifyCommand — assemble the exact shell command we run on the
 * REMOTE machine over SSH. It invokes the remote's OWN bundled CLI
 * (`agent-bridge notify --local ...`) so the remote owns its rendering and its
 * terminal-notifier-vs-osascript decision. We never re-implement the renderer
 * over SSH — we just call the remote CLI with safely-quoted args.
 *
 * Only required/explicitly-set fields are appended, so the remote CLI's own
 * defaults (sound silent-by-omission, group "agent-bridge") apply when a field
 * is absent — keeping CLI-direct and tool-driven behaviour identical.
 */
export function buildRemoteNotifyCommand(params: NotifyParams): string {
  const q = shellQuoteForSsh;
  // Base: always pass --local (force the remote to render locally), title, message.
  const parts: string[] = [
    'agent-bridge',
    'notify',
    '--local',
    '--title',
    q(params.title),
    '--message',
    q(params.message),
  ];
  // Optional fields — only forwarded when present so the remote CLI defaults win.
  if (params.subtitle != null && params.subtitle !== '') {
    parts.push('--subtitle', q(params.subtitle));
  }
  if (params.sound != null && params.sound !== '') {
    parts.push('--sound', q(params.sound));
  }
  if (params.group != null && params.group !== '') {
    parts.push('--group', q(params.group));
  }
  const inner = parts.join(' ');

  // PATH-PREPEND WRAP (important real-world robustness detail):
  // sshExec runs a NON-interactive, NON-login remote shell whose PATH is
  // minimal. The `agent-bridge` binary commonly lives in ~/.local/bin (the
  // install.sh default) or /opt/homebrew/bin — dirs that are only added to PATH
  // by the user's INTERACTIVE shell rc (e.g. ~/.zshrc), which a remote
  // `sh -lc` does NOT source (login sh reads ~/.profile, not ~/.zshrc). So we
  // can't rely on a login shell. Instead we explicitly prepend the standard
  // install locations to PATH before invoking, which works regardless of the
  // remote's shell flavor. Without this the remote command fails with exit 127
  // ("command not found") even though agent-bridge IS installed.
  // The inner string is single-quoted via shellQuoteForSsh so the whole thing
  // survives as one argument to -c.
  const withPath = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${inner}`;
  return `sh -c ${q(withPath)}`;
}

/**
 * renderLocalNotification — pop a native macOS banner ON THIS Mac, in-process.
 *
 * Mirrors the bash `_render_local_notification` helper exactly:
 *   • Prefer terminal-notifier (richer: real -title/-subtitle/-message/-group).
 *   • Fall back to osascript `display notification` when terminal-notifier is
 *     not installed (it is NOT guaranteed on every machine, e.g. the Mini —
 *     the fallback is load-bearing, not decorative).
 *
 * We use execFileSync with an ARGUMENT ARRAY (never a concatenated shell
 * string) for terminal-notifier, so titles/messages with spaces/quotes/$ are
 * passed verbatim with zero shell interpretation. The osascript path can't use
 * a pure arg array for the script body (AppleScript is its own language), so we
 * escape `"` and `\` for the AppleScript string literals instead.
 *
 * Throws on failure (the caller turns that into an MCP isError result).
 */
export function renderLocalNotification(params: NotifyParams): void {
  const { title, message } = params;
  const subtitle = params.subtitle ?? '';
  const sound = params.sound ?? '';
  const group = params.group && params.group !== '' ? params.group : DEFAULT_NOTIFY_GROUP;

  // -- Path 1: terminal-notifier (preferred) --------------------------------
  // Detect by attempting to resolve it; if the spawn throws ENOENT we fall
  // through to osascript. We check existence cheaply via `command -v` semantics
  // by just trying to run it inside a try/catch (no extra dependency).
  if (hasTerminalNotifier()) {
    const args: string[] = [
      '-title', title,
      '-message', message,
      '-group', group, // collapse duplicates instead of stacking
    ];
    if (subtitle !== '') {
      args.push('-subtitle', subtitle);
    }
    // Sound mapping: "none"/"" => omit the -sound flag entirely (silent).
    // "default" or a named sound => pass it through to -sound.
    if (sound !== '' && sound.toLowerCase() !== 'none') {
      args.push('-sound', sound);
    }
    execFileSync('terminal-notifier', args, { stdio: 'ignore' });
    return;
  }

  // -- Path 2: osascript fallback -------------------------------------------
  // AppleScript notifications have NO subtitle field, so we fold the subtitle
  // into the title as "title — subtitle" (same as the bash fallback).
  let dispTitle = title;
  if (subtitle !== '') {
    dispTitle = `${title} — ${subtitle}`;
  }
  // Escape backslashes first, then double quotes, for AppleScript string
  // literals embedded in the -e script.
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // `sound name "<name>"` clause only when a real sound was requested.
  let soundClause = '';
  if (sound !== '' && sound.toLowerCase() !== 'none') {
    // "default" is a valid value for AppleScript's `sound name "default"`.
    soundClause = ` sound name "${esc(sound)}"`;
  }
  const script =
    `display notification "${esc(message)}" with title "${esc(dispTitle)}"${soundClause}`;
  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
}

/**
 * hasTerminalNotifier — cheap presence check for the terminal-notifier binary.
 * Uses `command -v` via /bin/sh so we honour the same PATH the user's shell
 * would. Returns false on any error (including ENOENT), which routes us to the
 * osascript fallback. Kept private to this module.
 */
function hasTerminalNotifier(): boolean {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v terminal-notifier'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
