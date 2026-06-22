# Hướng dẫn deploy relay node mới

<!-- last_verified_at: 2026-06-21 -->
<!-- applies_to: derp-relay module — vpn3, vpn4 hoặc bất kỳ VPS standalone -->

---

## Tổng quan

Một **relay node** chạy module `derp-relay` — image duy nhất chứa:

- **`derper`** — DERP WebSocket relay server (Tailscale relay protocol)
- **`ping-reporter.py`** — script đo latency gửi về `collector` trên vpn2 qua tailnet

Relay node **không** chạy control plane (headscale), không chạy admin-ui, không chạy latency collector.

**Các relay node hiện có:**

| Node | IP | Domain | Region code | Ghi chú |
|------|----|--------|-------------|---------|
| vpn2 | 165.22.12.169 | vpn2.hangocthanh.io.vn | vpn2-vn | Relay local trên control plane node |
| vpn3 | 64.176.23.196 | vpn3.hangocthanh.io.vn | vpn3-vn | Ubuntu 24.04, server mới 2026-06-19 |
| vpn4 | (TBD) | vpn4.hangocthanh.io.vn | vpn4-vn | Chưa deploy |
| vpn6 | 45.119.87.220 | — | vpn6-vn | Co-host với HA control plane |

---

## Yêu cầu

- Ubuntu 22.04+ (hoặc 24.04)
- Docker Engine đã cài
- Domain trỏ về IP server (cần cho TLS cert)
- Tailscale installed trên host (để relay node join tailnet — dùng bởi ping-reporter)
- Port mở: **443 TCP** (DERP WebSocket), **3478 UDP** (STUN)
- Headscale đang chạy trên vpn2 (cần để tạo pre-auth key)

---

## Bước 1 — Chuẩn bị pre-auth key

Pre-auth key dùng để `ping-reporter` join tailnet. Một key reusable dùng được cho nhiều relay node.

```bash
# SSH vào vpn2:
ssh root@165.22.12.169

# Tạo pre-auth key reusable, hạn 1 năm:
docker exec derp-controller \
  headscale preauthkeys create --reusable --expiration 365d -u main

# Output ví dụ:
# tskey-auth-AbcDefGhi123...
```

Lưu key này. Nếu đã có key còn hạn thì dùng lại, không cần tạo mới.

Kiểm tra key hiện có:

```bash
docker exec derp-controller headscale preauthkeys list -u main
```

---

## Bước 2 — Set GitHub Secrets (chỉ cần cho relay node có CI deploy)

Mẫu cho vpn3 (đã cấu hình sẵn):

```powershell
# Từ D:\05. Peru\03.Taile\TailscaleRemote
gh secret set VPN3_HOST --body "64.176.23.196"
gh secret set VPN3_USER --body "root"
gh secret set VPN3_SSH_KEY --body (Get-Content "C:\Users\Hoanglong\keys\vpn3_key" -Raw)
```

Cho relay node mới (ví dụ vpn4):

```powershell
gh secret set VPN4_HOST --body "IP_CUA_VPN4"
gh secret set VPN4_USER --body "root"
gh secret set VPN4_SSH_KEY --body (Get-Content "C:\Users\Hoanglong\keys\vpn4_key" -Raw)
```

---

## Bước 3 — Deploy tự động qua GitHub Actions (cách khuyến nghị)

Workflow `module-derp-relay.yml` tự động build + deploy lên vpn3 khi có thay đổi trong `modules/derp-relay/`.

Trigger thủ công:

```powershell
# Deploy derp-relay lên vpn3:
gh workflow run module-derp-relay.yml

# Theo dõi:
gh run list --workflow=module-derp-relay.yml
gh run view <RUN_ID> --log
```

Workflow sẽ:
1. Build image `ghcr.io/vanbienperu3107/derp-relay:latest`
2. Push lên GHCR
3. SSH vào vpn3
4. `docker compose pull && docker compose up -d`
5. `curl http://localhost:8080/derp/probe` để kiểm tra

---

## Bước 4 — Deploy thủ công (dùng khi không có CI hoặc relay node mới)

### 4.1 Cài Docker trên relay node mới

```bash
ssh root@<IP_RELAY>

curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
```

### 4.2 Cài Tailscale trên host (để ping-reporter join tailnet)

```bash
# Ubuntu:
curl -fsSL https://tailscale.com/install.sh | sh
# Không chạy tailscale up ở đây — sẽ dùng trong container
```

### 4.3 Tạo thư mục và cấu hình

```bash
mkdir -p /opt/tailscale-remote/deploy/relay
cd /opt/tailscale-remote/deploy/relay
```

Tạo file `.env`:

```bash
cat > .env << 'EOF'
# Thay vpn3 bằng tên relay node của bạn
DERP_HOSTNAME=vpn3.hangocthanh.io.vn
REPORTER_NAME=vpn3
COLLECTOR_URL=http://collector.tailnet.local:8090
TS_AUTHKEY=tskey-auth-AbcDefGhi123...
CONTROLLER_URL=https://vpn2.hangocthanh.io.vn
EOF
```

### 4.4 Tạo docker-compose.yml

```bash
cat > docker-compose.yml << 'EOF'
version: '3.8'

services:
  derp-relay:
    image: ghcr.io/vanbienperu3107/derp-relay:latest
    container_name: derp-relay
    restart: unless-stopped
    network_mode: host
    volumes:
      - derp_certs:/certs
    environment:
      - DERP_HOSTNAME=${DERP_HOSTNAME}
      - DERP_CERT_MODE=manual
      - DERP_CERT_DIR=/certs
      - DERP_STUN_PORT=3478
      - DERP_HTTP_PORT=8080
      - REPORTER_NAME=${REPORTER_NAME}
      - COLLECTOR_URL=${COLLECTOR_URL}
      - TS_AUTHKEY=${TS_AUTHKEY}
      - CONTROLLER_URL=${CONTROLLER_URL}

volumes:
  derp_certs:
    driver: local
EOF
```

### 4.5 Pull và chạy container

```bash
# Login GHCR (nếu image là private):
echo $GITHUB_TOKEN | docker login ghcr.io -u vanbienperu3107 --password-stdin

# Pull và chạy:
docker compose pull
docker compose up -d
```

### 4.6 Dùng setup script (nếu có trong repo)

```bash
# Copy setup-relay-node.sh từ repo lên server rồi chạy:
DERP_HOSTNAME=vpn3.hangocthanh.io.vn \
REPORTER_NAME=vpn3 \
CONTROLLER_URL=https://vpn2.hangocthanh.io.vn \
TS_AUTHKEY=tskey-auth-AbcDefGhi123... \
bash /opt/tailscale-remote/deploy/relay/setup-relay-node.sh
```

---

## Bước 5 — Cấu hình TLS cho relay node

DERP relay cần TLS cert vì client kết nối qua HTTPS WebSocket. Có 2 cách:

### Cách 1: Caddy trên host (khuyến nghị cho Ubuntu 22.04+)

```bash
# Cài Caddy:
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

Tạo `/etc/caddy/Caddyfile`:

```caddyfile
vpn3.hangocthanh.io.vn {
    reverse_proxy :8080 {
        # Preserve WebSocket headers:
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }

    # STUN không qua Caddy (UDP), chỉ route HTTP/WebSocket
}
```

```bash
systemctl enable caddy
systemctl restart caddy
```

Caddy tự động lấy cert từ Let's Encrypt. `derper` dùng `certmode=manual` đọc từ `/certs` volume nếu cần cert offline.

### Cách 2: Cert thủ công (cho môi trường không có Caddy)

```bash
# Lấy cert bằng certbot:
apt install certbot
certbot certonly --standalone -d vpn3.hangocthanh.io.vn

# Copy cert vào volume Docker:
docker_vol=$(docker volume inspect derp_certs --format '{{.Mountpoint}}')
cp /etc/letsencrypt/live/vpn3.hangocthanh.io.vn/fullchain.pem \
   $docker_vol/vpn3.hangocthanh.io.vn.crt
cp /etc/letsencrypt/live/vpn3.hangocthanh.io.vn/privkey.pem \
   $docker_vol/vpn3.hangocthanh.io.vn.key

# Restart để load cert mới:
docker compose restart derp-relay
```

Cron job tự renew:

```bash
# /etc/cron.d/certbot-derp
0 3 1 * * root certbot renew --quiet && \
  cp /etc/letsencrypt/live/vpn3.hangocthanh.io.vn/fullchain.pem \
     $(docker volume inspect derp_certs --format '{{.Mountpoint}}')/vpn3.hangocthanh.io.vn.crt && \
  cp /etc/letsencrypt/live/vpn3.hangocthanh.io.vn/privkey.pem \
     $(docker volume inspect derp_certs --format '{{.Mountpoint}}')/vpn3.hangocthanh.io.vn.key && \
  docker restart derp-relay
```

---

## Bước 6 — Thêm relay node vào Admin-UI

Sau khi relay node hoạt động, đăng ký vào hệ thống qua Admin-UI:

1. Mở `https://vpn2.hangocthanh.io.vn/app/`
2. Đăng nhập với Google account
3. Vào **DERP Regions → Add Region**
4. Điền thông tin:

```
Hostname:    vpn3.hangocthanh.io.vn
IP Address:  64.176.23.196
DERP Port:   443
STUN Port:   3478
Region Code: vpn3-vn
Region Name: Vietnam - VPN3
Priority:    100
Status:      Active
```

5. Save → API tự động cập nhật `derpmap.json`
6. Headscale pull derpmap mỗi 10s → client nhận DERPMap mới

---

## Bước 7 — Cập nhật DERP probe URLs cho latency monitor

Secret `DERP_PROBE_URLS` chứa danh sách các relay node để `latency` module monitor:

```powershell
# Format: "region-code=probe-url,region-code=probe-url,..."
gh secret set DERP_PROBE_URLS --body "vpn2-vn=https://vpn2.hangocthanh.io.vn/derp/probe,vpn3-vn=https://vpn3.hangocthanh.io.vn/derp/probe,vpn4-vn=https://vpn4.hangocthanh.io.vn/derp/probe"
```

Re-deploy latency module để nhận cấu hình mới:

```powershell
gh workflow run module-latency.yml
```

---

## Bước 8 — Kiểm tra relay node hoạt động

### 8.1 Probe endpoint

```bash
# Từ máy bất kỳ có internet:
curl -v https://vpn3.hangocthanh.io.vn/derp/probe
# → HTTP 200 OK
# Body: "ok" hoặc JSON status
```

### 8.2 DERP WebSocket test

```bash
# Cài tailscale trên máy test rồi:
tailscale ping <peer_ip> --until-direct=false
# → pong via vpn3.hangocthanh.io.vn:443  (chứng tỏ relay đang dùng)
```

### 8.3 Logs container

```bash
ssh root@64.176.23.196
cd /opt/tailscale-remote/deploy/relay
docker compose logs -f derp-relay

# Log bình thường trông như:
# derper: 2026/06/21 10:00:00 DERP server
# derper: 2026/06/21 10:00:01 Accepting connection from 1.2.3.4:52345
# reporter: Sent latency report to collector: 12.3ms
```

### 8.4 STUN test

```bash
# Dùng stun-client hoặc nc:
nc -u vpn3.hangocthanh.io.vn 3478
# Hoặc dùng Admin-UI → DERP Regions → row vpn3 → click "Probe Health"
```

---

## Troubleshooting relay node

### DERP probe trả lỗi hoặc timeout

```bash
# Kiểm tra container chạy không:
docker compose ps

# Kiểm tra port 8080 (derper HTTP):
ss -tulpn | grep 8080

# Kiểm tra Caddy có route không:
curl -v http://localhost:8080/derp/probe
```

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `connection refused :443` | Caddy không chạy | `systemctl restart caddy` |
| `certificate invalid` | Cert chưa issue hoặc expired | Kiểm tra `certbot certificates` |
| `connection refused :8080` | derper container chưa chạy | `docker compose up -d` |
| `failed to get cert` | Domain chưa trỏ về IP | Kiểm tra DNS: `dig vpn3.hangocthanh.io.vn` |

### ping-reporter không gửi được về collector

```bash
# Xem log reporter trong container:
docker exec derp-relay cat /var/log/reporter.log
# hoặc:
docker compose logs derp-relay | grep reporter
```

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `tailscale not connected` | Container chưa join tailnet | Kiểm tra TS_AUTHKEY trong .env |
| `connection refused collector:8090` | collector-sidecar trên vpn2 không chạy | Kiểm tra vpn2 collector-sidecar status |
| `no route to host` | Tailnet chưa ổn định | `docker exec derp-relay tailscale status` |

### Container exit ngay lập tức

```bash
docker compose logs derp-relay --tail=20 --no-log-prefix
```

Thường do biến môi trường thiếu. Kiểm tra `.env` đủ `DERP_HOSTNAME`, `TS_AUTHKEY`, `COLLECTOR_URL`.

---

## Server migration — chuyển relay sang VPS mới

```bash
# 1. Trên VPS mới: cài Docker, Caddy, cấu hình y chang VPS cũ

# 2. Cập nhật DNS domain về IP mới
# (cert Let's Encrypt sẽ tự issue lại với IP mới)

# 3. Deploy:
gh secret set VPN3_HOST --body "NEW_IP"
gh workflow run module-derp-relay.yml

# 4. Kiểm tra:
curl https://vpn3.hangocthanh.io.vn/derp/probe
# → 200 OK

# 5. Update IP trong Admin-UI DERP Regions
# vpn3 → Edit → IP Address: NEW_IP

# 6. VPS cũ: stop container
ssh root@OLD_IP "docker compose -f /opt/tailscale-remote/deploy/relay/docker-compose.yml down"
```
