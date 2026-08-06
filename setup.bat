@echo off
setlocal
title Hotspot Product Radar - One-click Setup
cd /d "%~dp0"

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"

echo ===================================================
echo       Hotspot Product Radar - One-click Setup
echo ===================================================
echo.

echo [1/3] Preparing the local runtime and application...
call "%~dp0install.bat" /quiet
if errorlevel 1 goto failed

echo.
echo [2/3] Checking the centralized configuration...
if not exist "%~dp0config\radar_config.local.json" (
  if not exist "%~dp0config\radar_config.example.json" goto failed
  copy /y "%~dp0config\radar_config.example.json" "%~dp0config\radar_config.local.json" >nul
  echo [ACTION REQUIRED] A local configuration file was created.
  echo Fill in the API keys and service settings, save it, then run setup.bat again:
  echo   config\radar_config.local.json
  if not defined QUIET start "" notepad.exe "%~dp0config\radar_config.local.json"
  goto needs_config
)
echo [OK] config\radar_config.local.json is present.

echo.
echo [3/3] Starting the radar...
if defined QUIET (
  call "%~dp0start.bat" /quiet /nobrowser
) else (
  call "%~dp0start.bat" /quiet
)
if errorlevel 1 goto failed

echo.
echo [OK] Setup completed. The radar is ready.
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:needs_config
if defined QUIET exit /b 2
echo.
echo Press any key to close this window...
pause >nul
exit /b 2

:failed
echo.
echo [ERROR] Setup was not completed. Review the message above.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
