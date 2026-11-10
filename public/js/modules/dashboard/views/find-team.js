/* ==========================================================================
   Shinzora — Find Team
   --------------------------------------------------------------------------
   The directory both sides use when they already know (or half know) who they
   want: search by handle, name, or skill, scan a card, then open the full
   profile in a modal.

   Only agents appear here — the list RPC filters out business-owner accounts
   that never built an agent profile, so a card always describes a person you
   could actually hire.

   Two round trips on purpose. The list RPC (`find_team_search`) returns enough
   for a card; the modal calls `agent_public_profile` only when opened, so the
   directory stays cheap even with a large roster.
   ========================================================================== */

import { qs, delegate, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, avatar } from "../components.js";
import { presenceDot, presenceLabel, presenceState } from "../../../ui/presence.js";
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

/* "1 years" was on screen in the old modal. One helper, used everywhere the
   number is printed, so the plural never regresses. */
const years = (n) => (n === 1 ? "1 year" : `${n} years`);

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
      desc: "Freelancers and agents you can bring onto a project. Search by @username, by name, or by skill."
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

/* A real photo when one was uploaded, initials when not. Same classes either
   way, so a mixed roster still lines up. */
function personAvatar(person, size = "lg") {
  const picture = (() => {
    if (!person || !person.avatarUrl) return avatar(person?.name, null, size);
    const variant = size.startsWith("avatar-") ? size : `avatar-${size}`;
    return `<span class="avatar ${variant} ft-avatar"><img src="${esc(person.avatarUrl)}" alt="" loading="lazy" /></span>`;
  })();
  /* The dot sits under the picture, the same place it sits everywhere else.
     `lastSeenAt` comes from find_team_search (0033). */
  if (!person) return picture;
  return `<span class="presence-wrap">${picture}${presenceDot(person.lastSeenAt, { size: 11 })}</span>`;
}

const pill = (text, tone = "") => `<span class="ft-pill${tone ? ` ${tone}` : ""}">${esc(text)}</span>`;

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
        ? `No freelancer matches “${query}”. Check the spelling, or invite them by email from Team.`
        : "As agents join and publish a profile, they appear here."
    });
    return;
  }

  grid.innerHTML = results
    .map((person) => {
      const rate = amount(person.expectedRate, person.currency);
      const skills = (person.skills || []).slice(0, 3);
      const extra = Math.max(0, (person.skills || []).length - 3);
      const available = String(person.availability || "").toLowerCase() === "available";
      return `<article class="card ft-card" data-person="${esc(person.username || "")}" tabindex="0" role="button"
          aria-label="Open ${esc(person.name)}’s profile">
        <div class="card-body">
          <div class="ft-top">
            ${personAvatar(person, "lg")}
            <div class="ft-ident">
              <h3 class="ft-name">${esc(person.name)}</h3>
              <div class="ft-handle">@${esc(person.username || "no-handle")}${
                person.lastSeenAt ? `<span class="ft-seen"> · ${esc(presenceLabel(presenceState(person.lastSeenAt)))}</span>` : ""
              }</div>
            </div>
            ${person.availability ? pill(person.availability, available ? "is-available" : "") : ""}
          </div>

          ${
            person.headline
              ? `<p class="ft-headline">${esc(person.headline)}</p>`
              : `<p class="ft-headline is-empty">No headline yet</p>`
          }

          ${
            skills.length
              ? `<div class="mk-chips ft-chips">${skills
                  .map((skill) => `<span class="mk-chip">${esc(skill)}</span>`)
                  .join("")}${extra ? `<span class="mk-chip mk-chip-more">+${extra}</span>` : ""}</div>`
              : `<div class="ft-noskills">No skills listed yet</div>`
          }

          <div class="ft-stats">
            <div class="ft-stat">
              <span class="ft-stat-label">Experience</span>
              <span class="ft-stat-value">${person.yearsExperience ? `${person.yearsExperience} yr` : "—"}</span>
            </div>
            <div class="ft-stat">
              <span class="ft-stat-label">Rate</span>
              <span class="ft-stat-value">${rate ? esc(rate) : "Open"}</span>
            </div>
            <div class="ft-stat">
              <span class="ft-stat-label">Equity</span>
              <span class="ft-stat-value">${person.equityOk || person.esopOk ? "Open" : "Cash only"}</span>
            </div>
          </div>
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
  const skills = person.skills || [];
  const available = String(person.availability || "").toLowerCase() === "available";

  modal.body.innerHTML = `
    <div class="ft-profile">
      <div class="ft-profile-head">
        ${personAvatar(person, "lg")}
        <div class="ft-profile-ident">
          <!-- The modal header already carries the name; repeating it here made
               the sheet look like two stacked titles. -->
          <div class="ft-profile-handle">@${esc(person.username || username)}${person.isSelf ? " · that's you" : ""}</div>
          <div class="ft-profile-tags">
            ${pill(person.accountType === "agent" ? "Freelancer" : "Business owner")}
            ${person.location ? pill(person.location) : ""}
            ${person.remoteOk ? pill("Remote") : ""}
            ${person.availability ? pill(person.availability, available ? "is-available" : "") : ""}
          </div>
        </div>
      </div>

      ${person.bio ? `<p class="ft-bio">${esc(person.bio)}</p>` : ""}

      <div class="ft-stat-grid">
        <div class="ft-stat-cell"><span>Experience</span><strong>${person.yearsExperience ? years(person.yearsExperience) : "Not stated"}</strong></div>
        <div class="ft-stat-cell"><span>Expected rate</span><strong>${rate ? esc(rate) : "Open"}</strong></div>
        <div class="ft-stat-cell"><span>Hours / week</span><strong>${person.hoursPerWeek || "Flexible"}</strong></div>
        <div class="ft-stat-cell"><span>Completed</span><strong>${person.completedContracts ?? 0}</strong></div>
        <div class="ft-stat-cell"><span>Ongoing</span><strong>${person.ongoingContracts ?? 0}</strong></div>
        <div class="ft-stat-cell"><span>Rating</span><strong>${person.ratingAvg ? `${person.ratingAvg} (${person.ratingCount})` : "No reviews yet"}</strong></div>
        <div class="ft-stat-cell"><span>Equity</span><strong>${person.equityOk ? "Open to equity" : "Not open"}</strong></div>
        <div class="ft-stat-cell"><span>ESOP</span><strong>${person.esopOk ? "Open to ESOP" : "Not open"}</strong></div>
      </div>

      ${person.seeking ? `<section class="ft-section"><h4>Looking for</h4><p>${esc(person.seeking)}</p></section>` : ""}

      ${
        skills.length
          ? `<section class="ft-section"><h4>Skills</h4><div class="mk-chips">${skills
              .map((skill) => `<span class="mk-chip">${esc(skill)}</span>`)
              .join("")}</div></section>`
          : ""
      }

      ${
        experience.length
          ? `<section class="ft-section"><h4>Experience</h4><ul class="ft-timeline">${experience
              .map(
                (job) => `<li>
                  <div class="ft-timeline-role">${esc(job.role || "Role")}</div>
                  <div class="ft-timeline-meta">${esc(job.company || "")}${
                    job.from || job.to ? ` · ${esc(job.from || "")}–${esc(job.to || "")}` : ""
                  }</div>
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
                  ${item.url ? `<a class="mk-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open project</a>` : ""}
                </div>`
              )
              .join("")}</div></section>`
          : ""
      }

      <section class="ft-section"><h4>Documents &amp; links</h4>
        <div class="ft-links">
          ${
            person.resumeUrl
              ? `<a class="ft-link" href="${esc(person.resumeUrl)}" target="_blank" rel="noopener noreferrer">${icon("file-text", { size: 13 })} Résumé / CV</a>`
              : `<span class="ft-link is-empty">No CV uploaded</span>`
          }
          ${
            person.portfolioUrl
              ? `<a class="ft-link" href="${esc(person.portfolioUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", { size: 13 })} Portfolio site</a>`
              : ""
          }
          ${socials
            .map(
              ([key, value]) =>
                `<a class="ft-link" href="${esc(value)}" target="_blank" rel="noopener noreferrer">${icon("link", { size: 13 })} ${esc(key)}</a>`
            )
            .join("")}
        </div>
      </section>
    </div>`;

  if (person.isSelf) return;
  const foot = document.createElement("div");
  foot.className = "modal-foot";
  foot.innerHTML = `<a class="btn btn-secondary btn-sm" href="#/app/?view=team">${icon("user-plus", { size: 14 })}Invite from Team</a>`;
  qs(".modal", modal.root)?.append(foot);
}
