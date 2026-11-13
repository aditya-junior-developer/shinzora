/* ==========================================================================
   Shinzora — Customers
   Store customers with order history, contact details and lifetime value.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, date, initials } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { customers as fetchCustomers, orders as fetchOrders } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView } from "../components.js";
import { formDialog, confirmDialog, openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

let rows = [];
let orderRows = [];

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  try {
    const [customerRes, orderRes] = await Promise.all([fetchCustomers(), fetchOrders({ limit: 200 }).catch(() => ({ data: [] }))]);
    rows = customerRes.data;
    orderRows = orderRes.data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Customers" })}${setupNotice(error, "Customers")}`;
    return;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Customers",
      desc: "Everyone who has bought from your store, with lifetime value calculated from real orders.",
      actions: `<button class="btn btn-secondary btn-sm" id="export-customers">${icon("download", { size: 14 })}Export CSV</button>
                <button class="btn btn-primary btn-sm" id="add-customer">${icon("plus", { size: 14 })}Add customer</button>`
    })}
    <div class="grid-4" id="customer-stats" style="margin-bottom:var(--s-4)"></div>
    <div class="toolbar">
      <div class="toolbar-search">${icon("search", { size: 14 })}<input class="input" id="customer-search" placeholder="Search name or email" aria-label="Search customers" /></div>
      <div class="toolbar-spacer"></div>
      <span class="dim" style="font-size:var(--fs-xs)" id="customer-count"></span>
    </div>
    <div class="card"><div class="card-body" style="padding:0" id="customer-table"></div></div>`;

  paintStats();
  paintTable();

  on(qs("#customer-search"), "input", paintTable);
  on(qs("#add-customer"), "click", addCustomer);
  on(qs("#export-customers"), "click", exportCsv);

  delegate(qs("#customer-table"), "click", "[data-view]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-view"));
    if (row) detail(row);
  });

  delegate(qs("#customer-table"), "click", "[data-delete]", async (event, node) => {
    event.stopPropagation();
    const row = rows.find((item) => item.id === node.getAttribute("data-delete"));
    const ok = await confirmDialog({
      title: "Delete customer?",
      desc: `${row?.name || "This customer"} will be removed from your customer list. Orders stay in place.`,
      confirmLabel: "Delete",
      tone: "danger"
    });
    if (!ok) return;
    try {
      const { error } = await sb.from("store_customers").delete().eq("id", row.id);
      if (error) throw normalizeError(error);
      rows = rows.filter((item) => item.id !== row.id);
      paintStats();
      paintTable();
      toast({ title: "Customer deleted" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  /* Declared as a hoisted function: paintStats() runs before this point in the
     module and used to throw "Cannot access 'ordersFor' before initialization",
     which blanked the whole Customers view whenever there were customers. */
  function ordersFor(customer) {
    return orderRows.filter(
      (order) =>
        (customer.email && order.customer_email === customer.email) ||
        (customer.name && order.customer_name === customer.name)
    );
  }

  function paintStats() {
    const total = rows.length;
    const lifetime = orderRows.reduce((sum, order) => sum + Number(order.total_amount || 0), 0);
    const repeat = rows.filter((customer) => ordersFor(customer).length > 1).length;
    const avg = total ? lifetime / total : 0;
    safeSet("#customer-stats", `
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("users", { size: 13 })}Customers</span></div><div class="stat-value">${total}</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("indian-rupee", { size: 13 })}Lifetime value</span></div><div class="stat-value">${esc(money(lifetime))}</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("refresh-cw", { size: 13 })}Repeat buyers</span></div><div class="stat-value">${repeat}</div></div>
      <div class="stat"><div class="stat-head"><span class="stat-label">${icon("chart-line", { size: 13 })}Average order</span></div><div class="stat-value">${esc(money(avg))}</div></div>`);
  }

  function paintTable() {
    const term = (qs("#customer-search")?.value || "").toLowerCase();
    const visible = rows.filter((row) => !term || `${row.name || ""} ${row.email || ""} ${row.phone || ""}`.toLowerCase().includes(term));
    qs("#customer-count").textContent = `${visible.length} of ${rows.length}`;

    safeSet("#customer-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Customer</th><th>Contact</th><th>Orders</th><th>Spend</th><th>Since</th><th></th></tr></thead>
          <tbody>${visible
            .map((row) => {
              const orders = ordersFor(row);
              const spend = orders.reduce((sum, order) => sum + Number(order.total_amount || 0), 0);
              return `<tr data-view="${esc(row.id)}" style="cursor:pointer">
                <td data-label="Customer">
                  <div class="row gap-3">
                    <span class="avatar avatar-sm">${esc(initials(row.name || row.email))}</span>
                    <div><div class="cell-strong">${esc(row.name || "Unnamed")}</div>
                    ${row.city ? `<div class="cell-sub">${esc(row.city)}</div>` : ""}</div>
                  </div>
                </td>
                <td data-label="Contact">${esc(row.email || "—")}<div class="cell-sub">${esc(row.phone || "")}</div></td>
                <td data-label="Orders">${orders.length}</td>
                <td data-label="Spend">${esc(money(spend))}</td>
                <td class="dim" data-label="Since">${esc(timeAgo(row.created_at))}</td>
                <td class="cell-actions">
                  <button class="btn btn-ghost btn-sm btn-icon" data-delete="${esc(row.id)}" aria-label="Delete customer">${icon("trash-2", { size: 13 })}</button>
                </td>
              </tr>`;
            })
            .join("")}</tbody>
        </table></div>`
      : emptyState({
          icon: "users",
          title: rows.length ? "No matches" : "No customers yet",
          desc: rows.length ? "Try a different search." : "Customers are added automatically with store orders, or you can add them manually."
        }));
  }

  function detail(customer) {
    const orders = ordersFor(customer);
    const spend = orders.reduce((sum, order) => sum + Number(order.total_amount || 0), 0);
    openModal({
      title: customer.name || customer.email || "Customer",
      desc: `Customer since ${date(customer.created_at)}`,
      size: "lg",
      body: `
        <div class="grid-3" style="margin-bottom:var(--s-4)">
          <div class="stat"><div class="stat-head"><span class="stat-label">Orders</span></div><div class="stat-value">${orders.length}</div></div>
          <div class="stat"><div class="stat-head"><span class="stat-label">Spend</span></div><div class="stat-value">${esc(money(spend))}</div></div>
          <div class="stat"><div class="stat-head"><span class="stat-label">Avg order</span></div><div class="stat-value">${esc(money(orders.length ? spend / orders.length : 0))}</div></div>
        </div>
        <dl>
          <div class="kv"><dt>Email</dt><dd>${esc(customer.email || "—")}</dd></div>
          <div class="kv"><dt>Phone</dt><dd>${esc(customer.phone || "—")}</dd></div>
          <div class="kv"><dt>City</dt><dd>${esc(customer.city || "—")}</dd></div>
          <div class="kv"><dt>Notes</dt><dd>${esc(customer.notes || "—")}</dd></div>
        </dl>
        <div class="section-title" style="margin-top:var(--s-5)"><h3>Order history</h3></div>
        <div class="table-wrap"><table class="table table-compact">
          <thead><tr><th>Order</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead>
          <tbody>${
            orders.length
              ? orders
                  .map(
                    (order) => `<tr><td class="cell-strong">${esc(order.order_number || order.id.slice(0, 8))}</td>
                      <td>${esc(money(order.total_amount, order.currency || "INR"))}</td>
                      <td>${esc(order.status)}</td>
                      <td class="dim">${esc(timeAgo(order.placed_at || order.created_at))}</td></tr>`
                  )
                  .join("")
              : `<tr><td colspan="4" class="dim">No orders recorded for this customer yet.</td></tr>`
          }</tbody>
        </table></div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`
    });
  }

  async function addCustomer() {
    const values = await formDialog({
      title: "Add a customer",
      fields: [
        { name: "name", label: "Full name", required: true },
        { name: "email", label: "Email" },
        { name: "phone", label: "Phone" },
        { name: "city", label: "City" },
        { name: "notes", label: "Notes", type: "textarea", rows: 3 }
      ],
      submitLabel: "Add customer"
    });
    if (!values) return;
    try {
      const { data, error } = await sb
        .from("store_customers")
        .insert({ owner_id: (await sb.auth.getUser()).data.user.id, ...values, source: "manual" })
        .select("*")
        .single();
      if (error) throw normalizeError(error);
      rows.unshift(data);
      paintStats();
      paintTable();
      toast({ title: "Customer added" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  function exportCsv() {
    const header = "name,email,phone,city,created_at\n";
    const body = rows
      .map((row) => [row.name, row.email, row.phone, row.city, row.created_at].map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `shinzora-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast({ title: "Export started" }, { tone: "success" });
  }
}
