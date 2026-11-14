/* ==========================================================================
   Shinzora — PWA installation
   Registers the service worker and offers a dismissible install promotion.
   We only ever show the prompt when the browser actually fires
   `beforeinstallprompt` (Chromium) or when iOS Safari instructions apply —
   never a fake download button.
   ========================================================================== */

const DISMISS_KEY = "shinzora.install.dismissed";
const DISMISS_DAYS = 21;

let deferredPrompt = null;

/**
 * The browser fires `beforeinstallprompt` once, early, and the event can only
 * be used while it is held. Capturing it at module scope means the header's
 * "Get app" panel can offer a real install even though the dismissible banner
 * is the only other consumer.
 */
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    window.dispatchEvent(new CustomEvent("shinzora:installable"));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent("shinzora:installed"));
  });
}

/** True when the browser has offered a native install prompt we can still use. */
export function canPromptInstall() {
  return Boolean(deferredPrompt);
}

/** True when the app is already running as an installed application. */
export function isInstalled() {
  return isStandalone();
}

/**
 * Trigger the native install prompt. Resolves with the browser's own outcome —
 * never a fabricated one.
 * @returns {Promise<{outcome: "accepted"|"dismissed"|"unavailable"}>}
 */
export async function promptInstall() {
  if (!deferredPrompt) return { outcome: "unavailable" };
  const event = deferredPrompt;
  deferredPrompt = null;
  event.prompt();
  const choice = await event.userChoice.catch(() => null);
  return { outcome: choice?.outcome === "accepted" ? "accepted" : "dismissed" };
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  /* A new worker taking control means this tab is running yesterday's CSS and
     JS out of the old cache — the classic "I deployed but nothing changed"
     symptom. Reload once, guarded so it can never become a reload loop. */
  let reloaded = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });

  /* Register once the page has loaded. Pages whose boot waits on the network
     (the dashboard) call this after the load event has already fired, so the
     listener alone would never run and the worker would never install. */
  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        /* Check for a new deploy on every load, and again when the tab
           regains focus, so a long-lived tab picks up the next version. */
        registration.update().catch(() => undefined);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") registration.update().catch(() => undefined);
        });
      })
      .catch((error) => console.warn("[shinzora] service worker registration failed:", error?.message));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function dismissedRecently() {
  try {
    const value = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return value && Date.now() - value < DISMISS_DAYS * 86400000;
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* storage may be blocked */
  }
}

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

/**
 * Wire up the install UI. Looks for #install-prompt / #install-accept /
 * #install-dismiss in the document; silently does nothing if absent.
 */
export function initInstallPrompt() {
  registerServiceWorker();

  const banner = document.getElementById("install-prompt");
  if (!banner || isStandalone() || dismissedRecently()) return;

  const accept = document.getElementById("install-accept");
  const dismiss = document.getElementById("install-dismiss");

  const show = () => {
    banner.hidden = false;
    requestAnimationFrame(() => banner.classList.add("is-visible"));
  };
  const hide = () => {
    banner.classList.remove("is-visible");
    setTimeout(() => {
      banner.hidden = true;
    }, 380);
  };

  dismiss?.addEventListener("click", () => {
    rememberDismissal();
    hide();
  });

  accept?.addEventListener("click", async () => {
    if (canPromptInstall()) {
      const { outcome } = await promptInstall();
      if (outcome === "accepted") {
        rememberDismissal();
        hide();
      }
      return;
    }
    // No native prompt available (Safari / Firefox): send the visitor to the
    // instructions page rather than pretending an install happened.
    location.href = "/install/";
  });

  // beforeinstallprompt / appinstalled are captured at module scope; react here.
  window.addEventListener("shinzora:installable", () => {
    if (!dismissedRecently()) show();
  });

  window.addEventListener("shinzora:installed", () => {
    rememberDismissal();
    hide();
  });

  // iOS never fires beforeinstallprompt; offer the manual route after a pause.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIos) setTimeout(show, 12000);
}

export default initInstallPrompt;
