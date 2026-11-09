/* ==========================================================================
   Shinzora — Notification centre
   Inbox of everything that happened: account, AI, deployments, domains,
   payments and announcements from the Shinzora team.
   ========================================================================== */

import { qs, qsa, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime } from "../../../lib/format.js";
import { notifications as fetchNotifications, announcements, markNotificationRead, markAllNotificationsRead, isSchemaMissing } from "../data.js";
import { normalizeError } from "../../../lib/supabase.js";
import { pageHead, setupNotice, emptyState, skeletonView } from "../components.js";
import { refreshNotificationBadge } from "../shell.js";
import { toast, toastError } from "../../../ui/toast.js";

const TYPE_META = {
  account: { icon: "user-round", label: "Account" },
  ai: { icon: "sparkles", label: "AI" },
  website: { icon: "panels-top-left", label: "Website" },
  deployment: { icon: "rocket", label: "Deployment" },
  domain: { icon: "globe", label: "Domain" },
  payment: { icon: "receipt", label: "Payment" },
  admin: { icon: "megaphone", label: "Shinzora" },
  support: { icon: "life-buoy", label: "Support" },
  order: { icon: "package", label: "Order" },
  system: { icon: "server", label: "System" }
};

let onlyUnread = false;

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  let rows = [];
  let notices = [];
  try {
    const [notifRes, annRes] = await Promise.all([fetchNotifications(100), announcements(10).catch(() => ({ data: [] }))]);
    rows = notifRes.data;
    notices = annRes.data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Notifications" })}${setupNotice(error, "Notifications")}`;
    if (!isSchemaMissing(error)) console.error(error);
    return;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Notifications",
      desc: "Everything that happened in your workspace, newest first.",
      actions: `<button class="btn btn-secondary btn-sm" id="mark-all">${icon("check-check", { size: 14 })}Mark all as read</button>`
    })}
    <div class="toolbar">
      <div class="segmented" id="notif-filter">
        <button data-unread="false" aria-pressed="true">All</button>
        <button data-unread="true" aria-pressed="false">Unread</button>
      </div>
      <div class="toolbar-spacer"></div>
      <span class="badge badge-violet" id="unread-count">${rows.filter((r) => !r.read_at).length} unread</span>
    </div>
    <div class="grid-main-side">
      <div class="card" id="notif-card">
        <div class="drawer-body" id="notif-view-list" style="padding:var(--s-3)"></div>
      </div>
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">Announcements</div><span class="badge">From Shinzora</span></div>
          <div class="card-body">
            ${
              notices.length
                ? `<div class="stack gap-4">${notices
                    .map(
                      (n) => `<div>
                        <div style="font-size:var(--fs-sm);font-weight:600;color:#fff">${esc(n.title)}</div>
                        <div class="dim" style="font-size:var(--fs-2xs);margin:3px 0 6px">${esc(dateTime(n.created_at))}</div>
                        <p class="muted" style="font-size:var(--fs-xs);line-height:1.6;white-space:pre-wrap">${esc(n.body)}</p>
                      </div>`
                    )
                    .join("")}</div>`
                : `<p class="muted" style="font-size:var(--fs-xs);line-height:1.6">No announcements yet. Platform updates and maintenance notices appear here.</p>`
            }
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">Delivery</div></div>
          <div class="card-body">
            <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
              Notifications are stored in Postgres and streamed live over Supabase Realtime. They are also visible on any
              device you sign in to.
            </p>
            <dl style="margin-top:10px">
              <div class="kv"><dt>Channels</dt><dd>In-app (email optional)</dd></div>
              <div class="kv"><dt>Realtime</dt><dd>Enabled</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </div>`;

  const list = qs("#notif-view-list");

  function paint() {
    const visible = onlyUnread ? rows.filter((row) => !row.read_at) : rows;
    list.innerHTML = visible.length
      ? visible
          .map((row) => {
            const meta = TYPE_META[row.type] || TYPE_META.system;
            return `<button class="notif ${row.read_at ? "" : "is-unread"}" data-id="${esc(row.id)}">
              <span class="notif-icon">${icon(meta.icon, { size: 14 })}</span>
              <span class="notif-body">
                <span class="row gap-2" style="align-items:center">
                  <span class="notif-title">${esc(row.title)}</span>
                  <span class="badge badge-neutral" style="margin-left:auto">${esc(meta.label)}</span>
                </span>
                ${row.body ? `<span class="notif-text">${esc(row.body)}</span>` : ""}
                <span class="notif-meta">${row.read_at ? "" : '<span class="notif-dot"></span>'}${esc(timeAgo(row.created_at))}${
              row.link ? " · has link" : ""
            }</span>
              </span>
            </button>`;
          })
          .join("")
      : emptyState({
          icon: "bell",
          title: onlyUnread ? "No unread notifications" : "Nothing here yet",
          desc: onlyUnread
            ? "You have read everything. New activity will appear here in real time."
            : "Generation, deployment, domain and payment updates will show up here."
        });
    qs("#unread-count").textContent = `${rows.filter((r) => !r.read_at).length} unread`;
  }

  paint();

  delegate(qs("#notif-filter"), "click", "button", (event, node) => {
    onlyUnread = node.getAttribute("data-unread") === "true";
    qsa("#notif-filter button").forEach((btn) => btn.setAttribute("aria-pressed", String(btn === node)));
    paint();
  });

  delegate(list, "click", "[data-id]", async (event, node) => {
    const id = node.getAttribute("data-id");
    const row = rows.find((r) => r.id === id);

    /* Read status is persisted FIRST, then the link is followed.
       The old order navigated away immediately for any notification with a link,
       so the update never ran: reopen the page and the item was unread again —
       reported as "read status does not stick". A navigation is not a reason to
       skip the write. */
    if (row && !row.read_at) {
      try {
        await markNotificationRead(id);
        row.read_at = new Date().toISOString();
        paint();
        refreshNotificationBadge();
      } catch (error) {
        /* Do not trap the customer on the page because a write failed; tell them. */
        toastError(normalizeError(error));
      }
    }

    if (row?.link) {
      window.location.assign(row.link);
    }
  });

  qs("#mark-all").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await markAllNotificationsRead();
      rows.forEach((row) => (row.read_at = row.read_at || new Date().toISOString()));
      paint();
      await refreshNotificationBadge();
      toast({ title: "All notifications marked as read" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    } finally {
      button.disabled = false;
    }
  });
}
