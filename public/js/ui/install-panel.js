/* ==========================================================================
   Shinzora — Get App / download centre
   --------------------------------------------------------------------------
   A three-level flow inside one glass modal:

       device   →  Phone | Computer
       phone    →  Android | iOS
       computer →  Windows | macOS | Linux
       platform →  the real action for that platform

   Honesty rules, enforced by construction rather than by copy:

     • A download button only exists if `/downloads/manifest.json` lists a build
       AND the file answers a range request. A listed-but-missing file is
       reported as unavailable, never as a broken link.
     • Progress is measured from the response body as it streams. If the browser
       cannot stream, the button becomes a plain link and says so — it does not
       animate a fake bar.
     • Where no native build is published, the panel shows the supported route
       (browser/PWA install) and says exactly that. There is no pretend APK, IPA,
       DMG or EXE.
     • The install prompt is only offered when the browser actually fired
       `beforeinstallprompt`; its outcome is whatever the browser reports.

   The setup guide always opens in its own tab (`/install-guide/`), never inside
   this modal.
   ========================================================================== */

import { canPromptInstall, promptInstall, isInstalled } from "./pwa.js?v=20261105c";
import { icon } from "../lib/icons.js";
import { platformMark } from "../lib/platform-icons.js?v=20261110b";

const GUIDE_URL = "/install-guide/";
const MANIFEST_URL = "/downloads/manifest.json";

/* ------------------------------------------------------------------ content */

const PLATFORMS = {
  android: {
    family: "phone",
    name: "Android",
    mark: "android",
    desc: "Download Shinzora for Android.",
    format: "APK",
    route: "Android installs from Chrome in two taps — no file needed.",
    steps: [
      "Open Shinzora in <strong>Chrome</strong> on the phone.",
      "Tap the <strong>three-dot menu</strong>, then <strong>Install app</strong>.",
      "Confirm — Shinzora gets its own icon and opens without browser chrome."
    ]
  },
  ios: {
    family: "phone",
    name: "iOS",
    mark: "apple",
    desc: "Get Shinzora on your iPhone.",
    format: "IPA",
    route: "iPhone installs from Safari through Add to Home Screen.",
    steps: [
      "Open Shinzora in <strong>Safari</strong> on the iPhone or iPad.",
      "Tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>.",
      "Name it and tap <strong>Add</strong>. It opens full screen, like any app."
    ]
  },
  windows: {
    family: "computer",
    name: "Windows",
    mark: "windows",
    desc: "Download Shinzora for Windows.",
    format: "EXE",
    route: "Windows installs from Chrome or Edge as a desktop app.",
    steps: [
      "Open Shinzora in <strong>Chrome</strong> or <strong>Edge</strong>.",
      "Click the <strong>install icon</strong> at the right of the address bar.",
      "Confirm — Shinzora gets a Start-menu entry and its own window."
    ]
  },
  macos: {
    family: "computer",
    name: "macOS",
    mark: "apple",
    desc: "Download Shinzora for Mac.",
    format: "DMG",
    route: "On macOS, Chrome and Edge install it, or Safari 14+ adds it to the Dock.",
    steps: [
      "In <strong>Chrome</strong> or <strong>Edge</strong>, click the install icon in the address bar.",
      "On <strong>Safari 14+</strong> use <strong>File → Add to Dock</strong>.",
      "Confirm — Shinzora opens in its own window from Launchpad."
    ]
  },
  linux: {
    family: "computer",
    name: "Linux",
    mark: "linux",
    desc: "Download Shinzora for Linux.",
    format: "AppImage",
    route: "On Linux, Chrome and Chromium install it as a desktop application.",
    steps: [
      "Open Shinzora in <strong>Chrome</strong> or <strong>Chromium</strong>.",
      "Use the install icon in the address bar, or the menu → <strong>Install</strong>.",
      "Confirm — the launcher appears in your application menu."
    ]
  }
};

const FAMILIES = {
  phone: {
    title: "Choose Your Mobile Platform",
    lede: "Two ways to carry the same workspace in your pocket.",
    options: ["android", "ios"]
  },
  computer: {
    title: "Choose Your Desktop Platform",
    lede: "A real window, its own icon, and the shell still opens offline.",
    options: ["windows", "macos", "linux"]
  }
};

/* ------------------------------------------------------------------ helpers */

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function detectFamily() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/.test(ua)) return "phone";
  return "computer";
}

function detectPlatformKey() {
  const ua = navigator.userAgent || "";
  const touchMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return null;
}

/* Builds ------------------------------------------------------------------- */

let buildCache = null;

/** Read the build registry. Returns {} when nothing has been published. */
async function loadBuilds() {
  if (buildCache) return buildCache;
  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) {
      buildCache = {};
      return buildCache;
    }
    const json = await response.json();
    buildCache = json && typeof json.builds === "object" && json.builds ? json.builds : {};
  } catch {
    buildCache = {};
  }
  return buildCache;
}

/**
 * A build is only offered when the file really answers. A HEAD here means the
 * UI never renders a download button that 404s on click.
 */
async function probeBuild(entry) {
  if (!entry || !entry.url) return null;
  try {
    const response = await fetch(entry.url, { method: "HEAD", cache: "no-store" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") || 0);
    return { ...entry, size: length || entry.size || 0 };
  } catch {
    return null;
  }
}

/**
 * Stream a download so the progress bar reflects real bytes. Falls back to a
 * plain navigation when the stream is unavailable or the size is unknown.
 */
async function downloadWithProgress(entry, onProgress) {
  const response = await fetch(entry.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const total = Number(response.headers.get("content-length") || entry.size || 0);
  const type = response.headers.get("content-type") || "application/octet-stream";

  if (!response.body || typeof response.body.getReader !== "function" || !total) {
    /* No streaming read: hand the file to the browser and say what happened. */
    const anchor = document.createElement("a");
    anchor.href = entry.url;
    anchor.download = entry.file || "";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return { streamed: false, bytes: total };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total ? Math.min(1, received / total) : 0, received, total);
  }

  const blob = new Blob(chunks, { type });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = entry.file || "shinzora-download";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);

  return { streamed: true, bytes: received };
}

/* ------------------------------------------------------------------- panel */

let openInstance = null;
let openTrigger = null;

/**
 * Open the download centre.
 * @param {{ family?: "phone"|"computer", platform?: string }} [options]
 */
export function openInstallPanel(options = {}) {
  if (openInstance) return openInstance;

  const state = {
    step: options.family || options.platform ? "platform-list" : "device",
    family: options.family || (options.platform ? PLATFORMS[options.platform]?.family : null),
    platform: options.platform || null,
    builds: {},
    busy: false,
    status: null
  };

  const backdrop = document.createElement("div");
  backdrop.className = "ip-backdrop";
  backdrop.innerHTML = `
    <div class="ip-panel" role="dialog" aria-modal="true" aria-labelledby="ip-title" id="install-modal">
      <div class="ip-glow" aria-hidden="true"></div>

      <button class="ip-close" type="button" data-ip-close aria-label="Close">
        ${icon("x", { size: 16 })}
      </button>

      <div class="ip-head">
        <span class="ip-mark" aria-hidden="true">
          <img src="/assets/icons/mark.svg" alt="" width="34" height="34" />
        </span>
        <div>
          <h2 class="ip-title" id="ip-title">Get Shinzora</h2>
          <p class="ip-sub">Your business ecosystem. Everywhere.</p>
        </div>
      </div>

      <div class="ip-view" data-ip-view></div>

      <p class="ip-status" data-ip-status role="status" aria-live="polite"></p>
    </div>`;

  document.body.append(backdrop);
  document.body.classList.add("ip-open");
  requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add("is-open")));

  const panel = backdrop.querySelector(".ip-panel");
  const view = backdrop.querySelector("[data-ip-view]");
  const statusEl = backdrop.querySelector("[data-ip-status]");
  const titleEl = backdrop.querySelector("#ip-title");

  /* ---------------------------------------------------------------- render */

  function guideLine() {
    return `<p class="ip-guide">For setup guide, please check this
      <a href="${GUIDE_URL}" target="_blank" rel="noopener noreferrer">link</a>.</p>`;
  }

  function deviceView() {
    const installed = isInstalled();
    return `
      <p class="ip-lede">Choose your device to get the right application.</p>

      <div class="ip-devices">
        <button class="ip-device" type="button" data-ip-family="phone">
          <span class="ip-device-icon">${icon("smartphone", { size: 26 })}</span>
          <span class="ip-device-body">
            <span class="ip-device-name">Phone</span>
            <span class="ip-device-meta">Android &amp; iOS</span>
            <span class="ip-device-desc">Get Shinzora on your phone.</span>
          </span>
          ${icon("chevron-right", { size: 18, cls: "ip-device-go" })}
        </button>

        <button class="ip-device" type="button" data-ip-family="computer">
          <span class="ip-device-icon">${icon("monitor", { size: 26 })}</span>
          <span class="ip-device-body">
            <span class="ip-device-name">Computer</span>
            <span class="ip-device-meta">Windows, macOS &amp; Linux</span>
            <span class="ip-device-desc">Get Shinzora on your computer.</span>
          </span>
          ${icon("chevron-right", { size: 18, cls: "ip-device-go" })}
        </button>
      </div>

      ${
        installed
          ? `<p class="ip-installed">${icon("circle-check", { size: 15 })} This device is already running the installed app.</p>`
          : ""
      }`;
  }

  function familyView(family) {
    const config = FAMILIES[family];
    const current = detectPlatformKey();

    const options = config.options
      .map((key) => {
        const platform = PLATFORMS[key];
        const build = state.builds[key];
        const chip = build
          ? `<span class="ip-chip is-ready">${build.format || platform.format} ${build.size ? `· ${formatBytes(build.size)}` : ""}</span>`
          : `<span class="ip-chip">Browser install</span>`;
        return `
          <button class="ip-option" type="button" data-ip-platform="${key}">
            <span class="ip-option-mark">${platformMark(platform.mark, 22)}</span>
            <span class="ip-option-body">
              <span class="ip-option-name">${platform.name}${key === current ? `<span class="ip-here">this device</span>` : ""}</span>
              <span class="ip-option-desc">${platform.desc}</span>
            </span>
            ${chip}
            ${icon("chevron-right", { size: 16, cls: "ip-option-go" })}
          </button>`;
      })
      .join("");

    return `
      <div class="ip-bar">
        <button class="ip-back" type="button" data-ip-back aria-label="Back">
          ${icon("arrow-left", { size: 15 })}<span>Back</span>
        </button>
        <span class="ip-crumb">${family === "phone" ? "Phone" : "Computer"}</span>
      </div>

      <h3 class="ip-step-title">${config.title}</h3>
      <p class="ip-lede">${config.lede}</p>

      <div class="ip-options">${options}</div>

      ${guideLine()}`;
  }

  function platformView(key) {
    const platform = PLATFORMS[key];
    const build = state.builds[key];
    const current = detectPlatformKey();
    const isCurrentDevice = key === current;
    const promptAvailable = canPromptInstall();

    const action = build
      ? `
        <div class="ip-action-card">
          <div class="ip-action-row">
            <span class="ip-action-file">${build.file || `shinzora.${key}`}</span>
            <span class="ip-action-size">${build.size ? formatBytes(build.size) : (build.format || platform.format)}</span>
          </div>
          <button class="btn btn-primary btn-lg btn-block ip-download" type="button" data-ip-download>
            ${icon("download", { size: 16 })}<span data-ip-download-label>Download for ${platform.name}</span>
          </button>
          <div class="ip-progress" data-ip-progress hidden>
            <div class="ip-progress-track"><div class="ip-progress-fill" data-ip-fill></div></div>
            <span class="ip-progress-text" data-ip-progress-text>Starting…</span>
          </div>
          <p class="ip-action-note">Downloaded straight from ${location.host}. Nothing is emailed to you.</p>
        </div>`
      : `
        <div class="ip-action-card is-soft">
          <p class="ip-action-head">${icon("info", { size: 16 })} No standalone ${platform.format} build is published yet.</p>
          <p class="ip-action-note">
            Until one is released, the steps below are the supported way to install Shinzora on ${platform.name} —
            the same app and the same account, with nothing to sideload or trust.
          </p>
          ${
            isCurrentDevice && promptAvailable
              ? `<button class="btn btn-primary btn-lg btn-block ip-prompt" type="button" data-ip-prompt>
                   ${icon("download", { size: 16 })}<span data-ip-prompt-label>Install Shinzora now</span>
                 </button>
                 <p class="ip-prompt-hint">Your browser will show its own confirmation. Nothing installs without it.</p>`
              : ""
          }
        </div>`;

    return `
      <div class="ip-bar">
        <button class="ip-back" type="button" data-ip-back aria-label="Back">
          ${icon("arrow-left", { size: 15 })}<span>Back</span>
        </button>
        <span class="ip-crumb">${platform.family === "phone" ? "Phone" : "Computer"} / ${platform.name}</span>
      </div>

      <div class="ip-platform-head">
        <span class="ip-platform-mark">${platformMark(platform.mark, 26)}</span>
        <div>
          <h3 class="ip-step-title">${platform.name}</h3>
          <p class="ip-lede">${platform.route}</p>
        </div>
      </div>

      ${action}

      <ol class="ip-steps">${platform.steps.map((step) => `<li>${step}</li>`).join("")}</ol>

      ${guideLine()}`;
  }

  function render({ announce = true } = {}) {
    if (state.step === "device") {
      titleEl.textContent = "Get Shinzora";
      view.innerHTML = deviceView();
    } else if (state.step === "family") {
      titleEl.textContent = "Get Shinzora";
      view.innerHTML = familyView(state.family);
    } else if (state.step === "platform") {
      titleEl.textContent = "Get Shinzora";
      view.innerHTML = platformView(state.platform);
    }

    if (announce) {
      const heading = view.querySelector(".ip-step-title, .ip-lede");
      if (heading) {
        /* Announce the new screen for screen readers without stealing focus
           from the control the user just used. */
        heading.setAttribute("tabindex", "-1");
      }
    }
    setStatus(state.status);
  }

  /** Cross-fade + slide between screens. Never a hard swap. */
  async function transition(direction, apply) {
    if (prefersReducedMotion()) {
      apply();
      return;
    }
    const outClass = direction === "forward" ? "is-out-left" : "is-out-right";
    const inClass = direction === "forward" ? "is-in-right" : "is-in-left";

    const fromHeight = view.offsetHeight;

    view.classList.add(outClass);
    await wait(170);

    apply();
    view.classList.remove(outClass);

    /* Park the new screen off-stage without animating, then release it: the
       inline `transition: none` is what stops it flashing in at the final
       position for one frame before sliding. */
    view.style.transition = "none";
    view.classList.add(inClass);
    const toHeight = view.offsetHeight;
    void view.offsetWidth;
    view.style.transition = "";
    view.classList.remove(inClass);

    /* Animate the panel's height between steps so the modal grows and shrinks
       with the content instead of snapping. */
    if (fromHeight !== toHeight) {
      view.classList.add("is-resizing");
      view.style.height = `${fromHeight}px`;
      void view.offsetHeight;
      view.style.height = `${toHeight}px`;
      await wait(260);
      view.style.height = "";
      view.classList.remove("is-resizing");
    }
  }

  function setStatus(status) {
    state.status = status;
    if (!statusEl) return;
    if (!status) {
      statusEl.textContent = "";
      statusEl.className = "ip-status";
      return;
    }
    statusEl.textContent = status.message;
    statusEl.className = `ip-status is-${status.tone || "info"}`;
  }

  /* -------------------------------------------------------------- behaviour */

  async function go(next, payload, direction = "forward") {
    await transition(direction, () => {
      if (next === "family") {
        state.step = "family";
        state.family = payload;
      } else if (next === "platform") {
        state.step = "platform";
        state.platform = payload;
      } else if (next === "device") {
        state.step = "device";
        state.family = null;
        state.platform = null;
      }
      state.status = null;
      render();
    });
    focusFirst();
  }

  function back() {
    if (state.step === "platform") {
      go("family", state.family, "back");
    } else if (state.step === "family") {
      go("device", null, "back");
    }
  }

  function focusFirst() {
    const target =
      view.querySelector(".ip-device, .ip-option, .ip-download, .ip-prompt") ||
      view.querySelector("[data-ip-back]") ||
      view.querySelector("button");
    target?.focus();
  }

  view.addEventListener("click", async (event) => {
    const familyButton = event.target.closest("[data-ip-family]");
    if (familyButton) {
      await go("family", familyButton.getAttribute("data-ip-family"));
      return;
    }

    const platformButton = event.target.closest("[data-ip-platform]");
    if (platformButton) {
      await go("platform", platformButton.getAttribute("data-ip-platform"));
      return;
    }

    if (event.target.closest("[data-ip-back]")) {
      back();
      return;
    }

    const promptButton = event.target.closest("[data-ip-prompt]");
    if (promptButton) {
      await runPrompt(promptButton);
      return;
    }

    const downloadButton = event.target.closest("[data-ip-download]");
    if (downloadButton) {
      await runDownload(downloadButton);
    }
  });

  async function runPrompt(button) {
    if (!canPromptInstall()) {
      setStatus({ message: "No install prompt is available in this browser. Use the steps below.", tone: "warn" });
      return;
    }
    button.disabled = true;
    button.classList.add("is-busy");
    const label = button.querySelector("[data-ip-prompt-label]");
    if (label) label.textContent = "Waiting for your browser…";

    const { outcome } = await promptInstall();

    button.disabled = false;
    button.classList.remove("is-busy");
    if (label) label.textContent = "Install Shinzora now";

    if (outcome === "accepted") {
      setStatus({ message: "Installed. Your browser is adding the app now.", tone: "ok" });
      setTimeout(close, 1400);
    } else if (outcome === "dismissed") {
      setStatus({ message: "The browser declined the install. You can start it again from its menu.", tone: "warn" });
    } else {
      setStatus({ message: "The install prompt is no longer available. Follow the steps below.", tone: "warn" });
    }
  }

  async function runDownload(button) {
    const key = state.platform;
    const entry = state.builds[key];
    if (!entry) {
      setStatus({ message: "That build is no longer available. Reload the page to refresh the list.", tone: "error" });
      return;
    }

    const progress = view.querySelector("[data-ip-progress]");
    const fill = view.querySelector("[data-ip-fill]");
    const progressText = view.querySelector("[data-ip-progress-text]");
    const label = button.querySelector("[data-ip-download-label]");

    button.disabled = true;
    button.classList.add("is-busy");
    if (label) label.textContent = "Downloading…";
    if (progress) progress.hidden = false;
    setStatus(null);

    try {
      const result = await downloadWithProgress(entry, (ratio, received, total) => {
        if (fill) fill.style.transform = `scaleX(${Math.max(0.02, ratio)})`;
        if (progressText) {
          progressText.textContent = total
            ? `${formatBytes(received)} of ${formatBytes(total)}`
            : `${formatBytes(received)} received`;
        }
      });

      if (fill) fill.style.transform = "scaleX(1)";
      if (label) label.textContent = "Download again";
      setStatus({
        message: result.streamed
          ? `Downloaded ${formatBytes(result.bytes)}. Check your browser's downloads for ${entry.file}.`
          : "Your browser is saving the file. Check its downloads list.",
        tone: "ok"
      });
    } catch (error) {
      if (progress) progress.hidden = true;
      if (label) label.textContent = `Download for ${PLATFORMS[key].name}`;
      setStatus({
        message: `The download failed (${error.message}). Try again, or use the setup guide.`,
        tone: "error"
      });
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
    }
  }

  /* ------------------------------------------------------------------ close */

  function close() {
    /* Return focus to whatever opened the dialog, so keyboard users are not
       dropped back at the top of the document. */
    const opener = openTrigger;
    backdrop.classList.remove("is-open");
    document.body.classList.remove("ip-open");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => {
      backdrop.remove();
      openInstance = null;
      if (opener && document.contains(opener)) opener.focus();
    }, 320);
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      /* Escape always dismisses the dialog (WCAG 2.1.2). It used to step back
         one screen inside the flow instead, so from a platform list it took
         several presses before anything closed. */
      close();
      return;
    }
    if (event.key === "Tab") {
      const focusable = panel.querySelectorAll(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-ip-close]").addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  /* First paint, then load the build registry and re-render the chips once we
     know which platforms actually have a published build. */
  state.step = options.platform ? "platform" : "device";
  render();
  focusFirst();

  loadBuilds().then(async (builds) => {
    const resolved = {};
    await Promise.all(
      Object.keys(PLATFORMS).map(async (key) => {
        const build = await probeBuild(builds[key]);
        if (build) resolved[key] = build;
      })
    );
    state.builds = resolved;
    if (state.step !== "device") render({ announce: false });
  });

  openInstance = { close, state };
  return openInstance;
}

/* ------------------------------------------------------------------ trigger */

function syncTriggers() {
  const installed = isInstalled();
  document.querySelectorAll("[data-install-open]").forEach((trigger) => {
    if (installed) {
      trigger.setAttribute("hidden", "");
      trigger.setAttribute("aria-hidden", "true");
    } else {
      trigger.removeAttribute("hidden");
      trigger.removeAttribute("aria-hidden");
    }
  });
}

/** Bind every [data-install-open] control on the page. */
export function initInstallPanel() {
  syncTriggers();

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-install-open]");
    if (!trigger) return;
    event.preventDefault();
    openTrigger = trigger;
    openInstallPanel();
  });

  window.addEventListener("shinzora:installed", syncTriggers);
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", syncTriggers);
}

export default openInstallPanel;
