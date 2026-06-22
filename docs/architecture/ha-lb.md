# High Availability — Control Plane (vpn2 + vpn6)

---

## Tổng quan

Control plane (derp-controller + api-center + admin-ui) chạy song song trên **vpn2** và **vpn6**. Cloudflare DNS LB điều phối traffic và tự failover khi một node down.

```
Internet / Tailscale Clients
         │
         ▼
☁️ Cloudflare DNS LB
   vpn2.hangocthanh.io.vn
   A 165.22.12.169  (vpn2)  health check /healthz
   A 45.119.87.220  (vpn6)  health check /healthz
         │
    ┌────┴────┐
    ▼         ▼
  vpn2      vpn6
  PRIMARY   HA REPLICA
```

---

## Những gì chạy trên từng node

| Service | vpn2 (primary) | vpn6 (HA replica) |
|---------|---------------|-------------------|
| derp-controller | ✅ :8080 | ✅ :127.0.0.1:18081 |
| api-center | ✅ :8787 | ✅ :127.0.0.1:18787 |
| admin-ui | ✅ :80 | ✅ :127.0.0.1:18080 |
| gateway (Caddy) | ✅ container :80/:443 | ❌ dùng Caddy hệ thống + snippet |
| derp-relay | ✅ :8080 STUN:3479 | ❌ không cần (vpn6 có relay riêng) |
| latency | ✅ :8090 | ❌ chỉ vpn2 |
| collector-sidecar | ✅ | ❌ chỉ vpn2 |

---

## HA Challenges và giải pháp

| Thành phần | Challenge | Giải pháp |
|-----------|-----------|-----------|
| api-center | Stateless Fastify, sessions ở Neon | Chạy cả 2 node, cùng DB + SESSION_SECRET ✓ |
| admin-ui | Static files, zero state | Chạy cả 2 node trực tiếp ✓ |
| derp-controller | Default SQLite = single-writer | Switch Neon Postgres + chia sẻ noise_private.key |
| noise_private.key | Phải CÙNG key 2 instance | GitHub Secret (base64) → deploy ghi ra file |
| Load Balancer | Ai route traffic? | Cloudflare DNS LB + health check /healthz |
| vpn6 Caddy | Caddy sẵn có, không cài thêm Gateway | Thêm caddy-snippet.conf vào Caddy hiện có |
| latency/collector | Cần tailscale socket local | Chỉ vpn2, không HA — acceptable |
| derp-relay vpn2 | Nếu vpn2 down relay mất | Client fallback sang vpn3/vpn4/vpn6 relay ✓ |

---

## Điều kiện HA bắt buộc

### 1. Neon Postgres làm backend headscale
File `deploy/vpn2/config/config.yaml` và `deploy/vpn6/config/config.yaml` phải cấu hình:
```yaml
database:
  type: postgres
  postgres:
    host: ${HS_DB_HOST}
    port: 5432
    name: ${HS_DB_NAME}
    user: ${HS_DB_USER}
    password: ${HS_DB_PASS}
    ssl: true
```

### 2. noise_private.key giống nhau
```bash
# Lần đầu: lấy key từ vpn2 sau deploy đầu tiên
docker exec derp-controller cat /etc/headscale-keys/noise_private.key | base64
# → Copy → GitHub Secret: HEADSCALE_NOISE_KEY

# Deploy workflow tự động decode và ghi ra file:
echo "$HEADSCALE_NOISE_KEY" | base64 -d > ./headscale-keys/noise_private.key
```

### 3. SESSION_SECRET giống nhau
Cùng một giá trị trên cả 2 node → sessions của vpn2 và vpn6 verify được nhau.

### 4. DATABASE_URL giống nhau
Cùng Neon Postgres cho cả 2 node → api-center stateless, sessions lưu DB.

---

## Cloudflare Load Balancer Setup

```
Cloudflare Dashboard → DNS → Load Balancing

Pool: control-plane
  Origin 1: 165.22.12.169 (vpn2)
  Origin 2: 45.119.87.220 (vpn6)

Health check:
  Type: HTTPS
  Path: /healthz
  Expected body: ok
  Interval: 60s
  Timeout: 5s
  Healthy threshold: 1
  Unhealthy threshold: 2

Load Balancer:
  Hostname: vpn2.hangocthanh.io.vn
  Steering: Round Robin
  Failover: auto-remove failed origin
```

---

## vpn6 Caddy Snippet

File `deploy/vpn6/caddy-snippet.conf` được thêm vào Caddyfile hệ thống của vpn6.

Deploy workflow tự động:
1. Copy file lên `/opt/tailscale-remote/deploy/vpn6/caddy-snippet.conf`
2. Check nếu chưa có `import` thì thêm vào `/etc/caddy/Caddyfile`
3. Chạy `caddy reload`

**Routing table vpn6:**
```
vpn2.hangocthanh.io.vn {
  /derp*              → 127.0.0.1:18081  # derp-ctrl (không có relay)
  /key /ts2021 /...   → 127.0.0.1:18081  # headscale endpoints
  /api/v1/*           → 127.0.0.1:18081
  /app/api/*          → 127.0.0.1:18787  # api-center
  /app/*              → 127.0.0.1:18080  # admin-ui
  /healthz            → 127.0.0.1:18787  # Cloudflare health check
  /                   → redirect /app/
}
```

---

## Deploy HA

```bash
# Deploy cả 2 node (rolling, không downtime):
gh workflow run deploy-control-plane.yml \
  -f confirm=deploy \
  -f target=both

# Chỉ vpn2:
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=vpn2

# Chỉ vpn6:
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=vpn6
```

**Thứ tự deploy:** vpn2 → health check pass → vpn6. Nếu vpn2 deploy đang chạy và /healthz fail tạm thời, Cloudflare sẽ tự route 100% sang vpn6 trong thời gian đó.

---

## Secrets cần cho HA

| Secret | Dùng bởi | Mô tả |
|--------|---------|-------|
| `HEADSCALE_NOISE_KEY` | deploy-control-plane.yml | noise_private.key (base64). Phải giống nhau cả 2 node |
| `SESSION_SECRET` | api-center vpn2+vpn6 | Cookie signing. Phải giống nhau |
| `DATABASE_URL` | api-center vpn2+vpn6 | Neon Postgres |
| `HS_DB_HOST/NAME/USER/PASS` | derp-controller vpn2+vpn6 | Headscale Postgres |
| `VPN6_HOST` | deploy workflow | IP vpn6 |
| `VPN6_USER` | deploy workflow | SSH user vpn6 |
| `VPN6_SSH_KEY` | deploy workflow | SSH private key vpn6 |
| `CONTROL_DOMAIN` | deploy workflow | vpn2.hangocthanh.io.vn |
