@echo off
setlocal
title Hotspot Product Radar - Start
cd /d "%~dp0"
set "PROJECT_ROOT=%~dp0"

set "QUIET="
set "NO_BROWSER="
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="/quiet" set "QUIET=1"
if /i "%~1"=="/nobrowser" set "NO_BROWSER=1"
shift
goto parse_args
:args_done

echo ===================================================
echo       Hotspot Product Radar - Start
echo ===================================================
echo.

if exist "%PROJECT_ROOT%.runtime\node\node.exe" set "PATH=%PROJECT_ROOT%.runtime\node;%PATH%"
if exist "%PROJECT_ROOT%.runtime\git\cmd\git.exe" set "PATH=%PROJECT_ROOT%.runtime\git\cmd;%PATH%"

set "NEED_INSTALL="
where node.exe >nul 2>nul
if errorlevel 1 set "NEED_INSTALL=1"
if not exist "%PROJECT_ROOT%node_modules\tsx\dist\cli.mjs" set "NEED_INSTALL=1"
if not exist "%PROJECT_ROOT%f\radar\dashboard__raw_app\dist\index.html" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
  echo [INFO] Required files are missing. Running install.bat...
  call "%PROJECT_ROOT%install.bat" /quiet
  if errorlevel 1 goto failed
)

if not exist "%PROJECT_ROOT%config\radar_config.local.json" (
  echo [ERROR] Central configuration is missing. Run setup.bat first.
  goto failed
)

if defined NO_BROWSER (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\start-radar.ps1" -NoBrowser
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%scripts\start-radar.ps1"
)
if errorlevel 1 goto failed

echo.
echo [OK] Hotspot Product Radar is running in the background.
echo Use stop.bat to close it and status.bat to check it.
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
echo.
echo [ERROR] Hotspot Product Radar could not be started.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
