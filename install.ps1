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
Write-Host '  Get started:'
Write-Host '    agent-bridge setup'
Write-Host '    agent-bridge help'
Write-Host ''
if ($PathChanged) {
    Write-Host '  Note: open a NEW PowerShell or Command Prompt for the PATH change to take effect.' -ForegroundColor Yellow
    Write-Host ''
}
