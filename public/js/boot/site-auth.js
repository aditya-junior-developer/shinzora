/* ==========================================================================
   Shinzora — public-site header authentication state
   --------------------------------------------------------------------------
   The marketing homepage used to render one header for everybody: Sign in and
   Get started, whether or not the visitor was signed in. A signed-in customer
   therefore saw "Get started" on the site they already belonged to, and there
   was no way back into the dashboard from the public pages.

   This module keeps the header honest:

     signed out → Sign in + Get started (the markup that ships in the HTML)
     signed in  → an account button that opens the right destination
                  (/admin/ for a verified administrator, /app/ for a customer),
                  plus Settings, the published site and Sign out

   Identity is resolved from the session and, for the admin flag, from the same
   server-side is_admin() function the dashboard uses — never from a name or an
   email pattern. When the session ends (here, in another tab, or because it
   expired) the header returns to Sign in + Get started immediately.
   ========================================================================== */

import { qs, esc } from "../lib/dom.js";
import { icon, hydrateIcons } from "../lib/icons.js";
import { getSession } from "../lib/supabase.js";
import { loadIdentity, state, subscribe } from "../lib/store.js";
import { logoutEverywhere } from "../lib/guard.js";
import { publishedSiteUrl, rememberPublishedSite, resolvePublishedSite } from "../lib/site-url.js";

const RESERVED = new Set(["/app", "/admin", "/onboarding", "/auth", "/install", "/system-check"]);

function initials(value) {
  const text = String(value || "").trim();
  if (!text) return "S";
  const parts = text.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "S") + (parts[1]?.[0] || "")).toUpperCase();
}

/**
 * Point the header's Sign in / Get started pair at the right places for the
 * current visitor, or replace them with the account button when signed in.
 */
function paint() {
  const host = qs(".nav-actions");
  if (!host) return;

  const signIn = qs('a[href="/auth/login/"]', host);
  const getStarted = qs('a[href^="/auth/signup/"]', host);
  const existing = qs("[data-site-account]", host);

  if (!state.session) {
    if (existing) existing.remove();
    if (signIn) signIn.hidden = false;
    if (getStarted) getStarted.hidden = false;
    return;
  }

  if (signIn) signIn.hidden = true;
  if (getStarted) getStarted.hidden = true;
  if (existing) {
    /* Already mounted: only the label needs refreshing after an identity load. */
    const label = qs("[data-site-account-initials]", existing);
    if (label) label.textContent = initials(state.profile?.full_name || state.user?.email);
    return;
  }

  const destination = state.isAdmin ? "/admin/" : "/app/";
  const who = state.profile?.full_name || state.user?.email || "Account";
  const site = publishedSiteUrl();

  const wrap = document.createElement("div");
  wrap.setAttribute("data-site-account", "");
  wrap.className = "site-account";
  wrap.innerHTML = `
    <button class="site-account-btn" type="button" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(initials(who))} — account menu for ${esc(who)}">
      <span class="site-account-avatar" data-site-account-initials>${esc(initials(who))}</span>
    </button>
    <div class="menu site-account-menu" role="menu" hidden>
      <div class="menu-label">${esc(who)}</div>
      <a class="menu-item" role="menuitem" href="${esc(destination)}">
        ${icon(state.isAdmin ? "shield-check" : "layout-dashboard", { size: 15 })}
        ${state.isAdmin ? "Admin dashboard" : "Dashboard"}
      </a>
      <a class="menu-item" role="menuitem" href="/app/?view=settings">
        ${icon("user-round", { size: 15 })} Profile &amp; settings
      </a>
      ${
        site
          ? `<a class="menu-item" role="menuitem" href="${esc(site)}" ${
              site.startsWith("/") ? "" : 'target="_blank" rel="noopener"'
            }>${icon("external-link", { size: 15 })} View public site</a>`
          : ""
      }
      <div class="menu-sep"></div>
      <button class="menu-item menu-item-danger" role="menuitem" data-site-signout>
        ${icon("log-out", { size: 15 })} Sign out
      </button>
    </div>`;

  host.insertBefore(wrap, host.querySelector(".nav-toggle"));

  const button = qs(".site-account-btn", wrap);
  const menu = qs(".site-account-menu", wrap);

  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden ? open() : close();
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      close();
      button.focus();
    }
  });

  qs("[data-site-signout]", wrap)?.addEventListener("click", async (event) => {
    event.preventDefault();
    close();
    await logoutEverywhere();
  });

  hydrateIcons(wrap);
}

/* --------------------------------------------------------------- lifecycle */

/* Repaint whenever the cached identity changes — signing in, signing out, or a
   session expiring in another tab all arrive through this subscription. */
subscribe(() => paint());

(async () => {
  try {
    const session = await getSession();
    state.session = session;
    state.user = session?.user || null;
    if (session) {
      /* One identity load is enough to know the admin flag; a failure here must
         not hide the account button, so the paint happens either way. */
      await loadIdentity({ maxAge: 15000 }).catch(() => undefined);
      /* Resolve the customer's own published site once, so the menu entry is
         present or absent on first paint rather than appearing later. */
      await resolvePublishedSite()
        .then((url) => rememberPublishedSite(url))
        .catch(() => rememberPublishedSite(null));
    }
    paint();
  } catch {
    paint();
  }
})();

/* A page restored from the back/forward cache can be stale: repaint on show. */
window.addEventListener("pageshow", (event) => {
  if (event.persisted) paint();
});

void RESERVED;
