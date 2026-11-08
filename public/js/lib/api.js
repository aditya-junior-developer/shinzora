/* ==========================================================================
   Shinzora — Edge Function client
   --------------------------------------------------------------------------
   Every privileged operation (AI, domains, payments, admin, GitHub/Vercel)
   is executed by a Supabase Edge Function. This module is the only place the
   frontend talks to them, so headers, timeouts and error semantics stay
   consistent. The functions verify the caller's JWT server-side — a 401 here
   always means "sign in again", never "silently continue".
   ========================================================================== */

import { sb, AppError, normalizeError, getSession } from "./supabase.js";
import * as prelaunch from "./prelaunch.js";
import { env } from "../config/env.js";

const DEFAULT_TIMEOUT = 120000;

/**
 * Invoke an Edge Function.
 * @param {string} name  function slug (ai, domains, payments, admin, integrations, site, config)
 * @param {string} action  action discriminator inside the function
 * @param {object} [payload]
 * @param {{timeout?:number}} [opts]
 */
/* The Edge runtime answers 546 ("not enough compute resources") when an
   isolate is killed mid-request. Nothing is written when that happens, so one
   silent retry is safe — and it turns an intermittent dead end into a build that
   simply takes a little longer. Anything the server actually refused (4xx) is
   never retried. */
const RETRYABLE_PLATFORM = new Set([502, 503, 504, 546]);

export async function invoke(name, action, payload = {}, opts = {}) {
  try {
    return await invokeOnce(name, action, payload, opts);
  } catch (error) {
    if (opts.noRetry || !(error instanceof AppError) || !RETRYABLE_PLATFORM.has(error.status)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return invokeOnce(name, action, payload, { ...opts, noRetry: true });
  }
}

async function invokeOnce(name, action, payload = {}, opts = {}) {
  if (!sb) throw new AppError("Supabase client is not available.", { code: "client_missing" });
  const session = await getSession();
  if (!session) throw new AppError("Sign in to continue.", { code: "not_authenticated", status: 401 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);

  try {
    const { data, error, response } = await sb.functions.invoke(name, {
      body: { action, ...payload },
      /* A pre-launch session has no Supabase access token: the server reads the
         HttpOnly cookie instead, so no Authorization header is sent. */
      headers: session.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      signal: controller.signal
    });

    if (error) {
      // supabase-js wraps non-2xx responses in FunctionsHttpError: read the body
      let detail = null;
      try {
        if (error.context && typeof error.context.json === "function") detail = await error.context.json();
      } catch {
        /* body already consumed or not JSON */
      }
      const status = response?.status || error.context?.status || 0;
      const message = detail?.error || detail?.message || error.message || "Service request failed.";
      throw new AppError(message, {
        code: detail?.code || `fn_${status || "error"}`,
        hint: detail?.hint || "",
        detail: detail?.detail || "",
        status,
        retryable: status >= 500 || status === 429,
        data: detail
      });
    }

    if (data && data.error) {
      throw new AppError(data.error, { code: data.code || "fn_error", hint: data.hint || "", detail: data.detail || "", data });
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError("The request took too long and was cancelled.", { code: "timeout", retryable: true });
    }
    if (error instanceof AppError) throw error;
    if (/failed to send a request|fetch/i.test(error?.message || "")) {
      throw new AppError("Shinzora service functions are unreachable.", {
        code: "functions_unavailable",
        hint: "Deploy the Edge Functions (supabase functions deploy) or check your network connection.",
        detail: error?.message || "",
        retryable: true
      });
    }
    throw normalizeError(error);
  } finally {
    clearTimeout(timeout);
  }
}

/* --------------------------------------------------------------------------
   Public runtime configuration (which providers are actually connected).
   Cached for the page lifetime; the server is the source of truth.
   -------------------------------------------------------------------------- */
let configPromise = null;

export function runtimeConfig({ force = false } = {}) {
  if (!force && configPromise) return configPromise;
  configPromise = (async () => {
    try {
      /* With a pre-launch account signed in, the deployment state comes from the
         Shinzora server rather than the Supabase project — same shape, same
         "booleans only" rule. */
      const pl = await prelaunch.session();
      const target = pl ? "/api/prelaunch/fn/config" : `${env.functionsUrl}/config`;
      const response = await fetch(target, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: pl
          ? { accept: "application/json" }
          : {
              apikey: env.supabaseKey,
              Authorization: `Bearer ${env.supabaseKey}`
            }
      });
      if (!response.ok) throw new Error(`config ${response.status}`);
      return await response.json();
    } catch (error) {
      return {
        available: false,
        reason: error?.message || "unreachable",
        ai: { configured: false, model: null },
        payments: { upi_configured: false, razorpay_configured: false },
        domains: { provider: "none", configured: false },
        integrations: { github_configured: false, vercel_configured: false }
      };
    }
  })();
  return configPromise;
}

/* --------------------------------------------------------------------------
   Named endpoints — keeps call sites readable and greppable.
   -------------------------------------------------------------------------- */
export const api = {
  ai: {
    /** Chat with the business assistant; persists conversation server-side. */
    chat: (payload) => invoke("ai", "chat", payload),
    /**
     * Which models this deployment may honestly offer for a capability.
     * Metadata only: it spends no credit. An empty list means "not verified",
     * never "none exist" — the UI then offers Automatic alone.
     */
    models: (capability = "site") => invoke("ai", "models", { capability }),
    /** Generate a full site/app structure + files. */
    generate: (payload) => invoke("ai", "generate", payload, { timeout: 180000 }),
    /**
     * Start a chunked build. Answers as soon as the project and the job row
     * exist — no model call happens before the response, so the builder never
     * sits on a blank screen waiting for the provider.
     */
    buildStart: (payload) => invoke("ai", "build_start", payload, { timeout: 30000 }),
    /**
     * Run one unit of work of a build (plan, stylesheet, one page, finish).
     * Each call is small enough to finish well inside the Edge Function limits,
     * and everything it produced is saved before it returns.
     */
    buildStep: (payload) => invoke("ai", "build_step", payload, { timeout: 90000 }),
    /** Honest progress for a job, including after a reload or in another tab. */
    buildStatus: (payload = {}) => invoke("ai", "build_status", payload, { timeout: 20000 }),
    /** Apply a natural-language revision to an existing project version. */
    revise: (payload) => invoke("ai", "revise", payload, { timeout: 180000 }),
    /** Domain name ideas from a business description. */
    domainIdeas: (payload) => invoke("ai", "domain_ideas", payload),
    /** Short marketing copy / product descriptions. */
    copy: (payload) => invoke("ai", "copy", payload),
    /** Support reply drafting. */
    supportReply: (payload) => invoke("ai", "support_reply", payload),
    /**
     * Industry and competitor research. The server answers with the sources it
     * actually read; an answer without citations is treated as no research.
     */
    research: (payload) => invoke("ai", "research", payload, { timeout: 180000 })
  },
  domains: {
    search: (payload) => invoke("domains", "search", payload),
    availability: (payload) => invoke("domains", "availability", payload),
    createOrder: (payload) => invoke("domains", "create_order", payload),
    connect: (payload) => invoke("domains", "connect", payload),
    dns: (payload) => invoke("domains", "dns", payload)
  },
  payments: {
    create: (payload) => invoke("payments", "create", payload),
    submitProof: (payload) => invoke("payments", "submit_proof", payload),
    status: (payload) => invoke("payments", "status", payload),
    razorpayOrder: (payload) => invoke("payments", "razorpay_order", payload)
  },
  integrations: {
    status: () => invoke("integrations", "status"),
    githubConnect: (payload) => invoke("integrations", "github_connect", payload),
    githubRepos: () => invoke("integrations", "github_repos"),
    githubCreateRepo: (payload) => invoke("integrations", "github_create_repo", payload),
    githubPush: (payload) => invoke("integrations", "github_push", payload, { timeout: 180000 }),
    vercelConnect: (payload) => invoke("integrations", "vercel_connect", payload),
    vercelDeploy: (payload) => invoke("integrations", "vercel_deploy", payload, { timeout: 180000 }),
    vercelStatus: (payload) => invoke("integrations", "vercel_status", payload)
  },
  admin: {
    call: (action, payload) => invoke("admin", action, payload)
  },
  site: {
    /** Public read of a published project (used by /site/?p=slug). */
    published: (slug) => invoke("site", "get", { slug })
  }
};
