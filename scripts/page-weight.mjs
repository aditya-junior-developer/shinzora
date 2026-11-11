#!/usr/bin/env node
/* ==========================================================================
   Shinzora — page weight
   --------------------------------------------------------------------------
   "Taking so much time to load" is measurable, so this measures it: for the
   dashboard, the admin console and the public landing page it walks what the
   browser is actually told to fetch (stylesheets, the boot module and everything
   it statically imports, the vendor client, the fonts and the logo) and reports
   the bytes — raw and gzipped.

   Two things it caught, and now guards:
     • /assets/icons/mark.svg was a 351 KB SVG wrapper around a 512px PNG, drawn
       at 26px in the sidebar of every page. It is now a 3 KB PNG.
     • the 216 KB Supabase client was parsed before anything painted, because it
       had no `defer`.

     node scripts/page-weight.mjs            # report
     node scripts/page-weight.mjs --check    # exit 1 if a budget is blown
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const check = process.argv.includes("--check");

/* Raw bytes on disk and bytes over the wire (text compresses; images do not). */
function weigh(file) {
  const bytes = fs.readFileSync(file);
  const raw = bytes.length;
  const texty = /\.(css|js|mjs|html|json|svg|webmanifest)$/i.test(file);
  const gz = texty ? zlib.gzipSync(bytes, { level: 9 }).length : raw;
  return { raw, gz };
}

const exists = (file) => fs.existsSync(file);
const resolve = (urlPath) => path.join(PUBLIC, urlPath.split("?")[0].replace(/^\//, ""));

/** Everything the boot module pulls in statically, module by module. */
function staticModules(entry, seen = new Set()) {
  const file = resolve(entry);
  if (seen.has(entry) || !exists(file)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(file, "utf8");
  /* Static imports only: a dynamic `import()` is a view the reader may never
     open, and counting it would blame the first paint for the whole app. */
  const specifiers = [
    ...source.matchAll(/(?:^|\s)(?:import|export)\s+(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g)
  ].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
    staticModules(next, seen);
  }
  return seen;
}

/** The assets a page names in its own markup (stylesheets, scripts, images). */
function pageAssets(htmlPath) {
  const html = fs.readFileSync(path.join(PUBLIC, htmlPath), "utf8");
  const urls = new Set();
  for (const match of html.matchAll(/<(?:link|script|img)\b[^>]*?(?:href|src)="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    urls.add(url);
  }
  return urls;
}

const PAGES = [
  {
    name: "dashboard",
    html: "app/index.html",
    boot: "/js/boot/dashboard.js",
    vendor: "/js/vendor/supabase-js.js",
    /* Gzipped budget: what a first visit actually pays for. Measured at 258 KB
       after the logo and the deferred client were dealt with. */
    budget: 320 * 1024
  },
  {
    name: "admin console",
    html: "admin/index.html",
    boot: "/js/boot/admin.js",
    vendor: "/js/vendor/supabase-js.js",
    budget: 320 * 1024
  },
  {
    name: "landing page",
    html: "index.html",
    boot: null,
    vendor: null,
    budget: 520 * 1024
  }
];

let failures = 0;

for (const page of PAGES) {
  const assets = new Set(pageAssets(page.html));
  if (page.boot) for (const module of staticModules(page.boot)) assets.add(module);
  if (page.vendor) assets.add(page.vendor);

  let raw = 0;
  let gz = 0;
  const heaviest = [];
  const counted = new Set();
  for (const url of assets) {
    const file = resolve(url);
    if (!exists(file)) continue;
    /* `icons.js` and `icons.js?v=…` are one file, not two. */
    if (counted.has(file)) continue;
    counted.add(file);
    const size = weigh(file);
    raw += size.raw;
    gz += size.gz;
    heaviest.push({ url, ...size });
  }
  const html = weigh(path.join(PUBLIC, page.html));
  raw += html.raw;
  gz += html.gz;

  heaviest.sort((a, b) => b.raw - a.raw);
  const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
  console.log(`\n${page.name} — ${assets.size + 1} files, ${kb(raw)} raw, ${kb(gz)} over the wire`);
  for (const item of heaviest.slice(0, 6)) {
    console.log(`   ${kb(item.raw).padStart(9)}  ${kb(item.gz).padStart(8)} gz  ${item.url}`);
  }

  /* One giant file is the smell that started this: 351 KB of logo, 216 KB of
     client parsed before paint. Nothing here should be that big on its own. */
  const oversized = heaviest.filter((item) => item.raw > 260 * 1024);
  if (oversized.length) {
    failures += 1;
    console.log(`   ✗ over 260 KB in a single file: ${oversized.map((item) => item.url).join(", ")}`);
  }
  if (gz > page.budget) {
    failures += 1;
    console.log(`   ✗ ${kb(gz)} over the wire exceeds the ${kb(page.budget)} budget`);
  } else {
    console.log(`   ✓ within the ${kb(page.budget)} budget`);
  }
}

console.log("");
if (check && failures) {
  console.log(`${failures} budget failure(s).`);
  process.exit(1);
}
console.log("Page weight reported.");
