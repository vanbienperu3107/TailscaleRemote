@echo off
setlocal EnableExtensions
title Tailscale Portable (self-host)

REM ===================== CAU HINH (sua o day) =====================
set "HS_SERVER=https://vpn2.hangocthanh.io.vn"

REM (Tuy chon) pre-auth key. De TRONG = dang nhap bang Google (OIDC).
set "HS_AUTHKEY="

REM Shared secret cho /api/metrics/report (de trong = khong xac thuc)
set "METRICS_SECRET="
REM ===============================================================

REM Yeu cau quyen admin (tailscaled can tao named pipe).
net session >nul 2>&1
if not errorlevel 1 goto admin_ok
echo Requesting administrator privileges...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
exit /b
:admin_ok
cd /d "%~dp0"

REM tailscale-agent.exe xu ly moi thu:
REM   - Khoi dong tailscaled.exe (userspace networking + SOCKS5)
REM   - tailscale up --login-server / --accept-routes / --advertise-routes
REM   - Phat hien vai tro (itop/votam) qua IP
REM   - Set Windows proxy PAC tu server (votam only)
REM   - Start/restart gost.exe theo config tu API
REM   - Bao cao latency / metrics moi interval giay
REM   - Poll /api/client/config tu dong ap dung thay doi

if not exist "%~dp0tailscale-agent.exe" (
  echo [!] tailscale-agent.exe khong tim thay.
  echo     Tai ve tu: https://github.com/vanbienperu3107/TailscaleRemote/releases
  pause
  exit /b 1
)

set "AGENT_ARGS=--server=%HS_SERVER%"
if defined HS_AUTHKEY    set "AGENT_ARGS=%AGENT_ARGS% --authkey=%HS_AUTHKEY%"
if defined METRICS_SECRET set "AGENT_ARGS=%AGENT_ARGS% --secret=%METRICS_SECRET%"

echo ============================================================
echo  Tailscale Portable (userspace) - self-host
echo   Server : %HS_SERVER%
echo   Agent  : tailscale-agent.exe
echo ============================================================
echo.

tailscale-agent.exe %AGENT_ARGS%

echo.
echo Agent stopped.
pause
