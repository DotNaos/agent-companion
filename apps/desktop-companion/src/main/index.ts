import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, screen, session, systemPreferences, Tray } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { CursorTracker } from "./cursor-tracker.js";
import { loadDesktopEnv } from "./env.js";
import { logger } from "./logger.js";
import { shouldAllowMediaPermission } from "./media-permissions.js";
import { shouldOverlayIgnoreMouseEvents } from "./overlay-hit-test.js";
import { PlutoOrchestrator } from "./pluto-orchestrator.js";
import { RunnerBridge } from "./runner-bridge.js";

import { createDesktopServer } from "./server.js";
import { TunnelManager } from "./tunnel-manager.js";
import { UserStore } from "./user-store.js";

const env = loadDesktopEnv();
const desktopToken = randomUUID();
const cursorTracker = new CursorTracker(() => overlayWindow?.getBounds() ?? null);
const runnerBridge = new RunnerBridge(`http://127.0.0.1:${env.LOCAL_RUNNER_PORT}`);
const plutoOrchestrator = new PlutoOrchestrator(runnerBridge, capturePrimaryDisplayScreenshot);

const tunnelManager = new TunnelManager(env.CLOUDFLARED_BIN, env.CLOUDFLARED_CONFIG_PATH);
const userStore = new UserStore(env.USER_STORE_PATH);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolvePreloadPath() {
  const candidates = [
    path.join(currentDir, "../preload/index.cjs"),
    path.join(currentDir, "../preload/index.js"),
    path.join(process.cwd(), "src/preload/index.cjs"),
    path.join(process.cwd(), "dist/main/preload/index.js"),
    path.join(process.cwd(), "dist/preload/index.js"),
  ];

  const preload = candidates.find((candidate) => fs.existsSync(candidate));
  if (!preload) {
    throw new Error(`Unable to resolve preload script. Tried: ${candidates.join(", ")}`);
  }

  return preload;
}

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let isQuitting = false;
const COMPACT_OVERLAY_BOUNDS = {
  width: 248,
  height: 248,
  marginRight: 18,
  marginBottom: 18,
};
const EXPANDED_OVERLAY_BOUNDS = {
  width: 432,
  height: 480,
  marginRight: 16,
  marginBottom: 16,
};
ipcMain.on("agent-companion:set-ignore-mouse-events", (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

ipcMain.handle("agent-companion:show-dashboard", () => {
  mainWindow?.show();
  mainWindow?.focus();
  app.focus({ steal: true });
  return true;
});

ipcMain.handle("agent-companion:select-directory", async () => {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory", "createDirectory"],
      })
    : await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

function debugLog(message: string, details?: unknown) {
  if (details === undefined) {
    logger.info(message);
    return;
  }

  logger.info({ details }, message);
}

function errorLog(message: string, details?: unknown) {
  if (details === undefined) {
    logger.error(message);
    return;
  }

  logger.error({ details }, message);
}

const desktopServer = createDesktopServer({
  env,
  cursorTracker,
  runnerBridge,
  plutoOrchestrator,
  tunnelManager,
  userStore,
  desktopToken,
});
debugLog("boot:start");
app.once("ready", () => {
  void bootstrap().catch(handleBootstrapError);
});

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
  plutoOrchestrator.stop();
  tunnelManager.stop();
  debugLog("app:before-quit");
});

async function bootstrap() {
  debugLog("boot:app-ready");
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
    debugLog("boot:macos-activation-policy-set");
  }

  await configureMediaPermissions();

  await runnerBridge.connect();
  debugLog("boot:runner-connected", runnerBridge.getSnapshot().status);
  plutoOrchestrator.start();
  await desktopServer.listen();
  debugLog("boot:desktop-server-listening", { port: env.DESKTOP_PORT });
  createWindows();
  cursorTracker.start();
  createTray();
  wireApprovals();
  app.focus({ steal: true });
  debugLog("boot:focus-called");
}

function handleBootstrapError(error: unknown) {
  errorLog("boot:error", {
    message: error instanceof Error ? error.message : inspect(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  app.quit();

}

async function configureMediaPermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const mediaTypes = details.mediaType && details.mediaType !== "unknown"
      ? [details.mediaType]
      : undefined;
    const allowed = shouldAllowMediaPermission(permission, {
      mediaTypes,
      requestingUrl: requestingOrigin,
    });

    if (permission === "media") {
      debugLog("permissions:check", {
        permission,
        requestingOrigin,
        mediaTypes,
        allowed,
      });
    }

    return allowed;
  });

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    const mediaTypes = getRequestedMediaTypes(details);
    const allowed = shouldAllowMediaPermission(permission, {
      mediaTypes,
      requestingUrl,
    });

    debugLog("permissions:request", {
      permission,
      requestingUrl,
      mediaTypes,
      allowed,
    });

    callback(allowed);
  });

  if (process.platform !== "darwin") {
    return;
  }

  const currentStatus = systemPreferences.getMediaAccessStatus("microphone");
  debugLog("permissions:microphone-status", { status: currentStatus });

  if (currentStatus === "not-determined") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    debugLog("permissions:microphone-requested", { granted });
    return;
  }

  if (currentStatus !== "granted") {
    errorLog("permissions:microphone-unavailable", { status: currentStatus });
  }
}

function getRequestedMediaTypes(details: unknown) {
  if (
    typeof details === "object" &&
    details !== null &&
    "mediaTypes" in details &&
    Array.isArray(details.mediaTypes)
  ) {
    return details.mediaTypes.filter(
      (entry): entry is "audio" | "video" => entry === "audio" || entry === "video",
    );
  }

  return undefined;
}

function attachRendererLogging(window: BrowserWindow, label: string) {
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const details = {
      label,
      level,
      line,
      sourceId,
    };

    if (level >= 2) {
      logger.error({ details }, `renderer:${label}:${message}`);
      return;
    }

    if (level === 1) {
      logger.warn({ details }, `renderer:${label}:${message}`);
      return;
    }

    logger.info({ details }, `renderer:${label}:${message}`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    errorLog(`renderer:${label}:render-process-gone`, details);
  });

  window.webContents.on("unresponsive", () => {
    errorLog(`renderer:${label}:unresponsive`);
  });

  window.webContents.on("responsive", () => {
    debugLog(`renderer:${label}:responsive`);
  });
}

function createWindows() {
  debugLog("windows:create:start");
  const preloadPath = resolvePreloadPath();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  attachRendererLogging(mainWindow, "main");
  debugLog("windows:main-created", { windowCount: BrowserWindow.getAllWindows().length });
  mainWindow.webContents.on("did-finish-load", () => {
    debugLog("windows:main-did-finish-load", { url: mainWindow?.webContents.getURL() });
    mainWindow?.show();
    mainWindow?.focus();
    app.focus({ steal: true });
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    debugLog("windows:main-did-fail-load", { errorCode, errorDescription, validatedUrl });
    errorLog("mainWindow failed to load", { errorCode, errorDescription, validatedUrl });
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
    width: COMPACT_OVERLAY_BOUNDS.width,
    height: COMPACT_OVERLAY_BOUNDS.height,
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
      preload: preloadPath,
    },
  });
  attachRendererLogging(overlayWindow, "overlay");
  debugLog("windows:overlay-created", { windowCount: BrowserWindow.getAllWindows().length });
  updateOverlayWindowState();
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.on("did-finish-load", () => {
    debugLog("windows:overlay-did-finish-load", { url: overlayWindow?.webContents.getURL() });
    updateOverlayWindowState();
    overlayWindow?.show();
  });
  overlayWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    debugLog("windows:overlay-did-fail-load", { errorCode, errorDescription, validatedUrl });
    errorLog("overlayWindow failed to load", { errorCode, errorDescription, validatedUrl });
  });
  overlayWindow.on("show", () => debugLog("windows:overlay-show"));
  overlayWindow.on("hide", () => debugLog("windows:overlay-hide"));
  overlayWindow.on("closed", () => debugLog("windows:overlay-closed"));
  void overlayWindow.loadURL(`http://127.0.0.1:${env.DESKTOP_PORT}/overlay?desktopToken=${desktopToken}`);
  overlayWindow.once("ready-to-show", () => {
    debugLog("windows:overlay-ready-to-show");
    updateOverlayWindowState();
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
    const snapshot = runnerBridge.getSnapshot();
    const approvals = snapshot.approvals;
    updateOverlayWindowState(snapshot);
    updateOverlayMouseMode(snapshot);
    if (approvals.length > 0) {
      overlayWindow?.show();
      overlayWindow?.moveTop();
    }
  });

  cursorTracker.on("status", () => {
    updateOverlayMouseMode();
  });
}

function updateOverlayWindowState(snapshot = runnerBridge.getSnapshot()) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const hasBubble =
    snapshot.approvals.length > 0 ||
    snapshot.pluto.activeMessage !== null;
  const bounds = hasBubble
    ? EXPANDED_OVERLAY_BOUNDS
    : COMPACT_OVERLAY_BOUNDS;
  const workArea = screen.getPrimaryDisplay().workArea;

  overlayWindow.setBounds({
    x: workArea.x + workArea.width - bounds.width - bounds.marginRight,
    y: workArea.y + workArea.height - bounds.height - bounds.marginBottom,
    width: bounds.width,
    height: bounds.height,
  });

  updateOverlayMouseMode(snapshot);
}

function updateOverlayMouseMode(snapshot = runnerBridge.getSnapshot()) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const bounds = overlayWindow.getBounds();
  const cursorPoint = screen.getCursorScreenPoint();
  const ignoreMouseEvents = shouldOverlayIgnoreMouseEvents({
    bounds,
    cursorPoint,
    hasApprovalBubble: snapshot.approvals.length > 0,
  });

  overlayWindow.setIgnoreMouseEvents(ignoreMouseEvents, { forward: true });
}

async function capturePrimaryDisplayScreenshot() {
  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: 1280,
      height: 720,
    },
  });
  const source =
    sources.find((entry) => entry.display_id === primaryDisplayId) ??
    sources.find((entry) => entry.thumbnail && !entry.thumbnail.isEmpty());
  if (!source || source.thumbnail.isEmpty()) {
    return null;
  }

  return {
    mimeType: "image/jpeg",
    base64: source.thumbnail.toJPEG(75).toString("base64"),
  };
}
