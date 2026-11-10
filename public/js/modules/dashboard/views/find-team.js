/* ==========================================================================
   Shinzora — Find Team
   --------------------------------------------------------------------------
   The directory both sides use when they already know (or half know) who they
   want: search by handle, name, or skill, scan a card, then open the full
   profile in a modal.

   Two round trips on purpose. The list RPC (`find_team_search`) returns enough
   for a card; the modal calls `agent_public_profile` only when opened, so the
   directory stays cheap even with a large roster.
   ========================================================================== */

import { qs, delegate, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, avatar } from "../components.js";
import { openModal } from "../../../ui/modal.js";
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

let results = [];
let query = "";
let lastError = null;

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  await search(root, "", { firstPaint: true });
  paint(root);
}

function paint(root) {
  root.innerHTML = `
    ${pageHead({
      title: "Find Team",
      desc: "Search people by their @username, their name, or a skill. Open a card to see experience, portfolio and availability."
    })}
    <div class="toolbar">
      <form class="ft-search" id="ft-form" role="search">
        ${icon("search", { size: 15 })}
        <input id="ft-query" type="search" autocomplete="off" placeholder="Try @riya.sharma, a name, or “figma”"
          value="${esc(query)}" aria-label="Search people" />
        <button class="btn btn-secondary btn-sm" type="submit">Search</button>
      </form>
      <div class="toolbar-spacer"></div>
      <span class="badge badge-neutral" id="ft-count">${results.length} ${results.length === 1 ? "person" : "people"}</span>
    </div>
    <div id="ft-results" class="ft-grid"></div>`;

  paintResults(root);

  const field = qs("#ft-query", root);
  on(qs("#ft-form", root), "submit", (event) => {
    event.preventDefault();
    search(root, field.value).then(() => paintResults(root));
  });
  on(field, "input", debounce(() => search(root, field.value).then(() => paintResults(root)), 320));

  delegate(root, "click", "[data-person]", (_event, card) => openProfile(card.dataset.person));
}

function paintResults(root) {
  const grid = qs("#ft-results", root);
  const count = qs("#ft-count", root);
  if (!grid) return;
  if (count) count.textContent = `${results.length} ${results.length === 1 ? "person" : "people"}`;

  if (lastError) {
    grid.innerHTML = `<div class="card"><div class="card-body"><p class="muted">${esc(lastError.message || "Search failed.")}</p></div></div>`;
    return;
  }
  if (!results.length) {
    grid.innerHTML = emptyState({
      icon: "users",
      title: query ? "Nobody matches that yet" : "No one to show yet",
      desc: query
        ? `No account matches “${query}”. Check the spelling, or invite them by email from Team.`
        : "As people join and publish a profile, they appear here."
    });
    return;
  }

  grid.innerHTML = results
    .map((person) => {
      const rate = amount(person.expectedRate, person.currency);
      return `<article class="card ft-card" data-person="${esc(person.username || "")}" tabindex="0" role="button"
          aria-label="Open ${esc(person.name)}’s profile">
        <div class="card-body">
          <div class="ft-top">
            ${avatar(person.name, null, "lg")}
            <div class="ft-ident">
              <h3 class="mk-title">${esc(person.name)}</h3>
              <div class="mk-note">@${esc(person.username || "no-handle")}</div>
            </div>
            ${person.availability ? `<span class="mk-status mk-${person.availability === "available" ? "positive" : "muted"}">${esc(person.availability)}</span>` : ""}
          </div>
          ${person.headline ? `<p class="mk-desc">${esc(person.headline)}</p>` : ""}
          <div class="mk-chips">${(person.skills || []).slice(0, 6).map((s) => `<span class="mk-chip">${esc(s)}</span>`).join("")}</div>
          <dl class="mk-facts">
            <div><dt>Experience</dt><dd>${person.yearsExperience ? `${person.yearsExperience} yr` : "Not stated"}</dd></div>
            <div><dt>Rate</dt><dd>${rate ? esc(rate) : "Open"}</dd></div>
            <div><dt>Equity</dt><dd>${person.equityOk || person.esopOk ? "Open to equity" : "Cash only"}</dd></div>
          </dl>
        </div>
      </article>`;
    })
    .join("");

  // Cards are role=button, so Enter/Space must work too.
  grid.querySelectorAll("[data-person]").forEach((card) => {
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProfile(card.dataset.person);
      }
    });
  });
}

async function search(root, value) {
  query = String(value || "").trim();
  const handle = query.replace(/^@+/, "");
  try {
    results = (await rpc("find_team_search", { p_query: handle || null, p_limit: 60 })) || [];
    results = Array.isArray(results) ? results : [];
    lastError = null;
  } catch (error) {
    results = [];
    lastError = error;
  }
  return results;
}

async function openProfile(username) {
  if (!username) return;
  const modal = openModal({
    title: `@${username}`,
    desc: "Loading profile…",
    size: "lg",
    body: `<div class="skeleton skeleton-line" style="height:14px;width:70%"></div>
      <div class="skeleton skeleton-line" style="height:14px;width:90%;margin-top:10px"></div>
      <div class="skeleton skeleton-line" style="height:14px;width:60%;margin-top:10px"></div>`
  });

  let person;
  try {
    person = await rpc("agent_public_profile", { p_username: username });
  } catch (error) {
    modal.body.innerHTML = `<p class="muted">${esc(error.message || "That profile could not be loaded.")}</p>`;
    toastError(error);
    return;
  }

  const title = qs(".modal-title", modal.root);
  const desc = qs(".modal-desc", modal.root);
  if (title) title.textContent = person.name || `@${username}`;
  if (desc) desc.textContent = person.headline || `@${username}`;

  const rate = amount(person.expectedRate, person.currency);
  const socials = Object.entries(person.socialLinks || {}).filter(([, v]) => v);
  const experience = Array.isArray(person.experience) ? person.experience : [];
  const portfolio = Array.isArray(person.portfolio) ? person.portfolio : [];

  modal.body.innerHTML = `
    <div class="ft-profile">
      <div class="ft-profile-head">
        ${avatar(person.name, null, "lg")}
        <div>
          <div class="ft-profile-name">${esc(person.name)}</div>
          <div class="mk-note">@${esc(person.username || username)}${person.isSelf ? " · that's you" : ""}</div>
          <div class="mk-note">${esc(person.accountType === "agent" ? "Agent" : "Business owner")}${person.location ? ` · ${esc(person.location)}` : ""}${person.remoteOk ? " · remote" : ""}</div>
        </div>
      </div>

      ${person.bio ? `<p class="mk-desc">${esc(person.bio)}</p>` : ""}

      <dl class="mk-facts mk-facts-wide">
        <div><dt>Experience</dt><dd>${person.yearsExperience ? `${person.yearsExperience} years` : "Not stated"}</dd></div>
        <div><dt>Expected rate</dt><dd>${rate ? esc(rate) : "Open"}</dd></div>
        <div><dt>Hours / week</dt><dd>${person.hoursPerWeek || "Flexible"}</dd></div>
        <div><dt>Completed projects</dt><dd>${person.completedContracts}</dd></div>
        <div><dt>Ongoing projects</dt><dd>${person.ongoingContracts}</dd></div>
        <div><dt>Rating</dt><dd>${person.ratingAvg ? `${person.ratingAvg} (${person.ratingCount})` : "No reviews yet"}</dd></div>
        <div><dt>Equity</dt><dd>${person.equityOk ? "Open to equity" : "Not open"}</dd></div>
        <div><dt>ESOP</dt><dd>${person.esopOk ? "Open to ESOP" : "Not open"}</dd></div>
      </dl>

      ${person.seeking ? `<section class="ft-section"><h4>Looking for</h4><p>${esc(person.seeking)}</p></section>` : ""}

      ${
        (person.skills || []).length
          ? `<section class="ft-section"><h4>Skills</h4><div class="mk-chips">${person.skills.map((s) => `<span class="mk-chip">${esc(s)}</span>`).join("")}</div></section>`
          : ""
      }

      ${
        experience.length
          ? `<section class="ft-section"><h4>Experience</h4><ul class="ft-timeline">${experience
              .map(
                (job) => `<li>
                  <div class="ft-timeline-role">${esc(job.role || "Role")}</div>
                  <div class="ft-timeline-meta">${esc(job.company || "")}${job.from || job.to ? ` · ${esc(job.from || "")}–${esc(job.to || "")}` : ""}</div>
                  ${job.summary ? `<p class="mk-desc">${esc(job.summary)}</p>` : ""}
                </li>`
              )
              .join("")}</ul></section>`
          : ""
      }

      ${
        portfolio.length
          ? `<section class="ft-section"><h4>Portfolio</h4><div class="ft-portfolio">${portfolio
              .map(
                (item) => `<div class="ft-portfolio-item">
                  <div class="ft-portfolio-title">${esc(item.title)}</div>
                  ${item.summary ? `<p class="mk-desc">${esc(item.summary)}</p>` : ""}
                  ${item.url ? `<a class="mk-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
                </div>`
              )
              .join("")}</div></section>`
          : ""
      }

      <section class="ft-section"><h4>Documents &amp; links</h4>
        <div class="ft-links">
          ${person.resumeUrl ? `<a class="mk-link" href="${esc(person.resumeUrl)}" target="_blank" rel="noopener noreferrer">${icon("file-text", { size: 13 })} Résumé / CV</a>` : `<span class="muted">No CV uploaded</span>`}
          ${person.portfolioUrl ? `<a class="mk-link" href="${esc(person.portfolioUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", { size: 13 })} Portfolio site</a>` : ""}
          ${socials.map(([key, value]) => `<a class="mk-link" href="${esc(value)}" target="_blank" rel="noopener noreferrer">${icon("link", { size: 13 })} ${esc(key)}</a>`).join("")}
        </div>
      </section>
    </div>`;

  if (person.isSelf) return;
  const foot = document.createElement("div");
  foot.className = "modal-foot";
  foot.innerHTML = `<a class="btn btn-secondary btn-sm" href="#/app/?view=team">${icon("user-plus", { size: 14 })}Invite from Team</a>`;
  qs(".modal", modal.root)?.append(foot);
}
