// Earliest-possible parent-PID snapshot — runs BEFORE any other static
// import in this MCP server's import graph. This module is intentionally
// tiny (no other imports of its own) so that its body executes as the
// very first user-code in the process, before slow third-party loads
// (zod, MCP SDK) or any future top-level await could give the host time
// to die and reparent us.
//
// Why this matters: the orphan-suicide check (index.ts) gates the
// init-parent-from-boot skip path on this snapshot. If the snapshot
// were taken AFTER static imports resolved, a parent dying during a
// slow dependency load would leave `process.ppid === 1` by snapshot
// time — and the gate would erroneously treat a true startup orphan as
// legitimately init-parented, leaving the child immortal.
//
// Codex P2 (2026-05-04): keep this file dependency-free and import it
// FIRST in index.ts (before all other imports) so its body runs before
// any other import body in the entrypoint graph.
export const STARTUP_PPID: number = process.ppid;
