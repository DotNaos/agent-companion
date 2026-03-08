const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentCompanion', {
    platform: process.platform,
    selectDirectory: () =>
        ipcRenderer.invoke('agent-companion:select-directory'),
    setIgnoreMouseEvents: (ignore) =>
        ipcRenderer.send('agent-companion:set-ignore-mouse-events', ignore),
    showDashboard: () => ipcRenderer.invoke('agent-companion:show-dashboard'),
});
