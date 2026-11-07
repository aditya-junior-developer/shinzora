#!/usr/bin/env node
/* ==========================================================================
   Shinzora — build the WHOLE site into one HTML file
   --------------------------------------------------------------------------
   Produces one file containing every page: landing, auth, dashboard, admin,
   onboarding, docs, legal, download, install, site, system-check — with all
   CSS, fonts and images embedded and every module bundled. Navigation is a
   hash router (#/app/, #/auth/login/), because one file can only own one URL.

   The database is not copied into the file — it cannot be. The file carries
   the Supabase client and the anon key, so it talks to the same live database
   the deployed site talks to. Data lives in Supabase, always.

       node scripts/build-single-file-app.mjs
       node scripts/build-single-file-app.mjs --out ../shinzora-full.html
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex === -1 ? path.join(ROOT, "..", "shinzora-full.html") : path.resolve(args[outIndex + 1]);

const readText = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };

function dataUri(rel) {
  const file = path.join(PUBLIC, rel);
  const ext = path.extname(rel).toLowerCase();
  return `data:${MIME[ext] || "application/octet-stream"};base64,${fs.readFileSync(file).toString("base64")}`;
}

/* replace every /assets/… reference in a chunk of html or css with a data URI */
function inlineAssets(text) {
  let out = text.replace(/(["'(\s])(\/assets\/[^"')\s]+)(?=["')\s])/g, (match, lead, asset) => {
    const file = asset.split("?")[0].replace(/^\//, "");
    if (!fs.existsSync(path.join(PUBLIC, file))) return match;
    return `${lead}${dataUri(file)}`;
  });
  out = out.replace(/url\((["']?)\.\.\/(assets\/[^"')]+)\1\)/g, (match, _q, asset) => {
    const file = asset.split("?")[0];
    return fs.existsSync(path.join(PUBLIC, file)) ? `url("${dataUri(file)}")` : match;
  });
  return out;
}

/* ------------------------------------------------------------------- pages */

function discoverPages() {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "404.html") pages.push(full);
      else if (entry.name === "index.html") pages.push(full);
    }
  };
  walk(PUBLIC);
  return pages.map((file) => {
    const rel = path.relative(PUBLIC, file).split(path.sep).join("/");
    let route;
    if (rel === "index.html") route = "/";
    else if (rel === "404.html") route = "/404.html";
    else route = `/${rel.replace(/index\.html$/, "")}`;
    const html = fs.readFileSync(file, "utf8");
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, "Shinzora"])[1].trim();
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/);
    let body = bodyMatch ? bodyMatch[1] : html;

    const entries = [...body.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1].replace(/^\//, "").split("?")[0]);
    body = body.replace(/\s*<script[^>]*src="[^"]*"[^>]*>\s*<\/script>/g, "");
    body = body.replace(/\s*<script[^>]*type="module"[^>]*>\s*<\/script>/g, "");
    return { route, title, body: body.trim(), entries, rel };
  }).sort((a, b) => a.route.localeCompare(b.route));
}

/* ----------------------------------------------------------------- scripts */

/* Navigations written as location.replace("/app/") would leave the file and
   404. Rewrite the literal forms to hash routes; the runtime below also patches
   the Location methods, so a dynamic URL still stays inside the file. */
const hashRoutingPlugin = {
  name: "hash-routing",
  setup(build) {
    build.onLoad({ filter: /public[\\/]js[\\/].*\.js$/ }, (args2) => {
      let source = fs.readFileSync(args2.path, "utf8");
      const before = source;
      source = source
        .replace(/\b(?:window\.|document\.)?location\s*\.\s*(replace|assign)\s*\(/g, "__sfLoc.$1(")
        .replace(/\b(?:window\.|document\.)?location\s*\.\s*href\s*=(?!=)/g, "__sfLoc.href =")
        .replace(/\bwindow\s*\.\s*location\s*=(?!=)/g, "__sfLoc.href =");
      if (source === before) return null;
      return { contents: source, loader: "js" };
    });
  }
};

async function bundleEntries(entries) {
  if (!entries.length) return "";
  const importLines = entries
    .map((entry) => `import ${JSON.stringify(path.join(PUBLIC, entry))};`)
    .join("\n");
  const temp = path.join(os.tmpdir(), `shinzora-page-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(temp, importLines);
  try {
    const result = await build({
      entryPoints: [temp],
      bundle: true,
      write: false,
      format: "esm",
      target: ["es2020"],
      minify: true,
      legalComments: "none",
      absWorkingDir: PUBLIC,
      plugins: [hashRoutingPlugin],
      banner: {
        js: [
          'const __sfNav = (u) => {',
          '  const s = String(u);',
          '  if (s.charAt(0) === "/") { location.hash = "#" + s; return; }',
          '  if (/^https?:/i.test(s)) { window.open(s, "_blank", "noopener"); return; }',
          '  location.hash = s;',
          '};',
          'const __sfLoc = {',
          '  get href() { return location.href; },',
          '  set href(v) { __sfNav(v); },',
          '  get search() { return location.search; },',
          '  get hash() { return location.hash; },',
          '  set hash(v) { location.hash = v; },',
          '  get pathname() { return location.pathname; },',
          '  get origin() { return location.origin; },',
          '  assign: __sfNav, replace: __sfNav,',
          '  reload() { location.reload(); },',
          '  toString() { return location.href; }',
          '};'
        ].join("\n")
      }
    });
    return result.outputFiles[0].text;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const pages = discoverPages();
  const routes = new Set(pages.map((page) => page.route));
  const alias = { "/home": "/", "/dashboard": "/app/", "/login": "/auth/login/", "/signup": "/auth/signup/", "/pricing": "/" };

  const css = ["css/tokens.css", "css/components.css", "css/fx.css", "css/marketing.css", "css/marketing-sections.css", "css/auth.css", "css/app.css", "css/views.css", "css/admin.css", "css/onboarding.css", "css/legal.css", "css/guide.css"]
    .filter((file) => fs.existsSync(path.join(PUBLIC, file)))
    .map((file) => `/* ${file} */\n${inlineAssets(readText(file))}`)
    .join("\n");

  const markup = {};
  const scripts = {};
  const titles = {};

  for (const page of pages) {
    let body = page.body;
    /* absolute links to known pages become hash routes */
    body = body.replace(/href="(\/[^"#?]*)"/g, (match, href) => {
      const clean = href.endsWith("/") ? href : `${href}/`;
      if (routes.has(clean) || routes.has(href)) return `href="#${routes.has(href) ? href : clean}"`;
      if (alias[href.replace(/\/$/, "")]) return `href="#${alias[href.replace(/\/$/, "")]}"`;
      return match;
    });
    body = body.replace(/href="(\/[^"]*\?[^"]*)"/g, (match, href) => {
      const [pathPart, query] = href.split("?");
      const clean = pathPart.endsWith("/") ? pathPart : `${pathPart}/`;
      return routes.has(clean) ? `href="#${clean}?${query}"` : match;
    });
    markup[page.route] = inlineAssets(body);
    titles[page.route] = page.title;
    scripts[page.route] = await bundleEntries(page.entries);
  }

  const runtime = readText("js/config/runtime.js");
  const vendor = readText("js/vendor/supabase-js.js");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${titles["/"]}</title>
<meta name="description" content="Shinzora is an AI business operating platform. Describe what you are building and it generates a working website, storefront or web application, then runs the operations behind it." />
<style>
${css}
</style>
<style>
/* single-file router chrome */
#sf-root { display: contents; }
html { scroll-behavior: smooth; }
</style>
</head>
<body>
<div id="sf-root"></div>
<script>
${runtime}
</script>
<script>
${vendor}
</script>
<script>
const SF_PAGES = ${JSON.stringify(markup)};
const SF_TITLES = ${JSON.stringify(titles)};
const SF_SCRIPTS = ${JSON.stringify(scripts)};
const SF_ROUTES = ${JSON.stringify([...routes])};
</script>
<script>
(function () {
  /* Anything that navigates with a site-absolute path is turned into a route
     change instead of leaving the file. */
  try {
    var patch = function (name) {
      var original = Location.prototype[name];
      if (typeof original !== "function") return;
      Location.prototype[name] = function (url) {
        var s = String(url);
        if (s.charAt(0) === "/") { location.hash = "#" + s; return undefined; }
        return original.call(this, url);
      };
    };
    patch("assign");
    patch("replace");
  } catch (error) {
    console.warn("[single-file] navigation patch unavailable", error);
  }

  var mounted = null;
  var blobs = new Map();

  function parse() {
    var raw = location.hash.replace(/^#/, "");
    if (!raw || raw.indexOf("/") !== 0) return { route: \"/\", query: \"\" };
    var parts = raw.split(\"?\");
    var route = parts[0];
    if (!route.endsWith(\"/\")) route += \"/\";
    return { route: route, query: parts[1] || \"\" };
  }

  function normalize(route) {
    if (SF_PAGES[route]) return route;
    if (route === \"/404.html\") return \"/404.html\";
    return null;
  }

  async function mount() {
    var parsed = parse();
    var route = normalize(parsed.route) || \"/\";
    if (mounted === route + \"?\" + parsed.query) return;
    mounted = route + \"?\" + parsed.query;

    document.title = SF_TITLES[route] || \"Shinzora\";
    var root = document.getElementById(\"sf-root\");
    root.innerHTML = SF_PAGES[route] || \"\";

    /* pages carry their own heading ids; keep in-page anchors working */
    if (location.hash.indexOf(\"#/\") !== 0) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }

    var code = SF_SCRIPTS[route];
    if (!code) return;
    try {
      var url = URL.createObjectURL(new Blob([code], { type: \"text/javascript\" }));
      await import(url);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(\"[single-file] page script failed for\", route, error);
    }
  }

  window.addEventListener(\"hashchange\", mount);
  document.addEventListener(\"click\", function (event) {
    var link = event.target.closest && event.target.closest(\"a[href^='#/']\");
    if (link) event.preventDefault(), (location.hash = link.getAttribute(\"href\").slice(1)), mount();
  });
  if (!location.hash || location.hash.indexOf(\"#/\") !== 0) {
    if (!location.hash) history.replaceState(null, \"\", \"#/\");
  }
  mount();
  window.__SF_ROUTES__ = SF_ROUTES;
})();
</script>
</body>
</html>
`;

  fs.writeFileSync(OUT, html);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\n  ✓ ${path.relative(process.cwd(), OUT)}  ${kb} KB`);
  console.log(`  pages embedded: ${pages.length}`);
  for (const page of pages) {
    console.log(`    ${page.route.padEnd(28)} ${page.entries.length} script(s)  ${(scripts[page.route].length / 1024).toFixed(0)} KB`);
  }
  console.log("");
}

main().catch((error) => {
  console.error("\n  build failed:", error.message);
  process.exitCode = 1;
});
