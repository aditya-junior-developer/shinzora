/* ==========================================================================
   Shinzora — Team
   --------------------------------------------------------------------------
   One business at a time: its members, its open invitations, and a search box
   that looks people up by @handle, name, or email.

   The invite flow is pick-from-results, not blind-email-entry. Search returns
   real accounts, so the owner clicks a person rather than retyping an address.
   If nothing matches — because the person has not registered — the fallback is
   a pre-filled email so the invitation still exists in the database and can be
   accepted later by that address.

   The business name and logo are read from `businesses` and never copied, so a
   rename or new logo shows up on every team surface at once.
   ========================================================================== */

import { qs, delegate, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, avatar } from "../components.js";
import { presenceDot, presenceLabel, presenceState } from "../../../ui/presence.js";
import { toast, toastError } from "../../../ui/toast.js";

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function makeGmailDraft(email, businessName) {
  const subject = `Invitation to join ${businessName} on Shinzora`;
  const body = `Hi,\n\nI invited you to collaborate with ${businessName} on Shinzora. Sign up or sign in with this email address, then open Invitations to accept.\n\nThanks!`;
  return `https://mail.google.com/mail/mu/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

let businesses = [];
let activeId = null;
let members = [];
let pending = [];
let results = [];
let searchedFor = "";
let loadError = null;

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  try {
    businesses = (await rpc("team_accessible_businesses")) || [];
    businesses = Array.isArray(businesses) ? businesses : [];
  } catch (error) {
    loadError = error;
    businesses = [];
  }
  if (!businesses.length) {
    root.innerHTML = `${pageHead({ title: "Team", desc: "The people who work in your business workspace." })}
      ${loadError
        ? `<div class="card"><div class="card-body"><p class="muted">${esc(loadError.message)}</p></div></div>`
        : emptyState({ icon: "users", title: "No business yet", desc: "Finish business setup to build a team.", action: `<a class="btn btn-primary btn-sm" href="#/app/?view=settings">Open settings</a>` })}`;
    return;
  }
  if (!activeId || !businesses.some((b) => b.id === activeId)) activeId = businesses[0].id;
  paint(root);
  await loadTeam(root);
}

const current = () => businesses.find((b) => b.id === activeId) || businesses[0] || {};
const isOwner = () => current().role === "owner";

function paint(root) {
  const business = current();
  root.innerHTML = `
    ${pageHead({
      title: "Team",
      desc: "Members, invitations and access for this business.",
      actions: businesses.length > 1
        ? `<select class="input input-sm" id="team-business" aria-label="Business">
             ${businesses.map((b) => `<option value="${esc(b.id)}" ${b.id === activeId ? "selected" : ""}>${esc(b.name || "Business")}</option>`).join("")}
           </select>`
        : ""
    })}
    <div class="team-head card">
      <div class="card-body team-head-body">
        ${avatar(business.name, undefined, "lg", business.logo_url || business.logoUrl)}
        <div>
          <div class="team-head-name">${esc(business.name || "Business")}</div>
          <div class="mk-note"><span id="team-count">${members.length} ${members.length === 1 ? "member" : "members"}</span> · you are the ${esc(business.role || "member")}</div>
        </div>
      </div>
    </div>

    ${
      isOwner()
        ? `<section class="card team-invite">
            <div class="card-body">
              <h3 class="mk-subhead">${icon("user-plus", { size: 15 })} Add someone</h3>
              <p class="mk-note">Search by @username, name, or exact email. You pick from real accounts — no retyping addresses.</p>
              <form class="ft-search" id="team-search-form" role="search">
                ${icon("search", { size: 15 })}
                <input id="team-search" type="search" autocomplete="off" placeholder="Search people…" aria-label="Search people to invite" />
              </form>
              <div id="team-notice" class="team-results"></div>
              <div id="team-results" class="team-results"></div>
            </div>
          </section>

          <section class="card">
            <div class="card-body">
              <h3 class="mk-subhead">Invitations sent</h3>
              <div id="team-pending"></div>
            </div>
          </section>`
        : ""
    }

    <section class="card">
      <div class="card-body">
        <h3 class="mk-subhead">Members</h3>
        <div id="team-members"></div>
      </div>
    </section>`;

  if (businesses.length > 1) {
    on(qs("#team-business", root), "change", async (event) => {
      activeId = event.target.value;
      results = [];
      await loadTeam(root);
      paint(root);
    });
  }

  const searchField = qs("#team-search", root);
  if (searchField) {
    on(qs("#team-search-form", root), "submit", (event) => {
      event.preventDefault();
      runSearch(root, searchField.value);
    });
    on(searchField, "input", debounce(() => runSearch(root, searchField.value), 320));
  }

  delegate(root, "click", "[data-invite-user]", (_event, button) => invite(root, button.dataset.inviteUser, button));
  delegate(root, "click", "[data-invite-email]", (_event, button) => inviteEmail(root, button.dataset.inviteEmail, button));
  delegate(root, "click", "[data-revoke]", (_event, button) => revoke(root, button.dataset.revoke, button));
  delegate(root, "click", "[data-remove]", (_event, button) => removeMember(root, button.dataset.remove, button));

  /* Message a teammate: the same personal conversation the Messages screen
     opens, reached from the row of the person you are looking at. It creates or
     reuses the thread server-side, then hands over to Messages with it open. */
  delegate(root, "click", "[data-team-message]", async (_event, button) => {
    const username = button.dataset.teamMessage;
    if (!username) return;
    button.disabled = true;
    try {
      const result = await sb.rpc("dm_start", { p_username: username });
      if (result.error) throw result.error;
      location.href = `/app/?view=messages&c=${encodeURIComponent(result.data.conversationId)}`;
    } catch (error) {
      button.disabled = false;
      toastError(normalizeError(error));
    }
  });
}

async function loadTeam(root) {
  const [memberRes, pendingRes] = await Promise.allSettled([
    rpc("team_members_list", { p_business: activeId }),
    isOwner() ? rpc("team_pending_invites", { p_business: activeId }) : Promise.resolve([])
  ]);
  members = memberRes.status === "fulfilled" && Array.isArray(memberRes.value) ? memberRes.value : [];
  pending = pendingRes.status === "fulfilled" && Array.isArray(pendingRes.value) ? pendingRes.value : [];
  paintMembers(root);
  paintPending(root);
}

function paintMembers(root) {
  const box = qs("#team-members", root);
  if (!box) return;
  /* The head is painted before the list arrives, so it used to say "0 members"
     next to three of them. It is updated here, where the number is known. */
  const count = qs("#team-count", root);
  if (count) count.textContent = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  if (!members.length) {
    box.innerHTML = `<p class="muted">No members yet. Invite the first person above.</p>`;
    return;
  }
  box.innerHTML = `<ul class="team-list">${members
    .map(
      (member) => `<li class="team-row">
        <span class="team-avatar-wrap">
          ${avatar(member.fullName, member.email, "sm", member.avatarUrl)}
          ${presenceDot(member.lastSeenAt, { size: 9 })}
        </span>
        <div class="team-row-main">
          <div class="team-row-name">${esc(member.fullName || "Member")}${member.isOwner ? ` <span class="badge badge-neutral">Owner</span>` : ""}</div>
          <div class="mk-note">${member.username ? `@${esc(member.username)} · ` : ""}${esc(member.memberType || "member")}${member.joinedAt ? ` · joined ${esc(timeAgo(member.joinedAt))}` : ""} · ${esc(presenceLabel(presenceState(member.lastSeenAt)))}</div>
        </div>
        <div class="team-row-actions">
          ${member.username ? `<button class="btn btn-secondary btn-sm" data-team-message="${esc(member.username)}">${icon("message-square", { size: 13 })}Message</button>` : ""}
          ${isOwner() && !member.isOwner
            ? `<button class="btn btn-ghost btn-sm" data-remove="${esc(member.userId)}">Remove</button>`
            : ""}
        </div>
      </li>`
    )
    .join("")}</ul>`;
}

function paintPending(root) {
  const box = qs("#team-pending", root);
  if (!box) return;
  if (!pending.length) {
    box.innerHTML = `<p class="muted">No invitations waiting.</p>`;
    return;
  }
  box.innerHTML = `<ul class="team-list">${pending
    .map(
      (invite) => `<li class="team-row">
        ${avatar(invite.fullName || invite.email, invite.email, "sm")}
        <div class="team-row-main">
          <div class="team-row-name">${esc(invite.fullName || invite.email)}</div>
          <div class="mk-note">${esc(invite.email)} · ${esc(invite.memberType)} · sent ${esc(timeAgo(invite.createdAt))}${invite.userExists ? "" : " · not registered yet"}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-revoke="${esc(invite.inviteId)}">Cancel</button>
      </li>`
    )
    .join("")}</ul>`;
}

async function runSearch(root, value) {
  const q = String(value || "").trim();
  searchedFor = q;
  if (q.length < 2) {
    results = [];
    paintResults(root);
    return;
  }
  try {
    results = (await rpc("team_search_people", { p_business: activeId, p_query: q })) || [];
    results = Array.isArray(results) ? results : [];
  } catch (error) {
    results = [];
    toastError(error);
  }
  paintResults(root);
}

function paintResults(root) {
  const box = qs("#team-results", root);
  if (!box) return;
  if (!searchedFor || searchedFor.length < 2) {
    box.innerHTML = "";
    return;
  }
  if (results.length) {
    box.innerHTML = `<ul class="team-list">${results
      .map(
        (person) => `<li class="team-row">
          ${avatar(person.fullName, person.email, "sm", person.avatarUrl)}
          <div class="team-row-main">
            <div class="team-row-name">${esc(person.fullName || "Member")}</div>
            <div class="mk-note">${person.username ? `@${esc(person.username)} · ` : ""}${esc(person.email || "")}${person.accountType ? ` · ${esc(person.accountType)}` : ""}</div>
          </div>
          ${
            person.isMember
              ? `<span class="badge badge-neutral">On team</span>`
              : person.hasPendingInvite
                ? `<span class="badge badge-neutral">Invited</span>`
                : `<button class="btn btn-primary btn-sm" data-invite-user="${esc(person.userId)}">Invite</button>`
          }
        </li>`
      )
      .join("")}</ul>`;
    return;
  }
  // Nothing matched. If it looks like an address, still let the owner send it.
  const looksLikeEmail = EMAIL_RE.test(searchedFor);
  box.innerHTML = `<div class="team-fallback">
      <p class="muted">No account matches “${esc(searchedFor)}”.</p>
      ${
        looksLikeEmail
          ? `<button class="btn btn-secondary btn-sm" data-invite-email="${esc(searchedFor)}">${icon("mail", { size: 14 })}Invite ${esc(searchedFor)} anyway</button>`
          : `<p class="mk-note">If they have not signed up, type their full email address and we will create the invitation. They accept it after registering.</p>`
      }
    </div>`;
}

async function invite(root, userId, button) {
  const person = results.find((r) => r.userId === userId);
  if (!person?.email) return toastError(new Error("That person has no email on file yet."));
  await doInvite(root, person.email, button);
}

async function inviteEmail(root, email, button) {
  await doInvite(root, email, button);
}

async function doInvite(root, email, button) {
  button.disabled = true;
  try {
    const result = await rpc("team_invite_user", { p_business: activeId, p_email: email, p_member_type: "agent" });
    if (result?.alreadyMember) {
      toast({ title: "Already on the team", message: "That person is already a member." }, { tone: "warning" });
    } else {
      const link = makeGmailDraft(email, current().name || "our business");
      toast({ title: "Invitation created", message: "It now appears in their Invitations screen." });
      const notice = qs("#team-notice", root);
      if (notice) {
        notice.innerHTML = `<div class="team-fallback">Invitation saved for ${esc(email)}.
             <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open Gmail to tell them</a>.
             They accept it from Invitations after signing in with that address.</div>`;
      }
    }
    await loadTeam(root);
    await runSearch(root, searchedFor);
  } catch (error) {
    toastError(error);
  } finally {
    button.disabled = false;
  }
}

async function revoke(root, inviteId, button) {
  button.disabled = true;
  try {
    await rpc("team_revoke_member", { p_business: activeId, p_invite: inviteId });
    toast({ title: "Invitation cancelled" }, { tone: "warning" });
    await loadTeam(root);
  } catch (error) {
    button.disabled = false;
    toastError(error);
  }
}

async function removeMember(root, userId, button) {
  button.disabled = true;
  try {
    await rpc("team_remove_member", { p_business: activeId, p_user: userId });
    toast({ title: "Member removed" }, { tone: "warning" });
    await loadTeam(root);
  } catch (error) {
    button.disabled = false;
    toastError(error);
  }
}
