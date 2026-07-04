# Kiểm tra phiên bản modules — Version Check

<!-- last_verified_at: 2026-06-21 -->
<!-- applies_to: TailscaleRemote — vpn2 (primary), vpn6 (HA replica) -->

---

## Tổng quan

Tài liệu này hướng dẫn:

1. Chạy workflow tự động `check-versions.yml` để so sánh container đang chạy vs image mới nhất trên GHCR
2. Kiểm tra thủ công trước/sau deploy
3. Thực hiện rollback khi deploy gặp vấn đề

**GHCR registry:** `ghcr.io/vanbienperu3107/`

**Modules quản lý:**

| Module | Image name | Deploy target |
|--------|-----------|---------------|
| derp-controller | `derp-controller` | vpn2, vpn6 |
| api-center | `api-center` | vpn2, vpn6 |
| admin-ui | `admin-ui` | vpn2, vpn6 |
| derp-relay | `derp-relay` | vpn2, vpn3, vpn4, vpn6 |
| latency | `latency` | vpn2 only |
| collector-sidecar | `collector-sidecar` | vpn2 only |
| gateway | `gateway` | vpn2 only |

---

## Workflow tự động: check-versions.yml

### Trigger thủ công

```powershell
# Từ D:\05. Peru\03.Taile\TailscaleRemote:
gh workflow run check-versions.yml

# Xem danh sách run gần nhất:
gh run list --workflow=check-versions.yml --limit 5

# Xem log chi tiết của run mới nhất:
gh run list --workflow=check-versions.yml --limit 1 --json databaseId --jq '.[0].databaseId' | ForEach-Object { gh run view $_ --log }
```

### Cách workflow hoạt động

```
check-versions.yml
    │
    ├─ Job: check-vpn2
    │    ├─ SSH vào vpn2
    │    ├─ docker compose ps (list containers + status)
    │    ├─ docker compose images (list image digests đang chạy)
    │    └─ Với mỗi module:
    │         ├─ Lấy digest container đang chạy (docker inspect)
    │         ├─ Gọi GHCR API: GET /v2/.../manifests/latest
    │         ├─ So sánh digest
    │         └─ Cảnh báo nếu outdated
    │
    └─ Job: check-vpn6
         └─ (tương tự vpn2)
```

### Đọc kết quả

Output trong GitHub Actions log:

```
=== VERSION CHECK vpn2 (2026-06-21 10:00:00 UTC) ===

MODULE              RUNNING DIGEST          GHCR LATEST             STATUS
derp-controller     sha256:abc123...        sha256:abc123...        ✓ UP-TO-DATE
api-center          sha256:def456...        sha256:xyz789...        ⚠ OUTDATED
admin-ui            sha256:ghi789...        sha256:ghi789...        ✓ UP-TO-DATE
derp-relay          sha256:jkl012...        sha256:jkl012...        ✓ UP-TO-DATE
latency             sha256:mno345...        sha256:mno345...        ✓ UP-TO-DATE
collector-sidecar   sha256:pqr678...        sha256:pqr678...        ✓ UP-TO-DATE
gateway             sha256:stu901...        sha256:stu901...        ✓ UP-TO-DATE

⚠ WARNING: 1 module(s) outdated on vpn2. Run deploy-control-plane.yml to update.
```

---

## Kiểm tra thủ công trước deploy

### 1. Xem image đang chạy trên vpn2

```powershell
# SSH và query docker:
ssh root@vpn2.hangocthanh.io.vn `
  "cd /opt/tailscale-remote/deploy/vpn2 && docker compose images"
```

Output mẫu:

```
Container          Repository                                Tag       Image Id       Size
derp-controller    ghcr.io/vanbienperu3107/derp-controller   latest    a1b2c3d4e5f6   245MB
api-center         ghcr.io/vanbienperu3107/api-center         latest    b2c3d4e5f6a1   312MB
admin-ui           ghcr.io/vanbienperu3107/admin-ui           latest    c3d4e5f6a1b2   89MB
derp-relay         ghcr.io/vanbienperu3107/derp-relay         latest    d4e5f6a1b2c3   156MB
latency            ghcr.io/vanbienperu3107/latency            latest    e5f6a1b2c3d4   198MB
collector-sidecar  ghcr.io/vanbienperu3107/collector-sidecar  latest    f6a1b2c3d4e5   423MB
gateway            ghcr.io/vanbienperu3107/gateway            latest    a1b2c3d4e5f7   78MB
```

### 2. Xem image mới nhất trên GHCR

```powershell
# List tất cả packages (container images):
gh api "repos/vanbienperu3107/TailscaleRemote/packages?package_type=container" `
  --jq '.[] | {name: .name, updated: .updated_at}'

# Xem digest latest của 1 module cụ thể (ví dụ api-center):
gh api "users/vanbienperu3107/packages/container/api-center/versions" `
  --jq '.[0] | {id, created_at, tags: .metadata.container.tags}'
```

### 3. So sánh digest đang chạy vs GHCR

```bash
# SSH vào vpn2, lấy digest container đang chạy:
docker inspect derp-controller \
  --format '{{index .RepoDigests 0}}'
# → ghcr.io/vanbienperu3107/derp-controller@sha256:abc123...

# So sánh với digest trên GHCR (cần docker pull --dry hoặc manifest inspect):
docker manifest inspect ghcr.io/vanbienperu3107/derp-controller:latest \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('config',{}).get('digest',''))"
```

---

## Bảng tracking version (template điền tay)

Điền sau mỗi lần deploy để tracking.

**Deploy date:** ________________
**Deploy commit SHA:** ________________

| Module | Image GHCR (tag/SHA) | Container vpn2 (digest) | Container vpn6 (digest) | Status |
|--------|---------------------|------------------------|------------------------|--------|
| derp-controller | `ghcr.io/.../derp-controller:latest` | | | |
| api-center | `ghcr.io/.../api-center:latest` | | | |
| admin-ui | `ghcr.io/.../admin-ui:latest` | | | |
| derp-relay | `ghcr.io/.../derp-relay:latest` | | | |
| latency | `ghcr.io/.../latency:latest` | | | |
| collector-sidecar | `ghcr.io/.../collector-sidecar:latest` | | | |
| gateway | `ghcr.io/.../gateway:latest` | | | |

---

## Checklist sau deploy

Chạy lần lượt các lệnh sau và đảm bảo tất cả trả kết quả mong đợi.

### 1. Health check endpoint

```powershell
# vpn2:
curl https://vpn2.hangocthanh.io.vn/healthz
# Kết quả mong đợi: ok

# Nếu dùng IP trực tiếp (bypass Cloudflare LB):
curl --resolve "vpn2.hangocthanh.io.vn:443:165.22.12.169" `
     https://vpn2.hangocthanh.io.vn/healthz
# → ok

curl --resolve "vpn2.hangocthanh.io.vn:443:45.119.87.220" `
     https://vpn2.hangocthanh.io.vn/healthz
# → ok (kiểm tra vpn6 qua Cloudflare LB)
```

### 2. API DERP regions

```powershell
# Trả về JSON array các DERP regions đã cấu hình:
curl -s https://vpn2.hangocthanh.io.vn/app/api/derp | python3 -m json.tool
# Kết quả mong đợi:
# [
#   {
#     "id": 1,
#     "hostname": "vpn2.hangocthanh.io.vn",
#     "regionCode": "vpn2-vn",
#     ...
#   },
#   ...
# ]
```

### 3. DERP relay probe

```powershell
# Control plane node relay (vpn2):
curl -v https://vpn2.hangocthanh.io.vn/derp/probe
# → HTTP 200

# Standalone relay nodes:
curl -v https://vpn3.hangocthanh.io.vn/derp/probe
# → HTTP 200
```

### 4. Headscale key endpoint (Tailscale clients dùng)

```powershell
curl https://vpn2.hangocthanh.io.vn/key
# → JSON: {"publicKey":"..."}
```

### 5. Container status tổng quan

```bash
# SSH vào vpn2:
ssh root@165.22.12.169 \
  "cd /opt/tailscale-remote/deploy/vpn2 && docker compose ps --format table"
```

Kết quả mong đợi (tất cả STATUS = Up):

```
NAME               IMAGE                                                   STATUS      PORTS
derp-controller    ghcr.io/vanbienperu3107/derp-controller:latest          Up          ...
api-center         ghcr.io/vanbienperu3107/api-center:latest               Up          ...
admin-ui           ghcr.io/vanbienperu3107/admin-ui:latest                 Up          ...
derp-relay         ghcr.io/vanbienperu3107/derp-relay:latest               Up          ...
latency            ghcr.io/vanbienperu3107/latency:latest                  Up          ...
collector-sidecar  ghcr.io/vanbienperu3107/collector-sidecar:latest        Up          ...
gateway            ghcr.io/vanbienperu3107/gateway:latest                  Up          ...
```

```bash
# SSH vào vpn6:
ssh root@45.119.87.220 \
  "cd /opt/tailscale-remote/deploy/vpn6 && docker compose ps --format table"
```

### 6. Logs nhanh (tail 50 dòng)

```bash
ssh root@165.22.12.169 \
  "cd /opt/tailscale-remote/deploy/vpn2 && docker compose logs --tail=50 --no-log-prefix 2>&1"
```

Dấu hiệu bình thường:
- Không có `ERROR` level logs
- `api-center` log `Listening on :3000`
- `derp-controller` log `headscale started`
- `gateway` log `serving TLS` hoặc `certificate obtained successfully`

### 7. Collector-sidecar tailnet status

```bash
ssh root@165.22.12.169 \
  "docker exec collector-sidecar tailscale status"
# → Phải hiện peers từ vpn3/vpn4
```

---

## Rollback — khôi phục phiên bản cũ

### Rollback một module cụ thể về SHA trước đó

```bash
# Bước 1: SSH vào vpn2
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2

# Bước 2: Tìm SHA image muốn rollback về
# (từ GitHub Actions history hoặc GHCR tags)
# Ví dụ SHA: sha256:def456789...

# Bước 3: Pull image cụ thể:
docker pull ghcr.io/vanbienperu3107/api-center@sha256:def456789abc...

# Bước 4: Tag lại thành :latest tạm thời:
docker tag ghcr.io/vanbienperu3107/api-center@sha256:def456789abc... \
           ghcr.io/vanbienperu3107/api-center:rollback

# Bước 5: Sửa docker-compose.yml tạm thời:
# image: ghcr.io/vanbienperu3107/api-center:rollback

# Bước 6: Restart chỉ service đó (không restart các service khác):
docker compose up -d --no-deps api-center

# Bước 7: Kiểm tra:
docker compose ps api-center
curl https://vpn2.hangocthanh.io.vn/app/api/derp
```

### Rollback theo GitHub commit SHA (cách tốt hơn)

```powershell
# Tìm SHA của image từ workflow run cụ thể:
gh run list --workflow=module-api-center.yml --limit 10

# Xem output của run muốn rollback về (lấy image digest):
gh run view <RUN_ID> --log | Select-String "digest"

# Trigger deploy với image tag SHA cụ thể:
# (cần workflow hỗ trợ input image_tag)
gh workflow run deploy-control-plane.yml \
  -f confirm=deploy \
  -f target=vpn2 \
  -f image_tag=sha-<7-char-sha>
```

### Rollback toàn bộ (emergency)

```bash
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2

# Lấy danh sách image đang dùng TRƯỚC khi deploy gần nhất:
docker image ls --format "{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}" \
  | grep ghcr.io/vanbienperu3107/ | sort -k3 -r

# Sửa docker-compose.yml: thay tất cả :latest thành :<SHA> cũ
# Sau đó:
docker compose pull
docker compose up -d

# Kiểm tra:
docker compose ps
curl https://vpn2.hangocthanh.io.vn/healthz
```

---

## Monitoring thường xuyên

### Schedule check-versions định kỳ (tùy chọn)

Thêm vào `.github/workflows/check-versions.yml`:

```yaml
on:
  schedule:
    # Chạy mỗi ngày lúc 07:00 UTC (14:00 Việt Nam):
    - cron: '0 7 * * *'
  workflow_dispatch:
```

### Theo dõi restart count

```bash
ssh root@165.22.12.169 \
  "docker inspect --format='{{.Name}}: restarts={{.RestartCount}}' \$(docker ps -q)"
```

Nếu module nào `restarts > 3` → xem log ngay, container đang crash loop.

### Disk usage (image cache)

```bash
ssh root@165.22.12.169 "docker system df"
# Dọn image cũ nếu disk > 80%:
ssh root@165.22.12.169 "docker image prune -f --filter 'until=168h'"
# → Xóa image không dùng cũ hơn 7 ngày
```

---

## Server migration — chuyển sang VPS mới

Khi cần thay vpn2 bằng server mới:

```bash
# 1. Backup state quan trọng trên vpn2 cũ:
ssh root@165.22.12.169
cd /opt/tailscale-remote/deploy/vpn2

# Backup noise key:
docker exec derp-controller \
  cat /etc/headscale-keys/noise_private.key > /tmp/noise_private.key.backup

scp root@165.22.12.169:/tmp/noise_private.key.backup .

# 2. Cập nhật GitHub Secrets với IP mới:
gh secret set VPN2_HOST --body "NEW_VPS_IP"
gh secret set VPN2_SSH_KEY --body (Get-Content "C:\Users\Hoanglong\keys\new_vps_key" -Raw)

# 3. Cài Docker trên VPS mới (xem docs/deploy/first-deploy.md Yêu cầu)

# 4. Deploy:
gh workflow run deploy-control-plane.yml -f confirm=deploy -f target=vpn2
# Latency data (devices, latency_samples) lưu trên Neon Postgres — không cần restore local.

# 5. Cập nhật Cloudflare LB pool:
# DNS → Load Balancing → pool → thay IP vpn2 cũ = IP mới

# 7. Kiểm tra:
curl https://vpn2.hangocthanh.io.vn/healthz
gh workflow run check-versions.yml
```
