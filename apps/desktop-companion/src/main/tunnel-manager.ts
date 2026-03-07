import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class TunnelManager extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly binary: string,
    private readonly configPath: string,
  ) {
    super();
  }

  isRunning() {
    return this.process !== null;
  }

  start() {
    if (this.process) {
      return;
    }
    const resolvedConfigPath = resolveConfigPath(this.configPath);
    const tunnelRef = readTunnelRef(resolvedConfigPath);
    this.process = spawn(this.binary, ["tunnel", "--config", resolvedConfigPath, "run", tunnelRef], {
      shell: false,
      env: process.env,
    });
    this.emit("status", this.isRunning());
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.emit("log", chunk.toString("utf8").trimEnd());
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emit("log", chunk.toString("utf8").trimEnd());
    });
    this.process.on("error", (error) => {
      this.emit("log", `Failed to start cloudflared: ${error.message}`);
      this.process = null;
      this.emit("status", this.isRunning());
    });
    this.process.on("close", (code) => {
      this.emit("log", `Cloudflared exited with code ${code}`);
      this.process = null;
      this.emit("status", this.isRunning());
    });
  }

  stop() {
    this.process?.kill("SIGTERM");
    this.process = null;
    this.emit("status", this.isRunning());
  }
}

function readTunnelRef(configPath: string) {
  const config = fs.readFileSync(configPath, "utf8");
  const match = config.match(/^\s*tunnel:\s*(.+)\s*$/m);
  if (!match) {
    throw new Error(`Tunnel name or ID missing in ${configPath}`);
  }
  return match[1].trim();
}

function resolveConfigPath(configPath: string) {
  if (fs.existsSync(configPath)) {
    return configPath;
  }

  const fallbackPath = path.join(os.homedir(), ".cloudflared", "config.yml");
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  throw new Error(`Cloudflare config not found at ${configPath} or ${fallbackPath}`);
}
