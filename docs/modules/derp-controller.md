# Module: derp-controller

**Image:** `ghcr.io/vanbienperu3107/derp-controller:latest`
**Alias image:** `ghcr.io/vanbienperu3107/headscale:0.27.1-pernode` (dùng trong docker-compose.yml)
**Source:** `modules/derp-controller/` (Dockerfile clone từ `vanbienperu3107/headscale` fork)
**Fork của:** [juanfont/headscale v0.27.1](https://github.com/juanfont/headscale) với patch Feature B
**Stack:** Go — headscale control plane
**Port nội bộ:** 8080 (API + DERP), 9090 (metrics), 50443 (gRPC)
**Chạy trên:** vpn2 (primary), vpn6 (HA replica)

---

## Mục đích

DERP-Controller là headscale — Tailscale-compatible control plane tự host. Quản lý toàn bộ tailnet: nodes, users, ACL, pre-auth keys, routes. Ngoài ra bổ sung **Feature B** (per-node DERPMap override).

---

## Sự khác biệt so với headscale gốc

| Tính năng | headscale gốc | Fork này |
|-----------|--------------|----------|
| DERP policy | Tất cả nodes nhận cùng DERPMap | Per-node DERPMap qua `/api/internal/derp-map/:nodeKey` |
| DERP backend | Static config YAML | Dynamically từ api-center (poll mỗi 10s) |
| Auth | OIDC chung | OIDC + `HEADSCALE_DASHBOARD_SECRET` cho api-center |

---

## Source và Build

Dockerfile trong `modules/derp-controller/` clone branch `feat/pernode-derpmap` từ `vanbienperu3107/headscale` và build binary headscale.

```
vanbienperu3107/headscale (feat/pernode-derpmap)
    → modules/derp-controller/Dockerfile
        → ghcr.io/vanbienperu3107/derp-controller:latest
        → ghcr.io/vanbienperu3107/headscale:0.27.1-pernode  ← alias
```

---

## Config files

Deploy configs tại `deploy/vpn2/config/` và `deploy/vpn6/config/`:

```
config/
├── config.yaml          # headscale main config
└── acls.yaml            # ACL policy mặc định
```

### Config quan trọng

```yaml
# config.yaml
server_url: https://vpn2.hangocthanh.io.vn
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 0.0.0.0:9090

database:
  type: postgres
  postgres:
    host: ${HS_DB_HOST}
    port: 5432
    name: ${HS_DB_NAME}
    user: ${HS_DB_USER}
    password: ${HS_DB_PASS}
    ssl: true

derp:
  urls:
    - https://vpn2.hangocthanh.io.vn/derpmap.json   # dynamic từ api-center

oidc:
  issuer: https://accounts.google.com
  client_id: ${HEADSCALE_OIDC_CLIENT_ID}
  client_secret: ${HEADSCALE_OIDC_CLIENT_SECRET}
```

---

## Environment Variables

```env
HEADSCALE_OIDC_CLIENT_ID=...
HEADSCALE_OIDC_CLIENT_SECRET=...
HEADSCALE_DERP_DASHBOARD_SECRET=...   # X-Headscale-Secret cho Feature B
HEADSCALE_DATABASE_POSTGRES_HOST=...
HEADSCALE_DATABASE_POSTGRES_PORT=5432
HEADSCALE_DATABASE_POSTGRES_NAME=...
HEADSCALE_DATABASE_POSTGRES_USER=...
HEADSCALE_DATABASE_POSTGRES_PASS=...
HEADSCALE_DATABASE_POSTGRES_SSL=true
```

---

## Feature B: Per-node DERPMap

Khi Tailscale client hỏi DERPMap, headscale fork gọi api-center:

```
GET /api/internal/derp-map/:nodeKey
Authorization: X-Headscale-Secret: <HEADSCALE_DASHBOARD_SECRET>
```

api-center trả về DERPMap đã lọc theo node assignment. Node không có assignment nhận full DERPMap bình thường.

---

## HA: noise_private.key

Headscale dùng Noise protocol key để verify clients. Key này phải giống nhau trên cả vpn2 và vpn6:

```bash
# Sau deploy đầu tiên trên vpn2:
docker exec derp-controller cat /etc/headscale-keys/noise_private.key | base64
# → Lưu vào GitHub Secret: HEADSCALE_NOISE_KEY
# → Re-deploy cả vpn2 + vpn6
```

Deploy workflow tự động decode secret và ghi ra file:
```bash
echo "$HEADSCALE_NOISE_KEY" | base64 -d > ./headscale-keys/noise_private.key
```

---

## API (Headscale gRPC/REST)

Headscale expose gRPC API nội bộ tại `:50443`. api-center gọi qua HTTP API tại `:8080`:

```bash
# Lấy danh sách nodes:
curl http://derp-controller:8080/api/v1/node -H "Authorization: Bearer $HS_API_KEY"

# Lấy DERPMap hiện tại:
curl https://vpn2.hangocthanh.io.vn/derpmap.json
```

---

## Healthcheck

```bash
curl https://vpn2.hangocthanh.io.vn/healthz
# → (headscale không có /healthz — dùng api-center làm health check proxy)
```

derp-controller healthcheck qua `/api/v1/apikey` endpoint nội bộ.
