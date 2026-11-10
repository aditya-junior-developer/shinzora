/* ==========================================================================
   Admin · Operations — subscriptions, projects & deployments, support, contacts
   One module, four sections selected by `view`.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, dateTime, date, initials, statusLabel } from "../../../lib/format.js";
import { adminApi } from "../api.js";
import { emptyState } from "../../dashboard/components.js";
import { openModal, formDialog, confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

export default async function render(root, { view }) {
  if (view === "subscriptions") return renderSubscriptions(root);
  if (view === "projects") return renderProjects(root);
  if (view === "support") return renderSupport(root);
  return renderContacts(root);
}

/* ------------------------------------------------------------ subscriptions */
async function renderSubscriptions(root) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Subscriptions</h1>
        <p>Plan, status and AI credit usage per account. Plan changes are written directly and always notify the customer.</p>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head"><div><div class="admin-card-title">Active subscriptions</div><div class="admin-card-sub" id="sub-count">Loading…</div></div></div>
      <div id="sub-table"></div>
    </div>`;

  let rows = [];

  try {
    const response = await adminApi.subscriptions();
    rows = response.subscriptions || [];
    qs("#sub-count").textContent = `${rows.length} subscriptions`;
    paint();
  } catch (error) {
    safeSet("#sub-table", `<div class="admin-empty">${esc(error.message)}</div>`);
  }

  function paint() {
    safeSet("#sub-table", rows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>AI credits</th><th>Renews</th><th>Updated</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (row) => `<tr>
                <td><div class="customer-cell"><span class="avatar">${esc(initials(row.customer?.full_name || row.customer?.email))}</span>
                  <div><strong>${esc(row.customer?.full_name || "—")}</strong><span>${esc(row.customer?.email || "")}</span></div></div></td>
                <td><span class="badge badge-${row.plan === "enterprise" ? "brand" : row.plan === "pro" ? "ok" : "neutral"}">${esc(row.plan)}</span></td>
                <td>${esc(row.status)}</td>
                <td>${row.ai_credits_used} / ${row.ai_credits_limit}</td>
                <td class="dim">${row.current_period_end ? esc(date(row.current_period_end)) : "—"}</td>
                <td class="dim">${esc(timeAgo(row.updated_at))}</td>
                <td class="cell-actions">
                  <button class="btn btn-secondary btn-sm" data-edit="${esc(row.user_id)}">Change plan</button>
                  <button class="btn btn-ghost btn-sm" data-credits="${esc(row.user_id)}">Reset AI credits</button>
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({ icon: "crown", title: "No subscriptions found" }));
  }

  delegate(qs("#sub-table"), "click", "[data-edit]", async (_event, node) => {
    const row = rows.find((item) => item.user_id === node.getAttribute("data-edit"));
    if (!row) return;
    const values = await formDialog({
      title: `Change plan — ${row.customer?.email || row.user_id.slice(0, 8)}`,
      fields: [
        {
          name: "plan",
          label: "Plan",
          type: "select",
          value: row.plan,
          options: [
            { value: "free", label: "Free — 30 credits" },
            { value: "pro", label: "Pro — 800 credits" },
            { value: "enterprise", label: "Enterprise — 6000 credits" }
          ]
        },
        {
          name: "status",
          label: "Status",
          type: "select",
          value: row.status,
          options: ["active", "past_due", "cancelled", "trialing"].map((value) => ({ value, label: value }))
        }
      ],
      submitLabel: "Apply"
    });
    if (!values) return;
    try {
      /* The audited function: writes a subscription event and an audit row, and
         refuses anything the caller is not allowed to do. */
      await adminApi.subscriptionChange({ userId: row.user_id, plan: values.plan, status: values.status, reason: `plan set to ${values.plan} by an administrator` });
      toast({ title: "Subscription updated" }, { tone: "success" });
      const refreshed = await adminApi.subscriptions();
      rows = refreshed.subscriptions || [];
      paint();
    } catch (error) {
      toastError(error);
    }
  });

  delegate(qs("#sub-table"), "click", "[data-credits]", async (_event, node) => {
    const row = rows.find((item) => item.user_id === node.getAttribute("data-credits"));
    if (!row) return;
    const label = row.customer?.email || row.user_id.slice(0, 8);
    const confirmed = await confirmDialog({
      title: `Reset AI credits for ${label}?`,
      desc: `Used ${Number(row.ai_credits_used)} of ${Number(row.ai_credits_limit)} this period. Only a super administrator can do this, and the reset is recorded.`,
      confirmLabel: "Reset credits"
    });
    if (!confirmed) return;
    const values = await formDialog({
      title: "Reason for the reset",
      fields: [{ name: "reason", label: "Reason", type: "textarea", rows: 3, required: true, placeholder: "Recorded in the audit trail" }],
      submitLabel: "Reset credits"
    });
    if (!values) return;
    try {
      await adminApi.resetCredits({ userId: row.user_id, reason: values.reason });
      toast({ title: "AI credits reset" }, { tone: "success" });
      const refreshed = await adminApi.subscriptions();
      rows = refreshed.subscriptions || [];
      paint();
    } catch (error) {
      toastError(error);
    }
  });
}

/* ------------------------------------------------------- projects, deploys */
async function renderProjects(root) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Projects & deployments</h1>
        <p>Every generated project across the platform, plus GitHub pushes and Vercel deployments recorded with their provider state.</p>
      </div>
    </div>
    <div class="admin-split">
      <div class="admin-card">
        <div class="admin-card-head"><div><div class="admin-card-title">Projects</div><div class="admin-card-sub" id="proj-count">Loading…</div></div></div>
        <div id="proj-table"></div>
      </div>
      <div class="admin-card">
        <div class="admin-card-head"><div><div class="admin-card-title">Deployments</div><div class="admin-card-sub" id="dep-count">Loading…</div></div></div>
        <div id="dep-table"></div>
      </div>
    </div>`;

  try {
    const [projects, deployments] = await Promise.all([adminApi.projects({}), adminApi.deployments()]);
    const projectRows = projects.projects || [];
    const deploymentRows = deployments.deployments || [];

    qs("#proj-count").textContent = `${projectRows.length} projects`;
    safeSet("#proj-table", projectRows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Project</th><th>Customer</th><th>Type</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>${projectRows
            .map(
              (row) => `<tr>
                <td><div class="cell-strong">${esc(row.name)}</div><div class="cell-sub mono">${esc(row.slug || "—")}</div></td>
                <td>${esc(row.customer?.email || "—")}</td>
                <td>${esc(row.type)}</td>
                <td><span class="badge badge-${row.status === "published" ? "ok" : "neutral"}">${esc(row.status)}</span></td>
                <td class="dim">${esc(timeAgo(row.updated_at))}</td>
              </tr>`
            )
            .join("")}</tbody></table></div>`
      : emptyState({ icon: "panels-top-left", title: "No projects yet" }));

    qs("#dep-count").textContent = `${deploymentRows.length} deployments`;
    safeSet("#dep-table", deploymentRows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Provider</th><th>Target</th><th>Status</th><th>When</th></tr></thead>
          <tbody>${deploymentRows
            .map(
              (row) => `<tr>
                <td>${esc(row.provider)}</td>
                <td class="mono" style="font-size:var(--fs-2xs)">${esc(row.repo_full_name || row.url || row.external_id || "—")}</td>
                <td><span class="badge badge-${row.status === "ready" ? "ok" : row.status === "error" ? "danger" : "warn"}">${esc(row.status)}</span></td>
                <td class="dim">${esc(timeAgo(row.created_at))}</td>
              </tr>`
            )
            .join("")}</tbody></table></div>`
      : emptyState({ icon: "rocket", title: "No deployments", desc: "GitHub pushes and Vercel deploys are recorded here with their real provider status." }));
  } catch (error) {
    safeSet("#proj-table", `<div class="admin-empty">${esc(error.message)}</div>`);
  }
}

/* ----------------------------------------------------------------- support */
async function renderSupport(root) {
  let filter = "all";
  let rows = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Support</h1>
        <p>Tickets raised by customers and messages sent to the platform team. Replies notify the customer and move the ticket to pending.</p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="ticket-tabs">
          ${["all", "escalated", "open", "pending", "resolved", "closed"]
            .map((value) => `<button data-tab="${value}" class="${value === filter ? "is-active" : ""}">${esc(value)}</button>`)
            .join("")}
        </div>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head"><div><div class="admin-card-title">Tickets</div><div class="admin-card-sub" id="ticket-count">Loading…</div></div></div>
      <div id="ticket-table"></div>
    </div>`;

  await load();

  on(qs("#ticket-tabs"), "click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    filter = button.getAttribute("data-tab");
    root.querySelectorAll("#ticket-tabs button").forEach((node) => node.classList.toggle("is-active", node === button));
    load();
  });

  delegate(qs("#ticket-table"), "click", "[data-archive]", (_event, node) => {
    archiveRecordHandler("support_tickets", node.getAttribute("data-id"), () => renderSupport(root));
  });

  delegate(qs("#ticket-table"), "click", "[data-open]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-open"));
    if (row) open(row);
  });

  async function load() {
    try {
      const response = await adminApi.tickets({ status: filter });
      rows = response.tickets || [];
      qs("#ticket-count").textContent = `${rows.length} tickets`;
      safeSet("#ticket-table", rows.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Subject</th><th>Customer</th><th>Type</th><th>Priority</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>${rows
              .map(
                (row) => `<tr>
                  <td><div class="cell-strong">${esc(row.subject)}${
                    row.escalated_at ? ` <span class="badge badge-warn">Escalated</span>` : ""
                  }${row.auto_reply ? ` <span class="badge badge-neutral">Auto-reply</span>` : ""}</div><div class="cell-sub" style="max-width:340px">${esc((row.message || "").slice(0, 90))}</div>${
                    row.escalation_reason
                      ? `<div class="cell-sub" style="max-width:340px;color:var(--warn)">Escalated: ${esc(row.escalation_reason)}</div>`
                      : ""
                  }</td>
                  <td>${esc(row.customer_email_used || row.customer?.email || "—")}</td>
                  <td>${esc(row.ticket_type === "platform" ? "Shinzora" : "Customer")}</td>
                  <td><span class="badge badge-${row.priority === "urgent" ? "danger" : row.priority === "high" ? "warn" : "neutral"}">${esc(row.priority)}</span></td>
                  <td><span class="badge badge-${row.status === "open" ? "warn" : row.status === "resolved" ? "ok" : "neutral"}">${esc(row.status)}</span></td>
                  <td class="dim">${esc(timeAgo(row.updated_at))}</td>
                  <td class="cell-actions">
                    <button class="btn btn-secondary btn-sm" data-open="${esc(row.id)}">Open</button>
                    <button class="btn btn-ghost btn-sm" data-archive="support_tickets" data-id="${esc(row.id)}">Archive</button>
                  </td>
                </tr>`
              )
              .join("")}</tbody></table></div>`
        : emptyState({ icon: "life-buoy", title: "No tickets in this view" }));
    } catch (error) {
      safeSet("#ticket-table", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function open(ticket) {
    const replies = ticket.replies || [];
    const modal = openModal({
      title: ticket.subject,
      desc: `${ticket.customer?.email || ""} · ${dateTime(ticket.created_at)}`,
      size: "lg",
      body: `
        <div class="stack gap-3" style="margin-bottom:var(--s-4)">
          <div class="msg msg-user">
            <span class="msg-avatar">${esc(initials(ticket.customer?.full_name || ticket.customer?.email))}</span>
            <div><div class="msg-bubble">${esc(ticket.message)}</div><div class="msg-meta">${esc(ticket.customer?.email || "customer")} · ${esc(timeAgo(ticket.created_at))}</div></div>
          </div>
          ${replies
            .map(
              (reply) => `<div class="msg ${reply.author_role === "admin" ? "msg-ai" : "msg-user"}">
                <span class="msg-avatar">${reply.author_role === "admin" ? icon("shield-check", { size: 13 }) : "CU"}</span>
                <div><div class="msg-bubble">${esc(reply.body)}</div><div class="msg-meta">${esc(reply.author_role)} · ${esc(timeAgo(reply.created_at))}</div></div>
              </div>`
            )
            .join("")}
        </div>
        <div class="field">
          <label class="field-label" for="admin-reply">Reply as Shinzora</label>
          <textarea class="textarea" id="admin-reply" rows="4" placeholder="Answer the ticket. The customer is notified immediately."></textarea>
        </div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
               <button class="btn btn-secondary" id="close-ticket">Mark resolved</button>
               <button class="btn btn-primary" id="send-reply">Send reply</button>`
    });

    qs("#send-reply", modal.root).addEventListener("click", async () => {
      const body = qs("#admin-reply", modal.root).value.trim();
      if (body.length < 2) return toast({ title: "Write a reply first" }, { tone: "warning" });
      try {
        await adminApi.ticketReply({ ticketId: ticket.id, body });
        modal.close();
        toast({ title: "Reply sent" }, { tone: "success" });
        await load();
      } catch (error) {
        toastError(error);
      }
    });

    qs("#close-ticket", modal.root).addEventListener("click", async () => {
      try {
        await adminApi.ticketStatus({ ticketId: ticket.id, status: "resolved" });
        modal.close();
        toast({ title: "Ticket resolved" }, { tone: "success" });
        await load();
      } catch (error) {
        toastError(error);
      }
    });
  }
}

/* ---------------------------------------------------------------- contacts */
async function renderContacts(root) {
  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Contact messages</h1>
        <p>Submissions from the website contact form. They are stored in <span class="mono">contact_messages</span> and readable only by administrators.</p>
      </div>
    </div>
    <div class="admin-card"><div id="contact-table"></div></div>`;

  try {
    const response = await adminApi.contacts();
    const rows = response.messages || [];
    safeSet("#contact-table", rows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>From</th><th>Topic</th><th>Message</th><th>Status</th><th>Received</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (row) => `<tr>
                <td><div class="cell-strong">${esc(row.name)}</div><div class="cell-sub">${esc(row.email)}${row.phone ? ` · ${esc(row.phone)}` : ""}</div></td>
                <td>${esc(row.topic || "—")}</td>
                <td style="max-width:380px"><div class="cell-sub clamp-2">${esc(row.message)}</div></td>
                <td><span class="badge badge-${row.status === "new" ? "warn" : "neutral"}">${esc(row.status)}</span></td>
                <td class="dim">${esc(timeAgo(row.created_at))}</td>
                <td class="cell-actions">
                  <a class="btn btn-ghost btn-sm" href="mailto:${esc(row.email)}?subject=${encodeURIComponent("Re: your message to Shinzora")}">Reply</a>
                  ${row.status === "new" ? `<button class="btn btn-secondary btn-sm" data-read="${esc(row.id)}">Mark read</button>` : ""}
                  <button class="btn btn-ghost btn-sm" data-archive="contact_messages" data-id="${esc(row.id)}">Archive</button>
                </td>
              </tr>`
            )
            .join("")}</tbody></table></div>`
      : emptyState({ icon: "mail", title: "No contact messages", desc: "Submissions from the website land here." }));

    delegate(qs("#contact-table"), "click", "[data-archive]", (_event, node) => {
      archiveRecordHandler("contact_messages", node.getAttribute("data-id"), () => renderContacts(root));
    });

    delegate(qs("#contact-table"), "click", "[data-read]", async (_event, node) => {
      try {
        await adminApi.contactUpdate({ id: node.getAttribute("data-read"), status: "read" });
        toast({ title: "Marked as read" }, { tone: "success" });
        renderContacts(root);
      } catch (error) {
        toastError(error);
      }
    });
  } catch (error) {
    safeSet("#contact-table", `<div class="admin-empty">${esc(error.message)}</div>`);
  }

  void money;
  void confirmDialog;
  void statusLabel;
}

/* --------------------------------------------------------------------------
   Archiving — one handler for tickets and contact messages.
   A record that is archived leaves every list but keeps its row, its history
   and its timestamp; nothing here destroys what a customer wrote to us.
   -------------------------------------------------------------------------- */
export async function archiveRecordHandler(table, id, reload) {
  const confirmed = await confirmDialog({
    title: table === "support_tickets" ? "Archive this ticket?" : "Archive this message?",
    desc: "It disappears from the active list and stays in the database with its full history.",
    confirmLabel: "Archive"
  });
  if (!confirmed) return;

  const values = await formDialog({
    title: "Reason",
    fields: [{ name: "reason", label: "Why is this being archived?", type: "textarea", rows: 2, required: true }],
    submitLabel: "Archive"
  });
  if (!values) return;

  try {
    await adminApi.archiveRecord({ table, id, reason: values.reason });
    toast({ title: "Archived" }, { tone: "success" });
    reload();
  } catch (error) {
    toastError(error);
  }
}
