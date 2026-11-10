/* ==========================================================================
   Shinzora — Marketplace
   --------------------------------------------------------------------------
   Two kinds of account use this screen, and they mostly want different things:

     owner   posts a project with its requirements and screening questions,
             reads the pitches that come back, hires one
     agent   browses open projects and businesses, builds a public profile,
             pitches, then runs the contract to a review

   Both tabs are always present. Rather than hide half the product from each
   side, the view opens on the tab that account type is most likely to want and
   leaves the rest one click away.

   Every mutation is an RPC. The database re-checks ownership, so this file
   never decides who may accept a pitch — it only reflects the answer.
   ========================================================================== */

import { qs, delegate, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";

const TABS = [
  { id: "browse", label: "Projects" },
  { id: "businesses", label: "Businesses" },
  { id: "hire", label: "My projects" },
  { id: "work", label: "My work" },
  { id: "profile", label: "My profile" }
];

let tab = null;
let workspace = null;
let board = [];
let businesses = [];
let people = [];
let found = null;

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

/* Prices are stored as major units (numeric(12,2)), unlike `money()` which
   takes minor units. Formatting them with money() would show ₹18,500 as ₹185. */
const amount = (value, currency = "INR") => {
  if (value === null || value === undefined || value === "") return "Not stated";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency, maximumFractionDigits: 0
    }).format(Number(value));
  } catch {
    return `${Number(value).toLocaleString("en-IN")} ${currency}`;
  }
};

const chip = (label) => `<span class="mk-chip">${esc(label)}</span>`;

const tone = (status) => {
  const map = {
    open: "positive", submitted: "info", accepted: "positive",
    rejected: "muted", withdrawn: "muted", active: "info",
    completed: "positive", cancelled: "muted", filled: "positive"
  };
  return map[status] || "muted";
};

const isAgent = () => workspace?.accountType === "agent";

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  await load();
  if (!tab) tab = isAgent() ? "browse" : "hire";
  paint(root);
}

async function load() {
  workspace = await rpc("marketplace_my_workspace");
  board = await rpc("marketplace_browse_jobs", { p_search: null, p_skill: null, p_limit: 50 });
  businesses = await rpc("marketplace_list_businesses", { p_search: null, p_limit: 50 });
  people = await rpc("marketplace_list_freelancers", { p_skill: null, p_limit: 50 });
}

function paint(root) {
  const profile = workspace?.profile;
  const handle = workspace?.username ? `@${workspace.username}` : "";

  root.innerHTML = `
    ${pageHead({
      title: "Marketplace",
      desc: isAgent()
        ? "Find work, pitch on it, and run the contract end to end."
        : "Post projects, read the pitches, and run the contract end to end.",
      badge: handle ? `<span class="mk-status mk-info">${esc(handle)}</span>` : "",
      actions: `<button class="btn btn-ghost btn-sm" data-mk="refresh">${icon("refresh-cw", { size: 15 })} Refresh</button>`
    })}
    <div class="mk-tabs" role="tablist">
      ${TABS.map(
        (item) =>
          `<button class="mk-tab${item.id === tab ? " is-active" : ""}" role="tab"
             aria-selected="${item.id === tab}" data-mk-tab="${item.id}">${esc(item.label)}${
            item.id === "hire" && workspace?.myJobs?.length
              ? `<span class="mk-count">${workspace.myJobs.length}</span>`
              : ""
          }</button>`
      ).join("")}
    </div>
    <div class="mk-body" data-mk-body></div>
    <div class="mk-dialog-backdrop hidden" data-mk-dialog-root></div>
  `;

  const body = qs("[data-mk-body]", root);
  if (tab === "browse") body.innerHTML = viewBrowse();
  else if (tab === "businesses") body.innerHTML = viewBusinesses();
  else if (tab === "hire") body.innerHTML = viewHire();
  else if (tab === "work") body.innerHTML = viewWork();
  else body.innerHTML = viewProfile(profile);

  bind(root, body);
}

/* ------------------------------------------------------------------ browse */
function viewBrowse() {
  if (!board.length) {
    return emptyState({
      icon: "package",
      title: "No open projects yet",
      desc: "When a business posts work, it appears here. You can fill in your profile meanwhile."
    });
  }
  return `<div class="mk-grid">
    ${board
      .map(
        (job) => `<article class="mk-card mk-job-card">
        <div class="mk-card-top">
          <h3 class="mk-title">${esc(job.title)}</h3>
          <span class="mk-status mk-${tone(job.status)}">${esc(job.status)}</span>
        </div>
        <p class="mk-note">
          ${esc(job.businessName || "Independent business")}${
          job.ownerUsername ? ` · @${esc(job.ownerUsername)}` : ""
        } · ${timeAgo(job.createdAt)}
        </p>
        <p class="mk-desc">${esc(job.description.slice(0, 200))}${job.description.length > 200 ? "…" : ""}</p>
        ${
          job.requirements
            ? `<details class="mk-details"><summary>Requirements</summary><p class="mk-desc">${esc(job.requirements)}</p></details>`
            : ""
        }
        <div class="mk-chips">${(job.skills || []).map(chip).join("")}</div>
        <dl class="mk-meta">
          <div><dt>Budget</dt><dd>${amount(job.budgetMin, job.currency)} – ${amount(job.budgetMax, job.currency)}</dd></div>
          <div><dt>Delivery</dt><dd>${job.deliveryDays ? `${job.deliveryDays} days` : "Flexible"}</dd></div>
          <div><dt>Pitches</dt><dd>${job.proposals}</dd></div>
          <div><dt>Questions</dt><dd>${(job.questions || []).length}</dd></div>
        </dl>
        ${
          job.mine
            ? `<p class="mk-note">${icon("info", { size: 14 })} This is your project — manage it under My projects.</p>`
            : job.myProposal
              ? `<p class="mk-note">${icon("check-check", { size: 14 })} You pitched — status
                   <span class="mk-status mk-${tone(job.myProposal.status)}">${esc(job.myProposal.status)}</span></p>`
              : `<button class="btn btn-primary btn-sm" data-mk-pitch="${esc(job.jobId)}">Pitch this project</button>`
        }
      </article>`
      )
      .join("")}
  </div>`;
}

/* -------------------------------------------------------------- businesses */
function viewBusinesses() {
  return `<section class="mk-panel" style="margin-bottom:18px">
      <h2 class="mk-section-title">Find a person by handle</h2>
      <form class="mk-form" data-mk-form="find">
        <div class="mk-row mk-find">
          <label style="flex:1 1 260px;max-width:380px">Username
            <input name="username" placeholder="@riya.sharma" maxlength="31" autocomplete="off" />
          </label>
          <label style="flex:0 0 auto;justify-content:flex-end">
            <span>&nbsp;</span>
            <button class="btn btn-primary" type="submit">Search</button>
          </label>
        </div>
      </form>
      ${found ? cardForPerson(found) : ""}
    </section>

    <section class="mk-panel">
      <h2 class="mk-section-title">Businesses on Shinzora</h2>
      ${
        businesses.length
          ? `<div class="mk-grid">
          ${businesses
            .map(
              (business) => `<article class="mk-card">
              <div class="mk-card-top">
                <h3 class="mk-title">${esc(business.name)}</h3>
                <span class="mk-status mk-muted">${esc(business.category || "Business")}</span>
              </div>
              <p class="mk-desc">${esc((business.description || "No description yet.").slice(0, 180))}</p>
              <dl class="mk-meta">
                <div><dt>Owner</dt><dd>${
                  business.ownerUsername ? `@${esc(business.ownerUsername)}` : esc(business.ownerName || "—")
                }</dd></div>
                <div><dt>Location</dt><dd>${esc(business.location || "—")}</dd></div>
                <div><dt>Open projects</dt><dd>${business.openProjects}</dd></div>
              </dl>
              ${
                business.websiteUrl
                  ? `<a class="mk-link" href="${esc(business.websiteUrl)}" target="_blank" rel="noopener noreferrer">Website</a>`
                  : ""
              }
              ${
                business.openProjects
                  ? `<button class="btn btn-ghost btn-sm" data-mk-tab-jump="browse">See their projects</button>`
                  : ""
              }
            </article>`
            )
            .join("")}
        </div>`
          : emptyState({
              icon: "users",
              title: "No businesses listed yet",
              desc: "Businesses appear here once owners finish onboarding. Find someone directly by handle above."
            })
      }
    </section>

    ${
      people.length
        ? `<section class="mk-panel" style="margin-top:18px">
            <h2 class="mk-section-title">Agents on Shinzora</h2>
            <div class="mk-grid">
              ${people
                .map(
                  (person) => `<article class="mk-card">
                  <div class="mk-card-top">
                    <h3 class="mk-title">${esc(person.name)}</h3>
                    <span class="mk-status mk-${person.availability === "available" ? "positive" : "muted"}">${esc(person.availability)}</span>
                  </div>
                  <p class="mk-note">${person.username ? `@${esc(person.username)} · ` : ""}${esc(person.headline || "No headline yet.")}</p>
                  <div class="mk-chips">${(person.skills || []).map(chip).join("")}</div>
                  <dl class="mk-meta">
                    <div><dt>Expects</dt><dd>${
                      person.expectedRate
                        ? amount(person.expectedRate, person.currency)
                        : person.hourlyRate
                          ? `${amount(person.hourlyRate, person.currency)}/hr`
                          : "On request"
                    }</dd></div>
                    <div><dt>Rating</dt><dd>${person.ratingAvg ? `${person.ratingAvg} (${person.ratingCount})` : "No reviews yet"}</dd></div>
                    <div><dt>Completed</dt><dd>${person.completedContracts}</dd></div>
                    <div><dt>Equity</dt><dd>${person.equityOk ? `Open${person.equityMinPct || person.equityMaxPct ? ` (${person.equityMinPct || 0}–${person.equityMaxPct || "?"}%)` : ""}` : "Cash only"}</dd></div>
                  </dl>
                  ${person.seeking ? `<p class="mk-desc">${esc(person.seeking)}</p>` : ""}
                  ${person.portfolioUrl ? `<a class="mk-link" href="${esc(person.portfolioUrl)}" target="_blank" rel="noopener noreferrer">Portfolio</a>` : ""}
                </article>`
                )
                .join("")}
            </div>
          </section>`
        : ""
    }`;
}

function cardForPerson(person) {
  return `<article class="mk-card" style="margin-top:12px">
    <div class="mk-card-top">
      <h3 class="mk-title">${esc(person.name)}</h3>
      <span class="mk-status mk-${person.accountType === "agent" ? "info" : "positive"}">${esc(
        person.accountType === "agent" ? "Agent" : "Business owner"
      )}</span>
    </div>
    <p class="mk-note">@${esc(person.username)}${person.isSelf ? " · that's you" : ""}</p>
    ${person.headline ? `<p class="mk-desc">${esc(person.headline)}</p>` : ""}
    ${person.businessName ? `<p class="mk-note">${icon("package", { size: 13 })} ${esc(person.businessName)}</p>` : ""}
    <div class="mk-chips">${(person.skills || []).map(chip).join("")}</div>
    ${
      person.accountType === "agent" && !person.isPublished
        ? `<p class="mk-note">Their profile is not published yet, so only their handle and name are visible.</p>`
        : ""
    }
  </article>`;
}

/* -------------------------------------------------------------------- hire */
function viewHire() {
  const jobs = workspace?.myJobs || [];
  return `<div class="mk-split">
    <section class="mk-panel">
      <h2 class="mk-section-title">Post a project</h2>
      <form class="mk-form" data-mk-form="job">
        <label>Project name<input name="title" maxlength="140" required placeholder="Website for our bakery" /></label>
        <label>What it is<textarea name="description" rows="3" maxlength="6000" required
          placeholder="A short summary — what this project is for."></textarea></label>
        <label>Requirements<textarea name="requirements" rows="4" maxlength="8000" required
          placeholder="What the agent must actually deliver, and how you will judge it."></textarea></label>
        <label>Skills you are looking for (comma separated)<input name="skills" placeholder="web design, copywriting" /></label>
        <div class="mk-row">
          <label>Budget from<input name="budgetMin" type="number" min="0" step="1" /></label>
          <label>Budget to<input name="budgetMax" type="number" min="0" step="1" /></label>
          <label>Currency<input name="currency" maxlength="3" value="INR" /></label>
        </div>
        <div class="mk-row">
          <label>Delivery (days)<input name="deliveryDays" type="number" min="1" max="730" /></label>
          <label>Theme / direction<input name="theme" maxlength="80" placeholder="Editorial, minimal" /></label>
        </div>
        <label>Existing website (optional)<input name="website" placeholder="https://" inputmode="url" /></label>
        <label>Screening questions (one per line, up to 10)
          <textarea name="questions" rows="3" maxlength="2000"
            placeholder="Link the last site you shipped&#10;How would you approach the CMS?"></textarea>
        </label>
        <div class="field-hint">Agents must answer every question before they can pitch, so keep them short.</div>
        <button class="btn btn-primary" type="submit">Post project</button>
      </form>
    </section>
    <section class="mk-panel">
      <h2 class="mk-section-title">Your projects</h2>
      ${
        jobs.length
          ? jobs
              .map(
                (job) => `<article class="mk-job">
          <div class="mk-card-top">
            <h3 class="mk-title">${esc(job.title)}</h3>
            <span class="mk-status mk-${tone(job.status)}">${esc(job.status)}</span>
          </div>
          <p class="mk-note">${(job.proposals || []).length} pitch(es) · ${amount(job.budgetMin, job.currency)} – ${amount(job.budgetMax, job.currency)}</p>
          ${
            (job.questions || []).length
              ? `<p class="mk-note">${icon("info", { size: 13 })} ${job.questions.length} screening question(s)</p>`
              : ""
          }
          ${
            (job.proposals || []).length
              ? `<ul class="mk-proposals">
              ${job.proposals
                .map(
                  (pitch) => `<li class="mk-proposal">
                  <div class="mk-card-top">
                    <div>
                      <strong>${esc(pitch.name)}</strong>
                      <span class="dim">@${esc(pitch.username || "—")}</span>
                      ${pitch.ratingAvg ? `<span class="mk-status mk-positive">${pitch.ratingAvg}★</span>` : ""}
                    </div>
                    <span class="mk-status mk-${tone(pitch.status)}">${esc(pitch.status)}</span>
                  </div>
                  <div class="mk-chips">${(pitch.skills || []).map(chip).join("")}</div>
                  <p>${esc(pitch.coverNote || "No note.")}</p>
                  <p class="mk-note">Bid ${amount(pitch.bidAmount, pitch.currency)} · ${pitch.deliveryDays} days
                    ${pitch.equityOk ? " · open to equity" : ""}${pitch.esopOk ? " · open to ESOPs" : ""}</p>
                  ${renderAnswers(job, pitch)}
                  ${
                    pitch.status === "submitted" && job.status === "open"
                      ? `<div class="mk-decide">
                           <button class="btn btn-primary btn-sm" data-mk-accept="${esc(pitch.proposalId)}">Hire</button>
                           <button class="btn btn-ghost btn-sm" data-mk-reject="${esc(pitch.proposalId)}">Not this time</button>
                         </div>`
                      : ""
                  }
                </li>`
                )
                .join("")}
            </ul>`
              : `<p class="dim">No pitches yet.</p>`
          }
          ${job.status === "open" ? `<button class="btn btn-ghost btn-sm" data-mk-close="${esc(job.jobId)}">Close project</button>` : ""}
        </article>`
              )
              .join("")
          : emptyState({ icon: "inbox", title: "Nothing posted yet", desc: "Your first project will appear here with the pitches it attracts." })
      }
    </section>
  </div>`;
}

/* The client asked the questions; the pitch answered them. Show them paired so
   the owner never has to hold two lists in their head. */
function renderAnswers(job, pitch) {
  const asked = job.questions || [];
  if (!asked.length) return "";
  const answers = pitch.answers || {};
  return `<dl class="mk-answers">
    ${asked
      .map(
        (question) => `<div>
          <dt>${esc(question.prompt)}</dt>
          <dd>${esc(answers[question.questionId] || "— no answer —")}</dd>
        </div>`
      )
      .join("")}
  </dl>`;
}

/* -------------------------------------------------------------------- work */
function viewWork() {
  const proposals = workspace?.myProposals || [];
  const contracts = workspace?.contracts || [];
  return `<div class="mk-split">
    <section class="mk-panel">
      <h2 class="mk-section-title">Pitches you sent</h2>
      ${
        proposals.length
          ? proposals
              .map(
                (pitch) => `<article class="mk-job">
            <div class="mk-card-top">
              <h3 class="mk-title">${esc(pitch.jobTitle)}</h3>
              <span class="mk-status mk-${tone(pitch.status)}">${esc(pitch.status)}</span>
            </div>
            <p class="mk-note">Bid ${amount(pitch.bidAmount, pitch.currency)} · ${pitch.deliveryDays} days · ${timeAgo(pitch.createdAt)}</p>
            ${pitch.coverNote ? `<p class="mk-desc">${esc(pitch.coverNote)}</p>` : ""}
            ${pitch.status === "submitted" ? `<button class="btn btn-ghost btn-sm" data-mk-withdraw="${esc(pitch.proposalId)}">Withdraw</button>` : ""}
          </article>`
              )
              .join("")
          : emptyState({ icon: "send", title: "No pitches yet", desc: "Find a project under Projects and send your first pitch." })
      }
    </section>
    <section class="mk-panel">
      <h2 class="mk-section-title">Contracts</h2>
      ${
        contracts.length
          ? contracts
              .map(
                (contract) => `<article class="mk-job">
            <div class="mk-card-top">
              <h3 class="mk-title">${esc(contract.jobTitle)}</h3>
              <span class="mk-status mk-${tone(contract.status)}">${esc(contract.status)}</span>
            </div>
            <p class="mk-note">You are the ${esc(contract.role)} ·
              ${esc(contract.counterparty || "—")}${contract.counterpartyUsername ? ` (@${esc(contract.counterpartyUsername)})` : ""}
              · ${amount(contract.amount, contract.currency)}</p>
            ${
              contract.status === "active"
                ? `<div class="mk-row mk-actions">
                   <button class="btn btn-primary btn-sm" data-mk-complete="${esc(contract.contractId)}">Mark completed</button>
                   <button class="btn btn-ghost btn-sm" data-mk-cancel="${esc(contract.contractId)}">Cancel</button>
                 </div>`
                : ""
            }
            ${contract.canReview ? `<button class="btn btn-ghost btn-sm" data-mk-review="${esc(contract.contractId)}">Leave a review</button>` : ""}
          </article>`
              )
              .join("")
          : emptyState({ icon: "check-check", title: "No contracts yet", desc: "When someone accepts your pitch, the contract appears here." })
      }
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- profile */
function viewProfile(profile) {
  const skills = (profile?.skills || []).join(", ");
  const value = (key) => esc(profile?.[key] ?? "");
  return `<section class="mk-panel mk-panel-wide">
    <h2 class="mk-section-title">Agent profile</h2>
    <p class="mk-note">${icon("eye", { size: 14 })} Published profiles appear in the directory and can be found by handle.
      Unpublished ones stay private to you.</p>
    <form class="mk-form" data-mk-form="profile">
      <label>Headline<input name="headline" maxlength="120" value="${value("headline")}" placeholder="Full-stack designer for small businesses" /></label>
      <label>About you<textarea name="bio" rows="4" maxlength="2000" placeholder="What you do, who you have worked with, how you work.">${value("bio")}</textarea></label>
      <label>Skills (comma separated)<input name="skills" value="${esc(skills)}" placeholder="web design, copywriting, react" /></label>
      <div class="mk-row">
        <label>Expected pay<input name="expectedRate" type="number" min="0" step="1" value="${value("expected_rate")}" /></label>
        <label>Currency<input name="currency" maxlength="3" value="${esc(profile?.expected_currency || profile?.currency || "INR")}" /></label>
        <label>Years of experience<input name="yearsExperience" type="number" min="0" max="70" value="${value("years_experience")}" /></label>
      </div>
      <div class="mk-row">
        <label>Hours per week<input name="hoursPerWeek" type="number" min="1" max="100" value="${value("hours_per_week")}" /></label>
        <label>Availability
          <select name="availability">
            ${["available", "busy", "unavailable"]
              .map((option) => `<option value="${option}"${profile?.availability === option ? " selected" : ""}>${option}</option>`)
              .join("")}
          </select>
        </label>
        <label>Where you are<input name="location" maxlength="120" value="${value("location")}" placeholder="Faridabad, Haryana" /></label>
      </div>
      <label>What you are looking for<textarea name="seeking" rows="3" maxlength="500" placeholder="Long-term product work with a founding team.">${value("seeking")}</textarea></label>
      <label>Portfolio link<input name="portfolioUrl" value="${value("portfolio_url")}" placeholder="https://…" /></label>
      <label class="mk-check">
        <input type="checkbox" name="remoteOk" ${profile?.remote_ok === false ? "" : "checked"} />
        <span>I can work remotely</span>
      </label>
      <label class="mk-check">
        <input type="checkbox" name="equityOk" ${profile?.equity_ok ? "checked" : ""} />
        <span>I would take part of the fee as equity or stake</span>
      </label>
      <div class="mk-row">
        <label>Equity from (%)<input name="equityMin" type="number" min="0" max="100" step="0.1" value="${value("equity_min_pct")}" /></label>
        <label>Equity up to (%)<input name="equityMax" type="number" min="0" max="100" step="0.1" value="${value("equity_max_pct")}" /></label>
      </div>
      <label class="mk-check">
        <input type="checkbox" name="esopOk" ${profile?.esop_ok ? "checked" : ""} />
        <span>I am open to ESOPs / stock options</span>
      </label>
      <label class="mk-check">
        <input type="checkbox" name="publish" ${profile?.is_published ? "checked" : ""} />
        <span>Publish my profile to the directory</span>
      </label>
      <button class="btn btn-primary" type="submit">Save profile</button>
    </form>
  </section>`;
}

/* -------------------------------------------------------------------- bind */
/* paint() rewrites root.innerHTML, so anything bound to a node created by a
   previous paint is gone. Root itself survives, which means a delegate added
   there would stack up on every repaint and fire the tab handler N times.
   The root listeners are therefore installed once; the per-paint ones go on
   the body node, which is a fresh element each time. */
const boundRoots = new WeakSet();

function bind(root, body) {
  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    delegate(root, "click", "[data-mk-tab]", (event, button) => {
      tab = button.dataset.mkTab;
      found = null;
      paint(root);
    });

    delegate(root, "click", "[data-mk='refresh']", async () => {
      try {
        await load();
        paint(root);
        toast("Marketplace refreshed.");
      } catch (error) {
        toastError(error);
      }
    });
  }

  delegate(body, "click", "[data-mk-tab-jump]", (event, button) => {
    tab = button.dataset.mkTabJump;
    paint(root);
  });

  delegate(body, "click", "[data-mk-pitch]", (event, button) =>
    openPitchDialog(root, button.dataset.mkPitch)
  );

  delegate(body, "click", "[data-mk-accept]", async (event, button) => {
    if (!confirm("Hire this person? A contract starts, the project closes, and every other pitch is rejected.")) return;
    await act(async () => {
      const result = await rpc("marketplace_decide_proposal", {
        p_proposal: button.dataset.mkAccept,
        p_decision: "accept"
      });
      toast(result?.status === "accepted"
        ? "Contract started. The agent has been notified."
        : "That pitch has already been decided.");
    }, root);
  });

  /* Rejecting is its own outcome. Before this, a pitch that was not chosen sat
     at 'submitted' forever and the pitch list never changed. */
  delegate(body, "click", "[data-mk-reject]", async (event, button) => {
    if (!confirm("Turn this pitch down? The person is told, and can pitch on other projects.")) return;
    await act(async () => {
      await rpc("marketplace_decide_proposal", {
        p_proposal: button.dataset.mkReject,
        p_decision: "reject"
      });
      toast("Pitch declined. The person has been notified.");
    }, root);
  });

  delegate(body, "click", "[data-mk-close]", async (event, button) => {
    if (!confirm("Close this project? Pending pitches are rejected.")) return;
    await act(async () => {
      await rpc("marketplace_close_job", { p_job: button.dataset.mkClose });
      toast("Project closed.");
    }, root);
  });

  delegate(body, "click", "[data-mk-withdraw]", async (event, button) => {
    if (!confirm("Withdraw this pitch?")) return;
    await act(async () => {
      await rpc("marketplace_withdraw_proposal", { p_proposal: button.dataset.mkWithdraw });
      toast("Pitch withdrawn.");
    }, root);
  });

  delegate(body, "click", "[data-mk-complete]", async (event, button) => {
    if (!confirm("Mark this contract completed? Reviews open afterwards.")) return;
    await act(async () => {
      await rpc("marketplace_set_contract_status", { p_contract: button.dataset.mkComplete, p_status: "completed" });
      toast("Contract completed.");
    }, root);
  });

  delegate(body, "click", "[data-mk-cancel]", async (event, button) => {
    if (!confirm("Cancel this contract? It will no longer count towards completed work.")) return;
    await act(async () => {
      await rpc("marketplace_set_contract_status", { p_contract: button.dataset.mkCancel, p_status: "cancelled" });
      toast("Contract cancelled.");
    }, root);
  });

  delegate(body, "click", "[data-mk-review]", (event, button) => openReviewDialog(root, button.dataset.mkReview));

  delegate(body, "submit", "[data-mk-form='find']", async (event, form) => {
    event.preventDefault();
    const handle = String(new FormData(form).get("username") || "").trim().replace(/^@+/, "");
    if (!handle) return;
    try {
      found = await rpc("marketplace_find_user", { p_username: handle });
      paint(root);
    } catch (error) {
      found = null;
      toastError(error);
    }
  });

  delegate(body, "submit", "[data-mk-form='job']", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    const questions = String(data.get("questions") || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);
    await act(async () => {
      await rpc("marketplace_create_project", {
        p_title: String(data.get("title") || ""),
        p_description: String(data.get("description") || ""),
        p_requirements: String(data.get("requirements") || ""),
        p_skills: String(data.get("skills") || "").split(",").map((s) => s.trim()).filter(Boolean),
        p_budget_min: data.get("budgetMin") ? Number(data.get("budgetMin")) : null,
        p_budget_max: data.get("budgetMax") ? Number(data.get("budgetMax")) : null,
        p_currency: String(data.get("currency") || "INR").toUpperCase(),
        p_delivery_days: data.get("deliveryDays") ? Number(data.get("deliveryDays")) : null,
        p_theme: String(data.get("theme") || "") || null,
        p_website: String(data.get("website") || "") || null,
        p_questions: questions
      });
      toast("Project posted.");
    }, root);
  });

  delegate(body, "submit", "[data-mk-form='profile']", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    const numberOrNull = (key) => (data.get(key) ? Number(data.get(key)) : null);
    await act(async () => {
      await rpc("marketplace_save_agent", {
        p_headline: String(data.get("headline") || ""),
        p_bio: String(data.get("bio") || ""),
        p_skills: String(data.get("skills") || "").split(",").map((s) => s.trim()).filter(Boolean),
        p_expected_rate: numberOrNull("expectedRate"),
        p_currency: String(data.get("currency") || "INR").toUpperCase(),
        p_availability: String(data.get("availability") || "available"),
        p_portfolio_url: String(data.get("portfolioUrl") || "") || null,
        p_years_experience: numberOrNull("yearsExperience"),
        p_seeking: String(data.get("seeking") || ""),
        p_hours_per_week: numberOrNull("hoursPerWeek"),
        p_notice_period_days: null,
        p_location: String(data.get("location") || "") || null,
        p_remote_ok: data.get("remoteOk") === "on",
        p_equity_ok: data.get("equityOk") === "on",
        p_equity_min_pct: numberOrNull("equityMin"),
        p_equity_max_pct: numberOrNull("equityMax"),
        p_esop_ok: data.get("esopOk") === "on",
        p_publish: data.get("publish") === "on"
      });
      toast("Profile saved.");
    }, root);
  });
}

async function act(run, root) {
  try {
    await run();
    await load();
    paint(root);
  } catch (error) {
    toastError(error);
  }
}

/* ----------------------------------------------------------------- dialogs */
/* A dialog gets its own backdrop node every time it opens. Reusing one node
   and rewriting its innerHTML would leave the previous form's submit delegate
   attached, so a single submit could fire the RPC twice. */
function mountDialog(root, html) {
  qs("[data-mk-dialog-root]", root)?.remove();
  const holder = document.createElement("div");
  holder.className = "mk-dialog-backdrop";
  holder.setAttribute("data-mk-dialog-root", "");
  holder.innerHTML = `<div class="mk-dialog" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(holder);
  const close = () => {
    holder.remove();
  };
  delegate(holder, "click", "[data-mk-close-dialog]", close);
  holder.addEventListener("click", (event) => {
    if (event.target === holder) close();
  });
  return { holder, close };
}

function openPitchDialog(root, jobId) {
  const job = board.find((entry) => entry.jobId === jobId);
  const questions = job?.questions || [];

  const { holder, close } = mountDialog(
    root,
    `<h3 class="mk-title">Pitch: ${esc(job?.title || "this project")}</h3>
     ${job?.requirements ? `<p class="mk-desc">${esc(job.requirements)}</p>` : ""}
     <form class="mk-form" data-mk-pitch-form>
       <label>Your pitch<textarea name="coverNote" rows="4" maxlength="4000" required
         placeholder="Why you, what you would do first, and anything the client should know."></textarea></label>
       <div class="mk-row">
         <label>Bid amount<input name="bidAmount" type="number" min="1" step="1" required /></label>
         <label>Delivery (days)<input name="deliveryDays" type="number" min="1" max="730" required /></label>
       </div>
       ${
         questions.length
           ? `<div class="mk-subhead">The client asked ${questions.length} question${questions.length > 1 ? "s" : ""}</div>
              ${questions
                .map(
                  (question, index) => `<label>${esc(question.prompt)}
                    <textarea name="q_${esc(question.questionId)}" rows="2" maxlength="2000" required
                      data-mk-question="${index}"></textarea>
                  </label>`
                )
                .join("")}`
           : ""
       }
       <div class="mk-row mk-actions">
         <button class="btn btn-primary" type="submit">Send pitch</button>
         <button class="btn btn-ghost" type="button" data-mk-close-dialog>Cancel</button>
       </div>
     </form>`
  );

  delegate(holder, "submit", "[data-mk-pitch-form]", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    const answers = {};
    questions.forEach((question) => {
      answers[question.questionId] = String(data.get(`q_${question.questionId}`) || "");
    });
    try {
      await rpc("marketplace_pitch", {
        p_job: jobId,
        p_cover_note: String(data.get("coverNote") || ""),
        p_bid_amount: Number(data.get("bidAmount")),
        p_delivery_days: Number(data.get("deliveryDays")),
        p_answers: answers
      });
      close();
      toast("Pitch sent.");
      await load();
      paint(root);
    } catch (error) {
      toastError(error);
    }
  });
}

function openReviewDialog(root, contractId) {
  const { holder, close } = mountDialog(
    root,
    `<h3 class="mk-title">Leave a review</h3>
     <form class="mk-form" data-mk-review-form>
       <label>Rating
         <select name="rating">
           ${[5, 4, 3, 2, 1].map((value) => `<option value="${value}">${value} star${value > 1 ? "s" : ""}</option>`).join("")}
         </select>
       </label>
       <label>Comment<textarea name="comment" rows="4" maxlength="2000" placeholder="How did it go?"></textarea></label>
       <div class="mk-row mk-actions">
         <button class="btn btn-primary" type="submit">Save review</button>
         <button class="btn btn-ghost" type="button" data-mk-close-dialog>Cancel</button>
       </div>
     </form>`
  );
  delegate(holder, "submit", "[data-mk-review-form]", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await rpc("marketplace_submit_review", {
        p_contract: contractId,
        p_rating: Number(data.get("rating")),
        p_comment: String(data.get("comment") || "")
      });
      close();
      toast("Review saved.");
      await load();
      paint(root);
    } catch (error) {
      toastError(error);
    }
  });
}
