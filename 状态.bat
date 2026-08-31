@echo off
setlocal
title Hotspot Product Radar - Status
cd /d "%~dp0"

echo ===================================================
echo       Hotspot Product Radar - Status
echo ===================================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\server-control.ps1" status
set "STATUS_EXIT=%ERRORLEVEL%"

if /i "%~1"=="/quiet" exit /b %STATUS_EXIT%
echo.
echo Press any key to close this window...
pause >nul
exit /b %STATUS_EXIT%
