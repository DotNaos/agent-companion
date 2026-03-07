import { toolInputSchemas, type ToolName } from "@agent-companion/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { AuthenticatedActor } from "./auth.js";
import type { RelayRegistry } from "./relay-registry.js";

const toolDescriptions: Record<ToolName, string> = {
  health_check: "Return the local runner health status.",
  list_projects: "List projects inside the configured projects root.",
  create_project: "Create a new project folder inside the configured projects root.",
  list_directory: "List directory contents within approved roots.",
  search_files: "Search files inside approved roots.",
  read_file: "Read a file inside approved roots.",
  write_file: "Write a file inside approved roots.",
  start_dev_server: "Start an allowlisted dev server task for an approved project.",
  stop_dev_server: "Stop a managed dev server process.",
  get_logs: "Read recent logs from managed processes.",
  run_repo_task: "Run an allowlisted repository task in an approved path.",
  run_command: "Run an explicitly allowlisted command in an approved path.",
  create_todo_list: "Create a lightweight todo list for multi-step work.",
  update_todo_item: "Update a todo list item.",
  list_todo_items: "List todo lists and items.",
  notify_pluto:
    "Ask Pluto to tell the user something directly, optionally summarizing a longer remote-agent update into a short user-facing message.",
};

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
