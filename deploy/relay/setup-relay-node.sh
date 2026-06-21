#!/bin/bash
# Setup script cho relay node mới (vpn3/4/6 hoặc bất kỳ server nào).
# Chạy với: bash setup-relay-node.sh
#
# Yêu cầu:
#   DERP_HOSTNAME  — hostname đầy đủ (vd: vpn3.hangocthanh.io.vn)
#   REPORTER_NAME  — tên ngắn cho tailnet + latency DB (vd: vpn3)
#   CONTROLLER_URL — URL của DERP-Controller (vd: https://vpn2.hangocthanh.io.vn)
#   TS_AUTHKEY     — pre-auth key từ Admin-UI → Pre-auth Keys

set -euo pipefail

: "${DERP_HOSTNAME:?Cần đặt DERP_HOSTNAME (vd: vpn3.hangocthanh.io.vn)}"
: "${REPORTER_NAME:?Cần đặt REPORTER_NAME (vd: vpn3)}"
: "${CONTROLLER_URL:?Cần đặt CONTROLLER_URL (vd: https://vpn2.hangocthanh.io.vn)}"
: "${TS_AUTHKEY:?Cần đặt TS_AUTHKEY (lấy từ Admin-UI → Pre-auth Keys)}"

echo "=== [1/4] Cài Tailscale trên host ==="
if ! command -v tailscale &>/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "tailscale đã cài sẵn: $(tailscale version)"
fi

echo "=== [2/4] Join tailnet ==="
tailscale up \
  --login-server="${CONTROLLER_URL}" \
  --authkey="${TS_AUTHKEY}" \
  --hostname="${REPORTER_NAME}" \
  --accept-dns=false

echo "=== [3/4] Kiểm tra socket ==="
until [ -S /var/run/tailscale/tailscaled.sock ]; do
  echo "Chờ tailscaled socket..."
  sleep 2
done
echo "Socket OK: /var/run/tailscale/tailscaled.sock"
tailscale status

echo "=== [4/4] Tạo .env và khởi động DERP relay ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "${SCRIPT_DIR}/.env" <<EOF
DERP_HOSTNAME=${DERP_HOSTNAME}
REPORTER_NAME=${REPORTER_NAME}
EOF

docker compose -f "${SCRIPT_DIR}/docker-compose.yml" pull
docker compose -f "${SCRIPT_DIR}/docker-compose.yml" up -d

echo ""
echo "=== XONG ==="
echo "Relay ${REPORTER_NAME} (${DERP_HOSTNAME}) đang chạy."
echo "Kiểm tra: docker compose -f ${SCRIPT_DIR}/docker-compose.yml logs -f"
echo ""
echo "Bước tiếp theo: Thêm relay này vào Admin-UI → DERP Management:"
echo "  Hostname: ${DERP_HOSTNAME}"
echo "  STUN port: 3478"
echo "  Region: (đặt region code phù hợp)"
