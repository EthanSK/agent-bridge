# agent-bridge — Windows installer (PowerShell 5.1+)
# Usage:
#   irm https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.ps1 | iex
#
# Installs the bash CLI + a `.cmd` shim into %LOCALAPPDATA%\agent-bridge\bin
# and adds that directory to the user PATH. No administrator privileges needed.
# Requires Git Bash for Windows (https://git-scm.com/download/win).

$ErrorActionPreference = 'Stop'

function Test-AgentBridgeAbsolutePath {
    param([string]$Path)
    if ($Path -match '^[A-Za-z]:[\\/]') { return $true }
    # A stable UNC root requires both server and share. Root-relative paths,
    # drive-relative C:state, and \\server without a share are cwd-dependent.
    if ($Path -match '^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)') { return $true }
    return $false
}

function Resolve-AgentBridgeHome {
    $raw = [string]$env:AGENT_BRIDGE_HOME
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return (Join-Path $env:USERPROFILE '.agent-bridge')
    }
    $raw = $raw.Trim()
    if ($raw -eq '~') {
        $raw = $env:USERPROFILE
    } elseif ($raw.StartsWith('~/') -or $raw.StartsWith('~\')) {
        $raw = Join-Path $env:USERPROFILE $raw.Substring(2)
    }
    $trimmed = $raw.TrimEnd([char[]]@('\', '/'))
    if (($trimmed -match '^[A-Za-z]:$') -and ($raw -match '^[A-Za-z]:[\\/]+$')) { $trimmed += '\' }
    if (-not (Test-AgentBridgeAbsolutePath $trimmed)) {
        throw "AGENT_BRIDGE_HOME must resolve to an absolute path: $raw"
    }
    if ((Split-Path -Leaf $trimmed) -ieq '.agent-bridge') {
        return $trimmed
    }
    return (Join-Path $trimmed '.agent-bridge')
}

$BridgeHome = Resolve-AgentBridgeHome

$Repo        = 'https://raw.githubusercontent.com/EthanSK/agent-bridge/main'
$InstallDir  = Join-Path $env:LOCALAPPDATA 'agent-bridge\bin'
$ScriptPath  = Join-Path $InstallDir 'agent-bridge'
$ShimPath    = Join-Path $InstallDir 'agent-bridge.cmd'

Write-Host ''
Write-Host '  agent-bridge installer (Windows)' -ForegroundColor Cyan
Write-Host ''

if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
    Write-Host '  Error: Git Bash is required but `bash` was not found on PATH.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  Install Git for Windows (includes Git Bash):'
    Write-Host '    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements'
    Write-Host '  Or download: https://git-scm.com/download/win'
    Write-Host ''
    Write-Host '  Then re-run this installer.'
    exit 1
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

Write-Host '  Downloading agent-bridge...' -ForegroundColor DarkGray
Invoke-WebRequest -Uri "$Repo/agent-bridge"     -OutFile $ScriptPath -UseBasicParsing
Invoke-WebRequest -Uri "$Repo/agent-bridge.cmd" -OutFile $ShimPath   -UseBasicParsing

# Bundle plugin-registry-rewire.mjs next to the bin so the CLI can find it
# on installations that don't have a workspace clone in a known location.
# (CLI also searches dev-clone paths; this is the bin-bundled fallback.)
$RewireScriptPath = Join-Path $InstallDir 'plugin-registry-rewire.mjs'
try {
    Invoke-WebRequest -Uri "$Repo/scripts/plugin-registry-rewire.mjs" -OutFile $RewireScriptPath -UseBasicParsing
} catch {
    Write-Host '  (note: could not fetch plugin-registry-rewire.mjs; CLI will fall back to dev-clone search)' -ForegroundColor DarkGray
}

# --------------------------------------------------------------------------
# Self-contained codex-channel runtime (4.10.0). `agent-bridge codex ...`
# needs the codex-channel package; the CLI prefers AGENT_BRIDGE_SOURCE_DIR /
# a local clone, and otherwise uses this snapshot at
# <resolved-bridge-home>\runtime\codex-channel\. The package is fully
# self-contained (vendored shared modules, zero npm deps). Non-fatal.
# --------------------------------------------------------------------------
$RuntimeDir  = Join-Path $BridgeHome 'runtime'
$ZipUrl      = 'https://codeload.github.com/EthanSK/agent-bridge/zip/refs/heads/main'
$CodexRuntimeOk = $false
try {
    $TmpZipDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ab-codex-runtime-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $TmpZipDir -Force | Out-Null
    $ZipPath = Join-Path $TmpZipDir 'repo.zip'
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $TmpZipDir -Force
    $SrcDir = Get-ChildItem -Path $TmpZipDir -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'codex-channel\bin\codex-channel.mjs') } |
        Select-Object -First 1
    if ($null -ne $SrcDir) {
        New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
        $Dest    = Join-Path $RuntimeDir 'codex-channel'
        $DestNew = Join-Path $RuntimeDir 'codex-channel.new'
        $DestOld = Join-Path $RuntimeDir 'codex-channel.old'
        # Stage next to the live dir, then swap with rollback — no
        # remove-then-empty gap for a daemon restarting mid-install.
        if (Test-Path $DestNew) { Remove-Item -Path $DestNew -Recurse -Force }
        if (Test-Path $DestOld) { Remove-Item -Path $DestOld -Recurse -Force }
        Copy-Item -Path (Join-Path $SrcDir.FullName 'codex-channel') -Destination $DestNew -Recurse -Force
        if (-not (Test-Path (Join-Path $DestNew 'bin\codex-channel.mjs'))) {
            throw 'staged codex-channel payload is incomplete'
        }
        if (Test-Path $Dest) { Move-Item -Path $Dest -Destination $DestOld -Force }
        try {
            Move-Item -Path $DestNew -Destination $Dest -Force
            if (Test-Path $DestOld) { Remove-Item -Path $DestOld -Recurse -Force }
        } catch {
            if (Test-Path $DestOld) { Move-Item -Path $DestOld -Destination $Dest -Force -ErrorAction SilentlyContinue }
            throw
        }
        $CodexRuntimeOk = $true
        Write-Host "  [ok] codex-channel runtime installed to $Dest" -ForegroundColor Green
    } else {
        Write-Host '  [warn] Codex support NOT installed: codex-channel not present in the repo zip.' -ForegroundColor Yellow
        Write-Host '         agent-bridge codex needs the runtime: clone the repo, set AGENT_BRIDGE_SOURCE_DIR, or re-run install.ps1 with network access.' -ForegroundColor DarkGray
    }
    Remove-Item -Path $TmpZipDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "  [warn] Codex support NOT installed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '         agent-bridge codex needs the runtime: clone the repo, set AGENT_BRIDGE_SOURCE_DIR, or re-run install.ps1 with network access.' -ForegroundColor DarkGray
}

function Test-CodexRecoveryWork {
    $bindingsPath = Join-Path $BridgeHome 'codex\bindings.json'
    if (Test-Path $bindingsPath) {
        try {
            $registry = Get-Content -Raw -Path $bindingsPath -Encoding UTF8 | ConvertFrom-Json
            if ($registry.bindings) {
                foreach ($property in $registry.bindings.PSObject.Properties) {
                    $binding = $property.Value
                    if (($null -ne $binding) -and ($binding.enabled -ne $false)) { return $true }
                }
            }
        } catch { }
    }
    $pendingDir = Join-Path $BridgeHome 'codex\pending-settings'
    return @(Get-ChildItem -Path $pendingDir -Filter '*.json' -File -ErrorAction SilentlyContinue).Count -gt 0
}

# Re-running the installer updates the runtime. If delivery or crash-recovery
# work exists, run the version-aware ensure path from the newly swapped copy.
if ($CodexRuntimeOk) {
    if ($env:AGENT_BRIDGE_CODEX_NO_ENSURE -eq '1') {
        Write-Host '  [skip] AGENT_BRIDGE_CODEX_NO_ENSURE=1 — codex-channel service not ensured.' -ForegroundColor DarkGray
    } elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-CodexRecoveryWork)) {
        # The override may have arrived as a parent dir or tilde form. Ensure
        # the child runtime sees the exact normalized state dir used above.
        $PreviousBridgeHome = [Environment]::GetEnvironmentVariable('AGENT_BRIDGE_HOME', 'Process')
        $EnsureExitCode = 1
        try {
            $env:AGENT_BRIDGE_HOME = $BridgeHome
            & node (Join-Path $RuntimeDir 'codex-channel\service.mjs') --ensure 2>$null | Out-Null
            $EnsureExitCode = $LASTEXITCODE
        } finally {
            if ($null -eq $PreviousBridgeHome) {
                Remove-Item Env:AGENT_BRIDGE_HOME -ErrorAction SilentlyContinue
            } else {
                $env:AGENT_BRIDGE_HOME = $PreviousBridgeHome
            }
        }
        if ($EnsureExitCode -eq 0) {
            Write-Host '  [ok] codex-channel service ensured from the installed runtime' -ForegroundColor Green
        } else {
            Write-Host "  [warn] codex-channel runtime installed, but service ensure exited with code $EnsureExitCode; run 'agent-bridge codex service ensure'." -ForegroundColor Yellow
        }
    }
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' -contains $InstallDir)) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$userPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "  Added $InstallDir to user PATH." -ForegroundColor DarkGray
    $PathChanged = $true
} else {
    $PathChanged = $false
}

Write-Host ''
Write-Host "  [ok] agent-bridge installed to $ShimPath" -ForegroundColor Green
Write-Host ''

# --------------------------------------------------------------------------
# Optional: register the agent-bridge MCP server / Claude plugin in
# ~/.claude/settings.json so Claude Code auto-loads bridge_send_message
# and the inbound channel watcher on next session start.
#
# We mirror the Mac side, which uses a directory-source plugin marketplace
# (extraKnownMarketplaces["agent-bridge"]) plus enabledPlugins entry. This
# is preferred over a raw mcpServers entry because the same flow exposes
# both the MCP tools and the Claude Code channel push.
#
# Idempotent: if either entry already exists, leaves it alone. Skips
# silently if ~/.claude does not exist (non-Claude-Code users).
# --------------------------------------------------------------------------
$ClaudeDir      = Join-Path $env:USERPROFILE '.claude'
$SettingsPath   = Join-Path $ClaudeDir 'settings.json'

if (Test-Path $ClaudeDir) {
    # Locate the plugin source: prefer the local clone the user has, fall
    # back to the directory next to this install.ps1 if we were invoked
    # via `irm | iex` (no local clone) — in that case skip plugin
    # registration entirely; the user can re-run after cloning.
    $PluginSource = $null
    $CandidateLocal = Join-Path $env:USERPROFILE '.openclaw\workspace\agent-bridge'
    $ScriptDirCandidate = $null
    if ($PSCommandPath) { $ScriptDirCandidate = Split-Path -Parent $PSCommandPath }

    if ($ScriptDirCandidate -and (Test-Path (Join-Path $ScriptDirCandidate '.claude-plugin\marketplace.json'))) {
        $PluginSource = $ScriptDirCandidate
    } elseif (Test-Path (Join-Path $CandidateLocal '.claude-plugin\marketplace.json')) {
        $PluginSource = $CandidateLocal
    }

    if (-not $PluginSource) {
        Write-Host '  [skip] No local agent-bridge clone with .claude-plugin/marketplace.json found —' -ForegroundColor DarkGray
        Write-Host '         skipping Claude Code plugin registration. Clone the repo and re-run' -ForegroundColor DarkGray
        Write-Host '         install.ps1 to enable bridge_send_message in Claude Code.' -ForegroundColor DarkGray
    } else {
        try {
            if (Test-Path $SettingsPath) {
                $raw  = Get-Content -Raw -Path $SettingsPath -Encoding UTF8
                $json = $raw | ConvertFrom-Json
            } else {
                $json = [pscustomobject]@{}
            }

            # Ensure containers exist as ordered hashtables we can mutate.
            if (-not $json.PSObject.Properties.Match('extraKnownMarketplaces').Count) {
                $json | Add-Member -NotePropertyName 'extraKnownMarketplaces' -NotePropertyValue ([pscustomobject]@{})
            }
            if (-not $json.PSObject.Properties.Match('enabledPlugins').Count) {
                $json | Add-Member -NotePropertyName 'enabledPlugins' -NotePropertyValue ([pscustomobject]@{})
            }

            $changed = $false
            if (-not $json.extraKnownMarketplaces.PSObject.Properties.Match('agent-bridge').Count) {
                $marketplaceEntry = [pscustomobject]@{
                    source = [pscustomobject]@{
                        source = 'directory'
                        path   = $PluginSource
                    }
                }
                $json.extraKnownMarketplaces | Add-Member -NotePropertyName 'agent-bridge' -NotePropertyValue $marketplaceEntry
                $changed = $true
            }
            if (-not $json.enabledPlugins.PSObject.Properties.Match('agent-bridge@agent-bridge').Count) {
                $json.enabledPlugins | Add-Member -NotePropertyName 'agent-bridge@agent-bridge' -NotePropertyValue $true
                $changed = $true
            }

            if ($changed) {
                $out = $json | ConvertTo-Json -Depth 32
                Set-Content -Path $SettingsPath -Value $out -Encoding UTF8
                Write-Host "  [ok] Registered agent-bridge plugin in $SettingsPath" -ForegroundColor Green
                Write-Host '       Restart Claude Code to load bridge_send_message.' -ForegroundColor Green
            } else {
                Write-Host '  [ok] agent-bridge plugin already registered in settings.json' -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  [warn] Could not auto-register Claude Code plugin: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host '         You can add the entry manually — see README, "MCP server registration".' -ForegroundColor Yellow
        }
    }
}

# --------------------------------------------------------------------------
# [PERIODIC-UPDATE 2026-05-04] Install the harness-INDEPENDENT periodic
# auto-updater (Windows Scheduled Task every 10 min). Default ON for fresh
# installs. Opt-out via $env:AGENT_BRIDGE_NO_PERIODIC_UPDATE = '1'.
# --------------------------------------------------------------------------
if ($env:AGENT_BRIDGE_NO_PERIODIC_UPDATE -eq '1') {
    Write-Host '  [skip] AGENT_BRIDGE_NO_PERIODIC_UPDATE=1 — skipping periodic-update Scheduled Task.' -ForegroundColor DarkGray
} else {
    $Provisioner = $null
    if ($ScriptDirCandidate -and (Test-Path (Join-Path $ScriptDirCandidate 'scripts\install-periodic-update.ps1'))) {
        $Provisioner = Join-Path $ScriptDirCandidate 'scripts\install-periodic-update.ps1'
    } elseif (Test-Path (Join-Path $env:USERPROFILE 'Projects\agent-bridge\scripts\install-periodic-update.ps1')) {
        $Provisioner = Join-Path $env:USERPROFILE 'Projects\agent-bridge\scripts\install-periodic-update.ps1'
    } elseif (Test-Path (Join-Path $env:USERPROFILE '.openclaw\workspace\agent-bridge\scripts\install-periodic-update.ps1')) {
        $Provisioner = Join-Path $env:USERPROFILE '.openclaw\workspace\agent-bridge\scripts\install-periodic-update.ps1'
    }

    if ($Provisioner) {
        Write-Host '  Installing periodic-update Scheduled Task (10 min interval)...' -ForegroundColor DarkGray
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Provisioner
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [warn] Periodic-update provisioner exited with code $LASTEXITCODE. Run 'agent-bridge install-periodic-update' manually to retry." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "  [warn] Periodic-update provisioner failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        # irm | iex bootstrap path: no clone yet. The periodic body needs a
        # clone to operate on; we cannot meaningfully install the Scheduled
        # Task without one. Loud, actionable hint and continue (non-fatal).
        Write-Host '  [skip] Harness-independent auto-update not installed.' -ForegroundColor DarkGray
        Write-Host '         The periodic updater needs a local agent-bridge clone (it runs' -ForegroundColor DarkGray
        Write-Host '         git fetch + pull + build every 10 min). After cloning, run:' -ForegroundColor DarkGray
        Write-Host '             git clone https://github.com/EthanSK/agent-bridge $env:USERPROFILE\Projects\agent-bridge' -ForegroundColor DarkGray
        Write-Host '             agent-bridge install-periodic-update' -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host '  Get started:'
Write-Host '    agent-bridge setup'
Write-Host '    agent-bridge help'
Write-Host ''
if ($PathChanged) {
    Write-Host '  Note: open a NEW PowerShell or Command Prompt for the PATH change to take effect.' -ForegroundColor Yellow
    Write-Host ''
}
