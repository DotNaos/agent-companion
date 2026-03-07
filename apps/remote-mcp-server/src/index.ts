import { createRemoteMcpApp } from "./app.js";

const { env, logger, server } = createRemoteMcpApp();

server.listen(env.PORT, "0.0.0.0", () => {
  logger.info({ port: env.PORT }, "remote_mcp_server_started");
});
