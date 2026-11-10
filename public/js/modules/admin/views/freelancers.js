/* ==========================================================================
   Admin · Freelancers
   --------------------------------------------------------------------------
   The other half of the customer list. An account that works as an agent is
   not a business customer — it has a handle, a public profile and proposals
   instead of a storefront — so it gets its own screen with the columns that
   matter for it.

   Data: the same `customers` admin action the Customers screen uses (it is one
   list of accounts on the server), narrowed here to account_type = 'agent', plus
   the handle and heartbeat that the admins' RLS policy lets this console read
   straight from `profiles`.
   ========================================================================== */

import { qs, esc, on, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, initials } from "../../../lib/format.js";
import { adminApi, peopleMeta } from "../api.js";
import { adminState } from "../shell.js";
import { emptyState } from "../../dashboard/components.js";
import { openModal } from "../../../ui/modal.js";
import { presenceDot, presenceLabel, presenceState } from "../../../ui/presence.js";

export default async function render(root) {
  let search = adminState.search || "";
  let activeOnly = false;
  let rows = [];

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Freelancers</h1>
        <p>Agents and freelancers: the accounts that apply to work rather than run a business. Their handle is how a business owner finds and messages them.</p>
      </div>
      <div class="admin-filters">
        <button class="chip" id="active-filter" aria-pressed="false">${icon("activity", { size: 13 })}Active in the last 3 minutes</button>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Freelancer accounts</div>
          <div class="admin-card-sub" id="freelancer-count">Loading…</div>
        </div>
        <div class="admin-search" style="max-width:280px;display:block">
          ${icon("search", { size: 14 })}
          <input id="freelancer-search" type="search" placeholder="Handle, name or email" value="${esc(search)}" aria-label="Search freelancers" />
        </div>
      </div>
      <div id="freelancer-table"></div>
    </div>`;

  await load();

  let timer;
  on(qs("#freelancer-search"), "input", (event) => {
    clearTimeout(timer);
    const value = event.target.value;
    timer = setTimeout(async () => {
      search = value.trim();
      adminState.search = search;
      await load();
    }, 300);
  });

  on(qs("#active-filter"), "click", (event) => {
    activeOnly = !activeOnly;
    event.currentTarget.setAttribute("aria-pressed", String(activeOnly));
    paint();
  });

  delegate(qs("#freelancer-table"), "click", "[data-handle]", (_event, node) => {
    const row = rows.find((item) => item.id === node.getAttribute("data-handle"));
    if (row) detail(row);
  });

  async function load() {
    try {
      const response = await adminApi.customers({ search, limit: 100 });
      const all = response.customers || [];
      const meta = await peopleMeta(all.map((row) => row.id));
      rows = all
        .map((row) => ({ ...row, ...(meta.get(row.id) || {}) }))
        .filter((row) => row.account_type === "agent");
      qs("#freelancer-count").textContent = `${rows.length} freelancer account${rows.length === 1 ? "" : "s"}${
        search ? ` matching “${search}”` : ""
      }`;
      paint();
    } catch (error) {
      safeSet("#freelancer-table", `<div class="admin-empty">${esc(error.message || "Could not load freelancers.")}</div>`);
    }
  }

  function paint() {
    const visible = activeOnly ? rows.filter((row) => presenceState(row.last_seen_at) === "active") : rows;

    safeSet(
      "#freelancer-table",
      visible.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Freelancer</th><th>Handle</th><th>Status</th><th>Plan</th><th>Projects</th><th>Joined</th><th></th></tr></thead>
            <tbody>${visible
              .map(
                (row) => `<tr>
                  <td>
                    <div class="customer-cell">
                      <span class="customer-avatar">
                        <span class="avatar">${esc(initials(row.name || row.email))}</span>
                        ${presenceDot(row.last_seen_at, { size: 10 })}
                      </span>
                      <div><strong>${esc(row.name || "Unnamed")}</strong><span>${esc(row.email || "")}</span></div>
                    </div>
                  </td>
                  <td class="mono">${row.username ? `@${esc(row.username)}` : `<span class="dim">not set</span>`}</td>
                  <td>${esc(presenceLabel(presenceState(row.last_seen_at)))}</td>
                  <td><span class="badge badge-${row.plan === "enterprise" ? "brand" : row.plan === "pro" ? "ok" : "neutral"}">${esc(row.plan)}</span></td>
                  <td>${row.projects}</td>
                  <td class="dim">${esc(timeAgo(row.joined))}</td>
                  <td class="cell-actions"><button class="btn btn-secondary btn-sm" data-handle="${esc(row.id)}">Open</button></td>
                </tr>`
              )
              .join("")}</tbody>
          </table></div>`
        : emptyState({
            icon: "users",
            title: rows.length ? "No active freelancers right now" : "No freelancer accounts yet",
            desc: rows.length
              ? "Clear the activity filter to see everybody."
              : "Accounts appear here once somebody signs up and chooses “I work as an agent”."
          })
    );
  }

  function detail(row) {
    openModal({
      title: row.name || row.email || "Freelancer",
      desc: `${row.username ? `@${row.username} · ` : ""}${presenceLabel(presenceState(row.last_seen_at))}`,
      size: "md",
      body: `<dl class="admin-kv">
        <dt>Email</dt><dd>${esc(row.email || "—")}</dd>
        <dt>Handle</dt><dd class="mono">${row.username ? `@${esc(row.username)}` : "—"}</dd>
        <dt>Plan</dt><dd>${esc(row.plan)}</dd>
        <dt>AI usage</dt><dd>${row.ai_used} / ${row.ai_limit}</dd>
        <dt>Projects</dt><dd>${row.projects}</dd>
        <dt>Joined</dt><dd>${esc(timeAgo(row.joined))}</dd>
        <dt>Last seen</dt><dd>${esc(presenceLabel(presenceState(row.last_seen_at)))}</dd>
      </dl>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`
    });
  }
}
