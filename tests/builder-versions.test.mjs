/* Version delete, the live-version guard, leaving a build behind, the profile
   photo row, and the Sand and Mint brand gradients keeping white text readable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("a saved version can be deleted, and the live version cannot", async () => {
  const core = await read("public/js/modules/dashboard/builder-core.js");
  assert.match(core, /data-delete-version=/, "each version has a delete button");
  assert.match(core, /published_version_id === version\.id/, "the live version is disabled and refused");
  assert.match(core, /\.from\("project_versions"\)\s*\.delete\(\)/, "the delete is a real row delete");
  assert.match(core, /\.select\("id"\)/, "a delete that removed nothing is reported");
});

test("the database refuses to delete the live version and keeps version_count true", async () => {
  const sql = await read("supabase/migrations/0084_project_version_delete.sql");
  assert.match(sql, /before delete on public\.project_versions/, "a before-delete guard exists");
  assert.match(sql, /p\.published_version_id = old\.id/, "the guard checks the live pointer");
  assert.match(sql, /after delete on public\.project_versions/, "the count is recounted on delete");
  assert.match(sql, /revoke all on function public\.sz_guard_version_delete\(\) from public, anon, authenticated/);
});

test("a build keeps going after the person leaves, without painting the page they left", async () => {
  const core = await read("public/js/modules/dashboard/builder-core.js");
  assert.match(core, /data-builder-mount="\$\{mountId\}"/, "each builder marks its own page");
  assert.match(core, /const isWatching = \(\) =>/, "the builder can tell whether it is still on screen");
  assert.match(core, /if \(watching\) applyBuildProgress\(job, \{ quiet \}\);/, "no page work once the page is gone");
  assert.match(core, /watching \? 2200 : 12000/, "the slower check applies when the page is gone");
  assert.match(core, /code: "left_view"/, "leaving is not reported as a failure");
  assert.match(core, /if \(error\?\.code === "left_view"\) return;/, "callers return quietly");
});

test("the profile photo is top-aligned with its label", async () => {
  const settings = await read("public/js/modules/dashboard/views/settings.js");
  assert.match(settings, /<div class="row gap-4 wrap" style="align-items:flex-start">\s*<span id="avatar-slot">/);
});

test("white button text stays readable on the Sand and Mint brand gradients", async () => {
  const presets = await read("public/js/config/theme-presets.js");
  const grad = (id) => presets.slice(presets.indexOf(`id: "${id}"`)).match(/"grad-brand": "linear-gradient\([^"]*\)"/)[0];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  for (const id of ["sand", "mint"]) {
    const stops = [...grad(id).matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
    assert.ok(stops.length >= 3, `${id} has its stops`);
    for (const stop of stops) {
      const ratio = 1.05 / (luminance(stop) + 0.05);
      assert.ok(ratio >= 4.5, `${id} stop ${stop} gives white text ${ratio.toFixed(2)}:1`);
    }
  }
});
