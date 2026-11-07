#!/usr/bin/env node
/**
 * Shinzora — local development server
 * ---------------------------------------------------------------------------
 * A tiny static server that mirrors the Vercel hosting behaviour used in
 * production:
 *   /app            → /app/index.html   (clean URLs, like vercel.json)
 *   /app/           → /app/index.html
 *   /css/base.css   → static asset with cache headers
 *   404             → /404.html
 *
 * It also generates /js/config/runtime.js from the environment on every
 * request, so changing .env does not require a rebuild. Only public values
 * are ever written there — never a Gemini, Razorpay or service_role secret.
 *
 * Usage:  node scripts/dev-server.mjs [--port 4173]
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handlePrelaunchRequest, bootMonitor } from "../server/prelaunch/router.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = Number(portArg > -1 ? args[portArg + 1] : process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";

/*
 * Frame policy.
 * ---------------------------------------------------------------------------
 * Local development is often viewed through a proxy that embeds the page in an
 * iframe on a different origin (hosted preview, device mirror, screenshot
 * service). `X-Frame-Options: SAMEORIGIN` and an implicit
 * `frame-ancestors 'self'` would block that, so the dev server allows framing.
 *
 * Production does NOT inherit this: vercel.json keeps the strict policy, and
 * `--strict-frames` (or FRAME_MODE=strict) reproduces it locally for testing.
 */
const STRICT_FRAMES = args.includes("--strict-frames") || process.env.FRAME_MODE === "strict";
const ALLOW_CACHE = process.argv.includes("--cache");

/* -------------------------------------------------------------------------- */
/* .env loading (no dependencies)                                             */
/* -------------------------------------------------------------------------- */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  const out = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || line.trim().startsWith("#")) continue;
      out[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

/* The pre-launch modules read process.env directly (they are also used by the
   Vercel function, where the platform injects the variables). Mirror the parsed
   .env into process.env so both entry points behave identically. */
/* Configuration the sandbox genuinely reads: the pre-launch accounts, the model
   name, and the public provider settings (UPI payee, subdomain root, email
   provider). Secret provider keys stay out — the sandbox never calls those.
   The AI key is mirrored only so the UI can say "configured" truthfully. */
const MIRRORED = /^(PRELAUNCH_[A-Z0-9_]+|SHINZORA_AI_(API_KEY|MODEL|MODEL_FALLBACKS)|GEMINI_API_KEY|GOOGLE_API_KEY|GEMINI_MODEL|UPI_ID|UPI_PAYEE_NAME|PAYMENTS_MODE|SUBDOMAIN_ROOT|DOMAIN_PROVIDER|DOMAIN_API_URL|EMAIL_PROVIDER|SITE_ENV)$/;
for (const [key, value] of Object.entries(env)) {
  if (MIRRORED.test(key) && value != null && process.env[key] == null) process.env[key] = String(value);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".sql": "text/plain; charset=utf-8"
};

/*
 * `'unsafe-inline'` for scripts is deliberate.
 *
 * Generated projects are written into a sandboxed iframe (no allow-same-origin),
 * so their code cannot reach this origin's storage, cookies or DOM — but a
 * srcdoc document inherits this policy, and a generated site's only script is an
 * inline one. With it blocked the local preview rendered a dead page while
 * production (which sets no CSP at all) worked, and QA disagreed with the
 * deployed product. The frame stays sandboxed; the app's own scripts are all
 * external files, so nothing in Shinzora itself needs this allowance.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co https://images.pexels.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-src 'self' blob: data:",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  STRICT_FRAMES ? "frame-ancestors 'self'" : "frame-ancestors *"
].join("; ");

/*
 * Redirects.
 * ---------------------------------------------------------------------------
 * vercel.json sends /login, /signup, /dashboard and /pricing to their canonical
 * paths, and those short links get shared. Without them the dev server answers
 * 404 for a URL that works in production, which makes local QA disagree with the
 * deployed site. They are read from vercel.json itself so the two cannot drift.
 */
const REDIRECTS = (() => {
  const map = new Map();
  try {
    const file = path.join(ROOT, "vercel.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const rule of json.redirects || []) {
      if (!rule.source || !rule.destination) continue;
      /* Only exact, non-pattern sources are mirrored; a regex source is a
         Vercel feature this server does not pretend to implement. */
      if (/[()*+?[\]\\]/.test(rule.source)) continue;
      map.set(rule.source.replace(/\/$/, ""), {
        destination: rule.destination,
        status: rule.permanent ? 308 : 307
      });
    }
  } catch {
    /* No vercel.json: run without redirects. */
  }
  return map;
})();

function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`)
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * The site URL the browser should be told about.
 *
 * `.env` ships `SITE_URL=http://localhost:4173`, which is correct for a laptop
 * and wrong for a hosted preview: the page is served from a public origin, the
 * user's browser is not inside this sandbox, and anything built from SITE_URL —
 * OAuth redirects, email-verification links, canonical tags — would point at an
 * address that only resolves on the machine running the server.
 *
 * So a *loopback* configured value defers to the request origin whenever the
 * request did not itself arrive on loopback. A real configured domain (or the
 * production value) is always honoured.
 */
function siteUrl(origin) {
  const configured = String(env.SITE_URL || "").trim();
  if (!configured) return origin;
  try {
    const configuredUrl = new URL(configured);
    const requestUrl = new URL(origin);
    if (LOCAL_HOSTS.has(configuredUrl.hostname) && !LOCAL_HOSTS.has(requestUrl.hostname)) {
      return origin.replace(/\/+$/, "");
    }
    return configured.replace(/\/+$/, "");
  } catch {
    return configured;
  }
}

function runtimeConfigScript(origin = `http://localhost:${PORT}`) {
  const publicEnv = {
    SUPABASE_URL:
      env.SUPABASE_URL ||
      process.env.SHINZORA_SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      "https://zmkgfmlcpzjfgxdmbtvi.supabase.co",
    SUPABASE_PUBLISHABLE_KEY:
      env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SHINZORA_SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      "sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al",
    SITE_URL: siteUrl(origin),
    SUPPORT_EMAIL: env.SUPPORT_EMAIL || "official.shinzora@proton.me",
    APP_NAME: "Shinzora",
    ENVIRONMENT: env.ENVIRONMENT || "development"
  };
  return `/* generated by scripts/dev-server.mjs — public values only */\nwindow.__SHINZORA_ENV__ = ${JSON.stringify(
    publicEnv,
    null,
    2
  )};\n`;
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(PUBLIC, safe);
  if (!target.startsWith(PUBLIC)) return null;

  const attempts = [];
  if (safe.endsWith("/")) attempts.push(path.join(target, "index.html"));
  else {
    attempts.push(target, `${target}.html`, path.join(target, "index.html"));
  }

  for (const candidate of attempts) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/* Monitoring: log the boot and diff the deployable tree so website changes and
   feature updates show up in the administrator's timeline. */
try {
  bootMonitor(ROOT);
} catch (error) {
  console.warn("[dev-server] pre-launch monitor could not start:", error?.message);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Pre-launch accounts + sandbox API. Returns false for anything else so
    // static files keep working exactly as before.
    if (url.pathname.startsWith("/api/prelaunch")) {
      const handled = await handlePrelaunchRequest(req, res, { root: ROOT, url });
      if (handled) return;
    }

    // Health endpoint for smoke tests / uptime checks.
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "shinzora-web", mode: "dev", time: new Date().toISOString() }));
      return;
    }

    if (url.pathname === "/js/config/runtime.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(runtimeConfigScript(requestOrigin(req)));
      return;
    }

    const redirect = REDIRECTS.get(url.pathname.replace(/\/$/, ""));
    if (redirect) {
      const query = url.search || "";
      res.writeHead(redirect.status, {
        location: `${redirect.destination}${query}`,
        "cache-control": "no-store"
      });
      res.end();
      return;
    }

    const file = await resolveFile(url.pathname);
    const ext = file ? path.extname(file) : ".html";
    const body = file ? await fsp.readFile(file) : await fsp.readFile(path.join(PUBLIC, "404.html")).catch(() => Buffer.from("Not found"));
    const status = file ? 200 : 404;

    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      /* Development server: nothing is cacheable. A max-age here is how a
         stale CSS or JS module survives an edit and makes the running site look
         unchanged; opt in with --cache if you ever want the old behaviour. */
      "cache-control": ALLOW_CACHE && ext !== ".html" ? "public, max-age=3600" : "no-store"
    };
    // X-Frame-Options has no "allow a specific origin" value; omit it when the
    // dev server is meant to be embedded, and let CSP frame-ancestors decide.
    if (STRICT_FRAMES) headers["x-frame-options"] = "SAMEORIGIN";
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error("[dev-server]", error);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `\n  Shinzora dev server\n  → http://localhost:${PORT}\n  serving ${PUBLIC}\n  frames: ${
      STRICT_FRAMES ? "strict (same-origin only)" : "embeddable (preview friendly)"
    }\n`
  );
});
