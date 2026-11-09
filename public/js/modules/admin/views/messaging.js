/* ==========================================================================
   Admin · Messaging, activity and administrator access
   Three related sections selected by `view`.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime, date } from "../../../lib/format.js";
import { adminApi } from "../api.js";
import { emptyState } from "../../dashboard/components.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

let sendingAnnouncement = false;
let pendingRequestKey = null;

export default async function render(root, { view }) {
  if (view === "messaging") return renderMessaging(root);
  if (view === "activity") return renderActivity(root);
  return renderAccess(root);
}

/* ---------------------------------------------------------------- messaging */
async function renderMessaging(root) {
  const prefill = new URL(location.href).searchParams.get("to");

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Announcements</h1>
        <p>
          Send a message to every customer, a plan group or one account. Each recipient gets their own notification row, so
          read state is tracked per person.
        </p>
      </div>
    </div>

    <div class="admin-split">
      <div class="admin-card">
        <div class="admin-card-head"><div><div class="admin-card-title">Compose</div><div class="admin-card-sub">Delivered instantly to the notification centre</div></div></div>
        <div class="admin-card-body">
          <form id="announce-form" class="stack gap-4">
            <div class="field" data-field="title">
              <label class="field-label" for="ann-title">Title</label>
              <input class="input" id="ann-title" maxlength="160" placeholder="Scheduled maintenance on Sunday" required />
              <div class="field-error"></div>
            </div>
            <div class="field">
              <label class="field-label" for="ann-audience">Audience</label>
              <select class="select" id="ann-audience">
                <option value="all">All customers</option>
                <option value="free">Free plan</option>
                <option value="pro">Pro plan</option>
                <option value="enterprise">Enterprise plan</option>
                <option value="user:${esc(prefill || "")}" ${prefill ? "selected" : ""}>${prefill ? `Single account (${esc(prefill.slice(0, 8))}…)` : "Single account"}</option>
              </select>
            </div>
            <div class="field" data-field="body">
              <label class="field-label" for="ann-body">Message</label>
              <textarea class="textarea" id="ann-body" rows="7" maxlength="4000" placeholder="What changed, when, and what the customer should do." required></textarea>
              <div class="field-hint">Plain text. No emoji, no marketing claims.</div>
              <div class="field-error"></div>
            </div>
            <div class="row gap-2">
              <button class="btn btn-primary" type="submit" id="ann-send">${icon("send", { size: 14 })}Send announcement</button>
              <button class="btn btn-ghost" type="reset">Clear</button>
            </div>
          </form>
        </div>
      </div>

      <div class="admin-card">
        <div class="admin-card-head"><div><div class="admin-card-title">History</div><div class="admin-card-sub">Most recent first</div></div></div>
        <div class="admin-card-body" id="ann-history"><div class="admin-empty">Loading…</div></div>
      </div>
    </div>`;

  await loadHistory();

  qs("#announce-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = qs("#ann-title").value.trim();
    const body = qs("#ann-body").value.trim();
    const audience = qs("#ann-audience").value;

    if (title.length < 3) return toast({ title: "Add a title" }, { tone: "warning" });
    if (body.length < 5) return toast({ title: "Write the message" }, { tone: "warning" });

    const ok = await confirmDialog({
      title: "Send this announcement?",
      desc: `It will be delivered to ${audience === "all" ? "every customer" : audience}. Delivery cannot be undone.`,
      confirmLabel: "Send"
    });
    if (!ok) return;

    const button = qs("#ann-send");
    if (sendingAnnouncement) return;
    sendingAnnouncement = true;
    pendingRequestKey ||= crypto.randomUUID();
    button.disabled = true;
    try {
      const response = await adminApi.announcementCreate({ title, body, audience, requestKey: pendingRequestKey });
      pendingRequestKey = null;
      toast({ title: "Announcement sent", message: `Delivered to ${response.delivered ?? 0} accounts.` }, { tone: "success" });
      qs("#announce-form").reset();
      await loadHistory();
    } catch (error) {
      toastError(error);
    } finally {
      sendingAnnouncement = false;
      button.disabled = false;
    }
  });

  delegate(qs("#ann-history"), "click", "[data-archive-announcement]", async (_event, node) => {
    const id = node.getAttribute("data-archive-announcement");
    const confirmed = await confirmDialog({
      title: "Delete this announcement?",
      desc: "It stops being shown to customers and is kept in the database for reference.",
      confirmLabel: "Delete"
    });
    if (!confirmed) return;
    const values = await formDialog({
      title: "Reason",
      fields: [{ name: "reason", label: "Why is it being removed?", type: "textarea", rows: 2, required: true }],
      submitLabel: "Delete"
    });
    if (!values) return;
    try {
      await adminApi.archiveRecord({ table: "admin_announcements", id, reason: values.reason });
      toast({ title: "Announcement removed" }, { tone: "success" });
      loadHistory();
    } catch (error) {
      toastError(error);
    }
  });

  async function loadHistory() {
    try {
      const response = await adminApi.announcements();
      const rows = response.announcements || [];
      safeSet("#ann-history", rows.length
        ? `<div class="stack gap-4">${rows
            .map(
              (row) => `<div>
                <div class="row between" style="align-items:flex-start;gap:10px">
                  <div style="font-size:var(--fs-sm);color:var(--text)">${esc(row.title)}</div>
                  <div class="row" style="gap:6px;align-items:center">
                    <span class="badge badge-neutral">${esc(row.audience)}</span>
                    <button class="btn btn-ghost btn-sm" data-archive-announcement="${esc(row.id)}">Delete</button>
                  </div>
                </div>
                <div style="font-size:var(--fs-2xs);color:var(--text-4);margin:2px 0 8px">${esc(dateTime(row.created_at))}</div>
                <div class="announcement-preview">${esc(row.body || "")}</div>
              </div>`
            )
            .join("")}</div>`
        : emptyState({ icon: "megaphone", title: "Nothing sent yet", desc: "Announcements you send appear here with their audience." }));
    } catch (error) {
      safeSet("#ann-history", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  void on;
  void icon;
}

/* ----------------------------------------------------------------- activity */
async function renderActivity(root) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Platform activity</h1>
        <p>Audit trail written by the application: signups, generations, payments, plan changes, service requests and support replies.</p>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head"><div><div class="admin-card-title">Event stream</div><div class="admin-card-sub">Latest 200 events</div></div></div>
      <div class="admin-card-body" id="activity-feed"><div class="admin-empty">Loading…</div></div>
    </div>`;

  try {
    const response = await adminApi.activity({ limit: 200 });
    const rows = response.activity || [];
    safeSet("#activity-feed", rows.length
      ? `<div class="timeline">${rows
          .map(
            (row) => `<div class="timeline-item">
              <div class="timeline-title">${esc(String(row.action).replace(/_/g, " "))}</div>
              <div class="timeline-meta">
                ${esc(row.customer?.email || (row.user_id ? row.user_id.slice(0, 8) : "system"))}
                ${row.entity_type ? ` · ${esc(row.entity_type)}` : ""}
                · ${esc(timeAgo(row.created_at))}
                ${row.meta && Object.keys(row.meta).length ? ` · ${esc(JSON.stringify(row.meta).slice(0, 90))}` : ""}
              </div>
            </div>`
          )
          .join("")}</div>`
      : emptyState({ icon: "activity", title: "No events yet", desc: "Actions are recorded as customers use the platform." }));
  } catch (error) {
    safeSet("#activity-feed", `<div class="admin-empty">${esc(error.message)}</div>`);
  }
}

/* ------------------------------------------------------------------- access */
async function renderAccess(root) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Administrators</h1>
        <p>Read-only view. Administrator rights can only be granted by running the bootstrap migration — never through this interface.</p>
      </div>
    </div>
    <div class="admin-note" style="margin-bottom:var(--s-4)">
      ${icon("shield-check", { size: 15 })}
      <span>
        To add or remove an administrator, edit <span class="mono">supabase/migrations/0004_admin_bootstrap.sql</span> and run it
        in the Supabase SQL editor. The application has no write path to <span class="mono">admin_users</span>.
      </span>
    </div>
    <div class="admin-card">
      <div class="admin-card-head"><div><div class="admin-card-title">Current administrators</div><div class="admin-card-sub" id="admin-count">Loading…</div></div></div>
      <div id="admin-table"></div>
    </div>`;

  try {
    const response = await adminApi.admins();
    const rows = response.admins || [];
    qs("#admin-count").textContent = `${rows.length} account${rows.length === 1 ? "" : "s"}`;
    safeSet("#admin-table", rows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Email</th><th>Role</th><th>Granted</th><th>User ID</th></tr></thead>
          <tbody>${rows
            .map(
              (row) => `<tr>
                <td class="cell-strong">${esc(row.email || "—")}</td>
                <td><span class="badge badge-brand">${esc(row.role)}</span></td>
                <td class="dim">${esc(date(row.created_at))}</td>
                <td class="mono" style="font-size:var(--fs-2xs)">${esc(row.user_id)}</td>
              </tr>`
            )
            .join("")}</tbody></table></div>`
      : emptyState({ icon: "shield-check", title: "No administrators", desc: "Run 0004_admin_bootstrap.sql to create the first one." }));
  } catch (error) {
    safeSet("#admin-table", `<div class="admin-empty">${esc(error.message)}</div>`);
  }
}
