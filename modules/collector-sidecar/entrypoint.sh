#!/bin/sh
set -e

FORWARD_TARGET="${FORWARD_TARGET:-latency:8090}"
FORWARD_PORT="${FORWARD_PORT:-8090}"

# Start tailscaled
/usr/local/bin/tailscaled \
  --state="${TS_STATE_DIR:-/var/lib/tailscale}/tailscaled.state" \
  --socket="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}" \
  &
TS_PID=$!

sleep 3

# Join tailnet
tailscale up \
  --authkey="${TS_AUTHKEY:-}" \
  ${TS_EXTRA_ARGS:-}

# Forward port so ping-reporter on relay nodes can reach Latency module
socat "TCP-LISTEN:${FORWARD_PORT},fork,reuseaddr" "TCP:${FORWARD_TARGET}" &

# Keep tailscaled as main process
wait $TS_PID
