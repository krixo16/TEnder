@echo off
title TenderBridge AI - Tender Analysis Tool
cd /d "%~dp0\mcp-server"
echo ======================================================
echo    Starting TenderBridge AI Analysis Tool...
echo ======================================================
echo.
venv\Scripts\python.exe run_cli.py
pause
