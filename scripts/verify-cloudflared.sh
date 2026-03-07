#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${CONFIG_PATH:-$HOME/.agent-companion/cloudflared/config.yml}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
TUNNEL_NAME="${TUNNEL_NAME:-}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config file not found: $CONFIG_PATH"
  exit 1
fi

"$CLOUDFLARED_BIN" --version
"$CLOUDFLARED_BIN" tunnel --config "$CONFIG_PATH" ingress validate

if [[ -n "$TUNNEL_NAME" ]]; then
  "$CLOUDFLARED_BIN" tunnel info "$TUNNEL_NAME"
fi
