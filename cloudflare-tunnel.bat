@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "TARGET_URL=http://localhost:11434"
set "RESTART_DELAY=5"

echo.
echo ============================================================
echo  Cloudflare Tunnel ^| Ollama -^> Internet
echo ============================================================
echo.
echo Dieser Tunnel macht dein lokales Ollama (localhost:11434)
echo oeffentlich erreichbar, damit Render darauf zugreifen kann.
echo.
echo WICHTIG: Die URL aendert sich bei jedem Neustart!
echo          Nach dem Start: URL kopieren und in Render als
echo          OLLAMA_URL Environment Variable eintragen.
echo.

REM Pruefen ob cloudflared installiert ist
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] cloudflared nicht gefunden.
    echo.
    echo Bitte installieren:
    echo   winget install Cloudflare.cloudflared
    echo   oder: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo.
    pause
    exit /b 1
)

REM Pruefen ob Ollama laeuft
curl -s http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Ollama laeuft nicht auf localhost:11434
    echo     Bitte Ollama zuerst starten.
    echo.
    pause
    exit /b 1
)

echo [OK] Ollama laeuft.
echo [OK] Starte Tunnel mit Auto-Reconnect...
echo.
echo *** Die naechste URL kopieren und in Render OLLAMA_URL eintragen ***
echo *** Wenn die Verbindung abbricht, startet der Tunnel automatisch neu ***
echo.

:start_tunnel
echo [%date% %time%] cloudflared startet...
cloudflared tunnel --url %TARGET_URL% --no-autoupdate
set "EXIT_CODE=%errorlevel%"

echo.
echo [WARN] Tunnel beendet (Exit Code: %EXIT_CODE%).
echo [INFO] Neustart in %RESTART_DELAY%s. (Ctrl+C zum Beenden)
timeout /t %RESTART_DELAY% /nobreak >nul
goto start_tunnel
