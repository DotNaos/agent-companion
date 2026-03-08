#!/bin/bash
set -euo pipefail

echo "[dev-event] desktop-companion: dev session booting"

# Free the renderer dev port if a stale node/electron process is still listening
echo "[dev-event] desktop-companion: freeing Vite port 5173"
node ../../scripts/free-dev-port.mjs 5173 desktop-companion-vite

# Start the Vite dev server for the renderer in the background
echo "[dev-event] desktop-companion: starting Vite renderer"
vite --port 5173 --strictPort &
VITE_PID=$!

# Wait for Vite to be ready
echo "[dev-event] desktop-companion: waiting for Vite readiness"
wait-on tcp:127.0.0.1:5173

# Ensure the local Electron binary exists even if postinstall was skipped
echo "[dev-event] desktop-companion: ensuring Electron install"
node ../../scripts/ensure-electron-install.mjs

# Start Electron with tsx registered via NODE_OPTIONS
export VITE_DEV_SERVER_URL=http://127.0.0.1:5173
export NODE_OPTIONS="--import tsx"
echo "[dev-event] desktop-companion: starting Electron shell"
pnpm exec cross-env NODE_OPTIONS="--import tsx" electron . &
ELECTRON_PID=$!

# If either process exits, kill the other
trap 'echo "[dev-event] desktop-companion: shutting down child processes"; kill $VITE_PID $ELECTRON_PID 2>/dev/null' EXIT

wait $VITE_PID $ELECTRON_PID
