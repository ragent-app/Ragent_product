"use strict";

const { app, BrowserWindow, ipcMain, nativeImage, shell } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const updateCheck = require("./update-check.cjs");

const SERVICE_ORIGIN = "http://127.0.0.1:7690";
const MANAGER_URL = `${SERVICE_ORIGIN}/?desktop=manager`;
const RETRY_INTERVAL_MS = 1800;
const AUTH_HOSTS = new Set([
  "accounts.google.com",
  "auth.openai.com",
  "agentoc.andyscodexagent.cyou",
]);

let mainWindow = null;
let pollTimer = null;
let pollInProgress = false;
let managerLoaded = false;
let updateState = { status: "checking" };
let updatePending = null;
let updateTimer = null;

async function refreshUpdate() {
  if (updatePending) return updatePending;
  updatePending = (async () => {
    let currentVersion;
    try {
      currentVersion = (await fs.readFile(path.resolve(app.getAppPath(), "../../../.agentoc-package-version"), "utf8")).trim();
      const currentCommit = await fs.readFile(path.resolve(app.getAppPath(), "../../../.agentoc-source-commit"), "utf8").catch(() => "");
      const currentBuild = await fs.readFile(path.resolve(app.getAppPath(), "../../../.agentoc-package-build"), "utf8").catch(() => "");
      updateState = { status: "ready", ...(await updateCheck.check(currentVersion, undefined, { currentCommit, currentBuild })) };
    } catch {
      updateState = { status: "error", ...(currentVersion ? { currentVersion } : {}) };
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-state", updateState);
    return updateState;
  })().finally(() => { updatePending = null; });
  return updatePending;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.agentoc.desktop-manager");
    createMainWindow();
    void refreshUpdate();
    updateTimer = setInterval(() => void refreshUpdate(), 6 * 60 * 60 * 1000);
  });

  app.on("window-all-closed", () => app.quit());
}

function isLocalServiceUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === SERVICE_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isApprovedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && AUTH_HOSTS.has(url.hostname.toLowerCase())
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function openApprovedExternal(value, source) {
  if (isLocalServiceUrl(value)) {
    void shell.openExternal(value).catch(() => reportExternalOpenFailure(source));
    return true;
  }
  if (!isApprovedExternalUrl(value)) return false;
  void shell.openExternal(value).catch(() => reportExternalOpenFailure(source));
  return true;
}

function reportExternalOpenFailure(source) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:external-open-failed", { source });
  }
}

function guardWebContents(webContents, { isMain = false } = {}) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 560,
          height: 420,
          show: false,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    openApprovedExternal(url, "new-window");
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, targetUrl) => {
    if (isLocalServiceUrl(targetUrl) || targetUrl === "about:blank") return;
    event.preventDefault();
    if (openApprovedExternal(targetUrl, isMain ? "main-navigation" : "login-window")) {
      if (!isMain && !webContents.isDestroyed()) webContents.close();
    }
  });

  webContents.on("will-redirect", (event, targetUrl) => {
    if (isLocalServiceUrl(targetUrl) || targetUrl === "about:blank") return;
    event.preventDefault();
    if (openApprovedExternal(targetUrl, isMain ? "main-redirect" : "login-window")) {
      if (!isMain && !webContents.isDestroyed()) webContents.close();
    }
  });

  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function createMainWindow() {
  const appRoot = app.getAppPath();
  const icon = nativeImage.createFromPath(path.join(appRoot, "assets", "agentoc-android-logo.png"));
  mainWindow = new BrowserWindow({
    title: "Ragent",
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: true,
    autoHideMenuBar: true,
    icon,
    backgroundColor: "#f4f6fa",
    webPreferences: {
      preload: path.join(appRoot, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  guardWebContents(mainWindow.webContents, { isMain: true });
  mainWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.setMenuBarVisibility(false);
    guardWebContents(childWindow.webContents);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    clearInterval(pollTimer);
    clearInterval(updateTimer);
    pollTimer = null;
  });

  ipcMain.handle("desktop:update-get", (event) => event.sender === mainWindow?.webContents ? updateState : { status: "error" });
  ipcMain.handle("desktop:update-check", (event) => event.sender === mainWindow?.webContents ? refreshUpdate() : { status: "error" });
  ipcMain.handle("desktop:update-open", async (event) => {
    if (event.sender !== mainWindow?.webContents || !updateState.updateAvailable || !updateCheck.releaseAssetUrl(updateState.downloadUrl)) return false;
    try { await shell.openExternal(updateState.downloadUrl); return true; } catch { return false; }
  });
  ipcMain.handle("desktop:write-text", (event, value) => {
    if (event.sender !== mainWindow?.webContents || typeof value !== "string") return false;
    if (Buffer.byteLength(value, "utf8") > 4096) return false;
    const { clipboard } = require("electron");
    clipboard.writeText(value);
    return true;
  });
  ipcMain.on("desktop:retry", (event) => {
    if (event.sender === mainWindow?.webContents) void checkService();
  });

  const waitPage = path.join(appRoot, "wait.html");
  void mainWindow.loadFile(waitPage);
  pollTimer = setInterval(() => void checkService(), RETRY_INTERVAL_MS);
  void checkService();
}

function serviceIsReady() {
  return new Promise((resolve) => {
    // /healthz also covers the independent Windows CLI/Owner activation
    // transport. It can report degraded while the local web UI is available
    // for management, so gate this window on its actual manager route.
    const request = http.get(MANAGER_URL, {
      // A probe has no cookie jar: an HTML navigation would issue an owner
      // session on every poll and eventually exhaust the session store.
      headers: { Accept: "*/*" },
      timeout: 1600,
    }, (response) => {
      response.resume();
      // An unauthenticated probe can legitimately be redirected to the local
      // login page. Do not follow it or treat arbitrary redirects as ready.
      resolve((response.statusCode >= 200 && response.statusCode < 300)
        || (response.statusCode === 302 && response.headers.location === '/login'));
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function checkService() {
  if (pollInProgress || !mainWindow || mainWindow.isDestroyed()) return;
  pollInProgress = true;
  try {
    const ready = await serviceIsReady();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (ready && !managerLoaded) {
      managerLoaded = true;
      await mainWindow.loadURL(MANAGER_URL);
      return;
    }
    if (!ready && managerLoaded) {
      managerLoaded = false;
      await mainWindow.loadFile(path.join(app.getAppPath(), "wait.html"));
    }
  } catch {
    if (mainWindow && !mainWindow.isDestroyed() && managerLoaded) {
      managerLoaded = false;
      await mainWindow.loadFile(path.join(app.getAppPath(), "wait.html"));
    }
  } finally {
    pollInProgress = false;
  }
}
