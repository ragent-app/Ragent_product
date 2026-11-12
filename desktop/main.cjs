"use strict";

const { app, BrowserWindow, ipcMain, nativeImage, shell, Tray, Menu } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const updateCheck = require("./update-check.cjs");
const autoUpdate = require("./auto-update.cjs");

const portArg = process.platform === "darwin" ? process.argv.find((value) => value.startsWith("--agentoc-service-port=")) : "";
const configuredPort = portArg ? portArg.slice("--agentoc-service-port=".length) : process.env.AGENTOC_DESKTOP_PORT || "7690";
if (!/^[0-9]{1,5}$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535) {
  throw new Error("Invalid desktop service port");
}
const SERVICE_ORIGIN = `http://127.0.0.1:${Number(configuredPort)}`;
const MANAGER_URL = `${SERVICE_ORIGIN}/?desktop=manager`;
const RETRY_INTERVAL_MS = 1800;
const AUTH_HOSTS = new Set([
  "accounts.google.com",
  "auth.openai.com",
  "ragent.agentoncloud.com",
  "agentoc.andyscodexagent.cyou",
]);

let mainWindow = null;
let pollTimer = null;
let pollInProgress = false;
let managerLoaded = false;
let updateState = { status: "checking" };
let updatePending = null;
let updateTimer = null;
let installationPending = null;
let tray = null;
let quitting = false;
let trayServiceReady = false;

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(trayServiceReady ? "Ragent · 服务运行中" : "Ragent · 服务未连接");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayServiceReady ? "服务运行中" : "服务未连接", enabled: false },
    { label: "打开 Ragent", click: showMainWindow },
  ]));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    const isMac = process.platform === "darwin";
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "assets", isMac ? "ragent-trayTemplate.png" : "ragent-icon.png"));
    if (icon.isEmpty()) throw new Error("Ragent tray icon is missing");
    if (isMac) icon.setTemplateImage(true);
    tray = new Tray(isMac ? icon : icon.resize({ width: 32, height: 32 }));
    updateTrayMenu();
    tray.on("click", showMainWindow);
  } catch (error) {
    if (tray) tray.destroy();
    tray = null;
    console.error("Ragent tray unavailable:", error.message);
  }
}

async function queryUpdate() {
  const metadataDir = path.resolve(app.getAppPath(), process.platform === "linux" ? "../../../app" : process.platform === "darwin" ? "../../../../app" : "../../..");
  let currentVersion = (await fs.readFile(path.join(metadataDir, ".agentoc-package-version"), "utf8")).trim();
  if (process.platform !== "win32") currentVersion = currentVersion.split("+")[0];
  const currentCommit = await fs.readFile(path.join(metadataDir, ".agentoc-source-commit"), "utf8").catch(() => "");
  const currentBuild = await fs.readFile(path.join(metadataDir, ".agentoc-package-build"), "utf8").catch(() => "");
  return updateCheck.check(currentVersion, undefined, { currentCommit, currentBuild });
}

async function refreshUpdate() {
  if (installationPending) return updateState;
  if (updatePending) return updatePending;
  updatePending = (async () => {
    try {
      updateState = { status: "ready", ...(await queryUpdate()) };
    } catch {
      updateState = { status: "error" };
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-state", updateState);
    return updateState;
  })().finally(() => { updatePending = null; });
  return updatePending;
}

function publishUpdate(state) {
  updateState = { ...updateState, ...state };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-state", updateState);
}

async function readUpdateResult(attempt = 0) {
  if (typeof app.getPath !== "function") return;
  const resultFile = path.join(app.getPath("userData"), "ragent-update-result.json");
  try {
    const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    if (result.status === "pending" && attempt < 120) {
      setTimeout(() => void readUpdateResult(attempt + 1), 2000);
    } else if (result.status === "installed" || result.status === "failed") {
      publishUpdate({ status: result.status === "installed" ? "installed" : "installError" });
      if (result.status === "installed" && /^[a-f0-9]{64}$/.test(result.digest || "")) {
        try { await autoUpdate.clearCachedPackage(path.join(app.getPath("userData"), "ragent-update-cache"), result.digest); }
        catch { if (attempt < 120) setTimeout(() => void readUpdateResult(attempt + 1), 2000); return; }
      }
      await fs.unlink(resultFile).catch(() => {});
    }
  } catch { /* No previous update result. */ }
}

async function installUpdate() {
  if (installationPending) return false;
  if (!updateState.updateAvailable || !updateCheck.releaseAssetUrl(updateState.downloadUrl)) return false;
  installationPending = (async () => {
    let resultFile;
    try {
      publishUpdate({ status: "checking" });
      const latest = await queryUpdate();
      if (!latest.updateAvailable) { publishUpdate({ ...latest, status: "ready" }); return; }
      publishUpdate({ ...latest });
      publishUpdate({ status: "downloading", progress: 0 });
      const downloaded = await autoUpdate.downloadPackage(updateState, { cacheRoot: path.join(app.getPath("userData"), "ragent-update-cache"), onProgress: (bytes, total) => publishUpdate({ status: "downloading", progress: total ? Math.floor(bytes * 100 / total) : null }) });
      publishUpdate({ status: "waiting" });
      const metadataDir = path.resolve(app.getAppPath(), process.platform === "linux" ? "../../../app" : process.platform === "darwin" ? "../../../../app" : "../../..");
      const appRoot = process.platform === "darwin" ? path.resolve(metadataDir, "../..") : metadataDir;
      resultFile = path.join(app.getPath("userData"), "ragent-update-result.json");
      await fs.writeFile(resultFile, '{"status":"pending"}\n', { mode: 0o600 });
      const result = await autoUpdate.startInstaller({ ...downloaded, appRoot, executable: process.execPath, resultFile, packageSha256: updateState.packageSha256, servicePort: Number(configuredPort),
        onStatus: status => publishUpdate({ status }), onReadyToQuit: () => app.quit() });
      if (result.installed) { await fs.writeFile(resultFile, JSON.stringify({ status: "installed", digest: updateState.packageSha256 }), { mode: 0o600 }); await autoUpdate.clearCachedPackage(path.join(app.getPath("userData"), "ragent-update-cache"), updateState.packageSha256).catch(() => {}); publishUpdate({ status: "installed" }); app.relaunch(); app.quit(); }
    } catch (error) {
      console.error("Ragent update failed:", error.message);
      publishUpdate({ status: "installError" });
      if (resultFile) await fs.unlink(resultFile).catch(() => {});
    }
  })().finally(() => { installationPending = null; });
  return true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.agentoc.desktop-manager");
    createMainWindow();
    createTray();
    void refreshUpdate();
    void readUpdateResult();
    updateTimer = setInterval(() => void refreshUpdate(), 6 * 60 * 60 * 1000);
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { quitting = true; });
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
  mainWindow.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
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
    return installUpdate();
  });
  ipcMain.handle("desktop:write-text", async (event, value) => {
    if (event.sender !== mainWindow?.webContents || typeof value !== "string") return false;
    if (Buffer.byteLength(value, "utf8") > 4096) return false;
    const { clipboard } = require("electron");
    try { await clipboard.writeText(value); return true; } catch { return false; }
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
    trayServiceReady = ready;
    updateTrayMenu();
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
