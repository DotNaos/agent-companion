import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";
import { DEFAULT_DESKTOP_SERVER_PORT, DEFAULT_LOCAL_RUNNER_PORT } from "@agent-companion/shared";

const envSchema = z.object({
  DESKTOP_PORT: z.coerce.number().int().positive().default(DEFAULT_DESKTOP_SERVER_PORT),
  LOCAL_RUNNER_PORT: z.coerce.number().int().positive().default(DEFAULT_LOCAL_RUNNER_PORT),
  SESSION_SECRET: z.string().min(16).default("change-me-session-secret"),
  GOOGLE_OIDC_CLIENT_ID: z.string().default(""),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().default(""),
  DESKTOP_PUBLIC_BASE_URL: z.string().url().optional(),
  USER_STORE_PATH: z.string().default(path.join(os.homedir(), ".agent-companion", "users.json")),
  CLOUDFLARED_BIN: z.string().default("cloudflared"),
  CLOUDFLARED_CONFIG_PATH: z
    .string()
    .default(path.join(os.homedir(), ".agent-companion", "cloudflared", "config.yml")),
  VITE_DEV_SERVER_URL: z.string().url().optional(),
});

export type DesktopEnv = z.infer<typeof envSchema>;

export function loadDesktopEnv(): DesktopEnv {
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
