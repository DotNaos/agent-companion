import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";
import { DEFAULT_REMOTE_SERVER_PORT } from "@agent-companion/shared";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(DEFAULT_REMOTE_SERVER_PORT),
  RUNNER_TOKEN: z.string().min(1).default("change-me-runner-token"),
  ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  GOOGLE_ALLOWED_CLIENT_IDS: z.string().default(""),
  GOOGLE_OIDC_CLIENT_ID: z.string().default(""),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().default(""),
  SESSION_SECRET: z.string().min(16).default("change-me-session-secret"),
  REMOTE_PUBLIC_BASE_URL: z.string().url().optional(),
  REMOTE_SERVER_URL: z.string().url().optional(),
  REMOTE_OAUTH_CLIENTS_STORE_PATH: z
    .string()
    .default(path.join(os.homedir(), ".agent-companion", "remote-oauth-clients.json")),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type RemoteEnv = z.infer<typeof envSchema> & {
  REMOTE_PUBLIC_BASE_URL: string;
};

export function loadRemoteEnv(): RemoteEnv {
  loadWorkspaceEnv();
  const env = envSchema.parse(process.env);
  return {
    ...env,
    REMOTE_PUBLIC_BASE_URL:
      env.REMOTE_PUBLIC_BASE_URL ??
      env.REMOTE_SERVER_URL ??
      `http://127.0.0.1:${env.PORT}`,
  };
}

function loadWorkspaceEnv() {
  const candidates = collectEnvCandidates(process.cwd());
  const loadedFromFiles = new Set<string>();
  for (const base of candidates) {
    applyEnvFile(path.resolve(base, ".env"), loadedFromFiles, { allowFifo: false });
    applyEnvFile(path.resolve(base, ".env.local"), loadedFromFiles, { allowFifo: false });
    applyEnvFile(path.resolve(base, ".env.secrets"), loadedFromFiles, { allowFifo: true });
    applyEnvFile(path.resolve(base, ".env.secrets.local"), loadedFromFiles, { allowFifo: true });
    applyEnvFile(path.resolve(base, ".env.op"), loadedFromFiles, { allowFifo: true });
    applyEnvFile(path.resolve(base, ".env.op.local"), loadedFromFiles, { allowFifo: true });
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

function applyEnvFile(filePath: string, loadedFromFiles: Set<string>, options: { allowFifo: boolean }) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isFIFO() && !options.allowFifo) {
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
