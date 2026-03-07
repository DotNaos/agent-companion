# Cloudflare Tunnel Setup

## Install `cloudflared`

```bash
./scripts/install-cloudflared.sh
```

## Create or Connect a Tunnel

Set the hostnames you want to route:

```bash
export TUNNEL_NAME=agent-companion
export REMOTE_MCP_HOSTNAME=mcp.example.com
export REMOTE_ADMIN_HOSTNAME=admin.example.com
./scripts/create-cloudflare-tunnel.sh
```

This runs:

- `cloudflared tunnel login`
- `cloudflared tunnel create`
- `cloudflared tunnel route dns` for both hostnames

## Generate the Config File

```bash
export TUNNEL_ID=...
export CREDENTIALS_FILE=$HOME/.cloudflared/$TUNNEL_ID.json
export REMOTE_MCP_HOSTNAME=mcp.example.com
export REMOTE_ADMIN_HOSTNAME=admin.example.com
./scripts/generate-cloudflared-config.sh
```

Default local origins:

- MCP server: `http://127.0.0.1:${PORT:-8787}`
- admin interface: `http://127.0.0.1:${DESKTOP_PORT:-4318}`

The generator now reads the repo `.env` / `.env.local` first, so if you run the MCP server on a non-default port such as `8788`, the generated tunnel config will follow that automatically.

## Verify the Tunnel

```bash
CONFIG_PATH=$HOME/.agent-companion/cloudflared/config.yml \
TUNNEL_NAME=agent-companion \
./scripts/verify-cloudflared.sh
```

## Autostart

### macOS `launchd`

Copy and adapt:

- `infra/cloudflare/launchd/com.agent-companion.local-runner.plist`
- `infra/cloudflare/launchd/com.agent-companion.cloudflared.plist`

Load them:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-companion.local-runner.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-companion.cloudflared.plist
```

### Linux `systemd` (optional)

Use `infra/cloudflare/systemd/agent-companion-local-runner.service` as a starting point.

## Troubleshooting

- `cloudflared tunnel ingress validate` fails:
    - check hostname spelling and local service URLs
- DNS route exists but hostname does not resolve:
    - confirm the Cloudflare zone and tunnel are in the same account
- remote admin loads but API calls fail with `403`:
    - add the public admin origin to `config.auth.allowedOrigins`
- remote admin loads but API calls fail with `401`:
    - verify Google OAuth client config and session secret
