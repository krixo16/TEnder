@echo off
title TenderBridge AI - Set Gemini API Key
echo ============================================================
echo         TenderBridge AI - Configure Gemini API Key
echo ============================================================
echo.
echo You can get a free Gemini API key at: https://aistudio.google.com/apikey
echo.
set /p API_KEY="Paste your GEMINI_API_KEY and press Enter: "

if "%API_KEY%"=="" (
    echo [ERROR] No key entered. Aborting.
    pause
    exit /b
)

:: Write to mcp-server/.env
(
echo GEMINI_API_KEY=%API_KEY%
echo GEMINI_MODEL=gemini-2.0-flash
echo CACHE_DIR=.cache
echo REQUEST_TIMEOUT=30
echo MAX_PDF_SIZE_MB=25
echo MAX_PDFS_PER_PAGE=10
) > "%~dp0mcp-server\.env"

:: Write to TenderBridge-main/.env
(
echo GEMINI_API_KEY=%API_KEY%
echo GEMINI_MODEL=gemini-2.0-flash
) > "%~dp0TenderBridge-main\.env"

:: Write to root .env
(
echo GEMINI_API_KEY=%API_KEY%
echo GEMINI_MODEL=gemini-2.0-flash
) > "%~dp0.env"

echo.
echo [SUCCESS] GEMINI_API_KEY has been saved to:
echo   - mcp-server\.env
echo   - TenderBridge-main\.env
echo   - .env
echo.
pause
