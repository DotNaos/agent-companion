import { toolDescriptions, toolInputSchemas, type ToolName } from "@agent-companion/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { AuthenticatedActor } from "./auth.js";
import type { RelayRegistry } from "./relay-registry.js";

export function createMcpToolServer(relayRegistry: RelayRegistry, actor: AuthenticatedActor) {
  const server = new McpServer({
    name: "agent-companion-remote-mcp",
    version: "0.1.0",
  });

  const securitySchemes = [{ type: "oauth2", scopes: ["mcp:tools"] }];

  (Object.keys(toolInputSchemas) as ToolName[]).forEach((toolName) => {
    server.registerTool(
      toolName,
      {
        description: toolDescriptions[toolName],
        inputSchema: toolInputSchemas[toolName] as unknown as ZodRawShape,
        _meta: {
          securitySchemes,
        },
      },
      async (payload) => {
        const result = await relayRegistry.dispatch({
          toolName,
          payload,
          actor,
        });

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
      },
    );
  });

  return server;
}
