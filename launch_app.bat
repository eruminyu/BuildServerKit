@echo off
setlocal
cd /d "%~dp0app"

if not exist "node_modules" (
    echo [BuildServerKit Studio] Installing dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed. Please check Node.js installation.
        pause
        exit /b 1
    )
)

node scripts\ensure-electron.js
if errorlevel 1 (
    echo [ERROR] Failed to prepare Electron runtime.
    pause
    exit /b 1
)

echo [BuildServerKit Studio] Launching application...
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"
exit /b 0
