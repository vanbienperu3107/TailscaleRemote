# Stage 1: build gost từ source — không phụ thuộc URL release cụ thể
FROM golang:alpine AS builder

RUN apk add --no-cache git
# GOBIN=fixed path để COPY không bị ảnh hưởng bởi GOARCH (cross-compile)
ENV CGO_ENABLED=0 GOBIN=/usr/local/bin
RUN go install github.com/ginuerzh/gost@latest

# Stage 2: tailscale (Alpine) + gost binary
FROM tailscale/tailscale:latest

RUN apk add --no-cache iptables ip6tables

COPY --from=builder /usr/local/bin/gost /usr/local/bin/gost

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
