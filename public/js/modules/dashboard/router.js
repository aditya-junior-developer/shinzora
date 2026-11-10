/* ==========================================================================
   Shinzora — dashboard router
   Views are loaded on demand (dynamic import) so the first paint of the shell
   never waits for modules the user may not open. State lives in the URL:
   /app/?view=orders&id=… so any view is linkable and reload-safe.
   ========================================================================== */

import { skeletonView, setupNotice, pageHead } from "./components.js";
import { normalizeError } from "../../lib/supabase.js";
import { state, loadIdentity, hasCompletedOnboarding } from "../../lib/store.js";
import { qs } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";

const LOADERS = {
  overview: () => import("./views/overview.js"),
  assistant: () => import("./views/assistant.js"),
  "website-builder": () => import("./views/website-builder.js"),
  "app-builder": () => import("./views/app-builder.js"),
  projects: () => import("./views/projects.js"),
  domains: () => import("./views/domains.js"),
  store: () => import("./views/store.js"),
  inventory: () => import("./views/inventory.js"),
  orders: () => import("./views/orders.js"),
  customers: () => import("./views/customers.js"),
  marketing: () => import("./views/marketing.js"),
  support: () => import("./views/support.js"),
  messages: () => import("./views/messages.js"),
  requests: () => import("./views/requests.js"),
  marketplace: () => import("./views/marketplace.js"),
  freelancer: () => import("./views/freelancer.js"),
  portfolio: () => import("./views/portfolio.js"),
  "find-team": () => import("./views/find-team.js"),
  team: () => import("./views/team.js"),
  community: () => import("./views/community.js"),
  invitations: () => import("./views/invitations.js"),
  analytics: () => import("./views/analytics.js"),
  notifications: () => import("./views/notifications.js"),
  billing: () => import("./views/billing.js"),
  settings: () => import("./views/settings.js")
};

export const DEFAULT_VIEW = "overview";

/* An agent account has no business to overview, so its front door is the
   freelancer dashboard. Explicit ?view= always wins. */
export function landingView() {
  return state.profile?.account_type === "agent" ? "freelancer" : DEFAULT_VIEW;
}

export const viewIds = () => Object.keys(LOADERS);

let current = DEFAULT_VIEW;
let token = 0;

function parseParams() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  return { view: LOADERS[view] ? view : landingView(), params };
}

/** Render a view into the root element. */
export async function render(view, params, ctx) {
  const root = qs("#view-root");
  if (!root) return;
  const myToken = ++token;
  current = view;

  root.innerHTML = `<div class="page-head">
      <div class="page-head-left">
        <div class="skeleton skeleton-line" style="width:190px;height:20px"></div>
        <div class="skeleton skeleton-line" style="width:320px;height:10px;margin-top:9px"></div>
      </div>
    </div>
    ${skeletonView(4)}`;

  try {
    const module = await LOADERS[view]();
    if (myToken !== token) return;
    root.innerHTML = "";
    await module.default(root, {
      params,
      navigate,
      refresh: () => render(view, params, ctx)
    });

    const heading = root.querySelector(".page-title");
    if (heading) document.title = `${heading.textContent.trim().replace(/\s+/g, " ")} — Shinzora`;

    // Keep the sidebar in sync even when navigation happens inside a view.
    const event = new CustomEvent("shinzora:view", { detail: { view } });
    window.dispatchEvent(event);
    root.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  } catch (error) {
    if (myToken !== token) return;
    const normalized = normalizeError(error);
    root.innerHTML = `${pageHead({ title: "Something went wrong", desc: "This view could not be loaded." })}
      ${setupNotice(normalized)}
      <div class="card card-pad-lg" style="display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center">
        ${icon("circle-alert", { size: 26, cls: "dim" })}
        <div><strong>${normalized.message}</strong></div>
        <div class="muted" style="font-size:var(--fs-xs);max-width:60ch">${normalized.detail || normalized.hint || ""}</div>
        <button class="btn btn-secondary btn-sm" id="view-retry">Try again</button>
      </div>`;
    qs("#view-retry")?.addEventListener("click", () => render(view, params, ctx));
    console.error("[shinzora] view failed:", error);
  }
}

/** Push a new view onto history and render it. */
export function navigate(view, extra = {}) {
  const search = new URLSearchParams({ view, ...extra }).toString();
  history.pushState({ view }, "", `/app/?${search}`);
  const { params } = parseParams();
  window.dispatchEvent(new CustomEvent("shinzora:navigate", { detail: { view, params } }));
  return render(view, params, {});
}

export function currentView() {
  return current;
}

/** Boot the router: render the current URL and wire navigation events. */
export async function start() {
  if (!state.session) await loadIdentity({ force: true });

  const { view, params } = parseParams();
  await render(view, params, {});

  window.addEventListener("popstate", () => {
    const next = parseParams();
    render(next.view, next.params, {});
  });

  // Sidebar links and any in-view links should not reload the document.
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.('a[href^="/app/?view="]');
    if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    const url = new URL(anchor.getAttribute("href"), location.origin);
    history.pushState({}, "", url);
    const next = parseParams();
    window.dispatchEvent(new CustomEvent("shinzora:navigate", { detail: { view: next.view, params: next.params } }));
    render(next.view, next.params, {});
  });

  window.addEventListener("shinzora:navigate", (event) => {
    const detail = event.detail || {};
    if (detail.view) {
      const nav = document.querySelectorAll("[data-nav]");
      nav.forEach((link) => link.classList.toggle("is-active", link.getAttribute("data-nav") === detail.view));
    }
  });
}

export const onboardingIncomplete = () => !hasCompletedOnboarding();
