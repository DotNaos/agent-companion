import { AppError, toErrorEnvelope } from "@agent-companion/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z, type ZodRawShape } from "zod";
import type { RunnerState } from "./state.js";

const speakToUserInputSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  mode: z.enum(["plain", "summarize"]).default("plain"),
  steer: z.string().trim().max(1_000).optional(),
  kind: z.enum(["final", "progress"]).default("final"),
});

export async function handlePlutoCodexMcpRequest(
  state: RunnerState,
  sessionId: string,
  req: Request,
  res: Response,
) {
  const server = new McpServer({
    name: "pluto-codex-voice",
    version: "0.1.0",
  });

  server.registerTool(
    "speak_to_user",
    {
      description:
        "Speak a Codex-authored reply to the user through Pluto's Gemini voice bridge.",
      inputSchema: speakToUserInputSchema.shape as unknown as ZodRawShape,
    },
    async (payload) => {
      try {
        const result = await state.plutoService.executeVoiceSessionTool(
          sessionId,
          "speak_to_user",
          payload,
          {
            audioEnabled: !state.getConfig().pluto.muted,
          },
        );

        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result.error, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
          structuredContent:
            result.data && typeof result.data === "object"
              ? (result.data as Record<string, unknown>)
              : {},
        };
      } catch (error) {
        const envelope = toErrorEnvelope(error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(envelope, null, 2),
            },
          ],
        };
      }
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    const envelope = toErrorEnvelope(error);
    if (!res.headersSent) {
      res.status(error instanceof AppError ? error.statusCode : 500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: envelope.message,
          data: envelope,
        },
        id: null,
      });
    }
  }
}
