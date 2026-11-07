# Build registry

`manifest.json` is the single source of truth for the download centre
(`/js/ui/install-panel.js`). The UI renders a **Download** button for a platform
only when that platform has an entry here **and** the file answers a `HEAD`
request at its `url`. Nothing else produces a download button — there is no
hard-coded link anywhere in the JavaScript.

Right now `builds` is empty, so every platform shows its supported
browser-install route instead of a link that would 404.

## Publishing a build

1. Drop the installer into this folder, e.g. `public/downloads/shinzora-1.0.0.apk`.
2. Add an entry keyed by platform:

```json
{
  "builds": {
    "android": {
      "file": "shinzora-1.0.0.apk",
      "url": "/downloads/shinzora-1.0.0.apk",
      "format": "APK",
      "version": "1.0.0",
      "size": 24117248
    }
  }
}
```

Valid keys: `android`, `ios`, `windows`, `macos`, `linux`.

- `size` is optional; when present and the server reports `content-length`, the
  panel shows a real byte-accurate progress bar. Without a length it still
  downloads, but it tells the user what the browser is doing instead of faking
  a percentage.
- `format` is a label only (`APK`, `IPA`, `EXE`, `MSI`, `DMG`, `AppImage`, `DEB`).

## Rules

- Do not add an entry before the file exists. The panel verifies it, but a
  missing file is a broken promise to the visitor.
- `ios` should stay empty unless a TestFlight/App Store distribution exists;
  iOS installs through Safari's Add to Home Screen and the panel says so.
- Keep artifacts out of git if they are large: host them on a CDN and point
  `url` at the absolute URL. The `HEAD` probe and streaming progress work the
  same way, as long as CORS allows the request.
