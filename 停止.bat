@echo off
setlocal
title Hotspot Product Radar - Stop
cd /d "%~dp0"

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"

echo ===================================================
echo       Hotspot Product Radar - Stop
echo ===================================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-radar.ps1"
if errorlevel 1 goto failed

echo.
echo [OK] Hotspot Product Radar is stopped.
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
echo.
echo [ERROR] The radar could not be stopped safely.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
