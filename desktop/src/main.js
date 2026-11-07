/* ============================================================================
   Shinzora — desktop shell (Electron main process)
   ----------------------------------------------------------------------------
   A real application window: no tabs, no address bar, no browser UI. The window
   loads the same deployed web app, so there is exactly one codebase and one set
   of features — the desktop build is a shell, not a fork.

   Security posture
     · nodeIntegration off, contextIsolation on, sandbox on
     · no remote module, no eval, no custom protocol handlers
     · navigation is locked to the Shinzora origin: a link to anywhere else opens
       in the user's normal browser instead of hijacking the app window
     · the session is persistent, so the user stays signed in between launches

   The server URL is configurable (SHINZORA_URL) so the same build can point at a
   staging deployment without a rebuild.
   ========================================================================== */

const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("node:path");

const APP_URL = process.env.SHINZORA_URL || "https://shinzora.in";
const APP_ORIGIN = new URL(APP_URL).origin;
const IS_DEV = process.argv.includes("--dev");

/** Sent to the renderer so the page can tell it is running inside the app. */
const PRELOAD = path.join(__dirname, "preload.js");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#0a0812",
    title: "Shinzora",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });

  /* Window title follows the page, but keeps the product name in front. */
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    const pageTitle = mainWindow.webContents.getTitle();
    mainWindow.setTitle(pageTitle && pageTitle !== APP_URL ? `${pageTitle} — Shinzora` : "Shinzora");
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  /* External links belong in the browser, not in the app window. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_ORIGIN)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#0a0812" } };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  /* A genuine failure state instead of a blank window. */
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = user-initiated abort
    showOffline(errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on("render-process-gone", () => {
    dialog
      .showMessageBox(mainWindow, {
        type: "error",
        title: "Shinzora",
        message: "The application window stopped unexpectedly.",
        detail: "Reload the app. If it happens again, close Shinzora and open it once more.",
        buttons: ["Reload", "Close"],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => (response === 0 ? mainWindow.reload() : app.quit()));
  });

  mainWindow.loadURL(APP_URL);
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: "detach" });
}

function showOffline(errorCode, errorDescription, url) {
  const message = `${errorDescription || "Could not load"} (${errorCode})`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Shinzora</title>
<style>
  html,body{height:100%;margin:0;background:#0a0812;color:#e9e4ff;
    font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center}
  .card{max-width:420px;text-align:center;padding:36px 28px;border-radius:18px;
    border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
  h1{font-size:1.15rem;margin:0 0 10px}
  p{font-size:.86rem;line-height:1.65;color:#a9a2c4;margin:0 0 18px}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:10px 18px;
    font-size:.85rem;font-weight:600;cursor:pointer}
  code{font-size:.75rem;color:#8b84a8}
</style></head><body><div class="card">
  <h1>Shinzora cannot reach the server</h1>
  <p>Check your internet connection and try again. Your work is stored on the server, so nothing was lost.</p>
  <button onclick="location.replace('${APP_URL}')">Try again</button>
  <p style="margin-top:16px"><code>${message}${url ? " · " + url.replace(/</g, "&lt;") : ""}</code></p>
</div></body></html>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/* One instance only: a second launch focuses the existing window. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    /* No default Electron menu: the app has its own navigation. */
    Menu.setApplicationMenu(null);

    /* Nothing in this app needs camera, mic, geolocation or notifications
       beyond what the web app asks for explicitly; deny by default. */
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications"]);
      callback(allowed.has(permission));
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
