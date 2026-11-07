#!/usr/bin/env node
/**
 * Shinzora — generate the public runtime config
 * ---------------------------------------------------------------------------
 * Writes public/js/runtime.js with PUBLIC values only. Run during the build
 * (`npm run build`, also invoked by Vercel). Anything that ends up here is
 * readable by anyone who loads the site, so secrets must never be referenced.
 *
 * Usage:  node scripts/generate-config.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* Must match the <script src> every page loads — see the guard in
   scripts/check.mjs. Writing to js/runtime.js instead of js/config/runtime.js
   silently shipped an empty config to production while dev worked, because the
   dev server injects js/config/runtime.js on the fly. */
const RUNTIME_URL = "/js/config/runtime.js";
const TARGET = path.join(ROOT, "public", RUNTIME_URL);

/* Minimal .env reader so the script works without dependencies. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(path.join(ROOT, ".env"));
const get = (key, fallback = "") => process.env[key] ?? fileEnv[key] ?? fallback;

/**
 * First non-empty value across a list of names.
 *
 * The project's own convention is `SHINZORA_*`; `VITE_*` is accepted as an
 * alias so a host that already sets the Vite-style names (Vercel dashboards,
 * copied snippets, CI providers) works without renaming anything. Both are
 * PUBLIC values — the publishable key is designed for the browser and is
 * protected by RLS, which is why it may live in the bundle at all.
 */
const firstOf = (...keys) => {
  for (const key of keys) {
    const value = get(key);
    if (value) return value;
  }
  return "";
};

const config = {
  SUPABASE_URL: firstOf("SHINZORA_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"),
  SUPABASE_PUBLISHABLE_KEY: firstOf(
    "SHINZORA_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY"
  ),
  SITE_URL: firstOf("SHINZORA_SITE_URL", "VITE_SITE_URL", "VITE_PUBLIC_SITE_URL"),
  SUPPORT_EMAIL: get("SHINZORA_SUPPORT_EMAIL", "official.shinzora@proton.me"),
  APP_NAME: get("SHINZORA_APP_NAME", "Shinzora"),
  ENVIRONMENT: get("SHINZORA_ENVIRONMENT", "production"),
  RAZORPAY_KEY_ID: get("SHINZORA_RAZORPAY_KEY_ID"),
  /* True only when a deployment actually mounts the pre-launch router.
     A static host (Vercel) does not, and probing it produced a 404 in the
     console of every page that resolves identity. */
  PRELAUNCH_API: get("SHINZORA_PRELAUNCH_API") === "1"
};

/* Refuse to write anything that looks like a secret. */
const FORBIDDEN = ["SERVICE_ROLE", "SECRET", "GEMINI", "PRIVATE", "WEBHOOK"];
const leaked = Object.entries(config).filter(
  ([key, value]) => FORBIDDEN.some((word) => key.toUpperCase().includes(word)) && String(value).length > 0
);
if (leaked.length) {
  console.error(`Refusing to write secrets into the public bundle: ${leaked.map(([key]) => key).join(", ")}`);
  process.exit(1);
}

/* A deploy that supplies no environment variables must not wipe a runtime.js
   that was already generated with real public values — that is how a site
   reaches production looking fine and authenticating nothing. The existing
   file is the baseline; environment variables override it. */
let existing = {};
try {
  const previous = fs.readFileSync(TARGET, "utf8");
  const json = previous.match(/window\.__SHINZORA_ENV__\s*=\s*(\{[\s\S]*\});/);
  if (json) existing = JSON.parse(json[1]);
} catch {
  existing = {};
}

const resolved = { ...existing };
/* SITE_URL always comes from the environment, even when it is empty: an empty
   value means "derive from location.origin at runtime", which is what a
   deployment wants. A stale build-machine URL must never survive. */
const ALWAYS_FROM_ENV = new Set(["SITE_URL", "PRELAUNCH_API"]);
for (const [key, value] of Object.entries(config)) {
  if (value !== "" && value !== null && value !== undefined) resolved[key] = value;
  else if (ALWAYS_FROM_ENV.has(key)) resolved[key] = value;
}

if (!resolved.SUPABASE_URL || !resolved.SUPABASE_PUBLISHABLE_KEY) {
  console.warn(
    "[shinzora] SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is empty — the site will load but auth and data will not work."
  );
} else if (!config.SUPABASE_URL) {
  console.log("[shinzora] no environment variables set — keeping the public values already in runtime.js");
}

const banner = `/* Generated by scripts/generate-config.mjs — do not edit by hand.
   Public values only. Secrets live in Supabase Edge Function secrets. */\n`;
const body = `window.__SHINZORA_ENV__ = ${JSON.stringify(resolved, null, 2)};\n`;

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, banner + body, "utf8");
console.log(`[shinzora] wrote ${path.relative(ROOT, TARGET)}`);
