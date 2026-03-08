# agent-companion

`agent-companion` is a standalone product that gives a remote MCP client a tightly controlled path to a personal computer through a local companion agent. It is not designed as an Aryazos-internal module. The repo is structured as an independent deployable system with its own remote server, local runner, Electron companion, Cloudflare ingress, configuration, and docs.

## Architecture

```text
OpenAI / Codex-compatible MCP client
          |
          v
apps/remote-mcp-server
  - Streamable HTTP MCP endpoint
  - Google ID-token auth
  - request validation + structured logs
  - relay to connected local runner
          |
          v
authenticated WebSocket relay
          |
          v
apps/local-runner
  - outbound-only connection
  - path sandbox + per-path capabilities
  - task allowlists + run_command policy
  - approval queue + activity log
  - loopback-only control API
          |
          v
apps/desktop-companion
  - Electron tray app
  - floating overlay
  - remote admin web UI served locally
  - Google OAuth for remote admin
  - tunnel controls + approval dialogs
```

## Workspace Layout

- `apps/remote-mcp-server`: public MCP server and runner relay.
- `apps/local-runner`: local enforcement runtime and tool handlers.
- `apps/desktop-companion`: Electron shell plus remote admin web server and React UI.
- `packages/shared`: shared schemas, config models, policy helpers, and error envelopes.
- `infra/cloudflare`: tunnel config examples and service templates.
- `docs`: deployment, security, UI, OAuth, tunnel, and tool reference docs.

## Quickstart

1. Install dependencies:
    ```bash
    pnpm install
    ```
2. Copy `.env.example` into your preferred environment loader and set real values for:
    - `ADMIN_EMAIL`
    - `RUNNER_TOKEN`
    - `GOOGLE_ALLOWED_CLIENT_IDS`
    - `GOOGLE_OIDC_CLIENT_ID`
    - `GOOGLE_OIDC_CLIENT_SECRET`
    - `SESSION_SECRET`
    - `DESKTOP_PUBLIC_BASE_URL`
3. Start the local runner:
    ```bash
    pnpm --filter @agent-companion/local-runner dev
    ```
4. Start the remote MCP server:
    ```bash
    pnpm --filter @agent-companion/remote-mcp-server dev
    ```
5. Start the desktop companion:
    ```bash
    pnpm --filter @agent-companion/desktop-companion renderer
    pnpm --filter @agent-companion/desktop-companion dev
    ```
6. Configure the projects root and allowed paths from the desktop app, then add any allowed repo tasks and `run_command` rules.

## Security Model

- Filesystem access is deny-by-default and constrained to the configured `projects` root plus explicit manual path grants.
- Every path grant carries capability flags: `read`, `write`, `search`, `list`, `execute-tasks`, `run-command`.
- `run_command` has an empty allowlist by default and never executes through a shell.
- Sensitive tools can be blocked behind an approval gate and surfaced in both the Electron UI and the remote admin UI.
- The remote admin API requires a valid session cookie from Google OAuth and can additionally enforce explicit allowed origins.

## Verification

- Typecheck: `pnpm typecheck`
- Tests: `pnpm test`

## Performance profiling

- Capture an unattended desktop performance bundle: `pnpm profile:desktop`
- Output is written to `profiles/desktop/<timestamp>/`
- Each bundle includes:
    - `summary.md` — LLM-friendly diagnosis summary
    - `profile.json` — machine-readable metadata
    - `ps.txt` — process snapshot
    - `sample-*.txt` — short macOS process samples
    - `vmmap-*.txt` — memory maps for hot processes (when available)
    - copied desktop session logs from the latest `logs/<session>/`

This workflow is designed so an agent can run the command, read `summary.md`, and inspect the raw artifacts without any human-in-the-loop triage.

The current test suite covers the critical safety rules requested in the prompt, including path traversal rejection, per-path capability enforcement, `run_command` default denial, approval blocking, admin auth rejection, origin rejection, and safe-path happy paths.

## Standalone Product Positioning

`agent-companion` is intentionally packaged and documented as a reusable standalone product. Any later Aryazos integration should consume its public interfaces rather than collapsing these boundaries.
