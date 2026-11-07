/* ==========================================================================
   Shinzora — Online Store
   The commerce control room: storefront status, catalogue health, recent
   orders and the checks that actually matter before going live.
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo } from "../../../lib/format.js";
import { state } from "../../../lib/store.js";
import { products as fetchProducts, orders as fetchOrders, projects as fetchProjects } from "../data.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge, statCard } from "../components.js";

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  let productRows = [];
  let orderRows = [];
  let projectRows = [];
  let error = null;

  try {
    const [p, o, pr] = await Promise.all([fetchProducts(), fetchOrders({ limit: 50 }), fetchProjects({ limit: 50 })]);
    productRows = p.data;
    orderRows = o.data;
    projectRows = pr.data;
  } catch (err) {
    error = err;
  }

  if (error) {
    root.innerHTML = `${pageHead({ title: "Online Store" })}${setupNotice(error, "The store")}`;
    return;
  }

  const storefront = projectRows.find((project) => project.type === "store") || projectRows.find((project) => project.status === "published");
  const paid = orderRows.filter((row) => ["paid", "processing", "shipped", "delivered", "fulfilled"].includes(row.status));
  const revenue = paid.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const activeProducts = productRows.filter((row) => (row.status || "active") === "active");
  const lowStock = productRows.filter((row) => Number(row.stock) <= 5);

  const checklist = [
    { label: "Storefront project created", done: Boolean(projectRows.some((p) => p.type === "store")), href: "/app/?view=website-builder" },
    { label: "At least one product added", done: productRows.length > 0, href: "/app/?view=inventory" },
    { label: "Products priced and in stock", done: activeProducts.length > 0, href: "/app/?view=inventory" },
    { label: "Storefront published", done: Boolean(storefront?.status === "published"), href: "/app/?view=projects" }
  ];

  root.innerHTML = `
    ${pageHead({
      title: "Online Store",
      desc: "Your storefront and the commerce records behind it. Nothing here is simulated — orders, stock and customers are rows in your database.",
      actions: `<a class="btn btn-secondary btn-sm" href="/app/?view=inventory">${icon("boxes", { size: 14 })}Inventory</a>
                <a class="btn btn-primary btn-sm" href="/app/?view=orders">${icon("package", { size: 14 })}Orders</a>`
    })}

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Revenue", value: money(revenue), iconName: "indian-rupee", foot: `${paid.length} paid orders` })}
      ${statCard({ label: "Products", value: String(productRows.length), iconName: "boxes", foot: `${activeProducts.length} active` })}
      ${statCard({ label: "Orders", value: String(orderRows.length), iconName: "package", foot: `${orderRows.filter((o) => o.status === "pending").length} pending` })}
      ${statCard({
        label: "Storefront",
        value: storefront ? statusLabelSafe(storefront.status) : "Not built",
        iconName: "store",
        foot: lowStock.length ? `${lowStock.length} products low on stock` : "Stock healthy"
      })}
    </div>

    <div class="grid-main-side">
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Storefront</div>
              <div class="card-sub">${storefront ? esc(storefront.name) : "No storefront project yet"}</div>
            </div>
            ${storefront ? statusBadge(storefront.status) : `<span class="badge badge-neutral">Not created</span>`}
          </div>
          <div class="card-body">
            ${
              storefront
                ? `<div class="row gap-3 wrap" style="margin-bottom:var(--s-4)">
                    <span class="inline-code">${esc(storefront.slug || "not-published")}.shinzora.in</span>
                    <span class="dim" style="font-size:var(--fs-2xs)">Updated ${esc(timeAgo(storefront.updated_at))}</span>
                  </div>
                  <div class="row gap-2 wrap">
                    <a class="btn btn-secondary btn-sm" href="/app/?view=website-builder&id=${esc(storefront.id)}">${icon("square-pen", { size: 13 })}Edit storefront</a>
                    ${
                      storefront.status === "published"
                        ? `<a class="btn btn-ghost btn-sm" href="/site/?p=${esc(storefront.slug)}" target="_blank" rel="noopener">${icon("external-link", { size: 13 })}Open live store</a>`
                        : `<a class="btn btn-primary btn-sm" href="/app/?view=projects">${icon("rocket", { size: 13 })}Publish</a>`
                    }
                  </div>`
                : emptyState({
                    icon: "store",
                    title: "Build the storefront",
                    desc: "Describe the store in the builder — the AI generates product grids, product pages and checkout-ready sections.",
                    action: `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">${icon("sparkles", { size: 14 })}Create storefront</a>`
                  })
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Recent orders</div>
            <a class="btn btn-ghost btn-sm" href="/app/?view=orders">All orders</a>
          </div>
          ${
            orderRows.length
              ? `<div class="table-wrap"><table class="table">
                  <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead>
                  <tbody>${orderRows
                    .slice(0, 8)
                    .map(
                      (row) => `<tr>
                        <td class="cell-strong">${esc(row.order_number || row.id.slice(0, 8))}</td>
                        <td>${esc(row.customer_name || "—")}</td>
                        <td>${esc(money(row.total_amount, row.currency || "INR"))}</td>
                        <td>${statusBadge(row.status)}</td>
                        <td class="dim">${esc(timeAgo(row.placed_at || row.created_at))}</td>
                      </tr>`
                    )
                    .join("")}</tbody>
                </table></div>`
              : emptyState({ icon: "package", title: "No orders yet", desc: "Orders appear here as soon as your storefront is live and someone buys." })
          }
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Catalogue health</div><a class="btn btn-ghost btn-sm" href="/app/?view=inventory">Manage</a></div>
          <div class="card-body">
            ${
              productRows.length
                ? `<div class="stack gap-3">${productRows
                    .slice(0, 6)
                    .map(
                      (row) => `<div class="row gap-3">
                        <span class="notif-icon">${icon("package", { size: 13 })}</span>
                        <div class="grow">
                          <div style="font-size:var(--fs-sm);color:var(--text)">${esc(row.name)}</div>
                          <div class="dim" style="font-size:var(--fs-2xs)">${esc(row.sku || "no SKU")} · ${esc(money(row.price, row.currency || "INR"))}</div>
                        </div>
                        <span class="badge ${Number(row.stock) <= 0 ? "badge-danger" : Number(row.stock) <= 5 ? "badge-warn" : "badge-ok"}">${row.stock} left</span>
                      </div>`
                    )
                    .join("")}</div>`
                : `<p class="muted" style="font-size:var(--fs-xs)">No products yet. Add products in Inventory to populate the storefront.</p>`
            }
          </div>
        </div>
      </div>

      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">Go-live checklist</div></div>
          <div class="card-body">
            <div class="stack gap-3">
              ${checklist
                .map(
                  (item) => `<div class="row gap-3">
                    <span class="notif-icon" style="background:${item.done ? "rgba(52,211,153,.14)" : "rgba(255,255,255,.05)"};border-color:${
                    item.done ? "rgba(52,211,153,.34)" : "var(--line)"
                  };color:${item.done ? "var(--ok)" : "var(--text-3)"}">${icon(item.done ? "check" : "circle", { size: 13 })}</span>
                    <div class="grow" style="font-size:var(--fs-sm);color:${item.done ? "var(--text-2)" : "var(--text)"}">${esc(item.label)}</div>
                    ${item.done ? "" : `<a class="btn btn-ghost btn-sm" href="${esc(item.href)}">Do it</a>`}
                  </div>`
                )
                .join("")}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Payments in the store</div></div>
          <div class="card-body">
            <p class="muted" style="font-size:var(--fs-xs);line-height:1.65">
              Shinzora's own billing uses UPI QR with administrator verification. Customer payments inside a generated
              storefront are collected by whatever provider you connect — Razorpay when keys are configured, or your own
              link. No provider is faked.
            </p>
            <dl style="margin-top:10px">
              <div class="kv"><dt>Currency</dt><dd>INR</dd></div>
              <div class="kv"><dt>Gateway</dt><dd>${esc("Razorpay (architecture ready)")}</dd></div>
              <div class="kv"><dt>Manual orders</dt><dd>Supported</dd></div>
            </dl>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Business context</div></div>
          <div class="card-body">
            <dl>
              <div class="kv"><dt>Business</dt><dd>${esc(state.business?.name || "Not set")}</dd></div>
              <div class="kv"><dt>Category</dt><dd>${esc(state.business?.category || "—")}</dd></div>
              <div class="kv"><dt>Location</dt><dd>${esc(state.business?.location || "—")}</dd></div>
            </dl>
            <a class="btn btn-secondary btn-sm btn-block" style="margin-top:10px" href="/app/?view=settings">Edit business</a>
          </div>
        </div>
      </div>
    </div>`;

  void qs;
}

function statusLabelSafe(status) {
  const map = { published: "Live", ready: "Ready", draft: "Draft", generating: "Generating", archived: "Archived" };
  return map[status] || "Ready";
}
