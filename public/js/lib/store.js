/* ==========================================================================
   Shinzora — application state
   --------------------------------------------------------------------------
   A deliberately small observable store. It holds the signed-in identity
   (profile, business, subscription) so every view renders from one source of
   truth instead of re-querying on each navigation.
   ========================================================================== */

import { sb, getSession, normalizeError } from "./supabase.js";
import { PLAN_LIMITS, planById } from "../config/env.js";
import { adoptProfileTheme } from "../ui/theme.js";

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
  /* Named so a failure can be reported against the thing that actually broke,
     and settled individually: one denied query used to reject the whole batch
     and blank the dashboard. A missing subscription row must not cost the user
     their profile. */
  const calls = {
    profile: () => sb.from("profiles").select("*").eq("id", userId).maybeSingle(),
    business: () => sb.from("businesses").select("*").eq("owner_id", userId).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    subscription: () => sb.from("subscriptions").select("*").eq("user_id", userId).maybeSingle(),
    onboarding: () => sb.from("onboarding_progress").select("*").eq("user_id", userId).maybeSingle(),
    admin: () => sb.rpc("is_admin"),
    notifications: () => sb.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null)
  };
  const names = Object.keys(calls);
  /* supabase-js query builders are thenables, not Promises — they have no
     .catch — so wrap before attaching one. */
  const settled = await Promise.allSettled(
    names.map((name) => Promise.resolve(calls[name]()).catch((error) => ({ __threw: error })))
  );
  const result = {};
  const failures = [];
  settled.forEach((entry, index) => {
    const name = names[index];
    if (entry.status === "rejected") {
      failures.push({ area: name, error: entry.reason });
      result[name] = null;
      return;
    }
    const value = entry.value;
    if (value && value.__threw) {
      failures.push({ area: name, error: value.__threw });
      result[name] = null;
      return;
    }
    if (value && value.error && !/no rows/i.test(value.error.message || "")) {
      failures.push({ area: name, error: value.error });
    }
    result[name] = value;
  });

  state.identityFailures = failures;
  if (failures.length) {
    console.warn(
      "[shinzora] identity partial:",
      failures.map((f) => `${f.area}: ${normalizeError(f.error).message}`).join(" | ")
    );
  }

  state.profile = one(result.profile?.data);
  /* The account's saved theme seeds a device that has never chosen one. The
     inline pre-paint script has already painted the local preference, so this
     only ever changes anything on a fresh browser. */
  if (state.profile?.theme) adoptProfileTheme(state.profile.theme);
  state.business = one(result.business?.data);
  state.subscription = one(result.subscription?.data);
  state.onboarding = one(result.onboarding?.data);
  state.isAdmin = result.admin?.data === true;
  state.unreadNotifications = result.notifications?.count || 0;
  state.loadedAt = Date.now();

  if (state.profile) {
    rememberIdentity({
      userId,
      fullName: state.profile.full_name || "",
      accountType: state.profile.account_type || "owner",
      businessName: state.business?.name || ""
    });
  }

  emit("identity", state);
  return state;
}

/* --------------------------------------------------------------------------
   Remembering just enough to paint the right shell
   --------------------------------------------------------------------------
   Identity lives in memory, so a page load during an outage had nothing to
   paint with: an agent saw the business-owner navigation (or, before the boot
   fix, nothing at all). These three facts — who they are, which kind of account
   they have, and their business name — are all the chrome needs. Nothing
   sensitive, nothing authoritative: the database still decides every
   permission, this only decides which links to draw.
   -------------------------------------------------------------------------- */

const IDENTITY_CACHE_KEY = "shinzora.identity.shell";

function identityStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The last known shell-relevant identity, or null. Never throws. */
export function cachedIdentity() {
  const store = identityStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(IDENTITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function rememberIdentity(data) {
  const store = identityStorage();
  if (!store) return;
  try {
    if (!data || !data.userId) {
      store.removeItem(IDENTITY_CACHE_KEY);
      return;
    }
    store.setItem(IDENTITY_CACHE_KEY, JSON.stringify(data));
  } catch {
    /* private mode or a full quota: the cache is a convenience, not a need */
  }
}

/**
 * Seed the in-memory profile from the remembered shell identity, for a boot
 * that could not load it. Deliberately minimal — id, name and account type are
 * what the chrome reads — and overwritten by the real row on the next
 * successful load. Permissions never come from here.
 * @returns {boolean} whether anything was seeded
 */
export function applyShellIdentity() {
  if (state.profile) return false;
  const remembered = cachedIdentity();
  if (!remembered) return false;
  state.profile = {
    id: remembered.userId || null,
    full_name: remembered.fullName || "",
    account_type: remembered.accountType === "agent" ? "agent" : "owner",
    __provisional: true
  };
  return true;
}

/**
 * Paint-able identity for a boot that cannot reach the database.
 * Uses the live state when it is there, otherwise the last known values.
 */
export function shellIdentity() {
  if (state.profile) {
    return {
      userId: state.user?.id || null,
      fullName: state.profile.full_name || "",
      accountType: state.profile.account_type || "owner",
      businessName: state.business?.name || ""
    };
  }
  return cachedIdentity();
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
    identityFailures: [],
    loadedAt: 0
  });
  rememberIdentity(null);
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
  Boolean(state.onboarding?.completed_at || state.onboarding?.is_completed) || Boolean(state.business?.name);

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
