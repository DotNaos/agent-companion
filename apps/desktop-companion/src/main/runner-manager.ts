import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class RunnerManager extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lastError: string | null = null;

  isRunning() {
    return this.process !== null;
  }

  getLastError() {
    return this.lastError;
  }

  start() {
    if (this.process) {
      return;
    }

    const workspaceRoot = resolveWorkspaceRoot(process.cwd());
    const builtEntry = path.join(workspaceRoot, "apps/local-runner/dist/index.js");
    const sourceEntry = path.join(workspaceRoot, "apps/local-runner/src/index.ts");
    const tsxBinary = path.join(workspaceRoot, "node_modules/.bin/tsx");

    const command =
      fs.existsSync(builtEntry) && resolveNodeBinary()
        ? resolveNodeBinary()
        : tsxBinary;
    const args = command === tsxBinary ? [sourceEntry] : [builtEntry];

    this.lastError = null;
    this.process = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "pipe",
    });

    this.process.stdout.on("data", () => {
      this.emit("status", this.getSnapshot());
    });
    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.lastError = message.split("\n").at(-1) ?? message;
      }
      this.emit("status", this.getSnapshot());
    });
    this.process.on("error", (error) => {
      this.lastError = error.message;
      this.process = null;
      this.emit("status", this.getSnapshot());
    });
    this.process.on("exit", (code, signal) => {
      if (code && code !== 0) {
        this.lastError = `Runner exited with code ${code}`;
      } else if (signal) {
        this.lastError = `Runner stopped (${signal})`;
      }
      this.process = null;
      this.emit("status", this.getSnapshot());
    });

    this.emit("status", this.getSnapshot());
  }

  stop() {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
  }

  private getSnapshot() {
    return {
      running: this.isRunning(),
      lastError: this.lastError,
    };
  }
}

function resolveWorkspaceRoot(start: string) {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function resolveNodeBinary() {
  return process.env.NODE_BINARY || "node";
}
