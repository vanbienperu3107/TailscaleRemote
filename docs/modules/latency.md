# Module: latency (node-dedup + collector)

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Image | `ghcr.io/vanbienperu3107/latency:latest` |
| Source | `modules/latency/dedup.py` (Python 3.12) |
| Chạy trên | vpn2 only |
| Port | `8090` (HTTP collector, chỉ trong tailnet) |

## Mục đích

Module `latency` là thành phần trung tâm trên vpn2, đảm nhiệm ba chức năng độc lập trong một tiến trình Python duy nhất:

1. **Node Dedup** — Tự động dọn dẹp node trùng trong Headscale.
2. **Collector** — HTTP server nhận báo cáo latency từ relay nodes và Windows client, phục vụ dashboard và API.
3. **Auto-approve Routes** — Tự động duyệt route advertisement, không cần tác động thủ công.

Module này **phải chạy cùng host với `collector-sidecar`** (chia sẻ unix socket).

## Kiến trúc tổng thể

```
                    ┌─────────────────────────────────┐
                    │         vpn2 host                │
                    │                                  │
  relay nodes ─────►│  collector-sidecar               │
  (qua tailnet)    │  (tailscale + socat :8090)       │
                    │         │                        │
                    │         ▼ forward                │
                    │  ┌──────────────────────────┐   │
                    │  │   latency container       │   │
                    │  │                           │   │
                    │  │  [Node Dedup]             │   │
                    │  │  poll Headscale API       │   │
                    │  │  xóa node trùng           │   │
                    │  │                           │   │
                    │  │  [Collector :8090]        │   │
                    │  │  POST /metrics/report     │◄──┼── vpn3/vpn4/vpn6 reporter
                    │  │  GET  /metrics/latency    │   │   Windows client
                    │  │  GET  /metrics/health     │   │
                    │  │  GET  /stats              │   │
                    │  │  GET  /derp-status        │   │
                    │  │                           │   │
                    │  │  [Auto-approve Routes]    │   │
                    │  │  poll & approve           │   │
                    │  │                           │   │
                    │  │  [Server Ping]            │   │
                    │  │  LocalAPI → ping peers    │   │
                    │  └──────────────────────────┘   │
                    │         │ ts_sock volume          │
                    │         ▼                        │
                    │  /var/run/tailscale/tailscaled.sock │
                    └─────────────────────────────────┘
```

## Phần 1: Node Dedup

### Vấn đề

Headscale tạo **node mới** mỗi khi machine key thay đổi (cài lại Tailscale, build mới từ source, thư mục state mới). Kết quả là nhiều node có cùng hostname nhưng `given_name` bị thêm hậu tố ngẫu nhiên, ví dụ:

```
itop-thanhhn          ← keeper (online)
itop-thanhhn5-i8shta5a ← trùng (offline, cần xóa)
itop-thanhhn5-k9wqp2x ← trùng (offline, cần xóa)
```

### Logic dedup

```
Poll Headscale API (mỗi POLL_INTERVAL giây)
    │
    ├─► Gom node theo (user, hostname)
    │
    ├─► Với mỗi nhóm có > 1 node:
    │       Chọn "keeper":
    │         1. Ưu tiên node đang ONLINE
    │         2. Nếu tie: node có last_seen mới nhất
    │         3. Nếu vẫn tie: node có id nhỏ nhất
    │
    ├─► Xóa tất cả node OFFLINE còn lại trong nhóm
    │     (nếu DRY_RUN=false)
    │
    ├─► Đổi given_name của keeper về hostname sạch
    │     (bỏ hậu tố, ví dụ: "itop-thanhhn5-i8shta5a" → "itop-thanhhn")
    │     (nếu DRY_RUN=false)
    │
    └─► Lưu vào SQLite (bảng devices)
```

**Idempotent:** Chạy nhiều lần với cùng state Headscale cho cùng kết quả. An toàn để chạy liên tục.

### Lưu ý DRY_RUN

`DRY_RUN=true` — chỉ log hành động dự kiến, không gọi API xóa/đổi tên. Dùng khi debug hoặc kiểm tra trước khi đưa vào production.

## Phần 2: Collector (HTTP server)

HTTP server lắng nghe port `8090`. **Chỉ nhận request từ tailnet** (IP-based auth, không dùng token).

### Endpoints

| Method | Path | Mô tả |
|---|---|---|
| `POST` | `/metrics/report` | Nhận báo cáo latency từ reporter (relay nodes) hoặc Windows client |
| `GET` | `/metrics/latency` | Trả aggregated latency JSON (trong `LATENCY_WINDOW` giây gần nhất) |
| `GET` | `/metrics/health` | Smoke gate sau deploy. Query params: `expect=collector,vpn3,vpn4`, `window=180` |
| `GET` | `/stats` hoặc `/metrics/stats` | Dashboard HTML với Chart.js, auto-refresh 30s |
| `GET` | `/derp` hoặc `/derp-status` | DERP status page: probe kết quả + bảng peer relay |
| `GET` | `/metrics/netcheck` | Nhận netcheck từ client (POST netcheck) |

### Cấu trúc POST /metrics/report

```json
{
  "src": "vpn3",
  "dst": "itop-thanhhn",
  "dst_ip": "100.64.x.x",
  "rtt_ms": 12.4,
  "path": "direct",
  "ok": true
}
```

### Auth model (IP-based)

Collector chấp nhận request từ:

| Dải IP | Nguồn |
|---|---|
| `100.64.0.0/10` | Tailnet (IPv4) |
| `fd7a::/16` | Tailnet (IPv6) |
| `127.0.0.0/8` | Loopback |
| `10.0.0.0/8` | Docker network |
| `172.16.0.0/12` | Docker network |
| `192.168.0.0/16` | Docker network |

**Lý do chấp nhận Docker network:** collector-sidecar dùng `socat` để forward port. `socat` làm mất IP gốc của caller, request đến collector có IP là Docker bridge network.

### GET /metrics/health

Dùng làm smoke gate sau mỗi lần deploy. Ví dụ:

```
GET /metrics/health?expect=collector,vpn3,vpn4&window=180
```

- `expect`: danh sách `src` phải có báo cáo trong khoảng thời gian `window` giây.
- `window`: số giây tính ngược từ thời điểm hiện tại.
- Trả `200 OK` nếu tất cả `expect` đều có báo cáo; trả `503` nếu thiếu.

## Phần 3: Auto-approve Routes

Tự động duyệt mọi route mà node advertise qua Headscale API. Không cần tag đặc biệt, không cần duyệt tay qua CLI.

**Idempotent:** Route đã approved không bị thay đổi. Chỉ approve route mới chưa được duyệt.

## Server Ping

Ngoài việc nhận báo cáo từ relay nodes, latency module còn **tự ping** tất cả node ONLINE qua LocalAPI của collector-sidecar.

```
latency module
    │
    └─► ts_sock volume → /var/run/tailscale/tailscaled.sock (của collector-sidecar)
            │
            ├─► GET /localapi/v0/status → danh sách peer online
            └─► POST /localapi/v0/ping?ip=X&type=disco → RTT
                    → lưu vào node_latency với src="collector"
```

## SQLite Database

File: `/data/devices.db`

### Bảng `devices`

Lưu lịch sử node dedup.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `user` | TEXT | PRIMARY KEY (cùng `hostname`) |
| `hostname` | TEXT | PRIMARY KEY |
| `mac` | TEXT | MAC address (từ Windows client report) |
| `node_id` | TEXT | Headscale node ID của keeper |
| `ipv4` | TEXT | Tailnet IPv4 |
| `machine_key` | TEXT | Machine key hiện tại |
| `first_seen` | DATETIME | Lần đầu xuất hiện |
| `last_seen` | DATETIME | Lần cuối seen |
| `seen_count` | INTEGER | Tổng số lần thấy |

### Bảng `node_latency`

Lưu toàn bộ kết quả ping/latency.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | INTEGER | PK autoincrement |
| `ts` | DATETIME | Timestamp |
| `src` | TEXT | Nguồn ping (tên relay node hoặc "collector") |
| `dst` | TEXT | Hostname đích |
| `dst_ip` | TEXT | Tailnet IP đích |
| `rtt_ms` | REAL | Round-trip time (ms) |
| `path` | TEXT | "direct" hoặc "derp-vpnX" |
| `ok` | BOOLEAN | Ping thành công hay không |

Index trên cột `ts` để query nhanh theo time window.

### Bảng `client_netcheck`

Lưu kết quả netcheck từ Windows client.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | INTEGER | PK autoincrement |
| `ts` | DATETIME | Timestamp |
| `client` | TEXT | Hostname của Windows client |
| `preferred_derp` | TEXT | DERP region được chọn |
| `region_latency` | JSON | Map region → latency ms |

## Environment Variables

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `HS_API_URL` | — | Có | URL Headscale API (ví dụ: `http://derp-controller:8080`) |
| `HS_API_KEY` | — | Có | Headscale API key |
| `POLL_INTERVAL` | `30` | Không | Chu kỳ dedup + auto-approve + server ping (giây) |
| `DB_PATH` | `/data/devices.db` | Không | Đường dẫn SQLite database |
| `DRY_RUN` | `false` | Không | `true` = chỉ log, không xóa/đổi tên node |
| `AUTO_APPROVE_ROUTES` | `true` | Không | `true` = tự động approve route |
| `METRICS_PORT` | `8090` | Không | Port HTTP collector |
| `TS_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Không | Unix socket của collector-sidecar (ts_sock volume) |
| `SRC_NAME` | `collector` | Không | Tên `src` dùng khi collector-sidecar tự ping |
| `DERP_PROBE_URLS` | — | Không | Comma-separated `name=url` probe endpoints của DERP nodes |
| `LATENCY_WINDOW` | `3600` | Không | Số giây lấy samples cho `/metrics/latency` |

### DERP_PROBE_URLS format

```
vpn3-vn=https://vpn3.hangocthanh.io.vn/derp/probe,vpn4-vn=https://vpn4.hangocthanh.io.vn/derp/probe,vpn6-vn=https://vpn6.hangocthanh.io.vn/derp/probe
```

## Volumes

```yaml
volumes:
  - latency_data:/data                                  # SQLite DB
  - ts_sock:/var/run/tailscale                          # Chia sẻ với collector-sidecar
```

## COUPLING quan trọng

> **latency + collector-sidecar PHẢI chạy cùng host** vì chia sẻ volume `ts_sock`.

- `latency` cần đọc unix socket của `collector-sidecar` để gọi LocalAPI (server ping).
- `collector-sidecar` dùng `socat` để forward traffic từ tailnet vào `latency:8090`.
- Nếu di chuyển sang host khác, **phải di chuyển cả hai** cùng lúc. Không thể tách rời.

## Lưu ý quan trọng

- **Port 8090 không được expose ra internet.** Chỉ lắng nghe trong tailnet. collector-sidecar chịu trách nhiệm nhận traffic từ tailnet và forward vào.
- **Database migration:** Khi cập nhật schema SQLite, cần migration script hoặc xóa và recreate DB (mất lịch sử). Nên backup `/data/devices.db` trước khi update image.
- **DERP_PROBE_URLS:** Nếu không set, `/derp-status` vẫn hoạt động nhưng không có kết quả probe. Cần update khi thêm/bớt relay node.
- **Headscale API key rotation:** Khi đổi `HS_API_KEY`, restart latency container. Key cũ không còn dùng được ngay lập tức.
