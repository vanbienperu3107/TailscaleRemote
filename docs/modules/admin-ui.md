# Module: admin-ui

**Image:** `ghcr.io/vanbienperu3107/admin-ui:latest`
**Source:** `modules/admin-ui/`
**Stack:** React + TanStack Router + Vite + shadcn/ui
**Port nội bộ:** 80 (nginx)
**Chạy trên:** vpn2, vpn6 (HA replica)

---

## Mục đích

Dashboard admin thuần tĩnh. Không có business logic — tất cả data gọi qua api-center (`/app/api/*`). Vite build → static files → nginx serve tại `/app/`.

---

## Sidebar Navigation

```
DERP-Controller
├─ Overview           /overview              — Tổng quan hệ thống, status
├─ Machines           /machines              — Danh sách nodes, online status, rename, expire
├─ Users              /tailnet-users         — Tạo/xóa tailnet users
├─ Routes             /hs-routes             — Xem/enable/delete advertised routes
├─ ACL Policy         /acl                   — Editor HuJSON ACL policy
├─ Pre-auth Keys      /preauth-keys          — Tạo ephemeral/reusable pre-auth keys
├─ Latency            /latency               — Peer-to-peer RTT heatmap, path (direct/DERP)
├─ DERP Regions       /derp                  — CRUD DERP nodes, probe health, maintenance
├─ Force Routes       /force-routes          — IP-based routing rules, iptables sync
├─ Node Assignments   /node-assignments      — Per-node DERP constraints (Feature B)
└─ Deploy & CI        /deploy                — GitHub Actions runs status
```

---

## Tính năng từng trang

### Overview (`/overview`)
- Trạng thái tổng quát: số nodes online, số DERP regions active
- Quick links

### Machines (`/machines`)
- Bảng nodes với: ID, hostname, IP (100.x.x.x), user, OS, last seen, online status
- Rename given_name
- Expire node (revoke key)
- Filter, pagination, URL state persistence

### Users (`/tailnet-users`)
- Danh sách tailnet users
- Tạo user mới (namespace)
- Xóa user

### Routes (`/hs-routes`)
- Danh sách routes đang advertise (subnet routes)
- Enable/disable route
- Delete route

### ACL Policy (`/acl`)
- Editor HuJSON (JSON với comment)
- GET hiện policy hiện tại
- PUT lưu và apply ngay (headscale nhận qua api-center proxy)

### Pre-auth Keys (`/preauth-keys`)
- Danh sách keys tất cả users
- Tạo key: chọn user, ephemeral/reusable, expiry, tags
- Hiển thị key value lúc tạo (chỉ 1 lần)

### Latency (`/latency`)
- Bảng peer-to-peer RTT: src, dst, min/avg/max ms, path, %ok
- Heatmap theo region
- Chart.js, auto-refresh 30s
- Filter theo node, path type (direct/derp)

### DERP Regions (`/derp`)
- Danh sách regions với status (enabled/paused/maintenance)
- Tạo region mới: regionId auto-assign, hostname, IP, ports
- Edit region config
- Toggle: enabled ↔ paused ↔ maintenance
- Xóa region
- Probe health: click → test latency tất cả nodes
- Region embedded (vpn2, regionId=999): read-only, không xóa/sửa được

### Force Routes (`/force-routes`)
- Danh sách rules (clientIp, region, label, active)
- Tạo rule: IP client → region
- Sync iptables: SSH vào DERP node, apply chain DERP-FORCE
- Clear iptables: xóa toàn bộ rules trên node
- Active toggle per rule

### Node Assignments (`/node-assignments`)
- Gán DERP region cụ thể cho nodeKey (machine key)
- Node được gán sẽ nhận filtered DERPMap chỉ có region đó
- CRUD: tạo, sửa, xóa assignment

### Deploy & CI (`/deploy`)
- GitHub Actions runs gần nhất (8 runs mỗi repo)
- Trạng thái: queued/in_progress/success/failure
- Link trực tiếp đến GitHub Actions run
- Auto-refresh

---

## Build

```bash
cd modules/admin-ui
npm install
npm run build       # output: dist/
```

Dockerfile build static files rồi copy vào nginx image. nginx.conf serve `/app/` với SPA fallback (try_files → index.html).

---

## Environment Variables

Admin-UI là static files — không có env vars runtime. Mọi config (API URL, etc.) được nhúng lúc build qua Vite `import.meta.env` nếu có, hoặc suy ra từ `window.location.origin`.
