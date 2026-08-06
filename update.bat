@echo off
setlocal EnableDelayedExpansion
title Hotspot Product Radar - Update
cd /d "%~dp0"

if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"

echo ===================================================
echo       Hotspot Product Radar - Safe Update
echo ===================================================
echo.

where git.exe >nul 2>nul
if errorlevel 1 (
  echo [INFO] Git is missing. Preparing the local runtime first...
  call "%~dp0install.bat" /quiet
  if errorlevel 1 goto failed
  if exist "%~dp0.runtime\node\node.exe" set "PATH=%~dp0.runtime\node;%PATH%"
  if exist "%~dp0.runtime\git\cmd\git.exe" set "PATH=%~dp0.runtime\git\cmd;%PATH%"
)

where git.exe >nul 2>nul
if errorlevel 1 goto failed

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This folder is not a Git clone.
  echo Run setup.bat once to prepare automatic updates.
  goto failed
)

set "DIRTY="
for /f "delims=" %%i in ('git status --porcelain --untracked-files^=normal') do set "DIRTY=1"
if defined DIRTY (
  echo [ERROR] Local source-code changes were found.
  echo Update stopped to avoid overwriting user files.
  echo Local configuration and database files are ignored and do not block updates.
  echo.
  git -c core.quotePath=false status --short
  goto failed
)

echo [1/4] Stopping this project's service...
call "%~dp0stop.bat" /quiet
if errorlevel 1 goto failed

echo.
echo [2/4] Downloading the latest code...
git pull --ff-only
if errorlevel 1 goto failed

echo.
echo [3/4] Installing locked dependencies...
call "%~dp0install.bat" /quiet
if errorlevel 1 goto failed

echo.
echo [4/4] Starting the updated service...
call "%~dp0start.bat" /quiet
if errorlevel 1 goto failed

echo.
echo ===================================================
echo [OK] Hotspot Product Radar has been updated successfully.
echo ===================================================
if /i "%~1"=="/quiet" exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0

:failed
echo.
echo [ERROR] Update was not completed. Existing files were not overwritten automatically.
if /i "%~1"=="/quiet" exit /b 1
echo Press any key to close this window...
pause >nul
exit /b 1
