# Module: gateway

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Image | `ghcr.io/vanbienperu3107/gateway:latest` |
| Source | `modules/gateway/Dockerfile` |
| Stack | Caddy v2 + plugin `replace-response` |
| Port | `80` (ACME HTTP challenge), `443` (HTTPS public) |
| Chạy trên | vpn2 (containerized); vpn6 (Caddy hệ thống + `caddy-snippet.conf`) |

## Mục đích

Module `gateway` là reverse proxy và TLS termination point cho toàn bộ stack trên vpn2. Caddy xử lý:

- **TLS tự động** qua Let's Encrypt ACME.
- **Routing** tất cả request vào đúng backend service theo path pattern.
- **DERP relay** — forward `/derp*` vào `derp-relay` container (không phải `derp-controller`).
- **Headscale control** — forward `/key`, `/ts2021`, `/register/*`, `/machine/*`, `/api/v1/*`, `/noise` vào `derp-controller`.
- **Dashboard** — `/app/*` vào `admin-ui`, `/app/api/*` vào `api-center`.

## Dockerfile

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddyserver/replace-response

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Multi-stage build: stage 1 dùng `xcaddy` để compile Caddy với plugin `replace-response`, stage 2 là Caddy runtime image với binary đã được thay thế.

**Lý do cần plugin `replace-response`:** Dùng để rewrite content trong response nếu cần (ví dụ: đổi URL nội bộ thành URL public trong response JSON của Headscale).

## Caddyfile

File: `deploy/vpn2/Caddyfile`

```caddyfile
{
  order replace after encode
}

{$DOMAIN:vpn2.hangocthanh.io.vn} {
  log { output stdout; format json }

  handle /derp*          { reverse_proxy derp-relay:8080 }
  handle /key            { reverse_proxy derp-controller:8080 }
  handle /ts2021         { reverse_proxy derp-controller:8080 }
  handle /register/*     { reverse_proxy derp-controller:8080 }
  handle /machine/*      { reverse_proxy derp-controller:8080 }
  handle /api/v1/*       { reverse_proxy derp-controller:8080 }
  handle /noise          { reverse_proxy derp-controller:8080 }
  handle /generate_204   { respond 204 }
  handle /app/api/*      { reverse_proxy api-center:8787 }
  handle /app/*          { reverse_proxy admin-ui:80 }
  handle /derp-status*   {
    uri strip_prefix /derp-status
    reverse_proxy latency:8090
  }
  @root path /
  handle @root { redir * /app/ 302 }
  handle { reverse_proxy derp-controller:8080 }
}
```

## Routing table

| Path pattern | Backend | Port | Ghi chú |
|---|---|---|---|
| `/derp*` | `derp-relay` | `8080` | DERP WebSocket relay. **KHÔNG phải derp-controller** |
| `/key` | `derp-controller` | `8080` | Tailscale key exchange |
| `/ts2021` | `derp-controller` | `8080` | Tailscale protocol 2021 |
| `/register/*` | `derp-controller` | `8080` | Node registration |
| `/machine/*` | `derp-controller` | `8080` | Machine API |
| `/api/v1/*` | `derp-controller` | `8080` | Headscale REST API |
| `/noise` | `derp-controller` | `8080` | Noise protocol endpoint |
| `/generate_204` | — | — | Connectivity check, trả `204 No Content` |
| `/app/api/*` | `api-center` | `8787` | Backend API của dashboard |
| `/app/*` | `admin-ui` | `80` | Frontend dashboard (SPA) |
| `/derp-status*` | `latency` | `8090` | DERP status page (strip prefix `/derp-status`) |
| `/` (exact) | — | — | Redirect `302` → `/app/` |
| `*` (fallback) | `derp-controller` | `8080` | Mọi path không khớp → Headscale |

### Thứ tự ưu tiên

Caddy xử lý `handle` theo thứ tự khai báo (first match wins). `/app/api/*` phải đứng trước `/app/*` để tránh `/app/api/` bị route nhầm vào `admin-ui`.

## TLS (HTTPS)

Caddy tự động xử lý TLS qua Let's Encrypt ACME:

- **Port 80**: ACME HTTP-01 challenge. Caddy lắng nghe và tự trả lời challenge để lấy cert.
- **Port 443**: HTTPS với cert đã được cấp.
- **Auto-renewal**: Caddy tự gia hạn cert trước khi hết hạn. Không cần cron job.

TLS cert được lưu trong volume `gateway_data` (`/data`). Mất volume = mất cert = cần renew lại (tự động nhưng mất thời gian challenge).

## Environment Variables

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `DOMAIN` | `vpn2.hangocthanh.io.vn` | Không | Domain chính. Caddy dùng giá trị này cho virtual host và ACME cert |

Cú pháp `{$DOMAIN:vpn2.hangocthanh.io.vn}` trong Caddyfile: đọc env var `DOMAIN`, nếu không set thì dùng giá trị mặc định `vpn2.hangocthanh.io.vn`.

## Volumes

```yaml
volumes:
  - ./Caddyfile:/etc/caddy/Caddyfile:ro   # Caddyfile (read-only)
  - gateway_data:/data                    # TLS certs, ACME state
  - gateway_config:/config                # Caddy config (runtime)
```

| Volume | Mount | Mục đích |
|---|---|---|
| `./Caddyfile` | `/etc/caddy/Caddyfile:ro` | Config file. Mount read-only để tránh Caddy tự ghi đè |
| `gateway_data` | `/data` | Let's Encrypt cert, ACME account, cert cache. Phải persist |
| `gateway_config` | `/config` | Caddy runtime config (JSON adapter cache, v.v.) |

## Docker Compose snippet

```yaml
gateway:
  image: ghcr.io/vanbienperu3107/gateway:latest
  restart: unless-stopped
  ports:
    - "80:80"
    - "443:443"
  environment:
    DOMAIN: vpn2.hangocthanh.io.vn
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - gateway_data:/data
    - gateway_config:/config

volumes:
  gateway_data:
  gateway_config:
```

## Deployment trên vpn6

vpn6 không dùng container gateway. Thay vào đó, vpn6 có **Caddy hệ thống** (cài trực tiếp trên host) đang phục vụ `claude.hangocthanh.io.vn` (memory-stack).

DERP relay trên vpn6 được tích hợp bằng cách thêm snippet `caddy-snippet.conf` vào Caddyfile của Caddy hệ thống. Snippet này thêm routing `/derp*` vào derp-relay container đang chạy trên vpn6.

Không deploy container `gateway` lên vpn6 — sẽ conflict với Caddy hệ thống trên port 80/443.

## Lưu ý quan trọng

- **/derp* phải vào derp-relay, KHÔNG phải derp-controller.** `derp-controller` (Headscale) đã tắt embedded DERP server. Nếu routing nhầm, client Tailscale sẽ fail khi cố kết nối DERP relay.
- **replace-response plugin:** Nếu không cần rewrite response content, plugin này không ảnh hưởng hiệu năng. `order replace after encode` đặt bước replace sau encode (gzip/br) để hoạt động đúng với nén.
- **Log format JSON:** `log { output stdout; format json }` giúp aggregate log dễ hơn (ELK, Loki, v.v.). Không log sang file để tránh disk full trong container.
- **generate_204:** Android và một số OS dùng URL này để kiểm tra internet connectivity. Trả `204` ngay tại Caddy thay vì forward đến backend.
- **Fallback handle:** `handle { reverse_proxy derp-controller:8080 }` ở cuối bắt mọi path không match — Headscale có thể có endpoint mới trong tương lai không cần update Caddyfile.
- **Port 80 phải mở:** Nếu firewall block port 80, ACME HTTP-01 challenge thất bại và Caddy không lấy được cert. Caddy sẽ retry liên tục nhưng không serve HTTPS được cho đến khi challenge thành công.
