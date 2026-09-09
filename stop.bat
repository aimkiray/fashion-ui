@echo off
setlocal enabledelayedexpansion
title AI Fashion Studio - Stop
rem Usage:
rem   stop.bat          - stop web UI only
rem   stop.bat all      - stop web UI and ComfyUI backend

set MODE=%1
if "%MODE%"=="" set MODE=web

echo Stopping AI Fashion Studio web server...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr ":3000 "') do (
  taskkill /pid %%a /f >nul 2>nul && set FOUND=1
)
if "!FOUND!"=="1" (
  echo [OK] Web server stopped.
) else (
  echo [OK] Web server was not running.
)

if /i "%MODE%"=="all" goto stop_comfy
echo Done. ComfyUI backend left running (run "stop.bat all" to stop it too).
pause
exit /b 0

:stop_comfy
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr ":8188 "') do (
  taskkill /pid %%a /f >nul 2>nul && set FOUND=1
)
if "!FOUND!"=="1" (
  echo [OK] ComfyUI stopped.
) else (
  echo [OK] ComfyUI was not running.
)
echo Done.
pause
exit /b 0