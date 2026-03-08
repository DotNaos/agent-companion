#!/bin/bash
set -euo pipefail

echo "[dev-event] local-runner: dev session booting"
echo "[dev-event] local-runner: freeing port 4317"
node ../../scripts/free-dev-port.mjs 4317 local-runner

echo "[dev-event] local-runner: starting tsx watch"
pnpm exec tsx watch src/index.ts
