import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentCompanion", {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke("agent-companion:select-directory") as Promise<string | null>,
  setIgnoreMouseEvents: (ignore: boolean) => ipcRenderer.send("agent-companion:set-ignore-mouse-events", ignore),
  showDashboard: () => ipcRenderer.invoke("agent-companion:show-dashboard") as Promise<boolean>,
});
