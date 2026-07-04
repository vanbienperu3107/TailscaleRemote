# TailscaleRemote — Tài liệu

Monorepo hạ tầng Tailscale tự host: DERP management, latency monitoring, HA control plane.

---

## Mục lục

| File | Nội dung |
|------|---------|
| [modules/api-center.md](modules/api-center.md) | API hub trung tâm — endpoints, DB schema, env vars |
| [modules/admin-ui.md](modules/admin-ui.md) | Dashboard React — trang, tính năng, routing |
| [modules/derp-relay.md](modules/derp-relay.md) | DERP relay + ping-reporter |
| [modules/latency.md](modules/latency.md) | Node dedup, server ping, auto-approve routes — ghi vào api-center/Neon |
| [modules/collector-sidecar.md](modules/collector-sidecar.md) | Tailscale join + socat port forward |
| [modules/gateway.md](modules/gateway.md) | Caddy — routing table vpn2 và vpn6 |
| [modules/exit-node.md](modules/exit-node.md) | Standalone proxy node (SOCKS5 + HTTP) |
| [modules/derp-controller.md](modules/derp-controller.md) | Headscale fork — control plane (repo ngoài) |
| [modules/client-mod.md](modules/client-mod.md) | Tailscale Windows fork (repo ngoài) |
| [architecture/overview.md](architecture/overview.md) | Kiến trúc tổng quan + data flows |
| [architecture/ha-lb.md](architecture/ha-lb.md) | HA (vpn2 + vpn6) + Cloudflare LB |
| [deploy/secrets.md](deploy/secrets.md) | Tất cả secrets và env vars |
| [deploy/first-deploy.md](deploy/first-deploy.md) | Hướng dẫn deploy lần đầu vpn2 + vpn6 |
| [deploy/relay-nodes.md](deploy/relay-nodes.md) | Deploy relay node mới (vpn3/4/6) |
| [deploy/version-check.md](deploy/version-check.md) | Checklist kiểm tra phiên bản trước/sau deploy |

---

## Module nhanh

| Module | Image | Chạy trên | Port (nội bộ) |
|--------|-------|-----------|--------------|
| derp-controller | `ghcr.io/vanbienperu3107/derp-controller:latest` | vpn2, vpn6 | 8080 |
| api-center | `ghcr.io/vanbienperu3107/api-center:latest` | vpn2, vpn6 | 8787 |
| admin-ui | `ghcr.io/vanbienperu3107/admin-ui:latest` | vpn2, vpn6 | 80 |
| derp-relay | `ghcr.io/vanbienperu3107/derp-relay:latest` | vpn2,3,4,6 | 8080 (DERP), 3478 UDP |
| latency | `ghcr.io/vanbienperu3107/latency:latest` | vpn2 only | — |
| collector-sidecar | `ghcr.io/vanbienperu3107/collector-sidecar:latest` | vpn2 only | — |
| gateway | `ghcr.io/vanbienperu3107/gateway:latest` | vpn2 only | 80, 443 |
| exit-node | `ghcr.io/vanbienperu3107/exit-node:latest` | any VPS | 1080, 8118 |
