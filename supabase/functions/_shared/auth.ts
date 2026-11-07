// ============================================================================
// Shinzora Edge Functions — service client + authenticated caller
// ----------------------------------------------------------------------------
// The service-role key never leaves this runtime. Functions use it for writes
// that a browser must never be able to perform (payments, admin, quotas), and
// always verify the caller's JWT before doing anything on their behalf.
// ============================================================================

import { createClient, SupabaseClient, User } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

let adminClient: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS — use deliberately, never for caller-scoped reads. */
export function admin(): SupabaseClient {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured for this function.");
  }
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return adminClient;
}

export type Caller = { user: User; token: string };

/**
 * Verify the caller's access token. Returns null when the token is missing or
 * invalid so callers can answer 401 instead of continuing anonymously.
 */
export async function getCaller(req: Request): Promise<Caller | null> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === ANON_KEY) return null;

  try {
    const client = createClient(SUPABASE_URL, ANON_KEY || token, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return { user: data.user, token };
  } catch {
    return null;
  }
}

/** Caller-scoped client: every query runs with the user's own JWT and RLS. */
export function scoped(caller: Caller): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY || caller.token, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function isAdmin(userId: string): Promise<boolean> {
  const { data, error } = await admin()
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data && ["admin", "superadmin"].includes(data.role));
}

export async function requireAdmin(req: Request): Promise<{ caller: Caller } | { response: Response }> {
  const caller = await getCaller(req);
  if (!caller) {
    return {
      response: new Response(JSON.stringify({ code: "unauthorized", error: "Sign in to continue." }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      })
    };
  }
  const ok = await isAdmin(caller.user.id);
  if (!ok) {
    return {
      response: new Response(
        JSON.stringify({ code: "forbidden", error: "Administrator access is required for this action." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    };
  }
  return { caller };
}
