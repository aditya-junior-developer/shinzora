/* ==========================================================================
   Shinzora — dashboard shell
   Sidebar navigation, topbar menus, notification drawer, global search and
   realtime subscriptions. Everything here is chrome; views own their content.
   ========================================================================== */

import { qs, qsa, delegate, on, debounce, esc } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { state, aiCredits, plan, hasCompletedOnboarding } from "../../lib/store.js";
import { initials, timeAgo } from "../../lib/format.js";
import { logoutEverywhere } from "../../lib/guard.js";
import { toast, toastError } from "../../ui/toast.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { markAllNotificationsRead, markNotificationRead, notifications as fetchNotifications, uid } from "./data.js";
import { resolvePublishedSite, rememberPublishedSite } from "../../lib/site-url.js";

export const NAV = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: "house" },
      { id: "assistant", label: "AI Assistant", icon: "sparkles" }
    ]
  },
  {
    label: "Build",
    items: [
      { id: "website-builder", label: "Website Builder", icon: "panels-top-left" },
      { id: "app-builder", label: "App Builder", icon: "blocks" },
      { id: "projects", label: "Projects", icon: "folder-git-2" },
      { id: "domains", label: "Domains", icon: "globe" }
    ]
  },
  {
    label: "Commerce",
    items: [
      { id: "store", label: "Online Store", icon: "store" },
      { id: "inventory", label: "Inventory", icon: "boxes" },
      { id: "orders", label: "Orders", icon: "package" },
      { id: "customers", label: "Customers", icon: "users" },
      { id: "find-team", label: "Find Team", icon: "users-round" },
      { id: "team", label: "Team", icon: "users" }
    ]
  },
  {
    label: "Growth",
    items: [
      { id: "marketplace", label: "Marketplace", icon: "package" },
      { id: "community", label: "Community", icon: "messages-square" },
      { id: "marketing", label: "Request for Extra Service", icon: "megaphone" },
      { id: "support", label: "Customer Support", icon: "life-buoy" },
      { id: "messages", label: "Messages", icon: "messages-square" },
      { id: "analytics", label: "Analytics", icon: "chart-line" }
    ]
  },
  {
    label: "Account",
    items: [
      { id: "invitations", label: "Invitations", icon: "inbox" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "billing", label: "Billing", icon: "credit-card" },
      { id: "settings", label: "Settings", icon: "settings" }
    ]
  }
];

/* An agent's sidebar is about people and work, not about running a shop.
   Reusing the same view ids means an agent and an owner can both open
   "marketplace" — they just arrive at a different tab. */
export const AGENT_NAV = [
  {
    label: "Work",
    items: [
      { id: "freelancer", label: "Dashboard", icon: "house" },
      { id: "marketplace", label: "Find projects", icon: "search" },
      { id: "portfolio", label: "Portfolio & CV", icon: "id-card" }
    ]
  },
  {
    label: "Network",
    items: [
      { id: "find-team", label: "Find Team", icon: "users-round" },
      { id: "team", label: "Team", icon: "users" },
      { id: "community", label: "Community", icon: "messages-square" },
      { id: "messages", label: "Messages", icon: "messages-square" }
    ]
  },
  {
    label: "Account",
    items: [
      { id: "invitations", label: "Invitations", icon: "inbox" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "settings", label: "Settings", icon: "settings" },
      { id: "billing", label: "Billing", icon: "credit-card" }
    ]
  }
];

/** Which navigation a signed-in account should see. */
export const navFor = () => (state.profile?.account_type === "agent" ? AGENT_NAV : NAV);

let realtimeChannel = null;

/* ------------------------------------------------------------------ chrome */
export function renderSidebar(activeView) {
  const nav = qs("#sidebar-nav");
  if (!nav) return;
  const credits = aiCredits();
  nav.innerHTML = navFor().map(
    (group) => `<div class="sidebar-group">
        <div class="sidebar-group-label">${esc(group.label)}</div>
        ${group.items
          .map(
            (item) => `<a class="sidebar-link ${item.id === activeView ? "is-active" : ""}"
                href="/app/?view=${item.id}" data-nav="${item.id}">
                ${icon(item.icon, { size: 16 })}
                <span>${esc(item.label)}</span>
                ${item.id === "notifications" ? '<span class="link-badge hidden" data-notif-badge></span>' : ""}
              </a>`
          )
          .join("")}
      </div>`
  ).join("");

  // usage meter
  const count = qs("#ai-usage-count");
  const bar = qs("#ai-usage-bar");
  if (count) count.textContent = `${credits.used}/${credits.limit}`;
  if (bar) bar.style.width = `${Math.min(100, Math.round((credits.used / Math.max(1, credits.limit)) * 100))}%`;
}

export function paintIdentity() {
  const name = state.business?.name || state.profile?.full_name || state.user?.email || "Your business";
  const wsName = qs("#workspace-name");
  const wsPlan = qs("#workspace-plan");
  const wsAvatar = qs("#workspace-avatar");
  const accName = qs("#account-name");
  const accAvatar = qs("#account-avatar");
  const accEmail = qs("#account-email");
  const adminLink = qs("#admin-link");

  if (wsName) wsName.textContent = name;
  if (wsPlan) wsPlan.textContent = state.isAdmin ? "Administrator" : `${plan().name} plan`;
  if (wsAvatar) wsAvatar.textContent = initials(name);
  if (accName) accName.textContent = state.profile?.full_name || "Account";
  if (accAvatar) {
    if (state.profile?.avatar_url) accAvatar.innerHTML = `<img src="${esc(state.profile.avatar_url)}" alt="" />`;
    else accAvatar.textContent = initials(state.profile?.full_name || state.user?.email);
  }
  if (accEmail) accEmail.textContent = state.user?.email || "";
  if (adminLink) adminLink.hidden = !state.isAdmin;

  renderSetupBanner();
}

function renderSetupBanner() {
  const host = qs("#view-root");
  const existing = document.querySelector("[data-setup-banner]");
  if (existing) existing.remove();
  /* Administrators are not customers: the console is their workspace, and a
     "finish your setup" banner there just describes somebody else's journey. */
  if (!host || state.isAdmin || hasCompletedOnboarding()) return;
  const banner = document.createElement("div");
  banner.setAttribute("data-setup-banner", "");
  banner.className = "setup-banner";
  banner.innerHTML = `${icon("sparkles", { size: 18 })}
    <div><strong>Finish setting up your workspace.</strong> Add the business details so the AI can generate a site that fits.
    <a href="/onboarding/">Resume setup</a></div>`;
  host.prepend(banner);
}

/* -------------------------------------------------------------- interactions */
export function bindChrome({ navigate }) {
  // Sidebar open/close
  const sidebar = qs("#app-sidebar");
  const scrim = qs("#sidebar-scrim");
  const openSidebar = () => {
    sidebar.classList.add("is-open");
    scrim.classList.add("is-visible");
  };
  const closeSidebar = () => {
    sidebar.classList.remove("is-open");
    scrim.classList.remove("is-visible");
  };
  on(qs("[data-sidebar-open]"), "click", openSidebar);
  on(qs("[data-sidebar-close]"), "click", closeSidebar);
  on(scrim, "click", closeSidebar);
  delegate(qs("#sidebar-nav"), "click", "[data-nav]", () => closeSidebar());

  // Desktop collapse preference
  const collapsed = localStorage.getItem("shinzora.sidebar.collapsed") === "1";
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  on(qs("#sidebar-collapse"), "click", () => {
    const next = !document.body.classList.contains("sidebar-collapsed");
    document.body.classList.toggle("sidebar-collapsed", next);
    localStorage.setItem("shinzora.sidebar.collapsed", next ? "1" : "0");
  });

  // Workspace + account menus
  bindMenu("#workspace-switch", "#workspace-menu");
  bindMenu("#account-toggle", "#account-menu");

  /* Sign out. The button locks immediately so a second click cannot start a
     second sign-out, and the shell releases its channel first — a page that is
     navigating away should not keep a websocket open while it waits. */
  const signOutHandlers = [qs("#sidebar-signout"), qs("#account-signout")].filter(Boolean);
  signOutHandlers.forEach((button) =>
    on(button, "click", () => {
      signOutHandlers.forEach((node) => {
        node.disabled = true;
        node.setAttribute("aria-busy", "true");
      });
      stopBackgroundWork();
      logoutEverywhere();
    })
  );

  /* The guard announces the sign-out before it clears the session; whoever owns
     background work must stop then, not after the network call returns. */
  window.addEventListener("shinzora:signing-out", stopBackgroundWork, { once: true });

  // View public site — the customer's own published site, never our homepage
  bindViewPublicSite();

  // Notifications drawer
  bindNotificationDrawer();

  // Global search
  bindSearch(navigate);

  // Keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      qs("#global-search")?.focus();
    }
  });

  // Account menu closes on navigation
  delegate(document, "click", "#account-menu a, #workspace-menu a", () => closeMenus());
}

function bindMenu(triggerSel, menuSel) {
  const trigger = qs(triggerSel);
  const menu = qs(menuSel);
  if (!trigger || !menu) return;

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
  });

  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
    }
  });
}

function closeMenus() {
  qsa(".menu").forEach((menu) => (menu.hidden = true));
  qsa('[aria-expanded="true"]').forEach((node) => {
    if (node.id === "workspace-switch" || node.id === "account-toggle") node.setAttribute("aria-expanded", "false");
  });
}

/* ------------------------------------------------------------- notifications */
const NOTIF_ICONS = {
  account: "user-round",
  ai: "sparkles",
  website: "panels-top-left",
  deployment: "rocket",
  domain: "globe",
  payment: "receipt",
  admin: "megaphone",
  support: "life-buoy",
  order: "package",
  system: "server"
};

/** Rows currently rendered in the drawer, so a click can find its link. */
let notificationRows = [];

export async function refreshNotificationBadge() {
  if (!sb || !uid()) return;
  const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", uid()).is("read_at", null);
  state.unreadNotifications = count || 0;
  const badges = [qs("#notif-badge"), qs("[data-notif-badge]")].filter(Boolean);
  badges.forEach((badge) => {
    badge.textContent = String(state.unreadNotifications);
    badge.classList.toggle("hidden", state.unreadNotifications === 0);
  });
}

function notifMarkup(row) {
  return `<button class="notif ${row.read_at ? "" : "is-unread"}" data-notif="${esc(row.id)}">
      <span class="notif-icon">${icon(NOTIF_ICONS[row.type] || "bell", { size: 14 })}</span>
      <span class="notif-body">
        <span class="notif-title">${esc(row.title || "Notification")}</span>
        ${row.body ? `<span class="notif-text">${esc(row.body)}</span>` : ""}
        <span class="notif-meta">${row.read_at ? "" : '<span class="notif-dot"></span>'}${esc(timeAgo(row.created_at))}</span>
      </span>
    </button>`;
}

function bindNotificationDrawer() {
  const drawer = qs("#notification-drawer");
  const scrim = qs("#drawer-scrim");
  const list = qs("#notif-list");
  const sub = qs("#notif-sub");
  if (!drawer) return;

  const close = () => {
    drawer.classList.remove("is-open");
    scrim.classList.remove("is-visible");
    setTimeout(() => (drawer.hidden = true), 300);
  };
  const open = async () => {
    drawer.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add("is-open");
      scrim.classList.add("is-visible");
    });
    list.innerHTML = `<div class="skeleton-row">${icon("loader-circle", { size: 16 })}</div>`;
    try {
      const { data } = await fetchNotifications(25);
      notificationRows = data || [];
      sub.textContent = data.length ? `${data.filter((n) => !n.read_at).length} unread` : "You are all caught up";
      list.innerHTML = data.length
        ? data.map(notifMarkup).join("")
        : `<div class="empty"><div class="empty-mark">${icon("bell", { size: 20 })}</div>
             <div class="empty-title">No notifications yet</div>
             <p class="empty-desc">Generation, deployment, domain and payment updates appear here.</p></div>`;
    } catch (error) {
      list.innerHTML = `<div class="alert alert-warn" style="margin:var(--s-3)">${icon("triangle-alert", { size: 16 })}
        <span>${esc(normalizeError(error).message)}</span></div>`;
    }
  };

  on(qs("#notifications-toggle"), "click", open);
  delegate(document, "click", "[data-drawer-close]", close);
  on(scrim, "click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer.classList.contains("is-open")) close();
  });

  delegate(drawer, "click", "[data-notif]", async (_event, node) => {
    const id = node.getAttribute("data-notif");
    const row = notificationRows.find((entry) => entry.id === id);

    /* Persist the read state before anything else — including before following
       the notification's own link, which is what happens when this drawer is the
       only surface a customer ever sees. */
    try {
      await markNotificationRead(id);
      node.classList.remove("is-unread");
      node.querySelector(".notif-dot")?.remove();
      node.querySelector(".notif-meta .notif-dot")?.remove();
      await refreshNotificationBadge();
    } catch (error) {
      toastError(normalizeError(error));
      return;
    }

    if (row?.link) {
      close();
      location.assign(row.link);
    }
  });

  on(qs("#notif-mark-all"), "click", async () => {
    try {
      await markAllNotificationsRead();
      const readAt = new Date().toISOString();
      notificationRows.forEach((row) => { row.read_at = row.read_at || readAt; });
      qsa("#notif-list .notif").forEach((n) => n.classList.remove("is-unread"));
      await refreshNotificationBadge();
      toast({ title: "All notifications marked as read" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });
}

/** Stop every long-lived subscription this shell owns. */
export function stopBackgroundWork() {
  if (realtimeChannel && sb) {
    try {
      sb.removeChannel(realtimeChannel);
    } catch {
      /* already gone */
    }
  }
  realtimeChannel = null;
}

/** Stream new notifications over Supabase Realtime. */
export function subscribeNotifications() {
  if (!sb || !uid()) return;
  if (realtimeChannel) sb.removeChannel(realtimeChannel);

  realtimeChannel = sb
    .channel(`notifications:${uid()}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid()}` },
      (payload) => {
        const row = payload.new;
        refreshNotificationBadge();
        toast({ title: row.title || "New notification", message: row.body || "" }, { tone: "info" });
        const list = qs("#notif-list");
        if (list && !qs("#notification-drawer").hidden) list.insertAdjacentHTML("afterbegin", notifMarkup(row));
      }
    )
    .subscribe();
}

/* --------------------------------------------------------- view public site */
/**
 * Open the customer's own published website.
 *
 * The link used to be href="/" — Shinzora's marketing homepage — so the label
 * promised one thing and delivered another. The address now comes from the
 * customer's published project (or its verified custom domain). When nothing is
 * published the click says so and offers the builder, instead of silently
 * sending them to our sales page.
 */
function bindViewPublicSite() {
  const triggers = [qs("#view-public-site"), qs("#account-view-site")].filter(Boolean);
  if (!triggers.length) return;

  /* Resolved once per shell so a click can open a tab synchronously (a tab opened
     after an await is blocked by popup rules). */
  resolvePublishedSite()
    .then((url) => {
      rememberPublishedSite(url);
      triggers.forEach((node) => {
        if (url) {
          node.setAttribute("href", url);
          if (!url.startsWith("/")) {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener");
          }
          node.removeAttribute("aria-disabled");
        } else {
          node.setAttribute("href", "#");
          node.setAttribute("aria-disabled", "true");
          node.setAttribute("title", "No published site yet");
        }
      });
    })
    .catch(() => rememberPublishedSite(null));

  const open = async (event) => {
    event.preventDefault();
    const node = event.currentTarget;
    if (node.getAttribute("aria-disabled") === "true") {
      toast(
        {
          title: "No published site yet",
          message: "Publish a project from the builder first — it appears here as soon as it is live."
        },
        { tone: "info", duration: 6000 }
      );
      return;
    }
    const url = node.getAttribute("href");
    if (!url || url === "#") return;
    if (url.startsWith("/")) location.assign(url);
    else window.open(url, "_blank", "noopener");
  };

  triggers.forEach((node) => on(node, "click", open));
}

/* -------------------------------------------------------------- global search */
function bindSearch(navigate) {
  const input = qs("#global-search");
  const panel = qs("#search-results");
  if (!input || !panel) return;

  const close = () => {
    panel.hidden = true;
    panel.innerHTML = "";
  };

  const run = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) return close();

    const commands = navFor().flatMap((group) => group.items)
      .filter((item) => item.label.toLowerCase().includes(term.toLowerCase()))
      .slice(0, 3)
      .map((item) => ({ kind: "Page", label: item.label, href: `/app/?view=${item.id}`, iconName: item.icon }));

    let results = [];
    try {
      const [{ data: projectRows }, { data: orderRows }, { data: customerRows }] = await Promise.all([
        sb.from("projects").select("id, name, type").ilike("name", `%${term}%`).limit(4),
        sb.from("store_orders").select("id, order_number, customer_name").or(`order_number.ilike.%${term}%,customer_name.ilike.%${term}%`).limit(4),
        sb.from("store_customers").select("id, name, email").or(`name.ilike.%${term}%,email.ilike.%${term}%`).limit(4)
      ]);
      results = [
        ...(projectRows || []).map((p) => ({ kind: "Project", label: p.name, href: `/app/?view=projects&id=${p.id}`, iconName: "folder-git-2" })),
        ...(orderRows || []).map((o) => ({
          kind: "Order",
          label: `${o.order_number || "Order"} · ${o.customer_name || ""}`,
          href: `/app/?view=orders&id=${o.id}`,
          iconName: "package"
        })),
        ...(customerRows || []).map((c) => ({ kind: "Customer", label: c.name || c.email, href: `/app/?view=customers&id=${c.id}`, iconName: "user-round" }))
      ];
    } catch {
      /* search degrades to page navigation when the schema is missing */
    }

    const all = [...commands, ...results].slice(0, 9);
    panel.hidden = false;
    panel.innerHTML = all.length
      ? all
          .map(
            (item, index) => `<a class="search-result ${index === 0 ? "is-active" : ""}" href="${esc(item.href)}" data-search-item>
              ${icon(item.iconName || "search", { size: 14 })}
              <span class="truncate">${esc(item.label)}</span>
              <span class="sr-type">${esc(item.kind)}</span>
            </a>`
          )
          .join("")
      : `<div class="search-empty">No matches for “${esc(term)}”</div>`;
  }, 220);

  input.addEventListener("input", run);
  input.addEventListener("focus", () => input.value.trim().length > 1 && run());

  input.addEventListener("keydown", (event) => {
    const items = qsa("[data-search-item]", panel);
    if (event.key === "Escape") {
      close();
      input.blur();
    }
    if (event.key === "Enter" && items[0]) {
      event.preventDefault();
      location.href = items[0].getAttribute("href");
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const active = panel.querySelector(".is-active");
      const index = items.indexOf(active);
      const nextIndex = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
      items.forEach((item) => item.classList.remove("is-active"));
      items[nextIndex]?.classList.add("is-active");
      items[nextIndex]?.scrollIntoView({ block: "nearest" });
    }
  });

  document.addEventListener("click", (event) => {
    if (!panel.contains(event.target) && event.target !== input) close();
  });

  delegate(panel, "click", "[data-search-item]", () => {
    close();
    input.value = "";
    // navigation happens through the anchor; re-render happens on popstate
    setTimeout(() => navigate(new URL(location.href).searchParams.get("view") || "overview"), 0);
  });
}
