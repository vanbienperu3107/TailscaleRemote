# Module: latency

**Image:** `ghcr.io/vanbienperu3107/latency:latest`
**Source:** `modules/latency/dedup.py`
**Stack:** Python 3 — single process, không HTTP server, không SQLite
**Chạy trên:** vpn2 only
**Phụ thuộc:** api-center (healthcheck), derp-controller, ts_sock volume

---

## Mục đích

Module latency chạy một vòng lặp poll để thực hiện 3 nhiệm vụ:

1. **Node Dedup** — gom node trùng headscale (cùng hostname) theo (user, hostname), giữ lại 1, xóa bản trùng OFFLINE
2. **Server-side ping** — ping tất cả node ONLINE qua LocalAPI tailscale sidecar → ghi latency lên Neon Postgres via api-center
3. **Auto-approve routes** — tự động duyệt mọi route node quảng bá, không cần tag/duyệt tay

**Không có HTTP server, không có SQLite.** Tất cả dữ liệu lưu vào Neon Postgres qua api-center.

---

## Kiến trúc dữ liệu

```
latency module (dedup.py)
    │
    ├── GET /api/v1/node  ──────────────────→ derp-controller:8080
    │   (đọc danh sách node)
    │
    ├── POST /api/devices/report ──────────→ api-center:8787 → Neon (bảng devices)
    │   (upsert lịch sử thiết bị sau mỗi poll)
    │
    ├── POST /api/metrics/report ──────────→ api-center:8787 → Neon (bảng latency_samples)
    │   (ghi kết quả server-side ping)
    │
    ├── LocalAPI /localapi/v0/ping ────────→ ts_sock (tailscale sidecar)
    │   (ping từng node qua WireGuard/DERP)
    │
    └── POST /api/v1/node/{id}/approve_routes → derp-controller:8080
        (tự duyệt route)
```

---

## Environment Variables

```env
HS_API_URL          http://derp-controller:8080
HS_API_KEY          (headscale API key — bắt buộc)
API_CENTER_URL      http://api-center:8787
POLL_INTERVAL       30  (giây)
DRY_RUN             false  (true = chỉ log, không xóa/đổi tên/duyệt thật)
AUTO_APPROVE_ROUTES true
TS_SOCKET           /var/run/tailscale/tailscaled.sock
SRC_NAME            collector  (tên nguồn khi ghi ping samples)
```

---

## Volumes

| Volume    | Mount                   | Dùng cho                                             |
|-----------|-------------------------|------------------------------------------------------|
| `ts_sock` | `/var/run/tailscale`    | Shared với collector-sidecar — LocalAPI để ping node |

> **Không còn** `latency_data:/data` — SQLite đã được xóa hoàn toàn.

---

## Node Dedup

Headscale tạo node mới mỗi khi machine key thay đổi (reinstall, state mới). Dedup gom theo `(user, hostname)`:

- **Keeper**: ưu tiên ONLINE → last_seen mới nhất → id lớn nhất
- **Xóa**: node trùng OFFLINE (không bao giờ xóa node đang ONLINE)
- **Rename**: `given_name` → hostname sạch (bỏ hậu tố ngẫu nhiên)

Sau mỗi poll, danh sách node được POST lên `api-center /api/devices/report` để lưu vào bảng `devices` trong Neon (lịch sử thiết bị, seen_count, MAC từ client report).

---

## Server-side Ping

```
LocalAPI unix socket → ping từng node ONLINE → POST kết quả vào api-center
→ Neon Postgres (latency_samples) → Admin-UI trang Latency
```

Nguồn mặc định: `SRC_NAME="collector"`. Dữ liệu hiển thị trên Admin-UI trang Latency.

---

## Auto-approve Routes

Gọi `POST /api/v1/node/{id}/approve_routes` cho mọi route chưa được duyệt. Idempotent — an toàn chạy lặp lại.

---

## Coupling: collector-sidecar

Latency module **bắt buộc** chạy cùng host với collector-sidecar vì chia sẻ unix socket `ts_sock`. Nếu di chuyển, di chuyển cả 2 cùng lúc.

---

## Server Migration

1. Đảm bảo `ts_sock` volume chuyển cùng với collector-sidecar
2. `API_CENTER_URL` phải resolve đến api-center
3. `HS_API_URL` phải trỏ đến derp-controller
4. Không cần di chuyển data (Neon Postgres là centralized)
5. Cập nhật docker-compose trên server mới

---

## Logs

```
2026-01-01T12:00:00 node-dedup chay. API=http://derp-controller:8080 poll=30s DRY_RUN=False
2026-01-01T12:00:01 server ping: 5/6 node OK
2026-01-01T12:00:31 APPROVE-ROUTES node 42 -> ['192.168.1.0/24']
2026-01-01T12:01:01 DELETE itop-user-abc123 -> trung hostname 'itop' (user admin)
```
