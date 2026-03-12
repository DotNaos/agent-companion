import type { FunctionDeclaration } from "@google/genai";
import { GoogleGenAI } from "@google/genai";
import { z, toJSONSchema } from "zod";
import { logger } from "./logger.js";
import {
  PlutoMemoryStore,
  PlutoSkillRegistry,
  type ScoredMemoryEntry,
  type SkillSummary,
} from "./pluto-knowledge.js";

const localPlutoToolInputSchemas = {
  ask_agent: z.object({
    question: z.string().trim().min(1).max(4_000),
    context: z.string().max(12_000).optional(),
    preferredSkills: z.array(z.string().min(1).max(120)).max(8).default([]),
    includeMemory: z.boolean().default(true),
  }),
  agent_delegate: z.object({
    task: z.string().trim().min(1).max(4_000),
    context: z.string().max(12_000).optional(),
    successCriteria: z.string().max(2_000).optional(),
    preferredSkills: z.array(z.string().min(1).max(120)).max(8).default([]),
    includeMemory: z.boolean().default(true),
  }),
  remember_memory: z.object({
    text: z.string().trim().min(1).max(1_000),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  }),
  search_memory: z.object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().positive().max(10).default(5),
  }),
  list_skills: z.object({
    query: z.string().trim().max(120).optional(),
    limit: z.number().int().positive().max(20).default(10),
  }),
  read_skill: z.object({
    name: z.string().trim().min(1).max(120),
    maxBytes: z.number().int().positive().max(24_000).default(8_000),
  }),
} as const;

const localPlutoToolDescriptions: Record<LocalPlutoToolName, string> = {
  ask_agent:
    "Ask a specialist sub-agent to answer a question for Pluto, optionally using persistent memory and installed skills.",
  agent_delegate:
    "Delegate a task to a specialist sub-agent so Pluto gets a concrete plan, commands, or next actions to follow.",
  remember_memory:
    "Store a durable Pluto memory such as a user preference, recurring workflow, or stable instruction.",
  search_memory:
    "Search Pluto's durable memory for relevant prior preferences, routines, or instructions.",
  list_skills:
    "List installed SKILL.md workflows Pluto can use for domain-specific tasks.",
  read_skill:
    "Read an installed SKILL.md so Pluto can follow its workflow exactly.",
};

type LocalPlutoToolName = keyof typeof localPlutoToolInputSchemas;
type LocalToolResult = {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

interface PlutoSubAgentModel {
  answer(prompt: string): Promise<string>;
}

export { PlutoMemoryStore, PlutoSkillRegistry } from "./pluto-knowledge.js";

export function isLocalPlutoToolName(name: string): name is LocalPlutoToolName {
  return name in localPlutoToolInputSchemas;
}

export function buildLocalPlutoToolDeclarations(): FunctionDeclaration[] {
  return (Object.keys(localPlutoToolInputSchemas) as LocalPlutoToolName[]).map((toolName) => ({
    name: toolName,
    description: localPlutoToolDescriptions[toolName],
    parametersJsonSchema: toJSONSchema(localPlutoToolInputSchemas[toolName], {
      target: "draft-7",
      io: "input",
    }) as Record<string, unknown>,
  }));
}

export async function executeLocalPlutoTool(
  toolName: LocalPlutoToolName,
  payload: unknown,
  services: {
    memoryStore?: PlutoMemoryStore;
    skillRegistry?: PlutoSkillRegistry;
    model?: PlutoSubAgentModel | null;
  } = {},
): Promise<LocalToolResult> {
  const memoryStore = services.memoryStore ?? defaultMemoryStore;
  const skillRegistry = services.skillRegistry ?? defaultSkillRegistry;
  const model = services.model ?? createDefaultSubAgentModel();

  try {
    switch (toolName) {
      case "remember_memory": {
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        return { ok: true, data: { stored: true, entry: memoryStore.remember(input.text, input.tags) } };
      }
      case "search_memory": {
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        return { ok: true, data: { memories: memoryStore.search(input.query, input.limit) } };
      }
      case "list_skills": {
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        return { ok: true, data: { skills: skillRegistry.list(input.query, input.limit) } };
      }
      case "read_skill": {
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        return { ok: true, data: skillRegistry.read(input.name, input.maxBytes) };
      }
      case "ask_agent": {
        if (!model) {
          return unavailableSubAgentResult();
        }
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        const memoryHits = input.includeMemory ? memoryStore.search(input.question, 5) : [];
        const usedSkills = skillRegistry.selectRelevant(input.question, input.preferredSkills);
        return {
          ok: true,
          data: {
            answer: await model.answer(buildAskAgentPrompt(input.question, input.context, memoryHits, usedSkills, skillRegistry)),
            memoryHits,
            usedSkills,
          },
        };
      }
      case "agent_delegate": {
        if (!model) {
          return unavailableSubAgentResult();
        }
        const input = localPlutoToolInputSchemas[toolName].parse(payload);
        const memoryHits = input.includeMemory ? memoryStore.search(input.task, 5) : [];
        const usedSkills = skillRegistry.selectRelevant(input.task, input.preferredSkills);
        return {
          ok: true,
          data: {
            summary: await model.answer(
              buildAgentDelegatePrompt(input.task, input.context, input.successCriteria, memoryHits, usedSkills, skillRegistry),
            ),
            memoryHits,
            usedSkills,
          },
        };
      }
    }
  } catch (error) {
    logger.warn(
      {
        toolName,
        err: error instanceof Error ? error : undefined,
      },
      "pluto_local_tool_failed",
    );
    return {
      ok: false,
      error: {
        code: "PLUTO_LOCAL_TOOL_FAILED",
        message: error instanceof Error ? error.message : `Local Pluto tool failed: ${toolName}`,
      },
    };
  }
}

function buildAskAgentPrompt(
  question: string,
  context: string | undefined,
  memoryHits: ScoredMemoryEntry[],
  skills: SkillSummary[],
  registry: PlutoSkillRegistry,
) {
  return [
    "You are a specialist sub-agent helping Pluto answer a user question.",
    "Answer concisely, factually, and in a way Pluto can immediately relay or act on.",
    "If a skill is relevant, follow it strictly.",
    renderMemorySection(memoryHits),
    renderSkillSection(skills, registry),
    `Question: ${question}`,
    context ? `Context:\n${context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildAgentDelegatePrompt(
  task: string,
  context: string | undefined,
  successCriteria: string | undefined,
  memoryHits: ScoredMemoryEntry[],
  skills: SkillSummary[],
  registry: PlutoSkillRegistry,
) {
  return [
    "You are a delegated specialist sub-agent helping Pluto complete a task.",
    "You cannot directly execute tools, so produce the exact next actions Pluto should take.",
    "Be concrete. Include commands, files, or checks when they are obvious.",
    "Keep the response short and structured for execution, not discussion.",
    renderMemorySection(memoryHits),
    renderSkillSection(skills, registry),
    `Task: ${task}`,
    context ? `Context:\n${context}` : "",
    successCriteria ? `Success criteria:\n${successCriteria}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderMemorySection(memoryHits: ScoredMemoryEntry[]) {
  if (memoryHits.length === 0) {
    return "";
  }
  return `Relevant memory:\n${memoryHits
    .map((entry) => `- ${entry.text}${entry.tags.length > 0 ? ` [tags: ${entry.tags.join(", ")}]` : ""}`)
    .join("\n")}`;
}

function renderSkillSection(skills: SkillSummary[], registry: PlutoSkillRegistry) {
  if (skills.length === 0) {
    return "";
  }
  return `Relevant skills:\n${skills
    .map((skill) => {
      const document = registry.read(skill.name, 6_000);
      return `Skill ${skill.name}: ${skill.description}\n${document.content}`;
    })
    .join("\n\n")}`;
}

function createDefaultSubAgentModel(): PlutoSubAgentModel | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const ai = new GoogleGenAI({ apiKey });
  return {
    async answer(prompt: string) {
      const response = await ai.models.generateContent({
        model: resolveSubAgentModel(process.env.PLUTO_MODEL),
        contents: prompt,
      });
      const text = extractText(response);
      if (!text) {
        throw new Error("Sub-agent returned no text");
      }
      return text;
    },
  };
}

function resolveSubAgentModel(modelName: string | undefined) {
  const normalized = (modelName ?? "gemini-2.5-flash").replace(/^models\//, "");
  return normalized.includes("native-audio") || normalized.includes("live") ? "gemini-2.5-flash" : normalized;
}

function extractText(response: { text?: string | null; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) {
  if (typeof response.text === "string" && response.text.trim().length > 0) {
    return response.text.trim();
  }
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text.trim();
      }
    }
  }
  return "";
}

function unavailableSubAgentResult(): LocalToolResult {
  return {
    ok: false,
    error: {
      code: "PLUTO_SUBAGENT_UNAVAILABLE",
      message: "Gemini is not configured, so Pluto cannot start a sub-agent right now.",
    },
  };
}

const defaultMemoryStore = new PlutoMemoryStore();
const defaultSkillRegistry = new PlutoSkillRegistry();
