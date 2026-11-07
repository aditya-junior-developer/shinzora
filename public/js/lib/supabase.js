/* ==========================================================================
   Shinzora — Supabase client + error normalisation
   --------------------------------------------------------------------------
   A single shared client instance for every surface. Session persistence is
   handled by supabase-js (localStorage + auto refresh). Every database error
   passes through normalizeError() so the UI can show an accurate message —
   including the very common "schema not installed yet" case.
   ========================================================================== */

import { env } from "../config/env.js";
import * as prelaunch from "./prelaunch.js";
import {
  hasPrelaunchHint, clearPrelaunchHint, withTimeout, SIGN_OUT_LIMIT_MS
} from "./session-policy.js";

const lib = typeof window !== "undefined" ? window.supabase : null;

export const hasSupabaseLib = Boolean(lib && typeof lib.createClient === "function");

if (!hasSupabaseLib && typeof console !== "undefined") {
  console.error("[shinzora] supabase-js failed to load. Check /js/vendor/supabase-js.js");
}

/** @type {import("@supabase/supabase-js").SupabaseClient|null} */
export const sb = hasSupabaseLib
  ? lib.createClient(env.supabaseUrl, env.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        /* MUST stay false. With detectSessionInUrl:true supabase-js exchanges
           the ?code= on our /auth/callback/ page as soon as it initialises, and
           the app also called exchangeCodeForSession() for the same code. One
           of the two always lost the race and reported "PKCE code verifier not
           found in storage" — the intermittent OAuth failure. The exchange now
           happens exactly once, in auth-service.completeRedirect(). */
        detectSessionInUrl: false,
        flowType: "pkce",
        storageKey: "shinzora.auth"
      },
      global: {
        headers: { "x-client-info": "shinzora-web/1.0" },
        /* Every database / storage / function call made by supabase-js passes
           through here. With a pre-launch account signed in, the request is
           routed to the Shinzora server (which holds the account and the data);
           otherwise it goes to the Supabase project untouched. */
        fetch: prelaunch.prelaunchFetch
      },
      db: { schema: "public" }
    })
  : null;

/* Sandbox uploads live on the Shinzora server, so public storage URLs must
   point there while a pre-launch account is signed in. */
if (sb) prelaunch.patchStorage(sb);

/* Start the server-session probe in the background and install the error
   reporter. Both are no-ops unless a pre-launch account is signed in. */
try {
  prelaunch.boot();
} catch (error) {
  console.warn("[shinzora] pre-launch bridge unavailable:", error?.message);
}

/* --------------------------------------------------------------------------
   Typed application error
   -------------------------------------------------------------------------- */
export class AppError extends Error {
  constructor(message, { code = "app_error", detail = "", hint = "", status = 0, retryable = false } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.hint = hint;
    this.status = status;
    this.retryable = retryable;
  }
}

const MIGRATION_HINT =
  "The Shinzora database schema is not installed on this Supabase project yet. Run the SQL files in supabase/migrations in order (SQL Editor or `supabase db push`), then reload this page.";

/* Which migration creates which object. When the schema cache says a relation
   is missing, naming the file is the difference between a five-minute fix and
   an afternoon. Only objects introduced after 0005 are listed — those are the
   ones a deployed project can actually be missing. */
const OBJECT_MIGRATIONS = {
  service_request_notes: "0006_service_request_tracking.sql",
  migration_notes: "0007_customer_reference_uniqueness.sql",
  payment_webhook_events: "0008_payment_webhook_idempotency.sql",
  admin_audit: "0009_admin_authority_and_audit.sql",
  subscription_events: "0009_admin_authority_and_audit.sql",
  ai_generation_jobs: "0011_generation_conversion_marketing.sql",
  conversion_jobs: "0011_generation_conversion_marketing.sql",
  marketing_accounts: "0011_generation_conversion_marketing.sql",
  marketing_requests: "0011_generation_conversion_marketing.sql",
  marketing_request_events: "0011_generation_conversion_marketing.sql"
};

function missingObjectHint(rawMessage) {
  const match = String(rawMessage || "").match(/(?:relation|table|column)\s+"?(?:public\.)?([a-z_]+)"?/i);
  const file = match && OBJECT_MIGRATIONS[match[1].toLowerCase()];
  if (!file) return MIGRATION_HINT;
  return `The "${match[1]}" table is not in this database. It is created by supabase/migrations/${file}, which has not been applied yet. Apply migrations 0006 to 0013 in order, then reload.`;
}

/**
 * Convert anything thrown by supabase-js / fetch / Postgres into an AppError
 * with an honest, actionable message.
 */
export function normalizeError(error) {
  if (!error) return new AppError("Something went wrong.", { code: "unknown" });
  if (error instanceof AppError) return error;

  const code = error.code || error.error_code || "";
  const status = Number(error.status || error.statusCode || 0);
  const rawMessage = error.message || error.error_description || String(error);
  const hint = error.hint || "";

  // PostgREST: table / column missing → migrations not applied
  if (code === "42P01" || code === "PGRST205" || code === "42703" || /schema cache/i.test(rawMessage)) {
    return new AppError("Database not initialised", { code: "schema_missing", detail: rawMessage, hint: missingObjectHint(rawMessage), status });
  }
  if (code === "42501" || status === 403 || /row-level security|permission denied/i.test(rawMessage)) {
    return new AppError("You do not have access to this resource.", {
      code: "rls_denied",
      detail: rawMessage,
      hint: "Row Level Security blocked the request. Sign in with an account that owns this data.",
      status
    });
  }
  if (code === "PGRST301" || status === 401 || /jwt|token/i.test(rawMessage)) {
    return new AppError("Your session has expired. Please sign in again.", { code: "session_expired", status });
  }
  if (code === "23505" || status === 409) {
    return new AppError("That record already exists.", { code: "conflict", detail: rawMessage, status });
  }
  if (code === "23514" || code === "23503") {
    return new AppError("Some of the submitted values are not valid.", { code: "constraint", detail: rawMessage, status });
  }
  if (code === "rate_limited" || status === 429) {
    return new AppError("Too many requests. Please wait a moment and try again.", { code: "rate_limited", status, retryable: true });
  }
  if (/failed to fetch|networkerror|load failed/i.test(rawMessage)) {
    return new AppError("Network unavailable. Check your connection and retry.", { code: "network", retryable: true });
  }
  if (/invalid login credentials/i.test(rawMessage)) {
    return new AppError("Email or password is incorrect.", { code: "invalid_credentials", status });
  }
  if (/email not confirmed/i.test(rawMessage)) {
    return new AppError("Confirm your email address first — check your inbox for the Shinzora verification link.", {
      code: "email_unconfirmed",
      status
    });
  }
  /* The provider accepted the sign-up but could not send the mail: no SMTP
     configured, quota reached, or a rejected sender. Saying "check your inbox"
     to this is a lie, so it is named. */
  if (/error sending (confirmation|recovery|invite|magic link)|smtp|failed to send email/i.test(rawMessage)) {
    return new AppError("The confirmation email could not be sent.", {
      code: "email_send_failed",
      detail: rawMessage,
      hint: "The mail server is not configured, or its daily limit is reached. This needs Supabase → Authentication → Emails (SMTP settings). Your account exists — an administrator can confirm the address, or you can sign in once mail is restored.",
      status
    });
  }
  if (/email rate limit exceeded|you can only request this after/i.test(rawMessage)) {
    const wait = rawMessage.match(/after (\d+) seconds/i)?.[1];
    return new AppError("Too many emails requested.", {
      code: "email_rate_limited",
      detail: rawMessage,
      hint: wait
        ? `The mail service asked to wait ${wait} seconds before the next request.`
        : "The mail service limits how often it will send to one address. Wait a few minutes and try again.",
      status: 429,
      retryable: true
    });
  }
  if (/redirect_uri_mismatch|redirect url.*(not allowed|invalid)|invalid request: redirect/i.test(rawMessage)) {
    return new AppError("This site is not registered for sign-in redirects.", {
      code: "redirect_not_allowed",
      detail: rawMessage,
      hint: "Add this exact URL to Supabase → Authentication → URL Configuration → Redirect URLs (and to the Google console if you use Google sign-in).",
      status
    });
  }
  if (/user already registered|already exists/i.test(rawMessage)) {
    return new AppError("An account with this email already exists. Try signing in instead.", { code: "user_exists", status });
  }
  if (/password should be at least|weak.?password/i.test(rawMessage)) {
    return new AppError("Choose a stronger password — at least 8 characters with a letter and a number.", { code: "weak_password" });
  }
  if (/functions? (not found|relates)|Failed to send a request to the Edge Function|404/i.test(rawMessage) && /function/i.test(rawMessage)) {
    return new AppError("The Shinzora service function is not deployed yet.", {
      code: "functions_unavailable",
      detail: rawMessage,
      hint: "Deploy the Edge Functions with `supabase functions deploy ai domains payments admin integrations site config`, then retry.",
      status
    });
  }

  return new AppError(rawMessage || "Unexpected error.", { code: code || "unknown", detail: hint, status });
}

/** Throw a normalized error when a Supabase response carries one. */
export function unwrap({ data, error }) {
  if (error) throw normalizeError(error);
  return data;
}

/* --------------------------------------------------------------------------
   Auth helpers
   -------------------------------------------------------------------------- */
export async function getSession() {
  /* A pre-launch account is authenticated by the Shinzora server, not by
     Supabase Auth. Its session is shaped like a supabase-js session so every
     guard, view and helper in the app keeps working unchanged.

     The probe is only awaited when this browser has actually used a sandbox
     account. Otherwise a cold serverless hop used to sit in front of every
     page's session lookup, which made refresh feel like a logout. */
  const pl = hasPrelaunchHint() ? await prelaunch.session() : prelaunch.current();
  if (pl) return prelaunch.asSupabaseSession(pl);
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error) throw normalizeError(error);
  return data.session || null;
}

export async function getUser() {
  const pl = hasPrelaunchHint() ? await prelaunch.session() : prelaunch.current();
  if (pl) return prelaunch.asSupabaseSession(pl).user;
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data?.user || null;
}

/**
 * Sign out of this browser.
 *
 * Bounded on purpose: `scope: "local"` revokes only this session, but the call
 * still goes to the auth server, and an unreachable or slow auth endpoint used
 * to leave the Sign out button spinning indefinitely. It now gives the server
 * SIGN_OUT_LIMIT_MS and then finishes locally regardless — the refresh token is
 * dropped from storage either way, so the browser is genuinely signed out even
 * when the network never answers. Other devices are never touched.
 */
export async function signOut(scope = "local") {
  if (prelaunch.active() || hasPrelaunchHint()) {
    await prelaunch.signOut();
    clearPrelaunchHint();
    return;
  }
  if (!sb) return;

  const attempt = sb.auth.signOut({ scope }).then(
    ({ error }) => (error ? normalizeError(error) : null),
    (error) => normalizeError(error)
  );
  const failure = await withTimeout(attempt, SIGN_OUT_LIMIT_MS, null);

  /* If the server refused for a reason that leaves the session intact (for
     example a 5xx), remove it locally so the UI cannot keep showing a session
     the user asked to end. */
  if (failure) {
    try {
      await sb.auth.signOut({ scope: "local" });
    } catch {
      /* storage already empty */
    }
  }
}

export function onAuthStateChange(callback) {
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange(callback);
  return () => data?.subscription?.unsubscribe?.();
}

/** Upload a file to a user-scoped storage folder and return its public URL. */
export async function uploadPublic(bucket, userId, file, prefix = "file") {
  if (!sb) throw new AppError("Client not ready.");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${userId}/${prefix}-${Date.now()}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "application/octet-stream"
  });
  if (error) throw normalizeError(error);
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/** Signed URL for private buckets (payment screenshots). */
export async function signedUrl(bucket, path, expiresIn = 3600) {
  if (!sb) throw new AppError("Client not ready.");
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error) throw normalizeError(error);
  return data.signedUrl;
}

export default sb;
