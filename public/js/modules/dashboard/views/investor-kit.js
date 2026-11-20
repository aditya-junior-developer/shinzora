/* ==========================================================================
   Shinzora — investor portal shared helpers (phase 2)
   Every investor page reads through these few functions. The database decides
   what each call may return (migration 0086 and 0088); this file only shows it.
   ========================================================================== */

import { esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { timeAgo } from "../../../lib/format.js";
import { BUSINESS_CATEGORIES, BUSINESS_STAGES } from "../../../config/env.js";
import { stageBadge } from "../../../lib/business-stage.js";
import { chip } from "../components.js";

export const INDUSTRIES = BUSINESS_CATEGORIES;
export const STAGES = BUSINESS_STAGES;

export const investorUid = () => state.user?.id || state.session?.user?.id || null;

/** Money is stored in rupees (not paise). Blank means the owner has not stated it. */
export const rupees = (value) =>
  value === null || value === undefined || value === ""
    ? "Not stated"
    : `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** Call an RPC and turn an error into the app's normalized error. */
export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

/** Unwrap a table query result, throwing the normalized error. */
export function unwrap({ data, error }) {
  if (error) throw normalizeError(error);
  return data;
}

/** Run a loader and keep its error, so one failing block does not blank the page. */
export async function settle(loader) {
  try {
    return { ok: true, value: await loader(), error: null };
  } catch (error) {
    return { ok: false, value: null, error: normalizeError(error) };
  }
}

export async function loadProfile(uid) {
  if (!uid) return null;
  return unwrap(await sb.from("investor_profiles").select("*").eq("user_id", uid).maybeSingle());
}

/** Goals are stored as a list of short labels. Accept a string or an object too. */
export function goalsText(goals) {
  if (!goals) return [];
  if (Array.isArray(goals)) {
    return goals.map((g) => (typeof g === "string" ? g : g?.label || g?.id || "")).filter(Boolean);
  }
  if (typeof goals === "string") return [goals];
  return [];
}

export function stageName(id) {
  return STAGES.find((s) => s.id === id)?.label || "Stage not stated";
}

export function listingCard(b, { interested = false } = {}) {
  const goals = goalsText(b.goals).slice(0, 3);
  return `<article class="card inv-card inv-rise" data-business="${esc(b.id)}">
    <div class="inv-card-head">
      <div class="inv-card-title">
        <strong class="truncate">${esc(b.name || "Untitled business")}</strong>
        <span class="field-hint">${esc(b.location || "Location not stated")}</span>
      </div>
      ${stageBadge(b.stage, { size: "sm" })}
    </div>
    <div class="inv-chips">
      ${b.category ? chip(b.category, { tone: "violet", iconName: "building-2" }) : ""}
      ${chip(rupees(b.funding_requirement_inr) === "Not stated" ? "Funding not stated" : `Seeking ${rupees(b.funding_requirement_inr)}`, { tone: "info", iconName: "target" })}
    </div>
    <p class="inv-desc">${esc((b.description || "").slice(0, 180) || "No description yet.")}</p>
    ${goals.length ? `<div class="inv-chips">${goals.map((g) => chip(g)).join("")}</div>` : ""}
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-details="${esc(b.id)}">${icon("eye", { size: 13 })} View details</button>
      ${
        interested
          ? `<span class="badge badge-ok">${icon("circle-check", { size: 12 })} Interest sent</span>`
          : `<button class="btn btn-primary btn-sm" type="button" data-interest="${esc(b.id)}">${icon("sparkles", { size: 13 })} Express interest</button>`
      }
    </div>
  </article>`;
}

export function businessDetailBody(b, { interested = false } = {}) {
  const goals = goalsText(b.goals);
  const row = (label, value) =>
    `<div class="inv-detail-row"><span class="field-hint">${esc(label)}</span><strong>${value}</strong></div>`;
  return `<div class="inv-detail">
    <div class="inv-chips">
      ${b.category ? chip(b.category, { tone: "violet", iconName: "building-2" }) : ""}
      ${b.stage ? stageBadge(b.stage, { size: "sm" }) : ""}
    </div>
    <p class="inv-detail-desc">${esc(b.description || "The owner has not written a description yet.")}</p>
    ${row("Funding sought", esc(rupees(b.funding_requirement_inr)))}
    ${row("Stage", esc(stageName(b.stage)))}
    ${row("Location", esc(b.location || "Not stated"))}
    ${goals.length ? `<div class="inv-detail-row"><span class="field-hint">Goals</span><div class="inv-chips">${goals.map((g) => chip(g)).join("")}</div></div>` : ""}
    ${b.goal_note ? `<p class="field-hint">${esc(b.goal_note)}</p>` : ""}
    <p class="field-hint inv-note">${icon("circle-check", { size: 12 })} Contact details are not shown here. Express interest and the owner is told; a pitch comes from the owner.</p>
    ${
      interested
        ? `<span class="badge badge-ok">${icon("circle-check", { size: 12 })} You expressed interest in this business</span>`
        : `<button class="btn btn-primary" type="button" data-interest="${esc(b.id)}">${icon("sparkles", { size: 14 })} Express interest</button>`
    }
  </div>`;
}

export function fmtTime(value) {
  return value ? timeAgo(value) : "";
}

export const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

export const investorName = () =>
  String(state.profile?.full_name || state.user?.user_metadata?.full_name || "there").split(" ")[0];
