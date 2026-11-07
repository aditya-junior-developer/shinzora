# Shinzora desktop application

A real Electron application window for the Shinzora platform: no browser tabs, no
address bar, its own icon, Start Menu and desktop shortcuts, and a full installer.

## What is in this folder

| Path | Job |
| --- | --- |
| `src/main.js` | main process: window, security policy, external-link handling, offline state |
| `src/preload.js` | exposes `window.shinzoraDesktop = { isDesktop: true, platform }` |
| `assets/icon.ico` | the real Windows icon, built from the official Shinzora logo (16–256 px) |
| `assets/icon.png` | 512 px source of the same artwork |
| `package.json` | app identity (`in.shinzora.desktop`) and the electron-builder (NSIS) config |

The window loads the deployed web app, so the desktop build and the website are
the same product with one codebase. Point it elsewhere with `SHINZORA_URL`:

```bash
SHINZORA_URL=http://localhost:4173 npm start      # against the local dev server
```

## Build the Windows installer

The installer must be produced **on Windows** (or a Windows CI runner) — that is
where it can also be installed and tested. In this folder:

```bash
npm install
npm run dist:win
```

Output: `release/Shinzora-Setup-1.0.0.exe` — an NSIS installer with a real
uninstaller, an optional install directory, a desktop shortcut and a Start Menu
entry.

There is no `release/` folder in this repository, because the installer has not
been built yet. Do not advertise the `.exe` as downloadable until that command
has been run and the produced file has been installed and opened once.

## Uninstall

Windows Settings → Apps → Shinzora → Uninstall, or run the uninstaller that the
installer places in the install directory. User data on the server is untouched.

## Security notes

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
- navigation is locked to the Shinzora origin; external links open in the default browser
- no default Electron menu, no remote module, no permission prompt pass-through
