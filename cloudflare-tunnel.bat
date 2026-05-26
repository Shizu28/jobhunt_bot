@echo off
chcp 65001 >nul
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
echo [OK] Starte Tunnel...
echo.
echo *** Die naechste URL kopieren und in Render OLLAMA_URL eintragen ***
echo.

cloudflared tunnel --url http://localhost:11434
