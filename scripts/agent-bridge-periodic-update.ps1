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
#
# OpenClaw repair is macOS/Linux-only (OC doesn't ship Windows binaries).
#
# Logs to:
#   $env:USERPROFILE\.agent-bridge\logs\periodic-update.log
#
# Lock prevents concurrent runs.

[CmdletBinding()]
param(
    [switch]$WithOpenclawMcpRepair  # accepted for parity; no-op on Windows
)

$ErrorActionPreference = 'Continue'

# ---------- Config / paths --------------------------------------------------

$Repo     = if ($env:AGENT_BRIDGE_REPO) { $env:AGENT_BRIDGE_REPO } else { Join-Path $env:USERPROFILE 'Projects\agent-bridge' }
$LogDir   = Join-Path $env:USERPROFILE '.agent-bridge\logs'
$RunDir   = Join-Path $env:USERPROFILE '.agent-bridge\run'
$StateDir = Join-Path $env:USERPROFILE '.agent-bridge\state'
$LogFile  = Join-Path $LogDir 'periodic-update.log'
$LockDir  = Join-Path $RunDir 'periodic-update.lock'
$BuiltHeadFile = Join-Path $StateDir 'built-head.txt'

New-Item -ItemType Directory -Path $LogDir, $RunDir, $StateDir -Force | Out-Null

function Write-Log {
    param([string]$Message)
    $ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    Add-Content -Path $LogFile -Value "$ts $Message" -Encoding UTF8
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

try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
} catch {
    Write-Log "already running (lock held); exiting"
    exit 0
}

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
