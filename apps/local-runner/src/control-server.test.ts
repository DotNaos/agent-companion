import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlServer } from "./control-server.js";
import type { RunnerEnv } from "./env.js";
import { RunnerState } from "./state.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("control server Pluto voice sessions", () => {
  it("creates, lists, attaches and closes Pluto voice sessions over HTTP", async () => {
    const ctx = createContext();
    const server = await startControlServer(ctx.state, 0);

    try {
      const createdResponse = await fetch(`http://127.0.0.1:${server.port}/internal/pluto/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "HTTP Pluto",
          client: {
            label: "Desktop",
            requestedRole: "speaker",
          },
        }),
      });

      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      expect(created.session.title).toBe("HTTP Pluto");

      const listResponse = await fetch(`http://127.0.0.1:${server.port}/internal/pluto/sessions`);
      const listed = await listResponse.json();
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({
        id: created.session.id,
        status: "idle",
      });

      const attachResponse = await fetch(
        `http://127.0.0.1:${server.port}/internal/pluto/sessions/${created.session.id}/attach`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "iPhone",
            platform: "iOS",
            requestedRole: "observer",
          }),
        },
      );
      const attached = await attachResponse.json();
      expect(attached.client).toMatchObject({
        label: "iPhone",
        canSendAudio: false,
      });
      expect(attached.session.clients).toHaveLength(2);

      const closeResponse = await fetch(
        `http://127.0.0.1:${server.port}/internal/pluto/sessions/${created.session.id}/close`,
        {
          method: "POST",
        },
      );
      expect(closeResponse.status).toBe(200);
      await closeResponse.json();

      const emptyListResponse = await fetch(`http://127.0.0.1:${server.port}/internal/pluto/sessions`);
      const emptyList = await emptyListResponse.json();
      expect(emptyList.sessions).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-companion-control-"));
  tempDirs.push(dir);

  const env: RunnerEnv = {
    REMOTE_SERVER_URL: "http://127.0.0.1:8787",
    RUNNER_TOKEN: "runner-token",
    RUNNER_ID: "runner-1",
    GEMINI_API_KEY: "",
    PLUTO_MODEL: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    PLUTO_VOICE_NAME: "Achird",
    LOCAL_RUNNER_PORT: 4317,
    DESKTOP_SERVER_PORT: 4318,
    CONFIG_PATH: path.join(dir, "config.json"),
    TODO_STORE_PATH: path.join(dir, "todos.json"),
    ACTIVITY_LOG_PATH: path.join(dir, "activity.log"),
    PLUTO_AUDIO_DIR: path.join(dir, "pluto-audio"),
    DEFAULT_ADMIN_EMAIL: "admin@example.com",
    DEFAULT_ALLOWED_ORIGINS: "https://admin.example.com",
    DEFAULT_GOOGLE_CLIENT_IDS: "client-id",
    DEFAULT_COMMAND_TIMEOUT_MS: 10_000,
    DEFAULT_OUTPUT_LIMIT_BYTES: 10_000,
  };

  return {
    state: new RunnerState(env),
  };
}
