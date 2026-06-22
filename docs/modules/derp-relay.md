# Module: derp-relay

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Image | `ghcr.io/vanbienperu3107/derp-relay:latest` |
| Source | `modules/derp-relay/` (Dockerfile + reporter.py + entrypoint.sh) |
| Stack | Go `derper` binary + Python 3.12 ping-reporter |
| Port | `443` (DERP WebSocket), `3478/UDP` (STUN) |
| Chạy trên | vpn2 (STUN 3479), vpn3, vpn4, vpn6 |

## Mục đích

Module này đóng gói hai thành phần trong **cùng một container**:

1. **derper binary** — DERP relay server chính thức của Tailscale, dùng để relay traffic giữa các node khi không thiết lập được kết nối trực tiếp (peer-to-peer).
2. **reporter.py** (Python) — ping-reporter, thu thập RTT latency giữa relay node với các peer online và gửi về collector (vpn2).

Thiết kế "2-in-1" này giúp mỗi relay node tự báo cáo latency của mình mà không cần sidecar riêng, đồng thời tái sử dụng Tailscale LocalAPI socket đã có sẵn trên host.

## Kiến trúc container

```
┌─────────────────────────────────────────────┐
│              derp-relay container            │
│                                             │
│  ┌─────────────────┐  ┌──────────────────┐  │
│  │  derper binary  │  │   reporter.py    │  │
│  │                 │  │  (chỉ khi       │  │
│  │  :443  WebSocket│  │  REPORTER_NAME  │  │
│  │  :3478 STUN/UDP │  │  được set)      │  │
│  │  /derp          │  │                  │  │
│  │  /derp/probe    │  │  poll LocalAPI   │  │
│  └─────────────────┘  │  → ping peers    │  │
│                        │  → POST report   │  │
│                        └──────────────────┘  │
└─────────────────────────────────────────────┘
         │ unix socket
         ▼
/var/run/tailscale/tailscaled.sock (host)
```

## Thành phần 1: derper binary

DERP (Detoured Encrypted Routing Protocol) relay server chính thức của Tailscale.

### Endpoints

| Endpoint | Mô tả |
|---|---|
| `GET /derp` | WebSocket DERP relay (Tailscale client kết nối vào đây) |
| `GET /derp/probe` | Health probe, trả về `200 OK` nếu server đang chạy |
| `GET /` (port 8080) | HTTP endpoint nội bộ (Caddy proxy lên 443) |

### Lưu ý verify clients

`DERP_VERIFY_CLIENTS=true` — derper sẽ gọi về headscale tại `control_domain` để xác minh xem node kết nối vào có thuộc tailnet không. **Chỉ node đã join tailnet mới được dùng relay.** Nếu headscale không reach được, relay từ chối kết nối.

## Thành phần 2: reporter.py (ping-reporter)

### Flow hoạt động

```
reporter.py (mỗi POLL_INTERVAL giây)
    │
    ├─► GET /localapi/v0/status           (qua TS_SOCKET)
    │       → lấy danh sách peer online
    │
    ├─► POST /localapi/v0/ping?ip=X&type=disco  (từng peer)
    │       → RTT disco ping (ms)
    │
    └─► POST http://collector:COLLECTOR_PORT/metrics/report
            body: { src, dst, dst_ip, rtt_ms, path, ok }
```

### Điều kiện kích hoạt

| Node | `REPORTER_NAME` | reporter.py chạy? |
|---|---|---|
| vpn2 | `` (empty) | **Không** — vpn2 dùng collector-sidecar thay thế |
| vpn3 | `vpn3` | Có |
| vpn4 | `vpn4` | Có |
| vpn6 | `vpn6` | Có |

## Dockerfile

```dockerfile
FROM golang:alpine AS derper-build
RUN go install tailscale.com/cmd/derper@latest

FROM python:3.12-alpine
RUN apk add --no-cache ca-certificates
COPY --from=derper-build /go/bin/derper /usr/local/bin/derper
COPY reporter.py /app/reporter.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 443 3478/udp
ENTRYPOINT ["/entrypoint.sh"]
```

Multi-stage build: stage 1 compile `derper` từ `tailscale.com/cmd/derper@latest`, stage 2 là Python 3.12 runtime với binary được copy sang.

## entrypoint.sh

```bash
#!/bin/sh
set -e

# Start derper
derper \
  --hostname="$DERP_HOSTNAME" \
  --certmode=manual \
  --certdir="$DERP_CERTDIR" \
  --http-port="$DERP_HTTP_PORT" \
  --stun-port="$DERP_STUN_PORT" \
  --verify-clients="$DERP_VERIFY_CLIENTS" &
DERPER_PID=$!

# Chỉ start reporter nếu REPORTER_NAME được set (không rỗng)
if [ -n "$REPORTER_NAME" ]; then
  sleep 5
  python3 /app/reporter.py &
fi

wait $DERPER_PID
```

**Lưu ý:** `sleep 5` trước khi start reporter để derper kịp khởi động và ổn định trước khi reporter bắt đầu dùng LocalAPI.

## Environment Variables

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `DERP_HOSTNAME` | — | Có | FQDN của relay node (ví dụ: `vpn3.hangocthanh.io.vn`) |
| `DERP_CERTMODE` | `manual` | Không | Chế độ TLS cert. `manual` = dùng cert từ `DERP_CERTDIR` |
| `DERP_CERTDIR` | `/certs` | Không | Thư mục chứa TLS cert (được mount từ host hoặc Caddy) |
| `DERP_HTTP_PORT` | `8080` | Không | Port HTTP nội bộ (Caddy reverse proxy vào đây) |
| `DERP_STUN_PORT` | `3478` | Không | Port STUN/UDP |
| `DERP_VERIFY_CLIENTS` | `true` | Không | `true` = chỉ nhận client đã join tailnet |
| `REPORTER_NAME` | — | Không | Tên node dùng làm `src` trong report. Empty = tắt reporter |
| `COLLECTOR_PORT` | `8090` | Không | Port của collector trên vpn2 |
| `POLL_INTERVAL` | `30` | Không | Chu kỳ poll và ping (giây) |
| `PING_TIMEOUT` | `8` | Không | Timeout cho mỗi ping request (giây) |
| `TS_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Không | Đường dẫn unix socket của tailscaled trên host |

## Deployment per node

### vpn2

```yaml
environment:
  DERP_HOSTNAME: vpn2.hangocthanh.io.vn
  DERP_STUN_PORT: "3479"   # vpn2 dùng 3479 (khác default)
  REPORTER_NAME: ""         # reporter TẮT — dùng collector-sidecar
```

### vpn3

```yaml
environment:
  DERP_HOSTNAME: vpn3.hangocthanh.io.vn
  REPORTER_NAME: vpn3
  COLLECTOR_PORT: "8090"
```

### vpn4

```yaml
environment:
  DERP_HOSTNAME: vpn4.hangocthanh.io.vn
  REPORTER_NAME: vpn4
  COLLECTOR_PORT: "8090"
```

### vpn6

```yaml
environment:
  DERP_HOSTNAME: vpn6.hangocthanh.io.vn
  REPORTER_NAME: vpn6
  COLLECTOR_PORT: "8090"
```

## Volumes

```yaml
volumes:
  - /var/run/tailscale:/var/run/tailscale:ro   # LocalAPI socket (bind từ host)
  - ./certs:/certs:ro                           # TLS cert/key (certmode=manual)
```

## Lưu ý quan trọng

- **STUN port vpn2**: vpn2 dùng `3479` thay vì `3478` (mặc định) để tránh xung đột với service khác trên host.
- **TLS cert**: `certmode=manual` yêu cầu cert phải được provision bên ngoài (Caddy, Let's Encrypt, hoặc wildcard cert). Cert phải sẵn ở `DERP_CERTDIR` trước khi derper start.
- **Caddy integration**: derper chỉ expose HTTP port 8080; Caddy (gateway module) chịu trách nhiệm TLS termination và routing `/derp*` vào derper. Không route `/derp*` vào derp-controller.
- **LocalAPI socket**: reporter.py cần đọc được `/var/run/tailscale/tailscaled.sock` từ host. Nếu socket không tồn tại (tailscaled chưa chạy), reporter sẽ fail khi poll.
- **verify-clients và headscale**: Nếu headscale (control server) gặp sự cố, `verify-clients=true` sẽ khiến derper từ chối toàn bộ client. Cân nhắc khi làm maintenance headscale.
