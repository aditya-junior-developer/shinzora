/* ==========================================================================
   Shinzora — Invitations
   --------------------------------------------------------------------------
   This screen is the missing half of the team-invite flow. Before it existed,
   `team_invite_user` wrote a row that nothing ever read: the invited person had
   no list of invitations and no way to accept one, so teams could never form.

   Invitations are matched to the email on the signed-in session, not to the
   user id, because the owner may invite someone who has not registered yet.
   The database decides that (`team_accept_invite` compares the JWT email), so
   this file only renders whatever comes back.
   ========================================================================== */

import { qs, delegate, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, avatar } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

let rows = [];
let busy = false;

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  let error = null;
  try {
    rows = (await rpc("team_my_invitations")) || [];
    rows = Array.isArray(rows) ? rows : [];
  } catch (failure) {
    error = failure;
  }
  paint(root, error);
}

function paint(root, error) {
  const head = pageHead({
    title: "Invitations",
    desc: "Businesses that asked you to join their team.",
    badge: rows.length ? `<span class="badge badge-violet">${rows.length} waiting</span>` : ""
  });

  if (error) {
    root.innerHTML = `${head}<div class="card"><div class="card-body">
        <p class="muted">${esc(error.message || "Invitations could not be loaded.")}</p>
      </div></div>`;
    return;
  }

  if (!rows.length) {
    root.innerHTML = `${head}${emptyState({
      icon: "inbox",
      title: "No invitations waiting",
      desc: "When a business owner invites the email you signed in with, it appears here and you can accept or decline it.",
      action: `<a class="btn btn-secondary btn-sm" href="/app/?view=marketplace">${icon("package", { size: 14 })}Browse projects</a>`
    })}`;
    return;
  }

  root.innerHTML = `${head}
    <div class="inv-list">
      ${rows
        .map(
          (row) => `<article class="card inv-card" data-invite="${esc(row.inviteId)}">
            <div class="card-body inv-body">
              <div class="inv-ident">
                ${avatar(row.businessName, null, "lg")}
                <div>
                  <div class="inv-name">${esc(row.businessName || "A business")}</div>
                  <div class="inv-meta">
                    ${esc(row.inviterName || "The owner")} invited you to join as
                    <strong>${esc(row.memberType || "teammate")}</strong>
                    · <span title="${esc(row.createdAt || "")}">${esc(timeAgo(row.createdAt))}</span>
                  </div>
                  <div class="inv-email">${icon("mail", { size: 12 })} Invited address: ${esc(row.email || "")}</div>
                </div>
              </div>
              <div class="inv-actions">
                <button class="btn btn-primary btn-sm" data-accept="${esc(row.inviteId)}">${icon("check", { size: 14 })}Accept</button>
                <button class="btn btn-ghost btn-sm" data-decline="${esc(row.inviteId)}">Decline</button>
              </div>
            </div>
          </article>`
        )
        .join("")}
    </div>
    <p class="inv-foot muted">
      Invitations are tied to the email address you signed in with. If you were invited
      at a different address, sign in with that one to see it.
    </p>`;

  bind(root);
}

function bind(root) {
  delegate(root, "click", "[data-accept]", async (_event, button) => {
    if (busy) return;
    busy = true;
    const id = button.dataset.accept;
    const card = button.closest("[data-invite]");
    button.disabled = true;
    try {
      const result = await rpc("team_accept_invite", { p_invite: id });
      rows = rows.filter((row) => row.inviteId !== id);
      card?.remove();
      toast({ title: `Joined ${result?.businessName || "the team"}`, message: "You can now open Team chat and work inside their workspace." });
      window.dispatchEvent(new CustomEvent("shinzora:team-changed"));
      if (!rows.length) paint(root, null);
    } catch (error) {
      button.disabled = false;
      toastError(error);
    } finally {
      busy = false;
    }
  });

  delegate(root, "click", "[data-decline]", async (_event, button) => {
    if (busy) return;
    busy = true;
    const id = button.dataset.decline;
    const card = button.closest("[data-invite]");
    button.disabled = true;
    try {
      await rpc("team_decline_invite", { p_invite: id });
      rows = rows.filter((row) => row.inviteId !== id);
      card?.remove();
      toast({ title: "Invitation declined", message: "The owner will not be able to use this invitation again." }, { tone: "warning" });
      if (!rows.length) paint(root, null);
    } catch (error) {
      button.disabled = false;
      toastError(error);
    } finally {
      busy = false;
    }
  });
}
