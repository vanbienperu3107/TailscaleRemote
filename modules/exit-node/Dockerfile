# Stage 1: lấy gost binary (multi-protocol proxy)
FROM ghcr.io/go-gost/gost:latest AS gost

# Stage 2: tailscale image (Alpine-based) + gost
FROM tailscale/tailscale:latest

RUN apk add --no-cache iptables ip6tables

# Copy gost binary từ stage 1
COPY --from=gost /bin/gost /usr/local/bin/gost

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
