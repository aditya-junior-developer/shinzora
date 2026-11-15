/* ==========================================================================
   Shinzora · Plan and profile status, live
   --------------------------------------------------------------------------
   An administrator's approval writes the payment, the subscription and the
   premium entitlement in one database step (0054, 0060). This module listens
   for those rows over Supabase Realtime, so the member's open dashboard shows
   the new plan or profile at once: no logout, no login, no refresh.

   - Realtime applies row-level security, so only this member's rows arrive.
   - The browser never decides a tier. On any change it re-reads the identity
     from the database (loadIdentity) and then reports what it found.
   - Views listen for PREMIUM_EVENT and repaint from the database state.
   ========================================================================== */

import { sb } from "./supabase.js";
import { openLiveChannel, closeLiveChannel } from "./live-channel.js";
import { loadIdentity, state, applyShellIdentity } from "./store.js";
import { activeTier } from "./premium.js";
import { toast } from "../ui/toast.js";

export const PREMIUM_EVENT = "shinzora:premium-changed";

const KEY = "premium-live";
const TIER_NAME = { glow: "Glow", elite: "Elite" };

let listening = null;

/** Start listening for this member's plan, payment and profile changes. */
export function subscribePremiumLive(userId) {
  if (!sb || !userId) return;
  if (listening === userId) return;
  listening = userId;

  openLiveChannel(sb, KEY, {
    topic: `premium:${userId}`,
    bind: (channel) =>
      channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "profile_entitlements", filter: `user_id=eq.${userId}` },
          (payload) => refresh("profile_entitlements", payload)
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "subscriptions", filter: `user_id=eq.${userId}` },
          (payload) => refresh("subscriptions", payload)
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "payments", filter: `owner_id=eq.${userId}` },
          (payload) => refresh("payments", payload)
        )
  });
}

/** Stop listening (sign-out, or the user changed). */
export function unsubscribePremiumLive() {
  listening = null;
  return closeLiveChannel(KEY);
}

async function refresh(table, payload) {
  const before = activeTier(state.entitlement);
  const previousPlan = state.subscription?.plan || null;

  try {
    await loadIdentity({ force: true });
  } catch {
    /* Keep what is on screen; the next event or a reload will correct it. */
    return;
  }
  applyShellIdentity();

  const after = activeTier(state.entitlement);
  const plan = state.subscription?.plan || null;
  const tierChanged = before !== after;
  const planChanged = previousPlan !== plan;

  if (tierChanged && after) {
    toast({ title: `${TIER_NAME[after] || "Premium"} profile is live`, body: "It is active on your account now." }, { tone: "success" });
  } else if (planChanged && plan && plan !== "free") {
    toast({ title: "Your plan is active", body: "The new plan applies to your account now." }, { tone: "success" });
  }

  document.dispatchEvent(
    new CustomEvent(PREMIUM_EVENT, {
      detail: { table, event: payload?.eventType || null, tier: after, previousTier: before, plan, previousPlan }
    })
  );
}
