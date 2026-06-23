@echo off
setlocal EnableExtensions
title Stop Tailscale Portable

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo Stopping tailscale-agent (will stop tailscaled + gost + clear proxy)...
taskkill /IM tailscale-agent.exe /F >nul 2>&1

REM Fallback: kill children in case agent already exited without cleanup
taskkill /IM tailscaled.exe /F >nul 2>&1
taskkill /IM gost.exe /F >nul 2>&1
tailscale.exe down >nul 2>&1

REM Clear Windows system proxy (agent clears on graceful shutdown;
REM this is the hard-stop fallback).
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f >nul 2>&1

echo Stopped.
echo.
pause
