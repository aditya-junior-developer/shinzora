/* ============================================================================
   Shinzora — desktop preload
   ----------------------------------------------------------------------------
   The smallest possible surface: the web app is told it is running in the
   desktop shell (so it can hide "install the app" prompts) and nothing else.
   No Node APIs, no ipcRenderer passthrough.
   ========================================================================== */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("shinzoraDesktop", {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || "1.0.0"
});
