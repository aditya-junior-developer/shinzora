/* ==========================================================================
   Shinzora — shared view components
   Pure functions that return HTML strings. Views compose these and then bind
   behaviour in their own mount function.
   ========================================================================== */

import { esc, raw } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { statusLabel, statusTone, timeAgo, date, money } from "../../lib/format.js";
import { avatarMarkup } from "../../lib/avatar.js";

/* --------------------------------------------------------------- page head */
export function pageHead({ title, desc = "", actions = "", badge = "" }) {
  return `<div class="page-head">
    <div class="page-head-left">
      <h1 class="page-title">${esc(title)} ${badge}</h1>
      ${desc ? `<p class="page-desc">${esc(desc)}</p>` : ""}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </div>`;
}

/* ------------------------------------------------------------- setup notice */
export function setupNotice(error, context = "This section") {
  const isSchema = error?.code === "schema_missing";
  /* A missing provider key is not a deployment problem: the service is running
     and the variable is the only thing absent. Say that instead of telling the
     operator to deploy anything. */
  const isConfig = error?.code === "ai_unconfigured";
  const isFunctions = !isConfig && (error?.code === "functions_unavailable" || error?.code === "fn_error");
  return `<div class="setup-banner">
      ${icon("triangle-alert", { size: 18 })}
      <div>
        <strong>${isSchema ? "Database not initialised" : isConfig ? "AI provider key missing" : isFunctions ? "Service function not deployed" : "Could not load data"}</strong><br />
        ${
          isSchema
            ? `${context} needs the Shinzora tables. Apply <code>supabase/migrations</code> in order, then reload.`
            : isConfig
            ? `${context} is wired and running; the deployment has no AI provider key yet.`
            : isFunctions
            ? `${context} requires the Supabase Edge Function to be deployed. Run <code>supabase functions deploy</code> and set the required secrets.`
            : esc(error?.message || "Unexpected error.")
        }
        ${error?.hint ? `<br /><span class="dim" style="font-size:var(--fs-2xs)">${esc(error.hint)}</span>` : ""}
        <br /><a href="/system-check/">Open system check</a>
      </div>
    </div>`;
}

/* ------------------------------------------------------------- empty state */
export function emptyState({ icon: iconName = "sparkles", title, desc, action = "" }) {
  return `<div class="empty">
      <div class="empty-mark">${icon(iconName, { size: 22 })}</div>
      <div class="empty-title">${esc(title)}</div>
      <p class="empty-desc">${esc(desc)}</p>
      ${action}
    </div>`;
}

/* -------------------------------------------------------------- stat cards */
/* `href` is optional: most stat cards are just numbers, but a card that
   corresponds to a screen ("Pitches sent") should be able to open it. When
   present the same markup becomes a link, so the layout does not shift. */
export function statCard({ label, value, foot = "", iconName = "chart-line", tone = "", href = "" }) {
  const inner = `
      <div class="stat-head">
        <span class="stat-label">${icon(iconName, { size: 13 })}${esc(label)}</span>
      </div>
      <div class="stat-value">${value}</div>
      ${foot ? `<div class="stat-foot ${tone}">${foot}</div>` : ""}`;
  if (!href) return `<div class="stat">${inner}</div>`;
  return `<a class="stat stat-link" href="${esc(href)}">${inner}</a>`;
}

/* ----------------------------------------------------------------- badges */
export function statusBadge(status) {
  const tone = statusTone(status);
  return `<span class="badge badge-${tone}"><span class="dot"></span>${esc(statusLabel(status))}</span>`;
}

export function chip(text, { tone = "neutral", iconName = "" } = {}) {
  return `<span class="badge badge-${tone}">${iconName ? icon(iconName, { size: 11 }) : ""}${esc(text)}</span>`;
}

/* --------------------------------------------------------------- data table */
/**
 * @param {{columns:Array<{key:string,label:string,className?:string,render?:Function}>,
 *          rows:Array<object>, empty?:string, rowKey?:string}} options
 */
export function dataTable({ columns, rows, empty = "Nothing here yet.", rowKey = "id" }) {
  if (!rows?.length) {
    return emptyState({ icon: "inbox", title: "Nothing to show yet", desc: empty });
  }
  const head = columns
    .map((col) => `<th${col.className ? ` class="${col.className}"` : ""}>${esc(col.label)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const value = col.render ? col.render(row) : esc(row[col.key] ?? "—");
          /* `data-label` is what the phone layout uses to print the column name
             beside each value once the header row is gone. Without it a stacked
             table on a small screen is a list of values with no meaning. */
          return `<td data-label="${esc(col.label)}"${col.className ? ` class="${col.className}"` : ""}>${value}</td>`;
        })
        .join("");
      return `<tr data-row="${esc(row[rowKey] ?? "")}">${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ------------------------------------------------------------- misc pieces */
export function skeletonView(rows = 4) {
  return `<div class="card card-pad-lg">
      <div class="skeleton skeleton-line" style="width:32%;height:16px"></div>
      <div style="height:14px"></div>
      ${Array.from({ length: rows })
        .map(
          () => `<div class="skeleton-row">
            <div class="skeleton" style="width:34px;height:34px;border-radius:10px"></div>
            <div class="grow">
              <div class="skeleton skeleton-line" style="width:52%"></div>
              <div style="height:8px"></div>
              <div class="skeleton skeleton-line" style="width:34%;height:9px"></div>
            </div>
          </div>`
        )
        .join("")}
    </div>`;
}

/**
 * A person (or a business) as a picture when one is stored, initials otherwise.
 *
 * The fourth argument is new: uploads have always been saved to
 * `profiles.avatar_url`, but the renderer only ever knew how to draw initials,
 * so three screens disagreed about what a person looked like.
 */
export function avatar(name, email, size = "", avatarUrl = null, fit = "cover") {
  return avatarMarkup({ name, email, avatarUrl, size, fit });
}

export function metaRow(parts) {
  /* The separator carries a class so the phone layout can hide it: a "·" that
     wraps to the start of a line reads as a bullet with nothing to introduce. */
  const real = parts.filter((part) => part && String(part).replace(/<[^>]*>/g, "").trim().length);
  return `<div class="project-meta">${real.join('<span class="meta-sep" aria-hidden="true">·</span>')}</div>`;
}

export const fmt = { timeAgo, date, money, statusLabel };

/** Compose an action button. */
export function actionButton({ label, iconName = "", variant = "secondary", attrs = "", size = "sm" }) {
  return `<button class="btn btn-${variant} btn-${size}" ${attrs}>${iconName ? icon(iconName, { size: 14 }) : ""}${esc(
    label
  )}</button>`;
}

export { raw, esc };
