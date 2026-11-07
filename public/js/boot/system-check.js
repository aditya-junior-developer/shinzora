/* ==========================================================================
   Shinzora — system check
   --------------------------------------------------------------------------
   Read-only diagnostics for a deployment. Every check performs a real request
   and reports what actually happened, with the exact remediation step.

   Statuses:
     pass — verified working
     warn — reachable but not configured (expected before secrets are set)
     fail — broken and needs attention
   ========================================================================== */

import { env } from "../config/env.js";
import { sb, getSession } from "../lib/supabase.js";

const TABLES = [
  "profiles",
  "businesses",
  "onboarding_progress",
  "subscriptions",
  "projects",
  "project_versions",
  "ai_conversations",
  "ai_messages",
  "domains",
  "domain_orders",
  "payments",
  "notifications",
  "admin_announcements",
  "support_tickets",
  "support_replies",
  "service_requests",
  "customer_activity",
  "store_products",
  "store_orders",
  "store_order_items",
  "store_customers",
  "campaigns",
  "integrations",
  "integration_tokens",
  "deployments",
  "admin_users",
  "contact_messages",
  "ai_usage_log"
];

const RPC = ["is_admin", "ai_usage_quota", "log_activity"];

const state = { results: [], running: false };

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ helpers */
function result({ group, name, status, detail = "", fix = "", code = "" }) {
  state.results.push({ group, name, status, detail, fix, code });
}


/* Probing 25 tables one after another means the page waits for the sum of every
   round trip. The probes are independent, so they run together — bounded so a
   slow project cannot open fifty sockets at once. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function rest(path, { method = "GET", body = null, apikey = env.supabaseKey, bearer = null } = {}) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey,
      Authorization: `Bearer ${bearer || apikey}`,
      "Content-Type": "application/json",
      Prefer: "count=exact"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function fn(name, { method = "GET", body = null } = {}) {
  const session = await getSession().catch(() => null);
  const response = await fetch(`${env.functionsUrl}/${name}`, {
    method,
    headers: {
      apikey: env.supabaseKey,
      Authorization: `Bearer ${session?.access_token || env.supabaseKey}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

const isMissingTable = (payload) =>
  Boolean(payload && (payload.code === "42P01" || /relation .* does not exist|Could not find the table/i.test(payload.message || "")));

/* ------------------------------------------------------------------- checks */
async function checkRuntime() {
  const configured = Boolean(env.supabaseUrl && env.supabaseKey);
  result({
    group: "Runtime",
    name: "Frontend configuration",
    status: configured ? "pass" : "fail",
    detail: configured ? `Supabase URL ${env.supabaseUrl}` : "SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is empty.",
    fix: configured
      ? ""
      : "Run `npm run build` with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY set, or check scripts/dev-server.mjs wrote /js/runtime.js."
  });

  try {
    const response = await fetch("/manifest.webmanifest", { cache: "no-store" });
    const manifest = await response.json();
    result({
      group: "Runtime",
      name: "PWA manifest",
      status: response.ok && manifest.name ? "pass" : "fail",
      detail: response.ok ? `${manifest.name} · ${(manifest.icons || []).length} icons` : `HTTP ${response.status}`,
      fix: response.ok ? "" : "Restore public/manifest.webmanifest and link it from the HTML head."
    });
  } catch (error) {
    result({ group: "Runtime", name: "PWA manifest", status: "fail", detail: String(error), fix: "public/manifest.webmanifest is missing or invalid JSON." });
  }

  try {
    const response = await fetch("/sw.js", { cache: "no-store", method: "GET" });
    result({
      group: "Runtime",
      name: "Service worker",
      status: response.ok ? "pass" : "fail",
      detail: response.ok ? "sw.js is served" : `HTTP ${response.status}`,
      fix: response.ok ? "" : "Restore public/sw.js; the install prompt depends on it."
    });
  } catch (error) {
    result({ group: "Runtime", name: "Service worker", status: "fail", detail: String(error), fix: "public/sw.js is missing." });
  }

  const icons = ["/assets/icons/icon-192.png", "/assets/icons/icon-512.png", "/assets/icons/apple-touch-icon.png"];
  const missing = [];
  for (const path of icons) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) missing.push(path);
    } catch {
      missing.push(path);
    }
  }
  result({
    group: "Runtime",
    name: "PWA icons",
    status: missing.length ? "fail" : "pass",
    detail: missing.length ? `Missing: ${missing.join(", ")}` : "192, 512 and Apple touch icons are served",
    fix: missing.length ? "Regenerate the icons (scripts in docs/BUILD.md) and place them in public/assets/icons/." : ""
  });
}

async function checkAuth() {
  try {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: env.supabaseKey }
    });
    const payload = await response.json().catch(() => ({}));
    result({
      group: "Auth",
      name: "Supabase Auth reachable",
      status: response.ok ? "pass" : "fail",
      detail: response.ok ? `GoTrue ${payload.version || "ok"} · ${payload.name || "auth"}` : `HTTP ${response.status}`,
      fix: response.ok ? "" : "Check the Supabase project URL and that the project is not paused."
    });
  } catch (error) {
    result({ group: "Auth", name: "Supabase Auth reachable", status: "fail", detail: String(error), fix: "Network or URL problem reaching Supabase." });
  }

  try {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/settings`, { headers: { apikey: env.supabaseKey } });
    const settings = await response.json();
    const email = settings?.external?.email;
    const google = settings?.external?.google;
    result({
      group: "Auth",
      name: "Providers",
      status: email ? "pass" : "warn",
      detail: `email: ${email ? "on" : "off"} · google: ${google ? "on" : "off"} · confirmations: ${
        settings?.mailer_autoconfirm ? "auto-confirm" : "required"
      }`,
      fix: email ? "" : "Enable the Email provider in Supabase → Authentication → Providers."
    });
  } catch (error) {
    result({ group: "Auth", name: "Providers", status: "warn", detail: String(error) });
  }

  const session = await getSession().catch(() => null);
  result({
    group: "Auth",
    name: "Current session",
    status: "pass",
    detail: session ? `Signed in as ${session.user.email}` : "No session (public checks only; sign in and re-run for authenticated checks)",
    fix: ""
  });
}

async function checkSchema() {
  const outcomes = await mapLimit(TABLES, 6, async (table) => {
    try {
      /* `select=*`, not `select=id`: three expected tables have no `id`
         column (onboarding_progress, integration_tokens, admin_users), and
         asking for one made a healthy table look missing. */
      const response = await rest(`${table}?select=*&limit=1`);
      return response.status === 404 || isMissingTable(response.json) ? table : null;
    } catch {
      return table;
    }
  });
  const missing = outcomes.filter(Boolean);

  if (!missing.length) {
    result({
      group: "Database",
      name: `Schema (${TABLES.length} tables)`,
      status: "pass",
      detail: "Every expected table is present and reachable with the publishable key."
    });
    return;
  }

  const unauthenticated = missing.filter((table) => ["integration_tokens", "ai_usage_log", "payments", "admin_users"].includes(table));
  const trulyMissing = missing.filter((table) => !unauthenticated.includes(table));

  result({
    group: "Database",
    name: "Schema",
    status: trulyMissing.length ? "fail" : "pass",
    detail: trulyMissing.length
      ? `${trulyMissing.length} of ${TABLES.length} tables are missing: ${trulyMissing.join(", ")}`
      : "All expected tables are present.",
    fix: trulyMissing.length
      ? "Run supabase/migrations/0001_schema.sql, then 0002_functions_rls.sql, then 0003_storage_realtime.sql in the Supabase SQL editor."
      : ""
  });

  if (unauthenticated.length) {
    result({
      group: "Database",
      name: "Service-role-only tables",
      status: "warn",
      detail: `${unauthenticated.join(", ")} are not readable anonymously — this is expected for RLS-protected tables when signed out.`,
      fix: "Sign in as the owner (or an administrator) and run the checks again to confirm."
    });
  }
}

/* --------------------------------------------------------------------------
   Schema compatibility (0005)
   A database that already held the early tables can pass the table-existence
   check above while still carrying the legacy column shapes. These probes ask
   PostgREST for the exact columns the application reads, so the difference
   surfaces here instead of as a confusing runtime error later.
   -------------------------------------------------------------------------- */
async function checkSchemaCompat() {
  const notes = [];

  // 1. onboarding_progress.data — added by 0001, absent on the legacy schema.
  const dataProbe = await rest("onboarding_progress?select=user_id,data&limit=0");
  if (dataProbe.status === 400 && /column .*data does not exist/i.test(dataProbe.json?.message || dataProbe.text || "")) {
    notes.push("onboarding_progress.data is missing");
  }

  // 2. current_step must be an integer. Comparing it to a non-numeric string
  //    yields 400 on an integer column and 200 on a text column, which is a
  //    read-only way to read the type back without touching any rows.
  const stepProbe = await rest("onboarding_progress?select=user_id&current_step=eq.zzz&limit=0");
  if (stepProbe.status === 200) {
    notes.push("onboarding_progress.current_step is still text");
  } else if (stepProbe.status === 400 && !/invalid input syntax/i.test(stepProbe.json?.message || "")) {
    notes.push("onboarding_progress.current_step could not be inspected");
  }

  // 3. Columns the notification centre and the quota meter read.
  const notifyProbe = await rest("notifications?select=body,read_at&limit=0");
  if (notifyProbe.status === 400) notes.push("notifications.body / read_at are missing");

  const quotaProbe = await rest("subscriptions?select=ai_credits_used,ai_credits_limit&limit=0");
  if (quotaProbe.status === 400) notes.push("subscriptions credit columns are missing");

  if (!notes.length) {
    result({
      group: "Database",
      name: "Schema compatibility (0005)",
      status: "pass",
      detail: "Legacy column shapes are reconciled: current_step is an integer, onboarding data / notification / quota columns are present."
    });
  } else {
    result({
      group: "Database",
      name: "Schema compatibility (0005)",
      status: "fail",
      detail: notes.join("; ") + ".",
      fix: "Run supabase/migrations/0005_schema_compat.sql in the Supabase SQL editor. It converts types, copies answers → data and message → body, and adds the unique / check constraints that a pre-existing table never received. It never drops a column."
    });
  }
}

async function checkRls() {
  // An anonymous SELECT on a protected table must return an empty set, not rows.
  try {
    const response = await rest("profiles?select=id&limit=1");
    const rows = Array.isArray(response.json) ? response.json.length : 0;
    result({
      group: "Security",
      name: "Row Level Security on profiles",
      status: rows === 0 ? "pass" : "fail",
      detail: rows === 0 ? "Anonymous request returned 0 rows (RLS enforced)" : `Anonymous request returned ${rows} row(s) — profiles are exposed`,
      fix: rows === 0 ? "" : "Run 0002_functions_rls.sql: profiles must have RLS enabled with owner-only policies."
    });
  } catch (error) {
    result({ group: "Security", name: "Row Level Security on profiles", status: "warn", detail: String(error) });
  }

  // A client must never be able to write a verified payment.
  const session = await getSession().catch(() => null);
  if (!session) {
    result({
      group: "Security",
      name: "Payments are not client-writable",
      status: "warn",
      detail: "Skipped — sign in to test that an insert into payments is refused.",
      fix: "Sign in and re-run."
    });
    return;
  }

  try {
    const response = await rest(
      "payments",
      {
        method: "POST",
        bearer: session.access_token,
        body: { owner_id: session.user.id, purpose: "selfcheck", amount: 1, status: "verified" }
      }
    );
    result({
      group: "Security",
      name: "Payments are not client-writable",
      status: response.ok ? "fail" : "pass",
      detail: response.ok ? "A client insert into payments succeeded — this is a security defect" : `Client insert refused (HTTP ${response.status})`,
      fix: response.ok ? "Ensure 0002_functions_rls.sql ran: payments must have no INSERT policy for authenticated users." : ""
    });
  } catch (error) {
    result({ group: "Security", name: "Payments are not client-writable", status: "warn", detail: String(error) });
  }

  try {
    const response = await rest("admin_users", {
      method: "POST",
      bearer: session.access_token,
      body: { user_id: session.user.id, role: "superadmin" }
    });
    result({
      group: "Security",
      name: "Self-promotion to admin refused",
      status: response.ok ? "fail" : "pass",
      detail: response.ok ? "A client insert into admin_users succeeded — privilege escalation is possible" : `Client insert refused (HTTP ${response.status})`,
      fix: response.ok ? "admin_users must have RLS enabled with no INSERT policy for any client role." : ""
    });
  } catch (error) {
    result({ group: "Security", name: "Self-promotion to admin refused", status: "warn", detail: String(error) });
  }
}

/* Each function is probed with a body PostgREST can actually resolve. A bare
   `{}` fails argument resolution for every function whose parameters have no
   defaults — the gateway answers "Could not find the function", which is
   indistinguishable from a function that was never created. `log_activity`
   takes a required `p_action`, so it is called with one. */
const RPC_BODY = {
  is_admin: {},
  ai_usage_quota: {},
  log_activity: { p_action: "system_check" }
};

async function checkRpc() {
  await mapLimit(RPC, 4, async (name) => {
    try {
      const response = await rest(`rpc/${name}`, { method: "POST", body: RPC_BODY[name] || {} });
      const text = response.json?.message || response.json?.hint || response.text || "";
      const missing =
        response.status === 404 ||
        /PGRST202|Could not find the function|function .* does not exist/i.test(text);
      result({
        group: "Database",
        name: `RPC ${name}()`,
        status: missing ? "fail" : "pass",
        detail: missing ? "Function not found" : `Responded (HTTP ${response.status})`,
        fix: missing ? "Run 0002_functions_rls.sql — it creates is_admin, ai_usage_quota and log_activity." : ""
      });
    } catch (error) {
      result({ group: "Database", name: `RPC ${name}()`, status: "warn", detail: String(error) });
    }
  });
}

/* `GET /storage/v1/bucket` is a service-role call: for a publishable key it
   answers 403 or an empty array whatever the project contains, so using it as an
   existence check reports a false failure on a correctly migrated database.
   Instead each bucket is probed with an upload whose mime type no bucket allows:
   storage rejects it *before* RLS and before writing anything, and the error
   differs depending on whether the bucket exists (invalid_mime_type vs
   NoSuchBucket). Nothing is ever uploaded.

   The three probes are independent and run together — the whole page used to
   make forty sequential round trips, which is what made it feel broken on a
   slow connection. */
async function checkStorage() {
  const expected = ["avatars", "brand-assets", "payment-proofs"];
  const outcomes = await mapLimit(expected, 3, async (bucket) => {
    try {
      const response = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/__system_check_probe__`, {
        method: "POST",
        headers: {
          apikey: env.supabaseKey,
          Authorization: `Bearer ${env.supabaseKey}`,
          "content-type": "application/x-shinzora-check-probe"
        },
        body: ""
      });
      const text = await response.text();
      if (/NoSuchBucket|Bucket not found/i.test(text)) return { bucket, state: "missing" };
      if (!/InvalidMimeType|invalid_mime_type|mime type/i.test(text)) {
        return { bucket, state: "unknown", detail: `HTTP ${response.status}` };
      }
      return { bucket, state: "ok" };
    } catch (error) {
      return { bucket, state: "unknown", detail: error.message };
    }
  });

  const missing = outcomes.filter((o) => o.state === "missing").map((o) => o.bucket);
  const unknown = outcomes.filter((o) => o.state === "unknown").map((o) => `${o.bucket} (${o.detail})`);

  result({
    group: "Database",
    name: "Storage buckets",
    status: missing.length ? "fail" : unknown.length ? "warn" : "pass",
    detail: missing.length
      ? `Missing: ${missing.join(", ")}`
      : unknown.length
        ? `Unrecognised answer from ${unknown.join(", ")}`
        : `${expected.join(", ")} all answer (probe rejected by mime policy, nothing uploaded)`,
    fix: missing.length ? "Run 0003_storage_realtime.sql." : ""
  });
}

async function checkFunctions() {
  let config = null;
  try {
    const response = await fn("config");
    if (response.ok && response.json) {
      config = response.json;
      result({
        group: "Edge Functions",
        name: "config",
        status: "pass",
        detail: `Reachable · environment ${config.environment || "unknown"}`
      });
    } else {
      result({
        group: "Edge Functions",
        name: "config",
        status: "fail",
        detail: `HTTP ${response.status} — ${(response.json?.error || response.text || "").slice(0, 160)}`,
        fix: "Deploy it: supabase functions deploy config --no-verify-jwt"
      });
    }
  } catch (error) {
    result({
      group: "Edge Functions",
      name: "config",
      status: "fail",
      detail: String(error),
      fix: "Functions are not reachable. Deploy with `supabase functions deploy`, or check the project URL."
    });
  }

  const providers = [
    {
      key: "ai",
      name: "AI (Gemini)",
      configured: config?.ai?.configured,
      warnFix: "supabase secrets set GEMINI_API_KEY=... then redeploy the ai function. Until then the builder shows a setup notice instead of generating.",
      passDetail: `Model ${config?.ai?.model || "gemini"} · key held server-side`
    },
    {
      key: "payments",
      name: "Payments",
      configured: config?.payments?.upi_configured || config?.payments?.razorpay_configured,
      warnFix: "supabase secrets set UPI_ID=... UPI_PAYEE_NAME=... (or Razorpay keys) then redeploy payments.",
      passDetail: `UPI QR: ${config?.payments?.upi_configured ? "configured" : "off"} · Razorpay: ${
        config?.payments?.razorpay_configured ? "configured" : "off"
      } · manual verification`
    },
    {
      key: "domains",
      name: "Domain registrar",
      configured: config?.domains?.configured,
      warnFix: "Set DOMAIN_PROVIDER, DOMAIN_API_URL and DOMAIN_API_KEY. Without a registrar the product refuses to invent availability or prices.",
      passDetail: `Provider ${config?.domains?.provider || "none"}`
    },
    {
      key: "github",
      name: "GitHub",
      configured: config?.integrations?.github_configured,
      warnFix: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable repository pushes.",
      passDetail: "OAuth client configured"
    },
    {
      key: "vercel",
      name: "Vercel",
      configured: config?.integrations?.vercel_configured,
      warnFix: "Set VERCEL_TOKEN (or Vercel OAuth credentials) to enable deployments.",
      passDetail: "Deployment token configured"
    }
  ];

  for (const provider of providers) {
    if (!config) {
      result({ group: "Providers", name: provider.name, status: "warn", detail: "Cannot be verified until `config` responds.", fix: provider.warnFix });
      continue;
    }
    result({
      group: "Providers",
      name: provider.name,
      status: provider.configured ? "pass" : "warn",
      detail: provider.configured ? provider.passDetail : "Not configured — dependent features are disabled rather than simulated.",
      fix: provider.configured ? "" : provider.warnFix
    });
  }

  // Authenticated functions must refuse an unauthenticated call.
  const session = await getSession().catch(() => null);
  if (session) {
    try {
      const ai = await fn("ai", { method: "POST", body: { action: "chat", message: "health check" } });
      const quota = ai.json?.code === "quota_exceeded";
      result({
        group: "Edge Functions",
        name: "ai",
        status: ai.ok || quota ? "pass" : ai.json?.code === "functions_unavailable" ? "warn" : "fail",
        detail: ai.ok
          ? "Responded to an authenticated request"
          : `${ai.json?.code || ai.status} — ${(ai.json?.error || "").slice(0, 140)}`,
        fix:
          ai.ok || quota
            ? ""
            : ai.json?.code === "functions_unavailable"
              ? "Set GEMINI_API_KEY for the ai function."
              : "Deploy the function and check its logs."
      });
    } catch (error) {
      result({ group: "Edge Functions", name: "ai", status: "fail", detail: String(error) });
    }
  } else {
    result({
      group: "Edge Functions",
      name: "ai",
      status: "warn",
      detail: "Sign in to test an authenticated call (unauthorised calls are expected to be refused).",
      fix: "Sign in and re-run."
    });
  }
}

async function checkAppData() {
  const session = await getSession().catch(() => null);
  if (!session) {
    result({
      group: "Application",
      name: "Your own data",
      status: "warn",
      detail: "Sign in to verify profile, business, onboarding and notification rows.",
      fix: "Sign in at /auth/login/ and re-run this page."
    });
    return;
  }

  const checks = [
    { table: "profiles", label: "Profile row", optional: false },
    { table: "subscriptions", label: "Subscription row", optional: false },
    { table: "onboarding_progress", label: "Onboarding progress", optional: true },
    { table: "businesses", label: "Business profile", optional: true },
    { table: "notifications", label: "Notifications", optional: true }
  ];

  for (const check of checks) {
    try {
      const { data, error } = await sb.from(check.table).select("*").limit(1);
      if (error) {
        result({
          group: "Application",
          name: check.label,
          status: check.optional ? "warn" : "fail",
          detail: error.message,
          fix: "Run the migrations, then refresh."
        });
        continue;
      }
      result({
        group: "Application",
        name: check.label,
        status: data && data.length ? "pass" : check.optional ? "warn" : "fail",
        detail: data && data.length ? `${data.length} row visible to you` : "No row yet — created after onboarding or first write.",
        fix: data && data.length ? "" : check.optional ? "" : "Sign out and in again so the handle_new_user trigger can create the row, or run 0002_functions_rls.sql."
      });
    } catch (error) {
      result({ group: "Application", name: check.label, status: "warn", detail: String(error) });
    }
  }

  try {
    const channel = sb.channel(`selfcheck-${Date.now()}`);
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("TIMED_OUT"), 6000);
      channel.subscribe((state_) => {
        if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(state_)) {
          clearTimeout(timer);
          resolve(state_);
        }
      });
    });
    sb.removeChannel(channel);
    result({
      group: "Application",
      name: "Realtime channel",
      status: status === "SUBSCRIBED" ? "pass" : "warn",
      detail: `Subscription state: ${status}`,
      fix: status === "SUBSCRIBED" ? "" : "Enable Realtime for notifications in Supabase → Database → Replication (0003_storage_realtime.sql does this)."
    });
  } catch (error) {
    result({ group: "Application", name: "Realtime channel", status: "warn", detail: String(error) });
  }
}

/* -------------------------------------------------------------------- paint */
function render() {
  const groups = new Map();
  state.results.forEach((item) => {
    const list = groups.get(item.group) || [];
    list.push(item);
    groups.set(item.group, list);
  });

  const mark = { pass: "✓", fail: "✕", warn: "!", run: "…" };

  document.getElementById("groups").innerHTML = Array.from(groups.entries())
    .map(
      ([group, items]) => `<section class="group">
        <h2>${group}</h2>
        <div class="checks">
          ${items
            .map(
              (item) => `<article class="check ${item.status}">
                <span class="dot" aria-hidden="true">${mark[item.status] || "?"}</span>
                <div class="body">
                  <div class="title">${escapeHtml(item.name)}<code>${item.status}</code></div>
                  ${item.detail ? `<div class="detail">${escapeHtml(item.detail)}</div>` : ""}
                  ${item.fix ? `<div class="fix"><b>Fix:</b> ${escapeHtml(item.fix)}</div>` : ""}
                </div>
              </article>`
            )
            .join("")}
        </div>
      </section>`
    )
    .join("");

  const counts = state.results.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
  el("count-pass").textContent = counts.pass || 0;
  el("count-warn").textContent = counts.warn || 0;
  el("count-fail").textContent = counts.fail || 0;
  el("count-total").textContent = state.results.length;

  el("json").textContent = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      supabase_url: env.supabaseUrl,
      summary: counts,
      results: state.results
    },
    null,
    2
  );
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/* ---------------------------------------------------------------------- run */
async function run() {
  if (state.running) return;
  state.running = true;
  state.results = [];
  document.getElementById("groups").innerHTML = `<div class="check run"><span class="dot">…</span><div class="body"><div class="title">Running checks</div><div class="detail">Querying Supabase and the Edge Functions.</div></div></div>`;
  el("status-note").textContent = "Running diagnostic run…";
  el("rerun").disabled = true;

  const steps = [checkRuntime, checkAuth, checkSchema, checkSchemaCompat, checkRls, checkRpc, checkStorage, checkFunctions, checkAppData];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      result({ group: "Diagnostics", name: step.name, status: "warn", detail: String(error) });
    }
    render();
  }

  const failures = state.results.filter((item) => item.status === "fail").length;
  const warnings = state.results.filter((item) => item.status === "warn").length;
  el("status-note").textContent = failures
    ? `${failures} check${failures === 1 ? "" : "s"} need attention, ${warnings} warning${warnings === 1 ? "" : "s"}.`
    : warnings
      ? `No failures. ${warnings} warning${warnings === 1 ? "" : "s"} — usually an unconfigured provider.`
      : "All checks passed.";

  el("rerun").disabled = false;
  state.running = false;
}

document.getElementById("rerun").addEventListener("click", run);
document.getElementById("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el("json").textContent);
    el("status-note").textContent = "Report copied to the clipboard.";
  } catch {
    el("status-note").textContent = "Clipboard is blocked — open the raw report and copy manually.";
  }
});
document.getElementById("toggle-json").addEventListener("click", () => {
  el("json").classList.toggle("hidden");
});

run();
