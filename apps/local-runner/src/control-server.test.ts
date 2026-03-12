import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { startControlServer } from "./control-server.js";
import type { RunnerEnv } from "./env.js";
import { RunnerState } from "./state.js";

function decodeWebSocketMessage(data: RawData) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Buffer) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

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

  it("streams a session snapshot and returns a voice-stream error when Gemini is unavailable", async () => {
    const ctx = createContext();
    const server = await startControlServer(ctx.state, 0);

    try {
      const created = ctx.state.createPlutoVoiceSession({
        title: "WS Pluto",
        client: {
          label: "Desktop",
          requestedRole: "speaker",
        },
      });

      const received: Array<Record<string, unknown>> = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${server.port}/internal/pluto/sessions/${created.session.id}/stream`,
        );

        ws.on("message", (data) => {
          received.push(JSON.parse(decodeWebSocketMessage(data)) as Record<string, unknown>);
          if (received.length === 1) {
            ws.send(
              JSON.stringify({
                type: "audio_chunk",
                chunk: {
                  clientId: created.client!.id,
                  audioBase64: "ZmFrZQ==",
                  mimeType: "audio/pcm;rate=16000",
                },
              }),
            );
            return;
          }

          if (received.some((entry) => entry.type === "error")) {
            ws.close();
            resolve();
          }
        });

        ws.on("error", reject);
      });

      expect(received[0]).toMatchObject({
        type: "session_snapshot",
      });
      expect(received.some((entry) => entry.type === "error")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns persisted Pluto session history over HTTP", async () => {
    const ctx = createContext();
    const server = await startControlServer(ctx.state, 0);

    try {
      const created = ctx.state.createPlutoVoiceSession({
        title: "History Pluto",
        client: {
          label: "Desktop",
          requestedRole: "speaker",
        },
      });

      await expect(
        ctx.state.sendPlutoVoiceSessionText(created.session.id, {
          clientId: created.client!.id,
          text: "Was gibt's Neues?",
        }),
      ).rejects.toMatchObject({ code: "PLUTO_VOICE_TEXT_SEND_FAILED" });

      const historyResponse = await fetch(
        `http://127.0.0.1:${server.port}/internal/pluto/sessions/${created.session.id}/history?limit=10`,
      );

      expect(historyResponse.status).toBe(200);
      const history = await historyResponse.json();
      expect(history).toMatchObject({
        sessionId: created.session.id,
      });
      expect(history.entries).toHaveLength(2);
      expect(history.entries[0]).toMatchObject({
        kind: "text_input",
        text: "Was gibt's Neues?",
      });
      expect(history.entries[1]).toMatchObject({
        kind: "stream_event",
        event: {
          type: "error",
          code: "PLUTO_VOICE_TEXT_SEND_FAILED",
        },
      });
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
    LOG_LEVEL: "error",
    GEMINI_API_KEY: "",
    PLUTO_MODEL: "models/gemini-2.5-flash-native-audio-preview-12-2025",
    PLUTO_CODEX_MODEL: "gpt-5.4",
    PLUTO_CODEX_WORKING_DIRECTORY: process.cwd(),
    PLUTO_VOICE_NAME: "Achird",
    LOCAL_RUNNER_PORT: 4317,
    DESKTOP_SERVER_PORT: 4318,
    CONFIG_PATH: path.join(dir, "config.json"),
    TODO_STORE_PATH: path.join(dir, "todos.json"),
    ACTIVITY_LOG_PATH: path.join(dir, "activity.log"),
    PLUTO_AUDIO_DIR: path.join(dir, "pluto-audio"),
    PLUTO_HISTORY_STORE_PATH: path.join(dir, "pluto-history.json"),
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
