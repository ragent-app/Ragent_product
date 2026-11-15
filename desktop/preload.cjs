"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ragentDesktop", Object.freeze({
  getUpdateState: () => ipcRenderer.invoke("desktop:update-get"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:update-check"),
  openUpdate: () => ipcRenderer.invoke("desktop:update-open"),
  onUpdateState: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:update-state", handler);
    return () => ipcRenderer.removeListener("desktop:update-state", handler);
  },
  writeText: (value) => ipcRenderer.invoke("desktop:write-text", value),
  retryService: () => ipcRenderer.send("desktop:retry"),
  onExternalOpenFailed: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = () => listener();
    ipcRenderer.on("desktop:external-open-failed", handler);
    return () => ipcRenderer.removeListener("desktop:external-open-failed", handler);
  },
}));
