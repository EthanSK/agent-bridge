@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BASH_SCRIPT=%SCRIPT_DIR%agent-bridge"

where bash >nul 2>nul
if errorlevel 1 (
    echo agent-bridge requires Git Bash on Windows. 1>&2
    echo Install with: winget install --id Git.Git -e 1>&2
    echo Or download: https://git-scm.com/download/win 1>&2
    exit /b 1
)

bash "%BASH_SCRIPT%" %*
exit /b %ERRORLEVEL%
