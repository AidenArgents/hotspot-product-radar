@echo off
setlocal
title Hotspot Product Radar - Remove Startup
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-startup-task.ps1"
if errorlevel 1 goto failed
echo.
echo [OK] Automatic startup was removed. The current server was not stopped.
if /i "%~1"=="/quiet" exit /b 0
pause
exit /b 0

:failed
echo.
echo [ERROR] The startup shortcut could not be removed.
if /i "%~1"=="/quiet" exit /b 1
pause
exit /b 1
