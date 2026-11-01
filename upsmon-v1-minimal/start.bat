@echo off
setlocal enabledelayedexpansion
title UPS Monitor (Minimal / 回退版本)
cd /d "%~dp0"

set "NODE="
where node >nul 2>&1 && set "NODE=node"

if not defined NODE (
    for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
        if exist "%%D\node.exe" set "NODE=%%D\node.exe"
    )
)
if not defined NODE (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE (
    echo.
    echo  [ERROR] Node.js not found. Install Node.js LTS then run again.
    echo.
    pause
    exit /b 1
)

echo  UPS Monitor - MINIMAL version (rollback build)
echo  Node: !NODE!
echo  Open http://localhost:8686
echo  NOTE: use PORT=8687 to run alongside the full version.
echo.

if "%PORT%"=="" set "PORT=8686"
"!NODE!" server.js
pause
