import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import {
  DEFAULT_ACTIVITY_LIMIT,
  approvalDecisionSchema,
  agentCompanionConfigSchema,
} from "@agent-companion/shared";
import type { RunnerState } from "./state.js";

export async function startControlServer(state: RunnerState, port: number) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

    const onStatus = (data: unknown) => ws.send(JSON.stringify({ type: "status", data }));
    const onActivity = (data: unknown) => ws.send(JSON.stringify({ type: "activity", data }));
    const onApproval = (data: unknown) => ws.send(JSON.stringify({ type: "approvals", data }));
    const onConfig = (data: unknown) => ws.send(JSON.stringify({ type: "config", data }));

    state.events.on("status", onStatus);
    state.events.on("activity", onActivity);
    state.events.on("approval", onApproval);
    state.events.on("config", onConfig);

    ws.on("close", () => {
      state.events.off("status", onStatus);
      state.events.off("activity", onActivity);
      state.events.off("approval", onApproval);
      state.events.off("config", onConfig);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    close: async () => {
      wsServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
