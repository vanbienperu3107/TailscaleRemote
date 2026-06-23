#!/bin/sh
set -e

FORWARD_TARGET="${FORWARD_TARGET:-api-center:8787}"
FORWARD_PORT="${FORWARD_PORT:-8090}"
SOCK="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"

_term() {
  kill -TERM "$TS_PID" 2>/dev/null || true
  wait "$TS_PID"
}
trap _term TERM INT

# Start tailscaled
/usr/local/bin/tailscaled \
  --state="${TS_STATE_DIR:-/var/lib/tailscale}/tailscaled.state" \
  --socket="$SOCK" \
  &
TS_PID=$!

# Wait for socket instead of fixed sleep
i=0
until [ -S "$SOCK" ] || [ "$i" -ge 30 ]; do
  sleep 1
  i=$((i + 1))
done
[ -S "$SOCK" ] || { echo "tailscaled socket not ready after 30s"; exit 1; }

# Join tailnet
tailscale up \
  --authkey="${TS_AUTHKEY:-}" \
  ${TS_EXTRA_ARGS:-}

# Forward port so ping-reporter on relay nodes can reach api-center; restart on crash
_socat_loop() {
  while true; do
    socat "TCP-LISTEN:${FORWARD_PORT},fork,reuseaddr" "TCP:${FORWARD_TARGET}" || true
    echo "socat exited, restarting in 2s..."
    sleep 2
  done
}
_socat_loop &

# Keep tailscaled as main process
wait $TS_PID
