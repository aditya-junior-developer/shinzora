/* ==========================================================================
   Shinzora Admin — shell: navigation, view loading, shared state
   ========================================================================== */

import { qs, qsa, esc, on, debounce } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { toast, toastError } from "../../ui/toast.js";
import { skeletonView, setupNotice } from "../dashboard/components.js";
import { createSidebar } from "../../ui/sidebar.js";
import { avatarMarkup } from "../../lib/avatar.js";
import { peopleMeta } from "./api.js";

/* The navigation column, created by bindShell(). */
let adminDrawer = null;

export const closeAdminDrawer = () => adminDrawer?.close();

export const NAV = [
  {
    group: "Operations",
    items: [
      { id: "overview", label: "Overview", icon: "layout-dashboard" },
      { id: "businesses", label: "Businesses", icon: "building-2" },
      { id: "customers", label: "Customers", icon: "users" },
      { id: "freelancers", label: "Freelancers", icon: "briefcase" },
      { id: "payments", label: "Payments", icon: "receipt" },
      { id: "services", label: "Service requests", icon: "briefcase" },
      { id: "marketing", label: "Marketing requests", icon: "megaphone" }
    ]
  },
  {
    group: "Platform",
    items: [
      { id: "subscriptions", label: "Subscriptions", icon: "crown" },
      { id: "projects", label: "Projects & deploys", icon: "panels-top-left" },
      { id: "support", label: "Support", icon: "life-buoy" },
      { id: "contacts", label: "Contact messages", icon: "mail" }
    ]
  },
  {
    group: "Communication",
    items: [
      { id: "chat", label: "Messages", icon: "message-square" },
      { id: "messaging", label: "Announcements", icon: "megaphone" },
      { id: "activity", label: "Activity", icon: "activity" },
      { id: "monitoring", label: "Monitoring", icon: "gauge" },
      { id: "access", label: "Administrators", icon: "shield-check" }
    ]
  }
];

const LOADERS = {
  overview: () => import("./views/overview.js"),
  businesses: () => import("./views/businesses.js"),
  customers: () => import("./views/customers.js"),
  freelancers: () => import("./views/freelancers.js"),
  payments: () => import("./views/payments.js"),
  services: () => import("./views/payments.js"),
  subscriptions: () => import("./views/operations.js"),
  projects: () => import("./views/operations.js"),
  support: () => import("./views/operations.js"),
  contacts: () => import("./views/operations.js"),
  chat: () => import("./views/chat.js"),
  messaging: () => import("./views/messaging.js"),
  activity: () => import("./views/messaging.js"),
  monitoring: () => import("./views/monitoring.js"),
  access: () => import("./views/access.js"),
  marketing: () => import("./views/marketing.js")
};

/** True when a view id has a loader. The boot screen used to keep its own copy
    of this list, so a new view (Messages, Businesses) fell back to Overview for
    anyone arriving by link. One source of truth now. */
export const viewExists = (id) => Boolean(id && LOADERS[id]);

export const adminState = {
  view: "overview",
  identity: null,
  counts: {},
  search: ""
};

export function renderNav() {
  const host = qs("#admin-nav");
  host.innerHTML = NAV.map(
    (group) => `
      <div class="admin-nav-group">${esc(group.group)}</div>
      ${group.items
        .map(
          (item) => `<button class="admin-nav-item ${item.id === adminState.view ? "is-active" : ""}" data-view="${item.id}">
            ${icon(item.icon, { size: 15 })}<span>${esc(item.label)}</span>
            ${badgeFor(item.id)}
          </button>`
        )
        .join("")}`
  ).join("");
}

function badgeFor(view) {
  const c = adminState.counts || {};
  const value =
    view === "payments"
      ? c.payments_pending
      : view === "services"
        ? c.service_pending
        : view === "support"
          ? c.tickets_open
          : view === "contacts"
            ? c.contacts_new
            : view === "marketing"
              ? c.marketing_pending
              : view === "monitoring"
              ? c.monitor_unread
              : 0;
  return value ? `<span class="count">${value}</span>` : "";
}

export async function renderView(view) {
  adminState.view = view;
  renderNav();
  const root = qs("#admin-root");
  root.innerHTML = skeletonView(3);

  try {
    const module = await LOADERS[view]();
    await module.default(root, { view, state: adminState, navigate, refresh, setCounts });
  } catch (error) {
    root.innerHTML = setupNotice(error, "This section");
  }

  const url = new URL(location.href);
  url.searchParams.set("view", view);
  history.replaceState({ viewer: "admin" }, "", url);
}

export function navigate(view) {
  if (!LOADERS[view]) return;
  renderView(view);
  adminDrawer?.close();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function setCounts(counts) {
  adminState.counts = { ...adminState.counts, ...counts };
  renderNav();
}

export async function refresh() {
  await renderView(adminState.view);
}

export function bindShell({ user, role }) {
  adminState.identity = { user, role };
  adminState.role = role || "admin";
  qs("#admin-identity").textContent = user?.email || "—";
  qs("#admin-email-label").textContent = user?.email || "—";
  qs("#admin-role").textContent = role || "admin";

  /* The console shows the operator's own photo, so the person who uploaded one
     in Settings sees it here rather than initials next to their email. */
  void (async () => {
    const host = qs("#admin-avatar");
    if (!host || !user?.id) return;
    const row = (await peopleMeta([user.id])).get(user.id);
    host.innerHTML = avatarMarkup({
      name: row?.full_name || user?.email,
      email: user?.email,
      avatarUrl: row?.avatar_url,
      size: "sm"
    });
  })();

  on(qs("#admin-nav"), "click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) navigate(button.getAttribute("data-view"));
  });

  /* The admin console uses the same sidebar controller as the dashboard, so the
     two shells behave identically: a column on a desktop that the ☰ collapses to
     a rail, and an overlay drawer below 1024px where there is no room for a
     column. It used to be the modal drawer at every width, which dimmed the
     console's own content behind a scrim on a desktop monitor. */
  adminDrawer = createSidebar({
    panel: qs("#admin-sidebar"),
    scrim: qs("#admin-scrim"),
    toggles: "#admin-menu-toggle"
  });

  const search = qs("#admin-search");
  on(
    search,
    "input",
    debounce((event) => {
      adminState.search = event.target.value.trim();
      if (["customers", "payments", "support"].includes(adminState.view)) {
        renderView(adminState.view);
      } else if (adminState.search) {
        navigate("customers");
      }
    }, 300)
  );

  on(qs("#admin-signout"), "click", async () => {
    const { signOut } = await import("../../lib/supabase.js");
    await signOut();
    location.href = "/auth/login/";
  });
}

export { toast, toastError, qsa };
