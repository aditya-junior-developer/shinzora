/* ==========================================================================
   Shinzora — Inventory
   Products, variants and stock levels stored in Postgres. Every write is
   scoped by RLS to the signed-in owner.
   ========================================================================== */

import { qs, qsa, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { products as fetchProducts } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge } from "../components.js";
import { formDialog, confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

let rows = [];
let search = "";
let lowOnly = false;

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  try {
    const { data } = await fetchProducts();
    rows = data;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Inventory" })}${setupNotice(error, "Inventory")}`;
    return;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Inventory",
      desc: "Products, prices and stock. Low-stock items are flagged the moment the level drops to five or fewer.",
      actions: `<button class="btn btn-secondary btn-sm" id="export-products">${icon("download", { size: 14 })}Export CSV</button>
                <button class="btn btn-primary btn-sm" id="add-product">${icon("plus", { size: 14 })}Add product</button>`
    })}
    <div class="grid-4" id="inventory-stats" style="margin-bottom:var(--s-4)"></div>
    <div class="toolbar">
      <div class="toolbar-search">
        ${icon("search", { size: 14 })}
        <input class="input" id="product-search" placeholder="Search products" aria-label="Search products" />
      </div>
      <button class="chip" id="low-stock-filter" aria-pressed="false">${icon("triangle-alert", { size: 13 })}Low stock only</button>
      <div class="toolbar-spacer"></div>
      <span class="dim" style="font-size:var(--fs-xs)" id="product-count"></span>
    </div>
    <div class="card"><div class="card-body" style="padding:0" id="product-table"></div></div>`;

  paintStats();
  paintTable();

  on(qs("#product-search"), "input", (event) => {
    search = event.target.value.toLowerCase();
    paintTable();
  });

  on(qs("#low-stock-filter"), "click", (event) => {
    lowOnly = !lowOnly;
    event.currentTarget.setAttribute("aria-pressed", String(lowOnly));
    paintTable();
  });

  on(qs("#add-product"), "click", () => productDialog());
  on(qs("#export-products"), "click", exportCsv);

  delegate(qs("#product-table"), "click", "[data-edit]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-edit"));
    if (row) productDialog(row);
  });

  delegate(qs("#product-table"), "click", "[data-stock]", async (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-stock"));
    if (!row) return;
    const values = await formDialog({
      title: `Adjust stock — ${row.name}`,
      desc: "Enter the new stock level. The change is written immediately.",
      fields: [{ name: "stock", label: "Stock on hand", type: "number", value: row.stock ?? 0, required: true }],
      submitLabel: "Update stock",
      size: "sm"
    });
    if (!values) return;
    try {
      const { error } = await sb.from("store_products").update({ stock: Number(values.stock) }).eq("id", row.id);
      if (error) throw normalizeError(error);
      row.stock = Number(values.stock);
      paintStats();
      paintTable();
      toast({ title: "Stock updated" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  delegate(qs("#product-table"), "click", "[data-delete]", async (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-delete"));
    const ok = await confirmDialog({
      title: "Delete product?",
      desc: `“${row?.name}” will be removed from the catalogue. Existing orders keep their line items.`,
      confirmLabel: "Delete",
      tone: "danger"
    });
    if (!ok) return;
    try {
      const { error } = await sb.from("store_products").delete().eq("id", row.id);
      if (error) throw normalizeError(error);
      rows = rows.filter((item) => item.id !== row.id);
      paintStats();
      paintTable();
      toast({ title: "Product deleted" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  function paintStats() {
    const total = rows.length;
    const value = rows.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.stock || 0), 0);
    const low = rows.filter((row) => Number(row.stock) <= 5).length;
    const active = rows.filter((row) => row.status !== "archived").length;
    safeSet("#inventory-stats", `
      ${stat("Products", String(total), "boxes")}
      ${stat("Active", String(active), "circle-check")}
      ${stat("Low stock", String(low), "triangle-alert")}
      ${stat("Stock value", money(value), "indian-rupee")}`);
  }

  function stat(label, value, iconName) {
    return `<div class="stat">
      <div class="stat-head"><span class="stat-label">${icon(iconName, { size: 13 })}${esc(label)}</span></div>
      <div class="stat-value">${esc(value)}</div>
    </div>`;
  }

  function paintTable() {
    const visible = rows.filter((row) => {
      const matches = !search || `${row.name} ${row.sku || ""}`.toLowerCase().includes(search);
      const stockMatch = !lowOnly || Number(row.stock) <= 5;
      return matches && stockMatch;
    });
    qs("#product-count").textContent = `${visible.length} of ${rows.length} products`;

    safeSet("#product-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th>Stock</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${visible
            .map(
              (row) => `<tr>
                <td>
                  <div class="cell-strong">${esc(row.name)}</div>
                  ${row.description ? `<div class="cell-sub clamp-2" style="max-width:320px">${esc(row.description)}</div>` : ""}
                </td>
                <td class="mono dim">${esc(row.sku || "—")}</td>
                <td>${esc(money(row.price, row.currency || "INR"))}</td>
                <td>
                  <span class="badge ${Number(row.stock) <= 0 ? "badge-danger" : Number(row.stock) <= 5 ? "badge-warn" : "badge-ok"}">
                    ${Number(row.stock) <= 0 ? "Out of stock" : `${row.stock} in stock`}
                  </span>
                </td>
                <td>${statusBadge(row.status || "active")}</td>
                <td class="dim">${esc(timeAgo(row.updated_at || row.created_at))}</td>
                <td class="cell-actions">
                  <button class="btn btn-ghost btn-sm" data-stock="${esc(row.id)}">Stock</button>
                  <button class="btn btn-ghost btn-sm" data-edit="${esc(row.id)}">Edit</button>
                  <button class="btn btn-ghost btn-sm btn-icon" data-delete="${esc(row.id)}" aria-label="Delete">${icon("trash-2", { size: 13 })}</button>
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({
          icon: "boxes",
          title: rows.length ? "No products match" : "No products yet",
          desc: rows.length
            ? "Adjust the search or filter."
            : "Add your first product to start tracking stock, prices and orders.",
          action: rows.length ? "" : `<button class="btn btn-primary btn-sm" id="empty-add">${icon("plus", { size: 14 })}Add product</button>`
        }));

    qs("#empty-add")?.addEventListener("click", () => productDialog());
  }

  async function productDialog(existing = null) {
    const values = await formDialog({
      title: existing ? `Edit ${existing.name}` : "New product",
      desc: "Products are stored in your own Postgres table and can be exported at any time.",
      fields: [
        { name: "name", label: "Product name", value: existing?.name || "", required: true },
        { name: "sku", label: "SKU", value: existing?.sku || "", placeholder: "SA-001" },
        { name: "price", label: "Price (₹, in paise)", type: "number", value: existing?.price ?? 0, required: true, hint: "Amounts are stored in minor units to avoid rounding errors." },
        { name: "stock", label: "Stock on hand", type: "number", value: existing?.stock ?? 0, required: true },
        {
          name: "status",
          label: "Status",
          type: "select",
          value: existing?.status || "active",
          options: [
            { value: "active", label: "Active" },
            { value: "draft", label: "Draft" },
            { value: "archived", label: "Archived" }
          ]
        },
        { name: "description", label: "Description", type: "textarea", value: existing?.description || "", rows: 3 }
      ],
      submitLabel: existing ? "Save changes" : "Create product"
    });
    if (!values) return;

    try {
      if (existing) {
        const { error } = await sb
          .from("store_products")
          .update({ ...values, price: Number(values.price), stock: Number(values.stock), updated_at: new Date().toISOString() })
          .eq("id", existing.id);
        if (error) throw normalizeError(error);
        Object.assign(existing, values, { price: Number(values.price), stock: Number(values.stock) });
      } else {
        const { data, error } = await sb
          .from("store_products")
          .insert({
            owner_id: state.user.id,
            ...values,
            price: Number(values.price),
            stock: Number(values.stock),
            currency: "INR"
          })
          .select("*")
          .single();
        if (error) throw normalizeError(error);
        rows.unshift(data);
      }
      paintStats();
      paintTable();
      toast({ title: existing ? "Product updated" : "Product created" }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  function exportCsv() {
    const header = "name,sku,price,stock,status,currency\n";
    const body = rows
      .map((row) => [row.name, row.sku || "", row.price, row.stock, row.status || "active", row.currency || "INR"].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `shinzora-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast({ title: "Export started", message: `${rows.length} products exported.` }, { tone: "success" });
  }

  void qsa;
}
