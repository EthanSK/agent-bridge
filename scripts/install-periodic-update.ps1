# agent-bridge/scripts/install-periodic-update.ps1
# ------------------------------------------------
# [PERIODIC-UPDATE 2026-05-04]
#
# Provisions a Windows Scheduled Task that runs
# scripts\agent-bridge-periodic-update.ps1 every 10 minutes (and at user
# logon). This is the harness-INDEPENDENT half of auto-update: it fires
# whether or not Claude Code / OpenClaw is running.
#
# Idempotent: re-running unregisters any prior task with the same name,
# regenerates with up-to-date paths, then re-registers.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-periodic-update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-periodic-update.ps1 -WithOpenclawMcpRepair
#
# Task name: AgentBridge Periodic Update
# Logs:      $env:USERPROFILE\.agent-bridge\logs\periodic-update.log

[CmdletBinding()]
param(
    [switch]$WithOpenclawMcpRepair  # forwarded to body (no-op on Windows but kept for parity)
)

$ErrorActionPreference = 'Stop'

# ---------- Resolve paths ---------------------------------------------------

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot  = Split-Path -Parent $ScriptDir
$BodyScript = Join-Path $ScriptDir 'agent-bridge-periodic-update.ps1'

if (-not (Test-Path $BodyScript)) {
    Write-Error "Body script not found: $BodyScript"
    exit 1
}

$TaskName = 'AgentBridge Periodic Update'
$LogDir   = Join-Path $env:USERPROFILE '.agent-bridge\logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# ---------- Compose action --------------------------------------------------

$psArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$BodyScript`""
)
if ($WithOpenclawMcpRepair) {
    $psArgs += '-WithOpenclawMcpRepair'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($psArgs -join ' ') -WorkingDirectory $RepoRoot

# ---------- Triggers --------------------------------------------------------

# 10-min repeating trigger that fires immediately on registration AND repeats
# indefinitely. Plus a logon trigger so the task fires at user login too.
$now = Get-Date
$triggerPeriodic = New-ScheduledTaskTrigger -Once -At $now -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration ([TimeSpan]::FromDays(36500))
$triggerLogon    = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# ---------- Settings + principal -------------------------------------------

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# ---------- Register (idempotent) ------------------------------------------

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($triggerPeriodic, $triggerLogon) `
    -Settings $settings `
    -Principal $principal `
    -Description 'agent-bridge harness-independent periodic auto-updater (10min)' | Out-Null

Write-Host "[ok] Scheduled Task installed: $TaskName" -ForegroundColor Green
Write-Host "     Interval:    10 min (also fires at logon)"
Write-Host "     Body script: $BodyScript"
Write-Host "     Log file:    $(Join-Path $LogDir 'periodic-update.log')"
if ($WithOpenclawMcpRepair) {
    Write-Host "     OpenClaw MCP repair: ENABLED"
}
