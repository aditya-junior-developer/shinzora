/* ==========================================================================
   Shinzora — pre-launch stand-ins for the Edge Functions (server only)
   --------------------------------------------------------------------------
   The admin console and the AI client talk to Supabase Edge Functions. For a
   pre-launch session those calls are routed here instead, so the two testing
   accounts drive the real UI against the sandbox store.

   Implemented faithfully (same action names, same response shapes as
   supabase/functions/admin/index.ts):
     overview  customers  customer  payments  payment_review
     service_requests  service_request_update  subscriptions
     subscription_update  projects  deployments  tickets  ticket_reply
     ticket_status  announcements  announcement_create  activity
     contacts  contact_update  admins

   `ai` and `site` are proxied honestly:
     • ai   → calls Gemini with SHINZORA_AI_API_KEY when it is configured; when
              it is not, returns a structured "not configured" error and never
              invents output
     • site → serves the sandbox publication for a slug it owns
   ========================================================================== */

import { load, save, table as tableOf, nextId, ADMIN_ACCOUNT } from "./store.mjs";
import * as sandboxAi from "./ai.mjs";

const now = () => new Date().toISOString();

const PLAN_LIMITS = {
  free: { label: "Free", credits: 30, projects: 1 },
  pro: { label: "Pro", credits: 800, projects: 10 },
  enterprise: { label: "Enterprise", credits: 6000, projects: 100 }
};

class FunctionError extends Error {
  constructor(message, { status = 400, code = "invalid_input", hint = null, extra = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    /* Structured facts the UI renders (retry windows, ids) — never prose. */
    this.extra = extra;
  }
  toJSON() {
    return { error: this.message, code: this.code, hint: this.hint, ...(this.extra || {}) };
  }
}

/* --------------------------------------------------------------------------
   AI provider errors → customer language
   --------------------------------------------------------------------------
   Mirrors `translateAiError` in supabase/functions/_shared/gemini.ts. The two
   copies exist because the Edge Function is bundled from its own directory and
   cannot import from `server/`; tests/ai-errors.test.mjs runs both against the
   same provider payloads so they cannot drift apart silently.
   -------------------------------------------------------------------------- */

/** Pull a wait out of "retry in 1h24m15.4s", `"retryDelay":"84s"`, or "20 seconds". */
export function extractRetrySeconds(detail = "") {
  const clock = String(detail).match(/retry in\s+(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9.]+)s)?/i);
  if (clock && (clock[1] || clock[2] || clock[3])) {
    const seconds = Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0);
    if (seconds > 0) return Math.round(seconds);
  }
  const delay = String(detail).match(/"retryDelay"\s*:\s*"?([0-9.]+)s/i);
  if (delay) return Math.round(Number(delay[1]));
  const words = String(detail).match(/([0-9]+)\s*(?:seconds|secs)\b/i);
  return words ? Number(words[1]) : null;
}

/** Human wording for a wait. */
export function describeAiWait(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.floor(seconds / 3600);
  const rest = Math.round((seconds % 3600) / 60);
  return rest ? `about ${hours}h ${rest}m` : `about ${hours} hours`;
}

export function isAiQuotaExhausted(detail = "") {
  return /quota|exceeded your current quota|limit:\s*0|billing/i.test(String(detail));
}

export function translateAiError(status, detail = "") {
  const wait = extractRetrySeconds(detail);

  if (status === 429) {
    if (isAiQuotaExhausted(detail)) {
      const zeroLimit = /limit:\s*0\b/.test(detail);
      const message = zeroLimit
        ? "This AI feature is not included in the provider plan this project is on. The owner can enable it in the AI provider's billing settings."
        : `The AI provider's allowance for this project is used up.${wait ? ` It resets in ${describeAiWait(wait)}.` : ""}`;
      return new FunctionError(message, {
        status: 429,
        code: "ai_quota_exhausted",
        hint: zeroLimit
          ? "Enable billing for the AI provider project, or use a project whose plan includes this model."
          : "Wait for the allowance to reset, or raise the limit in the AI provider's plan.",
        extra: wait ? { retry_after_seconds: wait } : null
      });
    }
    return new FunctionError("The AI provider is rate limiting this project. Try again in a minute.", {
      status: 429,
      code: "ai_rate_limited",
      extra: wait ? { retry_after_seconds: wait } : null
    });
  }

  if (status === 400 && /api key/i.test(detail)) {
    return new FunctionError("The AI provider rejected the configured key.", { status: 502, code: "ai_bad_key" });
  }

  if (status === 403 || /billing|permission|has not been used in project|is disabled/i.test(detail)) {
    return new FunctionError(
      "The AI provider refused the request for this project. Check that billing and the API are enabled for the configured key.",
      { status: 502, code: "ai_forbidden" }
    );
  }

  return new FunctionError(`AI provider error (${status}).`, { status: 502, code: "ai_provider_error" });
}

const text = (value, max = 500) => String(value ?? "").trim().slice(0, max);
/** Clean list input (page names, tags) the same way cleanList does server-side. */
const listOf = (value, max = 8) =>
  (Array.isArray(value) ? value : [])
    .map((item) => text(item, 60))
    .filter(Boolean)
    .slice(0, max);

/* -------------------------------------------------------------- joins */

function profileIndex(root) {
  const map = new Map();
  tableOf(root, "profiles").forEach((row) => map.set(row.id, row));
  return map;
}

function withCustomer(rows, key, people) {
  return rows.map((row) => ({ ...row, customer: people.get(row[key]) ?? null }));
}

/* --------------------------------------------------------------- actions */

function overview(root) {
  const count = (name, filter) => tableOf(root, name).filter(filter || (() => true)).length;
  const verified = tableOf(root, "payments").filter((row) => row.status === "verified");
  return {
    counts: {
      users: count("profiles"),
      projects: count("projects"),
      published: count("projects", (row) => row.status === "published"),
      payments_pending: count("payments", (row) => ["pending", "awaiting_verification"].includes(row.status)),
      service_pending: count("service_requests", (row) => ["requested", "approved", "in_progress"].includes(row.status)),
      tickets_open: count("support_tickets", (row) => row.status === "open"),
      contacts_new: count("contact_messages", (row) => row.status === "new"),
      revenue_total: verified.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      verified_payments: verified.length
    },
    recent_activity: [...tableOf(root, "customer_activity")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 12),
    recent_customers: [...tableOf(root, "profiles")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 6)
      .map((row) => ({ id: row.id, full_name: row.full_name, email: row.email, created_at: row.created_at }))
  };
}

function customers(root, body) {
  const term = text(body.search, 80).toLowerCase();
  const limit = Math.min(Number(body.limit) || 50, 200);
  const offset = Math.max(Number(body.offset) || 0, 0);

  const all = tableOf(root, "profiles").filter((profile) => {
    if (!term) return true;
    return [profile.full_name, profile.email, profile.phone].some((field) =>
      String(field ?? "").toLowerCase().includes(term)
    );
  });

  const page = all.slice(offset, offset + limit);
  const subs = tableOf(root, "subscriptions");
  const businesses = tableOf(root, "businesses");
  const onboarding = tableOf(root, "onboarding_progress");
  const projects = tableOf(root, "projects");

  return {
    total: all.length,
    customers: page.map((profile) => {
      const sub = subs.find((row) => row.user_id === profile.id);
      const business = businesses.find((row) => row.owner_id === profile.id);
      const onboard = onboarding.find((row) => row.user_id === profile.id);
      const owned = projects.filter((row) => row.owner_id === profile.id);
      return {
        id: profile.id,
        name: profile.full_name,
        email: profile.email,
        phone: profile.phone,
        joined: profile.created_at,
        last_sign_in: profile.updated_at,
        business_name: business?.name ?? null,
        category: business?.category ?? null,
        location: business?.location ?? null,
        plan: sub?.plan ?? "free",
        subscription_status: sub?.status ?? "active",
        ai_used: sub?.ai_credits_used ?? 0,
        ai_limit: sub?.ai_credits_limit ?? 30,
        onboarding_step: onboard?.current_step ?? 1,
        onboarded: Boolean(onboard?.completed_at),
        projects: owned.length,
        published: owned.filter((row) => row.status === "published").length
      };
    })
  };
}

function customer(root, userId) {
  if (!userId) throw new FunctionError("A customer id is required.", { code: "invalid_input" });
  const profile = tableOf(root, "profiles").find((row) => row.id === userId);
  if (!profile) throw new FunctionError("Customer not found.", { status: 404, code: "not_found" });
  const byNewest = (a, b) => String(b.created_at).localeCompare(String(a.created_at));
  return {
    profile,
    business: tableOf(root, "businesses").find((row) => row.owner_id === userId) ?? null,
    subscription: tableOf(root, "subscriptions").find((row) => row.user_id === userId) ?? null,
    onboarding: tableOf(root, "onboarding_progress").find((row) => row.user_id === userId) ?? null,
    projects: tableOf(root, "projects").filter((row) => row.owner_id === userId),
    payments: tableOf(root, "payments").filter((row) => row.owner_id === userId).sort(byNewest).slice(0, 20),
    tickets: tableOf(root, "support_tickets").filter((row) => row.owner_id === userId).sort(byNewest).slice(0, 20),
    service_requests: tableOf(root, "service_requests").filter((row) => row.owner_id === userId).sort(byNewest).slice(0, 20),
    activity: tableOf(root, "customer_activity").filter((row) => row.user_id === userId).sort(byNewest).slice(0, 40)
  };
}

function payments(root, body) {
  const status = text(body.status, 30);
  const rows = tableOf(root, "payments")
    .filter((row) => !row.deleted_at)
    .filter((row) => !status || status === "all" || row.status === status)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 200);
  return { payments: withCustomer(rows, "owner_id", profileIndex(root)) };
}

function paymentReview(root, adminId, body) {
  const paymentId = text(body.paymentId, 64);
  const decision = text(body.decision, 20);
  const note = text(body.note, 500);
  if (!paymentId) throw new FunctionError("Payment id is required.");
  if (!["approve", "reject"].includes(decision)) throw new FunctionError("Decision must be approve or reject.");

  const payment = tableOf(root, "payments").find((row) => row.id === paymentId);
  if (!payment) throw new FunctionError("Payment not found.", { status: 404, code: "not_found" });
  if (payment.status === "verified" && decision === "approve") {
    throw new FunctionError("This payment is already verified.", { status: 409, code: "already_verified" });
  }

  payment.status = decision === "approve" ? "verified" : "rejected";
  payment.admin_note = note || (decision === "approve" ? "Approved by administrator" : "Rejected by administrator");
  payment.verified_by = decision === "approve" ? adminId : null;
  payment.verified_at = decision === "approve" ? now() : null;
  payment.updated_at = now();

  if (decision === "approve") applyPaymentEffect(root, payment);

  tableOf(root, "notifications").push({
    id: nextId("ntf"),
    tenant_id: payment.tenant_id,
    user_id: payment.owner_id,
    title: decision === "approve" ? "Payment verified" : "Payment needs attention",
    body:
      decision === "approve"
        ? `Payment ${payment.reference} for ${payment.label || payment.purpose} is confirmed.`
        : `Payment ${payment.reference} could not be verified. ${note || "Check the transaction ID and submit it again."}`,
    type: "payment",
    link: "/app/?view=billing",
    read_at: null,
    created_at: now()
  });

  tableOf(root, "customer_activity").push({
    id: nextId("act"),
    tenant_id: payment.tenant_id,
    user_id: payment.owner_id,
    action: decision === "approve" ? "payment_approved" : "payment_rejected",
    entity_type: "payment",
    entity_id: payment.id,
    meta: { admin_id: adminId, amount: payment.amount, note },
    created_at: now()
  });

  save(root);
  return { ok: true, payment };
}

/* ----------------------------------------------------------------- domains ---
   Availability, read from the public registry (RDAP) — the same free source the
   deployed `domains` function uses when no registrar is connected. "Taken or
   free" is real; no price is ever invented, and ordering is not offered. */
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.[a-z]{2,24}$/i;
const RDAP_TTL_MS = 10 * 60 * 1000;
const rdapCache = new Map();

async function rdapLookup(domain) {
  const cached = rdapCache.get(domain);
  if (cached && Date.now() - cached.at < RDAP_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let value;
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      redirect: "follow",
      headers: { accept: "application/rdap+json, application/json;q=0.9", "user-agent": "Shinzora/1.0 (+https://shinzora.in)" },
      signal: controller.signal
    });
    if (response.status === 404) value = { available: true, status: "available" };
    else if (response.status === 200) value = { available: false, status: "registered" };
    else value = { available: null, status: "unknown", detail: `registry answered ${response.status}` };
  } catch (error) {
    value = {
      available: null,
      status: "unknown",
      detail: error?.name === "AbortError" ? "registry timed out" : "registry unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
  rdapCache.set(domain, { at: Date.now(), value });
  return value;
}

async function domainChecks(body) {
  const action = body.action || "search";
  const registrarReady = Boolean(process.env.DOMAIN_PROVIDER && process.env.DOMAIN_PROVIDER !== "none" && process.env.DOMAIN_API_KEY);
  const availabilityOff = String(process.env.DOMAIN_AVAILABILITY || "rdap").toLowerCase() === "off";

  if (action === "create_order" || action === "checkout") {
    throw new FunctionError("Domain registration is not available on this deployment yet.", {
      status: 503,
      code: "domains_unconfigured",
      hint: "Availability checks are live, but ordering needs a registrar (DOMAIN_PROVIDER, DOMAIN_API_URL, DOMAIN_API_KEY). No order is created and no money is taken."
    });
  }

  if (!["search", "availability", "status"].includes(action)) {
    throw new FunctionError("That domain action is not available.", { code: "unknown_action" });
  }

  const raw = String(body.query || body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!raw) throw new FunctionError("Enter a domain to check.", { code: "invalid_input" });
  if (!DOMAIN_RE.test(raw)) {
    throw new FunctionError("That does not look like a domain. Try name.com or name.in.", { code: "invalid_input" });
  }

  if (registrarReady) {
    /* The sandbox never calls a real registrar: that would take live orders from
       a test surface. Say so plainly rather than pretending. */
    throw new FunctionError("The pre-launch sandbox does not place registrar calls.", {
      status: 501,
      code: "not_available_prelaunch",
      hint: "A registrar is configured, but ordering only runs on the deployed site. Availability is checked from the public registry here."
    });
  }

  if (availabilityOff) {
    return {
      provider_configured: false,
      availability: "off",
      registration_available: false,
      provider: process.env.DOMAIN_PROVIDER || "none",
      message: "Availability checks are switched off (DOMAIN_AVAILABILITY=off) and no registrar is connected.",
      results: []
    };
  }

  const check = await rdapLookup(raw);
  return {
    provider_configured: false,
    availability: "rdap",
    registration_available: false,
    provider: process.env.DOMAIN_PROVIDER || "none",
    source: "Public registry data (RDAP)",
    message:
      "Availability comes from the public registry, so it is live. Pricing and registration need a registrar account — no price is shown because none has been quoted.",
    results: [
      {
        domain: raw,
        available: check.available,
        status: check.status,
        price: null,
        renewal: null,
        currency: null,
        price_known: false,
        detail: check.detail ?? null
      }
    ]
  };
}

/* --------------------------------------------------------------- payments ---
   Mirrors `supabase/functions/payments`: prices come from this catalogue (a
   client-sent amount is ignored), a record is created as `pending`, and the
   only thing a customer can do is submit a UTR — which moves it to
   `awaiting_verification`. Nothing here can set `verified`; that is the
   administrator's payment_review action above. */
const PLAN_PRICES = { pro: 249900, enterprise: 999900 };
const SERVICE_PRICES = {
  website_setup: { amount: 499900, label: "Managed website setup" },
  brand_kit: { amount: 249900, label: "Brand kit and copywriting" },
  store_setup: { amount: 349900, label: "Store and catalogue setup" }
};

function upiSettings() {
  const id = String(process.env.UPI_ID || "").trim();
  return {
    configured: Boolean(id),
    id,
    payee: String(process.env.UPI_PAYEE_NAME || "Shinzora").trim()
  };
}

function resolvePrice(purpose) {
  if (purpose.startsWith("subscription:")) {
    const plan = purpose.split(":")[1];
    if (!PLAN_PRICES[plan]) return null;
    return { amount: PLAN_PRICES[plan], label: `${plan === "pro" ? "Pro" : "Enterprise"} plan`, plan };
  }
  if (purpose.startsWith("service:")) {
    const entry = SERVICE_PRICES[purpose.split(":")[1]];
    return entry ? { ...entry } : null;
  }
  return null;
}

function customerPayments(root, session, body) {
  const action = body.action || "create";
  const userId = session.account.id;
  const tenantId = session.account.tenantId;

  if (action === "create") {
    const purpose = text(body.purpose, 80);
    if (!purpose) throw new FunctionError("A payment purpose is required.");
    const resolved = resolvePrice(purpose);
    if (!resolved) throw new FunctionError("That payment purpose is not recognised.", { code: "invalid_input" });

    const upi = upiSettings();
    if (!upi.configured) {
      throw new FunctionError("Payments are not configured on this deployment.", {
        status: 503,
        code: "payments_unconfigured",
        hint: "Set UPI_ID and UPI_PAYEE_NAME in the environment, then restart the server."
      });
    }

    /* One open payment per customer per purpose (migration 0007). Asking to pay
       again for the same purpose returns the record that is already open, so a
       double click cannot mint a second reference and a second UTR to review. */
    const open = tableOf(root, "payments")
      .filter(
        (p) =>
          p.owner_id === userId &&
          p.purpose === purpose &&
          (p.status === "pending" || p.status === "awaiting_verification")
      )
      .sort(
        (a, b) =>
          Number(b.status === "awaiting_verification") - Number(a.status === "awaiting_verification") ||
          String(b.created_at).localeCompare(String(a.created_at))
      )[0];

    if (open) {
      const existingRupees = (open.amount / 100).toFixed(2);
      return {
        reused: true,
        payment: open,
        upi: {
          configured: true,
          upi_id: upi.id,
          payee_name: upi.payee,
          intent: `upi://pay?pa=${encodeURIComponent(upi.id)}&pn=${encodeURIComponent(upi.payee)}&am=${existingRupees}&cu=INR&tn=${encodeURIComponent(open.reference)}&tr=${encodeURIComponent(open.reference)}`,
          amount_rupees: Number(existingRupees)
        },
        razorpay: { configured: false }
      };
    }

    const rupees = (resolved.amount / 100).toFixed(2);
    const reference = `SZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const row = {
      id: nextId("pay"),
      tenant_id: tenantId,
      owner_id: userId,
      reference,
      purpose,
      label: resolved.label,
      amount: resolved.amount,
      currency: "INR",
      method: "upi_qr",
      status: "pending",
      plan: resolved.plan ?? null,
      utr: null,
      paid_at: null,
      proof_url: null,
      note: null,
      admin_note: null,
      verified_by: null,
      verified_at: null,
      provider: "manual",
      provider_payment_id: null,
      created_at: now(),
      updated_at: now()
    };
    tableOf(root, "payments").push(row);
    save(root);

    return {
      reused: false,
      payment: row,
      upi: {
        configured: true,
        upi_id: upi.id,
        payee_name: upi.payee,
        intent: `upi://pay?pa=${encodeURIComponent(upi.id)}&pn=${encodeURIComponent(upi.payee)}&am=${rupees}&cu=INR&tn=${encodeURIComponent(reference)}&tr=${encodeURIComponent(reference)}`,
        amount_rupees: Number(rupees)
      },
      razorpay: { configured: false }
    };
  }

  if (action === "submit_proof") {
    const paymentId = text(body.paymentId, 64);
    const utr = text(body.utr, 60).replace(/\s+/g, "");
    const payerUpi = text(body.payerUpi, 80).toLowerCase();
    const note = text(body.note, 500);

    if (!paymentId) throw new FunctionError("Missing payment reference.", { code: "invalid_input" });
    if (utr.length < 6) {
      throw new FunctionError("Enter the UPI transaction ID from your payment app.", {
        code: "invalid_input",
        hint: "It is a 12-digit number shown in the payment success screen and your UPI app history."
      });
    }
    if (payerUpi && !/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/.test(payerUpi)) {
      throw new FunctionError("Enter the UPI ID you paid from, e.g. name@bank.", { code: "invalid_input" });
    }

    const payment = tableOf(root, "payments").find((row) => row.id === paymentId && row.owner_id === userId);
    if (!payment) throw new FunctionError("That payment does not belong to your account.", { status: 404, code: "not_found" });
    if (payment.status === "verified") {
      throw new FunctionError("This payment is already verified.", { status: 409, code: "already_verified" });
    }
    if (payment.status === "rejected") {
      throw new FunctionError("This payment was rejected. Create a new payment request.", { status: 409, code: "rejected" });
    }

    payment.status = "awaiting_verification";
    payment.utr = utr;
    payment.note = [payerUpi ? `Payer UPI: ${payerUpi}` : "", note].filter(Boolean).join(" · ") || payment.note;
    payment.paid_at = payment.paid_at || now();
    payment.updated_at = now();

    tableOf(root, "notifications").push({
      id: nextId("ntf"),
      tenant_id: payment.tenant_id,
      user_id: userId,
      title: "Payment awaiting verification",
      body: "Your payment is awaiting verification. We will notify you once it is confirmed.",
      type: "payment",
      link: "/app/?view=billing",
      read_at: null,
      created_at: now()
    });
    tableOf(root, "customer_activity").push({
      id: nextId("act"),
      tenant_id: payment.tenant_id,
      user_id: userId,
      action: "payment_proof_submitted",
      entity_type: "payment",
      entity_id: payment.id,
      meta: { utr, amount: payment.amount, payerUpi: payerUpi || null },
      created_at: now()
    });
    save(root);
    return {
      ok: true,
      payment,
      message: "Your payment is awaiting verification. We will notify you once it is confirmed."
    };
  }

  if (action === "status") {
    const paymentId = text(body.paymentId, 64);
    const payment = tableOf(root, "payments").find((row) => row.id === paymentId && row.owner_id === userId);
    if (!payment) throw new FunctionError("Payment not found.", { status: 404, code: "not_found" });
    return { payment };
  }

  if (action === "razorpay_order") {
    throw new FunctionError("Razorpay is not enabled on this deployment.", {
      status: 503,
      code: "razorpay_unconfigured",
      hint: "UPI QR payments are active; Razorpay keys are not set."
    });
  }

  throw new FunctionError("Unknown payments action.", { code: "unknown_action" });
}

function applyPaymentEffect(root, payment) {
  const purpose = String(payment.purpose || "");
  if (purpose.startsWith("subscription:")) {
    const plan = purpose.split(":")[1];
    const limits = PLAN_LIMITS[plan];
    if (!limits) return;
    const subs = tableOf(root, "subscriptions");
    let sub = subs.find((row) => row.user_id === payment.owner_id);
    if (!sub) {
      sub = { id: nextId("sub"), tenant_id: payment.tenant_id, user_id: payment.owner_id, created_at: now() };
      subs.push(sub);
    }
    Object.assign(sub, {
      plan,
      status: "active",
      ai_credits_limit: limits.credits,
      ai_credits_used: 0,
      ai_period_start: now(),
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
      updated_at: now()
    });
  }
  if (purpose.startsWith("service:")) {
    const serviceType = purpose.split(":")[1];
    const requests = tableOf(root, "service_requests");
    const existing = requests.find(
      (row) => row.owner_id === payment.owner_id && row.service_type === serviceType && ["requested", "approved"].includes(row.status)
    );
    if (existing) {
      existing.status = "approved";
      existing.payment_id = payment.id;
      existing.updated_at = now();
    } else {
      requests.push({
        id: nextId("srv"),
        tenant_id: payment.tenant_id,
        owner_id: payment.owner_id,
        service_type: serviceType,
        title: payment.label || serviceType,
        details: "Created from a verified payment.",
        amount: payment.amount,
        status: "approved",
        admin_note: null,
        payment_id: payment.id,
        created_at: now(),
        updated_at: now()
      });
    }
  }
  if (purpose.startsWith("domain:")) {
    const orderId = purpose.split(":")[1];
    const order = tableOf(root, "domain_orders").find((row) => row.id === orderId);
    if (order) {
      order.status = "paid";
      order.payment_id = payment.id;
      order.updated_at = now();
    }
  }
}

function serviceRequests(root, body) {
  const status = text(body.status, 30);
  const rows = tableOf(root, "service_requests")
    .filter((row) => !status || status === "all" || row.status === status)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 200);
  return { requests: withCustomer(rows, "owner_id", profileIndex(root)) };
}

function serviceRequestUpdate(root, adminId, body) {
  const id = text(body.id, 64);
  const status = text(body.status, 30);
  const note = text(body.note, 500);
  const allowed = ["requested", "approved", "in_progress", "completed", "rejected", "cancelled"];
  if (!id || !allowed.includes(status)) throw new FunctionError("A valid request id and status are required.");

  const request = tableOf(root, "service_requests").find((row) => row.id === id);
  if (!request) throw new FunctionError("Request not found.", { status: 404, code: "not_found" });
  request.status = status;
  request.admin_note = note || null;
  request.updated_at = now();

  tableOf(root, "notifications").push({
    id: nextId("ntf"),
    tenant_id: request.tenant_id,
    user_id: request.owner_id,
    title: `Service request ${status.replace(/_/g, " ")}`,
    body: `${request.title || request.service_type} — ${status.replace(/_/g, " ")}.${note ? ` ${note}` : ""}`,
    type: "account",
    link: "/app/?view=billing",
    read_at: null,
    created_at: now()
  });

  tableOf(root, "customer_activity").push({
    id: nextId("act"),
    tenant_id: request.tenant_id,
    user_id: request.owner_id,
    action: "service_request_updated",
    entity_type: "service_request",
    entity_id: id,
    meta: { status, admin_id: adminId },
    created_at: now()
  });

  save(root);
  return { ok: true, request };
}

function subscriptions(root) {
  const rows = [...tableOf(root, "subscriptions")].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { subscriptions: withCustomer(rows, "user_id", profileIndex(root)) };
}

function subscriptionUpdate(root, adminId, body) {
  const userId = text(body.userId, 64);
  const plan = text(body.plan, 20);
  const status = text(body.status, 20) || "active";
  if (!userId || !PLAN_LIMITS[plan]) throw new FunctionError("A customer and a valid plan are required.");

  const subs = tableOf(root, "subscriptions");
  let sub = subs.find((row) => row.user_id === userId);
  if (!sub) {
    const profile = tableOf(root, "profiles").find((row) => row.id === userId);
    sub = { id: nextId("sub"), tenant_id: profile?.tenant_id ?? null, user_id: userId, created_at: now() };
    subs.push(sub);
  }
  Object.assign(sub, { plan, status, ai_credits_limit: PLAN_LIMITS[plan].credits, updated_at: now() });

  tableOf(root, "notifications").push({
    id: nextId("ntf"),
    tenant_id: sub.tenant_id,
    user_id: userId,
    title: "Subscription updated",
    body: `An administrator set your plan to ${PLAN_LIMITS[plan].label} (${status}).`,
    type: "account",
    link: "/app/?view=billing",
    read_at: null,
    created_at: now()
  });

  tableOf(root, "customer_activity").push({
    id: nextId("act"),
    tenant_id: sub.tenant_id,
    user_id: userId,
    action: "subscription_updated",
    entity_type: "subscription",
    entity_id: userId,
    meta: { plan, status, admin_id: adminId },
    created_at: now()
  });

  save(root);
  return { ok: true, subscription: sub };
}

function projects(root, body) {
  const type = text(body.type, 20);
  const rows = tableOf(root, "projects")
    .filter((row) => !type || type === "all" || row.type === type)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 200);
  return { projects: withCustomer(rows, "owner_id", profileIndex(root)) };
}

function deployments(root) {
  return {
    deployments: [...tableOf(root, "deployments")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 100)
  };
}

function tickets(root, body) {
  const status = text(body.status, 20);
  const rows = tableOf(root, "support_tickets")
    .filter((row) => !row.archived_at)
    .filter((row) => !status || status === "all" || row.status === status)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 200);
  const replies = tableOf(root, "support_replies");
  const people = profileIndex(root);
  return {
    tickets: rows.map((row) => ({
      ...row,
      customer: people.get(row.owner_id) ?? null,
      replies: replies
        .filter((reply) => reply.ticket_id === row.id)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    }))
  };
}

function ticketReply(root, adminId, body) {
  const ticketId = text(body.ticketId, 64);
  const message = text(body.body, 4000);
  if (!ticketId || !message) throw new FunctionError("A ticket and a message are required.");
  const ticket = tableOf(root, "support_tickets").find((row) => row.id === ticketId);
  if (!ticket) throw new FunctionError("Ticket not found.", { status: 404, code: "not_found" });

  tableOf(root, "support_replies").push({
    id: nextId("rep"),
    tenant_id: ticket.tenant_id,
    ticket_id: ticketId,
    author_id: adminId,
    author_role: "admin",
    body: message,
    created_at: now()
  });
  ticket.status = "pending";
  ticket.updated_at = now();

  tableOf(root, "notifications").push({
    id: nextId("ntf"),
    tenant_id: ticket.tenant_id,
    user_id: ticket.owner_id,
    title: "Shinzora support replied",
    body: `${ticket.subject} — a member of the team has answered your ticket.`,
    type: "support",
    link: "/app/?view=support",
    read_at: null,
    created_at: now()
  });

  save(root);
  return { ok: true };
}

function ticketStatus(root, body) {
  const ticketId = text(body.ticketId, 64);
  const status = text(body.status, 20);
  if (!ticketId || !["open", "pending", "resolved", "closed"].includes(status)) {
    throw new FunctionError("A ticket and a valid status are required.");
  }
  const ticket = tableOf(root, "support_tickets").find((row) => row.id === ticketId);
  if (!ticket) throw new FunctionError("Ticket not found.", { status: 404, code: "not_found" });
  ticket.status = status;
  ticket.updated_at = now();
  save(root);
  return { ok: true, ticket };
}

function announcements(root) {
  return {
    announcements: [...tableOf(root, "admin_announcements")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 60)
  };
}

function announcementCreate(root, adminId, body) {
  const title = text(body.title, 160);
  const message = text(body.body, 4000);
  const audience = text(body.audience, 30) || "all";
  if (!title || !message) throw new FunctionError("Title and message are required.");

  const announcement = {
    id: nextId("ann"),
    tenant_id: null,
    title,
    body: message,
    audience,
    created_by: adminId,
    published_at: now(),
    expires_at: null,
    created_at: now()
  };
  tableOf(root, "admin_announcements").push(announcement);

  const people = tableOf(root, "profiles");
  const subs = tableOf(root, "subscriptions");
  let recipients = [];
  if (audience === "all" || audience === "customers") recipients = people.map((row) => row.id);
  else if (["free", "pro", "enterprise"].includes(audience)) {
    recipients = subs.filter((row) => row.plan === audience).map((row) => row.user_id);
  } else if (audience.startsWith("user:")) recipients = [audience.slice(5)];

  recipients.forEach((userId) => {
    const profile = people.find((row) => row.id === userId);
    tableOf(root, "notifications").push({
      id: nextId("ntf"),
      tenant_id: profile?.tenant_id ?? null,
      user_id: userId,
      title,
      body: message,
      type: "admin",
      link: "/app/?view=notifications",
      meta: { announcement_id: announcement.id, audience },
      read_at: null,
      created_at: now()
    });
  });

  save(root);
  return { ok: true, announcement, delivered: recipients.length };
}

/* --------------------------------------------------------------------------
   Phase 3 — authority, audit and archival, mirrored for the sandbox
   --------------------------------------------------------------------------
   The same rules as migration 0009, against the file store: a super
   administrator is required to move roles, the protected owner cannot be
   demoted, the last super administrator cannot be removed, payments are voided
   rather than destroyed when money is involved, and every privileged change
   leaves an audit row. If this drifts from the SQL, tests/admin-authority.test.mjs
   fails.
   -------------------------------------------------------------------------- */

const SANDBOX_SUPER_ROLES = new Set(["owner", "superadmin"]);

function roleOf(root, userId) {
  const row = tableOf(root, "admin_users").find((entry) => entry.user_id === userId);
  if (!row) return "user";
  return SANDBOX_SUPER_ROLES.has(row.role) ? "superadmin" : "admin";
}

function superadminCount(root) {
  return tableOf(root, "admin_users").filter((row) => SANDBOX_SUPER_ROLES.has(row.role)).length;
}

/**
 * The recovery account. Either it carries the explicit flag (as migration 0009
 * sets it), or it is the earliest super administrator row — the sandbox seed
 * predates the flag and must behave the same way.
 */
function isProtectedOwner(root, userId) {
  const rows = tableOf(root, "admin_users");
  const row = rows.find((entry) => entry.user_id === userId);
  if (!row) return false;
  if (row.protected) return true;

  const supers = rows
    .filter((entry) => SANDBOX_SUPER_ROLES.has(entry.role))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return supers.length > 0 && supers[0].user_id === userId;
}

function writeAudit(root, actorEmail, action, targetTable, targetId, reason, before, after) {
  const entries = tableOf(root, "admin_audit");
  entries.push({
    id: nextId("audit"),
    actor_id: null,
    actor_email: actorEmail,
    actor_role: roleOf(root, tableOf(root, "admin_users").find((row) => row.email === actorEmail)?.user_id),
    action,
    target_table: targetTable,
    target_id: targetId,
    reason: reason || null,
    before: before || null,
    after: after || null,
    created_at: new Date().toISOString()
  });
  return entries[entries.length - 1];
}

function adminDirectory(root) {
  const subs = tableOf(root, "subscriptions");
  const projects = tableOf(root, "projects");
  return {
    users: tableOf(root, "profiles")
      .map((profile) => {
        const sub = subs.find((row) => row.user_id === profile.id);
        return {
          user_id: profile.id,
          email: profile.email,
          full_name: profile.full_name,
          phone: profile.phone,
          role: roleOf(root, profile.id),
          plan: sub?.plan ?? "free",
          plan_status: sub?.status ?? "active",
          ai_credits_used: sub?.ai_credits_used ?? 0,
          ai_credits_limit: sub?.ai_credits_limit ?? PLAN_LIMITS.free.credits,
          projects: projects.filter((row) => row.owner_id === profile.id).length,
          joined_at: profile.created_at,
          protected: isProtectedOwner(root, profile.id)
        };
      })
      .sort((a, b) => {
        const rank = { superadmin: 0, admin: 1, user: 2 };
        return rank[a.role] - rank[b.role] || String(a.joined_at).localeCompare(String(b.joined_at));
      })
  };
}

function setRole(root, actorEmail, body) {
  const userId = text(body.userId, 64);
  const wanted = text(body.role, 20).toLowerCase();
  const reason = text(body.reason, 400);
  if (!userId) throw new FunctionError("A user id is required.");
  if (!["admin", "superadmin", "none"].includes(wanted)) {
    throw new FunctionError("Role must be admin, superadmin or none.");
  }

  const rows = tableOf(root, "admin_users");
  const target = rows.find((row) => row.user_id === userId);
  const previous = target ? roleOf(root, userId) : null;

  if (target && isProtectedOwner(root, userId) && wanted !== "superadmin") {
    throw new FunctionError("The protected owner account cannot be demoted or revoked.", {
      status: 403,
      code: "forbidden"
    });
  }
  if (previous === "superadmin" && wanted !== "superadmin" && superadminCount(root) < 2) {
    throw new FunctionError("This is the last super administrator. Promote another account first.", {
      status: 403,
      code: "forbidden"
    });
  }

  const profile = tableOf(root, "profiles").find((row) => row.id === userId);
  if (!profile) throw new FunctionError("No account exists for that user id.", { status: 404, code: "not_found" });

  const before = target ? { ...target } : null;

  if (wanted === "none") {
    const index = rows.findIndex((row) => row.user_id === userId);
    if (index >= 0) rows.splice(index, 1);
    profile.role = "owner";
  } else {
    if (target) {
      target.role = wanted;
      target.updated_at = new Date().toISOString();
    } else {
      rows.push({
        tenant_id: null,
        user_id: userId,
        email: profile.email,
        role: wanted,
        protected: false,
        granted_by: actorEmail,
        granted_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });
    }
    profile.role = "admin";
  }

  const after = rows.find((row) => row.user_id === userId) || null;
  writeAudit(root, actorEmail, wanted === "none" ? "admin.revoke" : "admin.set_role", "admin_users", userId, reason, before, after);
  save(root);
  return { ok: true, result: { user_id: userId, previous, role: wanted } };
}

function resetCredits(root, body) {
  const userId = text(body.userId, 64);
  const reason = text(body.reason, 400) || null;
  if (!userId) throw new FunctionError("A user id is required.");
  const subs = tableOf(root, "subscriptions");
  const sub = subs.find((row) => row.user_id === userId);
  if (!sub) throw new FunctionError("That customer has no subscription row.", { status: 404, code: "not_found" });

  const before = { ...sub };
  const used = Number(sub.ai_credits_used || 0);
  sub.ai_credits_used = 0;
  sub.ai_period_start = new Date().toISOString();
  sub.updated_at = new Date().toISOString();

  tableOf(root, "subscription_events").push({
    id: nextId("subevt"),
    user_id: userId,
    actor_id: null,
    action: "credits_reset",
    from_plan: sub.plan,
    to_plan: sub.plan,
    credits_reset: true,
    reason,
    created_at: new Date().toISOString()
  });

  writeAudit(root, "sandbox-admin", "subscription.reset_credits", "subscriptions", sub.id, reason, before, { ...sub });
  save(root);
  return { ok: true, result: { ok: true, credits_used_before: used } };
}

function subscriptionChange(root, adminEmail, body) {
  const userId = text(body.userId, 64);
  const plan = text(body.plan, 20) || null;
  const status = text(body.status, 20) || null;
  const reason = text(body.reason, 400) || null;
  if (!userId) throw new FunctionError("A user id is required.");
  if (!plan && !status) throw new FunctionError("Supply a plan or a status.");
  if (plan && !PLAN_LIMITS[plan]) throw new FunctionError("Plan must be free, pro or enterprise.");
  if (status && !["active", "past_due", "cancelled", "trialing"].includes(status)) {
    throw new FunctionError("Status must be active, past_due, cancelled or trialing.");
  }

  const subs = tableOf(root, "subscriptions");
  let sub = subs.find((row) => row.user_id === userId);
  if (!sub) {
    sub = {
      id: nextId("sub"),
      user_id: userId,
      plan: plan || "free",
      status: status || "active",
      ai_credits_used: 0,
      ai_credits_limit: PLAN_LIMITS[plan || "free"].credits,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    subs.push(sub);
  }

  const before = { ...sub };
  const fromPlan = sub.plan;
  const fromStatus = sub.status;
  if (plan) {
    sub.plan = plan;
    sub.ai_credits_limit = PLAN_LIMITS[plan].credits;
    if (plan !== fromPlan) {
      sub.ai_credits_used = 0;
      sub.ai_period_start = new Date().toISOString();
    }
  }
  if (status) sub.status = status;
  sub.updated_at = new Date().toISOString();

  tableOf(root, "subscription_events").push({
    id: nextId("subevt"),
    user_id: userId,
    actor_id: null,
    action: plan && plan !== fromPlan ? "plan_changed" : "status_changed",
    from_plan: fromPlan,
    to_plan: sub.plan,
    from_status: fromStatus,
    to_status: sub.status,
    credits_reset: false,
    reason,
    created_at: new Date().toISOString()
  });

  writeAudit(root, adminEmail, "subscription.update", "subscriptions", sub.id, reason, before, { ...sub });
  save(root);
  return { ok: true, result: { ok: true, plan: sub.plan, status: sub.status } };
}

function paymentDelete(root, adminEmail, body) {
  const paymentId = text(body.paymentId, 64);
  const reason = text(body.reason, 400);
  const hard = body.hard === true;
  if (!paymentId) throw new FunctionError("A payment id is required.");
  if (reason.length < 3) throw new FunctionError("A reason is required to remove a payment record.");

  const rows = tableOf(root, "payments");
  const index = rows.findIndex((row) => row.id === paymentId);
  if (index === -1) throw new FunctionError("Payment not found.", { status: 404, code: "not_found" });

  const row = rows[index];
  const before = { ...row };
  const protectedState = ["verified", "awaiting_verification", "refunded"].includes(row.status);
  const removal = protectedState || !hard ? "voided" : "deleted";

  if (removal === "deleted") {
    rows.splice(index, 1);
    writeAudit(root, adminEmail, "payment.hard_delete", "payments", paymentId, reason, before, null);
  } else {
    row.deleted_at = new Date().toISOString();
    row.deletion_reason = reason;
    if (row.status === "verified") {
      row.voided_at = row.deleted_at;
      row.void_reason = reason;
    }
    writeAudit(root, adminEmail, row.status === "verified" ? "payment.void" : "payment.archive", "payments", paymentId, reason, before, { ...row });
  }

  save(root);
  return { ok: true, result: { ok: true, removal, status: row.status } };
}

function archiveRecord(root, adminEmail, body) {
  const name = text(body.table, 40);
  const id = text(body.id, 64);
  const reason = text(body.reason, 400) || null;
  const allowed = {
    support_tickets: "archived_at",
    contact_messages: "archived_at",
    admin_announcements: "deleted_at",
    customer_activity: "deleted_at"
  };
  if (!allowed[name]) throw new FunctionError("That table cannot be archived.");
  if (!id) throw new FunctionError("A record id is required.");

  const rows = tableOf(root, name);
  const row = rows.find((entry) => entry.id === id);
  if (!row) throw new FunctionError("Record not found.", { status: 404, code: "not_found" });

  const before = { ...row };
  row[allowed[name]] = new Date().toISOString();
  writeAudit(root, adminEmail, "record.archive", name, id, reason, before, null);
  save(root);
  return { ok: true, result: { ok: true, table: name, id } };
}

function auditLog(root, body) {
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
  return {
    entries: [...tableOf(root, "admin_audit")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
  };
}

function monitorProbes(root) {
  const started = Date.now();
  const counts = {
    profiles: tableOf(root, "profiles").length,
    payments: tableOf(root, "payments").filter((row) => !row.deleted_at).length,
    projects: tableOf(root, "projects").length
  };
  return {
    checks: [
      { name: "Sandbox store · readable", ok: true, ms: Date.now() - started, detail: `${counts.profiles} accounts` },
      { name: "Payments · readable", ok: true, ms: 0, detail: `${counts.payments} live records` },
      { name: "Projects · readable", ok: true, ms: 0, detail: `${counts.projects} projects` },
      {
        name: "Supabase · not used in this session",
        ok: true,
        ms: null,
        detail: "This is the pre-launch sandbox. Database, storage and auth probes run in the deployed console."
      }
    ],
    last_projects: tableOf(root, "projects")
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 3),
    checked_at: new Date().toISOString(),
    source: "live reads of the sandbox store on every request"
  };
}

function activity(root, body) {
  const limit = Math.min(Number(body.limit) || 100, 300);
  const rows = tableOf(root, "customer_activity")
    .filter((row) => !row.deleted_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
  const people = profileIndex(root);
  return { activity: withCustomer(rows, "user_id", people) };
}

function contacts(root) {
  return {
    messages: [...tableOf(root, "contact_messages")]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 200)
  };
}

function contactUpdate(root, body) {
  const id = text(body.id, 64);
  const status = text(body.status, 20);
  if (!id || !["new", "read", "replied", "archived"].includes(status)) {
    throw new FunctionError("A message and a valid status are required.");
  }
  const message = tableOf(root, "contact_messages").find((row) => row.id === id);
  if (!message) throw new FunctionError("Message not found.", { status: 404, code: "not_found" });
  message.status = status;
  save(root);
  return { ok: true };
}

function admins(root) {
  return {
    admins: tableOf(root, "admin_users"),
    note: "Pre-launch administrator rights come from PRELAUNCH_ADMIN_EMAIL on the server. Additional administrators are granted in the database."
  };
}

/* -------------------------------------------------------------------- AI */

const AI_TEXT_ACTIONS = new Set(["chat", "copy", "support_reply", "domain_ideas"]);

async function ai(root, session, body) {
  const action = text(body.action, 40);
  const keyed = sandboxAi.aiConfigured();

  if (!keyed) {
    throw new FunctionError("AI is not configured on this server.", {
      status: 503,
      code: "ai_unconfigured",
      hint:
        "Set SHINZORA_AI_API_KEY_1 (or SHINZORA_AI_API_KEY) in .env (local) or in the Vercel project settings, then reload. The pre-launch account is fully wired — the key is the only missing piece."
    });
  }

  /* Which models may honestly be offered. Metadata only: no credit is spent and
     nothing is generated, so the picker never shows a model that cannot be used. */
  if (action === "models") {
    const capability = text(body.capability, 30) || "site";
    const models = await sandboxAi.availableModels(capability);
    return {
      capability,
      verified: models.length > 0,
      models,
      usage: null
    };
  }

  /* Builder generation, implemented here as well as in the Edge Function so a
     pre-launch session can actually build a project instead of waiting for an
     action the sandbox refused to run. */
  if (action === "generate" || action === "revise") {
    const requested = text(body.model, 80);
    const capability = action === "generate" ? "site" : "project_modification";
    if (requested && !(await sandboxAi.isUsable(requested, capability))) {
      throw new FunctionError("That model is not available on this deployment right now.", {
        status: 400,
        code: "model_unavailable",
        hint: "Pick another model, or leave it on Automatic."
      });
    }

    try {
      if (action === "generate") {
        const briefText = text(body.brief, 4000);
        if (briefText.length < 20) {
          throw new FunctionError("Describe the project in at least a sentence or two.", {
            status: 400,
            code: "invalid_input",
            hint: "A good brief says what the business sells, who it serves and what the main action should be."
          });
        }
        const result = await sandboxAi.generate({
          type: text(body.type, 20) || "website",
          name: text(body.name, 90) || "Untitled project",
          brief: briefText,
          pages: listOf(body.pages, 8),
          style: text(body.style, 400),
          business:
            body.business && typeof body.business === "object"
              ? body.business
              : tableOf(root, "businesses").find((row) => row.owner_id === session.account.id) ?? null,
          model: requested
        });
        monitor.record(root, {
          type: "ai.generate",
          severity: "info",
          message: `Generated ${Object.keys(result.files).length} files with ${result.model}`,
          actor: actorOf(session),
          meta: { files: Object.keys(result.files) }
        });
        return { ...result, usage: null };
      }

      const files = sandboxAi.sanitiseFiles(body.files);
      if (!Object.keys(files).length) {
        throw new FunctionError("No project files were supplied to revise.", {
          status: 400,
          code: "invalid_input",
          hint: "Open the project and reload its latest version before requesting a revision."
        });
      }
      const revision = text(body.instruction, 2000);
      if (revision.length < 3) {
        throw new FunctionError("Describe the change you want.", { status: 400, code: "invalid_input" });
      }
      return await sandboxAi.revise({ instruction: revision, files, pages: listOf(body.pages, 12), model: requested });
    } catch (error) {
      if (error instanceof FunctionError) throw error;
      throw new FunctionError(error?.message || "The AI request failed.", {
        status: error?.status || 502,
        code: error?.code || "ai_error",
        hint: error?.hint || ""
      });
    }
  }

  if (!AI_TEXT_ACTIONS.has(action)) {
    throw new FunctionError(`The builder action "${action}" is not available in this environment.`, {
      status: 501,
      code: "not_available_prelaunch",
      hint: "Deploy the Edge Functions and use a Supabase account for this action."
    });
  }

  /* Chat arrives as { message, conversationId?, context? } — the same contract as
     the `ai` Edge Function. Other text actions take a prompt/topic/message. */
  let conversationId = null;
  let history = [];
  let prompt = "";

  if (action === "chat") {
    prompt = text(body.message || body.prompt, 4000);
    if (!prompt) throw new FunctionError("Write a message first.", { status: 400, code: "invalid_input" });

    const conversations = tableOf(root, "ai_conversations");
    conversationId = text(body.conversationId, 64) || null;
    if (conversationId) {
      const owned = conversations.find((row) => row.id === conversationId && row.user_id === session.account.id);
      if (!owned) throw new FunctionError("That conversation does not belong to you.", { status: 404, code: "not_found" });
    } else {
      conversationId = nextId("conv");
      conversations.push({
        id: conversationId,
        user_id: session.account.id,
        tenant_id: session.account.tenantId,
        title: prompt.slice(0, 70),
        kind: "assistant",
        project_id: null,
        created_at: now(),
        updated_at: now()
      });
    }

    history = tableOf(root, "ai_messages")
      .filter((row) => row.conversation_id === conversationId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-16)
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({ role: row.role === "assistant" ? "model" : "user", parts: [{ text: row.content }] }));

    tableOf(root, "ai_messages").push({
      id: nextId("msg"),
      conversation_id: conversationId,
      role: "user",
      content: prompt,
      tokens: null,
      meta: {},
      created_at: now()
    });
  } else {
    prompt = text(body.prompt || body.message || body.topic, 8000);
    if (!prompt) throw new FunctionError("A prompt is required.");
  }

  /* Base URL is overridable so a self-hosted/proxied Gemini endpoint (or a test
     double) can be used without touching the code path. */
  const base = (process.env.SHINZORA_AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [...history, { role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    /* The provider's own wording is written for developers ("Quota exceeded for
       metric: generativelanguage.googleapis.com/…"). Translate it before it
       reaches a customer; keep the raw text out of the response entirely. */
    throw translateAiError(response.status, detail);
  }

  const payload = await response.json();
  const reply = (payload?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text || "").join("").trim();
  if (!reply) throw new FunctionError("The AI returned an empty response.", { status: 502, code: "ai_empty" });

  /* Persist the assistant turn and count usage against the sandbox subscription. */
  if (action === "chat" && conversationId) {
    tableOf(root, "ai_messages").push({
      id: nextId("msg"),
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
      tokens: null,
      meta: { model },
      created_at: now()
    });
    const conversation = tableOf(root, "ai_conversations").find((row) => row.id === conversationId);
    if (conversation) conversation.updated_at = now();
  }

  const sub = tableOf(root, "subscriptions").find((row) => row.user_id === session.account.id);
  if (sub) {
    sub.ai_credits_used = Number(sub.ai_credits_used || 0) + 1;
    sub.updated_at = now();
  }
  save(root);

  const usage = { used: sub?.ai_credits_used ?? null, limit: sub?.ai_credits_limit ?? null };
  if (action === "chat") return { reply, conversationId, model, usage };
  return { reply, model, action, usage };
}

/* ------------------------------------------------------------------ site */

function site(root, session, body) {
  const slug = text(body.slug, 80).toLowerCase();
  if (!slug) throw new FunctionError("A site slug is required.");
  const project = tableOf(root, "projects").find((row) => row.slug === slug && row.status === "published");
  if (!project) throw new FunctionError("No published site with that address.", { status: 404, code: "not_found" });
  /* Published sites are public reads in the deployed project (verify_jwt=false):
     a signed-out visitor can load /site/?p=slug. A signed-in account that does
     not own the site is still refused, so the ownership rule is unchanged. */
  if (session) {
    const isAdmin = session.account.role === "admin";
    if (!isAdmin && project.tenant_id !== session.account.tenantId) {
      throw new FunctionError("This site belongs to another workspace.", { status: 403, code: "forbidden" });
    }
  }
  const version = tableOf(root, "project_versions")
    .filter((row) => row.project_id === project.id)
    .sort((a, b) => Number(b.version_number) - Number(a.version_number))[0];

  return {
    project: { name: project.name, slug: project.slug, type: project.type, published_at: project.published_at },
    version: version ? { number: version.version_number, files: version.files } : null,
    /* The sandbox has no generated bundle, so the renderer shows its own empty
       state instead of inventing a website. */
    files: version?.files ?? {}
  };
}

/* ---------------------------------------------------------------- routing */

export async function handleFunction(root, name, action, payload, session) {
  /* Mirrors the deployed project's verify_jwt flags: `config` and `site` are
     public (provider flags, published-site reads); every other function needs a
     verified caller. Nothing here can be reached anonymously by accident. */
  const PUBLIC_FUNCTIONS = new Set(["config", "site"]);
  if (!session && !PUBLIC_FUNCTIONS.has(name)) {
    throw new FunctionError("Sign in to continue.", { status: 401, code: "unauthenticated" });
  }
  const isAdmin = session?.account?.role === "admin";

  if (name === "ai") return ai(root, session, { ...payload, action });
  if (name === "site") return site(root, session, payload);
  if (name === "payments") return customerPayments(root, session, { ...payload, action });
  if (name === "domains") return domainChecks({ ...payload, action });

  if (name === "admin") {
    if (!session) throw new FunctionError("Sign in to continue.", { status: 401, code: "unauthenticated" });
    if (!isAdmin) throw new FunctionError("Administrator access required.", { status: 403, code: "forbidden" });
    const adminEmail = session.account.displayEmail || ADMIN_ACCOUNT;
    const body = payload || {};
    switch (action) {
      case "overview": return overview(root);
      case "customers": return customers(root, body);
      case "customer": return customer(root, text(body.userId, 64));
      case "payments": return payments(root, body);
      case "payment_review": return paymentReview(root, adminEmail, body);
      case "service_requests": return serviceRequests(root, body);
      case "service_request_update": return serviceRequestUpdate(root, adminEmail, body);
      case "subscriptions": return subscriptions(root);
      case "subscription_update": return subscriptionChange(root, adminEmail, body);
      case "projects": return projects(root, body);
      case "deployments": return deployments(root);
      case "tickets": return tickets(root, body);
      case "ticket_reply": return ticketReply(root, adminEmail, body);
      case "ticket_status": return ticketStatus(root, body);
      case "announcements": return announcements(root);
      case "announcement_create": return announcementCreate(root, adminEmail, body);
      case "activity": return activity(root, body);
      case "contacts": return contacts(root);
      case "contact_update": return contactUpdate(root, body);
      case "admins": return admins(root);
      case "directory": return adminDirectory(root);
      case "set_role": return setRole(root, adminEmail, body);
      case "reset_credits": return resetCredits(root, body);
      case "subscription_change": return subscriptionChange(root, adminEmail, body);
      case "payment_delete": return paymentDelete(root, adminEmail, body);
      case "archive_record": return archiveRecord(root, adminEmail, body);
      case "audit": return auditLog(root, body);
      case "monitor": return monitorProbes(root);
      default:
        throw new FunctionError(`Unknown admin action "${action}".`, { status: 400, code: "unknown_action" });
    }
  }

  /* domains / payments / integrations / config stay Supabase-only: they need
     registrar keys, a payment secret and OAuth apps. Pretending otherwise would
     be a fake result, so the sandbox says exactly what is missing. */
  /* Provider flags, identical in shape to the `config` Edge Function. Booleans
     and model names only — never a key. The AI flag is the real one, so the UI
     can tell the operator exactly which secret is missing. */
  if (name === "config") {
    const aiKey = sandboxAi.aiConfigured();
    const model = process.env.SHINZORA_AI_MODEL || process.env.GEMINI_MODEL || "gemini-3.8-flash";
    return {
      available: true,
      environment: "prelaunch",
      ai: { configured: Boolean(aiKey), model: aiKey ? model : null, key_env: aiKey ? null : "SHINZORA_AI_API_KEY" },
      payments: {
        upi_configured: Boolean(process.env.UPI_ID),
        upi_payee_name: process.env.UPI_ID ? process.env.UPI_PAYEE_NAME || "Shinzora" : null,
        upi_id: process.env.UPI_ID || null,
        razorpay_configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
        razorpay_key_id: process.env.RAZORPAY_KEY_ID || null,
        mode: process.env.PAYMENTS_MODE || "manual_verification"
      },
      domains: {
        provider: process.env.DOMAIN_PROVIDER || "none",
        configured: Boolean(process.env.DOMAIN_PROVIDER && process.env.DOMAIN_PROVIDER !== "none" && process.env.DOMAIN_API_KEY),
        availability:
          process.env.DOMAIN_PROVIDER && process.env.DOMAIN_PROVIDER !== "none" && process.env.DOMAIN_API_KEY
            ? "registrar"
            : String(process.env.DOMAIN_AVAILABILITY || "rdap").toLowerCase() === "off"
              ? "off"
              : "rdap",
        registration_configured: Boolean(process.env.DOMAIN_PROVIDER && process.env.DOMAIN_PROVIDER !== "none" && process.env.DOMAIN_API_KEY),
        subdomain_root: process.env.SUBDOMAIN_ROOT || "shinzora.in"
      },
      integrations: {
        github_configured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
        vercel_configured: Boolean(process.env.VERCEL_TOKEN || (process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET))
      },
      email: { provider: process.env.EMAIL_PROVIDER || "supabase" }
    };
  }

  throw new FunctionError(`The "${name}" service is not part of the pre-launch sandbox.`, {
    status: 501,
    code: "not_available_prelaunch",
    hint:
      "Domains, payments and integrations need their provider credentials and the deployed Edge Functions. Nothing is simulated."
  });
}

export { FunctionError, PLAN_LIMITS };
export default handleFunction;
