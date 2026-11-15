/* ==========================================================================
   Admin · Request Services
   Every request from every customer, with five statuses, an assignee and a
   reply. One save writes the status, the note the customer will read, and
   the assignee together. The database trigger tells the customer about each
   change, so this view never writes a notification itself.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime } from "../../../lib/format.js";
import { adminApi } from "../api.js";
import { emptyState } from "../../dashboard/components.js";
import { openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { REQUEST_CATEGORIES, REQUEST_STATUSES, categoryById, statusById } from "../../../config/request-services.js";

/* Requests written before 0055 may still carry older names. Show them as the
   current equivalent. The migration already converted stored rows. */
const LEGACY_STATUS = { requested: "submitted", approved: "under_review", cancelled: "rejected" };
const statusOf = (s) => statusById(s)?.id || LEGACY_STATUS[s] || "submitted";
const OPEN = new Set(["submitted", "under_review", "in_progress"]);

const TABS = [{ id: "all", label: "All" }, ...REQUEST_STATUSES.map((s) => ({ id: s.id, label: s.label }))];

const LEGACY_LABEL = {
  plan_upgrade: "Plan upgrade",
  account_deletion: "Account deletion",
  domain_registration: "Domain registration",
  website_setup: "Managed website setup",
  brand_kit: "Brand kit",
  store_setup: "Store setup"
};

function categoryName(row) {
  return categoryById(row.service_type)?.label || LEGACY_LABEL[row.service_type] || row.title || row.service_type || "Request";
}

function reference(row) {
  return row.reference || `SR-${String(row.id || "").slice(0, 8).toUpperCase()}`;
}

function rupees(value) {
  return value == null || value === "" ? "—" : `₹${Number(value).toLocaleString("en-IN")}`;
}

/* Overdue only while the request is still open; a closed request is history. */
function isOverdue(row) {
  const raw = row.respond_by || row.due_at;
  return Boolean(raw) && OPEN.has(statusOf(row.status)) && new Date(raw).getTime() < Date.now();
}

function statusBadge(status) {
  const meta = statusById(statusOf(status));
  return `<span class="badge badge-${meta.tone}"><span class="dot"></span>${esc(meta.label)}</span>`;
}

function contactCell(row) {
  const c = row.customer || {};
  const name = row.contact_name || c.full_name || "—";
  const email = row.contact_email || c.email || "";
  const phone = row.contact_phone || c.phone || "";
  return `<div>${esc(name)}</div>
    <div class="cell-sub">${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ""}${
      phone ? ` · <a href="tel:${esc(phone.replace(/\s+/g, ""))}">${esc(phone)}</a>` : ""
    }</div>`;
}

export default async function renderServiceRequests(root) {
  let tab = "all";
  let rows = [];
  let admins = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Request Services</h1>
        <p>Requests from customers, with their budget and contact details. Each one needs a specialist to reply within 24 hours of submission. Changing a status or replying notifies the customer.</p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="sr-tabs" role="tablist">
          ${TABS.map((item) => `<button role="tab" data-tab="${esc(item.id)}" aria-selected="${item.id === tab}" class="${item.id === tab ? "is-active" : ""}">${esc(item.label)}</button>`).join("")}
        </div>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div><div class="admin-card-title">Requests</div><div class="admin-card-sub" id="sr-count">Loading…</div></div>
      </div>
      <div id="sr-table"></div>
    </div>`;

  on(qs("#sr-tabs", root), "click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tab = button.getAttribute("data-tab");
    root.querySelectorAll("#sr-tabs button").forEach((node) => {
      const on = node === button;
      node.classList.toggle("is-active", on);
      node.setAttribute("aria-selected", String(on));
    });
    load();
  });

  delegate(qs("#sr-table", root), "click", "[data-manage]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-manage"));
    if (row) manage(row);
  });

  await load();

  async function load() {
    try {
      const [response, staff] = await Promise.all([
        adminApi.serviceRequests({ status: tab }),
        admins.length ? Promise.resolve(null) : adminApi.admins().catch(() => null)
      ]);
      rows = response.requests || [];
      if (staff?.admins) admins = staff.admins;
      qs("#sr-count", root).textContent = `${rows.length} request${rows.length === 1 ? "" : "s"}${
        rows.some(isOverdue) ? ` · ${rows.filter(isOverdue).length} past 24 hours` : ""
      }`;
      paint();
    } catch (error) {
      safeSet("#sr-table", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function paint() {
    if (!rows.length) {
      safeSet(
        "#sr-table",
        emptyState({
          icon: "briefcase",
          title: "No requests in this state",
          desc: "Customers submit these from Request Services. Each one appears here as soon as it is saved."
        })
      );
      return;
    }
    safeSet(
      "#sr-table",
      `<div class="table-wrap"><table class="table">
        <thead><tr>
          <th>Request</th><th>Customer</th><th>Budget</th><th>Status</th><th>Contact by</th><th>Assigned</th><th>Submitted</th><th></th>
        </tr></thead>
        <tbody>${rows
          .map((row) => {
            const overdue = isOverdue(row);
            const target = row.respond_by || row.due_at;
            const assignee = admins.find((a) => a.user_id === row.assigned_to);
            return `<tr class="${overdue ? "is-overdue" : ""}">
              <td>
                <div class="cell-strong">${esc(categoryName(row))}</div>
                <div class="cell-sub">${esc(reference(row))}${row.title && row.title !== categoryName(row) ? ` · ${esc(row.title)}` : ""}</div>
                ${row.custom_description ? `<div class="cell-sub sr-snippet">${esc(row.custom_description)}</div>` : ""}
              </td>
              <td>${contactCell(row)}</td>
              <td>${esc(rupees(row.budget_inr ?? row.amount))}</td>
              <td>${statusBadge(row.status)}</td>
              <td>${
                target
                  ? `<span class="${overdue ? "sr-overdue" : "dim"}">${overdue ? icon("circle-alert", { size: 12 }) + " " : ""}${esc(dateTime(target))}</span>`
                  : "—"
              }</td>
              <td class="dim">${assignee ? esc(assignee.email) : "Unassigned"}</td>
              <td class="dim">${esc(timeAgo(row.created_at))}</td>
              <td class="cell-actions"><button class="btn btn-secondary btn-sm" data-manage="${esc(row.id)}">Manage</button></td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div>`
    );
  }

  function manage(row) {
    const current = statusOf(row.status);
    const staffOptions = admins
      .map(
        (a) =>
          `<option value="${esc(a.user_id)}"${a.user_id === row.assigned_to ? " selected" : ""}>${esc(a.email || a.user_id)}</option>`
      )
      .join("");

    openModal({
      title: `${categoryName(row)} · ${reference(row)}`,
      desc: `${row.contact_email || row.customer?.email || ""} · submitted ${dateTime(row.created_at)}`,
      size: "lg",
      body: `
        <dl class="admin-kv">
          <dt>Category</dt><dd>${esc(categoryName(row))}</dd>
          <dt>Budget</dt><dd>${esc(rupees(row.budget_inr ?? row.amount))}</dd>
          <dt>Customer</dt><dd>${esc(row.contact_name || row.customer?.full_name || "—")}${
            row.contact_phone || row.customer?.phone ? ` · ${esc(row.contact_phone || row.customer?.phone)}` : ""
          }</dd>
          <dt>Contact by</dt><dd>${row.respond_by || row.due_at ? esc(dateTime(row.respond_by || row.due_at)) : "—"}${
            isOverdue(row) ? ' <span class="sr-overdue">past 24 hours</span>' : ""
          }</dd>
          ${
            row.custom_description
              ? `<dt>Requirements</dt><dd style="white-space:pre-wrap">${esc(row.custom_description)}</dd>`
              : ""
          }
        </dl>
        <form id="sr-manage" class="stack gap-4" novalidate style="margin-top:var(--s-4)">
          <label class="field">
            <span class="field-label">Status</span>
            <select class="input" name="status">
              ${REQUEST_STATUSES.map((s) => `<option value="${s.id}"${s.id === current ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Assigned to</span>
            <select class="input" name="assigned_to">
              <option value="">Unassigned</option>
              ${staffOptions}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Reply to the customer <span class="optional">shown in their request</span></span>
            <textarea class="input" name="note" rows="4" maxlength="2000" placeholder="What happens next, or why it could not be taken on.">${esc(row.admin_note || "")}</textarea>
            <span class="field-hint" id="sr-note-hint"></span>
          </label>
          <div class="field-error" id="sr-error" role="alert"></div>
        </form>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
               <button class="btn btn-primary" id="sr-save" type="button">${icon("check", { size: 14 })}Save changes</button>`,
      onMount: (dialog, controller) => {
        const form = qs("#sr-manage", dialog);
        const note = form.elements.note;
        const hint = qs("#sr-note-hint", dialog);
        const error = qs("#sr-error", dialog);

        /* A rejection must say why, so the customer is not left guessing. */
        const sync = () => {
          const rejecting = form.elements.status.value === "rejected";
          hint.textContent = rejecting ? "Add a reason. The customer reads it." : "";
          error.textContent = "";
        };
        form.elements.status.addEventListener("change", sync);
        sync();

        qs("#sr-save", dialog).addEventListener("click", async () => {
          const status = form.elements.status.value;
          const reply = note.value.trim();
          if (status === "rejected" && !reply) {
            error.textContent = "Give the customer a reason before rejecting this request.";
            note.focus();
            return;
          }
          const assignee = form.elements.assigned_to.value;
          const button = qs("#sr-save", dialog);
          button.disabled = true;
          try {
            await adminApi.serviceRequestUpdate({
              id: row.id,
              status,
              note: reply,
              assigned_to: assignee || null
            });
            toast({ title: "Request saved", message: "The customer has been notified of any change." }, { tone: "success" });
            controller.close();
            await load();
          } catch (err) {
            toastError(err);
            button.disabled = false;
          }
        });
      }
    });
  }
}
