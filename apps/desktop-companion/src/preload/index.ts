import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("agentCompanion", {
  platform: process.platform,
});
