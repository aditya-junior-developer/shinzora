/* ==========================================================================
   Shinzora — Orders
   Order records with line items. Status transitions are explicit actions,
   logged to customer_activity, never silently assumed.
   ========================================================================== */

import { qs, qsa, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, dateTime, statusLabel } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { orders as fetchOrders, logActivity } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge } from "../components.js";
import { formDialog, confirmDialog, openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const FILTERS = ["all", "pending", "processing", "shipped", "delivered", "cancelled"];
let rows = [];
let activeFilter = "all";

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  try {
    const { data } = await fetchOrders({ limit: 200 });
    rows = data;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Orders" })}${setupNotice(error, "Orders")}`;
    return;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Orders",
      desc: "Every order placed in your store, with line items and fulfilment status.",
      actions: `<button class="btn btn-primary btn-sm" id="add-order">${icon("plus", { size: 14 })}Record order</button>`
    })}
    <div class="grid-4" id="order-stats" style="margin-bottom:var(--s-4)"></div>
    <div class="toolbar">
      <div class="row gap-2 wrap" id="order-filters">
        ${FILTERS.map((f) => `<button class="chip ${f === "all" ? "is-active" : ""}" data-filter="${f}">${esc(statusLabel(f))}</button>`).join("")}
      </div>
      <div class="toolbar-spacer"></div>
      <div class="toolbar-search">${icon("search", { size: 14 })}<input class="input" id="order-search" placeholder="Search order or customer" aria-label="Search orders" /></div>
    </div>
    <div class="card"><div class="card-body" style="padding:0" id="order-table"></div></div>`;

  paintStats();
  paintTable();

  on(qs("#order-filters"), "click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    activeFilter = chip.getAttribute("data-filter");
    qsa("#order-filters .chip").forEach((node) => node.classList.toggle("is-active", node === chip));
    paintTable();
  });

  on(qs("#order-search"), "input", paintTable);
  on(qs("#add-order"), "click", recordOrder);

  delegate(qs("#order-table"), "click", "[data-view]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-view"));
    if (row) orderDetail(row);
  });

  delegate(qs("#order-table"), "click", "[data-advance-row]", async (event, node) => {
    event.stopPropagation();
    const row = rows.find((item) => item.id === node.getAttribute("data-advance-row"));
    if (row) await advance(row);
  });

  function paintStats() {
    const paid = rows.filter((r) => ["paid", "processing", "shipped", "delivered", "fulfilled"].includes(r.status));
    const revenue = paid.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
    const pending = rows.filter((r) => r.status === "pending").length;
    const shipped = rows.filter((r) => r.status === "shipped").length;
    safeSet("#order-stats", `
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("indian-rupee", { size: 13 })}Revenue</span></div><div class="stat-value">${esc(money(revenue))}</div><div class="stat-foot">${paid.length} paid orders</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("package", { size: 13 })}Orders</span></div><div class="stat-value">${rows.length}</div><div class="stat-foot">All time</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("clock", { size: 13 })}Pending</span></div><div class="stat-value">${pending}</div><div class="stat-foot">Awaiting action</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("truck", { size: 13 })}In transit</span></div><div class="stat-value">${shipped}</div><div class="stat-foot">Shipped, not delivered</div></div>`);
  }

  function paintTable() {
    const term = (qs("#order-search")?.value || "").toLowerCase();
    const visible = rows.filter((row) => {
      const byFilter = activeFilter === "all" || row.status === activeFilter;
      const bySearch = !term || `${row.order_number || ""} ${row.customer_name || ""} ${row.customer_email || ""}`.toLowerCase().includes(term);
      return byFilter && bySearch;
    });

    safeSet("#order-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th><th></th></tr></thead>
          <tbody>${visible
            .map(
              (row) => `<tr data-view="${esc(row.id)}" style="cursor:pointer">
                <td class="cell-strong">${esc(row.order_number || row.id.slice(0, 8))}</td>
                <td>${esc(row.customer_name || "—")}<div class="cell-sub">${esc(row.customer_email || "")}</div></td>
                <td>${(row.items || []).length}</td>
                <td>${esc(money(row.total_amount, row.currency || "INR"))}</td>
                <td>${statusBadge(row.status)}</td>
                <td class="dim">${esc(timeAgo(row.placed_at || row.created_at))}</td>
                <td class="cell-actions">
                  ${
                    row.status !== "delivered" && row.status !== "cancelled"
                      ? `<button class="btn btn-ghost btn-sm" data-advance-row="${esc(row.id)}">Advance</button>`
                      : ""
                  }
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({
          icon: "package",
          title: rows.length ? "No orders in this state" : "No orders yet",
          desc: rows.length
            ? "Change the filter to see other orders."
            : "Orders arrive from your storefront, or you can record a manual sale here."
        }));
  }

  function orderDetail(row) {
    const items = row.items || [];
    openModal({
      title: `Order ${row.order_number || row.id.slice(0, 8)}`,
      desc: `${row.customer_name || "Customer"} · ${dateTime(row.placed_at || row.created_at)}`,
      size: "lg",
      body: `
        <div class="row gap-3 wrap" style="margin-bottom:var(--s-4)">
          ${statusBadge(row.status)}
          <span class="badge badge-neutral">${esc(money(row.total_amount, row.currency || "INR"))}</span>
          ${row.payment_method ? `<span class="badge badge-neutral">${esc(row.payment_method)}</span>` : ""}
        </div>
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead>
          <tbody>${
            items.length
              ? items
                  .map(
                    (item) => `<tr>
                      <td class="cell-strong">${esc(item.product_name || item.name || "Item")}</td>
                      <td>${esc(item.quantity ?? 1)}</td>
                      <td>${esc(money(item.unit_price, item.currency || "INR"))}</td>
                      <td>${esc(money((item.unit_price || 0) * (item.quantity || 1), item.currency || "INR"))}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="4" class="dim">No line items recorded for this order.</td></tr>`
          }</tbody>
        </table></div>
        ${row.notes ? `<p class="muted" style="font-size:var(--fs-xs);margin-top:12px">${esc(row.notes)}</p>` : ""}
      `,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
        ${
          row.status !== "delivered" && row.status !== "cancelled"
            ? `<button class="btn btn-primary" id="modal-advance">Advance status</button>`
            : ""
        }`,
      onMount: (dialog, api) => {
        qs("#modal-advance", dialog)?.addEventListener("click", async () => {
          api.close();
          await advance(row);
        });
      }
    });
  }

  async function advance(row) {
    const flow = ["pending", "processing", "shipped", "delivered"];
    const index = flow.indexOf(row.status);
    const next = index > -1 ? flow[Math.min(flow.length - 1, index + 1)] : "processing";
    const ok = await confirmDialog({
      title: `Mark as ${statusLabel(next)}?`,
      desc: `Order ${row.order_number || row.id.slice(0, 8)} moves from ${statusLabel(row.status)} to ${statusLabel(next)}.`,
      confirmLabel: `Mark ${statusLabel(next)}`
    });
    if (!ok) return;
    try {
      const { error } = await sb
        .from("store_orders")
        .update({ status: next, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw normalizeError(error);
      row.status = next;
      paintStats();
      paintTable();
      await logActivity("order_updated", "store_order", row.id, { status: next });
      toast({ title: `Order marked ${statusLabel(next)}` }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  async function recordOrder() {
    const values = await formDialog({
      title: "Record an order",
      desc: "Use this for orders taken offline. Online orders arrive from your storefront automatically.",
      fields: [
        { name: "customer_name", label: "Customer name", required: true },
        { name: "customer_email", label: "Customer email" },
        { name: "item", label: "Item description", required: true },
        { name: "quantity", label: "Quantity", type: "number", value: 1, required: true },
        { name: "unit_price", label: "Unit price (paise)", type: "number", value: 0, required: true },
        {
          name: "status",
          label: "Status",
          type: "select",
          value: "pending",
          options: [
            { value: "pending", label: "Pending" },
            { value: "processing", label: "Processing" },
            { value: "paid", label: "Paid" }
          ]
        }
      ],
      submitLabel: "Record order",
      size: "lg"
    });
    if (!values) return;

    try {
      const total = Number(values.unit_price) * Number(values.quantity);
      const { data: order, error } = await sb
        .from("store_orders")
        .insert({
          owner_id: (await sb.auth.getUser()).data.user.id,
          order_number: `SZ-${Date.now().toString(36).toUpperCase()}`,
          customer_name: values.customer_name,
          customer_email: values.customer_email || null,
          status: values.status,
          total_amount: total,
          currency: "INR",
          payment_method: "manual",
          placed_at: new Date().toISOString()
        })
        .select("*")
        .single();
      if (error) throw normalizeError(error);

      await sb.from("store_order_items").insert({
        order_id: order.id,
        product_name: values.item,
        quantity: Number(values.quantity),
        unit_price: Number(values.unit_price),
        currency: "INR"
      });

      const { data: refreshed } = await fetchOrders({ limit: 200 });
      rows = refreshed;
      paintStats();
      paintTable();
      toast({ title: "Order recorded" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }
}
