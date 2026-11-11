/* ==========================================================================
   The page nobody should have to wait for
   --------------------------------------------------------------------------
   Reported: "taking so much time to load", "website is very slow man optimize
   that". Two real causes were found and are measured by scripts/page-weight.mjs:

     • /assets/icons/mark.svg — a 351 KB SVG wrapping a 512px PNG, drawn at 26px
       in the sidebar of every page. Now a 3 KB mark-96.png.
     • the 216 KB Supabase client parsed before anything painted, because the
       script tag had no `defer`.

   This test runs that script in check mode, so a new 300 KB asset or a
   re-blocked client fails the suite instead of the user's connection.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

test("the dashboard and admin console stay inside their page-weight budget", () => {
  const result = spawnSync(process.execPath, ["scripts/page-weight.mjs", "--check"], {
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /dashboard .*over the wire/);
});

test("the page logo is sized for where it is drawn", async () => {
  /* 26px in the sidebar, 16–34px everywhere else. Nothing needs a 512px raster,
     and nothing should ever download the 351 KB SVG wrapper again. */
  for (const page of ["public/app/index.html", "public/index.html", "public/auth/login/index.html"]) {
    const html = await readFile(path.join(repo, page), "utf8");
    assert.equal(html.includes("/assets/icons/mark.svg"), false, `${page} still references the 351 KB SVG`);
    const marks = [...html.matchAll(/src="(\/assets\/icons\/mark[^"]*)"/g)].map((match) => match[1]);
    for (const mark of marks) {
      assert.match(mark, /mark-(64|96|192)\.png/, `${page} uses a small mark: ${mark}`);
    }
  }
});

test("the Supabase client never blocks the first paint", async () => {
  const pages = [
    "public/app/index.html",
    "public/admin/index.html",
    "public/auth/login/index.html",
    "public/index.html"
  ];
  for (const page of pages) {
    const html = await readFile(path.join(repo, page), "utf8");
    const tag = html.match(/<script src="\/js\/vendor\/supabase-js\.js"[^>]*>/);
    assert.ok(tag, `${page} loads the client`);
    assert.match(tag[0], /\bdefer\b/, `${page} defers the client`);
  }
});

test("the dashboard warms the API host and preloads the modules it needs", async () => {
  const html = await readFile(path.join(repo, "public/app/index.html"), "utf8");
  assert.match(html, /rel="preconnect" href="https:\/\/zmkgfmlcpzjfgxdmbtvi\.supabase\.co" crossorigin/);
  assert.match(html, /rel="modulepreload" href="\/js\/boot\/dashboard\.js/);
  assert.match(html, /rel="preload" as="font" type="font\/woff2" href="\/assets\/fonts\/inter-latin\.woff2"/);
});
