# Module: client-mod (External repo)

## Tổng quan

| Thuộc tính | Giá trị |
|---|---|
| Loại | External repository — không có Docker image |
| Source repo | `vanbienperu3107/tailscale_mod` |
| URL | https://github.com/vanbienperu3107/tailscale_mod |
| Base | Tailscale v1.98.4 (official fork) |
| Chạy trên | Windows endpoints (máy khách) |
| CI trong TailscaleRemote | Không — build thủ công hoặc CI trong repo riêng |

> **Lưu ý:** Đây là external repository. Không có thư mục `modules/client-mod/` trong repo `TailscaleRemote`. Tài liệu này mô tả integration và behavior của fork, không phải source trong monorepo.

## Mục đích

`tailscale_mod` là fork của Tailscale Windows client (v1.98.4) được patch thêm một background goroutine để **báo cáo metrics về collector** (latency module trên vpn2). Mục tiêu:

- Ghi nhận MAC address của card mạng chính (để định danh thiết bị).
- Đo RTT từ Windows client đến tất cả peer online trong tailnet.
- POST dữ liệu lên collector để hiển thị trong dashboard và phân tích latency end-to-end.

Không thay đổi hành vi Tailscale cốt lõi (routing, DERP, auth). Chỉ thêm background reporting.

## Kiến trúc

```
Windows endpoint
┌──────────────────────────────────────────────────────────┐
│                    tailscale_mod                         │
│                                                          │
│  ┌─────────────────────────┐  ┌──────────────────────┐  │
│  │   Tailscale core        │  │  Reporter goroutine  │  │
│  │   (không thay đổi)      │  │  (thêm vào v1.98.4)  │  │
│  │                         │  │                      │  │
│  │  LocalAPI unix socket   │◄─│  GET /status         │  │
│  │  /var/run/tailscale/    │  │  POST /ping          │  │
│  │  tailscaled.sock        │  │                      │  │
│  │                         │  │  đọc MAC (WMI)       │  │
│  └─────────────────────────┘  └──────────┬───────────┘  │
│                                           │ mỗi 30s      │
└───────────────────────────────────────────┼──────────────┘
                                            │
                                            ▼ POST qua tailnet
                                  collector:8090/metrics/report
                                  (latency module trên vpn2)
```

## Các thay đổi so với tailscale v1.98.4

### 1. Background goroutine reporter

Một goroutine mới được thêm vào Tailscale daemon, chạy định kỳ mỗi **30 giây**:

```go
// Pseudo-code — logic thêm vào
func startReporter(ctx context.Context, lc *local.Client) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            report(ctx, lc)
        case <-ctx.Done():
            return
        }
    }
}
```

### 2. Đọc MAC address

Dùng **WMI** (Windows Management Instrumentation) hoặc `GetAdaptersInfo` (Win32 API) để lấy MAC address của card mạng chính (card có default route):

```go
// Ưu tiên WMI query:
// SELECT MACAddress FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE
// Fallback: GetAdaptersInfo() từ iphlpapi.dll
```

MAC address dùng để định danh thiết bị bền vững hơn hostname (hostname có thể thay đổi).

### 3. Lấy danh sách peer qua LocalAPI

```
GET /localapi/v0/status
```

Response chứa danh sách tất cả peer trong tailnet kèm trạng thái online/offline, Tailscale IP, hostname. Goroutine lọc lấy peer đang **online**.

### 4. Ping từng peer

```
POST /localapi/v0/ping?ip=<tailnet-ip>&type=disco
```

Thực hiện disco ping đến từng peer online, lấy RTT (ms). Timeout mỗi ping là hợp lý (không block quá lâu nếu peer không trả lời).

### 5. POST kết quả lên collector

```
POST http://collector:8090/metrics/report
Content-Type: application/json

{
  "hostname": "itop-thanhhn",
  "mac": "AA:BB:CC:DD:EE:FF",
  "ipv4": "100.64.x.x",
  "samples": [
    {
      "dst": "vpn3",
      "dst_ip": "100.64.y.y",
      "rtt_ms": 15.2,
      "path": "derp-vpn3-vn",
      "ok": true
    },
    {
      "dst": "vpn4",
      "dst_ip": "100.64.z.z",
      "rtt_ms": 28.7,
      "path": "direct",
      "ok": true
    }
  ]
}
```

`collector` được resolve qua Tailscale DNS (hostname của `collector-sidecar` node trong tailnet).

## Payload structure

### POST /metrics/report

| Field | Type | Mô tả |
|---|---|---|
| `hostname` | string | Hostname Windows endpoint |
| `mac` | string | MAC address card mạng chính (format `AA:BB:CC:DD:EE:FF`) |
| `ipv4` | string | Tailnet IPv4 của endpoint |
| `samples` | array | Mảng kết quả ping đến từng peer |
| `samples[].dst` | string | Hostname đích |
| `samples[].dst_ip` | string | Tailnet IP đích |
| `samples[].rtt_ms` | float | RTT ms |
| `samples[].path` | string | `"direct"` hoặc `"derp-<region>"` |
| `samples[].ok` | bool | Ping thành công hay timeout |

## Build

### Yêu cầu

- Go 1.22+ (khuyến nghị dùng cùng version với Tailscale v1.98.4)
- Windows SDK (cho WMI và Win32 API bindings)
- Git

### Build thủ công

```powershell
git clone https://github.com/vanbienperu3107/tailscale_mod.git
cd tailscale_mod
go build -o tailscale.exe ./cmd/tailscale/
go build -o tailscaled.exe ./cmd/tailscaled/
```

### CI

Không có CI trong repo `TailscaleRemote`. CI nằm trong repo `vanbienperu3107/tailscale_mod` (nếu đã cấu hình). Build thủ công trên máy Windows hoặc dùng GitHub Actions trong repo gốc.

> **Quy tắc:** Không deploy build lên máy thật cho đến khi CI trong repo `tailscale_mod` pass. Xem memory `build-test-before-prod.md`.

## Cài đặt trên Windows endpoint

1. Gỡ cài đặt Tailscale official (nếu đã cài).
2. Stop service `Tailscale` nếu đang chạy.
3. Replace binary `tailscale.exe` và `tailscaled.exe` trong thư mục cài đặt.
4. Start lại service hoặc re-install.
5. Join tailnet như bình thường (`tailscale up --login-server=...`).

Reporter goroutine tự động start khi `tailscaled` khởi động. Không cần cấu hình thêm.

## Collector endpoint

Reporter gửi về `http://collector:8090/metrics/report` — `collector` là Tailscale hostname của `collector-sidecar` node trên vpn2.

Resolve flow:
```
collector:8090
    │ Tailscale MagicDNS
    ▼
100.64.x.x:8090  (Tailnet IP của collector-sidecar)
    │ socat trong collector-sidecar
    ▼
latency:8090  (Docker network trên vpn2)
```

Nếu `collector-sidecar` offline, report thất bại silently (goroutine log error và tiếp tục đến lần tiếp theo sau 30s). Không ảnh hưởng hoạt động Tailscale cốt lõi.

## Lưu ý quan trọng

- **Không thay đổi Tailscale core:** Mọi patch chỉ thêm goroutine phụ. Hoạt động routing, DERP, auth, DNS không bị ảnh hưởng. Nếu reporter crash, panic được recover để không làm crash toàn bộ daemon.
- **MAC address stability:** MAC là primary key để dedup node trong `latency` module. Đổi card mạng hoặc virtual MAC (VM snapshot) sẽ tạo record mới. Hostname vẫn dùng làm secondary identifier.
- **Tailnet-only transport:** Reporter chỉ gửi qua tailnet (`collector` hostname). Không gửi ra internet, không có hardcoded IP. Nếu node chưa join tailnet, report không thực hiện.
- **30s interval:** Interval này đồng bộ với `POLL_INTERVAL=30` của relay reporters (vpn3/4). Dashboard hiển thị data đồng nhất từ tất cả nguồn.
- **Rebase policy:** Khi Tailscale upstream release version mới, cần rebase patch lên version đó. Fork ở v1.98.4 — theo dõi upstream để rebase kịp thời, đặc biệt nếu có security fix.
- **WMI dependency:** WMI có thể bị disable hoặc bị chặn trong một số môi trường enterprise. Fallback `GetAdaptersInfo` sẽ được dùng; nếu cả hai đều fail, `mac` field sẽ là empty string và record vẫn được gửi (dedup dùng hostname làm fallback key).
