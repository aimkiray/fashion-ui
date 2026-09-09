@echo off
setlocal enabledelayedexpansion
title AI Fashion Studio - Restart
cd /d D:\Comfy\fashion_ui
echo Restarting AI Fashion Studio (web server only; ComfyUI is kept running)...

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r ":3000 .*LISTENING"') do (
  taskkill /pid %%a /f >nul 2>nul && set FOUND=1
)
if "!FOUND!"=="1" (
  echo [OK] Old web server stopped.
) else (
  echo [OK] Web server was not running.
)

timeout /t 2 /nobreak >nul
start "AI Fashion Studio" cmd /k "D:\Comfy\fashion_ui\start.bat"
echo [OK] Restart requested - the startup window is opening.
timeout /t 3 /nobreak >nul
exit /b 0
