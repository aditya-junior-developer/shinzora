/* ==========================================================================
   Shinzora Admin — API client
   Every privileged read/write goes through the `admin` Edge Function, which
   re-checks public.admin_users server-side. The browser never queries another
   customer's rows directly.
   ========================================================================== */

import { sb, normalizeError, getSession } from "../../lib/supabase.js";
import { api } from "../../lib/api.js";

export async function call(action, payload = {}) {
  try {
    return await api.admin.call(action, payload);
  } catch (error) {
    throw normalizeError(error);
  }
}

/** Server-side admin check via the SECURITY DEFINER function. */
export async function checkAdmin() {
  if (!sb) return { admin: false, role: null, user: null };
  const session = await getSession();
  if (!session) return { admin: false, role: null, user: null };

  // `sb.rpc()` returns a PostgREST query builder, which is thenable but has no
  // `.catch`. Calling one directly threw a TypeError and the admin console could
  // never open for anyone — admin or not. Wrap it in a real promise first, and
  // treat a missing `admin_role` function as "no role" rather than a failure.
  const [{ data: adminFlag, error }, { data: role }] = await Promise.all([
    sb.rpc("is_admin"),
    Promise.resolve(sb.rpc("admin_role")).catch(() => ({ data: null }))
  ]);

  /* public.admin_role() answers 'admin' or 'superadmin'. The pre-launch sandbox
     still calls the founding account 'owner'; normalise it here so every view
     sees one vocabulary and no permission check depends on which backend is
     answering. */
  const normalised = role === "owner" ? "superadmin" : (role ?? null);

  return {
    admin: !error && adminFlag === true,
    role: normalised,
    user: session.user
  };
}

export const adminApi = {
  overview: () => call("overview"),
  customers: (params) => call("customers", params),
  customer: (userId) => call("customer", { userId }),
  payments: (params) => call("payments", params),
  paymentReview: (params) => call("payment_review", params),
  serviceRequests: (params) => call("service_requests", params),
  serviceRequestUpdate: (params) => call("service_request_update", params),
  subscriptions: () => call("subscriptions"),
  subscriptionUpdate: (params) => call("subscription_update", params),
  projects: (params) => call("projects", params),
  deployments: () => call("deployments"),
  tickets: (params) => call("tickets", params),
  ticketReply: (params) => call("ticket_reply", params),
  ticketStatus: (params) => call("ticket_status", params),
  announcements: () => call("announcements"),
  announcementCreate: (params) => call("announcement_create", params),
  activity: (params) => call("activity", params),
  contacts: () => call("contacts"),
  contactUpdate: (params) => call("contact_update", params),
  admins: () => call("admins"),

  /* Phase 3 — migration 0009. Each of these is a SECURITY DEFINER function call;
     the database re-checks the caller's role, so these are conveniences, not
     authority. */
  directory: () => call("directory"),
  setRole: (params) => call("set_role", params),
  resetCredits: (params) => call("reset_credits", params),
  subscriptionChange: (params) => call("subscription_change", params),
  paymentDelete: (params) => call("payment_delete", params),
  archiveRecord: (params) => call("archive_record", params),
  audit: (params) => call("audit", params),
  monitor: () => call("monitor")
};

/* --------------------------------------------------------------------------
   Presence and account kind for a set of accounts.

   Read directly from `profiles` rather than through the admin function: the
   admins' RLS policy already allows selecting every profile, and the alternative
   is redeploying a 500-line Edge Function to add two columns to one response.
   Only three columns are asked for, and only for ids the console is already
   showing.
   -------------------------------------------------------------------------- */
export async function peopleMeta(ids = []) {
  if (!sb || !ids.length) return new Map();
  const { data, error } = await sb
    .from("profiles")
    .select("id, username, account_type, last_seen_at")
    .in("id", ids.slice(0, 200));
  if (error) return new Map();
  return new Map((data || []).map((row) => [row.id, row]));
}
