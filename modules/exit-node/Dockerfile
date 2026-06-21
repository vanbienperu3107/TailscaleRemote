FROM tailscale/tailscale:latest

# TARGETARCH được BuildKit set tự động: amd64 | arm64 (cho multi-arch build)
ARG TARGETARCH=amd64
ARG GOST_VERSION=2.12.0

RUN apk add --no-cache iptables ip6tables wget

# gost v2 — SOCKS5 + HTTP CONNECT proxy (single static binary)
# Tải thẳng từ GitHub releases, không cần image trung gian
RUN wget -qO- \
      "https://github.com/ginuerzh/gost/releases/download/v${GOST_VERSION}/gost-linux-${TARGETARCH}-${GOST_VERSION}.gz" | \
      gunzip > /usr/local/bin/gost && \
    chmod +x /usr/local/bin/gost

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
