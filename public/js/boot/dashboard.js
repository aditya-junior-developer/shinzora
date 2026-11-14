/* ==========================================================================
   Shinzora — dashboard entry
   --------------------------------------------------------------------------
   Guard the route, hydrate identity, build the shell, then start the router.

   Order matters and so does failure handling. Everything after the guard used
   to run bare, so one rejected promise anywhere in identity resolution took
   the whole entry module down: no sidebar, no content, no message, no retry —
   an empty dashboard that looked like a deleted account. Every step below is
   now individually guarded, and the shell (sidebar + chrome) is painted before
   anything that touches the network, so navigation survives a bad boot.
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import { qs, param } from "../lib/dom.js";
import { requireSession, watchSession, logoutEverywhere } from "../lib/guard.js";
import { loadIdentity, state, shellIdentity, applyShellIdentity } from "../lib/store.js";
import { renderSidebar, paintIdentity, bindChrome, subscribeNotifications, paintNotificationBadge } from "../modules/dashboard/shell.js";
import { start as startRouter, currentView, landingView } from "../modules/dashboard/router.js";
import { paintBootFailure, paintIdentityWarning } from "../modules/dashboard/boot-error.js";
import { initInstallPrompt } from "../ui/pwa.js";
import { toast } from "../ui/toast.js";

hydrateIcons();

/* Human names for the identity queries, so a partial failure reads as
   "Business details didn't load" rather than naming a table. */
const AREA_LABELS = {
  profile: "Your profile",
  business: "Your business details",
  subscription: "Your plan",
  onboarding: "Your setup progress",
  admin: "Your access level",
  notifications: "Your notification count"
};

/* The remembered identity is a fallback for exactly one decision: which
   navigation to draw. The database remains the authority everywhere else. */
let remembered = null;
function rememberedIdentity() {
  if (!remembered) {
    try {
      remembered = shellIdentity();
    } catch {
      remembered = null;
    }
  }
  return remembered;
}

function identitySeed() {
  try {
    return applyShellIdentity();
  } catch {
    return false;
  }
}

function landingViewFor(identity) {
  if (!identity) return landingView();
  return identity.accountType === "agent" ? "freelancer" : landingView();
}

/** Steps that must never prevent the shell from appearing. */
function step(label, fn) {
  try {
    return fn();
  } catch (error) {
    console.error(`[shinzora] ${label} failed:`, error);
    return null;
  }
}

async function paintShell(initialView) {
  step("sidebar", () => renderSidebar(initialView));
  step("identity chrome", () => paintIdentity());
  step("icons", () => hydrateIcons());
  step("chrome", () => bindChrome({ navigate: (view) => (location.href = `/app/?view=${view}`) }));
  window.addEventListener("shinzora:view", (event) => {
    step("sidebar", () => renderSidebar(event.detail.view));
    step("icons", () => hydrateIcons());
  });
}

async function boot() {
  const gate = await requireSession({ next: location.pathname + location.search });

  if (!gate.ok) {
    /* Two very different "no": the guard already redirected a signed-out user,
       but an unreachable server must not be treated as a logout. Paint the
       shell with the default navigation plus a retry panel so the user keeps
       their place and knows what happened. */
    if (gate.reason === "unavailable") {
      /* Paint the shell from the last known identity so an agent keeps their
         own navigation while the server is unreachable, instead of being
         handed the business-owner menu. */
      if (identitySeed()) await paintShell(landingView());
      else await paintShell(landingViewFor(rememberedIdentity()));
      paintBootFailure(qs("#view-root"), gate.error, { onRetry: () => location.reload() });
    }
    return;
  }

  let identityError = gate.identityError || null;

  /* The guard has already loaded identity (one profile, business, subscription,
     onboarding and notification round trip). Load again only when it did not,
     so every dashboard open does not pay for the same six queries twice. */
  if (!identityError && !gate.identityLoaded) {
    try {
      await loadIdentity({ force: true });
    } catch (error) {
      identityError = error;
      console.error("[shinzora] identity load failed:", error);
    }
  }

  const identity = rememberedIdentity();
  const initialView =
    new URLSearchParams(location.search).get("view") ||
    (identity && identity.accountType === "agent" && !state.profile ? "freelancer" : landingView());
  await paintShell(initialView);

  if (identityError) {
    paintIdentityWarning(identityError, { onRetry: () => location.reload() });
  } else if (Array.isArray(state.identityFailures) && state.identityFailures.length) {
    /* Part of the identity payload is missing but the rest is usable; name the
       area that failed instead of silently showing a thinner workspace. */
    const first = state.identityFailures[0];
    paintIdentityWarning(first.error, { area: AREA_LABELS[first.area] || null, onRetry: () => location.reload() });
  }

  try {
    await startRouter();
  } catch (error) {
    console.error("[shinzora] router failed:", error);
    paintBootFailure(qs("#view-root"), error, { onRetry: () => startRouter().catch(() => location.reload()) });
  }
  step("icons", () => hydrateIcons());

  step("notifications badge", () => paintNotificationBadge());
  step("notifications", () => subscribeNotifications());
  step("session watch", () => watchSession(() => logoutEverywhere()));
  step("install prompt", () => initInstallPrompt());

  // Contextual first-run messages
  if (param("welcome")) {
    toast(
      { title: "Your workspace is ready", message: "Start with the AI builder or ask the assistant anything." },
      { tone: "success", duration: 6000 }
    );
  }
  if (param("view") === "billing" && param("plan")) {
    toast({ title: "Plan selected", message: "Complete the payment below to activate it." }, { tone: "info" });
  }
  void currentView;
}

boot().catch((error) => {
  /* Last resort: even a failure outside the guarded steps leaves something to
     read and something to click. */
  console.error("[shinzora] boot failed:", error);
  paintBootFailure(qs("#view-root"), error, { onRetry: () => location.reload() });
});
