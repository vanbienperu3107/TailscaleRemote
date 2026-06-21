#!/bin/sh
set -e

DERP_HOSTNAME="${DERP_HOSTNAME:-}"
DERP_CERTMODE="${DERP_CERTMODE:-manual}"
DERP_CERTDIR="${DERP_CERTDIR:-/certs}"
DERP_HTTP_PORT="${DERP_HTTP_PORT:-80}"
DERP_STUN_PORT="${DERP_STUN_PORT:-3478}"
DERP_VERIFY_CLIENTS="${DERP_VERIFY_CLIENTS:-true}"

# Start derper in background
derper \
  --hostname="${DERP_HOSTNAME}" \
  --certmode="${DERP_CERTMODE}" \
  --certdir="${DERP_CERTDIR}" \
  --http-port="${DERP_HTTP_PORT}" \
  --stun-port="${DERP_STUN_PORT}" \
  --verify-clients="${DERP_VERIFY_CLIENTS}" \
  &
DERPER_PID=$!

# Start ping-reporter if TS_SOCKET is available
if [ -n "${REPORTER_NAME}" ]; then
  sleep 5
  python3 /app/reporter.py &
fi

# Wait for derper (primary process)
wait $DERPER_PID
