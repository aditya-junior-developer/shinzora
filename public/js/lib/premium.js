/* ==========================================================================
   Premium profiles — the view of a member's tier (P6)
   --------------------------------------------------------------------------
   Pure functions over rows the database returned. They decide what the UI
   shows and which purchase buttons are offered. They do not decide what is
   allowed: the gateway refuses a purchase the member already holds, the
   database refuses an accent outside the palette, and only the admin function
   activates a tier. A hidden button is never the check.
   ========================================================================== */

import { PREMIUM_TIERS } from "../config/env.js";

export const TIER_RANK = Object.freeze({ glow: 1, elite: 2 });

/** The member's active tier id, or null for Free. */
export function activeTier(entitlement) {
  const tier = entitlement?.tier;
  return tier && TIER_RANK[tier] ? tier : null;
}

/** Tiers the member can still buy: anything above the one they hold. */
export function buyableTiers(entitlement) {
  const rank = TIER_RANK[activeTier(entitlement)] ?? 0;
  return PREMIUM_TIERS.filter((tier) => TIER_RANK[tier.id] > rank);
}

/** Orders waiting for activation, newest first. Paid but not yet live. */
export function pendingOrders(orders = []) {
  return orders
    .filter((order) => order?.status === "awaiting_activation")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Hours left before an order is due, never negative. */
export function hoursUntilDue(order, now = Date.now()) {
  const due = Date.parse(order?.due_by);
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.round(((due - now) / 36e5) * 10) / 10);
}

/** Plain-language status for the billing card. */
export function statusLine(entitlement, orders = []) {
  const tier = activeTier(entitlement);
  const pending = pendingOrders(orders);
  if (tier && pending.length) {
    return `${label(tier)} is active. A further order is waiting for activation.`;
  }
  if (tier) return `${label(tier)} is active on your profile.`;
  if (pending.length) {
    const next = pending[0];
    const hours = hoursUntilDue(next);
    return `Payment for ${label(next.tier)} is confirmed. We activate it within 24 hours${
      hours === null ? "" : ` (about ${Math.ceil(hours)} h left)`
    }.`;
  }
  return "Your profile is on the Free plan. Premium profiles are one-time purchases.";
}

function label(id) {
  return PREMIUM_TIERS.find((tier) => tier.id === id)?.name || id;
}
