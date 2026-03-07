#!/usr/bin/env bash
set -euo pipefail

if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is already installed: $(command -v cloudflared)"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew is required on macOS to install cloudflared automatically."
      exit 1
    fi
    brew install cloudflared
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
      echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
      sudo apt-get update
      sudo apt-get install -y cloudflared
    else
      echo "Automatic Linux installation is only scripted for apt-based systems."
      exit 1
    fi
    ;;
  *)
    echo "Unsupported OS for automated cloudflared installation."
    exit 1
    ;;
esac

cloudflared --version
