# Stage 1: build gost v3 từ source
# (gost v2/ginuerzh bị broken do obfs4 dep đổi sang gitlab, không fix được)
FROM golang:alpine AS builder

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth=1 https://github.com/go-gost/gost.git .

# Build static binary — BuildKit set GOARCH tự động cho cross-compile
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /usr/local/bin/gost ./cmd/gost/

# Stage 2: tailscale (Alpine) + gost v3 binary
FROM tailscale/tailscale:latest

RUN apk add --no-cache iptables ip6tables

COPY --from=builder /usr/local/bin/gost /usr/local/bin/gost

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
