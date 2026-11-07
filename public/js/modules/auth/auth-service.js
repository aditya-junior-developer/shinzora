/* ==========================================================================
   Shinzora — authentication service
   --------------------------------------------------------------------------
   Thin, explicit wrappers over supabase-js auth so every page behaves the same
   way: normalised errors, honest messaging, no silent failures.
   ========================================================================== */

import { sb, normalizeError, AppError, getSession } from "../../lib/supabase.js";
import * as prelaunch from "../../lib/prelaunch.js";
import { authRedirect } from "../../config/env.js";

function client() {
  if (!sb) throw new AppError("Authentication is unavailable — the client failed to load.", { code: "client_missing" });
  return sb;
}

/** Create an account. Returns { user, session, needsVerification }. */
export async function signUp({ fullName, email, password, plan = "free", next = "/onboarding/" }) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, plan, source: "web" },
      emailRedirectTo: authRedirect(`/auth/callback/?next=${encodeURIComponent(next)}`)
    }
  });
  if (error) throw normalizeError(error);

  /* Supabase answers an address that is already registered with a user object
     and NO identities, deliberately, so the endpoint cannot be used to discover
     accounts. The old code treated that as "needs verification" and sent the
     person to a page telling them to wait for an email that was never sent —
     which is one of the ways "the confirmation email never arrived".
     Say what actually happened, without confirming anything an attacker could
     not already learn: they have to know the address to see this message. */
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new AppError("An account already exists for this email.", {
      code: "user_exists",
      hint: "Sign in instead. If you never received the confirmation email, use “Forgot password” to get a fresh link — it verifies the address the same way."
    });
  }

  return {
    user: data.user,
    session: data.session,
    needsVerification: Boolean(data.user && !data.session),
    /* The provider accepted the request but could not send the mail. Surfaced so
       the verify screen can say "the mail server is not configured" instead of
       "check your inbox, it usually arrives in a minute". */
    emailSent: !data?.user || Boolean(data.session) || data.user.confirmed_at != null
  };
}

/**
 * Email + password sign in.
 *
 * The two pre-launch accounts are verified by the Shinzora server before
 * Supabase Auth is touched. Every other address falls straight through to
 * Supabase, so normal customer sign-in is byte-for-byte unchanged.
 */
export async function signIn({ email, password }) {
  const attempt = await prelaunch.signIn(email, password);
  if (attempt.handled) {
    await touchLastSignIn();
    return attempt.session;
  }

  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw normalizeError(error);
  if (!data.session) throw new AppError("Sign in did not return a session. Confirm your email first.", {
    code: "no_session",
    hint: "Check your inbox for the Shinzora verification email, then try again."
  });
  await touchLastSignIn();
  return data.session;
}

/** Google OAuth — redirects the browser to Google. */
export async function signInWithGoogle({ next = "/app/" } = {}) {
  const { error } = await client().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: authRedirect(`/auth/callback/?next=${encodeURIComponent(next)}`),
      queryParams: { access_type: "offline", prompt: "consent" }
    }
  });
  if (error) {
    const normalized = normalizeError(error);
    if (/provider is not enabled|unsupported provider/i.test(normalized.message)) {
      throw new AppError("Google sign-in is not enabled on this project yet.", {
        code: "provider_disabled",
        hint: "Enable Google in Supabase → Authentication → Providers and add the client ID and secret."
      });
    }
    throw normalized;
  }
}

/** Resend a verification email. */
export async function resendVerification(email) {
  const { error } = await client().auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: authRedirect("/auth/callback/?next=/onboarding/") }
  });
  if (error) throw normalizeError(error);
  return true;
}


/**
 * Supabase speaks to developers, not to customers. These three failures are the
 * ones a real link produces, and each has a different fix, so each gets its own
 * sentence instead of "PKCE code verifier not found in storage".
 */
function linkError(error) {
  const raw = String(error?.message || "");
  if (/code verifier|bad_code_verifier/i.test(raw)) {
    return new AppError(
      "This link was opened in a different browser or on another device than the one that asked for it.",
      {
        code: "link_wrong_browser",
        hint: "Send a new link and open it in the same window you asked from — that is the only thing that changes the outcome."
      }
    );
  }
  if (/expired/i.test(raw)) {
    return new AppError("This link has expired.", {
      code: "link_expired",
      hint: "Links are valid for one hour. Request a new one and it will work."
    });
  }
  if (/invalid|already|used|not found/i.test(raw)) {
    return new AppError("This link is no longer valid.", {
      code: "link_invalid",
      hint: "A link works once. Request a new one if you still need to finish."
    });
  }
  return normalizeError(error);
}

/** Start a password recovery flow. */
export async function requestPasswordReset(email) {
  const { error } = await client().auth.resetPasswordForEmail(email, {
    redirectTo: authRedirect("/auth/callback/?next=/auth/reset-password/")
  });
  if (error) throw normalizeError(error);
  return true;
}

/** Set a new password for the signed-in (recovery) session. */
export async function updatePassword(password) {
  const { error } = await client().auth.updateUser({ password });
  if (error) throw normalizeError(error);
  return true;
}

/**
 * Complete an email / OAuth redirect.
 * Supports both PKCE (`?code=`) and implicit (`#access_token=`) returns, so a
 * mis-configured Supabase redirect URL still lands the user in the right place.
 */
export async function completeRedirect(searchParams = new URLSearchParams(location.search)) {
  const code = searchParams.get("code");
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const errorDescription = searchParams.get("error_description") || hash.get("error_description");

  if (errorDescription) {
    throw new AppError(decodeURIComponent(errorDescription.replace(/\+/g, " ")), { code: "auth_redirect_error" });
  }

  if (code) {
    const { data, error } = await client().auth.exchangeCodeForSession(code);
    if (error) {
      /* A code that is already spent usually means this link was opened twice,
         or the exchange completed in another tab. If a session is live, the
         user is signed in — sending them back to "request a new link" would be
         wrong. Only a real absence of a session is a link problem. */
      const existing = await getSession().catch(() => null);
      if (existing) return existing;
      throw linkError(error);
    }
    return data.session;
  }

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (accessToken && refreshToken) {
    const { data, error } = await client().auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) throw linkError(error);
    return data.session;
  }

  // Already exchanged (e.g. supabase-js detectSessionInUrl) — use what we have.
  return getSession();
}

/** Record a best-effort sign-in timestamp for the customer_activity log. */
async function touchLastSignIn() {
  try {
    const session = await getSession();
    if (!session?.user) return;
    await sb.from("profiles").update({ last_sign_in_at: new Date().toISOString() }).eq("id", session.user.id);
    await sb.rpc("log_activity", { p_action: "signed_in", p_entity_type: "profile", p_entity_id: session.user.id, p_meta: {} });
  } catch {
    // Non-critical: never block a successful sign-in on telemetry.
  }
}

/** Coarse password score (0–4) used by the strength meter. */
export function passwordScore(password = "") {
  const value = String(password);
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value) && /[^a-zA-Z0-9]/.test(value)) score += 1;
  if (!value) score = 0;
  return Math.min(4, score);
}

export const PASSWORD_LABELS = ["Too short", "Weak", "Fair", "Strong", "Excellent"];
