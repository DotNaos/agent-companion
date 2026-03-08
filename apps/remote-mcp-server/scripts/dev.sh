#!/bin/bash
set -euo pipefail

echo "[dev-event] remote-mcp-server: dev session booting"
echo "[dev-event] remote-mcp-server: freeing port 8788"
node ../../scripts/free-dev-port.mjs 8788 remote-mcp-server

echo "[dev-event] remote-mcp-server: starting tsx watch"
pnpm exec tsx watch src/index.ts
