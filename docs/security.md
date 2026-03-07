# Security Model

## Threat Model

`agent-companion` assumes the public MCP endpoint and tunneled admin interface are reachable over the internet. The primary threats are:

- unauthorized remote access to MCP tools
- path traversal or accidental broad filesystem access
- arbitrary shell execution
- abuse of the remote admin surface
- silent execution of sensitive actions without local visibility

## Core Defenses

- Authentication and authorization are separate.
  - The remote MCP endpoint validates a Google-issued bearer token and authorizes only the configured admin email.
  - The remote admin web interface uses Google OAuth and a signed session cookie.
- Filesystem access is deny-by-default.
  - A request path must resolve inside either the `projects` root or a manually added allowed path.
  - Access to a manual path includes its descendants only.
- Capability flags are enforced per path.
  - `read`, `write`, `search`, `list`, `execute-tasks`, and `run-command` are checked independently.
- `run_command` is not a generic shell escape hatch.
  - the allowlist is empty by default
  - commands are exact argv arrays
  - execution never uses `shell=true`
  - working directory must also have `run-command` permission
- Sensitive actions can require approval.
  - approvals are recorded and surfaced in the Electron companion and remote admin UI
  - one-time approvals are tied to the exact tool payload
  - remembered approvals can add a path capability or exact command rule

## Why Arbitrary Shell Is Forbidden By Default

An unrestricted `exec` surface would collapse the product into remote code execution. That defeats the product goal. `agent-companion` exposes only narrow tools and exact allowlisted command templates so every execution path remains auditable and user-configurable.

## Sandbox and Path Policy

- `create_project` only accepts a project name and creates the directory under `projectsRoot`.
- `read_file`, `write_file`, `search_files`, and `list_directory` all use the same path normalization and containment checks.
- Traversal like `../secret.txt` is normalized before policy evaluation, so escaping an allowed root is blocked.

## Auth vs Authz

- Auth answers: “who is this caller?”
- Authz answers: “what are they allowed to do here?”

In this MVP:

- MCP auth is Google ID-token validation plus admin-email authorization.
- Remote admin auth is Google OAuth sign-in plus session verification.
- Local tool execution authz is the path/task/command policy stored in the local config.

## Approval Model

- Tool-level approvals can be configured per tool.
- Path or command policy failures can escalate into a pending approval instead of silently executing.
- The desktop companion is the primary approval surface.
- The remote admin UI can resolve pending approvals when the laptop is left running.

## `run_command` Risk Model

- default: no rules, therefore blocked
- exact command matching only
- no shell interpolation
- cwd must be inside a path with `run-command` enabled
- output is capped
- execution has a timeout
- approvals can be required even for allowlisted commands

## Remote Admin Origin Hardening

Allowed origins are additive hardening only. They are not a substitute for auth. The admin API first requires a valid session, then checks the request `Origin` against `config.auth.allowedOrigins`. This reduces cross-origin abuse from browsers while keeping auth as the primary control.
