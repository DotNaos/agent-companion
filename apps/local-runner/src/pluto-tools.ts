import { toolDescriptions, toolInputSchemas, type ToolName } from "@agent-companion/shared";
import type { FunctionCall, FunctionDeclaration, FunctionResponse } from "@google/genai";
import {
  buildLocalPlutoToolDeclarations,
  executeLocalPlutoTool,
  isLocalPlutoToolName,
} from "./pluto-local-tools.js";
import { toJSONSchema } from "zod";

export interface PlutoToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type PlutoToolExecutor = (
  toolName: ToolName,
  payload: unknown,
  context?: {
    sessionId?: string;
    toolCallId?: string | null;
  },
) => Promise<PlutoToolExecutionResult>;

export interface PlutoExecutedFunctionCall {
  functionCall: FunctionCall;
  result: PlutoToolExecutionResult;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaped) {
    current += "\\";
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeToolPayload(toolName: ToolName, payload: unknown): unknown {
  if (
    toolName !== "run_command" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const normalizedPayload: Record<string, unknown> = { ...record };

  if (
    typeof normalizedPayload.workingDirectory !== "string" &&
    typeof normalizedPayload.path === "string"
  ) {
    normalizedPayload.workingDirectory = normalizedPayload.path;
  }

  if (typeof normalizedPayload.command === "string") {
    normalizedPayload.command = tokenizeCommand(normalizedPayload.command);
  }

  return normalizedPayload;
}

function toFunctionResponsePayload(result: PlutoToolExecutionResult): Record<string, unknown> {
  if (result.ok) {
    return {
      ok: true,
      data: result.data ?? null,
    };
  }

  return {
    ok: false,
    error: result.error ?? {
      code: "TOOL_EXECUTION_FAILED",
      message: "Tool failed without an error envelope",
    },
  };
}

export function buildPlutoToolDeclarations(): FunctionDeclaration[] {
  return [
    ...(Object.keys(toolInputSchemas) as ToolName[]).map((toolName) => ({
      name: toolName,
      description: toolDescriptions[toolName],
      parametersJsonSchema: toJSONSchema(toolInputSchemas[toolName], {
        target: "draft-7",
        io: "input",
      }) as Record<string, unknown>,
    })),
    ...buildLocalPlutoToolDeclarations(),
  ];
}

export async function executePlutoFunctionCalls(
  functionCalls: FunctionCall[],
  executeTool: PlutoToolExecutor,
): Promise<{
  responses: FunctionResponse[];
  executions: PlutoExecutedFunctionCall[];
}> {
  const responses: FunctionResponse[] = [];
  const executions: PlutoExecutedFunctionCall[] = [];

  for (const functionCall of functionCalls) {
    const toolName = functionCall.name;
    if (!toolName) {
      const result: PlutoToolExecutionResult = {
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: `Pluto cannot execute the requested tool: ${toolName ?? "unknown"}`,
        },
      };
      executions.push({ functionCall, result });
      responses.push({
        id: functionCall.id,
        name: toolName ?? "unknown_tool",
        response: toFunctionResponsePayload(result),
      });
      continue;
    }

    let result: PlutoToolExecutionResult;
    if (isLocalPlutoToolName(toolName)) {
      result = await executeLocalPlutoTool(toolName, functionCall.args ?? {});
    } else if (toolName in toolInputSchemas) {
      const normalizedPayload = normalizeToolPayload(
        toolName as ToolName,
        functionCall.args ?? {},
      );
      result = await executeTool(
        toolName as ToolName,
        normalizedPayload,
        {
          toolCallId: functionCall.id ?? null,
        },
      );
    } else {
      result = {
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: `Pluto cannot execute the requested tool: ${toolName}`,
        },
      };
    }
    executions.push({ functionCall, result });
    responses.push({
      id: functionCall.id,
      name: toolName,
      response: toFunctionResponsePayload(
        result.ok
          ? result
          : {
              ...result,
              error: result.error ?? {
                code: "TOOL_EXECUTION_FAILED",
                message: `${toolName} failed without an error envelope`,
              },
            },
      ),
    });
  }

  return {
    responses,
    executions,
  };
}
