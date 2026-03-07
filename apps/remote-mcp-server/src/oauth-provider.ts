import { randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import type { Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
  OAuthTokenVerifier,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AppError, FileBackedStore } from "@agent-companion/shared";
import { z } from "zod";
import { exchangeGoogleCodeForActor, type AuthenticatedActor, verifyGoogleBearerToken } from "./auth.js";
import type { RemoteEnv } from "./env.js";

const clientStoreSchema = z.object({
  version: z.literal(1).default(1),
  clients: z.array(z.record(z.string(), z.unknown())).default([]),
});

type PendingGoogleAuthorization = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scopes: string[];
  state?: string;
  expiresAt: number;
};

type AuthorizationCodeRecord = PendingGoogleAuthorization & {
  actor: AuthenticatedActor;
  expiresAt: number;
};

type AccessTokenRecord = {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  actor: AuthenticatedActor;
  expiresAt: number;
};

type RefreshTokenRecord = {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  actor: AuthenticatedActor;
  expiresAt: number;
};

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class FileBackedOAuthClientsStore {
  private readonly store: FileBackedStore<z.infer<typeof clientStoreSchema>>;

  constructor(filePath: string) {
    this.store = new FileBackedStore(filePath, clientStoreSchema, () => ({
      version: 1,
      clients: [],
    }));
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const current = this.store.read();
    return current.clients.find((client) => client.client_id === clientId) as OAuthClientInformationFull | undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & {
      client_id?: string;
      client_id_issued_at?: number;
    },
  ): Promise<OAuthClientInformationFull> {
    const fullClient = client as OAuthClientInformationFull;
    this.store.update((current) => {
      const existingIndex = current.clients.findIndex((entry) => entry.client_id === fullClient.client_id);
      if (existingIndex >= 0) {
        current.clients[existingIndex] = fullClient as Record<string, unknown>;
      } else {
        current.clients.push(fullClient as Record<string, unknown>);
      }
      return current;
    });
    return fullClient;
  }
}

export class RemoteOAuthProvider implements OAuthServerProvider, OAuthTokenVerifier {
  readonly clientsStore: FileBackedOAuthClientsStore;

  private readonly pendingAuthorizations = new Map<string, PendingGoogleAuthorization>();
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(
    private readonly env: RemoteEnv,
    private readonly acceptedResourceUrls: URL[],
  ) {
    this.clientsStore = new FileBackedOAuthClientsStore(env.REMOTE_OAUTH_CLIENTS_STORE_PATH);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.ensureGoogleOauthConfigured();
    this.ensureAcceptedResource(params.resource);

    const googleState = randomUUID();
    this.pendingAuthorizations.set(googleState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      scopes: params.scopes?.length ? params.scopes : ["mcp:tools"],
      state: params.state,
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    });

    const callbackUrl = new URL("/oauth/callback/google", this.env.REMOTE_PUBLIC_BASE_URL);
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleUrl.searchParams.set("client_id", this.env.GOOGLE_OIDC_CLIENT_ID);
    googleUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", "openid email profile");
    googleUrl.searchParams.set("state", googleState);
    googleUrl.searchParams.set("prompt", "select_account");
    res.redirect(googleUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.cleanup();
    const code = this.authorizationCodes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id) {
      throw new AppError("INVALID_GRANT", "Authorization code is invalid or expired", 400);
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.cleanup();
    const code = this.authorizationCodes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id) {
      throw new AppError("INVALID_GRANT", "Authorization code is invalid or expired", 400);
    }
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new AppError("INVALID_GRANT", "redirect_uri does not match the original authorization request", 400);
    }
    if (resource) {
      this.ensureAcceptedResource(resource);
    }
    this.authorizationCodes.delete(authorizationCode);

    const token = this.issueAccessToken({
      clientId: client.client_id,
      scopes: code.scopes,
      resource: resource?.href ?? code.resource,
      actor: code.actor,
    });
    const refreshToken = this.issueRefreshToken({
      clientId: client.client_id,
      scopes: code.scopes,
      resource: resource?.href ?? code.resource,
      actor: code.actor,
    });

    return {
      access_token: token.token,
      refresh_token: refreshToken.token,
      token_type: "bearer",
      expires_in: Math.floor((token.expiresAt - Date.now()) / 1000),
      scope: token.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.cleanup();
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new AppError("INVALID_GRANT", "Refresh token is invalid or expired", 400);
    }
    if (resource) {
      this.ensureAcceptedResource(resource);
    }

    const effectiveScopes = scopes?.length ? scopes.filter((scope) => record.scopes.includes(scope)) : record.scopes;
    const nextToken = this.issueAccessToken({
      clientId: client.client_id,
      scopes: effectiveScopes,
      resource: resource?.href ?? record.resource,
      actor: record.actor,
    });

    return {
      access_token: nextToken.token,
      refresh_token: record.token,
      token_type: "bearer",
      expires_in: Math.floor((nextToken.expiresAt - Date.now()) / 1000),
      scope: nextToken.scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.cleanup();
    const record = this.accessTokens.get(token);
    if (!record || record.expiresAt <= Date.now()) {
      throw new AppError("UNAUTHORIZED", "Access token is invalid or expired", 401);
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: {
        email: record.actor.email,
        subject: record.actor.subject,
      },
    };
  }

  async handleGoogleCallback(code: string, googleState: string): Promise<URL> {
    this.cleanup();
    const pending = this.pendingAuthorizations.get(googleState);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new AppError("INVALID_OAUTH_STATE", "OAuth state is invalid or expired", 400);
    }
    this.pendingAuthorizations.delete(googleState);

    const callbackUrl = new URL("/oauth/callback/google", this.env.REMOTE_PUBLIC_BASE_URL).toString();
    const actor = await exchangeGoogleCodeForActor(code, callbackUrl, this.env);

    const authorizationCode = randomUUID();
    this.authorizationCodes.set(authorizationCode, {
      ...pending,
      actor,
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    });

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", authorizationCode);
    if (pending.state) {
      redirectUrl.searchParams.set("state", pending.state);
    }
    return redirectUrl;
  }

  async verifyIncomingBearerToken(token: string): Promise<AuthInfo> {
    try {
      return await this.verifyAccessToken(token);
    } catch {
      const actor = await verifyGoogleBearerToken(`Bearer ${token}`, this.env);
      return {
        token,
        clientId: "google-direct",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        extra: {
          email: actor.email,
          subject: actor.subject,
        },
      };
    }
  }

  private issueAccessToken(input: {
    clientId: string;
    scopes: string[];
    resource?: string;
    actor: AuthenticatedActor;
  }): AccessTokenRecord {
    const token = randomUUID();
    const record: AccessTokenRecord = {
      token,
      clientId: input.clientId,
      scopes: input.scopes,
      resource: input.resource,
      actor: input.actor,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
    this.accessTokens.set(token, record);
    return record;
  }

  private issueRefreshToken(input: {
    clientId: string;
    scopes: string[];
    resource?: string;
    actor: AuthenticatedActor;
  }): RefreshTokenRecord {
    const token = randomUUID();
    const record: RefreshTokenRecord = {
      token,
      clientId: input.clientId,
      scopes: input.scopes,
      resource: input.resource,
      actor: input.actor,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    };
    this.refreshTokens.set(token, record);
    return record;
  }

  private ensureGoogleOauthConfigured() {
    if (!this.env.GOOGLE_OIDC_CLIENT_ID || !this.env.GOOGLE_OIDC_CLIENT_SECRET) {
      throw new AppError("OAUTH_NOT_CONFIGURED", "Google OAuth is not configured for the remote MCP server", 500);
    }
  }

  private ensureAcceptedResource(resource: URL | undefined) {
    if (!resource) {
      return;
    }
    const normalizedResource = normalizeUrl(resource.href);
    const allowed = this.acceptedResourceUrls.some((candidate) => normalizeUrl(candidate.href) === normalizedResource);
    if (!allowed) {
      throw new AppError("INVALID_RESOURCE", "The requested OAuth resource is not allowed for this MCP server", 400);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [state, pending] of this.pendingAuthorizations.entries()) {
      if (pending.expiresAt <= now) {
        this.pendingAuthorizations.delete(state);
      }
    }
    for (const [code, authorization] of this.authorizationCodes.entries()) {
      if (authorization.expiresAt <= now) {
        this.authorizationCodes.delete(code);
      }
    }
    for (const [token, record] of this.accessTokens.entries()) {
      if (record.expiresAt <= now) {
        this.accessTokens.delete(token);
      }
    }
    for (const [token, record] of this.refreshTokens.entries()) {
      if (record.expiresAt <= now) {
        this.refreshTokens.delete(token);
      }
    }
  }
}

export function buildOauthErrorRedirect(targetUrl: string, error: string, description: string, state?: string) {
  const redirectUrl = new URL(targetUrl);
  redirectUrl.searchParams.set("error", error);
  redirectUrl.searchParams.set("error_description", description);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }
  return redirectUrl;
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return `${url.origin}${url.pathname}`;
}
