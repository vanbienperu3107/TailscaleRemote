# Module: api-center

**Image:** `ghcr.io/vanbienperu3107/api-center:latest`
**Source:** `modules/api-center/`
**Stack:** Fastify + TypeScript + Drizzle ORM + Neon PostgreSQL
**Port nội bộ:** 8787
**Chạy trên:** vpn2, vpn6 (HA replica)

---

## Mục đích

Hub API trung tâm. Toàn bộ hệ thống (Admin-UI, DERP-Controller, Latency, Client Mod) đều giao tiếp qua api-center. Không có business logic nào nằm ở client.

---

## API Endpoints

### Auth (`/api/auth/`)

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/auth/google/login` | — | Bắt đầu Google OAuth flow, redirect Google |
| GET | `/api/auth/google/callback` | — | OAuth callback, verify state, tạo session |
| GET | `/api/auth/me` | Optional | User hiện tại (401 nếu chưa login) |
| POST | `/api/auth/logout` | Required | Xóa session |

### DERP Nodes (`/api/derp/`)

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/derp` | Required | Danh sách tất cả DERP regions (embedded đầu, rồi theo regionId) |
| POST | `/api/derp` | Required | Tạo DERP region mới (auto-assign regionId, tránh 999) |
| GET | `/api/derp/next-region-id` | Required | Xem trước regionId tiếp theo |
| GET | `/api/derp/health` | Required | Probe tất cả DERP nodes (song song, trả latency ms) |
| PATCH | `/api/derp/:regionId` | Required | Cập nhật config region (block nếu embedded) |
| POST | `/api/derp/:regionId/toggle` | Required | Bật/tắt/maintenance (block nếu embedded) |
| DELETE | `/api/derp/:regionId` | Required | Xóa region (block nếu embedded) |

### DERPMap (public)

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/derpmap.json` | — | Dynamic DERPMap, dựng từ `derp_servers` (`enabled && !paused && !embedded`). Hai người tiêu thụ: (1) DERP-Controller poll mỗi 10s để phân phối DERPMap cho client; (2) job `discover` trong `.github/workflows/module-derp-relay.yml` — CI đọc route public này qua Caddy (`deploy/vpn2/Caddyfile`: `handle /derpmap.json { reverse_proxy api-center:8787 }`) để tự sinh matrix relay node cần deploy, không hardcode vpn3/vpn4/vpn6 trong YAML nữa. Đây là **nguồn duy nhất** cho cả headscale lẫn CI. |
| GET | `/api/internal/derp-map/:nodeKey` | Semi-public | Per-node DERPMap cho Feature B |

### Machines & Users

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/machines` | Required | Danh sách nodes với online status |
| POST | `/api/nodes/:id/rename` | Required | Đổi tên given_name |
| PUT | `/api/nodes/:id/tags` | Required | Set tags |
| GET | `/api/users` | Required | Danh sách tailnet users |
| POST | `/api/users` | Required | Tạo user |
| DELETE | `/api/users/:name` | Required | Xóa user |
| GET | `/api/hs-routes` | Required | Danh sách routes đang advertise |

### Pre-auth Keys & ACL

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/preauthkeys` | Required | Danh sách pre-auth keys (tất cả users) |
| POST | `/api/preauthkeys` | Required | Tạo pre-auth key |
| GET | `/api/acl` | Required | Lấy ACL policy hiện tại |
| PUT | `/api/acl` | Required | Cập nhật ACL policy |

### Latency, Devices & Metrics

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/latency` | Required | Aggregated peer-to-peer latency từ Neon DB |
| POST | `/api/metrics/report` | IP-based | Nhận latency report từ Client Mod, DERP Relay và latency module |
| POST | `/api/metrics/netcheck` | IP-based | Nhận `tailscale netcheck` result từ client |
| GET | `/api/metrics/health` | Public | Smoke gate sau deploy — kiểm tra reporter có báo cáo gần đây không |
| GET | `/api/devices` | Required | Danh sách thiết bị từ node dedup history (latency module ghi) |
| POST | `/api/devices/report` | IP-based | Latency module upsert device info sau mỗi poll headscale API |
| GET | `/api/netcheck` | Required | Latest `tailscale netcheck` per client |

**`/api/metrics/health`:** `?expect=collector,vpn3,vpn4&window=180` → 200 `{ok:true}` hoặc 503 `{ok:false, stale:[...]}`. Dùng trong deploy workflow.

### Force Routes

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/force-routes` | Required | Danh sách force-route rules |
| POST | `/api/force-routes` | Required | Tạo rule (clientIp → regionId) |
| PATCH | `/api/force-routes/:id` | Required | Cập nhật rule |
| DELETE | `/api/force-routes/:id` | Required | Xóa rule |
| POST | `/api/force-routes/sync/:regionId` | Required | SSH vào DERP node, apply iptables |
| POST | `/api/force-routes/clear/:regionId` | Required | SSH vào DERP node, xóa chain DERP-FORCE |

### Node Assignments (Feature B)

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/node-assignments` | Required | Danh sách per-node DERP assignments |
| PUT | `/api/node-assignments` | Required | Gán region cho nodeKey |
| DELETE | `/api/node-assignments/:nodeKey` | Required | Xóa assignment |

### Settings & CI

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/api/settings/apikey` | Required | Headscale API key status (prefix, ngày seed/refresh) |
| POST | `/api/settings/apikey/refresh` | Required | Rotate Headscale API key |
| POST | `/api/settings/apikey/webhook` | Webhook | Nhận API key từ GitHub Actions deploy |
| GET | `/api/ci` | Required | GitHub Actions runs gần nhất (8 per repo) |
| GET | `/healthz` | — | Health check — DB SELECT 1, trả `ok` |

---

## Database Schema (Neon PostgreSQL)

### `derp_servers`
| Column | Type | Ghi chú |
|--------|------|---------|
| regionId | int PK | 999 = embedded vpn2 (read-only) |
| code | text | Ví dụ: `vpn3-vn` |
| name | text | Ví dụ: `Vietnam - vpn3` |
| nodeName | text | Tên node trong DERPMap |
| hostname | text | FQDN |
| ipv4 | text | IP |
| derpPort | int | Default 443 |
| stunPort | int | Default 3478 |
| enabled | bool | false → không xuất hiện trong derpmap.json |
| paused | bool | true → maintenance score=9999, client tự chuyển |
| maintenance | bool | Giống paused, hiển thị trạng thái khác trên UI |
| embedded | bool | true = region 999 vpn2, không xóa/sửa được |
| priority | int | 1–1000, default 100. Thấp hơn = ưu tiên hơn |
| sshUser, sshPort | text/int | Dùng cho force-routes iptables sync |

**Logic DERPMap:** `enabled=true AND paused=false AND embedded=false`. Priority → RegionScore (inverted, 0.01–10).

### `latency_samples`

| Column                   | Type                          |
|--------------------------|-------------------------------|
| srcHostname, dstHostname | text (composite PK)           |
| srcIp, mac               | text                          |
| rttMs                    | real                          |
| path                     | text (direct or derp:code)    |
| ok                       | bool                          |
| reportedAt               | timestamptz                   |

UPSERT mỗi lần nhận report → giữ bản mới nhất. Nguồn: client (metrics-report.ps1), relay nodes (reporter.py), latency module (server ping via collector).

### `devices`

| Column      | Type                |
|-------------|---------------------|
| userName    | text (PK part)      |
| hostname    | text (PK part)      |
| mac         | text (nullable)     |
| nodeId      | text                |
| ipv4        | text                |
| machineKey  | text                |
| firstSeen   | timestamptz         |
| lastSeen    | timestamptz         |
| seenCount   | integer             |

Thay thế SQLite `devices.db`. Ghi bởi latency module sau mỗi poll headscale API. MAC được cập nhật khi client gửi metrics report.

### `client_netcheck`

| Column        | Type        |
|---------------|-------------|
| client        | text PK     |
| preferredDerp | text        |
| regionLatency | text (JSON) |
| reportedAt    | timestamptz |

Latest `tailscale netcheck` per client. UPSERT theo hostname.

### `derp_force_routes`
Bảng lưu (clientIp, regionId) pairs cho iptables DERP-FORCE chain.

### `derp_node_assignments`
Bảng lưu (nodeKey, regionId) cho Feature B per-node DERPMap.

### `headscale_api_keys`
Single-row (id=1). Lưu Headscale API key hiện tại, prefix, ngày seed/refresh.

### `users`, `sessions`
OAuth user cache và session management. Session lưu DB → stateless, cả vpn2 và vpn6 đọc được session nhau (điều kiện HA).

---

## Environment Variables

```env
# Bắt buộc
DATABASE_URL                    # Neon PostgreSQL connection string
PORT                            # default 8787
PUBLIC_URL                      # Base URL cho OAuth redirect, ví dụ: https://vpn2.hangocthanh.io.vn/app
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SESSION_SECRET                  # 32+ ký tự random, ký cookie + webhook auth
ALLOWED_EMAILS                  # email1@gmail.com,email2@gmail.com
HEADSCALE_API_URL               # default http://derp-controller:8080
HEADSCALE_API_KEY               # Headscale API key (bootstrap, sau đó lưu DB)
HEADSCALE_DASHBOARD_SECRET      # X-Headscale-Secret header cho Feature B

# Tùy chọn
CORS_ORIGIN                     # default auto từ PUBLIC_URL
METRICS_SHARED_SECRET           # nếu muốn auth metrics report theo secret thay IP
DERP_SSH_PRIVATE_KEY            # PEM private key để SSH sync iptables
GITHUB_TOKEN                    # PAT cho CI tab
GITHUB_REPOS                    # owner/repo1,owner/repo2
AUTH_OPTIONAL                   # true = dev mode không cần login
NODE_ENV                        # production / development
```

---

## Healthcheck

```bash
curl https://vpn2.hangocthanh.io.vn/healthz
# → ok
```

Container tự healthcheck mỗi 5s, 12 retries, start_period 20s. `derp-controller` depends_on api-center healthy.
