#!/bin/bash
set -e

# Start the Vite dev server for the renderer in the background
vite --port 5173 --strictPort &
VITE_PID=$!

# Wait for Vite to be ready
wait-on tcp:127.0.0.1:5173

# Start Electron with tsx registered via NODE_OPTIONS
export VITE_DEV_SERVER_URL=http://127.0.0.1:5173
export NODE_OPTIONS="--import tsx"
electron . &
ELECTRON_PID=$!

# If either process exits, kill the other
trap "kill $VITE_PID $ELECTRON_PID 2>/dev/null" EXIT

wait $VITE_PID $ELECTRON_PID
