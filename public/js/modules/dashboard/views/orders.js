/* ==========================================================================
   Shinzora — Orders
   Order records with line items. Status transitions are explicit actions,
   logged to customer_activity, never silently assumed.
   ========================================================================== */

import { qs, qsa, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, dateTime, statusLabel, toMinor } from "../../../lib/format.js";
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

        <div class="card" style="margin-top:var(--s-4)">
          <div class="card-head">
            <div>
              <div class="card-title">Customer tracking</div>
              <div class="card-sub">A link the customer can open without an account. It shows this order and nothing else.</div>
            </div>
          </div>
          <div class="card-body">
            <div class="row gap-2 wrap" id="tracking-body">
              ${
                row.tracking_token && !row.tracking_revoked_at
                  ? `<code class="mono" style="font-size:var(--fs-2xs)">/track/?t=${esc(row.tracking_token)}</code>
                     <button class="btn btn-secondary btn-sm" type="button" data-copy-track>${icon("copy", { size: 13 })}Copy link</button>
                     <button class="btn btn-ghost btn-sm" type="button" data-revoke-track>Revoke</button>`
                  : `<button class="btn btn-secondary btn-sm" type="button" data-make-track>${icon("link", { size: 13 })}Create tracking link</button>`
              }
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:var(--s-3)">
          <div class="card-head"><div><div class="card-title">Timeline</div><div class="card-sub">Every status change, newest first</div></div></div>
          <div class="card-body" id="order-timeline"><span class="dim" style="font-size:var(--fs-xs)">Loading…</span></div>
        </div>
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

        void paintTimeline(dialog, row);

        qs("[data-make-track]", dialog)?.addEventListener("click", async (event) => {
          event.currentTarget.disabled = true;
          try {
            const { data, error } = await sb.rpc("order_tracking_link", { p_order: row.id });
            if (error) throw normalizeError(error);
            row.tracking_token = data?.token || null;
            row.tracking_revoked_at = null;
            const url = `${location.origin}/track/?t=${data?.token}`;
            await copyText(url);
            toast({ title: "Tracking link copied", message: "Send it to the customer. It opens without signing in." }, { tone: "success" });
            api.close();
            orderDetail(row);
          } catch (error) {
            event.currentTarget.disabled = false;
            toastError(normalizeError(error));
          }
        });

        qs("[data-copy-track]", dialog)?.addEventListener("click", async () => {
          await copyText(`${location.origin}/track/?t=${row.tracking_token}`);
          toast({ title: "Link copied" }, { tone: "success", duration: 1800 });
        });

        qs("[data-revoke-track]", dialog)?.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: "Revoke this link?",
            desc: "The customer's current link stops working immediately. You can create a new one after.",
            confirmLabel: "Revoke",
            tone: "danger"
          });
          if (!ok) return;
          try {
            const { error } = await sb.rpc("order_tracking_revoke", { p_order: row.id });
            if (error) throw normalizeError(error);
            row.tracking_token = null;
            row.tracking_revoked_at = new Date().toISOString();
            api.close();
            orderDetail(row);
          } catch (error) {
            toastError(normalizeError(error));
          }
        });
      }
    });
  }

  /** The order's timeline, read straight from the events table (RLS-scoped). */
  async function paintTimeline(dialog, row) {
    const box = qs("#order-timeline", dialog);
    if (!box) return;
    try {
      const { data, error } = await sb
        .from("store_order_events")
        .select("status, note, created_at")
        .eq("order_id", row.id)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw normalizeError(error);
      if (!data?.length) {
        box.innerHTML = `<span class="dim" style="font-size:var(--fs-xs)">No changes recorded yet. Moving the status along records one.</span>`;
        return;
      }
      box.innerHTML = `<ol class="order-timeline">${data
        .map(
          (event) => `<li>
            <span class="order-timeline-dot" aria-hidden="true"></span>
            <div>
              <div style="font-size:var(--fs-sm)">${esc(statusLabel(event.status || "update"))}${
                event.note ? ` — ${esc(event.note)}` : ""
              }</div>
              <div class="dim" style="font-size:var(--fs-2xs)">${esc(dateTime(event.created_at))}</div>
            </div>
          </li>`
        )
        .join("")}</ol>`;
    } catch (error) {
      box.innerHTML = `<span class="dim" style="font-size:var(--fs-xs)">${esc(error.message || "Could not load the timeline.")}</span>`;
    }
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* Clipboard blocked: show it so it can be copied by hand. */
      toast({ title: "Copy this link", message: value, tone: "warning", duration: 12000 });
    }
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
      /* order_set_status() writes the row, appends the timeline entry and
         notifies the customer in one transaction. Writing the column directly
         used to leave the timeline empty and the customer uninformed. */
      const { error } = await sb.rpc("order_set_status", {
        p_order: row.id,
        p_status: next,
        p_note: null
      });
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
        /* Rupees here too: "Unit price (paise)" meant typing 168 for ₹1.68, and
           a shopkeeper recording a sale read it as rupees. */
        {
          name: "unit_price",
          label: "Unit price (₹)",
          type: "number",
          step: "0.01",
          value: 0,
          required: true,
          hint: "Rupees and paise — type 1.68 for ₹1.68."
        },
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
      const unitPrice = toMinor(values.unit_price);
      const total = unitPrice * Number(values.quantity);
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
        unit_price: unitPrice,
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
