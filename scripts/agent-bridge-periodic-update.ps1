# agent-bridge/scripts/agent-bridge-periodic-update.ps1
# -----------------------------------------------------
# [PERIODIC-UPDATE 2026-05-04]
#
# Harness-INDEPENDENT periodic auto-updater for an agent-bridge dev clone.
# Runs every 10 minutes via a Windows Scheduled Task — see
# scripts/install-periodic-update.ps1.
#
# Companion to scripts/agent-bridge-periodic-update.sh (macOS / Linux).
#
# Steps:
#   1. git fetch origin --prune
#   2. If origin/main differs from HEAD AND working tree is clean:
#        git pull --ff-only origin main
#   3. If pulled OR mcp-server\build\index.js missing OR HEAD changed
#      since last build → npm install + npm run build
#   4. agent-bridge plugin-registry-rewire (self-heal)
#   5. Refresh packaged CLI at %LOCALAPPDATA%\agent-bridge\bin\ when the
#      dev clone's VERSION exceeds the installed VERSION. Windows-specific:
#      install.ps1 COPIES the two CLI files into %LOCALAPPDATA%, so without
#      this step the packaged CLI drifts forever while the dev clone tracks
#      main. (macOS install.sh symlinks straight at the dev clone, so a
#      `git pull` updates the CLI in place — no equivalent needed there.)
#
# OpenClaw repair is macOS/Linux-only (OC doesn't ship Windows binaries).
#
# Logs to:
#   $env:USERPROFILE\.agent-bridge\logs\periodic-update.log
#
# Lock prevents concurrent runs.

[CmdletBinding()]
param(
    [switch]$WithOpenclawMcpRepair,  # accepted for parity; no-op on Windows
    [string]$AgentBridgeHome,
    [switch]$CodexNoEnsure
)

$ErrorActionPreference = 'Continue'

if (-not [string]::IsNullOrWhiteSpace($AgentBridgeHome)) {
    $env:AGENT_BRIDGE_HOME = $AgentBridgeHome
}
if ($CodexNoEnsure) {
    $env:AGENT_BRIDGE_CODEX_NO_ENSURE = '1'
}

function Test-AgentBridgeAbsolutePath {
    param([string]$Path)
    if ($Path -match '^[A-Za-z]:[\\/]') { return $true }
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
    if ((Split-Path -Leaf $trimmed) -ieq '.agent-bridge') { return $trimmed }
    return (Join-Path $trimmed '.agent-bridge')
}

# ---------- Config / paths --------------------------------------------------

$Repo       = if ($env:AGENT_BRIDGE_REPO) { $env:AGENT_BRIDGE_REPO } else { Join-Path $env:USERPROFILE 'Projects\agent-bridge' }
$BridgeHome = Resolve-AgentBridgeHome
$env:AGENT_BRIDGE_HOME = $BridgeHome
$LogDir     = Join-Path $BridgeHome 'logs'
$RunDir     = Join-Path $BridgeHome 'run'
$StateDir   = Join-Path $BridgeHome 'state'
$LogFile  = Join-Path $LogDir 'periodic-update.log'
$LockDir  = Join-Path $RunDir 'periodic-update.lock'
$BuiltHeadFile = Join-Path $StateDir 'built-head.txt'

New-Item -ItemType Directory -Path $LogDir, $RunDir, $StateDir -Force | Out-Null

function Write-Log {
    param([string]$Message)
    $ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -Path $LogFile -Value "$ts $Message" -Encoding UTF8
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

function Invoke-CaptureExit {
    param([string]$Cmd, [string[]]$Args, [string]$Cwd)
    Push-Location $Cwd
    try {
        & $Cmd @Args 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value "  $_" -Encoding UTF8 }
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

Write-Log "=== agent-bridge periodic-update start ==="

# ---------- Lock ------------------------------------------------------------
#
# Lock is a directory containing a `pid` file. Stale-lock handling: if the
# lock dir exists AND its pid is missing, malformed, or refers to a process
# no longer alive, reclaim it. Without this, a kill during git/npm leaves
# the lock orphaned and the Scheduled Task skips forever.

$LockPidFile = Join-Path $LockDir 'pid'
$StaleLockAgeSec = if ($env:AGENT_BRIDGE_PERIODIC_STALE_LOCK_SEC) { [int]$env:AGENT_BRIDGE_PERIODIC_STALE_LOCK_SEC } else { 1800 }

function Test-LockReclaimable {
    # Returns $true if lock can be reclaimed / is absent, $false if a
    # live/recent owner holds it. Mirrors the bash policy:
    #   - PID alive             -> CONTENDED (never reclaim purely on age)
    #   - PID dead               -> RECLAIM
    #   - No pid file:
    #       - Lock age < threshold -> CONTENDED (race; peer just mkdir'd)
    #       - Lock age >= threshold -> RECLAIM (orphan)
    if (-not (Test-Path $LockDir)) { return $true }

    $existingPid = $null
    if (Test-Path $LockPidFile) {
        $raw = (Get-Content -Path $LockPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($raw -match '^\d+$') { $existingPid = [int]$raw }
    }

    if ($existingPid) {
        $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($proc) {
            # Live owner; never reclaim purely on age. Codex review 0e763a3 round 2.
            return $false
        }
        Write-Log "stale lock: pid=$existingPid no longer alive; reclaiming"
        Remove-Item -Path $LockDir -Recurse -Force -ErrorAction SilentlyContinue
        return $true
    }

    # Pid-less lock: race vs orphan distinguished by age.
    $age = [int]((Get-Date) - (Get-Item $LockDir).LastWriteTime).TotalSeconds
    if ($age -lt $StaleLockAgeSec) {
        # Treat as contended — peer is mid-acquire, pid write imminent.
        return $false
    }
    Write-Log "stale lock: missing/malformed pid file (age ${age}s); reclaiming"
    Remove-Item -Path $LockDir -Recurse -Force -ErrorAction SilentlyContinue
    return $true
}

if (-not (Test-LockReclaimable)) {
    Write-Log "already running (lock held by live previous invocation); exiting"
    exit 0
}

try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
} catch {
    # Race: retry once after re-checking.
    if (-not (Test-LockReclaimable)) {
        Write-Log "already running (lock contended); exiting"
        exit 0
    }
    try {
        New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
    } catch {
        Write-Log "already running (lock contended after retry); exiting"
        exit 0
    }
}
Set-Content -Path $LockPidFile -Value $PID -Encoding UTF8 -ErrorAction SilentlyContinue

try {
    # ---------- Repo guard --------------------------------------------------
    if (-not (Test-Path (Join-Path $Repo '.git'))) {
        Write-Log "ERROR: repo missing or not a git checkout: $Repo"
        exit 1
    }

    # ---------- Step 1: fetch -----------------------------------------------
    $rc = Invoke-CaptureExit -Cmd 'git' -Args @('fetch', 'origin', '--prune') -Cwd $Repo
    if ($rc -ne 0) {
        Write-Log "ERROR: git fetch failed (rc=$rc)"
        exit 1
    }

    Push-Location $Repo
    try {
        $before = (& git rev-parse HEAD).Trim()
        $remote = (& git rev-parse origin/main).Trim()

        # Working-tree-clean detection
        $dirty = $false
        & git diff --quiet
        if ($LASTEXITCODE -ne 0) { $dirty = $true }
        & git diff --cached --quiet
        if ($LASTEXITCODE -ne 0) { $dirty = $true }
        $untracked = (& git ls-files --others --exclude-standard)
        if ($untracked) { $dirty = $true }
    } finally {
        Pop-Location
    }

    $changed = 0

    # ---------- Step 2: pull (only when clean) -------------------------------
    if ($before -ne $remote) {
        if ($dirty) {
            Write-Log "repo has local changes; skipping auto-pull: $before -> $remote"
        } else {
            Write-Log "updating repo: $before -> $remote"
            $rc = Invoke-CaptureExit -Cmd 'git' -Args @('pull', '--ff-only', 'origin', 'main') -Cwd $Repo
            if ($rc -ne 0) {
                Write-Log "ERROR: git pull --ff-only failed (rc=$rc)"
                exit 1
            }
            $changed = 1
        }
    } else {
        Write-Log "repo already current: $before"
    }

    # ---------- Step 3: build (when needed) ---------------------------------
    Push-Location $Repo
    try {
        $headNow = (& git rev-parse HEAD).Trim()
    } finally {
        Pop-Location
    }
    $builtHead = ''
    if (Test-Path $BuiltHeadFile) {
        $builtHead = (Get-Content -Path $BuiltHeadFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    }

    $buildIndex = Join-Path $Repo 'mcp-server\build\index.js'
    if ($changed -eq 1 -or -not (Test-Path $buildIndex) -or $builtHead -ne $headNow) {
        Write-Log "building mcp-server (head=$headNow)"
        $mcpDir = Join-Path $Repo 'mcp-server'
        $rc = Invoke-CaptureExit -Cmd 'npm' -Args @('install') -Cwd $mcpDir
        if ($rc -ne 0) {
            Write-Log "ERROR: npm install failed (rc=$rc)"
            exit 1
        }
        $rc = Invoke-CaptureExit -Cmd 'npm' -Args @('run', 'build') -Cwd $mcpDir
        if ($rc -ne 0) {
            Write-Log "ERROR: npm run build failed (rc=$rc)"
            exit 1
        }
        Set-Content -Path $BuiltHeadFile -Value $headNow -Encoding UTF8
    } else {
        Write-Log "build exists and head unchanged; skipping rebuild"
    }

    # ---------- Step 4: plugin-registry-rewire ------------------------------
    $abShim = Join-Path $Repo 'agent-bridge.cmd'
    if (Test-Path $abShim) {
        $rc = Invoke-CaptureExit -Cmd $abShim -Args @('plugin-registry-rewire') -Cwd $Repo
        if ($rc -ne 0) {
            Write-Log "WARN: plugin-registry-rewire exited rc=$rc (non-fatal)"
        }
    } else {
        Write-Log "WARN: $abShim not found; skipping plugin-registry-rewire"
    }

    # ---------- Step 5: refresh packaged CLI bin (Windows-specific) ---------
    #
    # The Windows install layout is separate from the dev clone:
    #   - Dev clone: $Repo (this script keeps it current via Steps 1-3)
    #   - Packaged CLI: %LOCALAPPDATA%\agent-bridge\bin\{agent-bridge,agent-bridge.cmd}
    #
    # macOS doesn't need this — `install.sh` symlinks /usr/local/bin/agent-bridge
    # directly at the dev clone, so a `git pull` updates the CLI in place. On
    # Windows, `install.ps1` COPIES the two CLI files into %LOCALAPPDATA% (no
    # symlink semantics for `.cmd` shims under cmd.exe), so without this step
    # the packaged CLI drifts forever while the dev clone tracks main.
    #
    # We compare VERSION strings (not file hashes) so cosmetic dev-clone edits
    # don't trigger spurious copies. Bumping VERSION in the bash CLI is the
    # canonical version-shipped signal.
    #
    # Source of truth: the freshly-pulled dev clone (Step 2 ran `--ff-only`
    # against origin/main, so $Repo's files are byte-equal to whatever shipped
    # in that commit). No need to re-fetch from raw.githubusercontent.com.

    $InstallBinDir = Join-Path $env:LOCALAPPDATA 'agent-bridge\bin'
    $InstalledCli  = Join-Path $InstallBinDir 'agent-bridge'
    $InstalledShim = Join-Path $InstallBinDir 'agent-bridge.cmd'
    $SourceCli     = Join-Path $Repo 'agent-bridge'
    $SourceShim    = Join-Path $Repo 'agent-bridge.cmd'

    function Get-CliVersion {
        param([string]$Path)
        if (-not (Test-Path $Path)) { return $null }
        $line = Select-String -Path $Path -Pattern '^VERSION="([^"]+)"' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($line) { return $line.Matches[0].Groups[1].Value }
        return $null
    }

    if (-not (Test-Path $InstallBinDir)) {
        Write-Log "no packaged CLI install detected at $InstallBinDir; skipping bin refresh"
    } elseif (-not (Test-Path $SourceCli) -or -not (Test-Path $SourceShim)) {
        Write-Log "WARN: source CLI files missing in dev clone; skipping bin refresh"
    } else {
        $installedVer = Get-CliVersion -Path $InstalledCli
        $sourceVer    = Get-CliVersion -Path $SourceCli
        if (-not $sourceVer) {
            Write-Log "WARN: could not parse VERSION from $SourceCli; skipping bin refresh"
        } elseif ($installedVer -eq $sourceVer) {
            Write-Log "packaged CLI already at v$sourceVer; no refresh needed"
        } else {
            Write-Log "refreshing packaged CLI: $installedVer -> $sourceVer"
            try {
                Copy-Item -Path $SourceCli  -Destination $InstalledCli  -Force -ErrorAction Stop
                Copy-Item -Path $SourceShim -Destination $InstalledShim -Force -ErrorAction Stop
                $verifyVer = Get-CliVersion -Path $InstalledCli
                if ($verifyVer -eq $sourceVer) {
                    Write-Log "packaged CLI refreshed to v$verifyVer at $InstallBinDir"
                } else {
                    Write-Log "ERROR: copy completed but installed VERSION=$verifyVer != source $sourceVer"
                }
            } catch {
                Write-Log "ERROR: failed to refresh packaged CLI: $($_.Exception.Message)"
            }
        }
    }

    # ---------- Step 6: codex-channel service refresh (4.10.0) --------------
    # Enabled bindings need delivery; pending sticky-settings journals need
    # crash recovery even after their binding was disabled or removed.
    $CodexService  = Join-Path $Repo 'codex-channel\service.mjs'
    if (Test-Path $CodexService) {
        if ($env:AGENT_BRIDGE_CODEX_NO_ENSURE -eq '1') {
            Write-Log 'codex-channel ensure skipped: AGENT_BRIDGE_CODEX_NO_ENSURE=1'
        } elseif (Test-CodexRecoveryWork) {
            & node $CodexService --ensure 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Log "codex-channel service ensured from $CodexService"
            } else {
                Write-Log "WARN: codex-channel service ensure exited with code $LASTEXITCODE (non-fatal)"
            }
        } else {
            Write-Log 'codex-channel ensure skipped: no enabled bindings or pending settings journals'
        }
    }

    # ---------- Summary -----------------------------------------------------
    Push-Location $Repo
    try {
        $head = (& git rev-parse HEAD).Trim()
    } finally {
        Pop-Location
    }
    Write-Log "head=$head changed=$changed"
    Write-Log "=== agent-bridge periodic-update done ==="
}
finally {
    Remove-Item -Path $LockDir -Recurse -Force -ErrorAction SilentlyContinue
}
