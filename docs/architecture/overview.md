# Tổng quan kiến trúc hệ thống TailscaleRemote

<!-- Frontmatter -->
<!-- last_verified_commit: (cập nhật sau mỗi deploy) -->
<!-- last_verified_at: 2026-06-21 -->
<!-- verified_by: lead-orchestrator -->
<!-- status: active -->
<!-- next_review_due: 2026-09-21 -->

---

## 1. Giới thiệu

**TailscaleRemote** là hệ thống tự vận hành (self-hosted) Tailscale + Headscale, bao gồm control plane, DERP relay, dashboard admin, đo độ trễ mạng, và client mod cho Windows. Hệ thống được thiết kế theo hướng **High Availability (HA)** trên hai node chính (vpn2 + vpn6) với Cloudflare Load Balancer ở tầng DNS.

---

## 2. Danh sách 9 modules

| # | Module | Nguồn | Mô tả | Vị trí deploy |
|---|--------|-------|-------|---------------|
| 1 | `derp-controller` | External: `vanbienperu3107/headscale` fork | Headscale control plane — xác thực client, phân phối DERPMap, quản lý tailnet | vpn2 + vpn6 (HA) |
| 2 | `api-center` | `modules/api-center` | Fastify API hub — REST API cho admin-ui, Google OAuth, quản lý DERP node DB, proxy tới headscale | vpn2 + vpn6 (HA) |
| 3 | `admin-ui` | `modules/admin-ui` | React dashboard — giao diện quản lý DERP regions, nodes, latency, user | vpn2 + vpn6 (HA) |
| 4 | `derp-relay` | `modules/derp-relay` | DERP relay WebSocket + STUN + ping-reporter gửi latency về collector | vpn2, vpn3, vpn4, vpn6 |
| 5 | `latency` | `modules/latency` | node-dedup + server ping + auto-approve routes — ghi vào Neon via api-center | vpn2 only |
| 6 | `collector-sidecar` | `modules/collector-sidecar` | Tailscale daemon + socat bridge — join tailnet để ping-reporter trên relay node khác kết nối được | vpn2 only (cùng host latency) |
| 7 | `gateway` | `modules/gateway` | Caddy reverse proxy — TLS termination, routing tới tất cả service | vpn2 only |
| 8 | `exit-node` | `modules/exit-node` | gost SOCKS5/HTTP proxy standalone — join tailnet rồi cung cấp exit proxy | Bất kỳ VPS |
| 9 | `client-mod` | External: `vanbienperu3107/tailscale_mod` | Windows Tailscale client patch — kết nối về headscale thay vì Tailscale.com | Windows client |

---

## 3. Topology mạng

```
Internet
    │
    ▼
Cloudflare DNS Load Balancer
  hostname: vpn2.hangocthanh.io.vn
  pool:     165.22.12.169 (vpn2) + 45.119.87.220 (vpn6)
  health:   HTTPS GET /healthz → "ok"
  failover: automatic round-robin
    │
    ├──────────────────────────────────────────────────────┐
    ▼                                                      ▼
vpn2 (PRIMARY)                                    vpn6 (HA REPLICA)
165.22.12.169                                     45.119.87.220
Ubuntu 22.04                                      Ubuntu 22.04
    │                                                      │
    ▼                                                      ▼
Gateway (Caddy)                               Caddy (system install + snippet)
  TLS termination                               TLS termination
  Port 80/443                                   Port 80/443
    │                                                      │
    ├─ derp-controller (headscale)             ├─ derp-controller
    ├─ api-center (Fastify)                    ├─ api-center
    ├─ admin-ui (React static)                 ├─ admin-ui
    ├─ derp-relay (vpn2 local relay)           └─ derp-relay (vpn6 relay)
    ├─ latency (node-dedup + metrics)
    └─ collector-sidecar (Tailscale + socat)


vpn3 (64.176.23.196) — Standalone DERP Relay
  domain: vpn3.hangocthanh.io.vn
  └─ derp-relay container (DERP WebSocket + STUN)
     └─ ping-reporter → tailnet → collector:8090 → socat → api-center:8787 (vpn2)

vpn4 — Standalone DERP Relay (tương tự vpn3)

exit-node — Bất kỳ VPS
  └─ gost container
     └─ join tailnet + SOCKS5:1080 + HTTP:8080
```

---

## 4. Data flows (luồng dữ liệu)

### 4.1 Tailscale client — DERP relay

```
Tailscale client (Windows client-mod)
    → DNS → Cloudflare LB → vpn2/vpn6 :443
    → Caddy → /derp* → derp-relay
    → WebSocket DERP tunnel
```

Mục đích: relay traffic giữa các client khi không kết nối P2P trực tiếp được.

---

### 4.2 Tailscale client — Control plane

```
Tailscale client (Windows client-mod)
    → DNS → Cloudflare LB → vpn2/vpn6 :443
    → Caddy → /key, /ts2021, /api/v1/*
    → derp-controller (headscale)
    → xác thực, phát DERPMap, quản lý peer list
```

---

### 4.3 Admin browser — Dashboard

```
Admin browser
    → DNS → Cloudflare LB → :443
    → Caddy → /app/* → admin-ui (static bundle)
    → Caddy → /app/api/* → api-center (Fastify)
        → api-center → headscale REST API (gRPC gateway)
        → api-center → Neon Postgres (DERP node DB)
```

---

### 4.4 Latency reporting từ relay node ngoài

```
derp-relay container (vpn3/vpn4)
    └─ ping-reporter.py
        → tailnet (qua Tailscale IP)
        → collector-sidecar:8090 trên vpn2
        → socat bridge
        → api-center:8787
        → Neon Postgres (latency_samples)
```

---

### 4.5 Latency ping từ server (vpn2 → peers)

```
latency service (vpn2)
    → unix socket ts_sock (shared volume)
    → Tailscale LocalAPI
    → ping tới mọi peer trong tailnet
    → POST api-center:8787/api/metrics/report
    → Neon Postgres (latency_samples)
```

---

### 4.6 Windows client-mod — Latency

```
client-mod (Windows)
    → kết nối tailnet
    → collector:8090 trên vpn2 (qua tailnet IP)
    → socat bridge → api-center:8787/api/metrics/report
    → Neon Postgres (latency_samples)
```

---

### 4.7 Dynamic DERPMap — Pull định kỳ

```
derp-controller (headscale) — mỗi 10 giây
    → GET https://vpn2.hangocthanh.io.vn/app/api/derp-map
    → api-center → Neon Postgres (DERP node table)
    → trả về derpmap.json
    → headscale cache + phân phối cho client
```

---

### 4.8 Feature B — Per-node DERPMap

```
Tailscale client (nodeKey cụ thể)
    → derp-controller (headscale fork)
    → GET /api/internal/derp-map/:nodeKey
    → api-center → filtered DERPMap theo rules/priority
    → headscale trả DERPMap riêng cho từng node
```

---

## 5. Docker volumes (vpn2)

| Volume | Mount trong container | Mục đích |
|--------|-----------------------|----------|
| `derp_relay_certs` | `/certs` (derp-relay) | TLS certificates cho DERP relay |
| `collector_state` | `/var/lib/tailscale` (collector-sidecar) | Tailscale daemon state |
| `ts_sock` | `/ts_sock` (latency + collector-sidecar) | Unix socket chia sẻ LocalAPI |
| `derp_controller_run` | `/var/run/headscale` (derp-controller) | Headscale runtime files, socket |
| `gateway_data` | `/data` (gateway/Caddy) | Caddy TLS certs tự động (ACME) |
| `gateway_config` | `/config` (gateway/Caddy) | Caddyfile config |

---

## 6. Ports exposed

### vpn2

| Port | Protocol | Service | Mục đích |
|------|----------|---------|----------|
| 80 | TCP | gateway (Caddy) | HTTP → redirect HTTPS |
| 443 | TCP | gateway (Caddy) | HTTPS — tất cả traffic |
| 3478 | UDP | derp-controller | STUN control plane |
| 3479 | UDP | derp-relay | STUN relay (vpn2 local relay) |

### vpn3 / vpn4 (standalone relay)

| Port | Protocol | Service | Mục đích |
|------|----------|---------|----------|
| 443 | TCP | Nginx/Caddy host | DERP WebSocket (TLS termination) |
| 3478 | UDP | derp-relay | STUN |

---

## 7. High Availability design

### 7.1 derp-controller (headscale)

- **Database**: Neon Postgres (shared cloud DB) — cả vpn2 và vpn6 kết nối cùng endpoint
- **noise_private.key**: deploy cùng một key (từ secret `HEADSCALE_NOISE_KEY`) lên cả hai node → client không phân biệt được đang kết nối node nào
- **Stateless**: mỗi request độc lập, không cần session affinity
- **Failover**: Cloudflare LB tự chuyển traffic khi một node fail health check

### 7.2 api-center

- **Database**: Neon Postgres — sessions và DERP node data đều trên cloud DB
- **SESSION_SECRET**: cùng một secret → JWT/session valid trên cả hai node
- **Stateless**: không có local state

### 7.3 admin-ui

- **Pure static**: React bundle, zero state, zero session
- Deploy giống nhau lên cả hai node

### 7.4 latency + collector-sidecar

- **Single instance trên vpn2**: không cần HA
- Nếu vpn2 down, latency data tạm dừng nhưng không ảnh hưởng Tailscale traffic
- SQLite local — acceptable for monitoring workload

### 7.5 Cloudflare Load Balancer

```
Pool: vpn2 (primary) + vpn6 (secondary)
Health check: HTTPS GET /healthz
  → Expect HTTP 200, body "ok"
  → Interval: 30s, threshold: 2 failures
Failover: automatic, DNS TTL 30s
```

### 7.6 module-derp-relay.yml — discover-from-DB thay vì hardcode node

Workflow không còn định nghĩa cứng `deploy-vpn3`/`deploy-vpn4`/`deploy-vpn6`. Thay vào đó:

- **`discover`**: `curl` `/derpmap.json` (mặc định `https://vpn2.hangocthanh.io.vn/derpmap.json`, override qua repo variable `DERPMAP_URL`) — endpoint public do api-center dựng từ bảng `derp_servers` (Neon), chỉ gồm node `enabled && !paused && !embedded`. Kết quả build thành GitHub Actions matrix `{name, hostname, num}` (num = chữ số trong tên node).
- **`deploy-relay`** (matrix job): với mỗi node, tra secret SSH theo quy ước `VPN{num}_HOST/_USER/_SSH_KEY`. Thiếu secret → job cảnh báo và bỏ qua node đó (không fail toàn bộ workflow).
- **`deploy-vpn2`**: vẫn tách riêng vì vpn2 là node control/embedded, không nằm trong `derp_servers`.

Hệ quả: **thêm một relay node mới chỉ cần thêm vào DB (qua Admin-UI) + khai 3 secret `VPN{N}_*`** — không phải sửa file workflow. `/derpmap.json` vừa là nguồn DERPMap cho headscale, vừa là nguồn duy nhất cho CI xác định tập relay node cần deploy.

---

## 8. CI/CD flow

```
Developer push → GitHub (branch/PR)
    │
    ▼
.github/workflows/module-<name>.yml
    ├─ Run tests (unit/integration)
    ├─ Build Docker image
    │    └─ ghcr.io/vanbienperu3107/<module>:latest
    │    └─ ghcr.io/vanbienperu3107/<module>:<sha>
    └─ Push to GHCR

    (merge to main)
    │
    ▼
deploy-control-plane.yml
    ├─ Rolling deploy vpn2
    │    ├─ SSH → docker compose pull
    │    ├─ docker compose up -d
    │    └─ Health check /healthz (wait up to 60s)
    └─ Rolling deploy vpn6 (chỉ sau vpn2 healthy)
         ├─ SSH → docker compose pull
         ├─ docker compose up -d
         └─ Health check /healthz
```

Workflow modules riêng:

| Workflow | Trigger | Deploy target |
|----------|---------|---------------|
| `module-derp-controller.yml` | push `modules/derp-controller/**` | build + push GHCR |
| `module-api-center.yml` | push `modules/api-center/**` | build + push GHCR |
| `module-admin-ui.yml` | push `modules/admin-ui/**` | build + push GHCR |
| `module-derp-relay.yml` | push `modules/derp-relay/**` | build + push GHCR; job `discover` fetch `/derpmap.json` → matrix `deploy-relay` deploy tới mọi relay node active trong DB (không hardcode vpn3/vpn4/vpn6); job `deploy-vpn2` riêng cho node embedded |
| `module-latency.yml` | push `modules/latency/**` | build + push GHCR |
| `module-collector-sidecar.yml` | push `modules/collector-sidecar/**` | build + push GHCR |
| `module-gateway.yml` | push `modules/gateway/**` | build + push GHCR |
| `deploy-control-plane.yml` | manual dispatch hoặc push `deploy/` | rolling deploy vpn2 → vpn6 |
| `check-versions.yml` | manual / schedule | so sánh running vs GHCR latest |

---

## 9. Phân tầng bảo mật (trust boundaries)

```
[Public Internet]
    │  HTTPS 443 only (TLS 1.2+)
    ▼
[Cloudflare — WAF + DDoS]
    │
    ▼
[Caddy — TLS termination, rate limit]
    │
    ├──[/app/api/*]── api-center  ──[Google OAuth]── Admin only
    ├──[/derp*]────── derp-relay  ──[Tailscale auth]
    ├──[/key /ts2021] derp-controller ──[noise protocol]
    └──[/app/*]────── admin-ui (static, no auth at CDN level)

[Internal Docker network — isolated]
    derp-controller ↔ api-center (localhost/docker-net)
    latency ↔ collector-sidecar (unix socket)

[Tailnet — encrypted overlay]
    collector-sidecar ↔ ping-reporter (vpn3/4)
    client-mod ↔ collector
    exit-node ↔ peers
```

---

## 10. Sơ đồ tóm tắt các external dependencies

| Dependency | Loại | Dùng bởi | Ghi chú |
|------------|------|----------|---------|
| Neon Postgres | Cloud DB | api-center, derp-controller | HA tự động, serverless |
| Cloudflare | DNS LB + WAF | gateway (ingress) | Free tier đủ dùng |
| GHCR | Container registry | Tất cả modules | Miễn phí với public repo |
| Google OAuth | Auth provider | api-center | Chỉ admin login |
| GitHub Actions | CI/CD | Tất cả | Free tier |

---

## 11. Ghi chú kiến trúc

- **vpn6 co-host**: vpn6 (45.119.87.220) chạy chung box với `memory-stack` / `claude.hangocthanh.io.vn`. Caddy trên vpn6 là system install, TailscaleRemote dùng snippet include — không conflict.
- **vpn3 DERP**: vpn3 (64.176.23.196 / `vpn3.hangocthanh.io.vn`, Ubuntu 24.04, server mới 2026-06-19) chạy thuần DERP relay, không chạy control plane.
- **headscale fork**: `vanbienperu3107/headscale` — fork của headscale upstream, bổ sung Feature B (per-node DERPMap API). Không thay đổi noise protocol.
- **client-mod**: `vanbienperu3107/tailscale_mod` — fork Tailscale v1.98.4 cho Windows, patch server URL về `vpn2.hangocthanh.io.vn`.
- **exit-node**: Không có trong HA topology — standalone, bất kỳ VPS nào join tailnet.
