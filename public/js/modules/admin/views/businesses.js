/* ==========================================================================
   Shinzora Admin · Businesses
   --------------------------------------------------------------------------
   Every registered business, its owner, its plan and its projects in one table,
   with two actions:

     Message            opens a conversation with the owner (Part 1 messaging)
     Make administrator promotes the owner — on the same account

   Promotion calls public.admin_promote_business, which calls the audited
   public.set_admin_role. The database refuses the call unless the caller is the
   protected super administrator, and it never creates a second account: the
   business, its projects, payments and documents stay exactly where they are.

   Ordinary administrators see the same table and may message anyone, but the
   promote button is not rendered for them and the function would refuse it
   anyway — administrators cannot grant or take away authority.
   ========================================================================== */

import { qs, esc, delegate, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { date } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { skeletonView, emptyState, statusBadge } from "../../dashboard/components.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { focusConversation } from "../../messaging/chat.js";

let rows = [];
let search = "";

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

export default async function render(root, ctx = {}) {
  root.innerHTML = skeletonView(3);
  const myRole = ctx.state?.role || null;
  const isSuper = myRole === "superadmin";

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Businesses</h1>
        <p>
          Every business on the platform, with the account that owns it. A business that is made an administrator keeps
          its account, its projects and its records — the access is added, nothing is copied or replaced.
        </p>
      </div>
      <div class="admin-filters">
        <label class="admin-search">
          ${icon("search", { size: 14 })}
          <input type="search" id="biz-search" placeholder="Search businesses or owners" value="${esc(search)}" />
        </label>
      </div>
    </div>

    <div class="admin-card">
      <div class="admin-card-head">
        <div>
          <div class="admin-card-title">Registered businesses</div>
          <div class="admin-card-sub" id="biz-count">Loading…</div>
        </div>
      </div>
      <div class="admin-card-body" id="biz-body"><div class="admin-empty">Loading…</div></div>
    </div>

    ${isSuper ? "" : `<div class="admin-note" style="margin-top:var(--s-4)">
      ${icon("shield-check", { size: 14 })}
      <span>Only the super administrator can grant or remove administrator access. You can read every business and
      start a conversation with its owner.</span>
    </div>`}`;

  const body = qs("#biz-body", root);

  function paint() {
    const needle = search.toLowerCase();
    const visible = rows.filter(
      (row) =>
        !needle ||
        String(row.name || "").toLowerCase().includes(needle) ||
        String(row.ownerEmail || "").toLowerCase().includes(needle) ||
        String(row.ownerName || "").toLowerCase().includes(needle)
    );
    safeSet("#biz-count", `${visible.length} of ${rows.length}`, root);

    if (!visible.length) {
      body.innerHTML = emptyState({
        icon: "building-2",
        title: rows.length ? "No business matches that search" : "No businesses yet",
        desc: rows.length
          ? "Clear the search to see every registered business."
          : "A business appears here as soon as an account finishes onboarding."
      });
      return;
    }

    body.innerHTML = `<div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Business</th><th>Owner</th><th>Plan</th><th>Status</th><th>Projects</th><th>Since</th><th>Access</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${visible
            .map((row) => {
              const admin = row.adminRole;
              const accessLabel = admin === "superadmin" ? "Super administrator" : admin === "admin" ? "Administrator" : "Business";
              const canPromote = isSuper && !admin;
              return `<tr>
                <td>
                  <div class="cell-strong">${esc(row.name || "Untitled business")}</div>
                  ${row.subdomain ? `<div class="cell-sub">${esc(row.subdomain)}.shinzora.app</div>` : ""}
                </td>
                <td>
                  <div class="cell-strong">${esc(row.ownerName || "—")}</div>
                  <div class="cell-sub">${esc(row.ownerEmail || "")}</div>
                </td>
                <td>${esc(String(row.plan || "free"))}</td>
                <td>${row.status ? statusBadge(row.status) : "<span class=\"cell-sub\">—</span>"}</td>
                <td>${esc(String(row.projects ?? 0))}</td>
                <td>${esc(row.createdAt ? date(row.createdAt) : "—")}</td>
                <td><span class="badge ${admin ? "badge-ok" : "badge-neutral"}">${esc(accessLabel)}</span></td>
                <td class="cell-actions">
                  <button class="btn btn-ghost btn-sm" type="button" data-message="${esc(row.ownerId || "")}">
                    ${icon("message-square", { size: 13 })}Message
                  </button>
                  ${
                    canPromote
                      ? `<button class="btn btn-secondary btn-sm" type="button" data-promote="${esc(row.businessId)}">
                          ${icon("shield-check", { size: 13 })}Make administrator
                        </button>`
                      : ""
                  }
                </td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
  }

  try {
    rows = (await rpc("admin_businesses", { p_search: null })) || [];
    paint();
  } catch (error) {
    body.innerHTML = `<div class="admin-empty">
      <div class="admin-card-title">The business list could not be read</div>
      <p>${esc(error.message || "The request failed.")}</p>
      <p class="cell-sub">${esc(error.hint || "Reload the page. If this repeats, check the admin function logs in Supabase.")}</p>
    </div>`;
  }

  delegate(qs("#biz-search", root), "input", (event) => {
    search = event.target.value.trim();
    paint();
  });

  delegate(body, "click", "[data-message]", async (_event, node) => {
    const ownerId = node.getAttribute("data-message");
    if (!ownerId) return toast({ title: "That business has no owner account" }, { tone: "warning" });
    node.disabled = true;
    try {
      const result = await rpc("messaging_start", { p_participants: [ownerId], p_title: null });
      focusConversation(result.conversationId);
      const { navigate } = await import("../shell.js");
      navigate("chat");
    } catch (error) {
      toastError(error);
    } finally {
      node.disabled = false;
    }
  });

  delegate(body, "click", "[data-promote]", async (_event, node) => {
    const businessId = node.getAttribute("data-promote");
    const row = rows.find((item) => item.businessId === businessId);
    const ok = await confirmDialog({
      title: "Make this business an administrator?",
      desc: `${row?.ownerName || "The owner"} keeps the same account and all of its data. It gains access to the admin console: it can see every business, every account and every conversation, but it cannot delete anyone, change anyone's role or read the audit trail's protected records. Only you can change roles.`,
      confirmLabel: "Make administrator"
    });
    if (!ok) return;

    const values = await formDialog({
      title: "Reason",
      desc: "Recorded in the audit trail next to the change.",
      fields: [{ name: "note", label: "Why is this account being promoted?", type: "textarea", rows: 2, required: true }],
      submitLabel: "Promote"
    });
    if (!values) return;

    node.disabled = true;
    try {
      const response = await rpc("admin_promote_business", { p_business: businessId, p_note: values.note });
      toast(
        {
          title: response.changed ? "Administrator access granted" : "Already an administrator",
          message: response.message || ""
        },
        { tone: "success" }
      );
      rows = (await rpc("admin_businesses", { p_search: null })) || [];
      paint();
    } catch (error) {
      toastError(error);
    } finally {
      node.disabled = false;
    }
  });
}
