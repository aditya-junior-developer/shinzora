// ============================================================================
// Shinzora Edge Functions — provider configuration
// ----------------------------------------------------------------------------
// One place that answers "is this provider actually connected?". The public
// `config` function exposes only booleans; secrets stay in the runtime.
// ============================================================================

import { geminiConfigured, primaryModel } from "./gemini.ts";

const env = (key: string) => (Deno.env.get(key) ?? "").trim();

export function providerFlags() {
  const upiId = env("UPI_ID");
  const domainProvider = env("DOMAIN_PROVIDER") || "none";

  return {
    available: true,
    environment: env("SITE_ENV") || "production",
    ai: {
      configured: geminiConfigured(),
      model: geminiConfigured() ? primaryModel() : null,
      // Names the operator the exact secret to set when AI is not configured.
      key_env: geminiConfigured() ? null : "SHINZORA_AI_API_KEY"
    },
    payments: {
      upi_configured: Boolean(upiId),
      upi_payee_name: upiId ? env("UPI_PAYEE_NAME") || "Shinzora" : null,
      /* The VPA is what a payer has to send money to — it is on the QR and on
         the receipt, so it is public by design. No key is ever exposed here. */
      upi_id: upiId || null,
      razorpay_configured: Boolean(env("RAZORPAY_KEY_ID") && env("RAZORPAY_KEY_SECRET")),
      razorpay_key_id: env("RAZORPAY_KEY_ID") || null,
      mode: env("PAYMENTS_MODE") || "manual_verification"
    },
    domains: {
      provider: domainProvider,
      /* `configured` keeps its old meaning: a registrar that can price and
         register. Availability alone is a different capability and is reported
         separately, so the dashboard never claims ordering works when it does
         not. */
      configured: domainProvider !== "none" && Boolean(env("DOMAIN_API_KEY")),
      availability:
        domainProvider !== "none" && Boolean(env("DOMAIN_API_KEY"))
          ? "registrar"
          : (env("DOMAIN_AVAILABILITY") || "rdap").toLowerCase() === "off"
            ? "off"
            : "rdap",
      registration_configured: domainProvider !== "none" && Boolean(env("DOMAIN_API_KEY")),
      subdomain_root: env("SUBDOMAIN_ROOT") || "shinzora.in"
    },
    integrations: {
      github_configured: Boolean(env("GITHUB_CLIENT_ID") && env("GITHUB_CLIENT_SECRET")),
      vercel_configured: Boolean(env("VERCEL_TOKEN") || (env("VERCEL_CLIENT_ID") && env("VERCEL_CLIENT_SECRET")))
    },
    email: {
      provider: env("EMAIL_PROVIDER") || "supabase"
    }
  };
}
