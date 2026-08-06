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

set "SETUP_SCRIPT=%~dp0scripts\setup.ps1"
set "DOWNLOADED_SETUP="

if exist "%SETUP_SCRIPT%" goto run_setup

set "SETUP_SCRIPT=%TEMP%\hotspot-product-radar-setup-%RANDOM%-%RANDOM%.ps1"
set "DOWNLOADED_SETUP=1"
echo [INFO] Downloading the setup program...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/AidenArgents/hotspot-product-radar/main/scripts/setup.ps1' -OutFile '%SETUP_SCRIPT%'"
if errorlevel 1 goto failed

:run_setup
if defined QUIET (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%" -InstallParent "%~dp0." -Quiet
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%" -InstallParent "%~dp0."
)
set "SETUP_EXIT=%ERRORLEVEL%"

if defined DOWNLOADED_SETUP del /q "%SETUP_SCRIPT%" >nul 2>nul
if not "%SETUP_EXIT%"=="0" goto failed

echo.
echo ===================================================
echo [OK] Installation and startup completed.
echo ===================================================
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
if defined DOWNLOADED_SETUP del /q "%SETUP_SCRIPT%" >nul 2>nul
echo.
echo [ERROR] Setup was not completed. Review the message above.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
