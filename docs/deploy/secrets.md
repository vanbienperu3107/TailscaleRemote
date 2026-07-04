# Secrets & Environment Variables

Tất cả secrets được lưu trong **GitHub Repository Secrets** (`Settings → Secrets and variables → Actions`).
Không commit file `.env` vào repo. Deploy workflow ghi `.env` từ secrets trước khi copy lên server.

---

## Secrets hiện có (đã set)

| Secret | Giá trị |
|--------|---------|
| `VPN3_HOST` | 64.176.23.196 |
| `CONTROL_DOMAIN` | vpn2.hangocthanh.io.vn |

---

## Secrets cần set thêm

### Control Plane (vpn2 + vpn6)

| Secret | Dùng bởi | Ví dụ / Mô tả |
|--------|---------|--------------|
| `VPN2_HOST` | deploy-control-plane, module CIs | IP hoặc domain vpn2 |
| `VPN2_USER` | deploy-control-plane, module CIs | `root` hoặc user SSH |
| `VPN2_SSH_KEY` | deploy-control-plane, module CIs | Nội dung private key SSH (`-----BEGIN...`) |
| `VPN6_HOST` | deploy-control-plane | 45.119.87.220 |
| `VPN6_USER` | deploy-control-plane | user SSH vpn6 |
| `VPN6_SSH_KEY` | deploy-control-plane | Private key SSH vpn6 |
| `DATABASE_URL` | api-center | `postgres://user:pass@host.neon.tech/db?sslmode=require` |
| `GOOGLE_CLIENT_ID` | api-center, derp-controller | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | api-center, derp-controller | Google OAuth client secret |
| `SESSION_SECRET` | api-center | Random string 32+ chars. **Phải giống nhau trên vpn2 và vpn6** |
| `ALLOWED_EMAILS` | api-center | `email1@gmail.com,email2@gmail.com` |
| `HEADSCALE_API_KEY` | api-center | Headscale API key (bootstrap, sau đó lưu DB) |
| `HEADSCALE_DASHBOARD_SECRET` | api-center, derp-controller | Shared secret cho Feature B |
| `HS_DB_HOST` | derp-controller | Neon Postgres host |
| `HS_DB_NAME` | derp-controller | Database name |
| `HS_DB_USER` | derp-controller | Database user |
| `HS_DB_PASS` | derp-controller | Database password |
| `HEADSCALE_NOISE_KEY` | deploy-control-plane | `cat noise_private.key \| base64`. **Phải giống nhau vpn2+vpn6** |
| `TS_AUTHKEY` | collector-sidecar | Pre-auth key để join tailnet làm `collector` |

### Relay Nodes

`module-derp-relay.yml` không hardcode danh sách node — job `discover` fetch `/derpmap.json` (public, api-center dựng từ bảng `derp_servers`) để lấy danh sách relay node active, rồi job `deploy-relay` tra secret SSH động theo quy ước `VPN{N}_HOST/_USER/_SSH_KEY` (N = chữ số trong tên node). Thêm node mới vào DB + khai đủ 3 secret dưới đây là tự động được đưa vào deploy, không cần sửa workflow. Node thiếu secret sẽ bị bỏ qua (cảnh báo, không fail workflow).

| Secret | Dùng bởi | Mô tả |
|--------|---------|-------|
| `VPN3_USER` | module-derp-relay (`deploy-relay` matrix) | SSH user vpn3 |
| `VPN3_SSH_KEY` | module-derp-relay (`deploy-relay` matrix) | SSH key vpn3 |
| `VPN4_HOST` | module-derp-relay (`deploy-relay` matrix) | IP vpn4 |
| `VPN4_USER` | module-derp-relay (`deploy-relay` matrix) | SSH user vpn4 |
| `VPN4_SSH_KEY` | module-derp-relay (`deploy-relay` matrix) | SSH key vpn4 |
| `VPN{N}_HOST/USER/SSH_KEY` | module-derp-relay (`deploy-relay` matrix) | Mẫu chung cho bất kỳ relay node mới nào — N lấy từ tên node trong `/derpmap.json` |

### Exit Node (standalone)

| Secret | Dùng bởi | Mô tả |
|--------|---------|-------|
| `PROXY_NODE_TS_AUTHKEY` | deploy-proxy-node | Pre-auth key cho proxy node join tailnet |
| `PROXY_NODE_USER` | deploy-proxy-node | Username SOCKS5/HTTP proxy (để trống = no auth) |
| `PROXY_NODE_PASS` | deploy-proxy-node | Password SOCKS5/HTTP proxy |

---

## Hướng dẫn set secrets

```bash
# Dùng GitHub CLI:
gh secret set VPN2_HOST --body "165.22.12.169"
gh secret set VPN2_USER --body "root"
gh secret set VPN2_SSH_KEY < ~/.ssh/id_rsa  # đọc từ file

# Hoặc qua web:
# github.com/vanbienperu3107/TailscaleRemote/settings/secrets/actions
```

---

## Lấy noise_private.key sau deploy đầu tiên

```bash
# SSH vào vpn2 sau lần deploy đầu tiên:
docker exec derp-controller cat /etc/headscale-keys/noise_private.key | base64
# → Copy toàn bộ output (kể cả dấu = cuối)
# → Paste vào GitHub Secret: HEADSCALE_NOISE_KEY
```

**Quan trọng:** Sau khi set `HEADSCALE_NOISE_KEY`, deploy lại cả vpn2 và vpn6 để đảm bảo cả hai dùng cùng key.

---

## Environment Variables mỗi service

### api-center
```env
DATABASE_URL=...
PORT=8787
PUBLIC_URL=https://vpn2.hangocthanh.io.vn/app
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
ALLOWED_EMAILS=...
HEADSCALE_API_KEY=...
HEADSCALE_API_URL=http://derp-controller:8080
HEADSCALE_DASHBOARD_SECRET=...
AUTH_OPTIONAL=false
NODE_ENV=production
```

### derp-controller (headscale)
```env
HEADSCALE_OIDC_CLIENT_ID=...
HEADSCALE_OIDC_CLIENT_SECRET=...
HEADSCALE_DERP_DASHBOARD_SECRET=...
HEADSCALE_DATABASE_POSTGRES_HOST=...
HEADSCALE_DATABASE_POSTGRES_PORT=5432
HEADSCALE_DATABASE_POSTGRES_NAME=...
HEADSCALE_DATABASE_POSTGRES_USER=...
HEADSCALE_DATABASE_POSTGRES_PASS=...
HEADSCALE_DATABASE_POSTGRES_SSL=true
```

### latency
```env
HS_API_URL=http://derp-controller:8080
HS_API_KEY=...           # = HEADSCALE_API_KEY
API_CENTER_URL=http://api-center:8787
POLL_INTERVAL=30
DRY_RUN=false
AUTO_APPROVE_ROUTES=true
TS_SOCKET=/var/run/tailscale/tailscaled.sock
SRC_NAME=collector
```

### collector-sidecar
```env
TS_AUTHKEY=...
TS_EXTRA_ARGS=--login-server=https://vpn2.hangocthanh.io.vn --hostname=collector --accept-dns=false
TS_STATE_DIR=/var/lib/tailscale
TS_SOCKET=/var/run/tailscale/tailscaled.sock
FORWARD_TARGET=api-center:8787
FORWARD_PORT=8090
```

### gateway (Caddy)
```env
DOMAIN=vpn2.hangocthanh.io.vn
```

### exit-node
```env
TS_AUTHKEY=...
EXIT_NODE_HOSTNAME=proxy-vpn3
TS_LOGIN_SERVER=https://vpn2.hangocthanh.io.vn
PROXY_USER=...            # để trống = no auth
PROXY_PASS=...
SOCKS5_PORT=1080
HTTP_PORT=8118
ADVERTISE_EXIT_NODE=false
```
