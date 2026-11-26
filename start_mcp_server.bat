@echo off
title TenderBridge AI - MCP Server (stdio)
cd /d "%~dp0\mcp-server"
echo ======================================================
echo    Starting TenderBridge AI MCP Server on stdio...
echo ======================================================
echo.
venv\Scripts\python.exe main.py
pause
