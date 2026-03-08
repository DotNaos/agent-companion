import pino from "pino";
import { loadDesktopEnv } from "./env.js";

const env = loadDesktopEnv();

export const logger = pino({
  name: "desktop-companion-main",
  level: env.LOG_LEVEL,
  base: {
    service: "desktop-companion-main",
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
