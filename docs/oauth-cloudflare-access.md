# OAuth and Cloudflare Access

## Google OAuth / OIDC

`agent-companion` uses Google identity in two places:

- the remote MCP server validates Google bearer tokens from MCP clients
- the remote admin web interface uses a Google OAuth authorization-code flow and stores a signed local session cookie

## Remote MCP Token Validation

- clients obtain a Google ID token for the configured OAuth client ID
- the remote server validates:
  - Google issuer
  - audience against `GOOGLE_ALLOWED_CLIENT_IDS`
  - verified email
  - admin email authorization

## Remote Admin Login Flow

1. user visits the admin hostname
2. `GET /auth/login/google` redirects to Google
3. `GET /auth/callback/google` exchanges the code for tokens
4. the desktop companion verifies the Google `id_token`
5. a signed `agent_companion_session` cookie is set
6. admin API routes require that cookie

## Optional Cloudflare Access

Cloudflare Access can be placed in front of the public MCP endpoint or the remote admin hostname as an additional perimeter layer. It is optional in this MVP and should not replace the app’s own auth or authorization checks.

## Origin Allowlisting

Set `config.auth.allowedOrigins` to the exact admin web origins you trust, for example:

- `https://admin.example.com`

If configured, the remote admin API rejects requests from other browser origins even when the session cookie is valid.
