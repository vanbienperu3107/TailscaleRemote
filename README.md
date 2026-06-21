# TailscaleRemote

Monorepo hạ tầng Tailscale tự host — bao gồm toàn bộ custom modules, deploy configs và CI/CD workflows.

---

## Kiến trúc tổng quan

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  VPN2 (165.22.12.169 · vpn2.hangocthanh.io.vn)                     │
│                                                                     │
│  ┌──────────┐   /app/api/*   ┌─────────────┐   http  ┌──────────┐  │
│  │  Gateway ├──────────────►│  Api-center  ├────────►│  Neon DB │  │
│  │  (Caddy) │   /app/*       │  :8787       │         └──────────┘  │
│  │  :80/443 ├──────────────►│  Admin-UI    │                        │
│  │          │   /derp*       └──────┬───────┘                       │
│  │          ├──────────────────────┐│  /derpmap.json               │
│  │          │               ┌──────▼▼──────┐                       │
│  │          │               │DERP-Controller│  :8080                │
│  │          │               │(headscale fork)│                      │
│  │          │               └──────────────┘                        │
│  │          │                                                        │
│  │          │   :443 DERP   ┌─────────────┐                        │
│  └──────────┘  ────────────►│  DERP Relay │  vpn2                  │
│                              │  (derper)    │                        │
│  ┌──────────────────┐        └─────────────┘                        │
│  │  Latency         │◄── /metrics/report ──── Collector Sidecar     │
│  │  (node-dedup)    │                         (tailscale+socat)     │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
          ▲                          ▲
          │ /metrics/report          │ DERP relay traffic
          │ (qua tailnet)            │
  ┌───────┴───────┐         ┌────────┴────────┐
  │  DERP Relay   │         │   Client Mod     │
  │  vpn3/4/6     │         │  (Windows .exe)  │
  │  derper+      │         │  tailscale fork  │
  │  ping-reporter│         └─────────────────┘
  └───────────────┘
```

---

## Modules

### 1. Admin-UI `modules/admin-ui/`
**Vai trò:** Giao diện admin React/Vite thuần tĩnh.

- Không chứa business logic
- Mọi dữ liệu gọi qua `Api-center` (`/app/api/*`)
- Các tính năng: DERP node management, node assignment, force routes, ACL editor, pre-auth keys, users, machines, latency dashboard, CI/CD status
- **Build:** `vite build` → static files → nginx
- **Image:** `ghcr.io/vanbienperu3107/admin-ui:latest`
- **Trigger CI:** thay đổi trong `modules/admin-ui/**`

### 2. Api-center `modules/api-center/`
**Vai trò:** Hub API trung tâm — toàn bộ hệ thống giao tiếp qua đây.

- Fastify + TypeScript + Drizzle ORM
- Quản lý: DERP nodes, derpmap.json, node assignments, force routes, latency data, ACL, pre-auth keys, users, machines, headscale API key
- Google OAuth session auth (không dùng oauth2-proxy)
- **Endpoints quan trọng:**
  - `GET /derpmap.json` → DERP-Controller fetch mỗi 10s
  - `POST /api/metrics/report` → Client Mod + DERP Relay gửi latency
  - `GET /api/internal/derp-map/:nodeKey` → DERP-Controller Feature B
  - `GET /api/nodes`, `DELETE /api/nodes/:id`, ... → quản lý node
  - `GET /api/acl`, `PUT /api/acl` → quản lý ACL policy
  - `GET /api/preauthkeys`, `POST /api/preauthkeys` → pre-auth key management
- **Image:** `ghcr.io/vanbienperu3107/api-center:latest`
- **Trigger CI:** thay đổi trong `modules/api-center/**` hoặc `contracts/**`

### 3. DERP-Controller *(repo riêng)*
**Vai trò:** Control plane Tailscale — não điều phối toàn bộ tailnet.

- Fork của [juanfont/headscale](https://github.com/juanfont/headscale) v0.27.1
- Patch thêm: per-node DERPMap (Feature B), DERP dashboard integration
- Chức năng: đăng ký node, key exchange (WireGuard/Noise), ACL distribution, MagicDNS, DERPMap distribution, OIDC device auth
- Fetch `/derpmap.json` từ Api-center mỗi 10s → push xuống client
- **Embedded DERP đã tắt** — vpn2 dùng container `derp-relay` riêng
- **Repo:** `github.com/vanbienperu3107/headscale`
- **Image:** `ghcr.io/vanbienperu3107/headscale:0.27.1-pernode`

### 4. DERP Relay `modules/derp-relay/`
**Vai trò:** Relay TCP/UDP giữa client khi không P2P được + đo latency.

- **Một image duy nhất** chạy trên **vpn2, vpn3, vpn4, vpn6**
- `derper` (Go binary from `tailscale.com/cmd/derper`) — relay chính
- `reporter.py` (Python) — ping peers qua tailnet LocalAPI, gửi latency về Api-center mỗi 30s
- DERP traffic được mã hoá đầu cuối (relay không thấy nội dung)
- Quản lý qua Admin-UI (bật/tắt, maintenance mode, region assignment)
- **Image:** `ghcr.io/vanbienperu3107/derp-relay:latest`
- **Trigger CI:** thay đổi trong `modules/derp-relay/**`
- **Deploy:** tự động lên cả 4 node (vpn2/3/4/6) sau khi build

### 5. Latency `modules/latency/`
**Vai trò:** Thu thập và lưu latency report. Không serve UI.

- Python 3.12 — `dedup.py`
- Nhận POST `/metrics/report` từ Client Mod và DERP Relay (qua Collector Sidecar)
- Dedup node theo hostname (xóa bản trùng OFFLINE)
- Tự động approve subnet routes
- Ping node qua tailnet LocalAPI socket (từ Collector Sidecar)
- Data lưu vào SQLite local (`/data/devices.db`)
- **Image:** `ghcr.io/vanbienperu3107/latency:latest`

### 6. Collector Sidecar `modules/collector-sidecar/`
**Vai trò:** Cầu nối mạng — cung cấp tailnet IP để relay nodes báo cáo latency về Latency module.

- `tailscale` daemon: join tailnet với hostname `collector`, cung cấp IP tailnet và LocalAPI socket
- `socat`: forward port 8090 → `latency:8090` để relay nodes POST `/metrics/report` tới `collector:8090`
- Nếu Collector Sidecar tắt: latency report tạm dừng, `/api/latency` trong Admin-UI vẫn hoạt động (từ DB)
- **Image:** `ghcr.io/vanbienperu3107/collector-sidecar:latest`

### 7. Gateway `modules/gateway/`
**Vai trò:** TLS termination, HTTP routing, điểm vào duy nhất từ internet.

- Caddy với plugin `replace-response` (inject UI buttons)
- Route table:
  - `/app/api/*` → Api-center:8787
  - `/app/*` → Admin-UI:80
  - `/derp*`, `/key`, `/ts2021`, `/noise`, `/api/v1/*` → DERP-Controller:8080 (no auth)
  - `/derp-status*` → Latency:8090 (internal diagnostic)
  - `/` → redirect `/app/`
- **Không có business logic** — chỉ proxy

### 8. Client Mod *(repo riêng)*
**Vai trò:** Tailscale fork tùy chỉnh cho Windows.

- Kết nối tailnet qua DERP-Controller
- Custom DERP relay selection
- Báo cáo latency về Api-center qua `/api/metrics/report`
- **Repo:** `github.com/vanbienperu3107/tailscale_mod`

---

## Luồng dữ liệu chính

### Luồng 1: DERP Map (bật/tắt relay qua Admin-UI → client tự cập nhật)
```
Admin toggle → Admin-UI → Api-center → UPDATE derpServers.enabled → Neon DB
DERP-Controller poll /derpmap.json (10s) → Api-center → SELECT enabled=true → DERPMap
DERP-Controller push DERPMap → Client Mod (long-poll)
Client Mod tự chọn relay tốt nhất
```

### Luồng 2: Latency report (relay đo → Admin-UI hiển thị)
```
DERP Relay ping-reporter → POST /metrics/report → collector:8090 (tailnet)
Collector Sidecar socat forward → Latency:8090
Latency lưu vào SQLite
Admin-UI → GET /api/latency → Api-center → query SQLite
```

### Luồng 3: Đăng ký thiết bị mới
```
Client Mod: tailscale up --login-server=vpn2...
→ Gateway → DERP-Controller /register/:key
→ DERP-Controller redirect → Google OIDC
→ Google callback → node registered → IP 100.x.x.x cấp
→ DERPMap + ACL push → Client Mod sẵn sàng
```

### Luồng 4: Quản lý ACL
```
Admin-UI → GET /api/acl → Api-center → GET headscale /api/v1/policy
Admin edit HuJSON → PUT /api/acl → Api-center → PUT headscale /api/v1/policy
DERP-Controller áp dụng ngay → push ACL update xuống client
```

---

## CI/CD & Dependency Check

Mỗi module có workflow riêng, trigger theo path:

| Workflow | Trigger path | Deploy target |
|---|---|---|
| `module-admin-ui.yml` | `modules/admin-ui/**` | vpn2 (admin-ui container) |
| `module-api-center.yml` | `modules/api-center/**`, `contracts/**` | vpn2 (api-center container) |
| `module-derp-relay.yml` | `modules/derp-relay/**`, `contracts/**` | vpn2 + vpn3 + vpn4 + vpn6 |
| `module-latency.yml` | `modules/latency/**` | vpn2 (latency container) |
| `module-collector-sidecar.yml` | `modules/collector-sidecar/**` | vpn2 (collector-sidecar) |
| `deploy-vpn2.yml` | Manual trigger | Full stack vpn2 |

### Dependency check logic

Khi `contracts/api-center.json` thay đổi:
- `module-api-center.yml` warn nếu `/derpmap.json` schema đổi → cần test DERP-Controller
- `module-api-center.yml` warn nếu `/metrics/report` schema đổi → cần test Client Mod + DERP Relay
- `module-derp-relay.yml` verify reporter.py vẫn gửi đúng fields

Mỗi module deploy **độc lập** — thay đổi Admin-UI không restart Api-center, thay đổi DERP Relay không ảnh hưởng Latency.

---

## GitHub Secrets cần thiết

| Secret | Dùng bởi | Mô tả |
|---|---|---|
| `DATABASE_URL` | Api-center | Neon Postgres connection string |
| `GOOGLE_CLIENT_ID` | Api-center, DERP-Controller | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Api-center, DERP-Controller | Google OAuth client secret |
| `SESSION_SECRET` | Api-center | Cookie signing secret |
| `ALLOWED_EMAILS` | Api-center | Danh sách email được phép đăng nhập |
| `HEADSCALE_API_KEY` | Api-center | API key gọi DERP-Controller |
| `HEADSCALE_DASHBOARD_SECRET` | Api-center, DERP-Controller | Secret cho Feature B per-node DERPMap |
| `TS_AUTHKEY` | Collector Sidecar | Pre-auth key join tailnet |
| `VPN2_HOST` | Deploy workflows | IP vpn2 |
| `VPN2_USER` | Deploy workflows | SSH user vpn2 |
| `VPN2_SSH_KEY` | Deploy workflows | SSH private key vpn2 |
| `VPN3_HOST/USER/SSH_KEY` | derp-relay workflow | vpn3 deploy |
| `VPN4_HOST/USER/SSH_KEY` | derp-relay workflow | vpn4 deploy |
| `VPN6_HOST/USER/SSH_KEY` | derp-relay workflow | vpn6 deploy |

---

## Modules ngoài repo này

| Module | Repo | Mô tả |
|---|---|---|
| DERP-Controller | `vanbienperu3107/headscale` | headscale fork + per-node DERPMap patch |
| Client Mod | `vanbienperu3107/tailscale_mod` | Tailscale Windows fork + latency reporter |

---

## High Availability (HA)

**api-center, admin-ui, DERP-Controller** chạy trên cả **vpn2 và vpn6**. Cloudflare LB phân phối traffic và tự động failover.

### Kiến trúc HA

```
Internet
    │
    ▼
Cloudflare (DNS LB + Health check /healthz)
    ├── vpn2.hangocthanh.io.vn A 165.22.12.169  ← primary
    └── vpn2.hangocthanh.io.vn A 45.119.87.220  ← vpn6 (HA replica)
         ↕                            ↕
  ┌──────────────┐            ┌──────────────────────┐
  │ vpn2         │            │ vpn6 (co-host)       │
  │ Caddy        │            │ Existing Caddy       │
  │ derp-ctrl    ├── Neon ───►│ + caddy-snippet.conf │
  │ api-center   │  Postgres  │ derp-ctrl (HA)       │
  │ admin-ui     │  (shared)  │ api-center (HA)      │
  │ derp-relay   │            │ admin-ui (HA)        │
  │ latency      │            │ + existing relay     │
  └──────────────┘            └──────────────────────┘
```

### Điều kiện HA

1. **Neon Postgres** — dùng chung cho cả sessions, DERP registry, headscale nodes
2. **noise_private.key giống nhau** — lưu làm `HEADSCALE_NOISE_KEY` GitHub Secret (base64)
3. **SESSION_SECRET giống nhau** — cả 2 node verify được cookie của nhau
4. **Cloudflare LB** — health check `/healthz` → failover tự động

### Setup Cloudflare LB

```text
DNS → vpn2.hangocthanh.io.vn
  A  165.22.12.169  (vpn2)  Proxied ✓
  A  45.119.87.220  (vpn6)  Proxied ✓

Load Balancing:
  Pool "control-plane":
    Origin 1: 165.22.12.169  health check: HTTPS /healthz  expect: "ok"
    Origin 2: 45.119.87.220  health check: HTTPS /healthz  expect: "ok"
  Failover: Round Robin → nếu 1 origin fail, tất cả traffic sang origin còn lại
```

### Lấy noise_private.key lần đầu

```bash
# Sau lần deploy đầu tiên trên vpn2:
docker exec derp-controller cat /etc/headscale-keys/noise_private.key | base64
# → Copy output → GitHub Secret: HEADSCALE_NOISE_KEY
```

### Deploy HA (cả 2 node)

```bash
# Qua GitHub Actions (recommended):
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=both

# Hoặc chỉ 1 node:
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=vpn6
```

### GitHub Secrets bổ sung cho HA

| Secret | Mô tả |
|---|---|
| `CONTROL_DOMAIN` | Domain HA (vpn2.hangocthanh.io.vn) |
| `HEADSCALE_NOISE_KEY` | base64-encoded noise_private.key |
| `HS_DB_HOST` | Neon Postgres host |
| `HS_DB_NAME` | Neon DB name |
| `HS_DB_USER` | Neon DB user |
| `HS_DB_PASS` | Neon DB password |
| `VPN6_HOST` | IP vpn6 |
| `VPN6_USER` | SSH user vpn6 |
| `VPN6_SSH_KEY` | SSH private key vpn6 |

---

## Cách deploy lần đầu

```bash
# 1. Clone repo lên vpn2
ssh user@vpn2
git clone https://github.com/vanbienperu3107/TailscaleRemote /opt/tailscale-remote

# 2. Tạo .env
cp /opt/tailscale-remote/deploy/vpn2/.env.example /opt/tailscale-remote/deploy/vpn2/.env
# Điền đầy đủ secrets vào .env

# 3. Build gateway image (cần plugin replace-response)
cd /opt/tailscale-remote/deploy/vpn2
docker compose build gateway

# 4. Pull tất cả images và khởi động
docker compose pull
docker compose up -d

# 5. Kiểm tra health
docker compose ps
docker compose exec api-center wget -qO- http://localhost:8787/healthz
```

---

## Cách deploy relay node mới (vpn3/4/6)

```bash
ssh user@vpnX
mkdir -p /opt/tailscale-remote/deploy/relay
# Copy deploy/relay/docker-compose.yml lên server

# Tạo .env
cat > .env <<EOF
DERP_HOSTNAME=vpnX.hangocthanh.io.vn
REPORTER_NAME=vpnX
EOF

docker compose pull
docker compose up -d
```
