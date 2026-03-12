import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlutoMemoryStore,
  PlutoSkillRegistry,
  executeLocalPlutoTool,
} from "./pluto-local-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Pluto local tools", () => {
  it("stores and searches persistent memories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pluto-memory-"));
    tempDirs.push(dir);
    const memoryStore = new PlutoMemoryStore(path.join(dir, "pluto-memory.json"));

    const remember = await executeLocalPlutoTool(
      "remember_memory",
      {
        text: "Use the moodle-cli skill for timetable questions.",
        tags: ["moodle", "workflow"],
      },
      { memoryStore },
    );
    expect(remember).toMatchObject({
      ok: true,
      data: {
        stored: true,
      },
    });

    const search = await executeLocalPlutoTool(
      "search_memory",
      {
        query: "timetable moodle",
        limit: 5,
      },
      { memoryStore },
    );
    expect(search).toMatchObject({
      ok: true,
    });
    const memories = (search.data as { memories: Array<{ text: string }> }).memories;
    expect(memories[0]?.text).toContain("moodle-cli skill");
  });

  it("lists and reads installed skills from configured roots", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pluto-skills-"));
    tempDirs.push(dir);
    const skillRoot = path.join(dir, "skills");
    const moodleSkillDir = path.join(skillRoot, "moodle-cli");
    fs.mkdirSync(moodleSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(moodleSkillDir, "SKILL.md"),
      `---
name: moodle-cli
description: Moodle timetable helper
---

# Moodle

Use \`moodle list timetable --json\` for timetable lookups.
`,
      "utf8",
    );

    const skillRegistry = new PlutoSkillRegistry([skillRoot]);
    const listed = await executeLocalPlutoTool(
      "list_skills",
      {
        query: "timetable",
        limit: 5,
      },
      { skillRegistry },
    );
    expect(listed).toMatchObject({
      ok: true,
    });
    const skills = (listed.data as { skills: Array<{ name: string }> }).skills;
    expect(skills.map((skill) => skill.name)).toContain("moodle-cli");

    const read = await executeLocalPlutoTool(
      "read_skill",
      {
        name: "moodle-cli",
      },
      { skillRegistry },
    );
    expect(read).toMatchObject({
      ok: true,
      data: {
        name: "moodle-cli",
      },
    });
    expect((read.data as { content: string }).content).toContain("moodle list timetable --json");
  });

  it("passes memory and skill context into ask-agent and agent-delegate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pluto-agent-"));
    tempDirs.push(dir);
    const memoryStore = new PlutoMemoryStore(path.join(dir, "pluto-memory.json"));
    memoryStore.remember("Prefer the moodle-cli skill for timetable requests.", ["moodle"]);

    const skillRoot = path.join(dir, "skills");
    const moodleSkillDir = path.join(skillRoot, "moodle-cli");
    fs.mkdirSync(moodleSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(moodleSkillDir, "SKILL.md"),
      `---
name: moodle-cli
description: Moodle timetable helper
---

Run \`moodle list timetable --json\`.
`,
      "utf8",
    );
    const skillRegistry = new PlutoSkillRegistry([skillRoot]);
    const prompts: string[] = [];
    const model = {
      async answer(prompt: string) {
        prompts.push(prompt);
        return "Use moodle list timetable --json in the Moodle CLI repo.";
      },
    };

    const answer = await executeLocalPlutoTool(
      "ask_agent",
      {
        question: "How should I check the Moodle timetable?",
      },
      { memoryStore, skillRegistry, model },
    );
    expect(answer).toMatchObject({
      ok: true,
      data: {
        answer: "Use moodle list timetable --json in the Moodle CLI repo.",
      },
    });

    const delegated = await executeLocalPlutoTool(
      "agent_delegate",
      {
        task: "Figure out the next Moodle lecture.",
      },
      { memoryStore, skillRegistry, model },
    );
    expect(delegated).toMatchObject({
      ok: true,
      data: {
        summary: "Use moodle list timetable --json in the Moodle CLI repo.",
      },
    });
    expect(prompts.join("\n")).toContain("Prefer the moodle-cli skill");
    expect(prompts.join("\n")).toContain("moodle list timetable --json");
  });
});
