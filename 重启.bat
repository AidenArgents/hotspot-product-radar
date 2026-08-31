@echo off
setlocal
title Hotspot Product Radar - Restart
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
echo       Hotspot Product Radar - Restart
echo ===================================================
echo.

if exist "%PROJECT_ROOT%.runtime\node\node.exe" set "PATH=%PROJECT_ROOT%.runtime\node;%PATH%"
if exist "%PROJECT_ROOT%.runtime\git\cmd\git.exe" set "PATH=%PROJECT_ROOT%.runtime\git\cmd;%PATH%"

call "%PROJECT_ROOT%Í£Ö¹.bat" /quiet
if errorlevel 1 goto failed

if defined NO_BROWSER (
  call "%PROJECT_ROOT%Æô¶¯.bat" /quiet /nobrowser
) else (
  call "%PROJECT_ROOT%Æô¶¯.bat" /quiet
)
if errorlevel 1 goto failed

echo.
echo [OK] Hotspot Product Radar was restarted.
if defined QUIET exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
echo.
echo [ERROR] Hotspot Product Radar could not be restarted.
if defined QUIET exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
