# Module: exit-node

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Image | `ghcr.io/vanbienperu3107/exit-node:latest` |
| Source | `modules/exit-node/Dockerfile` + `entrypoint.sh` |
| Stack | `gost v3` (build từ source) + `tailscale/tailscale:latest` |
| Port | `1080` (SOCKS5), `8118` (HTTP proxy) |
| Chạy trên | Standalone VPS (không phải vpn2/vpn3/vpn4) |

## Mục đích

Module `exit-node` cung cấp **proxy node** trong tailnet: một VPS join tailnet với hostname tùy chọn và expose SOCKS5 + HTTP proxy. Client trong tailnet kết nối đến proxy node này để route traffic qua IP của VPS đó.

Trường hợp dùng điển hình:
- Cần IP của một country/region cụ thể để bypass geo-restriction.
- Cần proxy có xác thực (username/password) trong môi trường tailnet private.
- Tùy chọn: advertise exit node Tailscale để route toàn bộ traffic của node khác qua VPS này.

## Lý do dùng gost v3

**gost v2** (github.com/ginuerzh/gost) hiện bị broken do dependency `obfs4` đã di chuyển từ GitHub sang GitLab và không còn tương thích. Build thất bại với các Alpine/Go mới.

**gost v3** (github.com/go-gost/gost) là rewrite hoàn toàn, maintained, build sạch từ source với `CGO_ENABLED=0`. Cung cấp đầy đủ SOCKS5 và HTTP proxy với auth.

## Dockerfile

```dockerfile
# Stage 1: Build gost v3 từ source
FROM golang:alpine AS builder
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth=1 https://github.com/go-gost/gost.git .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /usr/local/bin/gost ./cmd/gost/

FROM tailscale/tailscale:latest
RUN apk add --no-cache iptables ip6tables
COPY --from=builder /usr/local/bin/gost /usr/local/bin/gost
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

### Giải thích build

- `--depth=1`: shallow clone (không lấy full history) → build nhanh hơn.
- `CGO_ENABLED=0`: static binary, không cần libc trên runtime image.
- `-ldflags="-s -w"`: strip debug info → binary nhỏ hơn.
- `iptables` + `ip6tables`: Tailscale cần để quản lý routing rules (đặc biệt khi `ADVERTISE_EXIT_NODE=true`).

## entrypoint.sh

```bash
#!/bin/sh
set -e

# Start tailscaled với userspace networking
tailscaled \
  --state="${TS_STATE_DIR}/tailscaled.state" \
  --socket="${TS_SOCKET}" \
  --tun=userspace-networking &
TS_PID=$!

sleep 3

# Build tailscale up args
TS_UP_ARGS="--authkey=${TS_AUTHKEY} --hostname=${EXIT_NODE_HOSTNAME}"

if [ -n "${TS_LOGIN_SERVER}" ]; then
  TS_UP_ARGS="${TS_UP_ARGS} --login-server=${TS_LOGIN_SERVER}"
fi

if [ "${ADVERTISE_EXIT_NODE}" = "true" ]; then
  TS_UP_ARGS="${TS_UP_ARGS} --advertise-exit-node"
fi

tailscale up ${TS_UP_ARGS} --accept-routes

# Build gost auth string
if [ -n "${PROXY_USER}" ] && [ -n "${PROXY_PASS}" ]; then
  AUTH="${PROXY_USER}:${PROXY_PASS}@"
else
  AUTH=""
fi

# Start SOCKS5 proxy
gost -L "socks5://${AUTH}:${SOCKS5_PORT}" &

# Start HTTP proxy
gost -L "http://${AUTH}:${HTTP_PORT}" &

# Wait for tailscaled
wait $TS_PID
```

### Auth mode

| `PROXY_USER` | `PROXY_PASS` | Auth string | Behavior |
|---|---|---|---|
| set | set | `user:pass@` | Yêu cầu xác thực |
| empty | empty | `` (empty) | No auth — bất kỳ ai trong tailnet đều dùng được |

**Cảnh báo no-auth mode:** Nếu không set auth và proxy port bị expose ra ngoài tailnet (firewall misconfiguration), proxy trở thành open proxy. Đảm bảo chỉ expose trong tailnet.

## Environment Variables

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `TS_AUTHKEY` | — | Có | Pre-auth key để join tailnet |
| `EXIT_NODE_HOSTNAME` | `proxy-node` | Không | Hostname của node trong tailnet |
| `TS_LOGIN_SERVER` | `https://vpn2.hangocthanh.io.vn` | Không | Headscale control server URL |
| `TS_STATE_DIR` | `/var/lib/tailscale` | Không | Thư mục lưu state tailscaled |
| `TS_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Không | Unix socket của tailscaled |
| `PROXY_USER` | `` (empty) | Không | Username xác thực proxy. Empty = no auth |
| `PROXY_PASS` | `` (empty) | Không | Password xác thực proxy |
| `SOCKS5_PORT` | `1080` | Không | Port SOCKS5 proxy |
| `HTTP_PORT` | `8118` | Không | Port HTTP proxy |
| `ADVERTISE_EXIT_NODE` | `false` | Không | `true` = node advertise mình là Tailscale exit node |

### ADVERTISE_EXIT_NODE

Khi `ADVERTISE_EXIT_NODE=true`:
- Node gửi `--advertise-exit-node` lên Headscale.
- Headscale admin phải approve exit node (hoặc `latency` module auto-approve nếu policy cho phép).
- Client Tailscale có thể chọn node này làm exit node để route toàn bộ traffic.

Khác với SOCKS5/HTTP proxy (explicit proxy, client phải cấu hình), exit node Tailscale là transparent (client chọn trong Tailscale app).

## Volumes

```yaml
volumes:
  - exit_node_state:/var/lib/tailscale   # Persist node identity
```

Không cần volume bổ sung. Không có database hay cert riêng.

## Yêu cầu hệ thống

```yaml
# Không cần TUN device vì dùng userspace-networking
# Nhưng nếu muốn kernel mode, cần:
# devices:
#   - /dev/net/tun
# cap_add:
#   - NET_ADMIN
```

`--tun=userspace-networking` trong entrypoint.sh cho phép chạy mà không cần `/dev/net/tun` hay `NET_ADMIN`. Hiệu năng thấp hơn kernel mode nhưng không cần đặc quyền.

Nếu cần hiệu năng cao (kernel mode): bỏ `--tun=userspace-networking`, thêm `devices: /dev/net/tun` và `cap_add: NET_ADMIN`.

## Deploy

File deploy nằm tại: `deploy/exit-node/`

```
deploy/exit-node/
├── docker-compose.yml
└── .env.example
```

### docker-compose.yml

```yaml
version: "3.8"
services:
  exit-node:
    image: ghcr.io/vanbienperu3107/exit-node:latest
    restart: unless-stopped
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}
      EXIT_NODE_HOSTNAME: ${EXIT_NODE_HOSTNAME:-proxy-node}
      TS_LOGIN_SERVER: ${TS_LOGIN_SERVER:-https://vpn2.hangocthanh.io.vn}
      PROXY_USER: ${PROXY_USER:-}
      PROXY_PASS: ${PROXY_PASS:-}
      SOCKS5_PORT: ${SOCKS5_PORT:-1080}
      HTTP_PORT: ${HTTP_PORT:-8118}
      ADVERTISE_EXIT_NODE: ${ADVERTISE_EXIT_NODE:-false}
    volumes:
      - exit_node_state:/var/lib/tailscale
    ports:
      # Chỉ expose nếu cần access từ ngoài tailnet
      # Nếu chỉ dùng trong tailnet: comment out ports
      # - "1080:1080"
      # - "8118:8118"

volumes:
  exit_node_state:
```

### .env.example

```dotenv
TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx
EXIT_NODE_HOSTNAME=proxy-vn
TS_LOGIN_SERVER=https://vpn2.hangocthanh.io.vn
PROXY_USER=
PROXY_PASS=
SOCKS5_PORT=1080
HTTP_PORT=8118
ADVERTISE_EXIT_NODE=false
```

## Cách dùng từ client

### SOCKS5 proxy

```bash
# curl qua SOCKS5 (no auth)
curl --socks5 proxy-node:1080 https://ifconfig.me

# curl qua SOCKS5 (có auth)
curl --socks5 user:pass@proxy-node:1080 https://ifconfig.me
```

### HTTP proxy

```bash
# curl qua HTTP proxy (no auth)
http_proxy=http://proxy-node:8118 curl https://ifconfig.me

# curl qua HTTP proxy (có auth)
http_proxy=http://user:pass@proxy-node:8118 curl https://ifconfig.me
```

### Browser

Cấu hình browser (hoặc system proxy) trỏ đến `proxy-node:1080` (SOCKS5) hoặc `proxy-node:8118` (HTTP).

## Lưu ý quan trọng

- **Standalone VPS:** Module này thiết kế cho VPS riêng biệt, không chạy cùng vpn2/vpn3/vpn4 để không xung đột với stack chính. Mỗi exit-node là một deployment độc lập.
- **userspace-networking:** Dùng `--tun=userspace-networking` nghĩa là Tailscale route qua user-space TCP/IP stack. Latency cao hơn kernel mode khoảng 10-20%. Acceptable cho proxy use case.
- **Port forward:** Nếu VPS có firewall, cần mở port `1080` và `8118` (hoặc để mặc định chỉ accessible trong tailnet và không mở ra ngoài).
- **gost v3 listener address:** `gost -L "socks5://:1080"` lắng nghe trên `0.0.0.0:1080`. Tailscale IP của node sẽ là địa chỉ dùng được trong tailnet. Firewall host nên block các port này nếu không muốn expose ra internet.
- **Multiple exit nodes:** Có thể deploy nhiều instance với `EXIT_NODE_HOSTNAME` khác nhau (ví dụ: `proxy-sg`, `proxy-jp`, `proxy-us`) để client chọn theo nhu cầu geo.
- **gost v3 vs v2:** gost v3 có breaking changes về CLI flags so với v2. Config file format cũng khác. Không dùng config format của gost v2 cho binary v3.
