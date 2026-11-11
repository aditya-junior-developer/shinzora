/* ==========================================================================
   Shinzora — dashboard shell
   Sidebar navigation, topbar menus, notification drawer, global search and
   realtime subscriptions. Everything here is chrome; views own their content.
   ========================================================================== */

import { qs, qsa, delegate, on, debounce, esc } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { state, aiCredits, plan, hasCompletedOnboarding } from "../../lib/store.js";
import { timeAgo } from "../../lib/format.js";
import { logoutEverywhere } from "../../lib/guard.js";
import { toast, toastError } from "../../ui/toast.js";
import { sb, normalizeError, getSession } from "../../lib/supabase.js";
import { markAllNotificationsRead, markNotificationRead, notifications as fetchNotifications, uid } from "./data.js";
import { resolvePublishedSite, rememberPublishedSite } from "../../lib/site-url.js";
import { createSidebar } from "../../ui/sidebar.js";
import { paintAvatar } from "../../lib/avatar.js";
import { startPresence, runReferralTick } from "../../ui/heartbeat.js";
import { initNotifications, presentNotification } from "../../ui/notify.js";
import { openLiveChannel, closeLiveChannel } from "../../lib/live-channel.js";

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

/* One key for this page's notification channel — see lib/live-channel.js. */
const NOTIFICATION_KEY = "notifications";
let realtimeChannel = null;
/* The navigation sidebar, created by bindChrome(). */
let navSidebar = null;

/* Only meaningful below 1024px, where the sidebar is an overlay; on a desktop
   the navigation is a column and there is nothing to dismiss. */
export const closeNavDrawer = () => navSidebar?.close();

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
                href="/app/?view=${item.id}" data-nav="${item.id}"
                data-label="${esc(item.label)}" title="${esc(item.label)}"
                ${item.id === activeView ? 'aria-current="page"' : ""}>
                ${icon(item.icon, { size: 16 })}
                <span class="link-text">${esc(item.label)}</span>
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

/* ------------------------------------------------------------------ chats */
/*
 * The last few assistant conversations, inside the sidebar.
 *
 * It reads the same rows the assistant view reads (`ai_conversations`, kind =
 * "assistant"), so opening one here and opening it from the History panel are
 * the same action. Nothing is cached between pages and nothing is invented when
 * the list is empty — an account with no conversations gets one sentence that
 * says so.
 */
let recentChatToken = 0;

export async function renderRecentChats() {
  const host = qs("#sidebar-recent");
  if (!host) return;
  const myToken = ++recentChatToken;

  try {
    const session = await getSession();
    if (!session) {
      host.innerHTML = `<p class="sidebar-chat-empty">Sign in to see your conversations.</p>`;
      return;
    }
    const { data, error } = await sb
      .from("ai_conversations")
      .select("id, title, updated_at")
      .eq("user_id", session.user.id)
      .eq("kind", "assistant")
      .order("updated_at", { ascending: false })
      .limit(6);
    if (error) throw error;
    if (myToken !== recentChatToken) return;

    const activeId = new URLSearchParams(location.search).get("conversation");
    const rows = data || [];
    host.innerHTML = rows.length
      ? rows
          .map(
            (row) => `<a class="sidebar-chat ${row.id === activeId ? "is-active" : ""}"
                href="/app/?view=assistant&conversation=${esc(row.id)}"
                data-chat="${esc(row.id)}"
                title="${esc(row.title || "Untitled conversation")}">
                ${icon("message-square", { size: 13 })}
                <span class="chat-title">${esc(row.title || "Untitled conversation")}</span>
              </a>`
          )
          .join("") +
        `<a class="sidebar-chat sidebar-chat-all" href="/app/?view=assistant&history=1">
            ${icon("clock", { size: 13 })}
            <span class="chat-title">All chats</span>
          </a>`
      : `<p class="sidebar-chat-empty">No conversations yet. Start one above.</p>`;
  } catch (error) {
    if (myToken !== recentChatToken) return;
    /* A missing table or a blocked read is not worth an alarm in the sidebar —
       the assistant view is where the real error is reported. */
    if (normalizeError(error).code !== "schema_missing") console.warn("[shinzora] recent chats:", error);
    host.innerHTML = `<p class="sidebar-chat-empty">Conversations could not be loaded.</p>`;
  }
}

/** The sidebar highlights the chat that is open in the assistant. */
export function markActiveChat(conversationId) {
  qsa("#sidebar-recent .sidebar-chat").forEach((link) =>
    link.classList.toggle("is-active", link.getAttribute("data-chat") === conversationId)
  );
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
  if (wsAvatar) {
    /* The workspace badge is the business: its logo when one is uploaded, its
       initials otherwise. Painted into the existing circle rather than wrapping
       another one around it — see paintAvatar(). A logo is contained, not
       cropped, so the whole mark stays visible and centred. */
    paintAvatar(wsAvatar, {
      name,
      email: state.user?.email,
      avatarUrl: state.business?.logo_url,
      alt: state.business?.name || "Workspace",
      fit: "contain"
    });
  }
  if (accName) accName.textContent = state.profile?.full_name || "Account";
  if (accAvatar) {
    paintAvatar(accAvatar, {
      name: state.profile?.full_name,
      email: state.user?.email,
      avatarUrl: state.profile?.avatar_url,
      alt: "Your profile photo"
    });
  }
  if (accEmail) accEmail.textContent = state.user?.email || "";
  if (adminLink) adminLink.hidden = !state.isAdmin;

  renderSetupBanner();
  void renderAlertsPrompt();
}

/* ==========================================================================
   "Turn on alerts"
   --------------------------------------------------------------------------
   Web Push works on this deployment — the VAPID pair is set, the `push`
   function is live and every notification row is fanned out to it. What was
   missing was ever asking: the switch lives three levels into Settings, so the
   subscription table was empty and every push had nowhere to go. That is why a
   message, a call or a notice produced nothing once the tab was behind another
   window.

   So the ask is here, once, in plain words, with a real button. Dismissing it
   is remembered; a browser that has already said no is not nagged.
   ========================================================================== */
const ALERTS_DISMISSED = "shinzora:alerts-dismissed";

async function renderAlertsPrompt() {
  const host = qs("#view-root");
  document.querySelector("[data-alerts-prompt]")?.remove();
  if (!host || state.isAdmin === undefined) return;

  let reason;
  try {
    const { pushState, syncPush } = await import("../../ui/notify.js");
    const current = pushState();
    if (!current.ok && current.reason === "not-subscribed") {
      /* Permission was granted earlier but this device is not registered —
         registering needs no prompt, so it is done rather than asked about. */
      const revived = await syncPush();
      if (revived.ok) return;
      reason = revived.reason;
    } else if (!current.ok) {
      reason = current.reason;
    } else {
      await syncPush();
      return;
    }
  } catch {
    return;
  }

  if (!["permission-required", "not-subscribed", "server"].includes(reason)) return;
  try {
    if (localStorage.getItem(ALERTS_DISMISSED) === "1") return;
  } catch {
    /* private mode: ask every time rather than never */
  }

  const card = document.createElement("div");
  card.className = "alerts-prompt";
  card.setAttribute("data-alerts-prompt", "");
  card.innerHTML = `${icon("bell", { size: 16 })}
    <div class="alerts-prompt-text">
      <strong>Get messages, calls and notices when Shinzora is not on screen.</strong>
      <span>One click turns on device alerts. Your browser asks once; nothing is sent until you allow it.</span>
    </div>
    <button class="btn btn-primary btn-sm" type="button" data-alerts-on>Turn on alerts</button>
    <button class="btn btn-ghost btn-sm" type="button" data-alerts-later>Not now</button>`;
  host.prepend(card);

  const close = () => {
    card.remove();
    try {
      localStorage.setItem(ALERTS_DISMISSED, "1");
    } catch {
      /* nothing to remember it with */
    }
  };

  card.querySelector("[data-alerts-later]")?.addEventListener("click", close);
  card.querySelector("[data-alerts-on]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Turning on…";
    try {
      const { enablePush } = await import("../../ui/notify.js");
      const result = await enablePush();
      card.remove();
      toast({
        title: "Alerts are on",
        message: `This device is registered${result?.devices ? ` (${result.devices} of your devices now)` : ""}. Calls, messages and notices will reach you with the tab closed.`
      }, { tone: "success" });
    } catch (error) {
      button.disabled = false;
      button.textContent = "Try again";
      toastError(normalizeError(error));
    }
  });
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
  /* The navigation is a column on a desktop and a drawer on a phone, and one
     controller owns both so the two can never disagree about which is showing.
     Nothing here blurs, darkens or blocks the page above 1024px. */
  navSidebar = createSidebar({
    panel: qs("#app-sidebar"),
    scrim: qs("#sidebar-scrim")
  });
  on(qs("#sidebar-signout"), "click", () => navSidebar?.close());

  /* Recent chats belong to the assistant, so the sidebar paints them where the
     user is, and asks again whenever the view or the conversation list changes. */
  void renderRecentChats();
  window.addEventListener("shinzora:chats-changed", () => void renderRecentChats());
  window.addEventListener("shinzora:view", (event) => {
    markActiveChat(new URLSearchParams(location.search).get("conversation"));
    /* Coming back to the assistant can mean a conversation was started in
       another tab, so the list is refreshed there rather than on every view. */
    if (event.detail?.view === "assistant") void renderRecentChats();
  });

  /* Presence: one heartbeat a minute while the tab is visible, and once more on
     the way out so the last time is the time they left rather than a minute
     before it. Nothing about the page depends on the response. */
  startPresence();
  /* Referral months come due on a calendar, not on a user action, so this is the
     only place they are granted. Once a day per device is enough. */
  void runReferralTick();

  // Workspace + account menus
  /* In the icon rail the switcher is an avatar with no room for its menu, so a
     click opens the sidebar first — the rail is a summary, not a place to run
     things from. */
  on(qs("#workspace-switch"), "click", () => navSidebar?.expand());
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
  closeLiveChannel(NOTIFICATION_KEY);
  realtimeChannel = null;
}

/** Stream new notifications over Supabase Realtime. */
export function subscribeNotifications() {
  if (!sb || !uid()) return;
  /* Preferences, the audio unlock and a re-check of any existing push
     subscription. Nothing here asks for browser permission — that only happens
     when somebody presses "Turn on" in settings. */
  initNotifications({ onChange: () => refreshNotificationBadge() }).catch(() => {});
  listenForServiceWorkerMessages();
  /* Opening this twice (a re-mount, a reconnect) used to race the asynchronous
     removal of the previous channel and throw "cannot add postgres_changes
     callbacks ... after subscribe()". lib/live-channel.js closes first, then
     binds, then subscribes. */
  realtimeChannel = openLiveChannel(sb, NOTIFICATION_KEY, {
    topic: `notifications:${uid()}`,
    bind: (channel) =>
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid()}` },
        (payload) => {
          const row = payload.new;
          refreshNotificationBadge();
          /* One path for every notification: preferences decide whether it is
             shown and sounded, and a group message gets the richer notice with
             the sender, the group and a preview. */
          const shown = presentNotification(row);
          if (!shown) {
            /* Muted, or this member asked for mentions only. The row is still
               stored and still counted in the badge — it is their inbox. */
          }
          const list = qs("#notif-list");
          if (list && !qs("#notification-drawer").hidden) list.insertAdjacentHTML("afterbegin", notifMarkup(row));
          /* A mention is stored with type `group_mention`; keying off the meta
             rather than the type means both kinds refresh the open thread. */
          if (shown && row.meta?.groupId && row.meta?.messageId) {
            document.dispatchEvent(new CustomEvent("shinzora:group-message", { detail: row.meta }));
          }
        }
      )
  });
}

/**
 * A closed-tab notification was tapped.
 *
 * The service worker focuses this window and posts the target instead of
 * opening a second tab. If the inbox is already on screen it handles the jump
 * itself (and scrolls to the message); otherwise the whole page navigates.
 */
function listenForServiceWorkerMessages() {
  if (!("serviceWorker" in navigator)) return;
  if (navigator.serviceWorker.__shinzoraBound) return;
  navigator.serviceWorker.__shinzoraBound = true;

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "shinzora:open-group") return;
    const onInbox = new URLSearchParams(location.search).get("view") === "messages";
    if (onInbox) return; // views/messages.js owns it from here
    location.assign(data.url || `/app/?view=messages&tab=groups&group=${data.groupId || ""}`);
  });
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
