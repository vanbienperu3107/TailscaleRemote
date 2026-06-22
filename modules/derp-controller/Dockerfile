FROM golang:1.25-alpine AS builder

ARG VERSION=0.27.1-pernode
WORKDIR /app

RUN apk add --no-cache git

# Clone headscale fork (Feature B: per-node DERPMap override)
RUN git clone --depth=1 --branch feat/pernode-derpmap \
    https://github.com/vanbienperu3107/headscale.git .

RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o headscale \
      ./cmd/headscale

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /app/headscale /usr/local/bin/headscale

EXPOSE 8080 9090 50443

ENTRYPOINT ["headscale"]
