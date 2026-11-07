#!/usr/bin/env node
/* ==========================================================================
   Shinzora — build a single self-contained HTML file of the public site
   --------------------------------------------------------------------------
   Produces ONE .html file with no external requests at all: every stylesheet,
   font, image and script is embedded in it. It renders the same landing page
   whether it is opened by double-clicking it, served from a folder, or dropped
   on any static host.

       node scripts/build-standalone.mjs
       node scripts/build-standalone.mjs --out ../shinzora.html

   What it does
     1. inlines the five stylesheets, with the two woff2 fonts as data URIs
     2. bundles js/boot/site-auth.js + js/boot/landing.js with esbuild into one
        inline module, so the 78-file module graph becomes one block of script
     3. inlines js/config/runtime.js and the Supabase vendor bundle
     4. turns every /assets/… image reference into a data URI
     5. drops the manifest and service-worker wiring, which need a real origin
     6. refuses to write the file if any external reference survives

   What it cannot do
     The dashboard (/app/), the admin area, auth screens and onboarding are
     separate documents with their own bootstraps and their own routing. Folding
     them into one file would mean rewriting their routing, which is not a
     packaging job. This file is the public site: landing page, its sections and
     the signed-in header state.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const OUT = outFlag === -1 ? path.join(ROOT, "..", "shinzora.html") : path.resolve(args[outFlag + 1]);

const read = (relative) => fs.readFileSync(path.join(PUBLIC, relative), "utf8");
const buffer = (relative) => fs.readFileSync(path.join(PUBLIC, relative));

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};

function dataUri(relative) {
  const ext = path.extname(relative).toLowerCase();
  return `data:${MIME[ext] || "application/octet-stream"};base64,${buffer(relative).toString("base64")}`;
}

/* --------------------------------------------------------------- stylesheets */

const SHEETS = [
  "css/tokens.css",
  "css/components.css",
  "css/marketing.css",
  "css/marketing-sections.css",
  "css/fx.css"
];

function inlineCss(relative) {
  let css = read(relative);
  /* ../assets/fonts/x.woff2 → data URI */
  css = css.replace(/url\((["']?)\.\.\/(assets\/[^"')]+)\1\)/g, (_match, _quote, assetPath) => {
    const file = assetPath.split("?")[0];
    return fs.existsSync(path.join(PUBLIC, file)) ? `url("${dataUri(file)}")` : `url("../${assetPath}")`;
  });
  return `/* ${relative} */\n${css}`;
}

/* ------------------------------------------------------------------ scripts */

async function bundleScripts() {
  const entry = path.join(os.tmpdir(), `shinzora-standalone-entry-${process.pid}.mjs`);
  fs.writeFileSync(
    entry,
    `import ${JSON.stringify(path.join(PUBLIC, "js/boot/site-auth.js"))};\n` +
      `import ${JSON.stringify(path.join(PUBLIC, "js/boot/landing.js"))};\n`
  );
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      target: ["es2020"],
      minify: true,
      legalComments: "none",
      absWorkingDir: PUBLIC
    });
    return result.outputFiles[0].text;
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

/* --------------------------------------------------------------------- html */

async function main() {
  let html = read("index.html");

  /* 1 — stylesheets → one <style> */
  const styleBlock = `<style>\n${SHEETS.map(inlineCss).join("\n")}\n</style>`;
  const linkPattern = new RegExp(
    `\\s*<link[^>]*rel="stylesheet"[^>]*>`,
    "g"
  );
  html = html.replace(linkPattern, "");
  html = html.replace("</head>", `${styleBlock}\n</head>`);

  /* 2 — manifest + icons that need real files */
  html = html.replace(/\s*<link[^>]*rel="manifest"[^>]*>/g, "");
  html = html.replace(/(\s*<link[^>]*rel="(?:apple-touch-icon|icon|shortcut icon)"[^>]*>)/g, (match) => {
    const href = match.match(/href="([^"]+)"/);
    if (!href) return "";
    const file = href[1].split("?")[0].replace(/^\//, "");
    if (!fs.existsSync(path.join(PUBLIC, file))) return "";
    return match.replace(href[1], dataUri(file));
  });

  /* 3 — classic scripts inline */
  html = html.replace(
    /<script src="\/js\/config\/runtime\.js"><\/script>/,
    `<script>\n${read("js/config/runtime.js")}\n</script>`
  );
  html = html.replace(
    /<script src="\/js\/vendor\/supabase-js\.js"><\/script>/,
    `<script>\n${read("js/vendor/supabase-js.js")}\n</script>`
  );

  /* 4 — module scripts → one inline module (and a no-module fallback note) */
  const bundle = await bundleScripts();
  html = html.replace(/<script type="module" src="\/js\/boot\/site-auth\.js\?[^"]*"><\/script>/, "");
  html = html.replace(/<script type="module" src="\/js\/boot\/landing\.js\?[^"]*"><\/script>/, "");
  html = html.replace("</body>", `<script type="module">\n${bundle}\n</script>\n</body>`);

  /* 5a — <source srcset="/assets/…"> → data URI */
  html = html.replace(/srcset="(\/assets\/[^"?]+)/g, (match, src) => {
    const file = src.replace(/^\//, "");
    return fs.existsSync(path.join(PUBLIC, file)) ? `srcset="${dataUri(file)}` : match;
  });

  /* 5 — images → data URIs */
  html = html.replace(/<img([^>]*?)src="(\/assets\/[^"?]+)/g, (match, before, src) => {
    const file = src.replace(/^\//, "");
    return fs.existsSync(path.join(PUBLIC, file)) ? `<img${before}src="${dataUri(file)}` : match;
  });

  /* 6 — any remaining absolute asset reference is a defect, not a leftover */
  const leftovers = [];
  for (const match of html.matchAll(/(?:src|href|poster|srcset)="(\/(?:css|js|assets)\/[^"]+)"/g)) leftovers.push(match[1]);
  for (const match of html.matchAll(/url\((["']?)(\/assets\/[^"')]+)\1\)/g)) leftovers.push(match[2]);
  if (leftovers.length) {
    console.error(`\n  ✗ ${leftovers.length} external reference(s) survived:`);
    for (const item of [...new Set(leftovers)].slice(0, 20)) console.error(`      ${item}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT, html);

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\n  ✓ ${path.relative(process.cwd(), OUT)}`);
  console.log(`    ${kb} KB, self-contained`);
  console.log(`    stylesheets embedded : ${SHEETS.length}`);
  console.log(`    module bundle        : ${(bundle.length / 1024).toFixed(0)} KB`);
  console.log(`    external references  : 0`);
  console.log("");
}

main().catch((error) => {
  console.error("\n  build failed:", error.message);
  process.exitCode = 1;
});
