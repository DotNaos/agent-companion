import pino from "pino";

export function createRemoteLogger(level: "debug" | "info" | "warn" | "error") {
  return pino({
    name: "remote-mcp-server",
    level,
    base: {
      service: "remote-mcp-server",
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
}

function shouldUsePrettyLogging() {
  return process.env.AGENT_COMPANION_LOG_PRETTY !== "false";
}
