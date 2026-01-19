const { contextBridge, process } = require("electron");

contextBridge.exposeInMainWorld("APP_ENV", {
  electron: !!process.versions.electron,
  version: process.versions.electron || "",
});
