import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentCompanion", {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke("agent-companion:select-directory") as Promise<string | null>,
});
