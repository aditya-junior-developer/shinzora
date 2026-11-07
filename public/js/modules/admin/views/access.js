/* ==========================================================================
   Shinzora Admin · Access — every account, and who may change it
   --------------------------------------------------------------------------
   Before migration 0009 this page could only ever show the signed-in
   administrator: `admin_users` allowed "select your own row" and the console had
   no write path at all. The directory now comes from public.admin_directory(),
   and role changes go through public.set_admin_role(), which enforces in the
   database what this page merely offers:

     • only a super administrator may change a role
     • the protected owner can never be demoted or revoked
     • the platform can never be left without a super administrator
     • every change needs a stated reason and is written to the audit trail

   Nothing here decides anything. The buttons mirror what the server will accept;
   if the server refuses, its words are shown to the operator unchanged.
   ========================================================================== */

import { qs, qsa, esc, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, date, initials } from "../../../lib/format.js";
import { state } from "../../../lib/store.js";
import { adminApi } from "../api.js";
import { openModal, formDialog, confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { emptyState, skeletonView, statusBadge } from "../../dashboard/components.js";

const TABS = [
  { id: "all", label: "All accounts" },
  { id: "superadmin", label: "Super administrators" },
  { id: "admin", label: "Administrators" },
  { id: "user", label: "Customers" }
];

let users = [];
let audit = [];
let tab = "all";
let search = "";
let myRole = null;

export default async function render(root, ctx = {}) {
  root.innerHTML = skeletonView(3);
  myRole = ctx.state?.role || state.adminRole || null;

  try {
    const [directory, log] = await Promise.all([
      adminApi.directory(),
      adminApi.audit({ limit: 40 }).catch(() => ({ entries: [] }))
    ]);
    users = directory.users || [];
    audit = log.entries || [];
    myRole = myRole || users.find((row) => row.email === state.user?.email)?.role || "admin";
  } catch (error) {
    /* Three different outages looked identical here, and the old copy guessed
       "migration 0009" for all of them — wrong when the function is simply an
       older build that does not implement the action yet. Name the real cause
       and the exact command that fixes it. */
    const code = String(error.code || "");
    const message = String(error.message || "");
    const isStaleFunction = code === "unknown_action" || /unknown admin action/i.test(message);
    const isMissingFunction = code === "functions_unavailable" || code === "not_found" || /not deployed|unreachable/i.test(message);
    const isMissingSchema = /does not exist|admin_directory|schema cache/i.test(message + " " + (error.hint || ""));

    const remedy = isStaleFunction
      ? {
          title: "The deployed admin function is out of date",
          body: "This console is newer than the admin Edge Function running on your project, so the action it asked for does not exist yet.",
          action: "Deploy it: <code>node scripts/deploy-functions.mjs admin</code> — then reload this page."
        }
      : isMissingFunction
        ? {
            title: "The admin function is not deployed",
            body: "The console needs the admin Edge Function, and this project has no deployed copy answering.",
            action: "Deploy it: <code>node scripts/deploy-functions.mjs admin</code>."
          }
        : isMissingSchema
          ? {
              title: "The database objects are missing",
              body: "The admin function is running but the tables and functions it reads are not in this database yet.",
              action: "Apply migrations 0006 → 0009: <code>node scripts/apply-migrations.mjs</code>."
            }
          : {
              title: "The account directory could not be read",
              body: message || "The request failed.",
              action: error.hint || "Reload the page. If this repeats, check the admin function logs in Supabase."
            };

    root.innerHTML = `<div class="admin-head"><div><h1>Access</h1></div></div>
      <div class="admin-card"><div class="admin-card-body">
        <div class="admin-card-title">${esc(remedy.title)}</div>
        <p class="muted" style="margin-top:8px">${esc(remedy.body)}</p>
        <p class="muted" style="margin-top:8px">${remedy.action.replace(/<code>(.*?)<\/code>/g, "<code>$1</code>")}</p>
        <p class="muted" style="margin-top:8px;font-size:var(--fs-xs)">Server said: ${esc(message || code)}</p>
      </div></div>`;
    return;
  }

  paint(root);
}

function visible() {
  const term = search.trim().toLowerCase();
  return users.filter((row) => {
    if (tab !== "all" && row.role !== tab) return false;
    if (!term) return true;
    return [row.email, row.full_name].some((value) => String(value ?? "").toLowerCase().includes(term));
  });
}

function roleBadge(role) {
  if (role === "superadmin") return `<span class="badge badge-brand">Super administrator</span>`;
  if (role === "admin") return `<span class="badge badge-ok">Administrator</span>`;
  return `<span class="badge badge-neutral">Customer</span>`;
}

function paint(root) {
  const counts = {
    all: users.length,
    superadmin: users.filter((r) => r.role === "superadmin").length,
    admin: users.filter((r) => r.role === "admin").length,
    user: users.filter((r) => r.role === "user").length
  };
  const isSuper = myRole === "superadmin" || myRole === "owner";

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Access</h1>
        <p>Every account on Shinzora, with the role it holds. Role changes are enforced by the database, require a reason, and are written to the audit trail.</p>
      </div>
    </div>

    ${isSuper ? "" : `<div class="admin-note" style="margin-bottom:var(--s-4)">
      ${icon("shield-alert", { size: 15 })}
      <span>You are signed in as an administrator. Only a super administrator can change a role; the buttons are hidden and the server would refuse them anyway.</span>
    </div>`}

    <div class="admin-filters">
      <div class="admin-tabs" id="access-tabs">
        ${TABS.map(
          (item) => `<button data-tab="${item.id}" class="${item.id === tab ? "is-active" : ""}">${esc(item.label)}
            <span class="tab-count">${counts[item.id]}</span></button>`
        ).join("")}
      </div>
      <label class="admin-search">
        ${icon("search", { size: 14 })}
        <input class="input" id="access-search" type="search" placeholder="Search name or email" value="${esc(search)}" />
      </label>
    </div>

    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">${esc(TABS.find((t) => t.id === tab)?.label || "Accounts")}</div>
          <div class="admin-card-sub" id="access-count">${visible().length} of ${users.length}</div>
        </div>
      </div>
      <div id="access-table"></div>
    </div>

    <div class="admin-card" style="margin-top:var(--s-4)">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Audit trail</div>
          <div class="admin-card-sub">Every privileged change, newest first. Read-only — no client can edit or delete these rows.</div>
        </div>
        <button class="btn btn-secondary btn-sm" id="audit-refresh">${icon("refresh-cw", { size: 14 })}Refresh</button>
      </div>
      <div id="audit-table"></div>
    </div>`;

  paintTable();
  paintAudit();
  bind(root);
}

function paintTable() {
  const rows = visible();
  qs("#access-count").textContent = `${rows.length} of ${users.length}`;
  safeSet("#access-table", rows.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Account</th><th>Role</th><th>Plan</th><th>AI credits</th><th>Projects</th><th>Joined</th><th></th></tr></thead>
        <tbody>${rows
          .map((row) => {
            const isMe = row.email === state.user?.email;
            const actions = [];
            if (myRole === "superadmin" && !row.protected) {
              if (row.role !== "superadmin") actions.push(`<button class="btn btn-ghost btn-sm" data-role="superadmin" data-user="${esc(row.user_id)}">Make super administrator</button>`);
              if (row.role === "user") actions.push(`<button class="btn btn-secondary btn-sm" data-role="admin" data-user="${esc(row.user_id)}">Make administrator</button>`);
              if (row.role !== "user" && !isMe) actions.push(`<button class="btn btn-ghost btn-sm" data-role="none" data-user="${esc(row.user_id)}">Revoke access</button>`);
            }
            if (row.protected) actions.push(`<span class="badge badge-neutral" title="The recovery account cannot be demoted">${icon("lock", { size: 11 })} Protected</span>`);
            if (myRole === "superadmin" && row.plan) actions.push(`<button class="btn btn-ghost btn-sm" data-credits="${esc(row.user_id)}">Reset AI credits</button>`);

            return `<tr>
              <td><div class="customer-cell"><span class="avatar">${esc(initials(row.full_name || row.email))}</span>
                <div><strong>${esc(row.full_name || "—")}${isMe ? ' <span class="badge badge-neutral">you</span>' : ""}</strong>
                <span>${esc(row.email || "")}</span></div></div></td>
              <td>${roleBadge(row.role)}</td>
              <td><span class="badge badge-${row.plan === "enterprise" ? "brand" : row.plan === "pro" ? "ok" : "neutral"}">${esc(row.plan)}</span></td>
              <td>${Number(row.ai_credits_used)} / ${Number(row.ai_credits_limit)}</td>
              <td>${Number(row.projects || 0)}</td>
              <td class="dim">${esc(date(row.joined_at))}</td>
              <td class="cell-actions">${actions.join("") || `<span class="dim">—</span>`}</td>
            </tr>`;
          })
          .join("")}</tbody></table></div>`
    : emptyState({
        icon: "users",
        title: "No accounts match",
        desc: search ? "Try a different search." : "Nobody holds this role yet."
      }));
}

function paintAudit() {
  safeSet("#audit-table", audit.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>${audit
          .map(
            (entry) => `<tr>
              <td class="dim" title="${esc(entry.created_at)}">${esc(timeAgo(entry.created_at))}</td>
              <td><span class="badge badge-neutral mono" style="font-size:var(--fs-2xs)">${esc(entry.action)}</span></td>
              <td class="mono" style="font-size:var(--fs-2xs)">${esc(
                String(entry.target_id || "").slice(0, 8)
              )}${entry.target_table ? ` <span class="dim">${esc(entry.target_table)}</span>` : ""}</td>
              <td>${esc(entry.reason || "—")}</td>
              <td class="dim">${esc(entry.actor_email || "system")}</td>
            </tr>`
          )
          .join("")}</tbody></table></div>`
    : `<div class="admin-empty">No privileged changes have been recorded yet.</div>`);
}

function bind(root) {
  qsa("[data-tab]", root).forEach((button) =>
    button.addEventListener("click", () => {
      tab = button.getAttribute("data-tab");
      qsa("[data-tab]", root).forEach((node) => node.classList.toggle("is-active", node === button));
      qs(".admin-card-title", root).textContent = TABS.find((t) => t.id === tab)?.label || "Accounts";
      paintTable();
    })
  );

  const searchBox = qs("#access-search", root);
  searchBox?.addEventListener("input", () => {
    search = searchBox.value;
    paintTable();
  });

  delegate(qs("#access-table"), "click", "[data-role]", async (_event, node) => {
    const userId = node.getAttribute("data-user");
    const role = node.getAttribute("data-role");
    const account = users.find((row) => row.user_id === userId);
    await changeRole(account, role);
  });

  delegate(qs("#access-table"), "click", "[data-credits]", async (_event, node) => {
    const account = users.find((row) => row.user_id === node.getAttribute("data-credits"));
    await resetCredits(account);
  });

  qs("#audit-refresh", root)?.addEventListener("click", async () => {
    try {
      const log = await adminApi.audit({ limit: 40 });
      audit = log.entries || [];
      paintAudit();
    } catch (error) {
      toastError(error);
    }
  });
}

async function changeRole(account, role) {
  if (!account) return;
  const label =
    role === "none" ? "Revoke administrator access" : role === "superadmin" ? "Make super administrator" : "Make administrator";

  const values = await formDialog({
    title: `${label} — ${account.email || account.full_name}`,
    desc:
      role === "none"
        ? "The account keeps everything it owns. Only the administrative role is removed."
        : role === "superadmin"
          ? "A super administrator can change other roles and remove records. This is the highest level."
          : "An administrator can manage customers, subscriptions, payments, support and announcements.",
    fields: [
      {
        name: "reason",
        label: "Reason",
        type: "textarea",
        rows: 3,
        required: true,
        placeholder: "Recorded in the audit trail, e.g. “running support while A is away”"
      }
    ],
    submitLabel: label
  });
  if (!values) return;

  try {
    await adminApi.setRole({ userId: account.user_id, role, reason: values.reason });
    toast({ title: role === "none" ? "Access revoked" : "Role updated" }, { tone: "success" });
    await reload();
  } catch (error) {
    toastError(error);
  }
}

async function resetCredits(account) {
  if (!account) return;
  const confirmed = await confirmDialog({
    title: `Reset AI credits for ${account.email || account.full_name}?`,
    desc: `They have used ${Number(account.ai_credits_used)} of ${Number(account.ai_credits_limit)} this period. The counter returns to zero and the reset is recorded.`,
    confirmLabel: "Reset credits"
  });
  if (!confirmed) return;

  const values = await formDialog({
    title: "Reason for the reset",
    fields: [{ name: "reason", label: "Reason", type: "textarea", rows: 3, required: true }],
    submitLabel: "Reset credits"
  });
  if (!values) return;

  try {
    await adminApi.resetCredits({ userId: account.user_id, reason: values.reason });
    toast({ title: "AI credits reset" }, { tone: "success" });
    await reload();
  } catch (error) {
    toastError(error);
  }
}

async function reload() {
  const [directory, log] = await Promise.all([
    adminApi.directory(),
    adminApi.audit({ limit: 40 }).catch(() => ({ entries: [] }))
  ]);
  users = directory.users || [];
  audit = log.entries || [];
  const root = qs("#admin-shell .admin-main") || document;
  paint(root);
}
