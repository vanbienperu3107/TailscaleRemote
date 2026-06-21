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
