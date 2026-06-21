#!/bin/sh
set -e

STATE_DIR="${TS_STATE_DIR:-/var/lib/tailscale}"
SOCKET="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"
HOSTNAME="${EXIT_NODE_HOSTNAME:-proxy-node}"
AUTHKEY="${TS_AUTHKEY:-}"
LOGIN_SERVER="${TS_LOGIN_SERVER:-}"
SOCKS5_PORT="1080"
HTTP_PORT="8118"
PROXY_USER="${PROXY_USER:-}"
PROXY_PASS="${PROXY_PASS:-}"
ADVERTISE_EXIT_NODE="${ADVERTISE_EXIT_NODE:-false}"

# ── Start tailscaled (userspace networking — không cần kernel module) ──────────
tailscaled \
  --state="${STATE_DIR}/tailscaled.state" \
  --socket="${SOCKET}" \
  --tun=userspace-networking &
TS_PID=$!

# Chờ daemon sẵn sàng
sleep 3

# ── Join tailnet ───────────────────────────────────────────────────────────────
UP_ARGS="--authkey=${AUTHKEY} --hostname=${HOSTNAME} --accept-routes"
if [ -n "${LOGIN_SERVER}" ]; then
  UP_ARGS="${UP_ARGS} --login-server=${LOGIN_SERVER}"
fi
if [ "${ADVERTISE_EXIT_NODE}" = "true" ]; then
  UP_ARGS="${UP_ARGS} --advertise-exit-node"
fi

tailscale up ${UP_ARGS}

TS_IP=$(tailscale ip -4 2>/dev/null || echo "<tailscale-ip>")
echo "[proxy-node] Joined tailnet: ${HOSTNAME} (Tailscale IP: ${TS_IP})"

# ── Build auth string cho gost ─────────────────────────────────────────────────
if [ -n "${PROXY_USER}" ] && [ -n "${PROXY_PASS}" ]; then
  AUTH="${PROXY_USER}:${PROXY_PASS}@"
else
  AUTH=""
  echo "[proxy-node] WARNING: proxy chạy không có auth — chỉ dùng trong tailnet private"
fi

# ── Start SOCKS5 proxy ─────────────────────────────────────────────────────────
gost -L "socks5://${AUTH}:${SOCKS5_PORT}" &
echo "[proxy-node] SOCKS5 proxy: ${TS_IP}:${SOCKS5_PORT}"

# ── Start HTTP CONNECT proxy ───────────────────────────────────────────────────
gost -L "http://${AUTH}:${HTTP_PORT}" &
echo "[proxy-node] HTTP proxy:   ${TS_IP}:${HTTP_PORT}"

echo ""
echo "[proxy-node] Thành viên set proxy:"
echo "  SOCKS5 → ${TS_IP}:${SOCKS5_PORT}"
echo "  HTTP   → ${TS_IP}:${HTTP_PORT}"
echo ""

wait $TS_PID
