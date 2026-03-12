import { TOOL_NAMES } from "@agent-companion/shared";
import { describe, expect, it, vi } from "vitest";
import {
    buildPlutoToolDeclarations,
    executePlutoFunctionCalls,
} from "./pluto-tools.js";

describe("buildPlutoToolDeclarations", () => {
  it("exports the shared runner tools as Gemini function declarations", () => {
    const declarations = buildPlutoToolDeclarations();

    expect(declarations.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([...TOOL_NAMES, "ask_agent", "agent_delegate", "remember_memory", "search_memory", "list_skills", "read_skill"]),
    );
    expect(declarations.find((entry) => entry.name === "read_file")).toMatchObject({
      description: expect.stringContaining("Read a file"),
      parametersJsonSchema: {
        type: "object",
        properties: expect.objectContaining({
          path: expect.any(Object),
          maxBytes: expect.any(Object),
        }),
      },
    });
  });
});

describe("executePlutoFunctionCalls", () => {
  it("wraps successful tool results in Gemini function responses", async () => {
    const executeTool = vi.fn(async () => ({
      ok: true,
      data: { content: "hello" },
    }));

    const { responses, executions } = await executePlutoFunctionCalls(
      [
        {
          id: "call-1",
          name: "read_file",
          args: { path: "/tmp/hello.txt" },
        },
      ],
      executeTool,
    );

    expect(executeTool).toHaveBeenCalledWith(
      "read_file",
      { path: "/tmp/hello.txt" },
      { toolCallId: "call-1" },
    );
    expect(executions).toHaveLength(1);
    expect(executions[0]?.result).toMatchObject({ ok: true });
    expect(responses).toEqual([
      {
        id: "call-1",
        name: "read_file",
        response: {
          ok: true,
          data: { content: "hello" },
        },
      },
    ]);
  });

  it("normalizes legacy Pluto run_command payloads before execution", async () => {
    const executeTool = vi.fn(async () => ({
      ok: true,
      data: {
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        approvedViaRule: "moodle-cli",
      },
    }));

    await executePlutoFunctionCalls(
      [
        {
          id: "call-legacy-run-command",
          name: "run_command",
          args: {
            command: "./moodle list timetable --json",
            path: "/Users/oli/projects/moodle/moodle-cli",
          },
        },
      ],
      executeTool,
    );

    expect(executeTool).toHaveBeenCalledWith(
      "run_command",
      {
        command: ["./moodle", "list", "timetable", "--json"],
        path: "/Users/oli/projects/moodle/moodle-cli",
        workingDirectory: "/Users/oli/projects/moodle/moodle-cli",
      },
      { toolCallId: "call-legacy-run-command" },
    );
  });

  it("returns an error envelope for unknown tools without calling the executor", async () => {
    const executeTool = vi.fn();

    const { responses, executions } = await executePlutoFunctionCalls(
      [
        {
          id: "call-2",
          name: "definitely_not_a_real_tool",
          args: {},
        },
      ],
      executeTool,
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(executions).toHaveLength(1);
    expect(executions[0]?.result).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" },
    });
    expect(responses).toEqual([
      {
        id: "call-2",
        name: "definitely_not_a_real_tool",
        response: {
          ok: false,
          error: {
            code: "UNKNOWN_TOOL",
            message: "Pluto cannot execute the requested tool: definitely_not_a_real_tool",
          },
        },
      },
    ]);
  });
});
