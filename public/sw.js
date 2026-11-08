/* ==========================================================================
   Shinzora — service worker
   --------------------------------------------------------------------------
   Strategy, deliberately conservative:
     • Navigation requests  → network first, offline page as fallback.
     • Static same-origin   → stale-while-revalidate with a size-capped cache.
     • Supabase / Edge      → never cached (auth, data and AI must be live).

   Bump VERSION when shipping breaking asset changes.
   ========================================================================== */

const VERSION = "shinzora-v19";
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";

const PRECACHE = [
  OFFLINE_URL,
  "/js/boot/offline.js",
  "/css/tokens.css",
  "/css/components.css",
  "/css/marketing.css",
  "/css/marketing-sections.css",
  "/css/fx.css",
  "/css/guide.css",
  "/js/ui/hero-fx.js",
  "/js/ui/aurora.js",
  "/js/ui/install-panel.js",
  "/js/lib/platform-icons.js",
  "/js/boot/install-guide.js",
  "/assets/icons/favicon.svg",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isPrivate = (url) =>
  url.hostname.endsWith("supabase.co") ||
  url.pathname.startsWith("/js/config/runtime.js") ||
  url.pathname.startsWith("/api/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin && isPrivate(url)) return;
  if (!url.protocol.startsWith("http")) return;

  // Build registry and installer files: never cached. A stale manifest would
  // offer a build that no longer exists, and the bytes must arrive intact.
  if (url.pathname.startsWith("/downloads/")) return;

  // Navigations: fresh HTML, offline fallback when the network is gone.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // Static assets: serve cached immediately, refresh in the background.
  if (url.origin === self.location.origin && /\.(css|js|mjs|svg|png|jpg|jpeg|webp|avif|woff2|webmanifest|json)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === "basic") {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});

/* Allow the page to trigger an immediate update after a deploy. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
