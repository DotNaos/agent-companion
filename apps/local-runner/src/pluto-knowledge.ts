import { FileBackedStore } from "@agent-companion/shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const memoryEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  createdAt: z.string(),
});

const memoryStoreSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(memoryEntrySchema).default([]),
});

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface SkillDocument extends SkillSummary {
  content: string;
  truncated: boolean;
}

export type ScoredMemoryEntry = z.infer<typeof memoryEntrySchema> & { score: number };

export class PlutoMemoryStore {
  private readonly store: FileBackedStore<z.infer<typeof memoryStoreSchema>>;

  constructor(filePath = defaultMemoryPath()) {
    this.store = new FileBackedStore(filePath, memoryStoreSchema, () => ({
      version: 1,
      entries: [],
    }));
  }

  remember(text: string, tags: string[]) {
    const normalizedText = text.trim();
    const normalizedTags = normalizeTags(tags);
    const existing = this.store
      .read()
      .entries.find((entry) => entry.text.toLowerCase() === normalizedText.toLowerCase());
    if (existing) {
      const updatedTags = Array.from(new Set([...existing.tags, ...normalizedTags]));
      this.store.update((current) => ({
        ...current,
        entries: current.entries.map((entry) =>
          entry.id === existing.id
            ? {
                ...entry,
                tags: updatedTags,
              }
            : entry,
        ),
      }));
      return {
        ...existing,
        tags: updatedTags,
      };
    }

    const entry = memoryEntrySchema.parse({
      id: randomUUID(),
      text: normalizedText,
      tags: normalizedTags,
      createdAt: new Date().toISOString(),
    });
    this.store.update((current) => ({
      ...current,
      entries: [...current.entries, entry].slice(-200),
    }));
    return entry;
  }

  search(query: string, limit: number) {
    const queryTokens = tokenize(query);
    const scored = this.store
      .read()
      .entries.map((entry) => ({
        ...entry,
        score: scoreTextMatch(queryTokens, `${entry.text} ${entry.tags.join(" ")}`),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    return scored.slice(0, limit);
  }
}

export class PlutoSkillRegistry {
  constructor(private readonly roots = defaultSkillRoots()) {}

  list(query?: string, limit = 10) {
    const skills = this.readAllSkills();
    if (!query?.trim()) {
      return skills.slice(0, limit);
    }
    const queryTokens = tokenize(query);
    return skills
      .map((skill) => ({
        ...skill,
        score: scoreTextMatch(queryTokens, `${skill.name} ${skill.description} ${skill.path}`),
      }))
      .filter((skill) => skill.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(({ score: _score, ...skill }) => skill);
  }

  findByName(name: string) {
    const normalized = name.trim().toLowerCase();
    return this.readAllSkills().find((skill) => {
      const base = path.basename(path.dirname(skill.path)).toLowerCase();
      return skill.name.toLowerCase() === normalized || base === normalized;
    });
  }

  read(name: string, maxBytes: number): SkillDocument {
    const match = this.findByName(name);
    if (!match) {
      throw new Error(`Skill not found: ${name}`);
    }
    const raw = fs.readFileSync(match.path, "utf8");
    const truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
    const content = raw.slice(0, maxBytes);
    return {
      ...match,
      content,
      truncated,
    };
  }

  selectRelevant(task: string, preferredSkills: string[], limit = 3) {
    const explicit = preferredSkills
      .map((name) => this.findByName(name))
      .filter((skill): skill is SkillSummary => Boolean(skill));
    if (explicit.length > 0) {
      return dedupeSkills(explicit).slice(0, limit);
    }
    return this.list(task, limit);
  }

  private readAllSkills() {
    const skills: SkillSummary[] = [];
    for (const root of this.roots) {
      for (const skillPath of walkSkillFiles(root)) {
        skills.push(readSkillSummary(skillPath));
      }
    }
    return dedupeSkills(skills).sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 2);
}

function scoreTextMatch(queryTokens: string[], haystack: string) {
  const normalizedHaystack = haystack.toLowerCase();
  return queryTokens.reduce((score, token) => score + (normalizedHaystack.includes(token) ? 1 : 0), 0);
}

function normalizeTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function dedupeSkills(skills: SkillSummary[]) {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.name}:${skill.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readSkillSummary(skillPath: string): SkillSummary {
  const content = fs.readFileSync(skillPath, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const name = /^name:\s*"?(.+?)"?$/m.exec(frontmatter)?.[1]?.trim() || path.basename(path.dirname(skillPath));
  const description =
    /^description:\s*"?(.+?)"?$/m.exec(frontmatter)?.[1]?.trim() || "Installed skill";
  return {
    name,
    description,
    path: skillPath,
  };
}

function* walkSkillFiles(root: string, depth = 0): Generator<string> {
  if (!fs.existsSync(root) || depth > 4) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkSkillFiles(absolutePath, depth + 1);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      yield absolutePath;
    }
  }
}

function defaultSkillRoots() {
  return [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
  ];
}

function defaultMemoryPath() {
  return process.env.PLUTO_MEMORY_PATH ?? path.join(os.homedir(), ".agent-companion", "pluto-memory.json");
}
