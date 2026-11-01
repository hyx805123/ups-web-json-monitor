@echo off
setlocal enabledelayedexpansion
title UPS Monitor
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
    echo  [ERROR] Node.js not found.
    echo  Install Node.js LTS from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
)

echo  Node: !NODE!
echo  Open http://localhost:8686 in your browser.
echo  Press Ctrl+C to stop.
echo.

"!NODE!" server.js
pause
