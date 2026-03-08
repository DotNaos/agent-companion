import { toolDescriptions, toolInputSchemas, type ToolName } from "@agent-companion/shared";
import type { FunctionCall, FunctionDeclaration, FunctionResponse } from "@google/genai";
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
  return (Object.keys(toolInputSchemas) as ToolName[]).map((toolName) => ({
    name: toolName,
    description: toolDescriptions[toolName],
    parametersJsonSchema: toJSONSchema(toolInputSchemas[toolName], {
      target: "draft-7",
      io: "input",
    }) as Record<string, unknown>,
  }));
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
    if (!toolName || !(toolName in toolInputSchemas)) {
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

    const result = await executeTool(
      toolName as ToolName,
      functionCall.args ?? {},
      {
        toolCallId: functionCall.id ?? null,
      },
    );
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
