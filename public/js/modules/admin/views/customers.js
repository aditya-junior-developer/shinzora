/* ==========================================================================
   Admin · Customers — list, filter, inspect, and act on one account
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, date, dateTime, timeAgo, statusLabel } from "../../../lib/format.js";
import { adminApi, peopleMeta } from "../api.js";
import { adminState } from "../shell.js";
import { emptyState } from "../../dashboard/components.js";
import { openModal, formDialog, confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { presenceDot, presenceLabel, presenceState } from "../../../ui/presence.js";
import { avatarMarkup } from "../../../lib/avatar.js";

const PLAN_FILTERS = ["all", "free", "pro", "enterprise"];

export default async function render(root, { state }) {
  let plan = "all";
  let onboardedOnly = false;
  let search = adminState.search || "";
  let rows = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Customers</h1>
        <p>Every business owner, with the business they run, their plan and their usage. Freelancers and agents have their own section.</p>
      </div>
      <div class="admin-filters">
        <div class="admin-tabs" id="plan-filter">
          ${PLAN_FILTERS.map((item) => `<button data-plan="${item}" class="${item === "all" ? "is-active" : ""}">${esc(item === "all" ? "All plans" : item)}</button>`).join("")}
        </div>
        <button class="chip" id="onboarded-filter" aria-pressed="false">${icon("check-circle-2", { size: 13 })}Onboarded only</button>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Accounts</div>
          <div class="admin-card-sub" id="customer-count">Loading…</div>
        </div>
        <div class="admin-search" style="max-width:280px;display:block">
          ${icon("search", { size: 14 })}
          <input id="customer-search" type="search" placeholder="Name, email or phone" value="${esc(search)}" aria-label="Search customers" />
        </div>
      </div>
      <div id="customer-table"></div>
    </div>`;

  await load();

  on(qs("#plan-filter"), "click", (event) => {
    const button = event.target.closest("[data-plan]");
    if (!button) return;
    plan = button.getAttribute("data-plan");
    root.querySelectorAll("#plan-filter button").forEach((node) => node.classList.toggle("is-active", node === button));
    paint();
  });

  on(qs("#onboarded-filter"), "click", (event) => {
    onboardedOnly = !onboardedOnly;
    event.currentTarget.setAttribute("aria-pressed", String(onboardedOnly));
    paint();
  });

  let timer;
  on(qs("#customer-search"), "input", (event) => {
    clearTimeout(timer);
    const value = event.target.value;
    timer = setTimeout(async () => {
      search = value.trim();
      adminState.search = search;
      await load();
    }, 300);
  });

  delegate(qs("#customer-table"), "click", "[data-open]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-open"));
    if (row) detail(row);
  });

  async function load() {
    try {
      const response = await adminApi.customers({ search, limit: 100 });
      const all = response.customers || [];
      /* One extra read gives every row its handle, its account kind and its
         heartbeat. Accounts that work as agents are not customers of a business
         here — they are listed under Freelancers. */
      const meta = await peopleMeta(all.map((row) => row.id));
      rows = all
        .map((row) => ({ ...row, ...(meta.get(row.id) || {}) }))
        .filter((row) => row.account_type !== "agent");
      qs("#customer-count").textContent = `${rows.length} business accounts${search ? ` matching “${search}”` : ""}`;
      paint();
    } catch (error) {
      safeSet("#customer-table", `<div class="admin-empty">${esc(error.message || "Could not load customers.")}</div>`);
    }
  }

  function paint() {
    const visible = rows.filter((row) => {
      const planMatch = plan === "all" || row.plan === plan;
      const onboardMatch = !onboardedOnly || row.onboarded;
      return planMatch && onboardMatch;
    });

    safeSet("#customer-table", visible.length
      ? `<div class="table-wrap"><table class="table">
          <thead>
            <tr><th>Customer</th><th>Business</th><th>Plan</th><th>AI usage</th><th>Projects</th><th>Onboarding</th><th>Joined</th><th></th></tr>
          </thead>
          <tbody>${visible
            .map(
              (row) => `<tr>
                <td>
                  <div class="customer-cell">
                    <span class="customer-avatar">
                      ${avatarMarkup({ name: row.name, email: row.email, avatarUrl: row.avatar_url })}
                      ${presenceDot(row.last_seen_at, { size: 10 })}
                    </span>
                    <div><strong>${esc(row.name || "Unnamed")}</strong><span>${esc(row.email || "")}${
                row.phone ? ` · ${esc(row.phone)}` : ""
              }</span><span class="cell-sub">${esc(presenceLabel(presenceState(row.last_seen_at)))}${
                row.username ? ` · @${esc(row.username)}` : ""
              }</span></div>
                  </div>
                </td>
                <td>${esc(row.business_name || "—")}<div class="cell-sub">${esc(row.category || "")}</div></td>
                <td><span class="badge badge-${row.plan === "enterprise" ? "brand" : row.plan === "pro" ? "ok" : "neutral"}">${esc(row.plan)}</span></td>
                <td>${row.ai_used} / ${row.ai_limit}</td>
                <td>${row.projects}${row.published ? ` <span class="dim">(${row.published} live)</span>` : ""}</td>
                <td>${
                  row.onboarded
                    ? `<span class="badge badge-ok">Complete</span>`
                    : Number.isFinite(Number(row.onboarding_step))
                      ? `<span class="badge badge-warn">Step ${Number(row.onboarding_step)}</span>`
                      : `<span class="badge badge-neutral">Not started</span>`
                }</td>
                <td class="dim">${esc(timeAgo(row.joined))}</td>
                <td class="cell-actions"><button class="btn btn-secondary btn-sm" data-open="${esc(row.id)}">Open</button></td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : emptyState({ icon: "users", title: rows.length ? "No accounts match those filters" : "No customers yet", desc: rows.length ? "Clear the plan filter or search term." : "Accounts appear here as soon as someone signs up." }));
  }

  async function detail(row) {
    const modal = openModal({
      title: row.name || row.email || "Customer",
      desc: `${row.email || ""} · joined ${date(row.joined)}`,
      size: "xl",
      body: `<div class="admin-empty">Loading profile…</div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>
               <button class="btn btn-secondary" id="msg-user">${icon("message-square", { size: 14 })}Message this customer</button>
               <button class="btn btn-primary" id="edit-sub">${icon("crown", { size: 14 })}Manage subscription</button>`
    });

    try {
      const data = await adminApi.customer(row.id);
      qs(".modal-body", modal.root).innerHTML = profileMarkup(data);
    } catch (error) {
      qs(".modal-body", modal.root).innerHTML = `<div class="admin-empty">${esc(error.message)}</div>`;
    }

    qs("#edit-sub", modal.root).addEventListener("click", () => {
      modal.close();
      subscriptionDialog(row);
    });

    qs("#msg-user", modal.root).addEventListener("click", () => {
      modal.close();
      navigateToMessaging(row);
    });
  }

  function profileMarkup(data) {
    const profile = data.profile || {};
    const business = data.business || {};
    const sub = data.subscription || {};
    const onboarding = data.onboarding || {};

    return `
      <div class="admin-grid" style="margin-bottom:var(--s-4)">
        ${mini("Plan", sub.plan || "free")}
        ${mini("AI usage", `${sub.ai_credits_used ?? 0} / ${sub.ai_credits_limit ?? 30}`)}
        ${mini("Projects", (data.projects || []).length)}
        ${mini("Payments", (data.payments || []).length)}
      </div>

      <div class="admin-split">
        <div class="stack gap-4">
          <div>
            <div class="section-title"><h3>Profile</h3></div>
            <dl class="admin-kv">
              <dt>Name</dt><dd>${esc(profile.full_name || "—")}</dd>
              <dt>Email</dt><dd>${esc(profile.email || "—")}</dd>
              <dt>Phone</dt><dd>${esc(profile.phone || "—")}</dd>
              <dt>Registered</dt><dd>${esc(dateTime(profile.created_at))}</dd>
              <dt>Last sign-in</dt><dd>${profile.last_sign_in_at ? esc(timeAgo(profile.last_sign_in_at)) : "—"}</dd>
              <dt>Onboarding</dt><dd>${onboarding.completed_at ? "Complete" : `Step ${onboarding.current_step ?? 1}`}</dd>
            </dl>
          </div>

          <div>
            <div class="section-title"><h3>Business</h3></div>
            ${
              business.name
                ? `<dl class="admin-kv">
                    <dt>Name</dt><dd>${esc(business.name)}</dd>
                    <dt>Category</dt><dd>${esc(business.category || "—")}</dd>
                    <dt>Location</dt><dd>${esc(business.location || "—")}</dd>
                    <dt>Audience</dt><dd>${esc(business.target_audience || "—")}</dd>
                    <dt>Stage</dt><dd>${esc(business.stage || "—")}</dd>
                    <dt>Goals</dt><dd>${esc((business.goals || []).join(", ") || "—")}</dd>
                    <dt>Description</dt><dd>${esc(business.description || "—")}</dd>
                  </dl>`
                : `<div class="admin-note">${icon("info", { size: 14 })}<span>No business profile submitted yet.</span></div>`
            }
          </div>

          <div>
            <div class="section-title"><h3>Projects</h3></div>
            ${
              (data.projects || []).length
                ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Versions</th><th>Updated</th></tr></thead><tbody>
                    ${data.projects
                      .map(
                        (project) => `<tr><td>${esc(project.name)}</td><td>${esc(project.type)}</td>
                          <td>${esc(project.status)}</td><td>${project.version_count ?? 0}</td>
                          <td class="dim">${esc(timeAgo(project.updated_at))}</td></tr>`
                      )
                      .join("")}</tbody></table></div>`
                : `<div class="admin-note">${icon("info", { size: 14 })}<span>No projects generated.</span></div>`
            }
          </div>
        </div>

        <div class="stack gap-4">
          <div>
            <div class="section-title"><h3>Payment history</h3></div>
            ${
              (data.payments || []).length
                ? `<div class="stack gap-2">${data.payments
                    .slice(0, 8)
                    .map(
                      (payment) => `<div class="row between" style="font-size:var(--fs-xs)">
                        <div>
                          <div style="color:var(--text)">${esc(money(payment.amount, payment.currency))}</div>
                          <div style="color:var(--text-4);font-size:var(--fs-2xs)">${esc(payment.purpose)} · ${esc(timeAgo(payment.created_at))}</div>
                        </div>
                        <span class="badge badge-${payment.status === "verified" ? "ok" : payment.status === "rejected" ? "danger" : "warn"}">${esc(payment.status)}</span>
                      </div>`
                    )
                    .join("")}</div>`
                : `<div class="admin-note">${icon("info", { size: 14 })}<span>No payments recorded.</span></div>`
            }
          </div>

          <div>
            <div class="section-title"><h3>Service requests</h3></div>
            ${
              (data.service_requests || []).length
                ? `<div class="stack gap-2">${data.service_requests
                    .map(
                      (request) => `<div class="row between" style="font-size:var(--fs-xs)">
                        <div><div style="color:var(--text)">${esc(request.title || request.service_type)}</div>
                        <div style="color:var(--text-4);font-size:var(--fs-2xs)">${esc(timeAgo(request.created_at))}</div></div>
                        <span class="badge badge-neutral">${esc(statusLabel(request.status))}</span>
                      </div>`
                    )
                    .join("")}</div>`
                : `<div class="admin-note">${icon("info", { size: 14 })}<span>No service requests.</span></div>`
            }
          </div>

          <div>
            <div class="section-title"><h3>Recent activity</h3></div>
            ${
              (data.activity || []).length
                ? `<div class="timeline">${data.activity
                    .slice(0, 10)
                    .map(
                      (row) => `<div class="timeline-item">
                        <div class="timeline-title">${esc(String(row.action).replace(/_/g, " "))}</div>
                        <div class="timeline-meta">${esc(row.entity_type || "")} · ${esc(timeAgo(row.created_at))}</div>
                      </div>`
                    )
                    .join("")}</div>`
                : `<div class="admin-note">${icon("info", { size: 14 })}<span>No activity logged.</span></div>`
            }
          </div>
        </div>
      </div>`;
  }

  function mini(label, value) {
    return `<div class="admin-stat"><div class="admin-stat-label">${esc(label)}</div><div class="admin-stat-value">${esc(
      String(value)
    )}</div></div>`;
  }

  async function subscriptionDialog(row) {
    const values = await formDialog({
      title: `Manage subscription — ${row.name || row.email}`,
      desc: "This writes to subscriptions directly and notifies the customer. Use it for verified offline payments only.",
      fields: [
        {
          name: "plan",
          label: "Plan",
          type: "select",
          value: row.plan || "free",
          options: [
            { value: "free", label: "Free — 30 credits" },
            { value: "pro", label: "Pro — 800 credits" },
            { value: "enterprise", label: "Enterprise — 6000 credits" }
          ]
        },
        {
          name: "status",
          label: "Status",
          type: "select",
          value: row.subscription_status || "active",
          options: ["active", "past_due", "cancelled", "trialing"].map((value) => ({ value, label: value }))
        }
      ],
      submitLabel: "Update plan"
    });
    if (!values) return;

    const ok = await confirmDialog({
      title: "Confirm plan change",
      desc: `Set ${row.email} to ${values.plan} (${values.status}). The customer is notified immediately.`,
      confirmLabel: "Apply"
    });
    if (!ok) return;

    try {
      await adminApi.subscriptionUpdate({ userId: row.id, plan: values.plan, status: values.status });
      toast({ title: "Subscription updated" }, { tone: "success" });
      await load();
    } catch (error) {
      toastError(error);
    }
  }

  function navigateToMessaging(row) {
    const url = new URL(location.href);
    url.searchParams.set("view", "messaging");
    url.searchParams.set("to", row.id);
    location.href = url.toString();
  }

  void state;
}
