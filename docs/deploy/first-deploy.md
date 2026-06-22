# Hướng dẫn deploy lần đầu — vpn2 + vpn6

<!-- last_verified_at: 2026-06-21 -->
<!-- applies_to: TailscaleRemote control plane (vpn2 primary + vpn6 HA) -->

---

## Tổng quan

Tài liệu này hướng dẫn deploy toàn bộ hệ thống TailscaleRemote lên hai node chính lần đầu tiên từ đầu (greenfield). Các bước phải thực hiện **đúng thứ tự** vì có dependency vòng: headscale phải chạy trước mới lấy được `noise_private.key` và pre-auth key; pre-auth key cần trước khi `collector-sidecar` join tailnet.

**Thứ tự tổng quát:**

```
Chuẩn bị ngoài (DB, OAuth, secrets)
    → Build images
        → Deploy vpn2 (lần 1, không có noise key)
            → Lấy noise key + pre-auth key
                → Set secrets
                    → Re-deploy vpn2 (lần 2, đầy đủ)
                        → Deploy vpn6
                            → Cấu hình Cloudflare LB
                                → Kiểm tra
```

---

## Yêu cầu hạ tầng

| Node | OS | IP | Domain | Ghi chú |
|------|----|----|--------|---------|
| vpn2 | Ubuntu 22.04+ | 165.22.12.169 | vpn2.hangocthanh.io.vn | Primary, Docker phải cài sẵn |
| vpn6 | Ubuntu 22.04+ | 45.119.87.220 | — | HA replica, Caddy system install sẵn |

**Phần mềm cần trên mỗi node trước khi deploy:**

```bash
# Ubuntu — cài Docker:
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Thêm user vào group docker (nếu không dùng root):
usermod -aG docker $USER
```

**Phần mềm cần trên máy local (Windows):**

```powershell
# GitHub CLI:
winget install GitHub.cli
gh auth login

# OpenSSL (để tạo SESSION_SECRET):
winget install ShiningLight.OpenSSL
```

---

## Bước 1 — Tạo Neon Postgres databases

1. Truy cập [console.neon.tech](https://console.neon.tech) → Sign up / Login
2. Create project: `tailscale-remote`
3. Tạo **2 databases** trong project:

### Database 1: `tailscale_remote` (cho api-center)

```
Database name: tailscale_remote
Branch: main
```

Lấy connection string (dạng `postgres://user:pass@ep-xxx.us-east-1.aws.neon.tech/tailscale_remote?sslmode=require`) → lưu làm `DATABASE_URL`.

### Database 2: `headscale` (cho derp-controller)

```
Database name: headscale
Branch: main
```

Từ connection string tách ra:

| Secret name | Giá trị ví dụ |
|-------------|--------------|
| `HS_DB_HOST` | `ep-xxx.us-east-1.aws.neon.tech` |
| `HS_DB_NAME` | `headscale` |
| `HS_DB_USER` | `neondb_owner` (hoặc user bạn tạo) |
| `HS_DB_PASS` | `AbcXyz123...` |

> **Lưu ý:** Neon free tier tắt DB sau 5 phút không hoạt động. Headscale và api-center đều có connection pool + retry — không ảnh hưởng khi đang chạy. Lần cold start đầu tiên mỗi ngày có thể delay ~2s.

---

## Bước 2 — Tạo Google OAuth application

1. Truy cập [console.cloud.google.com](https://console.cloud.google.com)
2. Tạo hoặc chọn project
3. Vào **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Authorized redirect URIs — thêm:

```
https://vpn2.hangocthanh.io.vn/app/api/auth/google/callback
```

6. Lưu:

| Secret name | Mô tả |
|-------------|-------|
| `GOOGLE_CLIENT_ID` | Dạng `1234567890-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Dạng `GOCSPX-...` |

---

## Bước 3 — Set GitHub Secrets

Từ thư mục repo local (`D:\05. Peru\03.Taile\TailscaleRemote`):

```powershell
# SSH keys phải tồn tại tại các path sau:
# C:\Users\Hoanglong\keys\id_rsa      → vpn2
# C:\Users\Hoanglong\keys\vpn6_key   → vpn6

# Infrastructure secrets:
gh secret set VPN2_HOST --body "165.22.12.169"
gh secret set VPN2_USER --body "root"
gh secret set VPN2_SSH_KEY --body (Get-Content "C:\Users\Hoanglong\keys\id_rsa" -Raw)

gh secret set VPN6_HOST --body "45.119.87.220"
gh secret set VPN6_USER --body "root"
gh secret set VPN6_SSH_KEY --body (Get-Content "C:\Users\Hoanglong\keys\vpn6_key" -Raw)

# Database:
gh secret set DATABASE_URL --body "postgres://user:pass@ep-xxx.us-east-1.aws.neon.tech/tailscale_remote?sslmode=require"
gh secret set HS_DB_HOST   --body "ep-xxx.us-east-1.aws.neon.tech"
gh secret set HS_DB_NAME   --body "headscale"
gh secret set HS_DB_USER   --body "neondb_owner"
gh secret set HS_DB_PASS   --body "your_password_here"

# Google OAuth:
gh secret set GOOGLE_CLIENT_ID     --body "1234567890-abc.apps.googleusercontent.com"
gh secret set GOOGLE_CLIENT_SECRET --body "GOCSPX-..."

# Session (tạo random 32-byte hex):
$sessionSecret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
gh secret set SESSION_SECRET --body $sessionSecret

# Allowed admin emails:
gh secret set ALLOWED_EMAILS --body "hangocthanhperu3107@gmail.com"

# TS_AUTHKEY và HEADSCALE_NOISE_KEY sẽ set ở Bước 6 (sau khi headscale chạy)
```

> **Kiểm tra secrets đã set:**
> ```powershell
> gh secret list
> ```

---

## Bước 4 — Build tất cả Docker images

Trigger từng workflow build (chạy lần lượt hoặc song song — độc lập nhau):

```powershell
cd D:\05. Peru\03.Taile\TailscaleRemote

gh workflow run module-derp-controller.yml
gh workflow run module-api-center.yml
gh workflow run module-admin-ui.yml
gh workflow run module-derp-relay.yml
gh workflow run module-latency.yml
gh workflow run module-collector-sidecar.yml
gh workflow run module-gateway.yml
```

Theo dõi tiến trình:

```powershell
# Xem tất cả run đang chạy:
gh run list --limit 20

# Xem log chi tiết từng workflow:
gh run list --workflow=module-derp-controller.yml
gh run view <RUN_ID> --log
```

Chờ tất cả workflows hiện `✓ completed` trước khi sang Bước 5.

---

## Bước 5 — Deploy vpn2 lần đầu (không có noise key)

```powershell
gh workflow run deploy-control-plane.yml `
  -f confirm=deploy `
  -f target=vpn2
```

Workflow sẽ thực hiện (tự động):

```
1. SSH vào vpn2 (165.22.12.169)
2. Tạo /opt/tailscale-remote/deploy/vpn2/
3. Upload:
   - docker-compose.yml
   - Caddyfile
   - config/ (headscale config, derpmap template)
4. Tạo .env từ GitHub Secrets
5. docker compose pull (pull từ GHCR)
6. docker compose up -d
7. Health check: curl http://localhost/healthz → "ok"
```

Theo dõi:

```powershell
gh run list --workflow=deploy-control-plane.yml
gh run view <RUN_ID> --log
```

Kiểm tra nhanh sau deploy:

```powershell
# Từ máy local — kiểm tra health:
curl https://vpn2.hangocthanh.io.vn/healthz
# Kết quả mong đợi: ok
```

> **Lưu ý:** Ở bước này `collector-sidecar` sẽ **không** join tailnet được vì `TS_AUTHKEY` chưa có. Đây là bình thường — container sẽ restart loop, sẽ fix ở Bước 7.

---

## Bước 6 — Lấy noise_private.key và tạo pre-auth key

SSH vào vpn2:

```bash
ssh root@165.22.12.169
```

### 6.1 Lấy noise_private.key

```bash
# Chờ headscale generate key lần đầu (thường < 10s sau khi container chạy):
docker exec derp-controller cat /etc/headscale-keys/noise_private.key
```

Output sẽ dạng:

```
privkey:0a1b2c3d4e5f...64-char-hex
```

Encode sang base64 để set secret an toàn:

```bash
docker exec derp-controller \
  cat /etc/headscale-keys/noise_private.key | base64 -w 0
```

Copy toàn bộ output (1 dòng base64, không xuống dòng).

### 6.2 Tạo pre-auth key cho collector-sidecar

```bash
# Tạo reusable key, hạn 365 ngày, namespace "main":
docker exec derp-controller \
  headscale preauthkeys create --reusable --expiration 365d -u main
```

Output ví dụ:

```
2026-06-21 12:34:56 [INFO] Created new preauthkey...
tskey-auth-AbcDef...
```

Copy key bắt đầu bằng `tskey-auth-...`.

### 6.3 Set secrets

Từ máy local (PowerShell):

```powershell
# noise key (paste output base64 từ bước 6.1):
gh secret set HEADSCALE_NOISE_KEY --body "BASE64_OUTPUT_FROM_ABOVE"

# pre-auth key (paste key tskey-auth-... từ bước 6.2):
gh secret set TS_AUTHKEY --body "tskey-auth-AbcDef..."
```

---

## Bước 7 — Re-deploy vpn2 với đầy đủ secrets

```powershell
gh workflow run deploy-control-plane.yml `
  -f confirm=deploy `
  -f target=vpn2
```

Lần này `collector-sidecar` sẽ có `TS_AUTHKEY` → join tailnet thành công.

Kiểm tra sau deploy:

```powershell
# SSH vào vpn2:
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2

# Xem tất cả containers:
docker compose ps

# collector-sidecar phải ở trạng thái "running" (không phải "restarting"):
docker compose logs collector-sidecar --tail=20

# Kiểm tra tailnet join:
docker exec collector-sidecar tailscale status
```

---

## Bước 8 — Deploy vpn6

```powershell
gh workflow run deploy-control-plane.yml `
  -f confirm=deploy `
  -f target=vpn6
```

Workflow sẽ:
- SSH vào vpn6 (45.119.87.220)
- Cài đặt tương tự vpn2 nhưng không có: `latency`, `collector-sidecar`, `gateway` (Caddy riêng)
- Caddy trên vpn6 dùng snippet include từ `/etc/caddy/tailscale-remote.conf`

Kiểm tra:

```bash
# SSH vào vpn6:
ssh root@45.119.87.220

docker compose ps
curl http://localhost/healthz
# → ok
```

---

## Bước 9 — Cấu hình Cloudflare DNS Load Balancer

1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com) → chọn domain `hangocthanh.io.vn`
2. Vào **Traffic → Load Balancing → Create Load Balancer**

### Tạo Origin Pool

```
Pool name: tailscale-remote-pool
Origins:
  - Name: vpn2
    Address: 165.22.12.169
    Weight: 1
  - Name: vpn6
    Address: 45.119.87.220
    Weight: 1
Health check monitor: (tạo mới)
  - Type: HTTPS
  - Path: /healthz
  - Expected codes: 200
  - Expected body: ok
  - Interval: 30
  - Retries: 2
  - Timeout: 5
```

### Tạo Load Balancer

```
Hostname: vpn2.hangocthanh.io.vn
Pools: tailscale-remote-pool
Fallback pool: tailscale-remote-pool (same)
Session affinity: None (stateless)
Steering policy: Round Robin
Proxy status: Proxied (orange cloud) — bật để dùng WAF
```

> **Lưu ý UDP (STUN):** Cloudflare free tier không proxy UDP. STUN port 3478 UDP phải trỏ trực tiếp về vpn2 bằng DNS A record riêng:
> ```
> stun.hangocthanh.io.vn  A  165.22.12.169  (DNS only, không proxy)
> ```
> Hoặc configure Tailscale client dùng STUN server riêng.

---

## Bước 10 — Kiểm tra toàn hệ thống

### Health checks

```powershell
# Control plane health:
curl https://vpn2.hangocthanh.io.vn/healthz
# → ok

# API endpoint:
curl https://vpn2.hangocthanh.io.vn/app/api/derp
# → JSON array: [{"id":1,"hostname":"vpn2.hangocthanh.io.vn",...}]

# DERP relay probe:
curl https://vpn2.hangocthanh.io.vn/derp/probe
# → HTTP 200

# Headscale key endpoint (Tailscale client dùng cái này):
curl https://vpn2.hangocthanh.io.vn/key
# → JSON với publicKey
```

### Admin UI

```
1. Mở browser: https://vpn2.hangocthanh.io.vn/app/
2. Click "Login with Google"
3. Đăng nhập với hangocthanhperu3107@gmail.com
4. Sau login → redirect về dashboard
5. Kiểm tra menu: DERP Regions, Nodes, Latency
```

### Version check

```powershell
gh workflow run check-versions.yml
gh run list --workflow=check-versions.yml
# Chờ complete rồi xem log
gh run view <RUN_ID> --log
```

### Container status tổng quan

```bash
# SSH vpn2:
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2
docker compose ps

# Kết quả mong đợi (tất cả Up):
# derp-controller    Up
# api-center         Up
# admin-ui           Up
# derp-relay         Up
# latency            Up
# collector-sidecar  Up
# gateway            Up
```

---

## Troubleshooting

### derp-controller không start

```bash
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2
docker compose logs derp-controller --tail=50
```

Lỗi thường gặp:

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `cannot connect to database` | HS_DB_* sai hoặc Neon DB tắt | Kiểm tra secrets, thử connect thủ công |
| `failed to load private key` | HEADSCALE_NOISE_KEY sai format | Re-encode base64, re-deploy |
| `address already in use :3478` | Port conflict | `ss -tulpn | grep 3478` |

### api-center auth fail

```bash
docker compose logs api-center --tail=50
```

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `Invalid OAuth callback` | Redirect URI không khớp | Kiểm tra Google Console URI |
| `User not allowed` | Email không trong ALLOWED_EMAILS | Cập nhật secret |
| `DATABASE_URL invalid` | Connection string sai | Kiểm tra Neon dashboard |

### Caddy/gateway TLS fail

```bash
docker compose logs gateway --tail=50
```

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `certificate authority error` | Domain chưa trỏ về IP | Kiểm tra DNS propagation |
| `connection refused :80` | Firewall block port 80 | `ufw allow 80` |
| `bind: permission denied` | Port < 1024 cần root | Chạy Docker với root hoặc cấp capability |

### collector-sidecar loop restart

```bash
docker compose logs collector-sidecar --tail=30
```

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `invalid auth key` | TS_AUTHKEY hết hạn hoặc sai | Tạo key mới (Bước 6.2), re-deploy |
| `failed to connect to control` | vpn2 chưa healthy khi container start | `docker compose restart collector-sidecar` |

### Server migration (chuyển sang server mới)

Khi cần chuyển vpn2 sang IP/server mới:

```bash
# 1. Backup volumes quan trọng trên server cũ:
ssh root@165.22.12.169
docker run --rm \
  -v derp_controller_run:/data \
  -v /tmp/backup:/backup \
  alpine tar czf /backup/derp_controller_run.tar.gz /data
scp root@165.22.12.169:/tmp/backup/derp_controller_run.tar.gz .

# 2. Update GitHub Secret VPN2_HOST với IP mới
gh secret set VPN2_HOST --body "NEW_IP"

# 3. Cập nhật DNS A record về IP mới

# 4. Re-deploy
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=vpn2

# 5. Restore volume (nếu cần giữ noise key cũ):
# Trên server mới:
docker run --rm \
  -v derp_controller_run:/data \
  -v /tmp/backup:/backup \
  alpine tar xzf /backup/derp_controller_run.tar.gz -C /
```
