/* ==========================================================================
   Shinzora — page limits for the website and app builders
   --------------------------------------------------------------------------
   Plan limits on pages (websites) and screens (apps):
     Free 1 · Pro 3 · Enterprise unlimited (null)

   The database is the authority (migration 0050: sz_page_limit and the save
   and publish guards). This module only decides what the builder shows and
   what it offers, so the customer sees the limit before a save is refused.
   Pure functions, no DOM, so the rules can be tested in Node.
   ========================================================================== */

import { PLANS, PLAN_LIMITS } from "../../../config/env.js";

/** Plan id → page limit. `null` means unlimited. Unknown plans count as Free. */
export function pageLimitFor(planId) {
  const key = String(planId || "free").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PLAN_LIMITS, key)) {
    return PLAN_LIMITS[key].pages ?? null;
  }
  return PLAN_LIMITS.free.pages;
}

/**
 * The limit the server reported (project_plan_limits RPC), or the catalogue
 * value when the server did not answer. A failed lookup never grants more than
 * the Free limit.
 */
export function resolveLimit(reported, planId) {
  if (reported && typeof reported === "object" && "page_limit" in reported) {
    const limit = reported.page_limit;
    return { plan: reported.plan || planId || "free", limit: limit == null ? null : Number(limit), fromServer: true };
  }
  return { plan: planId || "free", limit: pageLimitFor(planId), fromServer: false };
}

/** How the chosen pages sit against the limit. */
export function pageState(selected = [], limit = 1) {
  const used = Array.isArray(selected) ? selected.length : 0;
  if (limit == null) {
    return { limit: null, used, remaining: null, atLimit: false, over: false, unlimited: true };
  }
  return {
    limit,
    used,
    remaining: Math.max(limit - used, 0),
    atLimit: used >= limit,
    over: used > limit,
    unlimited: false
  };
}

/** Keep at most `limit` items, in the order they were given. */
export function trimToLimit(list = [], limit = 1) {
  const items = Array.isArray(list) ? list.slice() : [];
  return limit == null ? items : items.slice(0, limit);
}

/**
 * Plans the owner could move to for more pages, cheapest first. Used to show
 * the upgrade options next to the limit. Enterprise (unlimited) is always an
 * option unless the owner is already on it.
 */
export function upgradeOptions(planId) {
  const current = pageLimitFor(planId);
  const current_id = String(planId || "free").toLowerCase();
  return PLANS.filter((plan) => {
    if (plan.id === current_id) return false;
    if (plan.pages == null) return current !== null; // unlimited beats any finite limit
    return current !== null && plan.pages > current;
  })
    .sort((a, b) => a.priceMonthly - b.priceMonthly)
    .map((plan) => ({ id: plan.id, name: plan.name, pages: plan.pages ?? null, priceMonthly: plan.priceMonthly }));
}

/** Words for a limit, for the customer: "1 page", "3 pages", "unlimited pages". */
export function limitWords(limit, noun = "page") {
  if (limit == null) return `unlimited ${noun}s`;
  return `${limit} ${noun}${limit === 1 ? "" : "s"}`;
}

/**
 * Read a save or publish refusal from the database. Returns null for anything
 * that is not one of ours, so other errors keep their normal handling.
 *
 * The database puts a JSON object in the error's hint: {"code": "page_limit"},
 * {"code": "quality", "problems": [...]} or {"code": "no_version"}.
 */
export function standardsFailure(error) {
  const raw = error && typeof error === "object" ? error.hint : null;
  let parsed = null;
  if (raw && typeof raw === "object") parsed = raw;
  else if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || !parsed.code) return null;
  if (parsed.code === "page_limit") {
    return { kind: "page_limit", plan: parsed.plan || "free", limit: parsed.limit == null ? null : Number(parsed.limit), pages: Number(parsed.pages || 0) };
  }
  if (parsed.code === "quality") {
    const problems = Array.isArray(parsed.problems) ? parsed.problems.filter((p) => p && p.title) : [];
    return { kind: "quality", problems };
  }
  if (parsed.code === "no_version") return { kind: "no_version" };
  return null;
}
