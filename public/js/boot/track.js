/* ==========================================================================
   Shinzora — public order tracking
   --------------------------------------------------------------------------
   The one page a customer can open without an account. The token in the URL is
   the only credential: order_tracking() is anon-executable and returns exactly
   one order — status, milestones, line items, business name — and nothing that
   identifies the buyer beyond their first name.

   No dashboard shell, no session, no service key. If the link has been revoked
   the function raises, and the page says so plainly instead of pretending the
   order does not exist.
   ========================================================================== */

import { env } from "../config/env.js";

const view = document.getElementById("view");

const esc = (value = "") =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));

const MONEY = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function money(amount, currency = "INR") {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "INR").toUpperCase(),
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `${MONEY.format(value)} ${currency}`;
  }
}

const dateTime = (iso) => {
  if (!iso) return "—";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "—";
  return when.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const LABELS = {
  pending: "Placed",
  paid: "Payment received",
  processing: "Being packed",
  shipped: "On its way",
  delivered: "Delivered",
  fulfilled: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded"
};

const label = (status) => LABELS[String(status || "").toLowerCase()] || String(status || "").replace(/_/g, " ");

function failure(message) {
  view.innerHTML = `<div class="msg danger">${esc(message)}</div>
    <div class="card tight" style="margin-top:14px">
      <div class="label">What to do</div>
      <p class="lede" style="margin:8px 0 0">
        Tracking links can be turned off by the business, and each one only ever points at a single order.
        Ask the business to send a fresh link, or check the message it came in.
      </p>
    </div>`;
}

function render(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const timeline = Array.isArray(order.timeline) ? order.timeline : [];
  const currency = order.currency || "INR";
  const title = `${esc(order.business || "The business")} · order ${esc(order.orderNumber || "")}`;

  document.title = `${order.orderNumber || "Order"} · tracking · Shinzora`;

  const milestones = timeline.length
    ? timeline
        .map(
          (event) => `<li>
            <strong>${esc(label(event.status))}</strong>
            <div class="when">${esc(dateTime(event.at))}${
              event.note ? ` · ${esc(String(event.note).slice(0, 140))}` : ""
            }</div>
          </li>`
        )
        .join("")
    : `<li><strong>${esc(label(order.status))}</strong><div class="when">${esc(dateTime(order.placedAt))}</div></li>`;

  view.innerHTML = `
    <h1>${esc(order.customerFirstName || "Hello")}, your order is ${esc(
      String(label(order.status)).toLowerCase()
    )}.</h1>
    <p class="lede">${title}. This page updates itself as the order moves — keep the link.</p>

    <div class="card">
      <div class="row between">
        <div>
          <div class="label">Order</div>
          <div class="big">${esc(order.orderNumber || "—")}</div>
        </div>
        <span class="status ${esc(String(order.status || "").toLowerCase())}">${esc(label(order.status))}</span>
      </div>
      <div class="grid2" style="margin-top:18px">
        <div class="kv"><span>Placed</span><b>${esc(dateTime(order.placedAt))}</b></div>
        <div class="kv"><span>Shipped</span><b>${esc(dateTime(order.shippedAt))}</b></div>
        <div class="kv"><span>Delivered</span><b>${esc(dateTime(order.deliveredAt))}</b></div>
        <div class="kv"><span>Total</span><b>${esc(money(order.total, currency))}</b></div>
      </div>
    </div>

    <div class="card">
      <div class="label">Progress</div>
      <ol class="timeline" style="margin-top:14px">${milestones}</ol>
    </div>

    <div class="card">
      <div class="label" style="margin-bottom:10px">What you ordered</div>
      <table>
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
        <tbody>
          ${
            items.length
              ? items
                  .map(
                    (item) => `<tr>
                      <td>${esc(item.name || "Item")}</td>
                      <td class="num">${esc(item.quantity ?? 1)}</td>
                      <td class="num">${esc(money(item.unitPrice, currency))}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="3" class="muted">Item details are not available for this order.</td></tr>`
          }
        </tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="num">${esc(money(order.total, currency))}</td></tr></tfoot>
      </table>
    </div>

    <div class="card tight">
      <div class="label">Something wrong?</div>
      <p class="lede" style="margin:8px 0 0">
        Contact ${esc(order.business || "the business")} and quote order ${esc(order.orderNumber || "")}.
        They can resend this link or update the status.
      </p>
    </div>`;
}

async function boot() {
  if (!env.isConfigured || !window.supabase?.createClient) {
    failure("Tracking is not configured on this deployment.");
    return;
  }

  const token = new URLSearchParams(location.search).get("t") || "";
  if (!token.trim()) {
    failure("This link is missing its tracking code. Open the full link from your message.");
    return;
  }

  const client = window.supabase.createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  try {
    const { data, error } = await client.rpc("order_tracking", { p_token: token.trim() });
    if (error) {
      const message = String(error.message || "");
      failure(
        /valid any more|incomplete|not valid/i.test(message)
          ? "This tracking link is not valid any more."
          : message || "That order could not be loaded."
      );
      return;
    }
    if (!data) {
      failure("This tracking link is not valid any more.");
      return;
    }
    render(data);
  } catch (error) {
    failure(String(error?.message || "That order could not be loaded."));
  }
}

void boot();
