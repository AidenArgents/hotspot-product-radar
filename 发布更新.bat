@echo off
setlocal
title Hotspot Product Radar - Publish Update
cd /d "%~dp0"

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-update.ps1" %*
set "PUBLISH_EXIT=%ERRORLEVEL%"

echo.
if "%PUBLISH_EXIT%"=="0" (
  echo Publish tool finished.
) else (
  echo Publish was not completed. Please review the message above.
)
echo.
echo Press any key to close this window...
pause >nul
exit /b %PUBLISH_EXIT%
