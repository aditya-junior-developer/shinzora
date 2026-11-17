/* ==========================================================================
   SHINZORA CONNECT — loads Daily's call client on demand
   --------------------------------------------------------------------------
   The SDK is bundled into public/js/vendor/daily-js.js by scripts/build-vendor
   and served from our own origin, so the page's Content-Security-Policy only
   has to allow Daily's servers for media. It is loaded the first time a
   meeting is opened, not on every page.
   ========================================================================== */

let loading = null;

export function dailyLoaded() {
  return typeof window !== "undefined" && Boolean(window.DailyIframe?.createCallObject);
}

export function loadDailySdk() {
  if (dailyLoaded()) return Promise.resolve(window.DailyIframe);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/js/vendor/daily-js.js";
    script.async = true;
    script.onload = () => {
      if (dailyLoaded()) resolve(window.DailyIframe);
      else {
        loading = null;
        reject(new Error("The video client loaded without its call library. Reload the page."));
      }
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("The video client could not be loaded. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Can this browser run a Daily call at all? Mobile in-app browsers often cannot. */
export function callSupport() {
  try {
    const info = window.DailyIframe?.supportedBrowser?.();
    if (info && info.supported === false) {
      return { ok: false, reason: "This browser cannot run video calls. Open the meeting in Chrome, Safari, Edge or Firefox." };
    }
  } catch {
    /* the SDK answers for itself once loaded; before that we do not block */
  }
  return { ok: true, reason: "" };
}

/** Whether this browser can offer screen sharing at all. */
export function screenShareAvailable() {
  return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function");
}
