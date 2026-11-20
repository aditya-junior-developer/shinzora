/* ==========================================================================
   Shinzora — Explore Businesses (phase 2)
   Lists only businesses that opted in (investor_visible). The database returns
   a fixed set of columns and no contact details. "Express interest" records the
   investor's interest and tells the owner, without naming the investor.
   ========================================================================== */

import { qs, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb } from "../../../lib/supabase.js";
import { pageHead, skeletonView, emptyState, setupNotice, chip } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import {
  rpc, unwrap, listingCard, businessDetailBody, INDUSTRIES, STAGES
} from "./investor-kit.js";

let host = null;
let businesses = [];
let interested = new Set();

const num = (value) => {
  const n = Number(String(value || "").replace(/[^\d.]/g, ""));
  return value === "" || value === null || !Number.isFinite(n) ? null : n;
};

function filtersFromForm() {
  const f = new FormData(qs("#inv-filters", host));
  return {
    p_query: String(f.get("q") || "").trim() || null,
    p_industry: String(f.get("industry") || "") || null,
    p_stage: String(f.get("stage") || "") || null,
    p_min_funding: num(f.get("min")),
    p_max_funding: num(f.get("max")),
    p_location: String(f.get("location") || "").trim() || null
  };
}

export default async function render(root) {
  host = root;
  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Explore Businesses",
      desc: "Businesses that have chosen to be seen by investors. Read the profile, then express interest.",
      badge: chip("Investors only", { tone: "violet", iconName: "briefcase" })
    })}
    <form class="card inv-filters inv-rise" id="inv-filters" role="search" aria-label="Filter businesses">
      <label class="inv-field inv-field-wide">
        <span class="field-label">Search</span>
        <input class="input" name="q" type="search" placeholder="Name or description" autocomplete="off" />
      </label>
      <label class="inv-field">
        <span class="field-label">Industry</span>
        <select class="input" name="industry">
          <option value="">All industries</option>
          ${INDUSTRIES.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}
        </select>
      </label>
      <label class="inv-field">
        <span class="field-label">Stage</span>
        <select class="input" name="stage">
          <option value="">All stages</option>
          ${STAGES.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("")}
        </select>
      </label>
      <label class="inv-field">
        <span class="field-label">Funding from (Rs)</span>
        <input class="input" name="min" inputmode="numeric" placeholder="0" />
      </label>
      <label class="inv-field">
        <span class="field-label">Funding to (Rs)</span>
        <input class="input" name="max" inputmode="numeric" placeholder="No limit" />
      </label>
      <label class="inv-field">
        <span class="field-label">Location</span>
        <input class="input" name="location" type="search" placeholder="City or region" autocomplete="off" />
      </label>
      <div class="inv-filter-actions">
        <button class="btn btn-ghost btn-sm" type="reset" id="inv-clear">Clear</button>
      </div>
    </form>
    <div id="inv-results" aria-live="polite">${skeletonView(3)}</div>
  </div>`;

  /* Typing reloads after a short pause. Only selects reload on "change": a text
     field also fires "change" when it loses focus, and a reload at that moment
     would replace the button the person is about to click. */
  const form = qs("#inv-filters", host);
  const rerun = debounce(() => load(), 280);
  on(form, "input", rerun);
  on(form, "change", (event) => {
    if (event.target.tagName === "SELECT") load();
  });
  on(form, "reset", () => setTimeout(load, 0));

  host.addEventListener("click", onClick);
  await load();
}

async function load() {
  const box = qs("#inv-results", host);
  if (!box) return;
  /* Keep the current list on screen while a new one loads, so nothing under the pointer disappears. */
  if (!businesses.length) box.innerHTML = skeletonView(3);
  box.setAttribute("aria-busy", "true");
  try {
    const [rows, mine] = await Promise.all([
      rpc("investor_marketplace", filtersFromForm()),
      sb.from("investor_interests").select("business_id").then(unwrap)
    ]);
    businesses = Array.isArray(rows) ? rows : [];
    interested = new Set((mine || []).map((r) => r.business_id));
    paint();
  } catch (error) {
    box.innerHTML = setupNotice(error, "Explore Businesses");
  }
}

let lastSignature = "";

function paint() {
  const box = qs("#inv-results", host);
  if (!box) return;
  box.removeAttribute("aria-busy");
  /* An unchanged result set is not redrawn, so a click in progress is never lost. */
  const signature = JSON.stringify([businesses.map((b) => b.id), [...interested].sort()]);
  if (signature === lastSignature && box.childElementCount) return;
  lastSignature = signature;
  box.innerHTML = businesses.length
    ? `<p class="field-hint inv-count">${businesses.length} business${businesses.length === 1 ? "" : "es"} match</p>
       <div class="inv-grid">${businesses.map((b) => listingCard(b, { interested: interested.has(b.id) })).join("")}</div>`
    : emptyState({
        iconName: "search",
        title: "No businesses match these filters",
        desc: "Clear a filter, or come back later. Businesses appear here once their owners choose to be seen by investors."
      });
}

function onClick(event) {
  const details = event.target.closest?.("[data-details]");
  if (details) return openDetails(details.getAttribute("data-details"));
  const interest = event.target.closest?.("[data-interest]");
  if (interest) return expressInterest(interest.getAttribute("data-interest"), interest);
}

async function openDetails(id) {
  let row = businesses.find((b) => b.id === id);
  try {
    const rows = await rpc("investor_business", { p_business: id });
    row = (Array.isArray(rows) ? rows[0] : rows) || row;
  } catch (error) {
    toastError(error);
    return;
  }
  if (!row) return;
  const modal = openModal({
    title: row.name || "Business",
    desc: "Read-only profile. Contact details are not shared with investors.",
    size: "lg",
    body: businessDetailBody(row, { interested: interested.has(id) }),
    footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`,
    onMount: (node) => {
      node.addEventListener("click", (event) => {
        const btn = event.target.closest?.("[data-interest]");
        if (!btn) return;
        expressInterest(btn.getAttribute("data-interest"), btn, () => {
          node.querySelector?.(".modal-close, [data-modal-close]")?.click();
        });
      });
    }
  });
  return modal;
}

async function expressInterest(id, button, done) {
  if (button) button.disabled = true;
  try {
    const first = await rpc("express_investor_interest", { p_business: id });
    interested.add(id);
    toast(
      { title: first ? "Interest sent" : "Already sent", message: first ? "The owner has been told that an investor is interested." : "You expressed interest in this business earlier." },
      { tone: "success" }
    );
    done?.();
    paint();
  } catch (error) {
    if (button) button.disabled = false;
    toastError(error);
  }
}
