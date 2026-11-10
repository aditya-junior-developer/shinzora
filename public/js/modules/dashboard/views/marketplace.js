/* ==========================================================================
   Shinzora — Freelancer marketplace
   --------------------------------------------------------------------------
   Three roles in one screen, chosen by what the account is doing:

     Browse     find open work, and publish a freelancer profile
     My work    proposals sent, contracts to finish, reviews to leave
     Hire       jobs posted, the proposals they attracted, accept one

   Every mutation is an RPC. The database re-checks ownership, so this file
   never decides who may accept a proposal — it only reflects the answer.
   ========================================================================== */

import { qs, qsa, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";

const TABS = [
  { id: "browse", label: "Find work" },
  { id: "hire", label: "Hire" },
  { id: "work", label: "My work" },
  { id: "profile", label: "My profile" }
];

let tab = "browse";
let workspace = null;
let board = [];
let people = [];

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

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  await load();
  paint(root);
}

async function load() {
  workspace = await rpc("marketplace_my_workspace");
  board = await rpc("marketplace_browse_jobs", { p_search: null, p_skill: null, p_limit: 50 });
  people = await rpc("marketplace_list_freelancers", { p_skill: null, p_limit: 50 });
}

function paint(root) {
  const profile = workspace?.profile;

  root.innerHTML = `
    ${pageHead({
      title: "Marketplace",
      desc: "Post work, send proposals, and run the contract end to end.",
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
  else if (tab === "hire") body.innerHTML = viewHire(profile);
  else if (tab === "work") body.innerHTML = viewWork();
  else body.innerHTML = viewProfile(profile);

  bind(root, body);
}

/* ------------------------------------------------------------------ browse */
function viewBrowse() {
  if (!board.length) {
    return emptyState({
      icon: "package",
      title: "No open jobs yet",
      desc: "When someone posts work, it appears here. You can publish your profile meanwhile."
    });
  }
  return `<div class="mk-grid">
    ${board
      .map(
        (job) => `<article class="mk-card">
        <div class="mk-card-top">
          <h3 class="mk-title">${esc(job.title)}</h3>
          <span class="mk-status mk-${tone(job.status)}">${esc(job.status)}</span>
        </div>
        <p class="mk-desc">${esc(job.description.slice(0, 220))}${job.description.length > 220 ? "…" : ""}</p>
        <div class="mk-chips">${(job.skills || []).map(chip).join("")}</div>
        <dl class="mk-meta">
          <div><dt>Budget</dt><dd>${amount(job.budgetMin, job.currency)} – ${amount(job.budgetMax, job.currency)}</dd></div>
          <div><dt>Delivery</dt><dd>${job.deliveryDays ? `${job.deliveryDays} days` : "Flexible"}</dd></div>
          <div><dt>Proposals</dt><dd>${job.proposals}</dd></div>
          <div><dt>Posted</dt><dd>${timeAgo(job.createdAt)}</dd></div>
        </dl>
        ${
          job.mine
            ? `<p class="mk-note">${icon("info", { size: 14 })} This is your job — manage it under Hire.</p>`
            : `<button class="btn btn-primary btn-sm" data-mk-propose="${esc(job.jobId)}">Send a proposal</button>`
        }
      </article>`
      )
      .join("")}
  </div>
  ${
    people.length
      ? `<h2 class="mk-section-title">Freelancers on Shinzora</h2>
         <div class="mk-grid">
         ${people
           .map(
             (person) => `<article class="mk-card mk-person">
             <div class="mk-card-top">
               <h3 class="mk-title">${esc(person.name)}</h3>
               <span class="mk-status mk-${person.availability === "available" ? "positive" : "muted"}">${esc(person.availability)}</span>
             </div>
             <p class="mk-desc">${esc(person.headline || "No headline yet.")}</p>
             <div class="mk-chips">${(person.skills || []).map(chip).join("")}</div>
             <dl class="mk-meta">
               <div><dt>Rate</dt><dd>${person.hourlyRate ? `${amount(person.hourlyRate, person.currency)}/hr` : "On request"}</dd></div>
               <div><dt>Rating</dt><dd>${person.ratingAvg ? `${person.ratingAvg} (${person.ratingCount})` : "No reviews yet"}</dd></div>
               <div><dt>Completed</dt><dd>${person.completedContracts}</dd></div>
             </dl>
             ${person.portfolioUrl ? `<a class="mk-link" href="${esc(person.portfolioUrl)}" target="_blank" rel="noopener noreferrer">Portfolio</a>` : ""}
           </article>`
           )
           .join("")}
         </div>`
      : ""
  }`;
}

/* -------------------------------------------------------------------- hire */
function viewHire() {
  const jobs = workspace?.myJobs || [];
  return `<div class="mk-split">
    <section class="mk-panel">
      <h2 class="mk-section-title">Post a job</h2>
      <form class="mk-form" data-mk-form="job">
        <label>Title<input name="title" maxlength="140" required placeholder="Build a bakery website" /></label>
        <label>What needs doing<textarea name="description" rows="5" maxlength="6000" required
          placeholder="Describe the work, the pages, the tone — enough for someone to quote it."></textarea></label>
        <label>Skills (comma separated)<input name="skills" placeholder="web design, copywriting" /></label>
        <div class="mk-row">
          <label>Budget from<input name="budgetMin" type="number" min="0" step="1" /></label>
          <label>Budget to<input name="budgetMax" type="number" min="0" step="1" /></label>
          <label>Currency<input name="currency" maxlength="3" value="INR" /></label>
        </div>
        <label>Delivery (days)<input name="deliveryDays" type="number" min="1" max="730" /></label>
        <button class="btn btn-primary" type="submit">Post job</button>
      </form>
    </section>
    <section class="mk-panel">
      <h2 class="mk-section-title">Your jobs</h2>
      ${
        jobs.length
          ? jobs
              .map(
                (job) => `<article class="mk-job">
          <div class="mk-card-top">
            <h3 class="mk-title">${esc(job.title)}</h3>
            <span class="mk-status mk-${tone(job.status)}">${esc(job.status)}</span>
          </div>
          <p class="mk-note">${(job.proposals || []).length} proposal(s) · ${amount(job.budgetMin, job.currency)} – ${amount(job.budgetMax, job.currency)}</p>
          ${
            (job.proposals || []).length
              ? `<ul class="mk-proposals">
              ${job.proposals
                .map(
                  (proposal) => `<li class="mk-proposal">
                  <div>
                    <strong>${esc(proposal.name)}</strong>
                    ${proposal.ratingAvg ? `<span class="mk-status mk-positive">${proposal.ratingAvg}★</span>` : ""}
                    <span class="dim">${proposal.completedContracts} completed</span>
                  </div>
                  <p>${esc(proposal.coverNote || "No note.")}</p>
                  <p class="mk-note">Bid ${amount(proposal.bidAmount, proposal.currency)} · ${proposal.deliveryDays} days
                    · <span class="mk-status mk-${tone(proposal.status)}">${esc(proposal.status)}</span></p>
                  ${
                    proposal.status === "submitted" && job.status === "open"
                      ? `<button class="btn btn-primary btn-sm" data-mk-accept="${esc(proposal.proposalId)}">Accept this proposal</button>`
                      : ""
                  }
                </li>`
                )
                .join("")}
            </ul>`
              : `<p class="dim">No proposals yet.</p>`
          }
          ${job.status === "open" ? `<button class="btn btn-ghost btn-sm" data-mk-close="${esc(job.jobId)}">Close job</button>` : ""}
        </article>`
              )
              .join("")
          : emptyState({ icon: "inbox", title: "Nothing posted yet", desc: "Your first job will appear here with the proposals it attracts." })
      }
    </section>
  </div>`;
}

/* -------------------------------------------------------------------- work */
function viewWork() {
  const proposals = workspace?.myProposals || [];
  const contracts = workspace?.contracts || [];
  return `<div class="mk-split">
    <section class="mk-panel">
      <h2 class="mk-section-title">Proposals you sent</h2>
      ${
        proposals.length
          ? proposals
              .map(
                (proposal) => `<article class="mk-job">
            <div class="mk-card-top">
              <h3 class="mk-title">${esc(proposal.jobTitle)}</h3>
              <span class="mk-status mk-${tone(proposal.status)}">${esc(proposal.status)}</span>
            </div>
            <p class="mk-note">Bid ${amount(proposal.bidAmount, proposal.currency)} · ${proposal.deliveryDays} days · ${timeAgo(proposal.createdAt)}</p>
            ${proposal.coverNote ? `<p class="mk-desc">${esc(proposal.coverNote)}</p>` : ""}
            ${proposal.status === "submitted" ? `<button class="btn btn-ghost btn-sm" data-mk-withdraw="${esc(proposal.proposalId)}">Withdraw</button>` : ""}
          </article>`
              )
              .join("")
          : emptyState({ icon: "send", title: "No proposals yet", desc: "Find a job under Find work and send your first proposal." })
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
            <p class="mk-note">You are the ${esc(contract.role)} · ${esc(contract.counterparty || "—")} · ${amount(contract.amount, contract.currency)}</p>
            ${
              contract.status === "active"
                ? `<div class="mk-row mk-actions">
                   <button class="btn btn-primary btn-sm" data-mk-complete="${esc(contract.contractId)}">Mark completed</button>
                   <button class="btn btn-ghost btn-sm" data-mk-cancel="${esc(contract.contractId)}">Cancel</button>
                 </div>`
                : ""
            }
            ${
              contract.canReview
                ? `<button class="btn btn-ghost btn-sm" data-mk-review="${esc(contract.contractId)}">Leave a review</button>`
                : ""
            }
          </article>`
              )
              .join("")
          : emptyState({ icon: "check-check", title: "No contracts yet", desc: "When someone accepts your proposal, the contract appears here." })
      }
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- profile */
function viewProfile(profile) {
  const skills = (profile?.skills || []).join(", ");
  return `<section class="mk-panel mk-panel-wide">
    <h2 class="mk-section-title">Freelancer profile</h2>
    <p class="mk-note">${icon("eye", { size: 14 })} Published profiles appear in the freelancer directory. Unpublished ones stay private to you.</p>
    <form class="mk-form" data-mk-form="profile">
      <label>Headline<input name="headline" maxlength="120" value="${esc(profile?.headline || "")}" placeholder="Full-stack designer for small businesses" /></label>
      <label>About you<textarea name="bio" rows="5" maxlength="2000" placeholder="What you do, who you have worked with, how you work.">${esc(profile?.bio || "")}</textarea></label>
      <label>Skills (comma separated)<input name="skills" value="${esc(skills)}" placeholder="web design, copywriting, react" /></label>
      <div class="mk-row">
        <label>Hourly rate<input name="hourlyRate" type="number" min="0" step="1" value="${profile?.hourly_rate ?? ""}" /></label>
        <label>Currency<input name="currency" maxlength="3" value="${esc(profile?.currency || "INR")}" /></label>
        <label>Years of experience<input name="yearsExperience" type="number" min="0" max="70" value="${profile?.years_experience ?? ""}" /></label>
      </div>
      <label>Availability
        <select name="availability">
          ${["available", "busy", "unavailable"]
            .map((value) => `<option value="${value}"${profile?.availability === value ? " selected" : ""}>${value}</option>`)
            .join("")}
        </select>
      </label>
      <label>Portfolio link<input name="portfolioUrl" value="${esc(profile?.portfolio_url || "")}" placeholder="https://…" /></label>
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

  delegate(body, "click", "[data-mk-propose]", (event, button) =>
    openProposalDialog(root, button.dataset.mkPropose)
  );

  delegate(body, "click", "[data-mk-accept]", async (event, button) => {
    if (!confirm("Accept this proposal? The other proposals on this job are rejected and a contract starts.")) return;
    await act(async () => {
      await rpc("marketplace_accept_proposal", { p_proposal: button.dataset.mkAccept });
      toast("Contract started. The freelancer has been notified.");
    }, root);
  });

  delegate(body, "click", "[data-mk-close]", async (event, button) => {
    if (!confirm("Close this job? Pending proposals are rejected.")) return;
    await act(async () => {
      await rpc("marketplace_close_job", { p_job: button.dataset.mkClose });
      toast("Job closed.");
    }, root);
  });

  delegate(body, "click", "[data-mk-withdraw]", async (event, button) => {
    if (!confirm("Withdraw this proposal?")) return;
    await act(async () => {
      await rpc("marketplace_withdraw_proposal", { p_proposal: button.dataset.mkWithdraw });
      toast("Proposal withdrawn.");
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

  delegate(body, "submit", "[data-mk-form='job']", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    await act(async () => {
      await rpc("marketplace_create_job", {
        p_title: String(data.get("title") || ""),
        p_description: String(data.get("description") || ""),
        p_skills: String(data.get("skills") || "").split(",").map((s) => s.trim()).filter(Boolean),
        p_budget_min: data.get("budgetMin") ? Number(data.get("budgetMin")) : null,
        p_budget_max: data.get("budgetMax") ? Number(data.get("budgetMax")) : null,
        p_currency: String(data.get("currency") || "INR").toUpperCase(),
        p_delivery_days: data.get("deliveryDays") ? Number(data.get("deliveryDays")) : null,
        p_business: null
      });
      toast("Job posted.");
    }, root);
  });

  delegate(body, "submit", "[data-mk-form='profile']", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    await act(async () => {
      await rpc("marketplace_upsert_freelancer", {
        p_headline: String(data.get("headline") || ""),
        p_bio: String(data.get("bio") || ""),
        p_skills: String(data.get("skills") || "").split(",").map((s) => s.trim()).filter(Boolean),
        p_hourly_rate: data.get("hourlyRate") ? Number(data.get("hourlyRate")) : null,
        p_currency: String(data.get("currency") || "INR").toUpperCase(),
        p_availability: String(data.get("availability") || "available"),
        p_portfolio_url: String(data.get("portfolioUrl") || "") || null,
        p_years_experience: data.get("yearsExperience") ? Number(data.get("yearsExperience")) : null,
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

function openProposalDialog(root, jobId) {
  const { holder, close } = mountDialog(
    root,
    `<h3 class="mk-title">Send a proposal</h3>
     <form class="mk-form" data-mk-proposal-form>
       <label>Your note<textarea name="coverNote" rows="5" maxlength="4000" required
         placeholder="Why you, what you would do first, and anything the client should know."></textarea></label>
       <div class="mk-row">
         <label>Bid amount<input name="bidAmount" type="number" min="1" step="1" required /></label>
         <label>Delivery (days)<input name="deliveryDays" type="number" min="1" max="730" required /></label>
       </div>
       <div class="mk-row mk-actions">
         <button class="btn btn-primary" type="submit">Send proposal</button>
         <button class="btn btn-ghost" type="button" data-mk-close-dialog>Cancel</button>
       </div>
     </form>`
  );
  delegate(holder, "submit", "[data-mk-proposal-form]", async (event, form) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await rpc("marketplace_submit_proposal", {
        p_job: jobId,
        p_cover_note: String(data.get("coverNote") || ""),
        p_bid_amount: Number(data.get("bidAmount")),
        p_delivery_days: Number(data.get("deliveryDays"))
      });
      close();
      toast("Proposal sent.");
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

