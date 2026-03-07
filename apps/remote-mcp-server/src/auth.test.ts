import { describe, expect, it } from "vitest";
import { AppError } from "@agent-companion/shared";
import { verifyGoogleBearerToken } from "./auth.js";
import type { RemoteEnv } from "./env.js";

describe("remote auth", () => {
  it("rejects requests without a bearer token", async () => {
    const env: RemoteEnv = {
      PORT: 8787,
      RUNNER_TOKEN: "runner-token",
      ADMIN_EMAIL: "admin@example.com",
      GOOGLE_ALLOWED_CLIENT_IDS: "client-id",
      GOOGLE_OIDC_CLIENT_ID: "",
      GOOGLE_OIDC_CLIENT_SECRET: "",
      SESSION_SECRET: "super-secret-session-key",
      REMOTE_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      REMOTE_SERVER_URL: "http://127.0.0.1:8787",
      REMOTE_OAUTH_CLIENTS_STORE_PATH: "/tmp/agent-companion-test-remote-oauth-clients.json",
      REQUEST_TIMEOUT_MS: 60_000,
      LOG_LEVEL: "info",
    };

    await expect(verifyGoogleBearerToken(undefined, env)).rejects.toBeInstanceOf(AppError);
  });
});
