import {
    DEFAULT_ACTIVITY_LIMIT,
    agentCompanionConfigSchema,
    approvalDecisionSchema,
    plutoVoiceSessionAttachInputSchema,
    plutoVoiceSessionCreateInputSchema,
    plutoVoiceSessionDetachInputSchema,
} from "@agent-companion/shared";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { RunnerState } from "./state.js";

export async function startControlServer(state: RunnerState, port: number) {
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  app.get("/internal/status", (_req, res) => {
    res.json(state.getStatus());
  });

  app.get("/internal/config", (_req, res) => {
    res.json(state.getConfig());
  });

  app.put("/internal/config", (req, res) => {
    const config = agentCompanionConfigSchema.parse(req.body);
    res.json(state.updateConfig(config));
  });

  app.get("/internal/activity", (req, res) => {
    const limit = Number(req.query.limit ?? DEFAULT_ACTIVITY_LIMIT);
    res.json({ entries: state.listActivity(limit) });
  });

  app.get("/internal/approvals", (_req, res) => {
    res.json({ approvals: state.listApprovals() });
  });

  app.get("/internal/pluto", (_req, res) => {
    res.json(state.getPlutoState());
  });

  app.get("/internal/pluto/audio/:messageId", (req, res) => {
    const audio = state.getPlutoAudio(req.params.messageId);
    if (!audio) {
      res.status(404).json({ error: "Pluto audio not found" });
      return;
    }
    res.type(audio.contentType).send(audio.buffer);
  });

  app.post("/internal/pluto/commentary", async (req, res) => {
    res.json(await state.createPlutoCommentary(req.body));
  });

  app.get("/internal/pluto/sessions", (_req, res) => {
    res.json({ sessions: state.listPlutoVoiceSessions() });
  });

  app.get("/internal/pluto/sessions/:sessionId", (req, res) => {
    res.json({ session: state.getPlutoVoiceSession(req.params.sessionId) });
  });

  app.post("/internal/pluto/sessions", (req, res) => {
    const input = plutoVoiceSessionCreateInputSchema.parse(req.body ?? {});
    res.status(201).json(state.createPlutoVoiceSession(input));
  });

  app.post("/internal/pluto/sessions/:sessionId/attach", (req, res) => {
    const input = plutoVoiceSessionAttachInputSchema.parse(req.body ?? {});
    res.json(state.attachPlutoVoiceSession(req.params.sessionId, input));
  });

  app.post("/internal/pluto/sessions/:sessionId/detach", (req, res) => {
    const input = plutoVoiceSessionDetachInputSchema.parse(req.body ?? {});
    res.json(state.detachPlutoVoiceSession(req.params.sessionId, input.clientId));
  });

  app.post("/internal/pluto/sessions/:sessionId/close", (req, res) => {
    res.json(state.closePlutoVoiceSession(req.params.sessionId));
  });

  app.post("/internal/approvals/decision", async (req, res) => {
    const decision = approvalDecisionSchema.parse(req.body);
    const result = await state.applyApprovalDecision(decision);
    res.json(result);
  });

  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/internal/stream") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws);
    });
  });

  wsServer.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "status", data: state.getStatus() }));
    ws.send(JSON.stringify({ type: "activity_snapshot", data: state.listActivity(DEFAULT_ACTIVITY_LIMIT) }));
    ws.send(JSON.stringify({ type: "approvals", data: state.listApprovals() }));
    ws.send(JSON.stringify({ type: "pluto", data: state.getPlutoState() }));
    ws.send(JSON.stringify({ type: "pluto_voice_sessions", data: state.listPlutoVoiceSessions() }));

    const onStatus = (data: unknown) => ws.send(JSON.stringify({ type: "status", data }));
    const onActivity = (data: unknown) => ws.send(JSON.stringify({ type: "activity", data }));
    const onApproval = (data: unknown) => ws.send(JSON.stringify({ type: "approvals", data }));
    const onConfig = (data: unknown) => ws.send(JSON.stringify({ type: "config", data }));
    const onPluto = (data: unknown) => ws.send(JSON.stringify({ type: "pluto", data }));
    const onPlutoVoiceSessions = (data: unknown) => ws.send(JSON.stringify({ type: "pluto_voice_sessions", data }));

    state.events.on("status", onStatus);
    state.events.on("activity", onActivity);
    state.events.on("approval", onApproval);
    state.events.on("config", onConfig);
    state.events.on("pluto", onPluto);
    state.events.on("pluto_voice_sessions", onPlutoVoiceSessions);

    ws.on("close", () => {
      state.events.off("status", onStatus);
      state.events.off("activity", onActivity);
      state.events.off("approval", onApproval);
      state.events.off("config", onConfig);
      state.events.off("pluto", onPluto);
      state.events.off("pluto_voice_sessions", onPlutoVoiceSessions);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    app,
    port: actualPort,
    server,
    close: async () => {
      wsServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
