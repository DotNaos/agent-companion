# Deployment

## Overview

Deploy `agent-companion` as two cooperating runtimes:

- `apps/remote-mcp-server` on an internet-reachable host
- `apps/local-runner` and `apps/desktop-companion` on the user’s machine

The local machine does not expose the runner directly. The only public entrypoints should be:

- the remote MCP server
- the remote admin interface served by the desktop companion through Cloudflare Tunnel

## Remote MCP Server

1. Set environment variables from `.env.example`.
2. Start the service:

    ```bash
    pnpm --filter @agent-companion/remote-mcp-server start
    ```

3. Publish the configured `PORT` (default `8787`) behind your reverse proxy or Cloudflare Tunnel target.

## Local Runner

1. Configure the same `RUNNER_TOKEN` and the public `REMOTE_SERVER_URL`.
2. Start the runner:

    ```bash
    pnpm --filter @agent-companion/local-runner start
    ```

3. The runner opens an outbound WebSocket to `/runner/connect`.
4. The runner also serves a loopback-only control API on `127.0.0.1:4317`.

## Desktop Companion

1. Set:
    - `DESKTOP_PUBLIC_BASE_URL`
    - `GOOGLE_OIDC_CLIENT_ID`
    - `GOOGLE_OIDC_CLIENT_SECRET`
    - `SESSION_SECRET`
2. Start the renderer in dev mode if needed:

    ```bash
    pnpm --filter @agent-companion/desktop-companion renderer
    ```

3. Start Electron:

    ```bash
    pnpm --filter @agent-companion/desktop-companion dev
    ```

4. Configure the projects root, allowed paths, allowed tasks, and `run_command` rules from the desktop UI.

## Remote Admin Exposure

Expose `http://127.0.0.1:${DESKTOP_PORT:-4318}` through Cloudflare Tunnel and map the remote admin hostname to that local port. The admin web interface remains backed by the same local config store and runner control plane.

If you generate the tunnel config via `scripts/generate-cloudflared-config.sh`, it will automatically pick up `PORT` and `DESKTOP_PORT` from the repo `.env` / `.env.local` before falling back to the default ports.

## Allowed Roots, Capability Flags, and Tasks

The desktop UI persists:

- `projectsRoot`
- manual allowed paths
- per-path capability flags
- allowed repo tasks
- allowed dev-server tasks
- `run_command` rules
- remote admin allowed origins

The local runner re-reads that config and enforces it at runtime.
