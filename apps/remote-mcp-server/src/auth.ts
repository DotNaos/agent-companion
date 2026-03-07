import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError } from "@agent-companion/shared";
import type { RemoteEnv } from "./env.js";

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface AuthenticatedActor {
  email: string;
  subject: string;
}

export async function exchangeGoogleCodeForActor(
  code: string,
  redirectUri: string,
  env: RemoteEnv,
): Promise<AuthenticatedActor> {
  if (!env.GOOGLE_OIDC_CLIENT_ID || !env.GOOGLE_OIDC_CLIENT_SECRET) {
    throw new AppError("OAUTH_NOT_CONFIGURED", "Google OAuth is not configured for the remote MCP server", 500);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OIDC_CLIENT_ID,
      client_secret: env.GOOGLE_OIDC_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    throw new AppError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google token exchange failed", 502);
  }

  const tokenPayload = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenPayload.id_token) {
    throw new AppError("OAUTH_TOKEN_EXCHANGE_FAILED", "Google did not return an id_token", 502);
  }

  return await verifyGoogleToken(tokenPayload.id_token, [env.GOOGLE_OIDC_CLIENT_ID], env.ADMIN_EMAIL);
}

export async function verifyGoogleBearerToken(
  authorizationHeader: string | undefined,
  env: RemoteEnv,
): Promise<AuthenticatedActor> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new AppError("UNAUTHORIZED", "Missing bearer token", 401);
  }

  const token = authorizationHeader.slice("Bearer ".length);
  const audiences = env.GOOGLE_ALLOWED_CLIENT_IDS
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return await verifyGoogleToken(token, audiences, env.ADMIN_EMAIL);
}

async function verifyGoogleToken(
  token: string,
  audiences: string[],
  adminEmail: string,
): Promise<AuthenticatedActor> {
  const { payload } = await jwtVerify(token, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    ...(audiences.length > 0 ? { audience: audiences } : {}),
  });

  const email = typeof payload.email === "string" ? payload.email : null;
  const emailVerified = payload.email_verified === true;
  const subject = typeof payload.sub === "string" ? payload.sub : null;

  if (!email || !emailVerified || !subject) {
    throw new AppError("UNAUTHORIZED", "Token is missing required Google identity claims", 401);
  }
  if (email !== adminEmail) {
    throw new AppError("FORBIDDEN", "Authenticated user is not authorized for this server", 403);
  }

  return { email, subject };
}
