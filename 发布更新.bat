@echo off
setlocal
title Hotspot Product Radar - Publish Update
cd /d "%~dp0"

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"

echo ===================================================
echo       Hotspot Product Radar - Publish Update
echo       Step 1: Git source publish
echo       Step 2: Build and publish release zip
echo ===================================================
echo.

echo.
echo ########## Step 1/2: Git source publish ##########
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-update.ps1" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Git source publish failed. Release build skipped.
    echo.
    pause >nul
    exit /b 1
)

echo.
echo ########## Step 2/2: Release zip publish ##########
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-release.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Release zip publish failed.
    echo.
    pause >nul
    exit /b 1
)

echo.
echo ===================================================
echo [OK] Source and release package published!
echo ===================================================
echo.
pause >nul
exit /b 0
