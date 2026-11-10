/* ==========================================================================
   Shinzora — Analytics
   Aggregates computed from real rows: orders, revenue, catalogue, customers,
   projects and AI usage. When there is not enough data we say so instead of
   drawing a convincing chart out of nothing.
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, compact, timeAgo, statusLabel } from "../../../lib/format.js";
import { state, aiCredits, plan } from "../../../lib/store.js";
import { orders as fetchOrders, products as fetchProducts, customers as fetchCustomers, projects as fetchProjects, payments as fetchPayments } from "../data.js";
import { pageHead, setupNotice, statCard, emptyState, skeletonView } from "../components.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { actionPendingDeploy, api, runtimeConfig } from "../../../lib/api.js";
import { toCsv, downloadCsv } from "../../../lib/csv.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";

export default async function render(root) {
  root.innerHTML = skeletonView(4);

  let orderRows = [];
  let productRows = [];
  let customerRows = [];
  let projectRows = [];
  let paymentRows = [];

  /* store_analytics() is the server's own definition of revenue, conversion and
     category totals. The client still computes the same figures for the cards
     it already had, but the new panels read the server's answer so the screen,
     the CSV report and the AI analysis cannot disagree. */
  let storeStats = null;
  try {
    const { data } = await sb.rpc("store_analytics", { p_days: 30 });
    storeStats = data || null;
  } catch {
    storeStats = null;
  }

  try {
    const [o, p, c, pr, pay] = await Promise.all([
      fetchOrders({ limit: 500 }),
      fetchProducts(),
      fetchCustomers(),
      fetchProjects({ limit: 100 }),
      fetchPayments(50).catch(() => ({ data: [] }))
    ]);
    orderRows = o.data;
    productRows = p.data;
    customerRows = c.data;
    projectRows = pr.data;
    paymentRows = pay.data;
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Analytics" })}${setupNotice(error, "Analytics")}`;
    return;
  }

  const paidStatuses = ["paid", "processing", "shipped", "delivered", "fulfilled"];
  const paidOrders = orderRows.filter((row) => paidStatuses.includes(row.status));
  const revenue = paidOrders.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const avgOrder = paidOrders.length ? revenue / paidOrders.length : 0;

  const series = buildSeries(orderRows, 14);
  const maxSeries = Math.max(1, ...series.map((point) => point.value));

  const statusBreakdown = ["pending", "processing", "shipped", "delivered", "cancelled"].map((status) => ({
    status,
    count: orderRows.filter((row) => row.status === status).length
  }));

  const stockValue = productRows.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.stock || 0), 0);
  const credits = aiCredits();
  const published = projectRows.filter((row) => row.status === "published").length;
  const verifiedPayments = paymentRows.filter((row) => row.status === "verified");

  root.innerHTML = `
    ${pageHead({
      title: "Analytics",
      desc: `Computed from ${orderRows.length} order${orderRows.length === 1 ? "" : "s"}, ${productRows.length} products and ${projectRows.length} projects in your workspace. No synthetic data.`,
      actions: `<button class="btn btn-secondary btn-sm" id="report-csv">${icon("download", { size: 14 })}Download report</button>
                <button class="btn btn-primary btn-sm" id="analyse-ai">${icon("sparkles", { size: 14 })}Analyse with AI</button>
                <a class="btn btn-ghost btn-sm" href="/app/?view=orders">${icon("package", { size: 14 })}Orders</a>`
    })}

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Revenue", value: money(revenue), iconName: "indian-rupee", foot: `${paidOrders.length} paid orders` })}
      ${statCard({ label: "Average order", value: money(avgOrder), iconName: "chart-line", foot: "Paid orders only" })}
      ${statCard({ label: "Customers", value: compact(customerRows.length), iconName: "users", foot: `${customerRows.filter((c) => c.created_at && Date.now() - new Date(c.created_at) < 2.6e9).length} new in 30 days` })}
      ${statCard({ label: "Stock value", value: money(stockValue), iconName: "boxes", foot: `${productRows.length} products` })}
    </div>

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({
        label: "Conversion",
        value: storeStats?.conversionRate == null ? "No visits yet" : `${storeStats.conversionRate}%`,
        iconName: "trending-up",
        foot: storeStats?.visits
          ? `${storeStats.paidOrders} paid of ${storeStats.visits} visits · 30 days`
          : "The published site has not reported a visit yet"
      })}
      ${statCard({
        label: "Repeat customers",
        value: compact(storeStats?.repeatCustomers ?? 0),
        iconName: "repeat",
        foot: `${compact(storeStats?.customers ?? customerRows.length)} customers in total`
      })}
      ${statCard({
        label: "Top category",
        value: storeStats?.categories?.[0] ? esc(storeStats.categories[0].category) : "—",
        iconName: "tags",
        foot: storeStats?.categories?.[0] ? money(storeStats.categories[0].revenue) + " sold" : "No category sales yet"
      })}
      ${statCard({
        label: "Visits",
        value: compact(storeStats?.visits ?? 0),
        iconName: "eye",
        foot: "Last 30 days, from the published site"
      })}
    </div>

    <div class="card" id="ai-analysis" hidden style="margin-bottom:var(--s-4)">
      <div class="card-head">
        <div>
          <div class="card-title">What the numbers say</div>
          <div class="card-sub">Written by the AI from the aggregates below. It is told to admit when the data is too thin.</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="ai-close" type="button">Hide</button>
      </div>
      <div class="card-body" id="ai-analysis-body"></div>
    </div>

    <div class="grid-main-side">
      <div class="stack gap-4">
        <div class="chart-card">
          <div class="chart-head">
            <div>
              <div class="chart-title">Order value · last 14 days</div>
              <div class="chart-sub">Sum of order totals placed on each day (all statuses)</div>
            </div>
            <div class="legend"><span><i style="background:var(--violet)"></i>Order value</span></div>
          </div>
          <div class="chart-body">
            ${
              orderRows.length
                ? `<div class="bar-chart">${series
                    .map(
                      (point) => `<div class="bar-col" data-tip="${esc(point.label)} · ${esc(money(point.value))}">
                        <i style="height:${Math.max(3, (point.value / maxSeries) * 100)}%"></i>
                        <span>${esc(point.short)}</span>
                      </div>`
                    )
                    .join("")}</div>`
                : emptyState({ icon: "chart-line", title: "No order data yet", desc: "Record or receive orders and this chart fills in from real rows." })
            }
          </div>
        </div>

        <div class="grid-2">
          <div class="chart-card">
            <div class="chart-head"><div><div class="chart-title">Order status</div><div class="chart-sub">Current distribution</div></div></div>
            <div class="stack gap-3">
              ${statusBreakdown
                .map(
                  (row) => `<div>
                    <div class="row between" style="font-size:var(--fs-xs);color:var(--text-2);margin-bottom:4px">
                      <span>${esc(statusLabel(row.status))}</span><span>${row.count}</span>
                    </div>
                    <div class="progress progress-thin"><span style="width:${
                      orderRows.length ? Math.round((row.count / orderRows.length) * 100) : 0
                    }%"></span></div>
                  </div>`
                )
                .join("")}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-head"><div><div class="chart-title">Workspace</div><div class="chart-sub">Plan and usage</div></div></div>
            <dl>
              <div class="kv"><dt>Plan</dt><dd>${esc(plan().name)}</dd></div>
              <div class="kv"><dt>AI generations</dt><dd>${credits.used} / ${credits.limit}</dd></div>
              <div class="kv"><dt>Projects</dt><dd>${projectRows.length} (${published} published)</dd></div>
              <div class="kv"><dt>Payments verified</dt><dd>${verifiedPayments.length}</dd></div>
              <div class="kv"><dt>Business</dt><dd>${esc(state.business?.name || "—")}</dd></div>
            </dl>
          </div>
        </div>

        <div class="chart-card" style="margin-bottom:var(--s-4)">
          <div class="chart-head">
            <div><div class="chart-title">Sales by category</div><div class="chart-sub">Revenue from paid orders in the last 30 days</div></div>
          </div>
          <div class="chart-body">
            ${
              storeStats?.categories?.length
                ? `<div class="table-wrap"><table class="table table-compact">
                    <thead><tr><th>Category</th><th>Orders</th><th>Units</th><th>Revenue</th></tr></thead>
                    <tbody>${storeStats.categories
                      .map(
                        (row) => `<tr>
                          <td class="cell-strong">${esc(row.category)}</td>
                          <td>${esc(row.orders)}</td>
                          <td>${esc(row.units)}</td>
                          <td>${esc(money(row.revenue))}</td>
                        </tr>`
                      )
                      .join("")}</tbody>
                  </table></div>`
                : emptyState({
                    icon: "tags",
                    title: "No category sales yet",
                    desc: "Give products a category and record a paid order; this fills in from the line items."
                  })
            }
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-head">
            <div><div class="chart-title">Catalogue performance</div><div class="chart-sub">Stock and price position</div></div>
            <a class="btn btn-ghost btn-sm" href="/app/?view=inventory">Manage inventory</a>
          </div>
          ${
            productRows.length
              ? `<div class="table-wrap"><table class="table table-compact">
                  <thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Stock value</th></tr></thead>
                  <tbody>${productRows
                    .slice()
                    .sort((a, b) => Number(b.price || 0) * Number(b.stock || 0) - Number(a.price || 0) * Number(a.stock || 0))
                    .slice(0, 8)
                    .map(
                      (row) => `<tr>
                        <td class="cell-strong">${esc(row.name)}</td>
                        <td>${esc(money(row.price, row.currency || "INR"))}</td>
                        <td>${esc(row.stock)}</td>
                        <td>${esc(money(Number(row.price || 0) * Number(row.stock || 0), row.currency || "INR"))}</td>
                      </tr>`
                    )
                    .join("")}</tbody>
                </table></div>`
              : emptyState({ icon: "boxes", title: "No products yet", desc: "Add products to see catalogue performance." })
          }
        </div>
      </div>

      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">Recent payments</div><a class="btn btn-ghost btn-sm" href="/app/?view=billing">Billing</a></div>
          <div class="card-body">
            ${
              paymentRows.length
                ? `<div class="stack gap-3">${paymentRows
                    .slice(0, 5)
                    .map(
                      (row) => `<div class="row gap-3">
                        <span class="notif-icon">${icon("receipt", { size: 13 })}</span>
                        <div class="grow">
                          <div style="font-size:var(--fs-sm);color:var(--text)">${esc(money(row.amount, row.currency || "INR"))}<span class="dim" style="font-size:var(--fs-2xs)"> · ${esc(row.purpose || "service")}</span></div>
                          <div class="dim" style="font-size:var(--fs-2xs)">${esc(timeAgo(row.created_at))}</div>
                        </div>
                        <span class="badge badge-${row.status === "verified" ? "ok" : row.status === "rejected" ? "danger" : "warn"}">${esc(statusLabel(row.status))}</span>
                      </div>`
                    )
                    .join("")}</div>`
                : `<p class="muted" style="font-size:var(--fs-xs)">No payments recorded.</p>`
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">What to watch</div></div>
          <div class="card-body">
            <div class="stack gap-3" style="font-size:var(--fs-xs);color:var(--text-2);line-height:1.6">
              <div class="row gap-2" style="align-items:flex-start">${icon("triangle-alert", { size: 14, cls: "dim" })}<span>${
                productRows.filter((p) => Number(p.stock) <= 5).length
              } products at or below 5 units.</span></div>
              <div class="row gap-2" style="align-items:flex-start">${icon("clock", { size: 14, cls: "dim" })}<span>${
                orderRows.filter((o) => o.status === "pending").length
              } orders still pending.</span></div>
              <div class="row gap-2" style="align-items:flex-start">${icon("sparkles", { size: 14, cls: "dim" })}<span>${
                credits.limit - credits.used
              } AI generations left this month.</span></div>
              <div class="row gap-2" style="align-items:flex-start">${icon("globe", { size: 14, cls: "dim" })}<span>${
                projectRows.filter((p) => p.status !== "published").length
              } projects not published yet.</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  void qs;

  /* The report is the same shape as the screen: the figures shown, not a second
     interpretation of them. */
  on(qs("#report-csv"), "click", () => {
    const rows = [
      ["Revenue", storeStats?.revenue ?? revenue],
      ["Paid orders", storeStats?.paidOrders ?? paidOrders.length],
      ["Orders", storeStats?.orders ?? orderRows.length],
      ["Average order", storeStats?.averageOrder ?? Math.round(avgOrder)],
      ["Customers", storeStats?.customers ?? customerRows.length],
      ["Repeat customers", storeStats?.repeatCustomers ?? 0],
      ["Visits (30 days)", storeStats?.visits ?? 0],
      ["Conversion %", storeStats?.conversionRate ?? "no visits recorded"]
    ];
    const csv = toCsv(["metric", "value"], rows);
    const categories = storeStats?.categories || [];
    const categoryCsv = categories.length
      ? "\n\n" + toCsv(["category", "orders", "units", "revenue"], categories.map((row) => [row.category, row.orders, row.units, row.revenue]))
      : "";
    downloadCsv(`shinzora-report-${new Date().toISOString().slice(0, 10)}.csv`, csv + categoryCsv);
    toast({ title: "Report downloaded" }, { tone: "success", duration: 2000 });
  });

  on(qs("#analyse-ai"), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const current = button.innerHTML;
    button.innerHTML = `${icon("loader", { size: 14 })}Reading the numbers…`;
    try {
      const runtime = await runtimeConfig();
      if (!runtime?.ai?.configured) {
        throw new Error("The AI service is not configured on this deployment.");
      }
      const snapshot = {
        days: storeStats?.days ?? 30,
        revenue: storeStats?.revenue ?? revenue,
        paidOrders: storeStats?.paidOrders ?? paidOrders.length,
        orders: storeStats?.orders ?? orderRows.length,
        averageOrder: storeStats?.averageOrder ?? Math.round(avgOrder),
        customers: storeStats?.customers ?? customerRows.length,
        repeatCustomers: storeStats?.repeatCustomers ?? 0,
        visits: storeStats?.visits ?? 0,
        conversionRate: storeStats?.conversionRate ?? null,
        categories: (storeStats?.categories || []).slice(0, 8),
        topCustomers: (storeStats?.topCustomers || []).slice(0, 5).map((row) => ({ orders: row.orders, revenue: row.revenue })),
        lowStockProducts: productRows.filter((row) => Number(row.stock) <= 5).length,
        products: productRows.length
      };
      const analysis = await api.ai.dataAnalysis({ snapshot });
      const box = qs("#ai-analysis");
      box.hidden = false;
      qs("#ai-analysis-body").innerHTML = `
        <p style="font-size:var(--fs-sm);color:var(--text);margin-bottom:var(--s-3)">${esc(analysis.headline || "")}</p>
        <div class="stack gap-3">
          ${(analysis.findings || [])
            .map(
              (finding) => `<div class="card" style="padding:var(--s-3)">
                <div class="row between gap-2" style="align-items:baseline">
                  <strong style="font-size:var(--fs-sm)">${esc(finding.title || "Finding")}</strong>
                  <span class="badge badge-${finding.confidence === "high" ? "ok" : finding.confidence === "medium" ? "warn" : "neutral"}">${esc(finding.confidence || "low")} confidence</span>
                </div>
                <p class="muted" style="font-size:var(--fs-xs);margin-top:6px">${esc(finding.detail || "")}</p>
                ${finding.action ? `<p style="font-size:var(--fs-xs);color:var(--text-2);margin-top:6px"><strong>Do this:</strong> ${esc(finding.action)}</p>` : ""}
              </div>`
            )
            .join("")}
        </div>
        ${
          (analysis.caveats || []).length
            ? `<div class="alert alert-info" style="margin-top:var(--s-3);font-size:var(--fs-xs)">${icon("info", { size: 14 })}<div>${analysis.caveats
                .map((row) => esc(row))
                .join("<br>")}</div></div>`
            : ""
        }`;
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      if (actionPendingDeploy(error)) {
        const box = qs("#ai-analysis");
        box.hidden = false;
        qs("#ai-analysis-body").innerHTML = `<div class="alert alert-warn" style="font-size:var(--fs-xs)">${icon("info", { size: 14 })}<div>
          The AI reading needs the updated <code>ai</code> Edge Function, which is not deployed on this instance yet.
          Every number on this page is still real — they come from your database, not from the model.
        </div></div>`;
        return;
      }
      toastError(normalizeError(error));
    } finally {
      button.disabled = false;
      button.innerHTML = current;
    }
  });

  on(qs("#ai-close"), "click", () => {
    qs("#ai-analysis").hidden = true;
  });
}

function buildSeries(orders, days) {
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, { value: 0, date });
  }
  orders.forEach((order) => {
    const stamp = order.placed_at || order.created_at;
    if (!stamp) return;
    const key = new Date(stamp).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.get(key).value += Number(order.total_amount || 0);
  });
  return Array.from(buckets.values()).map((bucket) => ({
    value: bucket.value,
    label: bucket.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    short: bucket.date.toLocaleDateString("en-IN", { day: "2-digit" })
  }));
}
