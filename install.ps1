# agent-bridge — Windows installer (PowerShell 5.1+)
# Usage:
#   irm https://raw.githubusercontent.com/EthanSK/agent-bridge/main/install.ps1 | iex
#
# Installs the bash CLI + a `.cmd` shim into %LOCALAPPDATA%\agent-bridge\bin
# and adds that directory to the user PATH. No administrator privileges needed.
# Requires Git Bash for Windows (https://git-scm.com/download/win).

$ErrorActionPreference = 'Stop'

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

Write-Host ''
Write-Host '  Get started:'
Write-Host '    agent-bridge setup'
Write-Host '    agent-bridge help'
Write-Host ''
if ($PathChanged) {
    Write-Host '  Note: open a NEW PowerShell or Command Prompt for the PATH change to take effect.' -ForegroundColor Yellow
    Write-Host ''
}
