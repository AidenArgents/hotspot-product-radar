@echo off
setlocal
title Hotspot Product Radar - Update
cd /d "%~dp0"

echo ===================================================
echo       Hotspot Product Radar - Update
echo ===================================================
echo.

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-client.ps1"
set "UPDATE_EXIT=%ERRORLEVEL%"

echo.
if "%UPDATE_EXIT%"=="0" (
    echo Update finished.
) else (
    echo Update was not completed. Please review the message above.
)
echo.
echo Press any key to close this window...
pause > nul
exit /b %UPDATE_EXIT%
