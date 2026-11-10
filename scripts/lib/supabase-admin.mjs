/* ==========================================================================
   Small admin client for the release scripts
   --------------------------------------------------------------------------
   Everything here talks to Supabase's Management API with a personal access
   token (SUPABASE_ACCESS_TOKEN). That token is never printed, never written to a
   file and never sent to a browser: the scripts read it from the environment or
   from .env, which is gitignored.

   Why the Management API rather than psql: it runs arbitrary SQL against the
   project over HTTPS, so a migration can be applied from anywhere without a
   database password, and every statement is recorded against the project.
   ========================================================================== */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readEnvFile(file = path.join(ROOT, ".env")) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

export function config() {
  const file = readEnvFile();
  const get = (key) => process.env[key] || file[key] || "";
  const url = get("SUPABASE_URL") || get("VITE_SUPABASE_URL");
  const ref = get("SUPABASE_PROJECT_REF") || (url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || "";
  return {
    url,
    ref,
    anonKey: get("VITE_SUPABASE_ANON_KEY") || get("SUPABASE_PUBLISHABLE_KEY"),
    accessToken: get("SUPABASE_ACCESS_TOKEN"),
    dbUrl: get("SUPABASE_DB_URL") || get("DATABASE_URL"),
    serviceRoleKey: get("SUPABASE_SERVICE_ROLE_KEY")
  };
}

/** Run one SQL statement through the Management API and return its rows. */
export async function sql(query, { token, ref } = {}) {
  const cfg = config();
  const accessToken = token || cfg.accessToken;
  const projectRef = ref || cfg.ref;
  if (!accessToken) {
    const error = new Error("SUPABASE_ACCESS_TOKEN is not set.");
    error.code = "no_token";
    throw error;
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, read_only: false })
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = typeof body === "object" ? body.message || JSON.stringify(body) : String(body);
    const error = new Error(`Management API ${res.status}: ${message.slice(0, 400)}`);
    error.status = res.status;
    throw error;
  }
  return Array.isArray(body) ? body : [];
}

/** Public tables and their row counts, read over the REST API with the anon key. */
export async function restProbe(pathname) {
  const cfg = config();
  if (!cfg.url || !cfg.anonKey) return { status: 0, body: null };
  const res = await fetch(`${cfg.url}/rest/v1/${pathname}`, {
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

/** The tables the application actually reads. Order matters only for reading. */
/* Every table the migrations create in `public`, in dependency order
   (parents before children). `scripts/check.mjs` fails the build if a migration
   creates a table that is missing from this list — an incomplete backup is worse
   than no backup, because it looks like one.

   `auth.users` is NOT here: it is not readable through this API and restoring
   identity rows from JSON would be reckless. Use the pg_dump path (set
   SUPABASE_DB_URL) when you need the user accounts themselves. */
export const APPLICATION_TABLES = [
  "profiles", "businesses", "subscriptions", "subscription_events", "onboarding_progress",
  "projects", "project_versions", "deployments", "store_products", "inventory_movements",
  "store_orders", "store_order_items", "store_customers", "campaigns",
  "support_tickets", "support_replies", "service_requests", "service_request_notes",
  "domains", "domain_orders", "payments", "payment_webhook_events",
  "notifications", "customer_activity", "ai_conversations", "ai_messages", "ai_usage_log",
  "admin_announcements", "contact_messages", "admin_users", "admin_audit", "migration_notes",
  "migration_archive", "integrations", "integration_tokens",
  "ai_generation_jobs", "conversion_jobs", "marketing_accounts",
  "marketing_requests", "marketing_request_events",
  "admin_conversations", "admin_conversation_participants", "admin_messages",
  "business_team_invites", "business_team_members", "team_conversations",
  "team_conversation_members", "team_chat_messages",
  "freelancer_profiles", "marketplace_jobs", "marketplace_proposals",
  "marketplace_contracts", "marketplace_reviews", "marketplace_job_questions"
];

/* Restoring these writes provider credentials back into the database, so the
   backup folder holds secrets. The tools say so out loud rather than pretending
   the folder is harmless. */
export const SECRET_BEARING_TABLES = ["integrations", "integration_tokens"];
