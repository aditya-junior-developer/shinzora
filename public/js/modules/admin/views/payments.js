/* ==========================================================================
   Admin · Payments and service requests
   Payment review is the only manual path that can mark money as received.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, dateTime, initials, statusLabel } from "../../../lib/format.js";
import { adminApi } from "../api.js";
import { adminState } from "../shell.js";
import { emptyState } from "../../dashboard/components.js";
import { openModal, confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const PAYMENT_TABS = [
  { id: "awaiting_verification", label: "Awaiting verification" },
  { id: "pending", label: "Not paid" },
  { id: "verified", label: "Verified" },
  { id: "rejected", label: "Rejected / failed" },
  { id: "all", label: "All" }
];

const SERVICE_TABS = [
  { id: "requested", label: "Requested" },
  { id: "approved", label: "Approved" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "all", label: "All" }
];

/* `payments.submit_proof` records the payer's VPA as "Payer UPI: x@y" in the
   note column (the schema has no dedicated field), so the reviewer sees the
   exact account the money came from without having to parse it by eye. */
function payerUpi(note = "") {
  const match = String(note || "").match(/Payer UPI:\s*([a-z0-9._-]+@[a-z0-9]+)/i);
  return match ? match[1] : "";
}

function customerNote(note = "") {
  return String(note || "")
    .replace(/Payer UPI:\s*[a-z0-9._-]+@[a-z0-9]+\s*·?\s*/i, "")
    .trim();
}

export default async function render(root, { view }) {
  if (view === "services") return renderServices(root);
  return renderPayments(root);
}

/* ---------------------------------------------------------------- payments */
async function renderPayments(root) {
  let tab = "awaiting_verification";
  let rows = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Payments</h1>
        <p>
          Match the UTR against the UPI statement, then approve or reject. Approval activates the plan or service and
          notifies the customer; rejection leaves everything untouched.
        </p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="payment-tabs">
          ${PAYMENT_TABS.map((item) => `<button data-tab="${item.id}" class="${item.id === tab ? "is-active" : ""}">${esc(item.label)}</button>`).join("")}
        </div>
      </div>
    </div>

    <div class="admin-note" style="margin-bottom:var(--s-4)">
      ${icon("shield-alert", { size: 15 })}
      <span>
        Never approve a payment because the customer says they paid. Approve only when the credit appears in the bank or
        UPI statement, or when a verified provider callback has already moved it — in which case it will not appear in
        this queue.
      </span>
    </div>

    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Payment records</div>
          <div class="admin-card-sub" id="payment-count">Loading…</div>
        </div>
        <div class="admin-search" style="max-width:280px;display:block">
          ${icon("search", { size: 14 })}
          <input id="payment-search" type="search" placeholder="Reference, UTR or email" aria-label="Search payments" />
        </div>
      </div>
      <div id="payment-table"></div>
    </div>`;

  await load();

  on(qs("#payment-tabs"), "click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tab = button.getAttribute("data-tab");
    root.querySelectorAll("#payment-tabs button").forEach((node) => node.classList.toggle("is-active", node === button));
    load();
  });

  let timer;
  on(qs("#payment-search"), "input", () => {
    clearTimeout(timer);
    timer = setTimeout(paint, 250);
  });

  delegate(qs("#payment-table"), "click", "[data-remove]", async (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-remove"));
    if (!row) return;
    await removePayment(row);
  });

  delegate(qs("#payment-table"), "click", "[data-review]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-review"));
    if (row) review(row);
  });

  async function load() {
    try {
      const response = await adminApi.payments({ status: tab });
      rows = response.payments || [];
      qs("#payment-count").textContent = `${rows.length} record${rows.length === 1 ? "" : "s"} · ${statusLabel(tab)}`;
      paint();
    } catch (error) {
      safeSet("#payment-table", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function paint() {
    const term = (qs("#payment-search")?.value || "").toLowerCase();
    const visible = rows.filter((row) => {
      if (!term) return true;
      return `${row.reference} ${row.utr || ""} ${row.customer?.email || ""} ${row.customer?.full_name || ""} ${row.label || ""}`
        .toLowerCase()
        .includes(term);
    });

    safeSet("#payment-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Reference</th><th>Customer</th><th>Purpose</th><th>Amount</th><th>UTR</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${visible
            .map(
              (row) => `<tr>
                <td class="mono" style="font-size:var(--fs-2xs)">${esc(row.reference)}</td>
                <td>
                  <div class="customer-cell">
                    <span class="avatar">${esc(initials(row.customer?.full_name || row.customer?.email))}</span>
                    <div><strong>${esc(row.customer?.full_name || "Unknown")}</strong><span>${esc(row.customer?.email || (row.owner_id ? row.owner_id.slice(0, 8) : "—"))}</span></div>
                  </div>
                </td>
                <td>${esc(row.label || row.purpose)}</td>
                <td>${esc(money(row.amount, row.currency))}</td>
                <td class="mono" style="font-size:var(--fs-2xs)">${esc(row.utr || "—")}</td>
                <td><span class="badge badge-${row.status === "verified" ? "ok" : row.status === "rejected" ? "danger" : "warn"}">${esc(statusLabel(row.status))}</span></td>
                <td class="dim">${esc(timeAgo(row.created_at))}</td>
                <td class="cell-actions">
                  ${
                    row.status === "verified"
                      ? `<button class="btn btn-ghost btn-sm" data-review="${esc(row.id)}">Details</button>`
                      : `<button class="btn btn-primary btn-sm" data-review="${esc(row.id)}">Review</button>`
                  }
                  <button class="btn btn-ghost btn-sm" data-remove="${esc(row.id)}" title="${
                    row.status === "verified" || row.status === "awaiting_verification"
                      ? "Void this record — it is kept for audit"
                      : "Archive or delete this record"
                  }">${row.status === "verified" ? "Void" : "Remove"}</button>
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({
          icon: "receipt",
          title: "Nothing in this queue",
          desc: "Payments appear here as customers create them. Switch tabs to see other states."
        }));
  }

  /* The database decides what "remove" means. Money-bearing records are voided
     and kept; only a row that never reached a money state can be deleted, and
     even then a full snapshot goes into the audit trail first. The dialog below
     states which of those is about to happen, before it happens. */
  async function removePayment(row) {
    const state = String(row.status || "");
    const protectedState = ["verified", "awaiting_verification", "refunded"].includes(state);
    const canDelete = ["pending", "rejected", "cancelled"].includes(state);

    const values = await formDialog({
      title: `Remove payment ${row.reference}`,
      desc: protectedState
        ? "This record is voided, not deleted: the amount, the UTR and the verified state are preserved for accounting."
        : "This record never reached a money state, so it can be removed permanently — a snapshot is kept in the audit trail.",
      fields: [
        {
          name: "reason",
          label: "Reason",
          type: "textarea",
          rows: 3,
          required: true,
          placeholder: "Why is this record being removed? Stored in the audit trail."
        },
        ...(canDelete
          ? [
              {
                name: "hard",
                label: "Delete permanently instead of archiving",
                type: "select",
                value: "false",
                options: [
                  { value: "false", label: "Archive (recoverable)" },
                  { value: "true", label: "Delete permanently" }
                ],
                hint: "Archived records disappear from every list and stay in the database."
              }
            ]
          : [])
      ],
      submitLabel: protectedState ? "Void this payment" : "Remove"
    });
    if (!values) return;

    try {
      const response = await adminApi.paymentDelete({
        paymentId: row.id,
        reason: values.reason,
        hard: values.hard === "true"
      });
      const how = response?.result?.removal === "deleted" ? "deleted" : response?.result?.status === "verified" ? "voided" : "archived";
      toast({ title: `Payment ${how}` }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
    }
  }

  function review(row) {
    const verified = row.status === "verified";

    const modal = openModal({
      title: `Payment ${row.reference}`,
      desc: `${row.customer?.full_name || row.customer?.email || "Customer"} · ${dateTime(row.created_at)}`,
      size: "lg",
      body: `
        <div class="admin-grid" style="margin-bottom:var(--s-4)">
          <div class="admin-stat"><div class="admin-stat-label">Amount</div><div class="admin-stat-value">${esc(money(row.amount, row.currency))}</div></div>
          <div class="admin-stat"><div class="admin-stat-label">Purpose</div><div class="admin-stat-value" style="font-size:1rem">${esc(row.label || row.purpose)}</div></div>
          <div class="admin-stat"><div class="admin-stat-label">Status</div><div class="admin-stat-value" style="font-size:1rem">${esc(statusLabel(row.status))}</div></div>
        </div>
        <dl class="admin-kv">
          <dt>Reference</dt><dd class="mono">${esc(row.reference)}</dd>
          <dt>UTR</dt><dd class="mono">${esc(row.utr || "not submitted")}</dd>
          <dt>Method</dt><dd>${esc(row.method || "upi_qr")}</dd>
          <dt>Paid from (UPI ID)</dt><dd class="mono">${esc(payerUpi(row.note) || "not provided")}</dd>
          <dt>Customer note</dt><dd>${esc(customerNote(row.note) || "—")}</dd>
          <dt>Paid on</dt><dd>${row.paid_at ? esc(dateTime(row.paid_at)) : "—"}</dd>
          <dt>Contact</dt><dd>${esc(row.customer?.email || "—")} ${row.customer?.phone ? `· ${esc(row.customer.phone)}` : ""}</dd>
          ${verified ? `<dt>Verified</dt><dd>${esc(dateTime(row.verified_at))} — ${esc(row.admin_note || "approved")}</dd>` : ""}
          ${row.admin_note && !verified ? `<dt>Admin note</dt><dd>${esc(row.admin_note)}</dd>` : ""}
        </dl>
        ${
          verified
            ? ""
            : `<div class="field" style="margin-top:var(--s-4)">
                <label class="field-label" for="review-note">Review note (visible to the customer)</label>
                <textarea class="textarea" id="review-note" rows="2" placeholder="e.g. Matched UTR in the UPI statement"></textarea>
              </div>`
        }`,
      footer: verified
        ? `<button class="btn btn-ghost" data-modal-close>Close</button>`
        : `<button class="btn btn-ghost" data-modal-close>Close</button>
           <button class="btn btn-secondary" id="reject-payment">Reject</button>
           <button class="btn btn-primary" id="approve-payment">Approve payment</button>`
    });

    if (verified) return;

    qs("#approve-payment", modal.root).addEventListener("click", async () => {
      const note = qs("#review-note", modal.root).value.trim();
      const ok = await confirmDialog({
        title: "Approve this payment?",
        desc: `${money(row.amount, row.currency)} for ${row.label || row.purpose}. This activates the plan or service immediately and cannot be undone from the UI.`,
        confirmLabel: "Approve",
        requireText: "APPROVE"
      });
      if (!ok) return;
      modal.close();
      try {
        await adminApi.paymentReview({ paymentId: row.id, decision: "approve", note });
        toast({ title: "Payment approved", message: "Plan or service activated and the customer has been notified." }, { tone: "success" });
        await load();
      } catch (error) {
        toastError(error);
      }
    });

    qs("#reject-payment", modal.root).addEventListener("click", async () => {
      const note = qs("#review-note", modal.root).value.trim();
      const ok = await confirmDialog({
        title: "Reject this payment?",
        desc: "The customer is asked to check the transaction ID. Nothing is activated.",
        confirmLabel: "Reject",
        tone: "danger"
      });
      if (!ok) return;
      modal.close();
      try {
        await adminApi.paymentReview({ paymentId: row.id, decision: "reject", note });
        toast({ title: "Payment rejected" }, { tone: "success" });
        await load();
      } catch (error) {
        toastError(error);
      }
    });
  }

  void adminState;
}

/* -------------------------------------------------------- service requests */
/**
 * `service_requests.details` is a JSONB column, so it arrives as an object for
 * structured requests and as a string for free text. Calling `.slice()` on the
 * object form threw inside the row template, which took down the entire table
 * and printed the TypeError into the cell.
 */
function detailText(value, max = 140) {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function renderServices(root) {
  let tab = "requested";
  let rows = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Service requests</h1>
        <p>Managed work requested by customers: setup, brand kits, store builds and account actions. Approving records a decision; the work itself is tracked by status.</p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="service-tabs">
          ${SERVICE_TABS.map((item) => `<button data-tab="${item.id}" class="${item.id === tab ? "is-active" : ""}">${esc(item.label)}</button>`).join("")}
        </div>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div><div class="admin-card-title">Requests</div><div class="admin-card-sub" id="service-count">Loading…</div></div>
      </div>
      <div id="service-table"></div>
    </div>`;

  await load();

  on(qs("#service-tabs"), "click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tab = button.getAttribute("data-tab");
    root.querySelectorAll("#service-tabs button").forEach((node) => node.classList.toggle("is-active", node === button));
    load();
  });

  delegate(qs("#service-table"), "click", "[data-manage]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-manage"));
    if (row) manage(row);
  });

  async function load() {
    try {
      const response = await adminApi.serviceRequests({ status: tab });
      rows = response.requests || [];
      qs("#service-count").textContent = `${rows.length} request${rows.length === 1 ? "" : "s"}`;
      paint();
    } catch (error) {
      safeSet("#service-table", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function paint() {
    safeSet("#service-table", rows.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Service</th><th>Customer</th><th>Amount</th><th>Status</th><th>Requested</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (row) => `<tr>
                <td>
                  <div class="cell-strong">${esc(row.title || row.service_type)}</div>
                  <div class="cell-sub" style="max-width:420px">${esc(detailText(row.details, 140))}</div>
                </td>
                <td>${esc(row.customer?.full_name || "—")}<div class="cell-sub">${esc(row.customer?.email || "")}</div></td>
                <td>${row.amount ? esc(money(row.amount, "INR")) : "—"}</td>
                <td><span class="badge badge-${row.status === "completed" ? "ok" : row.status === "rejected" ? "danger" : "warn"}">${esc(statusLabel(row.status))}</span></td>
                <td class="dim">${esc(timeAgo(row.created_at))}</td>
                <td class="cell-actions"><button class="btn btn-secondary btn-sm" data-manage="${esc(row.id)}">Manage</button></td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({ icon: "briefcase", title: "No requests in this state", desc: "Customers create these from Billing or Settings." }));
  }

  function manage(row) {
    openModal({
      title: row.title || row.service_type,
      desc: `${row.customer?.email || ""} · ${dateTime(row.created_at)}`,
      size: "lg",
      body: `
        <dl class="admin-kv">
          <dt>Type</dt><dd>${esc(row.service_type)}</dd>
          <dt>Status</dt><dd>${esc(statusLabel(row.status))}</dd>
          <dt>Amount</dt><dd>${row.amount ? esc(money(row.amount, "INR")) : "—"}</dd>
          <dt>Details</dt><dd style="white-space:pre-wrap">${esc(detailText(row.details, 1200))}</dd>
          ${row.admin_note ? `<dt>Your note</dt><dd>${esc(row.admin_note)}</dd>` : ""}
        </dl>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
               <button class="btn btn-secondary" id="reject-service">Reject</button>
               <button class="btn btn-primary" id="advance-service">Advance status</button>`,
      onMount: (dialog, controller) => {
        qs("#advance-service", dialog).addEventListener("click", async () => {
          controller.close();
          const values = await formDialog({
            title: "Update request",
            fields: [
              {
                name: "status",
                label: "New status",
                type: "select",
                value: nextServiceStatus(row.status),
                options: ["approved", "in_progress", "completed", "cancelled"].map((value) => ({ value, label: statusLabel(value) }))
              },
              { name: "note", label: "Note to customer", type: "textarea", rows: 3 }
            ],
            submitLabel: "Update"
          });
          if (!values) return;
          try {
            await adminApi.serviceRequestUpdate({ id: row.id, status: values.status, note: values.note });
            toast({ title: "Request updated" }, { tone: "success" });
            await load();
          } catch (error) {
            toastError(error);
          }
        });

        qs("#reject-service", dialog).addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: "Reject this request?",
            desc: "The customer is notified. No payment is refunded from here.",
            confirmLabel: "Reject",
            tone: "danger"
          });
          if (!ok) return;
          controller.close();
          try {
            await adminApi.serviceRequestUpdate({ id: row.id, status: "rejected", note: "Rejected by administrator" });
            toast({ title: "Request rejected" }, { tone: "success" });
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      }
    });
  }

  function nextServiceStatus(status) {
    return { requested: "approved", approved: "in_progress", in_progress: "completed", completed: "completed", rejected: "approved", cancelled: "approved" }[status] || "in_progress";
  }

  void initials;
}
