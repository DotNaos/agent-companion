import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_OUTPUT_LIMIT_BYTES } from "@agent-companion/shared";

export interface ProcessLogEntry {
  processId?: string;
  timestamp: string;
  level: "info" | "error";
  message: string;
}

interface ManagedProcess {
  id: string;
  child: ChildProcessWithoutNullStreams;
  taskId: string;
  cwd: string;
  logs: ProcessLogEntry[];
}

export class ProcessManager {
  private readonly managed = new Map<string, ManagedProcess>();
  private readonly finishedLogs: ProcessLogEntry[] = [];

  constructor(
    private readonly onEvent: (entry: ProcessLogEntry) => void,
  ) {}

  async runOnce(
    command: string[],
    cwd: string,
    limits?: { timeoutMs?: number; outputLimitBytes?: number },
  ) {
    const timeoutMs = limits?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const outputLimitBytes = limits?.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;

    return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command[0]!, command.slice(1), {
        cwd,
        shell: false,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const clamp = (current: string, chunk: string) => {
        const next = `${current}${chunk}`;
        if (Buffer.byteLength(next, "utf8") <= outputLimitBytes) {
          return next;
        }
        return Buffer.from(next).subarray(0, outputLimitBytes).toString("utf8");
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = clamp(stdout, chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = clamp(stderr, chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
          });
        }
      });
    });
  }

  startManaged(command: string[], cwd: string, taskId: string) {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      shell: false,
      env: process.env,
    });
    const id = randomUUID();
    const record: ManagedProcess = {
      id,
      child,
      taskId,
      cwd,
      logs: [],
    };
    this.managed.set(id, record);
    this.pushLog(record, "info", `Started process ${taskId}`);

    child.stdout.on("data", (chunk: Buffer) => {
      this.pushLog(record, "info", chunk.toString("utf8").trimEnd());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.pushLog(record, "error", chunk.toString("utf8").trimEnd());
    });
    child.on("close", (code) => {
      this.pushLog(record, code === 0 ? "info" : "error", `Process exited with code ${code ?? 1}`);
      this.managed.delete(id);
      this.finishedLogs.push(...record.logs.slice(-25));
    });

    return { processId: id };
  }

  stopManaged(processId: string) {
    const record = this.managed.get(processId);
    if (!record) {
      return false;
    }
    record.child.kill("SIGTERM");
    this.pushLog(record, "info", "Stop requested");
    return true;
  }

  countRunning() {
    return this.managed.size;
  }

  getLogs(processId?: string, limit = 100): ProcessLogEntry[] {
    if (processId) {
      const record = this.managed.get(processId);
      return record ? record.logs.slice(-limit) : [];
    }
    const live = Array.from(this.managed.values()).flatMap((record) => record.logs);
    return [...this.finishedLogs, ...live].slice(-limit);
  }

  shutdown() {
    for (const record of this.managed.values()) {
      record.child.kill("SIGTERM");
    }
    this.managed.clear();
  }

  private pushLog(record: ManagedProcess, level: "info" | "error", message: string) {
    if (!message) {
      return;
    }
    const entry: ProcessLogEntry = {
      processId: record.id,
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    record.logs.push(entry);
    if (record.logs.length > 250) {
      record.logs.shift();
    }
    this.onEvent(entry);
  }
}
