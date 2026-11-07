/* ==========================================================================
   Shinzora — session policy
   --------------------------------------------------------------------------
   Small, dependency-free decisions about how the app resolves "who is signed
   in". Kept separate from the Supabase client so they can be unit-tested in
   Node without a browser, and so the reasoning lives in one place.

   The two problems this exists to solve:

   1. Every Supabase request used to wait for a network probe of
      /api/prelaunch/auth/session before it could be sent. On a static host that
      endpoint is a cold serverless function, so the first request of every page
      load paid for it — sign-in felt like a hang and a slow probe looked like a
      lost session. Now the probe only blocks when this browser has actually
      used a pre-launch account.

   2. `signOut()` awaited a network round trip with no ceiling. A slow or
      unreachable auth endpoint meant the Sign out button did nothing for as
      long as the request took. A sign-out now always finishes within a bounded
      time, and always clears local state even when the network never answers.
   ========================================================================== */

/** localStorage key that records "this browser signed in to the sandbox". */
export const PRELAUNCH_HINT_KEY = "shinzora.prelaunch";

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    /* Storage can throw outright in private modes and sandboxed iframes. */
    return null;
  }
}

/** True when this browser has used a pre-launch account before. */
export function hasPrelaunchHint() {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(PRELAUNCH_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPrelaunchHint() {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PRELAUNCH_HINT_KEY, "1");
  } catch {
    /* quota or blocked storage: the app still works, it just probes each load */
  }
}

export function clearPrelaunchHint() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PRELAUNCH_HINT_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Resolve with `work`, or with `fallback` if it takes longer than `ms`.
 * The slow promise is not cancelled — it is simply no longer on the critical
 * path, which is what a sign-out needs.
 *
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @param {T|(() => T)} fallback
 * @returns {Promise<T>}
 */
export function withTimeout(work, ms, fallback) {
  let timer = 0;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(typeof fallback === "function" ? fallback() : fallback);
    }, ms);
  });
  return Promise.race([
    Promise.resolve(work).catch(() => (typeof fallback === "function" ? fallback() : fallback)),
    limit
  ]).finally(() => clearTimeout(timer));
}

/** How long a sign-out may wait for the auth server before it stops waiting. */
export const SIGN_OUT_LIMIT_MS = 2500;

/** How long a pre-launch probe may take before the app proceeds without it. */
export const PRELAUNCH_PROBE_LIMIT_MS = 2500;
