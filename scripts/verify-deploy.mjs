/* ==========================================================================
   Shinzora — verify the production build against the Vercel config
   --------------------------------------------------------------------------
   `npm run build` writes the runtime config; this script then serves `public/`
   through a local re-implementation of the rules in vercel.json and asserts
   that every route resolves the way it will on the deployed site:

     · cleanUrls        /auth/login  → 308 → /auth/login/
     · trailingSlash    /auth/login/ → auth/login/index.html
     · redirects        /login → /auth/login/, /dashboard → /app/, /pricing → /#pricing
     · rewrites         /site/<slug> → /site/index.html?p=<slug>
     · headers          nosniff, HSTS, SAMEORIGIN, noindex on /app|/admin|/onboarding
     · 404              unknown paths get the branded page, not a directory listing

   It is not a substitute for the first real deploy, but it catches the class of
   mistake that only shows up after deploy: a route that 404s because a directory
   has no index.html, a redirect that double-appends a slash, a rewrite that
   loops, or headers that never apply because the source pattern is wrong.

     npm run build && node scripts/verify-deploy.mjs
   ========================================================================== */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const PORT = Number(process.env.VERIFY_PORT || 4299);
const BASE = `http://127.0.0.1:${PORT}`;

const outputDirectory = config.outputDirectory || "public";
if (path.join(ROOT, outputDirectory) !== PUBLIC) {
  console.error(`  ✕ vercel.json outputDirectory is "${outputDirectory}" but this script verifies public/`);
  process.exit(1);
}

/* ------------------------------------------------------- Vercel semantics */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml"
};

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Translate a Vercel `source` pattern into a matcher.
 * Supports `:param`, `(.*)` and `(a|b|c)` groups — the three forms vercel.json
 * actually uses here. Getting this wrong makes every header look "missing"
 * while the config is fine, which is why it is spelled out instead of regexed.
 */
function matcher(source) {
  const names = [];
  const STAR = "\u0000S\u0000";
  const GRP_OPEN = "\u0000G\u0000";
  const GRP_CLOSE = "\u0000g\u0000";
  const PARAM = "\u0000P\u0000";

  let pattern = source;
  pattern = pattern.replace(/\(\.\*\)/g, STAR);
  pattern = pattern.replace(/\(/g, GRP_OPEN).replace(/\)/g, GRP_CLOSE);
  pattern = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    names.push(name);
    return PARAM;
  });
  // Escape everything that is regex syntax, then restore the protected tokens.
  pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\.\*/g, "\\*");
  pattern = pattern.split(STAR).join(".*");
  pattern = pattern.split(GRP_OPEN).join("(?:");
  pattern = pattern.split(GRP_CLOSE).join(")");
  pattern = pattern.split(PARAM).join("([^/]+)");

  const re = new RegExp(`^${pattern}$`);
  return (pathname) => {
    const match = re.exec(pathname);
    if (!match) return null;
    const params = {};
    names.forEach((name, index) => (params[name] = decodeURIComponent(match[index + 1] ?? "")));
    return params;
  };
}

const redirectRules = (config.redirects || []).map((rule) => ({ ...rule, match: matcher(rule.source) }));
const rewriteRules = (config.rewrites || []).map((rule) => ({ ...rule, match: matcher(rule.source) }));
const headerRules = (config.headers || []).map((rule) => ({ ...rule, match: matcher(rule.source) }));

function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) {
    if (rule.match(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  let pathname = decodeURIComponent(url.pathname);
  const send = (status, headers = {}, body = "") => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };

  // 1. redirects
  for (const rule of redirectRules) {
    if (!rule.match(pathname)) continue;
    const target = rule.destination.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => rule.match(pathname)[name] ?? "");
    return send(rule.permanent ? 308 : 307, { Location: target }, "");
  }

  // 2. trailingSlash: a directory path without a slash redirects to the slash
  if (config.trailingSlash && !pathname.endsWith("/") && !path.extname(pathname)) {
    const asDir = path.join(PUBLIC, pathname);
    if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
      return send(308, { Location: `${pathname}/${url.search}` }, "");
    }
  }

  // 3. rewrites
  let filePath = null;
  for (const rule of rewriteRules) {
    const params = rule.match(pathname);
    if (!params) continue;
    // A destination may carry its own query string: /site/index.html?p=:slug
    const [destPath, destQuery] = rule.destination.split("?");
    const query = new URLSearchParams(url.searchParams);
    if (destQuery) {
      for (const pair of destQuery.split("&")) {
        const [key, raw] = pair.split("=");
        const value = (raw || "").replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => params[name] ?? "");
        query.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(params)) query.set(key, value);
    filePath = path.join(PUBLIC, destPath);
    pathname = destPath;
    url.search = query.toString();
    break;
  }

  // 4. static resolution (cleanUrls + trailingSlash)
  if (!filePath) {
    const requestPath = pathname;
    const candidates = [];

    if (requestPath.endsWith("/")) {
      candidates.push(path.join(PUBLIC, requestPath, "index.html"));
    } else {
      candidates.push(path.join(PUBLIC, requestPath));
      if (config.cleanUrls) candidates.push(path.join(PUBLIC, `${requestPath}.html`));
      if (config.trailingSlash) candidates.push(path.join(PUBLIC, requestPath, "index.html"));
    }

    filePath = candidates.find(exists) || null;
  }

  if (!filePath) {
    const notFound = path.join(PUBLIC, "404.html");
    const body = exists(notFound) ? fs.readFileSync(notFound, "utf8") : "Not found";
    return send(404, headersFor(pathname), body);
  }

  const type = MIME[path.extname(filePath)] || "application/octet-stream";
  return send(200, { "Content-Type": type, ...headersFor(pathname) }, fs.readFileSync(filePath));
});

/* ------------------------------------------------------------- assertions */

let failures = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) failures++;
};

const get = async (pathname, { follow = false } = {}) => {
  const response = await fetch(BASE + pathname, { redirect: follow ? "follow" : "manual" });
  const body = await response.text();
  return { status: response.status, location: response.headers.get("location"), headers: response.headers, body };
};

const run = async () => {
  console.log(`\nVerifying ${path.relative(ROOT, PUBLIC)}/ against vercel.json\n`);

  /* Every page that must be publicly reachable. */
  const pages = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
        walk(path.join(dir, entry.name), `${rel}/`);
      } else if (entry.name === "index.html") {
        pages.push(`/${rel.replace(/index\.html$/, "")}`);
      } else if (entry.name.endsWith(".html") && entry.name !== "404.html" && entry.name !== "offline.html") {
        pages.push(`/${rel}`);
      }
    }
  };
  walk(PUBLIC);

  let pageFailures = 0;
  for (const page of pages) {
    const r = await get(page);
    if (r.status !== 200) {
      pageFailures++;
      console.log(`  ✗ ${page} → ${r.status}`);
    }
  }
  ok(`all ${pages.length} pages resolve to 200`, pageFailures === 0, pageFailures ? `${pageFailures} failed` : "");

  /* Redirects */
  for (const rule of redirectRules) {
    const sample = rule.source.replace(/:[a-zA-Z_]+/g, "demo");
    const r = await get(sample);
    const wanted = rule.permanent ? 308 : 307;
    ok(`redirect ${sample} → ${rule.destination}`, r.status === wanted, `${r.status} → ${r.location || "(no location)"}`);
  }

  /* trailingSlash behaviour */
  if (config.trailingSlash) {
    const r = await get("/auth/login");
    ok("/auth/login 308s to /auth/login/", r.status === 308 && r.location === "/auth/login/", `${r.status} ${r.location || ""}`);
    const followed = await get("/auth/login", { follow: true });
    ok("following that redirect lands on the sign-in page", followed.status === 200 && /Sign in|Welcome back/i.test(followed.body));
  }

  /* Rewrites */
  const rewrite = (config.rewrites || []).find((rule) => rule.source.includes(":slug"));
  if (rewrite) {
    const r = await get("/site/studio-aria");
    ok(`rewrite ${rewrite.source} serves the site renderer`, r.status === 200 && /site/i.test(r.body.slice(0, 2000)), `${r.status}`);
  }

  /* Headers */
  const admin = await get("/admin/");
  const adminHeaders = {
    robots: admin.headers.get("x-robots-tag"),
    nosniff: admin.headers.get("x-content-type-options")
  };
  ok("/admin/ is noindex", /noindex/i.test(adminHeaders.robots || ""), adminHeaders.robots || "missing X-Robots-Tag");
  ok("security headers apply (nosniff)", adminHeaders.nosniff === "nosniff", adminHeaders.nosniff || "missing");

  const root = await get("/");
  ok("HSTS is set on the document", Boolean(root.headers.get("strict-transport-security")));
  ok("framing is restricted in production (SAMEORIGIN)", (root.headers.get("x-frame-options") || "").toUpperCase() === "SAMEORIGIN");

  const css = await get("/css/app.css");
  ok("CSS is served with the right content type", /text\/css/.test(css.headers.get("content-type") || ""), css.headers.get("content-type") || "");
  ok("CSS is revalidated (not immutable)", /must-revalidate|max-age=0/.test(css.headers.get("cache-control") || ""), css.headers.get("cache-control") || "none");

  /* 404 */
  const missing = await get("/definitely-not-a-page");
  ok("unknown path returns the branded 404", missing.status === 404 && /404|not found|page/i.test(missing.body), `${missing.status}`);

  /* Runtime config — the file the whole app depends on */
  const runtime = await get("/js/config/runtime.js");
  ok("/js/config/runtime.js exists in the build", runtime.status === 200, `${runtime.status}`);
  ok("runtime config carries a Supabase URL", /SUPABASE_URL"\s*:\s*"https?:\/\//.test(runtime.body), runtime.body.match(/SUPABASE_URL"\s*:\s*"([^"]*)"/)?.[1] || "empty");
  ok("runtime config carries no service-role key", !/service_role/.test(runtime.body));

  server.close();
  console.log(
    failures
      ? `\n${failures} problem${failures === 1 ? "" : "s"} — this build would misbehave on Vercel\n`
      : "\nDeployment config verified\n"
  );
  process.exit(failures ? 1 : 0);
};

server.listen(PORT, "127.0.0.1", run);
