/* ==========================================================================
   Shinzora — route guards
   --------------------------------------------------------------------------
   Every protected surface calls one of these before rendering. They use the
   cached session from supabase-js (refreshed automatically) and redirect with
   a `next` parameter so the user returns to where they were headed.
   ========================================================================== */

import { sb, getSession, signOut } from "./supabase.js";
import { loadIdentity, state, hasCompletedOnboarding, resetIdentity } from "./store.js";
import { retrySession, classifySessionError, withDeadline, SESSION_LOOKUP_LIMIT_MS } from "./identity-retry.js";
import { toast } from "../ui/toast.js";

const withNext = (base, next) => {
  if (!next) return base;
  const url = new URL(base, location.origin);
  url.searchParams.set("next", next);
  return url.pathname + url.search;
};

/* A boot overlay that never goes away is the worst failure mode in the app:
   the user cannot tell a slow network from a broken build. Every overlay gets
   a watchdog, and a data-boot-timeout attribute is left on <html> so the state
   is visible in the console and in automated checks rather than being a silent
   hang. `hideBootOverlay()` clears the timer. */
let bootWatchdog = 0;
const BOOT_LIMIT_MS = 12000;

/** Full-page loader used while guards resolve. */
export function showBootOverlay(label = "Preparing your workspace") {
  if (document.querySelector("[data-boot]")) return;
  const node = document.createElement("div");
  node.setAttribute("data-boot", "");
  node.innerHTML = `
    <div class="boot-screen">
      <div class="boot-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" width="40" height="40" fill="none">
          <path d="M20 3.5 34.5 11v18L20 36.5 5.5 29V11L20 3.5Z" stroke="url(#bg1)" stroke-width="1.6"/>
          <path d="M20 12.4 27.4 16.6v8.8L20 29.6l-7.4-4.2v-8.8L20 12.4Z" fill="url(#bg2)"/>
          <defs>
            <linearGradient id="bg1" x1="5" y1="4" x2="36" y2="36"><stop stop-color="#c9b8f5"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
            <linearGradient id="bg2" x1="13" y1="12" x2="28" y2="30"><stop stop-color="#a855f7"/><stop offset="1" stop-color="#4f1d91"/></linearGradient>
          </defs>
        </svg>
      </div>
      <div class="boot-text">${label}<span class="boot-dots"><i></i><i></i><i></i></span></div>
    </div>`;
  document.body.append(node);

  clearTimeout(bootWatchdog);
  bootWatchdog = setTimeout(() => {
    /* Resolution has taken too long. Release the page and tell the truth
       instead of spinning forever. */
    hideBootOverlay();
    document.documentElement.setAttribute("data-boot-timeout", String(Date.now()));
    console.warn("[shinzora] boot overlay timed out after", BOOT_LIMIT_MS, "ms");
  }, BOOT_LIMIT_MS);
}

export function hideBootOverlay() {
  clearTimeout(bootWatchdog);
  bootWatchdog = 0;
  document.querySelectorAll("[data-boot]").forEach((node) => node.remove());
}

/**
 * Require a signed-in session.
 * @param {{onboarding?:boolean, admin?:boolean, redirect?:string, next?:string}} opts
 * @returns {Promise<{session:object, ok:boolean}>}
 */
export async function requireSession(opts = {}) {
  showBootOverlay();
  let session = null;
  try {
    /* A dropped connection is worth a second attempt; a dead refresh token is
       not. Retrying the first and signing out for the second is the whole
       difference between "slow network" and "you were logged out". */
    session = await withDeadline(
      retrySession(() => getSession()),
      SESSION_LOOKUP_LIMIT_MS,
      "Checking your session"
    );
  } catch (error) {
    hideBootOverlay();
    const kind = classifySessionError(error);
    console.warn("[shinzora] session lookup failed:", kind, error?.message);

    if (kind === "auth") {
      /* The stored session is genuinely unusable. Clear it so the next visit
         starts clean, and ask for a sign-in instead of looping on a dead token. */
      try {
        await signOut();
      } catch {
        /* signing out locally is enough; the token is already dead */
      }
      resetIdentity();
      const next = opts.next || location.pathname + location.search;
      location.replace(withNext(opts.redirect || "/auth/login/?reason=session_expired", next));
      return { session: null, ok: false, reason: "auth", error };
    }

    toast({ title: "Could not restore your session", message: "Check your connection, then try again." }, { tone: "error" });
    /* Deliberately not a redirect: the user is probably still signed in, and
       sending them to the login page would look like a logout. The caller
       renders a retry panel instead. */
    return { session: null, ok: false, reason: "unavailable", error };
  }
  if (!session) {
    hideBootOverlay();
    const next = opts.next || location.pathname + location.search;
    location.replace(withNext(opts.redirect || "/auth/login/", next));
    return { session: null, ok: false, reason: "signed_out" };
  }

  try {
    await loadIdentity({ force: true });
  } catch (error) {
    hideBootOverlay();
    console.warn("[shinzora] identity load failed:", error?.message);
    /* The session is real; only the data behind it is missing. Returning
       ok:false here used to abandon the shell entirely — an empty sidebar and
       an empty page with a toast that disappeared. Report the failure instead
       and let the caller paint a usable, retryable shell. */
    return { session, ok: true, identityError: error };
  }

  if (opts.admin && state.isAdmin !== true) {
    hideBootOverlay();
    toast({ title: "Administrator access required", message: "This area is restricted to Shinzora administrators." }, { tone: "error" });
    location.replace("/app/");
    return { session, ok: false };
  }

  if (opts.onboarding && !hasCompletedOnboarding()) {
    hideBootOverlay();
    location.replace("/onboarding/");
    return { session, ok: false };
  }

  hideBootOverlay();
  return { session, ok: true };
}

/** Used on auth pages: bounce already-signed-in users to their workspace. */
export async function redirectIfSignedIn() {
  const session = await getSession();
  if (!session) return false;
  await loadIdentity({ force: true });
  location.replace(state.isAdmin && !hasCompletedOnboarding() ? "/admin/" : hasCompletedOnboarding() ? "/app/" : "/onboarding/");
  return true;
}

/**
 * Watch for sign-out (including in another tab) and leave protected pages.
 * supabase-js fires SIGNED_OUT for token revocation too.
 */
/**
 * Notice that the session has ended and tell the caller.
 *
 * Three ways a session can end while a tab is open, all of which used to leave
 * the UI showing a signed-in shell:
 *   - this tab signs out                       → onAuthStateChange(SIGNED_OUT)
 *   - another tab signs out                    → storage event on the auth key
 *   - the refresh token is revoked or expires  → checked when the tab is
 *                                                looked at again
 *
 * The last two only fire `onSignedOut` when the local session is genuinely
 * gone; a failed check while offline is not a sign-out.
 */
/** The key supabase-js persists the session under (see lib/supabase.js). */
const AUTH_STORAGE_KEY = "shinzora.auth";

export function watchSession(onSignedOut) {
  const fire = () => {
    resetIdentity();
    onSignedOut?.();
  };

  const teardown = [];
  if (sb) {
    const { data } = sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") fire();
    });
    if (data?.subscription?.unsubscribe) teardown.push(() => data.subscription.unsubscribe());
  }

  /* Cross-tab sign-out. supabase-js writes the session under the configured
     storageKey, so a removal of that key is the other tab ending the session. */
  const onStorage = (event) => {
    if (event.key && sb && !event.newValue) {
      const key = event.key;
      if (key === AUTH_STORAGE_KEY || key.endsWith("-auth-token")) {
        if (!sb.auth.getSession) fire();
      }
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  teardown.push(() => window.removeEventListener("storage", onStorage));

  /* Coming back to a tab that has been asleep is when an expired or revoked
     session is discovered. Clear the shell rather than let the next click fail. */
  let checking = false;
  const recheck = async () => {
    if (checking || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const session = await getSession();
      if (!session) fire();
    } catch {
      /* transient: never sign somebody out because a request failed */
    } finally {
      checking = false;
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", recheck);
    teardown.push(() => document.removeEventListener("visibilitychange", recheck));
  }

  return () => teardown.forEach((fn) => fn());
}

/**
 * Sign out of this browser.
 *
 * The order matters, and it used to be wrong in two ways:
 *
 *   • it waited for the auth server before changing anything, so a slow or
 *     unreachable endpoint left the customer sitting on a dashboard they had
 *     already asked to leave ("sign out takes too long / never returns")
 *   • it landed on /auth/login/, not the public homepage, so the homepage never
 *     showed Sign In / Get Started again — the state the rest of the app keys on
 *     was still "signed in" until a manual reload
 *
 * Now: stop background work, clear the session (bounded — signOut gives the
 * server a short, fixed window), wipe cached identity, then go to the homepage.
 * Nothing here can hang: every step either completes or is abandoned on time.
 */
export async function logoutEverywhere() {
  /* Tell anything holding a live subscription, timer or open channel to stop.
     The dashboard listens for this and unsubscribes. */
  try {
    window.dispatchEvent(new CustomEvent("shinzora:signing-out"));
  } catch {
    /* older browsers: nothing to notify */
  }

  try {
    await signOut("local");
  } catch (error) {
    console.warn("[shinzora] sign out:", error?.message);
  }

  resetIdentity();
  /* Clear anything the app cached on this browser for the signed-in user. */
  try {
    sessionStorage.removeItem("shinzora.intent.plan");
  } catch {
    /* storage blocked */
  }

  location.replace("/?signedOut=1");
}
