import {
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_DESKTOP_SERVER_PORT,
    DEFAULT_LOCAL_RUNNER_PORT,
    DEFAULT_OUTPUT_LIMIT_BYTES,
} from "@agent-companion/shared";
import { parse as parseDotenv } from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  REMOTE_SERVER_URL: z.string().url().default("http://127.0.0.1:8787"),
  RUNNER_TOKEN: z.string().min(1).default("change-me-runner-token"),
  RUNNER_ID: z.string().min(1).default(os.hostname()),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  GEMINI_API_KEY: z.string().default(""),
  PLUTO_MODEL: z.string().min(1).default("models/gemini-2.5-flash-native-audio-preview-12-2025"),
  PLUTO_VOICE_NAME: z.string().min(1).default("Achird"),
  LOCAL_RUNNER_PORT: z.coerce.number().int().positive().default(DEFAULT_LOCAL_RUNNER_PORT),
  DESKTOP_SERVER_PORT: z.coerce.number().int().positive().default(DEFAULT_DESKTOP_SERVER_PORT),
  CONFIG_PATH: z.string().default(path.join(os.homedir(), ".agent-companion", "config.json")),
  TODO_STORE_PATH: z.string().default(path.join(os.homedir(), ".agent-companion", "todos.json")),
  ACTIVITY_LOG_PATH: z.string().default(path.join(os.homedir(), ".agent-companion", "activity.log")),
  PLUTO_AUDIO_DIR: z.string().default(path.join(os.homedir(), ".agent-companion", "pluto-audio")),
  DEFAULT_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  DEFAULT_ALLOWED_ORIGINS: z.string().default(""),
  DEFAULT_GOOGLE_CLIENT_IDS: z.string().default(""),
  DEFAULT_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_COMMAND_TIMEOUT_MS),
  DEFAULT_OUTPUT_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OUTPUT_LIMIT_BYTES),
});

export type RunnerEnv = z.infer<typeof envSchema>;

export function loadRunnerEnv(): RunnerEnv {
  loadWorkspaceEnv();
  return envSchema.parse(process.env);
}

function loadWorkspaceEnv() {
  const candidates = collectEnvCandidates(process.cwd());
  const loadedFromFiles = new Set<string>();
  for (const base of candidates) {
    applyEnvFile(path.resolve(base, ".env"), loadedFromFiles);
    applyEnvFile(path.resolve(base, ".env.local"), loadedFromFiles);
    applyEnvFile(path.resolve(base, ".env.secrets"), loadedFromFiles);
    applyEnvFile(path.resolve(base, ".env.secrets.local"), loadedFromFiles);
    applyEnvFile(path.resolve(base, ".env.op"), loadedFromFiles);
    applyEnvFile(path.resolve(base, ".env.op.local"), loadedFromFiles);
  }
}

function collectEnvCandidates(start: string) {
  const candidates: string[] = [];
  let current = path.resolve(start);

  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(current);
    if (depth > 0 && hasWorkspaceMarkers(current)) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return [...new Set(candidates)].reverse();
}

function hasWorkspaceMarkers(directory: string) {
  return ["pnpm-workspace.yaml", ".git"].some((marker) => fs.existsSync(path.resolve(directory, marker)));
}

function applyEnvFile(filePath: string, loadedFromFiles: Set<string>) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const parsed = parseDotenv(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || loadedFromFiles.has(key)) {
      process.env[key] = value;
      loadedFromFiles.add(key);
    }
  }
}
