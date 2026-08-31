@echo off
setlocal
title Hotspot Product Radar - Install
cd /d "%~dp0"

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"

echo ===================================================
echo       Hotspot Product Radar - Install
echo ===================================================
echo.

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"

echo [1/4] Checking Git and Node.js...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-runtime.ps1" -EnsureGit -EnsureNode
if errorlevel 1 goto failed

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"
where git.exe >nul 2>nul
if errorlevel 1 goto failed
where node.exe >nul 2>nul
if errorlevel 1 goto failed
where npm.cmd >nul 2>nul
if errorlevel 1 goto failed
node --version
call npm.cmd --version

echo.
echo [2/4] Installing server dependencies...
call npm.cmd ci
if errorlevel 1 goto failed

echo.
echo [3/4] Installing dashboard dependencies...
call npm.cmd --prefix "f\radar\dashboard__raw_app" ci
if errorlevel 1 goto failed

echo.
echo [4/4] Building the dashboard...
call npm.cmd run build:dashboard
if errorlevel 1 goto failed

echo.
echo [OK] Runtime, dependencies, and dashboard are ready.
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
echo.
echo [ERROR] Installation was not completed. Review the message above.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
