/* ==========================================================================
   Shinzora — service worker
   --------------------------------------------------------------------------
   Strategy, deliberately conservative:
     • Navigation requests  → network first, offline page as fallback.
     • Code and styles      → network first, cache as the offline fallback.
     • Images and fonts     → stale-while-revalidate with a size-capped cache.

   Code is network-first on purpose. Serving a cached module first means a
   returning visitor runs yesterday's JavaScript against today's HTML, and the
   two disagree about how the page is built — the sidebar shipped its new markup
   while the cached shell still looked for the old toggle attribute, so the
   hamburger did nothing on the first visit after a deploy. A few milliseconds
   of latency is a better trade than a mixed-version page.
     • Supabase / Edge      → never cached (auth, data and AI must be live).

   Bump VERSION when shipping breaking asset changes.
   ========================================================================== */

const VERSION = "shinzora-v51";
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

  const sameOrigin = url.origin === self.location.origin;
  const isCode = /\.(css|js|mjs)$/.test(url.pathname);
  const isAsset = /\.(svg|png|jpg|jpeg|webp|avif|woff2|webmanifest|json)$/.test(url.pathname);

  /* Code and styles: always ask the network first. The cache is only there for
     when the network is gone, so HTML and its modules can never come from two
     different deploys. */
  if (sameOrigin && isCode) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  /* Images, fonts and icons rarely change and cost the most to re-fetch, so
     these keep the serve-cached-refresh-in-background strategy. */
  if (sameOrigin && isAsset) {
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

/* ==========================================================================
   Web Push
   --------------------------------------------------------------------------
   A message that arrives here was sent by the `push` Edge Function after the
   database already stored the notification row. The worker does not decide
   anything: it shows what it was given and opens the link it was given, so a
   push tap lands on the same group and message the in-app notice would.

   Nothing in this file claims delivery: if the browser never subscribed, or the
   function has no VAPID keys, this handler is simply never called.
   ========================================================================== */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Shinzora", body: event.data ? event.data.text() : "" };
  }

  const isMention = payload.kind === "mention" || payload.kind === "everyone";
  const title = payload.title || (payload.groupName ? `${payload.senderName || "Someone"} · ${payload.groupName}` : "Shinzora");
  const body = payload.body || "You have a new message.";
  /* A stable tag per group would collapse separate mentions; per message keeps
     every unread mention visible until it is opened or dismissed. */
  const tag = payload.messageId ? `group-${payload.groupId}-${payload.messageId}` : payload.groupId ? `group-${payload.groupId}` : "shinzora";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: Boolean(isMention),
      icon: "/assets/icons/icon-192.png",
      badge: "/assets/icons/icon-192.png",
      data: {
        url: payload.url || "/app/?view=groups",
        groupId: payload.groupId || null,
        messageId: payload.messageId || null,
        kind: payload.kind || "message"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = data.url || "/app/?view=groups";
  try {
    /* Absolute so it can be compared with existing client windows. */
    target = new URL(target, self.location.origin).href;
  } catch {
    target = `${self.location.origin}/app/?view=groups`;
  }

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = clientList.filter((client) => client.url.startsWith(self.location.origin));
      /* Focus an existing Shinzora window and tell it where to go: opening a new
         tab every time would pile up duplicate inboxes. */
      for (const client of sameOrigin) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "shinzora:open-group", url: target, groupId: data.groupId, messageId: data.messageId });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});
