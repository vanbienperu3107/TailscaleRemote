# Module: collector-sidecar

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Image | `ghcr.io/vanbienperu3107/collector-sidecar:latest` |
| Source | `modules/collector-sidecar/Dockerfile` + `entrypoint.sh` |
| Stack | `tailscale/tailscale:latest` + `socat` |
| Chạy trên | vpn2 only (cùng host với `latency`) |
| Port exposed | Không (chỉ nhận traffic qua tailnet) |

## Mục đích

`collector-sidecar` là một container Tailscale chuyên dụng chạy cạnh `latency` trên vpn2, đảm nhiệm hai nhiệm vụ:

1. **Join tailnet với hostname "collector"** — cung cấp unix socket LocalAPI để `latency` module dùng khi tự ping các peer.
2. **socat TCP port forward** — nhận traffic từ tailnet (relay nodes gửi metrics report) và forward vào `latency` container trong Docker network.

Thiết kế sidecar này tách biệt network (Tailscale) khỏi application logic (`latency`), giúp `latency` không cần tự quản lý Tailscale connection.

## Kiến trúc

```
  vpn3/vpn4/vpn6                        vpn2 host
  (relay nodes)                         ┌──────────────────────────────────────┐
                                        │                                      │
  reporter.py                           │  ┌────────────────────────────┐     │
  POST metrics/report                   │  │    collector-sidecar        │     │
      │                                 │  │                            │     │
      │ (qua tailnet)                   │  │  tailscaled                │     │
      └────────────────────────────────►│  │    hostname: collector     │     │
                                        │  │    authkey: TS_AUTHKEY     │     │
                                        │  │                            │     │
                                        │  │  socat                     │     │
                                        │  │    LISTEN :8090            │     │
                                        │  │    → TCP:latency:8090      │     │
                                        │  └─────────┬──────────────────┘     │
                                        │            │                         │
                                        │            │ Docker network          │
                                        │            ▼                         │
                                        │  ┌────────────────────────────┐     │
                                        │  │       latency              │     │
                                        │  │       :8090                │     │
                                        │  └────────────────────────────┘     │
                                        │                                      │
                                        │   ts_sock volume                     │
                                        │   /var/run/tailscale/                │
                                        │   tailscaled.sock ◄──── latency      │
                                        └──────────────────────────────────────┘
```

## Dockerfile

```dockerfile
FROM tailscale/tailscale:latest
RUN apk add --no-cache socat
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

Base image là official Tailscale image (`tailscale/tailscale:latest` dựa trên Alpine). Chỉ thêm `socat` để làm TCP port forwarder.

## entrypoint.sh

```bash
#!/bin/sh
set -e

# Start tailscaled daemon
tailscaled \
  --state="${TS_STATE_DIR}/tailscaled.state" \
  --socket="${TS_SOCKET}" &
TS_PID=$!

sleep 3

# Join tailnet
tailscale up \
  --authkey="${TS_AUTHKEY}" \
  ${TS_EXTRA_ARGS}

# Start socat port forward: tailnet port → latency container
socat TCP-LISTEN:${FORWARD_PORT},fork,reuseaddr \
      TCP:${FORWARD_TARGET} &

# Wait for tailscaled
wait $TS_PID
```

### Giải thích flow

1. **tailscaled start**: Daemon Tailscale khởi động, tạo unix socket tại `TS_SOCKET`. Socket này được mount vào volume `ts_sock` để `latency` có thể dùng.
2. **sleep 3**: Chờ tailscaled ổn định trước khi gọi `tailscale up`.
3. **tailscale up**: Join tailnet với pre-auth key. `TS_EXTRA_ARGS` cho phép truyền thêm flags như `--login-server`, `--hostname`, `--accept-dns=false`.
4. **socat**: Mở port `FORWARD_PORT` (8090) để nhận TCP connection, fork cho mỗi connection mới, forward đến `FORWARD_TARGET` (latency:8090) trong Docker network.
5. **wait**: Block trên `tailscaled` PID để container không exit.

## Environment Variables

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `TS_AUTHKEY` | — | Có | Pre-auth key để join tailnet. Nên dùng reusable key để restart tự động re-auth |
| `TS_EXTRA_ARGS` | — | Không | Flags bổ sung cho `tailscale up`. Ví dụ: `--login-server=https://vpn2.hangocthanh.io.vn --hostname=collector --accept-dns=false` |
| `TS_STATE_DIR` | `/var/lib/tailscale` | Không | Thư mục lưu state file của tailscaled |
| `TS_SOCKET` | `/var/run/tailscale/tailscaled.sock` | Không | Đường dẫn unix socket của tailscaled |
| `FORWARD_TARGET` | `latency:8090` | Không | Địa chỉ target mà socat forward đến (tên service trong Docker network) |
| `FORWARD_PORT` | `8090` | Không | Port socat lắng nghe trên tailnet interface |

### Ví dụ TS_EXTRA_ARGS

```
--login-server=https://vpn2.hangocthanh.io.vn --hostname=collector --accept-dns=false
```

- `--login-server`: trỏ về Headscale control server.
- `--hostname=collector`: hostname trong tailnet. Relay nodes gửi report đến `collector:8090`.
- `--accept-dns=false`: không dùng Tailscale DNS (tránh conflict với DNS của host).

## Volumes

```yaml
volumes:
  collector_state:/var/lib/tailscale     # State của tailscaled (persist qua restart)
  ts_sock:/var/run/tailscale             # Chia sẻ unix socket với latency
```

| Volume | Mount point | Chia sẻ với | Mục đích |
|---|---|---|---|
| `collector_state` | `/var/lib/tailscale` | Không chia sẻ | Lưu `tailscaled.state` — node identity persist qua restart |
| `ts_sock` | `/var/run/tailscale` | `latency` container | Cung cấp `tailscaled.sock` cho `latency` module dùng LocalAPI |

**Lưu ý volume `ts_sock`:** Đây là cơ chế kết nối chính giữa hai container. `latency` mount volume này và gọi LocalAPI qua socket để ping peers, đọc status, v.v.

## Yêu cầu hệ thống

```yaml
devices:
  - /dev/net/tun          # TUN device cho Tailscale

cap_add:
  - NET_ADMIN             # Cần để tạo/quản lý network interface
```

Nếu không có `/dev/net/tun` hoặc `NET_ADMIN`, tailscaled sẽ fail khi tạo network interface. Đây là yêu cầu bắt buộc của Tailscale kernel mode.

> **Lưu ý:** `TS_EXTRA_ARGS=--tun=userspace-networking` có thể bỏ qua yêu cầu TUN device, nhưng hiệu năng thấp hơn và không phải default configuration.

## Docker Compose snippet

```yaml
collector-sidecar:
  image: ghcr.io/vanbienperu3107/collector-sidecar:latest
  restart: unless-stopped
  environment:
    TS_AUTHKEY: ${COLLECTOR_TS_AUTHKEY}
    TS_EXTRA_ARGS: --login-server=https://vpn2.hangocthanh.io.vn --hostname=collector --accept-dns=false
    TS_STATE_DIR: /var/lib/tailscale
    TS_SOCKET: /var/run/tailscale/tailscaled.sock
    FORWARD_TARGET: latency:8090
    FORWARD_PORT: "8090"
  volumes:
    - collector_state:/var/lib/tailscale
    - ts_sock:/var/run/tailscale
  devices:
    - /dev/net/tun
  cap_add:
    - NET_ADMIN

latency:
  image: ghcr.io/vanbienperu3107/latency:latest
  restart: unless-stopped
  volumes:
    - latency_data:/data
    - ts_sock:/var/run/tailscale   # Dùng socket của collector-sidecar
  # ...

volumes:
  collector_state:
  ts_sock:
  latency_data:
```

## COUPLING với latency

> **collector-sidecar và latency PHẢI chạy cùng host.** Không thể tách sang host khác.

| Dependency | Hướng | Lý do |
|---|---|---|
| `ts_sock` volume | collector-sidecar → latency | latency đọc unix socket để dùng LocalAPI |
| Docker network | socat (sidecar) → latency:8090 | socat forward traffic từ tailnet vào latency |
| `FORWARD_TARGET=latency:8090` | sidecar cần resolve hostname `latency` | Phải trong cùng Docker network |

Khi di chuyển sang host mới, **di chuyển cả hai container cùng lúc** và đảm bảo volumes được migrate đúng cách.

## Lưu ý quan trọng

- **Pre-auth key:** Nên dùng pre-auth key loại **reusable + ephemeral=false** để container có thể restart mà không cần tạo key mới. Key hết hạn = container không join được tailnet = mọi relay node mất kết nối đến collector.
- **socat fork mode:** `fork` trong `socat TCP-LISTEN:8090,fork,...` cho phép xử lý nhiều connection đồng thời. Không có `fork` thì chỉ xử lý được một connection tại một thời điểm.
- **IP mất do socat:** Do socat forward TCP, collector (latency module) nhìn thấy source IP là Docker bridge, không phải IP tailnet của relay node. Đây là lý do latency module phải chấp nhận Docker network range trong IP-based auth.
- **Restart behavior:** Khi restart container, `collector_state` volume giữ node identity nên không cần re-auth từ đầu (nếu dùng reusable key). State persist đồng nghĩa node giữ nguyên IP tailnet.
- **tailscale up idempotent:** Gọi lại `tailscale up` khi đã connected chỉ cập nhật flags, không tạo node mới.
