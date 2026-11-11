/* ==========================================================================
   Shinzora — Freelancer dashboard
   --------------------------------------------------------------------------
   The front door for an agent account. An owner lands on Overview, which is
   about a business; this is about a person and the work they are chasing.

   Everything here is derived from rows that already exist — no invented
   metrics. Three calls, made in parallel:
     marketplace_my_workspace  their profile, pitches and contracts
     marketplace_browse_jobs   the open board, for "what is out there"
     team_my_invitations       anything waiting to be answered

   The "finish your profile" list is ordered by what actually blocks work:
   an unpublished profile cannot be found, and a pitch needs a rate.
   ========================================================================== */

import { esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { pageHead, statCard, emptyState, skeletonView, avatar } from "../components.js";
import { toastError } from "../../../ui/toast.js";

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

const amount = (value, currency = "INR") => {
  if (value === null || value === undefined || value === "") return null;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value));
  } catch {
    return `${Number(value).toLocaleString("en-IN")} ${currency}`;
  }
};

let workspace = null;
let board = [];
let invitations = [];
let portfolioCount = 0;
let loadError = null;

export default async function render(root) {
  root.innerHTML = skeletonView(4);
  const userId = state.user?.id;
  const [wsRes, boardRes, invRes, portfolioRes] = await Promise.allSettled([
    rpc("marketplace_my_workspace"),
    rpc("marketplace_browse_jobs", { p_search: null, p_skill: null, p_limit: 50 }),
    rpc("team_my_invitations"),
    /* Portfolio items are their own table, so the workspace payload cannot
       tell us whether this person has any — count them directly. The RLS
       policy allows a signed-in user to read portfolio rows. */
    userId
      ? sb.from("freelancer_portfolio_items").select("id").eq("user_id", userId)
      : Promise.resolve({ data: [] })
  ]);

  workspace = wsRes.status === "fulfilled" ? wsRes.value : null;
  board = boardRes.status === "fulfilled" && Array.isArray(boardRes.value) ? boardRes.value : [];
  invitations = invRes.status === "fulfilled" && Array.isArray(invRes.value) ? invRes.value : [];
  portfolioCount =
    portfolioRes.status === "fulfilled" && Array.isArray(portfolioRes.value?.data)
      ? portfolioRes.value.data.length
      : 0;
  loadError = wsRes.status === "rejected" ? wsRes.reason : null;

  if (loadError) {
    root.innerHTML = `${pageHead({ title: "Dashboard" })}<div class="card"><div class="card-body">
      <p class="muted">${esc(loadError.message || "Your dashboard could not be loaded.")}</p></div></div>`;
    return;
  }
  paint(root);
}

function paint(root) {
  const profile = workspace?.profile || {};
  const handle = workspace?.username ? `@${workspace.username}` : "";
  const name = state.profile?.full_name || workspace?.username || "there";

  const pitches = Array.isArray(workspace?.myProposals) ? workspace.myProposals : [];
  const contracts = Array.isArray(workspace?.contracts) ? workspace.contracts : [];
  const active = contracts.filter((c) => c.status === "active");
  const completed = contracts.filter((c) => c.status === "completed");
  const openPitches = pitches.filter((p) => p.status === "submitted");

  const todo = profileTodo(profile);
  const fresh = board.slice(0, 4);

  root.innerHTML = `
    ${pageHead({
      title: `Welcome back, ${name}`,
      desc: "Your work, your pitches and what is waiting on you.",
      badge: handle ? `<span class="mk-status mk-info">${esc(handle)}</span>` : "",
      actions: `<a class="btn btn-primary btn-sm" href="/app/?view=marketplace&tab=browse">${icon("search", { size: 14 })}Find projects</a>`
    })}

    <div class="stat-grid">
      ${statCard({ label: "Open projects", value: String(board.length), foot: "live on the board", iconName: "package" })}
      ${statCard({ label: "Pitches sent", value: String(openPitches.length), foot: `${pitches.length} total`, iconName: "send", href: "/app/?view=marketplace&tab=work" })}
      ${statCard({ label: "Active contracts", value: String(active.length), foot: `${completed.length} completed`, iconName: "briefcase", href: "/app/?view=marketplace&tab=work" })}
      ${statCard({ label: "Invitations", value: String(invitations.length), foot: invitations.length ? "waiting for an answer" : "none waiting", iconName: "inbox" })}
    </div>

    ${todo.length
      ? `<section class="card fl-todo">
          <div class="card-body">
            <h3 class="mk-subhead">${icon("circle-alert", { size: 15 })} Finish your profile</h3>
            <p class="mk-note">A complete profile is the difference between being found and not.</p>
            <ul class="fl-todo-list">
              ${todo.map((item) => `<li>
                <span class="fl-todo-mark">${icon(item.done ? "check" : "dot", { size: 13 })}</span>
                <span class="fl-todo-text ${item.done ? "is-done" : ""}">${esc(item.label)}</span>
                ${item.done ? "" : `<a class="mk-link" href="/app/?view=${esc(item.view)}">${esc(item.action)}</a>`}
              </li>`).join("")}
            </ul>
          </div>
        </section>`
      : ""}

    <div class="grid-main-side">
      <section class="card">
        <div class="card-body">
          <h3 class="mk-subhead">${icon("package", { size: 15 })} Newest projects</h3>
          ${fresh.length
            ? `<ul class="fl-project-list">${fresh.map((job) => `
                <li class="fl-project">
                  <div>
                    <div class="fl-project-title">${esc(job.title)}</div>
                    <div class="mk-note">${esc(job.businessName || "A business")}${job.createdAt ? ` · ${esc(timeAgo(job.createdAt))}` : ""}</div>
                    <div class="mk-chips">${(job.skills || []).slice(0, 4).map((s) => `<span class="mk-chip">${esc(s)}</span>`).join("")}</div>
                  </div>
                  <div class="fl-project-side">
                    <div class="fl-project-budget">${esc(amount(job.budgetMax || job.budgetMin, job.currency) || "Open")}</div>
                    <a class="btn btn-secondary btn-sm" href="/app/?view=marketplace&tab=browse">View</a>
                  </div>
                </li>`).join("")}</ul>`
            : emptyState({ icon: "package", title: "No open projects yet", desc: "When a business posts work, it appears here and on the board." })}
          <a class="btn btn-ghost btn-sm fl-more" href="/app/?view=marketplace&tab=browse">See all ${board.length} projects</a>
        </div>
      </section>

      <aside class="card">
        <div class="card-body">
          <h3 class="mk-subhead">${icon("activity", { size: 15 })} Your activity</h3>
          ${pitches.length || active.length
            ? `<ul class="fl-activity">
                ${openPitches.slice(0, 3).map((p) => `<li>
                  <span class="fl-dot fl-dot-info"></span>
                  <div><div class="fl-activity-title">Pitched on ${esc(p.jobTitle || "a project")}</div>
                  <div class="mk-note">${esc(p.status)} · ${esc(timeAgo(p.createdAt))}</div></div>
                </li>`).join("")}
                ${active.slice(0, 3).map((c) => `<li>
                  <span class="fl-dot fl-dot-ok"></span>
                  <div><div class="fl-activity-title">Working on ${esc(c.jobTitle || "a contract")}</div>
                  <div class="mk-note">with ${esc(c.counterparty || "the client")}</div></div>
                </li>`).join("")}
              </ul>`
            : `<p class="muted">Nothing yet. Pitch on a project and it shows up here.</p>`}
          <div class="fl-quick">
            <a class="btn btn-ghost btn-sm" href="/app/?view=portfolio">${icon("id-card", { size: 14 })}Edit profile</a>
            <a class="btn btn-ghost btn-sm" href="/app/?view=invitations">${icon("inbox", { size: 14 })}Invitations</a>
            <a class="btn btn-ghost btn-sm" href="/app/?view=marketplace&tab=work">${icon("send", { size: 14 })}My applications</a>
            <a class="btn btn-ghost btn-sm" href="/app/?view=find-team">${icon("users-round", { size: 14 })}Find team</a>
          </div>
        </div>
      </aside>
    </div>`;
}

/* Only unfinished items are rendered, so an empty array means "nothing to do".
   Ordered the way it costs work to leave undone. */
function profileTodo(profile) {
  const todos = [
    {
      label: "Publish your profile so businesses can find you",
      done: Boolean(profile.is_published),
      view: "portfolio",
      action: "Publish"
    },
    {
      label: "Add a headline — one line on what you do",
      done: Boolean(profile.headline && profile.headline.trim()),
      view: "portfolio",
      action: "Add"
    },
    {
      label: "Set expected pay",
      done: profile.expected_rate != null,
      view: "portfolio",
      action: "Set rate"
    },
    {
      label: "Add at least three skills",
      done: (profile.skills || []).length >= 3,
      view: "portfolio",
      action: "Add skills"
    },
    {
      label: "Add a portfolio item or CV",
      done: portfolioCount > 0 || Boolean(profile.resume_url),
      view: "portfolio",
      action: "Add"
    }
  ];
  const open = todos.filter((item) => !item.done);
  return open.length ? todos : [];
}
