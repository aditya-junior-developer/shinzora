/* ==========================================================================
   Shinzora — business stage
   One place for the four stages: the badge every screen shows, the option
   cards used in onboarding and Settings, the stage-based checklist on the
   overview, and the one write path (business_set_stage, migration 0079).
   ========================================================================== */

import { esc } from "./dom.js";
import { icon } from "./icons.js";
import { sb, normalizeError } from "./supabase.js";
import { BUSINESS_STAGES, BUSINESS_STAGE_IDS } from "../config/env.js";

export const stageById = (id) => BUSINESS_STAGES.find((stage) => stage.id === id) || null;

export const isStageId = (id) => BUSINESS_STAGE_IDS.includes(id);

/* Badge for a saved stage. A business with no stage yet gets a quiet prompt
   instead of a coloured badge, so existing members see what to do next. */
export function stageBadge(id, { size = "md", link = false } = {}) {
  const stage = stageById(id);
  if (!stage) {
    const prompt = `<span class="stage-badge stage-badge--unset stage-badge--${size}">Stage not set</span>`;
    return link ? `<a class="stage-badge-link" href="/app/?view=settings">${prompt}</a>` : prompt;
  }
  const art = size === "sm" ? 14 : size === "lg" ? 20 : 17;
  return `<span class="stage-badge stage-badge--${stage.tone} stage-badge--${size}" data-stage-badge="${esc(stage.id)}">${
    stageArt(stage, art)
  }${esc(stage.label)}</span>`;
}

/* The badge artwork for a stage (public/img/stages). Decorative: the label next to it says the same thing. */
export function stageArt(stage, size = 44) {
  return `<img class="stage-art" src="/img/stages/${esc(stage.tone)}.png" alt="" width="${size}" height="${size}" decoding="async" />`;
}

/* Option cards. `name` groups the radio-style buttons; `selected` is the id
   currently chosen in the UI (not necessarily saved yet). */
export function stageOptionsHtml({ selected = "", prefix = "stage" } = {}) {
  return BUSINESS_STAGES.map((stage) => {
    const on = stage.id === selected;
    return `<button class="stage-option stage-option--${stage.tone}" type="button" role="radio"
        id="${esc(prefix)}-${esc(stage.id)}" data-stage-option="${esc(stage.id)}"
        aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}">
        <span class="stage-option-top">
          <span class="stage-option-mark" aria-hidden="true">${stageArt(stage, 56)}</span>
          <span class="stage-option-check" aria-hidden="true">${icon("check", { size: 12 })}</span>
        </span>
        <span class="stage-option-title">${esc(stage.label)}</span>
        <span class="stage-option-desc">${esc(stage.desc)}</span>
      </button>`;
  }).join("");
}

/* Moves the selected state between option cards in place (no re-render). */
export function paintStageOptions(root, selected) {
  root.querySelectorAll("[data-stage-option]").forEach((button) => {
    const on = button.dataset.stageOption === selected;
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
  });
}

/* Checklist for the overview. Each item links to a page that already exists.
   `done` is only set when the live data proves it; otherwise the item is
   shown as an open step. Nothing here invents progress. */
export function stageChecklist(stageId, data = {}, business = {}) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const hasPublished = projects.some((project) => project.status === "published");
  const plans = {
    ideation: [
      { label: "Describe the business in your profile", href: "/app/?view=settings", done: Boolean(business.description) },
      { label: "Test the idea with the assistant", href: "/app/?view=assistant" },
      { label: "Sketch the first website", href: "/app/?view=website-builder" },
      { label: "Check the market in Insights", href: "/app/?view=analytics" }
    ],
    mvp: [
      { label: "Generate and publish a first website", href: "/app/?view=website-builder", done: hasPublished },
      { label: "Add your first product", href: "/app/?view=inventory", done: data.productCount > 0 },
      { label: "Set up customer support", href: "/app/?view=support" },
      { label: "Record your first orders", href: "/app/?view=orders", done: data.orderCount > 0 }
    ],
    scaling: [
      { label: "Review orders and stock", href: "/app/?view=orders", done: false },
      { label: "Review your customers", href: "/app/?view=customers", done: data.customerCount > 0 },
      { label: "Run a marketing campaign", href: "/app/?view=marketing" },
      { label: "Find a team to grow with", href: "/app/?view=find-team" }
    ],
    established: [
      { label: "Review performance in Insights", href: "/app/?view=analytics" },
      { label: "Prepare an investor deck", href: "/app/?view=investor-decks" },
      { label: "Find partners and freelancers", href: "/app/?view=marketplace" },
      { label: "Check your plan and billing", href: "/app/?view=billing" }
    ]
  };
  return plans[stageId] || [];
}

/* Recommended next step: the first open item, so the overview always points
   at one concrete page. */
export function nextStep(items) {
  return items.find((item) => !item.done) || null;
}

/* Saves through the owner-only RPC. The database checks the value, the owner
   and the stage list; the page does not decide access. */
export async function saveBusinessStage(businessId, stageId) {
  if (!businessId) throw new Error("Save your business profile before choosing a stage.");
  if (!isStageId(stageId)) throw new Error("Choose one of the four stages.");
  const { data, error } = await sb.rpc("business_set_stage", { p_business: businessId, p_stage: stageId });
  if (error) throw normalizeError(error);
  return data;
}

/* Saved onboarding drafts written before the stage update still hold the old
   onboarding labels. Map them onto the four stages so a returning member sees
   the right card selected. Unknown values become "no stage". */
const LEGACY_STAGE = { idea: "ideation", starting: "mvp", operating: "scaling", growing: "established" };
export function normalizeStage(value) {
  const key = String(value || "").trim().toLowerCase();
  if (isStageId(key)) return key;
  return LEGACY_STAGE[key] || "";
}
