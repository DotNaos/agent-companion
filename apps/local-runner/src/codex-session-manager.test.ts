import { describe, expect, it } from "vitest";
import { buildCodexEnvironment } from "./codex-session-manager.js";

describe("buildCodexEnvironment", () => {
  it("removes Codex API keys so the local ChatGPT login is used", () => {
    const env = buildCodexEnvironment({
      PATH: "/usr/bin",
      GEMINI_API_KEY: "gemini-key",
      OPENAI_API_KEY: "openai-key",
      CODEX_API_KEY: "codex-key",
      CODEX_HOME: "/tmp/codex-home",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      GEMINI_API_KEY: "gemini-key",
      CODEX_HOME: "/tmp/codex-home",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });
});
