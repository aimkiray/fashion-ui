@echo off
setlocal enabledelayedexpansion
title AI Fashion Studio
cd /d "%~dp0"

rem Optional overrides (edit before running):
rem set PORT=8199
rem set COMFY_URL=http://127.0.0.1:8188
rem set IDLE_RELEASE_MS=1800000

if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

netstat -ano | findstr LISTENING | findstr ":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo [SKIP] AI Fashion Studio is already running on port %PORT%.
  echo        If you want a fresh start, run stop.bat first, or edit this file to set PORT=8199.
  echo        Opening the UI: http://localhost:%PORT%
  start "" http://localhost:%PORT%
  timeout /t 3 /nobreak >nul
  exit /b 0
)

if "%COMFY_DIR%"=="" set COMFY_DIR=D:\Comfy\ComfyUI
set COMFY_PYTHON=%COMFY_DIR%\venv\Scripts\python.exe

netstat -ano | findstr LISTENING | findstr ":8188 " >nul 2>nul
if errorlevel 1 goto start_comfy
echo [OK] ComfyUI already running on port 8188.
goto comfy_done

:start_comfy
if not exist "%COMFY_PYTHON%" goto comfy_missing
echo [SETUP] ComfyUI is not running - starting it in a separate window...
start "ComfyUI Backend" cmd /k "cd /d "%COMFY_DIR%" && "%COMFY_PYTHON%" main.py"
echo Waiting for ComfyUI on port 8188...
set /a TRIES=0

:wait_comfy
timeout /t 3 /nobreak >nul
netstat -ano | findstr LISTENING | findstr ":8188 " >nul 2>nul
if not errorlevel 1 goto comfy_up
set /a TRIES+=1
if !TRIES! LSS 40 goto wait_comfy
echo [WARN] ComfyUI is taking long to load (large models). It will come online shortly.
goto comfy_done

:comfy_missing
echo [WARN] ComfyUI not found at %COMFY_DIR% and nothing listens on 8188.
echo The UI will start, but generation stays offline until ComfyUI is running.
goto comfy_done

:comfy_up
echo [OK] ComfyUI is up on http://127.0.0.1:8188
goto comfy_done

:comfy_done
if not exist node_modules\express\package.json (
  echo [SETUP] First run - installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [ERROR] Dependency install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

echo Starting AI Fashion Studio...
rem Put the ComfyUI venv python on PATH so the image fitting scripts
rem (crop_to_canvas.py etc.) find a Python with Pillow installed.
rem disabledelayedexpansion: %PATH% may contain "!" chars that delayed
rem expansion would otherwise mangle.
setlocal disabledelayedexpansion
if exist "%COMFY_PYTHON%" set "PATH=%COMFY_DIR%\venv\Scripts;%PATH%"
node server.js
pause