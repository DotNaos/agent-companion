#!/usr/bin/env bash
set -euo pipefail

: "${TUNNEL_NAME:?Set TUNNEL_NAME}"
: "${REMOTE_MCP_HOSTNAME:?Set REMOTE_MCP_HOSTNAME}"
: "${REMOTE_ADMIN_HOSTNAME:?Set REMOTE_ADMIN_HOSTNAME}"

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"

"$CLOUDFLARED_BIN" tunnel login
"$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME"
"$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" "$REMOTE_MCP_HOSTNAME"
"$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" "$REMOTE_ADMIN_HOSTNAME"

echo "Tunnel created. Next step: run scripts/generate-cloudflared-config.sh"
