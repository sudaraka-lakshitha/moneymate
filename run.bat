@echo off
title MoneyMate Web App

echo ========================================================
echo               Starting MoneyMate Web App
echo ========================================================
echo.

:: Check if node_modules exists, install if missing
if not exist node_modules (
    echo [!] Installing dependencies... Please wait.
    call npm install
    echo.
)

:: Start Vite dev server and open browser
echo [+] Launching local dev server...
echo [+] Opening http://localhost:5173 in your default browser...
echo.

start http://localhost:5173
call npm run dev

pause
