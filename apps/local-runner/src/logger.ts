import pino from "pino";
import { loadRunnerEnv } from "./env.js";

const env = loadRunnerEnv();

export const logger = pino({
  name: "local-runner",
  level: env.LOG_LEVEL,
  base: {
    service: "local-runner",
  },
  transport: shouldUsePrettyLogging()
    ? {
        target: "pino-pretty",
        options: {
          colorize: false,
          ignore: "pid,hostname",
          messageFormat: "{msg}",
          singleLine: false,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        },
      }
    : undefined,
});

function shouldUsePrettyLogging() {
  return process.env.AGENT_COMPANION_LOG_PRETTY !== "false";
}
