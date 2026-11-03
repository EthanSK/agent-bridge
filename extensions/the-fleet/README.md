# The Fleet

The Fleet is Agent Bridge's shared worker extension. The generic engine is a
separate package, `the-fleet`; Agent Bridge provides the CLI and MCP entry points.
It reuses existing Agent Bridge pairings. All apps use the same local coordinator,
not separate schedulers inside each app.

## Install

Install [The Fleet](https://github.com/EthanSK/the-fleet) from its source package (`npm ci`, then `npm link`), using
Node 22.18 or newer and Python 3. Ensure `the-fleet` is on Agent Bridge's PATH, or
set `THE_FLEET_BIN` to its absolute executable path in your MCP environment.
Run `the-fleet service install` for optional macOS login startup, then load the
printed LaunchAgent. Other platforms can run the documented service command with
their own user service manager. Automatic CLI startup uses the same kernel lock.

Use `agent-bridge pair` to configure a worker. For private networking, install and
sign in to Tailscale on both machines, set the worker's stable Tailscale IP or DNS
name as the pairing's `internet_host`, and enable SSH on the worker. The existing
pairing stores the SSH identity-file path; never copy private keys into a project.
For an unattended, trusted worker, its owner can disable device-key expiry in the
Tailscale admin console. Keep ordinary device authentication and SSH authorization.
No reusable Tailscale login token belongs in this extension or its examples.

## Use

```sh
agent-bridge fleet machine add worker --bridge-target MyWorker --default
agent-bridge fleet state --fresh
agent-bridge fleet submit request.json
agent-bridge fleet run my-project test
```

The MCP server exposes `bridge_fleet_state` and `bridge_fleet`. Restart/reconnect
the MCP client after building a changed server to refresh its tool catalog.
`bridge_fleet` returns an operation ID promptly; poll `operation` at least once
every 75 seconds until completion. This is also the cancellation/heartbeat path.
It supports one-time JSON jobs, stored project profiles, and external SSH
reservations. The engine README owns the full schema and protocol.

Configuration, source paths, registrations, limits and credentials remain in
each user's private state. The extension contains no personal machine names,
addresses or project list. It does not forward chat messages or start AI agents.

Compatibility: existing `fleet-runner` callers use the same service. New
installations use `~/.the-fleet`; existing `~/.fleet-runner` installations keep
using their state until an explicit `the-fleet migrate-home`. The core owns that
locked, resumable migration and redirects old default-home requests afterward.
The extension keeps delegating to the core; it never creates a second state store.

Shared defaults, including the returned-results folder, are configured through
The Fleet app or its `/v1/config/controller` API. Apps can resolve a registration
for their current Git worktree with `the-fleet project resolve --source "$PWD"`.
Saved `the-fleet.json` profiles remain optional; a one-time submit uses the same
worker discovery, admission, output verification and result store.
