@echo off
setlocal
title Hotspot Product Radar - Install Startup
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-startup-task.ps1"
if errorlevel 1 goto failed
echo.
echo [OK] The radar will start automatically after Windows sign-in.
if /i "%~1"=="/quiet" exit /b 0
pause
exit /b 0

:failed
echo.
echo [ERROR] The startup shortcut could not be installed.
if /i "%~1"=="/quiet" exit /b 1
pause
exit /b 1
