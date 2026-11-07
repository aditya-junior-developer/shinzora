/* ==========================================================================
   Shinzora — pre-launch session bridge (browser side)
   --------------------------------------------------------------------------
   The two pre-launch accounts are authenticated by the Shinzora server, not by
   Supabase Auth. This module is the single place the frontend learns about that
   session, so nothing else in the codebase needs to know which mode it is in:

     session()            who the server says is signed in (or nobody)
     asSupabaseSession()  the same session shaped like a supabase-js session, so
                          existing guards and views keep working untouched
     prelaunchFetch()     the fetch used by supabase-js: when a pre-launch
                          session is active, database / function / storage
                          calls are routed to the Shinzora server instead of
                          the Supabase project
     signIn()             password sign-in for the two pre-launch accounts;
                          returns { handled:false } for every other address so
                          the caller falls through to Supabase Auth unchanged

   No credential of any kind lives in this file. The server issues an HttpOnly
   cookie; this script can neither read nor forge it.
   ========================================================================== */

import { env } from "../config/env.js";
import { markPrelaunchHint, clearPrelaunchHint, hasPrelaunchHint, PRELAUNCH_PROBE_LIMIT_MS } from "./session-policy.js";

const API = "/api/prelaunch";
const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : fetch;

/* ------------------------------------------------------------------ state */
const cache = {
  probed: false,
  available: false,
  session: null,
  checkedAt: 0
};

let probePromise = null;

function safeJson(response) {
  return response.json().catch(() => null);
}

/**
 * Ask the server who is signed in. Cached for a short window so a page that
 * makes many calls does not hammer the endpoint; `force` bypasses the cache.
 */
export function session({ force = false } = {}) {
  /* A static host does not mount /api/prelaunch at all, and probing it put a
     404 (or an aborted request) in the console of every page that resolves
     identity. Probe only where the route exists, or where this browser has
     actually signed in to a sandbox account before. */
  if (!env.prelaunchApi && !hasPrelaunchHint()) {
    cache.probed = true;
    cache.available = false;
    cache.session = null;
    cache.checkedAt = Date.now();
    return Promise.resolve(null);
  }
  if (!force && cache.probed && Date.now() - cache.checkedAt < 15000) {
    return Promise.resolve(cache.session);
  }
  if (!force && probePromise) return probePromise;

  probePromise = (async () => {
    try {
      const response = await nativeFetch(`${API}/auth/session`, {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
        /* A probe that never answers must not hold a page hostage; after this
           the app proceeds as "no sandbox session" and Supabase auth carries on. */
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(PRELAUNCH_PROBE_LIMIT_MS)
          : undefined
      });
      cache.available = response.ok;
      const data = response.ok ? await safeJson(response) : null;
      cache.session = data && data.authenticated ? data : null;
    } catch {
      /* Static hosting without the API, or offline: behave exactly like the
         Supabase-only build this file ships alongside. */
      cache.available = false;
      cache.session = null;
    }
    cache.probed = true;
    cache.checkedAt = Date.now();
    probePromise = null;
    return cache.session;
  })();

  return probePromise;
}

/** The pre-launch session, awaitable and synchronously inspectable afterwards. */
export function current() {
  return cache.session;
}

/** True once a pre-launch account is signed in on this browser. */
export function active() {
  return Boolean(cache.session);
}

/** Shape a pre-launch session like a supabase-js session. */
export function asSupabaseSession(pl) {
  if (!pl) return null;
  const user = {
    id: pl.id,
    email: pl.email,
    aud: "prelaunch",
    role: "authenticated",
    created_at: new Date().toISOString(),
    user_metadata: {
      full_name: pl.name || "",
      prelaunch: true,
      account_role: pl.role
    },
    app_metadata: { provider: "prelaunch", providers: ["prelaunch"] }
  };
  return {
    access_token: null,
    token_type: "prelaunch",
    expires_at: pl.expiresAt ? Math.floor(Date.parse(pl.expiresAt) / 1000) : null,
    expires_in: null,
    refresh_token: null,
    user,
    prelaunch: true
  };
}

/* -------------------------------------------------------------- sign in/out */

/**
 * Try the pre-launch sign-in endpoint.
 * @returns {Promise<{handled:boolean, session?:object, reason?:string}>}
 *  - handled:false  → the address is not a pre-launch account (or the API is
 *                     not deployed); the caller should use Supabase Auth.
 *  - handles:true   → signed in; `session` is a supabase-shaped session.
 * Throws an Error with `.code`/`.status` when the password is wrong for a
 * pre-launch account, so the UI can show the real reason.
 */
export async function signIn(email, password) {
  let response;
  try {
    response = await nativeFetch(`${API}/auth/login`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password })
    });
  } catch {
    return { handled: false, reason: "api_unreachable" };
  }

  const data = await safeJson(response);
  if (!response.ok) {
    const error = new Error(data?.error || "Sign in failed.");
    error.code = data?.code || "prelaunch_login_failed";
    error.status = response.status;
    error.prelaunch = true;
    throw error;
  }

  if (!data || data.prelaunch !== true) return { handled: false, reason: data?.reason || "not_prelaunch_account" };

  cache.probed = true;
  cache.available = true;
  cache.session = data.session;
  cache.checkedAt = Date.now();
  /* Remember that this browser uses the sandbox, so later page loads know they
     must wait for the probe before sending Supabase traffic to the API. */
  markPrelaunchHint();
  return { handled: true, session: asSupabaseSession(data.session) };
}

/** End the pre-launch session (server clears the cookie). */
export async function signOut() {
  try {
    await nativeFetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      /* A sign-out that waits on a cold serverless function is the reason
         "Sign out" appeared to do nothing. Give it a short, fixed window; the
         cookie is cleared locally either way and the server call is best-effort. */
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(2500)
        : undefined
    });
  } catch {
    /* nothing to do — the cookie is cleared by the server when it is reachable */
  }
  cache.session = null;
  cache.checkedAt = Date.now();
  clearPrelaunchHint();
}

/* --------------------------------------------------- supabase-js transport */

const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(env.supabaseUrl, location.origin).origin;
  } catch {
    return null;
  }
})();

function rewriteUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl, location.origin);
  } catch {
    return rawUrl;
  }
  if (!SUPABASE_ORIGIN || url.origin !== SUPABASE_ORIGIN) return rawUrl;

  const path = url.pathname;
  let mapped = null;
  if (path.startsWith("/rest/v1/")) mapped = `${API}${path}`;
  else if (path.startsWith("/storage/v1/")) mapped = `${API}${path}`;
  else if (path.startsWith("/functions/v1/")) mapped = `${API}/fn/${path.slice("/functions/v1/".length)}`;
  if (!mapped) return rawUrl;

  const search = url.search || "";
  return `${mapped}${search}`;
}

/**
 * fetch used by supabase-js. Transparent passthrough unless a pre-launch
 * session is active.
 */
export async function prelaunchFetch(input, init = {}) {
  /* Only wait for the probe when this browser has a sandbox session to find.
     Everyone else resolves from the in-memory cache — synchronously when it is
     empty — so normal Supabase traffic never queues behind /api/prelaunch. */
  const pl = hasPrelaunchHint() ? await session() : current();
  if (!pl) return nativeFetch(input, init);

  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const rawUrl = isRequest ? input.url : String(input);
  const target = rewriteUrl(rawUrl);
  if (target === rawUrl) return nativeFetch(input, init);

  const options = { ...init, credentials: "same-origin", cache: "no-store" };
  const headers = new Headers(options.headers || (isRequest ? input.headers : undefined));
  /* The Supabase anon key is meaningless to the Shinzora server; drop credentials
     it would otherwise treat as authoritative. */
  headers.delete("authorization");
  headers.delete("apikey");
  options.headers = headers;

  return nativeFetch(target, options);
}

/* --------------------------------------------------------------- storage */

/** Local public URL for a sandbox upload (replaces the Supabase storage URL). */
export function publicUrl(bucket, path) {
  return `${API}/storage/v1/object/public/${bucket}/${path}`;
}

/** Rewrite any Supabase storage public URL to the sandbox equivalent. */
export function rewriteStorageUrl(url) {
  if (!url || !SUPABASE_ORIGIN) return url;
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== SUPABASE_ORIGIN) return url;
    if (!parsed.pathname.startsWith("/storage/v1/object/public/")) return url;
    return `${API}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Patch the shared client so `storage.from(bucket).getPublicUrl(path)` returns a
 * URL the browser can actually load while in pre-launch mode. supabase-js builds
 * that URL from the project origin, which is not where sandbox uploads live.
 */
export function patchStorage(client) {
  if (!client?.storage || typeof client.storage.from !== "function") return;
  if (client.storage.from.__prelaunchPatched) return;

  const originalFrom = client.storage.from.bind(client.storage);
  const patchedFrom = (bucket) => {
    const api = originalFrom(bucket);
    const originalGetPublicUrl = api.getPublicUrl.bind(api);
    api.getPublicUrl = (path, options) => {
      const result = originalGetPublicUrl(path, options);
      if (!active()) return result;
      const local = publicUrl(bucket, path);
      return { ...result, data: { ...(result?.data || {}), publicUrl: local } };
    };
    return api;
  };
  patchedFrom.__prelaunchPatched = true;
  client.storage.from = patchedFrom;
}

/* ------------------------------------------------- error + activity reports */

let reporting = false;

/** Report a client-side failure to the pre-launch monitor (never throws). */
export async function report(kind, payload = {}) {
  if (reporting) return;
  const pl = cache.session;
  if (!pl) return;
  reporting = true;
  try {
    await nativeFetch(`${API}/events`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: kind,
        view: location.pathname,
        url: location.href,
        ...payload
      })
    });
  } catch {
    /* monitoring is best-effort and must never affect the page */
  } finally {
    reporting = false;
  }
}

export function logActivity(message, meta = {}) {
  return report("feature.use", { message, meta });
}

/** Catch uncaught errors while a pre-launch account is signed in. */
export function watchErrors() {
  if (typeof window === "undefined" || window.__shinzoraPrelaunchWatch) return;
  window.__shinzoraPrelaunchWatch = true;

  window.addEventListener("error", (event) => {
    if (!cache.session) return;
    report("client.error", {
      message: event.message || "Uncaught error",
      source: event.filename || "",
      stack: event.error?.stack || "",
      message_detail: `${event.lineno || 0}:${event.colno || 0}`
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (!cache.session) return;
    const reason = event.reason;
    report("client.error", {
      message: reason?.message || String(reason || "Unhandled promise rejection"),
      stack: reason?.stack || ""
    });
  });
}

/* ------------------------------------------------------------------ boot */

/** Probe once on load so the first database call already knows the mode. */
export function boot() {
  watchErrors();
  return session();
}

export default { session, current, active, asSupabaseSession, signIn, signOut, prelaunchFetch, patchStorage, publicUrl, rewriteStorageUrl, report, logActivity, watchErrors, boot };
