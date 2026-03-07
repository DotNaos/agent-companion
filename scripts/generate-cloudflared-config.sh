#!/usr/bin/env bash
set -euo pipefail

: "${TUNNEL_ID:?Set TUNNEL_ID}"
: "${CREDENTIALS_FILE:?Set CREDENTIALS_FILE}"
: "${REMOTE_MCP_HOSTNAME:?Set REMOTE_MCP_HOSTNAME}"
: "${REMOTE_ADMIN_HOSTNAME:?Set REMOTE_ADMIN_HOSTNAME}"

OUTPUT_PATH="${OUTPUT_PATH:-$HOME/.agent-companion/cloudflared/config.yml}"
REMOTE_MCP_ORIGIN="${REMOTE_MCP_ORIGIN:-http://127.0.0.1:8787}"
REMOTE_ADMIN_ORIGIN="${REMOTE_ADMIN_ORIGIN:-http://127.0.0.1:4318}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

cat >"$OUTPUT_PATH" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

ingress:
  - hostname: $REMOTE_MCP_HOSTNAME
    service: $REMOTE_MCP_ORIGIN
  - hostname: $REMOTE_ADMIN_HOSTNAME
    service: $REMOTE_ADMIN_ORIGIN
  - service: http_status:404
EOF

echo "Wrote $OUTPUT_PATH"
