import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Response } from "express";
import { AppError } from "@agent-companion/shared";
import type { DesktopEnv } from "./env.js";
import { UserStore } from "./user-store.js";

const encoder = new TextEncoder();
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface AdminSession {
  email: string;
  subject: string;
}

const stateStore = new Map<string, number>();

export function createLoginUrl(env: DesktopEnv) {
  if (!env.GOOGLE_OIDC_CLIENT_ID || !env.DESKTOP_PUBLIC_BASE_URL) {
    throw new AppError("OAUTH_NOT_CONFIGURED", "Google OAuth is not configured for the desktop companion", 500);
  }
  const state = randomUUID();
  stateStore.set(state, Date.now());
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/auth/callback/google", env.DESKTOP_PUBLIC_BASE_URL).toString());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return { url: url.toString(), state };
}

export async function exchangeCodeForSession(
  code: string,
  state: string,
  env: DesktopEnv,
  userStore: UserStore,
  adminEmail: string,
): Promise<AdminSession> {
  if (!stateStore.has(state)) {
    throw new AppError("INVALID_OAUTH_STATE", "OAuth state is invalid or expired", 400);
  }
  stateStore.delete(state);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OIDC_CLIENT_ID,
      client_secret: env.GOOGLE_OIDC_CLIENT_SECRET,
      redirect_uri: new URL("/auth/callback/google", env.DESKTOP_PUBLIC_BASE_URL!).toString(),
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

  const { payload } = await jwtVerify(tokenPayload.id_token, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_OIDC_CLIENT_ID,
  });
  const email = typeof payload.email === "string" ? payload.email : null;
  const subject = typeof payload.sub === "string" ? payload.sub : null;
  if (!email || !subject || payload.email_verified !== true) {
    throw new AppError("UNAUTHORIZED", "Google login did not include a verified email", 401);
  }
  if (email !== adminEmail) {
    throw new AppError("FORBIDDEN", "This account is not authorized for agent-companion", 403);
  }
  userStore.upsertAdmin(email, subject);
  return { email, subject };
}

export async function signSession(session: AdminSession, secret: string) {
  return await new SignJWT({
    email: session.email,
    subject: session.subject,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(encoder.encode(secret));
}

export async function verifySession(token: string | undefined, secret: string): Promise<AdminSession> {
  if (!token) {
    throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  }
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  const email = typeof payload.email === "string" ? payload.email : null;
  const subject = typeof payload.subject === "string" ? payload.subject : null;
  if (!email || !subject) {
    throw new AppError("UNAUTHORIZED", "Session token is invalid", 401);
  }
  return { email, subject };
}

export function writeSessionCookie(res: Response, token: string) {
  res.cookie("agent_companion_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
  });
}
