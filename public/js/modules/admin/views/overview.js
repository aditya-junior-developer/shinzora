/* ==========================================================================
   Admin · Overview — real platform counts and the latest activity
   ========================================================================== */

import { esc, qs } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, statusLabel } from "../../../lib/format.js";
import { adminApi } from "../api.js";
import { setCounts, navigate } from "../shell.js";
import { emptyState } from "../../dashboard/components.js";
import { avatarMarkup } from "../../../lib/avatar.js";

export default async function render(root, { state }) {
  const data = await adminApi.overview();
  const counts = data.counts || {};
  setCounts({
    payments_pending: counts.payments_pending,
    service_pending: counts.service_pending,
    tickets_open: counts.tickets_open,
    contacts_new: counts.contacts_new
  });

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Overview</h1>
        <p>Live totals from your database. Nothing on this screen is a placeholder — every number is a count query.</p>
      </div>
      <div class="admin-filters">
        <button class="btn btn-secondary btn-sm" data-go="customers">${icon("users", { size: 14 })}Customers</button>
        <button class="btn btn-primary btn-sm" data-go="payments">${icon("receipt", { size: 14 })}Review payments${
    counts.payments_pending ? ` (${counts.payments_pending})` : ""
  }</button>
      </div>
    </div>

    <div class="admin-grid">
      ${stat("Customers", counts.users ?? 0, "users", "Registered accounts")}
      ${stat("Projects", counts.projects ?? 0, "panels-top-left", `${counts.published ?? 0} published`)}
      ${stat("Verified revenue", money(counts.revenue_total ?? 0), "indian-rupee", `${counts.verified_payments ?? 0} confirmed payments`)}
      ${stat("Payments to review", counts.payments_pending ?? 0, "hourglass", "Awaiting verification")}
      ${stat("Service requests", counts.service_pending ?? 0, "briefcase", "Requested or in progress")}
      ${stat("Open tickets", counts.tickets_open ?? 0, "life-buoy", "Support queue")}
      ${stat("Contact messages", counts.contacts_new ?? 0, "mail", "Unread from the website")}
    </div>

    <div class="admin-split">
      <div class="admin-card">
        <div class="admin-card-head">
          <div>
            <div class="admin-card-title">Platform activity</div>
            <div class="admin-card-sub">Latest 12 events across all customers</div>
          </div>
          <button class="btn btn-ghost btn-sm" data-go="activity">All activity</button>
        </div>
        <div class="admin-card-body">
          ${
            (data.recent_activity || []).length
              ? `<div class="timeline">${data.recent_activity
                  .map(
                    (row) => `<div class="timeline-item">
                      <div class="timeline-title">${esc(prettyAction(row.action))}</div>
                      <div class="timeline-meta">
                        ${esc(row.entity_type || "platform")} · ${esc(timeAgo(row.created_at))}
                      </div>
                    </div>`
                  )
                  .join("")}</div>`
              : emptyState({ icon: "activity", title: "No activity yet", desc: "Customer actions are logged here as they happen." })
          }
        </div>
      </div>

      <div class="stack gap-4">
        <div class="admin-card">
          <div class="admin-card-head">
            <div class="admin-card-title">Newest customers</div>
            <button class="btn btn-ghost btn-sm" data-go="customers">View all</button>
          </div>
          <div class="admin-card-body">
            ${
              (data.recent_customers || []).length
                ? `<div class="stack gap-3">${data.recent_customers
                    .map(
                      (row) => `<div class="row gap-3">
                        ${avatarMarkup({ name: row.full_name, email: row.email, avatarUrl: row.avatar_url, size: "sm" })}
                        <div class="grow">
                          <div style="font-size:var(--fs-xs);color:var(--text)">${esc(row.full_name || "Unnamed")}</div>
                          <div style="font-size:var(--fs-2xs);color:var(--text-4)">${esc(row.email || "")}</div>
                        </div>
                        <span class="dim" style="font-size:var(--fs-2xs)">${esc(timeAgo(row.created_at))}</span>
                      </div>`
                    )
                    .join("")}</div>`
                : emptyState({ icon: "users", title: "No customers yet" })
            }
          </div>
        </div>

        <div class="admin-card">
          <div class="admin-card-head"><div class="admin-card-title">Before you act</div></div>
          <div class="admin-card-body">
            <div class="admin-note">
              ${icon("shield-check", { size: 15 })}
              <span>
                Approving a payment activates the plan or service immediately and is recorded against your account.
                Only approve after the UPI statement shows the credit.
              </span>
            </div>
            <div class="admin-kv" style="margin-top:var(--s-4)">
              <dt>Admins</dt><dd><button class="btn btn-ghost btn-sm" data-go="access">Manage access</button></dd>
              <dt>Broadcast</dt><dd><button class="btn btn-ghost btn-sm" data-go="messaging">Send announcement</button></dd>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-go]");
    if (button) navigate(button.getAttribute("data-go"));
  });

  void state;
  void qs;
  void statusLabel;
}

function stat(label, value, iconName, foot) {
  return `<div class="admin-stat">
    <div class="admin-stat-label">${icon(iconName, { size: 12 })}${esc(label)}</div>
    <div class="admin-stat-value">${esc(String(value))}</div>
    <div class="admin-stat-foot">${esc(foot)}</div>
  </div>`;
}

function prettyAction(action = "") {
  return String(action)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
