/* ==========================================================================
   Shinzora — Inventory
   Products, variants and stock levels stored in Postgres. Every write is
   scoped by RLS to the signed-in owner.
   ========================================================================== */

import { qs, qsa, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, toMinor, fromMinor } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { products as fetchProducts } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge } from "../components.js";
import { formDialog, confirmDialog, openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { parseCsv, toCsv, downloadCsv } from "../../../lib/csv.js";

let rows = [];
let search = "";
let lowOnly = false;

/* Each product sets its own low-stock level. Products saved before the column
   existed fall back to 5, the level the app used before thresholds. */
const lowAt = (row) => Math.max(0, Number(row.low_stock_threshold ?? 5));
const isLow = (row) => Number(row.stock) <= lowAt(row);
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 8;
const websiteUrl = (slug) => `${location.origin}/shop/?p=${encodeURIComponent(slug)}`;

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
      desc: "Products, prices and stock. Each product raises its own low-stock alert at the level you set.",
      actions: `<button class="btn btn-secondary btn-sm" id="import-products">${icon("upload", { size: 14 })}Import CSV</button>
                <button class="btn btn-secondary btn-sm" id="export-products">${icon("download", { size: 14 })}Export CSV</button>
                <button class="btn btn-primary btn-sm" id="add-product">${icon("plus", { size: 14 })}Add product</button>
                <input id="import-file" type="file" accept=".csv,text/csv" hidden />`
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
    <div id="stock-alerts"></div>
    <div class="card"><div class="card-body" style="padding:0" id="product-table"></div></div>`;

  paintStats();
  paintTable();
  void paintAlerts();

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

  /* Import: the file is read and parsed here, but every row is validated again
     by store_import_products(), which also decides update-vs-insert by SKU. The
     browser never writes the catalogue directly. */
  on(qs("#import-products"), "click", () => qs("#import-file").click());
  on(qs("#import-file"), "change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await importCsv(file);
  });

  delegate(qs("#product-table"), "click", "[data-edit]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-edit"));
    if (row) productDialog(row);
  });

  /* Push to website: the database checks the quality rules and writes the flag,
     so this only reports what the database actually did. */
  delegate(qs("#product-table"), "click", "[data-website]", async (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-website"));
    if (!row) return;
    const publish = !row.website_published;
    node.disabled = true;
    try {
      const { data, error } = await sb.rpc("product_set_website", { p_product: row.id, p_publish: publish });
      if (error) throw error;
      row.website_published = publish;
      if (data?.slug) row.website_slug = data.slug;
      paintTable();
      toast(
        publish
          ? { title: "Live on your website", message: websiteUrl(row.website_slug) }
          : { title: "Taken off your website", message: "The public page for this product now shows as not found." },
        { tone: "success", duration: 7000 }
      );
    } catch (error) {
      /* 22023 is the publish quality gate; its message names what is missing. */
      if (error?.code === "22023") {
        toast({ title: "Not published", message: error.message }, { tone: "warning", duration: 7000 });
      } else {
        toastError(normalizeError(error));
      }
    } finally {
      node.disabled = false;
    }
  });

  delegate(qs("#product-table"), "click", "[data-photos]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-photos"));
    if (row) photosDialog(row);
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

  /* ---------------------------------------------------------------- alerts */
  /* One open alert per product and state, enforced by the database. "Resolve"
     closes an alert; it reopens only after the product recovers and drops again. */
  async function paintAlerts() {
    const box = qs("#stock-alerts");
    if (!box) return;
    try {
      const { data, error } = await sb
        .from("product_alerts")
        .select("id, product_id, product_name, stock, threshold, state, created_at")
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw normalizeError(error);
      if (!data?.length) {
        box.innerHTML = "";
        box.onclick = null;
        return;
      }
      box.innerHTML = `<div class="alert alert-warn" style="align-items:flex-start;flex-direction:column;gap:8px">
        <div style="display:flex;gap:8px;align-items:center;width:100%">
          ${icon("triangle-alert", { size: 15 })}
          <strong style="flex:1">${data.length} ${data.length === 1 ? "product needs" : "products need"} restocking</strong>
          ${data.length > 1 ? `<button class="btn btn-ghost btn-sm" type="button" data-resolve-all>Resolve all</button>` : ""}
        </div>
        ${data
          .map(
            (row) => `<div style="display:flex;gap:8px;align-items:center;width:100%;font-size:var(--fs-2xs)">
              <span style="flex:1">${esc(row.product_name || "A product")} — ${
                row.state === "out" ? "out of stock" : `${row.stock} left (alert at ${row.threshold})`
              }</span>
              <button class="btn btn-ghost btn-sm" type="button" data-resolve="${esc(row.id)}">Resolve</button>
            </div>`
          )
          .join("")}
      </div>`;

      /* One handler on the container, replaced on each repaint, so clicks never
         run twice. */
      box.onclick = async (event) => {
        const one = event.target.closest?.("[data-resolve]")?.getAttribute("data-resolve");
        const all = event.target.closest?.("[data-resolve-all]");
        if (!one && !all) return;
        try {
          const { error: resolveError } = await sb.rpc("product_alert_resolve", { p_ids: one ? [one] : null });
          if (resolveError) throw normalizeError(resolveError);
          void paintAlerts();
        } catch (failure) {
          toastError(normalizeError(failure));
        }
      };
    } catch {
      /* An alert list that cannot load must not take the catalogue down with it. */
      box.innerHTML = "";
    }
  }

  /* --------------------------------------------------------------- import */
  async function importCsv(file) {
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "That file is too big", message: "Import at most 2 MB at a time." }, { tone: "warning" });
      return;
    }
    let text = "";
    try {
      text = await file.text();
    } catch (error) {
      toastError(normalizeError(error));
      return;
    }
    const parsed = parseCsv(text, { required: ["name"] });
    if (!parsed.rows.length) {
      toast({ title: "Nothing to import", message: parsed.error || "No rows found in that file." }, { tone: "warning" });
      return;
    }
    try {
      const { data, error } = await sb.rpc("store_import_products", { p_rows: parsed.rows });
      if (error) throw normalizeError(error);
      const skipped = Number(data?.skipped || 0);
      toast(
        {
          title: `${data?.imported || 0} added, ${data?.updated || 0} updated`,
          message: skipped
            ? `${skipped} row${skipped === 1 ? "" : "s"} skipped: ${(data.problems || [])
                .slice(0, 3)
                .map((problem) => `line ${problem.row} — ${problem.reason}`)
                .join("; ")}`
            : "Every row was accepted."
        },
        { tone: skipped ? "warning" : "success", duration: skipped ? 9000 : 4000 }
      );
      const { data: fresh } = await fetchProducts();
      rows = Array.isArray(fresh) ? fresh : [];
      paintStats();
      paintTable();
      void paintAlerts();
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  function paintStats() {
    const total = rows.length;
    const value = rows.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.stock || 0), 0);
    const low = rows.filter(isLow).length;
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
      const stockMatch = !lowOnly || isLow(row);
      return matches && stockMatch;
    });
    qs("#product-count").textContent = `${visible.length} of ${rows.length} products`;

    safeSet("#product-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th>Stock</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${visible
            .map(
              (row) => `<tr>
                <td data-label="Product">
                  <div class="cell-strong">${esc(row.name)}</div>
                  ${row.description ? `<div class="cell-sub clamp-2" style="max-width:320px">${esc(row.description)}</div>` : ""}
                </td>
                <td class="mono dim" data-label="SKU">${esc(row.sku || "—")}</td>
                <td data-label="Price">${esc(money(row.price, row.currency || "INR"))}</td>
                <td data-label="Stock">
                  <span class="badge ${Number(row.stock) <= 0 ? "badge-danger" : isLow(row) ? "badge-warn" : "badge-ok"}">
                    ${Number(row.stock) <= 0 ? "Out of stock" : `${row.stock} in stock`}
                  </span>
                </td>
                <td data-label="Status">${statusBadge(row.status || "active")}</td>
                <td class="dim" data-label="Updated">${esc(timeAgo(row.updated_at || row.created_at))}</td>
                <td class="cell-actions">
                  ${row.website_published && row.website_slug
                    ? `<a class="badge badge-ok" href="${esc(websiteUrl(row.website_slug))}" target="_blank" rel="noopener" style="margin-right:6px">On website</a>`
                    : ""}
                  <button class="btn btn-ghost btn-sm" data-website="${esc(row.id)}">${row.website_published ? "Unpublish" : "Push to website"}</button>
                  <button class="btn btn-ghost btn-sm" data-photos="${esc(row.id)}">Photos${row.image_urls?.length ? ` (${row.image_urls.length})` : ""}</button>
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

  /* Photos: uploaded to the owner's folder in brand-assets (public read, owner
     write, per 0003). The product's image list is updated only after the upload
     succeeds. The first photo is the cover. */
  function photosDialog(row) {
    const photos = [...(row.image_urls || [])];
    openModal({
      title: `Photos — ${row.name}`,
      desc: `JPG, PNG or WebP, up to 5 MB each, ${MAX_PHOTOS} at most. The first photo is the cover on your website.`,
      body: `<div class="stack gap-4">
        <div id="photo-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px"></div>
        <div id="photo-empty" class="dim" style="font-size:var(--fs-xs)">No photos yet.</div>
        <input class="input" type="file" id="photo-file" accept="image/png,image/jpeg,image/webp" />
        <div class="field-hint" id="photo-status"></div>
      </div>`,
      footer: `<button class="btn btn-primary" data-modal-close>Done</button>`,
      onMount: (root) => {
        const grid = qs("#photo-grid", root);
        const empty = qs("#photo-empty", root);
        const status = qs("#photo-status", root);
        const paint = () => {
          empty.hidden = photos.length > 0;
          grid.innerHTML = photos
            .map(
              (url, index) => `<div style="position:relative">
                <img src="${esc(url)}" alt="" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px" />
                ${index === 0 ? `<span class="badge badge-ok" style="position:absolute;left:4px;top:4px">Cover</span>` : ""}
                <button class="btn btn-ghost btn-sm" type="button" data-remove="${index}" style="position:absolute;right:4px;bottom:4px">Remove</button>
              </div>`
            )
            .join("");
        };
        const save = async () => {
          const { error } = await sb.from("store_products").update({ image_urls: photos, updated_at: new Date().toISOString() }).eq("id", row.id);
          if (error) throw normalizeError(error);
          row.image_urls = [...photos];
          paintTable();
        };
        paint();

        grid.addEventListener("click", async (event) => {
          const index = Number(event.target.closest?.("[data-remove]")?.getAttribute("data-remove"));
          if (!Number.isInteger(index)) return;
          photos.splice(index, 1);
          paint();
          try {
            await save();
            status.textContent = "Photo removed.";
          } catch (error) {
            toastError(normalizeError(error));
          }
        });

        qs("#photo-file", root).addEventListener("change", async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (!PHOTO_TYPES.includes(file.type)) {
            status.textContent = "That file type is not supported. Use JPG, PNG or WebP.";
            return;
          }
          if (file.size > PHOTO_MAX_BYTES) {
            status.textContent = "That photo is larger than 5 MB.";
            return;
          }
          if (photos.length >= MAX_PHOTOS) {
            status.textContent = `A product can have ${MAX_PHOTOS} photos. Remove one first.`;
            return;
          }
          status.textContent = "Uploading…";
          const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
          const path = `${state.user.id}/products/${row.id}/${Date.now()}-${safe}`;
          try {
            const { error: uploadError } = await sb.storage.from("brand-assets").upload(path, file, {
              contentType: file.type,
              upsert: false
            });
            if (uploadError) throw normalizeError(uploadError);
            const { data: pub } = sb.storage.from("brand-assets").getPublicUrl(path);
            photos.push(pub.publicUrl);
            paint();
            await save();
            status.textContent = "Photo added.";
          } catch (error) {
            /* Put the list back to what the database holds. */
            photos.length = 0;
            photos.push(...(row.image_urls || []));
            paint();
            status.textContent = "";
            toastError(normalizeError(error));
          }
        });
      }
    });
  }

  async function productDialog(existing = null) {
    const values = await formDialog({
      title: existing ? `Edit ${existing.name}` : "New product",
      desc: "Products are stored in your own Postgres table and can be exported at any time.",
      fields: [
        { name: "name", label: "Product name", value: existing?.name || "", required: true },
        { name: "sku", label: "SKU", value: existing?.sku || "", placeholder: "SA-001" },
        /* Rupees, exactly as written on the price tag. "Price (₹, in paise)"
           asked a shopkeeper to type 168 for ₹1.68, and typing 100 showed ₹1.00
           — the field and the table disagreed because one spoke rupees and the
           other paise. The conversion now happens in format.js: toMinor on save,
           fromMinor when an existing price is put back in the box. */
        {
          name: "price",
          label: "Price (₹)",
          type: "number",
          step: "0.01",
          value: fromMinor(existing?.price ?? 0),
          required: true,
          hint: "Rupees and paise — type 1.68 for ₹1.68. Stored as 168 paise so nothing rounds away."
        },
        { name: "stock", label: "Stock on hand", type: "number", value: existing?.stock ?? 0, required: true },
        {
          name: "low_stock_threshold",
          label: "Low-stock alert at",
          type: "number",
          value: existing?.low_stock_threshold ?? 5,
          required: true,
          hint: "You are alerted when stock reaches this number or below. Out-of-stock alerts always fire at zero."
        },
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
    const threshold = Math.round(Number(values.low_stock_threshold));
    if (!Number.isFinite(threshold) || threshold < 1) {
      toast({ title: "Low-stock level", message: "Enter a whole number of 1 or more." }, { tone: "warning" });
      return;
    }
    values.low_stock_threshold = threshold;

    try {
      if (existing) {
        const patch = { ...values, price: toMinor(values.price), stock: Number(values.stock), updated_at: new Date().toISOString() };
        const { error } = await sb
          .from("store_products")
          .update(patch)
          .eq("id", existing.id);
        if (error) throw normalizeError(error);
        Object.assign(existing, patch);
      } else {
        const { data, error } = await sb
          .from("store_products")
          .insert({
            owner_id: state.user.id,
            ...values,
            price: toMinor(values.price),
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
      if (error?.code === "23505") {
        toast({ title: "SKU already used", message: "Another product in your catalogue has this SKU. Use a different one, or leave it blank." }, { tone: "warning" });
        return;
      }
      toastError(normalizeError(error));
    }
  }

  function exportCsv() {
    /* The same columns the importer reads, so an exported file can be edited and
       imported back without renaming anything. */
    const csv = toCsv(
      ["name", "sku", "price", "stock", "category", "status", "currency"],
      rows.map((row) => [
        row.name || "",
        row.sku || "",
        Number(row.price || 0),
        Number(row.stock || 0),
        row.category || "",
        row.status || "active",
        row.currency || "INR"
      ])
    );
    downloadCsv(`shinzora-inventory-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast({ title: "Export started", message: `${rows.length} products exported.` }, { tone: "success" });
  }

  void qsa;
}
