/* ==========================================================================
   Shinzora — application state
   --------------------------------------------------------------------------
   A deliberately small observable store. It holds the signed-in identity
   (profile, business, subscription) so every view renders from one source of
   truth instead of re-querying on each navigation.
   ========================================================================== */

import { sb, getSession, normalizeError } from "./supabase.js";
import { PLAN_LIMITS, planById } from "../config/env.js";

export const state = {
  session: null,
  user: null,
  profile: null,
  business: null,
  subscription: null,
  onboarding: null,
  isAdmin: false,
  unreadNotifications: 0,
  loadedAt: 0
};

const listeners = new Set();

/** Subscribe to store changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event = "change", detail = null) {
  listeners.forEach((listener) => {
    try {
      listener(event, detail, state);
    } catch (error) {
      console.error("[shinzora] store listener failed", error);
    }
  });
}

const one = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);

/**
 * Load (and cache) the signed-in identity. Safe to call repeatedly: it reuses
 * a load that is younger than `maxAge` unless `force` is set.
 */
export async function loadIdentity({ force = false, maxAge = 30000 } = {}) {
  if (!sb) return state;
  if (!force && state.loadedAt && Date.now() - state.loadedAt < maxAge) return state;

  const session = await getSession();
  state.session = session;
  state.user = session?.user || null;

  if (!session) {
    state.profile = null;
    state.business = null;
    state.subscription = null;
    state.onboarding = null;
    state.isAdmin = false;
    state.unreadNotifications = 0;
    state.loadedAt = Date.now();
    emit("identity", state);
    return state;
  }

  const userId = session.user.id;
  const [profileRes, businessRes, subRes, onboardRes, adminRes, notifRes] = await Promise.all([
    sb.from("profiles").select("*").eq("id", userId).maybeSingle(),
    sb.from("businesses").select("*").eq("owner_id", userId).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    sb.from("subscriptions").select("*").eq("user_id", userId).maybeSingle(),
    sb.from("onboarding_progress").select("*").eq("user_id", userId).maybeSingle(),
    sb.rpc("is_admin"),
    sb.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null)
  ]);

  if (profileRes.error && !/no rows/i.test(profileRes.error.message || "")) {
    // A missing table is surfaced by the views; don't hard-fail identity load.
    console.warn("[shinzora] profile load:", normalizeError(profileRes.error).message);
  }

  state.profile = one(profileRes.data);
  state.business = one(businessRes.data);
  state.subscription = one(subRes.data);
  state.onboarding = one(onboardRes.data);
  state.isAdmin = adminRes.data === true;
  state.unreadNotifications = notifRes.count || 0;
  state.loadedAt = Date.now();

  emit("identity", state);
  return state;
}

/** Clear cached identity on sign-out. */
export function resetIdentity() {
  Object.assign(state, {
    session: null,
    user: null,
    profile: null,
    business: null,
    subscription: null,
    onboarding: null,
    isAdmin: false,
    unreadNotifications: 0,
    loadedAt: 0
  });
  emit("identity", state);
}

/* --------------------------------------------------------------------------
   Derived getters
   -------------------------------------------------------------------------- */
export const planId = () => state.subscription?.plan || "free";
export const plan = () => planById(planId());
export const limits = () => PLAN_LIMITS[planId()] || PLAN_LIMITS.free;

export const displayName = () =>
  state.profile?.full_name || state.business?.name || state.user?.email?.split("@")[0] || "Founder";

export const hasCompletedOnboarding = () =>
  Boolean(state.onboarding?.completed_at) || Boolean(state.business?.name);

export const aiCredits = () => ({
  used: Number(state.subscription?.ai_credits_used || 0),
  limit: Number(state.subscription?.ai_credits_limit || limits().aiMonthlyCredits)
});

/** True when the account can create another project on its current plan. */
export async function canCreateProject() {
  if (!sb || !state.user) return { allowed: false, reason: "not_authenticated" };
  const { count, error } = await sb
    .from("projects")
    .select("id", { count: "exact", head: true })
    .in("status", ["draft", "generating", "ready", "published"]);
  if (error) return { allowed: false, reason: "error", error: normalizeError(error) };
  const limit = limits().projects;
  return { allowed: (count || 0) < limit, used: count || 0, limit, reason: (count || 0) < limit ? null : "plan_limit" };
}

/**
 * Where a signed-in user should land right now.
 *
 * Administrators always land in the console. The previous rule only sent them
 * there when they had NOT completed onboarding, so the moment an administrator
 * created a business — which the onboarding wizard encourages — the same account
 * started landing in the customer dashboard and looked like an ordinary plan
 * user. `state.isAdmin` comes from the server-side is_admin() function, never
 * from a name, an email pattern or anything the browser can set.
 */
export function landingPath() {
  if (!state.session) return "/auth/login/";
  if (state.isAdmin) return "/admin/";
  return hasCompletedOnboarding() ? "/app/" : "/onboarding/";
}
