@echo off
setlocal
set CSC_IDENTITY_AUTO_DISCOVERY=false
cd /d "%~dp0app"

if not exist "node_modules" (
    echo [BuildServerKit Studio] Installing dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed.
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

echo [BuildServerKit Studio] Building Windows Portable EXE...
call npm run dist:portable
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo [OK] Built: app\dist\BuildServerKit_Studio_Portable.exe
pause
