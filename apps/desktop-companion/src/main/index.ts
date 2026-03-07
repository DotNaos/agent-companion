import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadDesktopEnv } from "./env.js";
import { CursorTracker } from "./cursor-tracker.js";
import { RunnerBridge } from "./runner-bridge.js";

import { createDesktopServer } from "./server.js";
import { TunnelManager } from "./tunnel-manager.js";
import { UserStore } from "./user-store.js";

const env = loadDesktopEnv();
const desktopToken = randomUUID();
const cursorTracker = new CursorTracker(() => overlayWindow?.getBounds() ?? null);
const runnerBridge = new RunnerBridge(`http://127.0.0.1:${env.LOCAL_RUNNER_PORT}`);

const tunnelManager = new TunnelManager(env.CLOUDFLARED_BIN, env.CLOUDFLARED_CONFIG_PATH);
const userStore = new UserStore(env.USER_STORE_PATH);

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let isQuitting = false;
const debugLogPath = path.join(process.cwd(), "tmp", "desktop-main.log");

fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });

function debugLog(message: string, details?: unknown) {
  const line = `[${new Date().toISOString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`;
  fs.appendFileSync(debugLogPath, line);
}

const desktopServer = createDesktopServer({
  env,
  cursorTracker,
  runnerBridge,
  tunnelManager,
  userStore,
  desktopToken,
});
void bootstrap();

app.on("window-all-closed", () => {
  // Keep the tray app resident; windows hide instead of terminating the companion.
  debugLog("app:window-all-closed", { windowCount: BrowserWindow.getAllWindows().length });
});

app.on("activate", () => {
  debugLog("app:activate", { windowCount: BrowserWindow.getAllWindows().length });
  mainWindow?.show();
  mainWindow?.focus();
});

app.on("before-quit", () => {
  isQuitting = true;
  cursorTracker.stop();
  tunnelManager.stop();
  debugLog("app:before-quit");
});

async function bootstrap() {
  try {
    debugLog("boot:start");
    await app.whenReady();
    debugLog("boot:app-ready");
    if (process.platform === "darwin") {
      app.setActivationPolicy("regular");
      app.dock?.show();
      debugLog("boot:macos-activation-policy-set");
    }
    await runnerBridge.connect();
    debugLog("boot:runner-connected", runnerBridge.getSnapshot().status);
    await desktopServer.listen();
    debugLog("boot:desktop-server-listening", { port: env.DESKTOP_PORT });
    createWindows();
    cursorTracker.start();
    createTray();
    wireApprovals();
    app.focus({ steal: true });
    debugLog("boot:focus-called");
  } catch (error) {
    debugLog("boot:error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    app.quit();
  }
}

function createWindows() {
  debugLog("windows:create:start");
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugLog("windows:main-created", { windowCount: BrowserWindow.getAllWindows().length });
  mainWindow.webContents.on("did-finish-load", () => {
    debugLog("windows:main-did-finish-load", { url: mainWindow?.webContents.getURL() });
    mainWindow?.show();
    mainWindow?.focus();
    app.focus({ steal: true });
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    debugLog("windows:main-did-fail-load", { errorCode, errorDescription, validatedUrl });
    console.error("mainWindow failed to load", { errorCode, errorDescription, validatedUrl });
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("show", () => debugLog("windows:main-show"));
  mainWindow.on("hide", () => debugLog("windows:main-hide"));
  mainWindow.on("closed", () => debugLog("windows:main-closed"));
  void mainWindow.loadURL(`http://127.0.0.1:${env.DESKTOP_PORT}/desktop?desktopToken=${desktopToken}`);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.once("ready-to-show", () => {
    debugLog("windows:main-ready-to-show");
    mainWindow?.show();
    mainWindow?.focus();
    app.focus({ steal: true });
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });

  overlayWindow = new BrowserWindow({
    width: 432,
    height: 480,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    show: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    movable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugLog("windows:overlay-created", { windowCount: BrowserWindow.getAllWindows().length });
  const workArea = screen.getPrimaryDisplay().workArea;
  overlayWindow.setPosition(workArea.x + workArea.width - 448, workArea.y + workArea.height - 496);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.webContents.on("did-finish-load", () => {
    debugLog("windows:overlay-did-finish-load", { url: overlayWindow?.webContents.getURL() });
    overlayWindow?.show();
  });
  overlayWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    debugLog("windows:overlay-did-fail-load", { errorCode, errorDescription, validatedUrl });
    console.error("overlayWindow failed to load", { errorCode, errorDescription, validatedUrl });
  });
  overlayWindow.on("show", () => debugLog("windows:overlay-show"));
  overlayWindow.on("hide", () => debugLog("windows:overlay-hide"));
  overlayWindow.on("closed", () => debugLog("windows:overlay-closed"));
  void overlayWindow.loadURL(`http://127.0.0.1:${env.DESKTOP_PORT}/overlay?desktopToken=${desktopToken}`);
  overlayWindow.once("ready-to-show", () => {
    debugLog("windows:overlay-ready-to-show");
    overlayWindow?.show();
  });
  overlayWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    overlayWindow?.hide();
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  updateTrayMenu();
  tunnelManager.on("status", updateTrayMenu);
  debugLog("tray:created");
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }
  tray.setToolTip(`agent-companion${tunnelManager.isRunning() ? " (tunnel on)" : " (tunnel off)"}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Dashboard",
        click: () => mainWindow?.show(),
      },
      {
        label: overlayWindow?.isVisible() ? "Hide Overlay" : "Show Overlay",
        click: () => {
          if (!overlayWindow) {
            return;
          }
          if (overlayWindow.isVisible()) {
            overlayWindow.hide();
          } else {
            overlayWindow.show();
          }
          updateTrayMenu();
        },
      },

      {
        label: tunnelManager.isRunning() ? "Stop Tunnel" : "Start Tunnel",
        click: () => {
          if (tunnelManager.isRunning()) {
            tunnelManager.stop();
          } else {
            tunnelManager.start();
          }
          updateTrayMenu();
        },
      },
      {
        label: "Quit",
        click: () => app.quit(),
      },
    ]),
  );
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect x="2" y="2" width="14" height="14" rx="4" fill="black"/>
      <path d="M6 9h6M9 6v6" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="13.5" cy="4.5" r="1.2" fill="white"/>
    </svg>
  `;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image.resize({ width: 18, height: 18 });
}

function wireApprovals() {
  runnerBridge.on("snapshot", () => {
    const approvals = runnerBridge.getSnapshot().approvals;
    if (approvals.length > 0) {
      overlayWindow?.show();
      overlayWindow?.moveTop();
    }
  });
}
