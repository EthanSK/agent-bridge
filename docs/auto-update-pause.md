# Pause automatic update probes

Create `~/.agent-bridge/auto-update-check.disabled` to stop `scripts/check-update.sh` before it fetches Git or sends update notices. The check reads this flag on every invocation, including calls from an already-running MCP server. Removing the flag restores the existing default. `--force` does not bypass an operator pause.

The existing `AGENT_BRIDGE_AUTO_UPDATE_CHECK=0` environment switch still works. A process cannot see later edits to its parent's environment; use the file flag when the current MCP server must stay running.

This flag pauses the availability probe only. It does not pause a separately installed periodic updater, restart an agent, install an update, or create a schedule. Manage those jobs separately. A chosen nightly maintenance command can use its normal guarded updater while the daytime availability probes remain paused.
