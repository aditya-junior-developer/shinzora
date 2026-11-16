/* ==========================================================================
   Admin · Premium profiles (P6)
   A premium order appears only after its payment is verified. Activating it
   is the only thing that grants a tier, and it is due within 24 hours.
   ========================================================================== */

import { qs, esc, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { dateTime, timeAgo, statusLabel, money } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { adminApi } from "../api.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const TABS = [
  { id: "awaiting_activation", label: "Awaiting activation" },
  { id: "activated", label: "Activated" },
  { id: "cancelled", label: "Cancelled" },
  { id: "all", label: "All" }
];

const tierName = (id) => (id === "elite" ? "Elite" : id === "glow" ? "Glow" : id || "—");

export default async function render(root) {
  let tab = "awaiting_activation";
  let orders = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Premium profiles</h1>
        <p>
          Activate a profile once its payment is verified in Payments. Activation is due within 24 hours of verification.
          Cancelling does not refund: refund outside this panel, then record the reason here.
        </p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="premium-tabs">
          ${TABS.map((item) => `<button data-tab="${item.id}" class="${item.id === tab ? "is-active" : ""}">${esc(item.label)}</button>`).join("")}
        </div>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Orders</div>
          <div class="admin-card-sub" id="premium-count">Loading…</div>
        </div>
      </div>
      <div id="premium-table"></div>
    </div>
    <div class="admin-card" style="margin-top:var(--s-4)" id="ring-ledger-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Ring payments</div>
          <div class="admin-card-sub">Every ring order with its payment. Administrators only: members never see this list.</div>
        </div>
      </div>
      <div id="ring-ledger"><div class="admin-empty">Loading…</div></div>
    </div>`;

  await load();
  await loadLedger();

  root.querySelector("#premium-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tab = button.getAttribute("data-tab");
    root.querySelectorAll("#premium-tabs button").forEach((node) => node.classList.toggle("is-active", node === button));
    load();
  });

  delegate(qs("#premium-table"), "click", "[data-activate]", async (_event, node) => {
    const order = orders.find((item) => item.id === node.getAttribute("data-activate"));
    if (!order) return;
    const ok = await confirmDialog({
      title: `Activate ${tierName(order.tier)} for ${order.customer}?`,
      desc: `Payment ${order.payment?.reference || ""} is verified. This sets the ${tierName(order.tier)} profile on the member's account now.`,
      confirmLabel: "Activate profile",
      tone: "primary"
    });
    if (!ok) return;
    try {
      await adminApi.premium({ op: "activate", orderId: order.id });
      toast({ title: "Profile activated", message: `${tierName(order.tier)} is live for ${order.customer}.` }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
      await load();
    }
  });

  delegate(qs("#premium-table"), "click", "[data-cancel]", async (_event, node) => {
    const order = orders.find((item) => item.id === node.getAttribute("data-cancel"));
    if (!order) return;
    const values = await formDialog({
      title: `Cancel ${tierName(order.tier)} request`,
      desc: "Cancelling does not refund. Refund the payment outside this panel, then record why here.",
      fields: [{ name: "note", label: "Reason (shown to the member)", required: true, maxlength: 500 }],
      submitLabel: "Cancel request"
    });
    if (!values) return;
    try {
      await adminApi.premium({ op: "cancel", orderId: order.id, note: values.note });
      toast({ title: "Request cancelled" }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
      await load();
    }
  });

  /* The ledger reads straight from the database with this admin's session.
     admin_ring_ledger() checks is_admin() itself, so a member gets an error. */
  async function loadLedger() {
    try {
      const { data, error } = await sb.rpc("admin_ring_ledger", { p_limit: 100 });
      if (error) throw normalizeError(error);
      paintLedger(Array.isArray(data) ? data : []);
    } catch (error) {
      safeSet("#ring-ledger", `<div class="admin-empty">${esc(error.message || "The ring ledger could not be loaded.")}</div>`);
    }
  }

  function paintLedger(rows) {
    if (!rows.length) {
      safeSet("#ring-ledger", `<div class="admin-empty">No ring orders yet.</div>`);
      return;
    }
    const body = rows
      .map((row) => {
        const paid = row.paid_at ? dateTime(row.paid_at) : "—";
        const shown = row.ring_shown === false ? `<span class="badge badge-neutral">Hidden</span>` : `<span class="badge badge-ok">Shown</span>`;
        return `<tr>
          <td><div>${esc(row.member_name || "—")}</div><div class="dim ring-ledger-cell">${esc(row.member_email || "")}</div></td>
          <td><strong>${esc(tierName(row.tier))}</strong></td>
          <td class="ring-ledger-cell">
            <div>${esc(money(Number(row.payment_amount || 0)))}</div>
            <div class="mono dim">${esc(row.payment_reference || "—")}</div>
          </td>
          <td><span class="badge ${row.payment_status === "verified" ? "badge-ok" : "badge-neutral"}">${esc(statusLabel(row.payment_status || "—"))}</span></td>
          <td class="ring-ledger-cell"><span>${esc(paid)}</span></td>
          <td><span class="badge ${row.order_status === "activated" ? "badge-ok" : row.order_status === "cancelled" ? "badge-danger" : "badge-warn"}">${esc(statusLabel(row.order_status || "—"))}</span></td>
          <td>${shown}</td>
        </tr>`;
      })
      .join("");
    safeSet(
      "#ring-ledger",
      `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Member</th><th>Ring</th><th>Payment</th><th>Payment status</th><th>Paid</th><th>Order</th><th>Shown to members</th>
      </tr></thead><tbody>${body}</tbody></table></div>`
    );
  }

  async function load() {
    try {
      const response = await adminApi.premium({ op: "list", status: tab });
      orders = response.orders || [];
      qs("#premium-count").textContent = `${orders.length} order${orders.length === 1 ? "" : "s"} · ${statusLabel(tab)}`;
      paint();
    } catch (error) {
      safeSet("#premium-table", `<div class="admin-empty">${esc(error.message)}</div>`);
    }
  }

  function paint() {
    if (!orders.length) {
      safeSet("#premium-table", `<div class="admin-empty">No orders in this view.</div>`);
      return;
    }
    const rows = orders
      .map((order) => {
        const waiting = order.status === "awaiting_activation";
        const due = order.due_by ? dateTime(order.due_by) : "—";
        const dueCell = waiting
          ? order.overdue
            ? `<span class="badge badge-danger">Overdue</span> <span class="dim">${esc(due)}</span>`
            : `<span>${esc(due)}</span>`
          : `<span class="dim">${esc(order.activated_at ? dateTime(order.activated_at) : "—")}</span>`;
        return `<tr>
          <td><div>${esc(order.customer)}</div><div class="dim" style="font-size:var(--fs-xs)">${esc(order.email || "")}</div></td>
          <td><strong>${esc(tierName(order.tier))}</strong>${order.currentTier ? `<div class="dim" style="font-size:var(--fs-xs)">Currently ${esc(tierName(order.currentTier))}</div>` : ""}</td>
          <td class="mono" style="font-size:var(--fs-xs)">${esc(order.payment?.reference || "—")}<div class="dim">${order.payment?.verified_at ? esc(timeAgo(order.payment.verified_at)) : ""}</div></td>
          <td>${dueCell}</td>
          <td><span class="badge ${waiting ? "badge-warn" : order.status === "activated" ? "badge-ok" : "badge-neutral"}">${esc(statusLabel(order.status))}</span></td>
          <td>${
            waiting
              ? `<div class="row gap-2"><button class="btn btn-primary btn-sm" data-activate="${esc(order.id)}">${icon("check", { size: 13 })}Activate</button><button class="btn btn-ghost btn-sm" data-cancel="${esc(order.id)}">Cancel</button></div>`
              : `<span class="dim" style="font-size:var(--fs-xs)">${esc(order.admin_note || "")}</span>`
          }</td>
        </tr>`;
      })
      .join("");
    safeSet(
      "#premium-table",
      `<div class="table-wrap"><table class="table"><thead><tr>
        <th>Member</th><th>Tier</th><th>Payment</th><th>Activate by</th><th>Status</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`
    );
  }
}
