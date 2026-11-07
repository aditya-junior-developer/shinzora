/* ==========================================================================
   Shinzora — install instructions
   --------------------------------------------------------------------------
   Honest PWA installation: if the browser fires `beforeinstallprompt` we show a
   real button wired to that event. Otherwise we show the manual steps for the
   visitor's platform. Nothing pretends an app package exists.
   ========================================================================== */

const STEPS = {
  chrome: [
    ["Open the install prompt", "Click the install icon in the address bar (a small screen with an arrow), or open the three-dot menu and choose Install Shinzora."],
    ["Confirm", "The browser asks for confirmation. Accept — Shinzora opens in its own window from now on."],
    ["Sign in once", "Your session persists, so the app opens straight to your dashboard."]
  ],
  android: [
    ["Use Chrome", "Open shinzora.in in Chrome on Android."],
    ["Add to home screen", "Tap the three-dot menu, then Add to Home screen. Chrome may show an install banner instead — accept it."],
    ["Launch from the icon", "The Shinzora icon appears with your other apps and opens full screen, without the browser bar."]
  ],
  ios: [
    ["Use Safari", "On iPhone or iPad, installation only works from Safari. Open shinzora.in in Safari."],
    ["Share, then Add to Home Screen", "Tap the Share button at the bottom, scroll and tap Add to Home Screen."],
    ["Confirm the name", "Keep the suggested name and tap Add. The app appears on your home screen."],
    ["Sign in once", "iOS keeps the session, so future launches open directly."]
  ],
  desktop: [
    ["Safari on macOS", "Open shinzora.in in Safari 17 or later, then choose File → Add to Dock."],
    ["Or use Chrome", "Chrome and Edge both support Install from the address bar on macOS as well."],
    ["Keep it in the dock", "The app then behaves like any other Mac application, including its own window."]
  ]
};

const stepsHost = document.getElementById("steps");
const platformButtons = Array.from(document.querySelectorAll("[data-platform]"));
const installButton = document.getElementById("native-install");
const banner = document.getElementById("installed-banner");

let deferredPrompt = null;
let platform = detectPlatform();

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh/.test(ua)) return "desktop";
  return "chrome";
}

function paint() {
  const steps = STEPS[platform] || STEPS.chrome;
  stepsHost.innerHTML = steps
    .map(
      ([title, detail], index) => `<article class="step">
        <span class="step-num">${index + 1}</span>
        <div><h3>${title}</h3><p>${detail}</p></div>
      </article>`
    )
    .join("");

  platformButtons.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.platform === platform));
  });
}

platformButtons.forEach((button) => {
  button.addEventListener("click", () => {
    platform = button.dataset.platform;
    paint();
  });
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installButton.hidden = false;
});

installButton?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null;
  installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  banner.classList.add("is-visible");
  installButton.hidden = true;
});

if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) {
  banner.classList.add("is-visible");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* registration failures are non-fatal; the page still works */
  });
}

paint();
