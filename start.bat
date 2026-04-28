@echo off
chcp 65001 >nul
title JobHunter AI Server
color 0A
echo.
echo  ==========================================
echo   JobHunter AI - Server wird gestartet...
echo  ==========================================
echo.

:: Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo  FEHLER: Node.js ist nicht installiert!
    echo  Bitte herunterladen von: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Go to script directory
cd /d "%~dp0"

:: Install dependencies (puppeteer, first-run only ~300MB)
if not exist node_modules\puppeteer (
    echo  Installiere Abhaengigkeiten - einmalig ca. 300MB, bitte warten...
    npm install
    echo.
)

echo  Node.js gefunden. Starte Server...
echo  Druecke Ctrl+C zum Beenden.
echo.

node --no-warnings server.js

pause
