import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRemoteMcpApp } from "./app.js";
import type { RemoteEnv } from "./env.js";

function makeEnv(): RemoteEnv {
  return {
    PORT: 8787,
    RUNNER_TOKEN: "runner-token",
    ADMIN_EMAIL: "admin@example.com",
    GOOGLE_ALLOWED_CLIENT_IDS: "client-id",
    GOOGLE_OIDC_CLIENT_ID: "",
    GOOGLE_OIDC_CLIENT_SECRET: "",
    SESSION_SECRET: "super-secret-session-key",
    REMOTE_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    REMOTE_SERVER_URL: "http://127.0.0.1:8787",
    REMOTE_OAUTH_CLIENTS_STORE_PATH: path.join(
      os.tmpdir(),
      `agent-companion-remote-oauth-clients-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    ),
    REQUEST_TIMEOUT_MS: 60_000,
    LOG_LEVEL: "error",
  };
}

describe("remote MCP OAuth surface", () => {
  it("publishes protected resource metadata", async () => {
    const { app } = createRemoteMcpApp({ env: makeEnv() });

    const response = await request(app).get("/.well-known/oauth-protected-resource");

    expect(response.status).toBe(200);
    expect(response.body.resource).toBe("http://127.0.0.1:8787/");
    expect(response.body.authorization_servers).toEqual(["http://127.0.0.1:8787/"]);
  });

  it("returns an OAuth challenge on unauthenticated MCP requests", async () => {
    const { app } = createRemoteMcpApp({ env: makeEnv() });

    const response = await request(app).post("/mcp").send({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(response.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("accepts runner websocket upgrades with the dedicated runner token header", async () => {
    const { server } = createRemoteMcpApp({ env: makeEnv() });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/runner/connect?runnerId=test-runner`, {
          headers: {
            "x-agent-companion-runner-token": "runner-token",
          },
        });

        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects invalid runner websocket upgrades with a 401 response", async () => {
    const { server } = createRemoteMcpApp({ env: makeEnv() });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const result = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/runner/connect?runnerId=test-runner`, {
          headers: {
            authorization: "Bearer wrong-token",
          },
        });

        ws.on("unexpected-response", (_request, response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        });

        ws.on("open", () => reject(new Error("Expected runner upgrade to be rejected")));
        ws.on("error", () => undefined);
      });

      expect(result.statusCode).toBe(401);
      expect(result.body).toContain("Runner relay authentication failed");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
