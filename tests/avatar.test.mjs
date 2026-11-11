/* ==========================================================================
   Profile photos — uploaded once, shown everywhere
   --------------------------------------------------------------------------
   Two complaints, one cause:

     "can't able to set pfp"          — the photo did upload and the URL was
                                        saved, but every list still painted two
                                        initials, so it looked like nothing
                                        happened
     "business pfp"                   — the logo upload created a business row
                                        it never named, and `businesses.name`
                                        is NOT NULL, so the raw Postgres
                                        sentence appeared in the card

   These tests hold the shared renderer, the surfaces that now use it, and the
   guard that stops the constraint message from reaching a customer again.

     node tests/avatar.test.mjs
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

const AVATAR = await import(pathToFileURL(path.join(repo, "public/js/lib/avatar.js")).href);
const { avatarMarkup, usableAvatar } = AVATAR;

const PHOTO = "https://example.supabase.co/storage/v1/object/public/avatars/u/avatar-1.jpg";

/* ------------------------------------------------------------- renderer */

test("a photo replaces the initials", () => {
  const html = avatarMarkup({ name: "Aditya Sharma", avatarUrl: PHOTO });
  assert.match(html, /<img /, "the photo was not rendered");
  assert.match(html, new RegExp(`src="${PHOTO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  /* The initials must not survive behind the image, or the avatar reads "AS" to
     a screen reader and in the alt text of a broken image. */
  assert.doesNotMatch(html, />AS</);
});

test("with no photo the initials are still there", () => {
  const html = avatarMarkup({ name: "Aditya Sharma" });
  assert.match(html, />AS</, "the fallback initials disappeared");
  assert.doesNotMatch(html, /<img /);
});

test("a missing name falls back to the email", () => {
  assert.match(avatarMarkup({ email: "mext.aditya@gmail.com" }), />ME</);
});

test("the size class is added the way the stylesheet expects", () => {
  assert.match(avatarMarkup({ name: "A B", size: "sm" }), /class="avatar avatar-sm"/);
  assert.match(avatarMarkup({ name: "A B", size: "avatar-xl" }), /class="avatar avatar-xl"/);
  assert.match(avatarMarkup({ name: "A B" }), /class="avatar"/);
});

test("an unsafe URL is ignored, not put in a src", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "  ", null, undefined, 42]) {
    assert.equal(usableAvatar(bad), false, `accepted ${String(bad)}`);
    assert.doesNotMatch(avatarMarkup({ name: "A B", avatarUrl: bad }), /<img /, `rendered ${String(bad)}`);
  }
  assert.equal(usableAvatar(PHOTO), true);
  assert.equal(usableAvatar("/storage/avatar.png"), true, "a same-origin path should be usable");
});

test("the URL is escaped into the attribute", () => {
  const html = avatarMarkup({ name: "A B", avatarUrl: 'https://x.test/a.png" onerror="alert(1)' });
  assert.doesNotMatch(html, /onerror="alert\(1\)"/, "an attribute was escaped out of");
});

/* -------------------------------------------------------------- surfaces */

/* Where a person appears, a photo must be what is drawn. Each of these used to
   call `initials(...)` directly. */
const SURFACES = [
  ["public/js/modules/admin/views/customers.js", "the admin customer list"],
  ["public/js/modules/admin/views/freelancers.js", "the admin freelancer list"],
  ["public/js/modules/admin/views/payments.js", "the admin payments list"],
  ["public/js/modules/admin/views/operations.js", "service requests and tickets"],
  ["public/js/modules/admin/views/overview.js", "the admin overview"],
  ["public/js/modules/admin/views/access.js", "users and access"],
  ["public/js/modules/dashboard/shell.js", "the dashboard topbar"],
  ["public/js/modules/dashboard/views/settings.js", "the settings profile card"],
  ["public/js/modules/dashboard/views/team.js", "the team screen"]
];

for (const [file, label] of SURFACES) {
  test(`${label} draws the photo when there is one`, () => {
    const source = read(file);
    assert.match(source, /avatarMarkup\(|avatar\(/, `${file} renders no avatar through the shared helper`);
    /* Hand-rolled initials are exactly the bug: they cannot show a photo. */
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      body,
      /class="avatar[^"]*"\$\{esc\(initials\(/,
      `${file} still paints initials directly instead of the uploaded photo`
    );
  });
}

test("components.avatar takes a photo URL", () => {
  const source = read("public/js/modules/dashboard/components.js");
  assert.match(source, /export function avatar\(name, email, size = "", avatarUrl = null\)/);
  assert.match(source, /avatarMarkup\(\{ name, email, avatarUrl, size \}\)/);
});

test("the shared renderer is one module, not a copy per screen", () => {
  const lib = read("public/js/lib/avatar.js");
  assert.match(lib, /export function avatarMarkup/);
  /* No screen may re-implement the img-or-initials decision. */
  const files = ["public/js/modules/admin/views/customers.js", "public/js/modules/dashboard/shell.js"];
  for (const file of files) {
    assert.match(read(file), /from "\S*lib\/avatar\.js"/, `${file} imports its own copy`);
  }
});

/* ---------------------------------------------------------------- storage */

test("the admin console is told which column holds the photo", () => {
  /* peopleMeta enriches admin rows; without avatar_url the lists cannot show it. */
  assert.match(read("public/js/modules/admin/api.js"), /select\("id, username, account_type, last_seen_at, avatar_url"\)/);
  const fn = read("supabase/functions/admin/index.ts");
  assert.match(fn, /avatar_url/, "the admin function never selects the photo");
  assert.match(fn, /avatar_url: profile\.avatar_url \?\? null/, "the customers response drops the photo");
});

test("the upload writes the URL that every screen reads", () => {
  const settings = read("public/js/modules/dashboard/views/settings.js");
  assert.match(settings, /storage\.from\("avatars"\)\.upload\(path, file/);
  assert.match(settings, /updateProfile\(\{ avatar_url: data\.publicUrl \}\)/);
  assert.match(settings, /updateProfile\(\{ avatar_url: null \}\)/, "there is no way to remove a photo");
});

/* --------------------------------------------------------- business logo */

test("a logo upload can no longer produce a raw constraint error", () => {
  const data = read("public/js/modules/dashboard/data.js");
  const fn = data.slice(data.indexOf("export async function updateBusiness"), data.indexOf("/* ------------------------------------------------------------------ reads */"));
  /* The name is required before the insert, and the message tells the user what
     to do rather than quoting Postgres. */
  assert.match(fn, /business_name_required/);
  assert.match(fn, /insert\(\{ owner_id: uid\(\), \.\.\.patch, name \}\)/);
  assert.doesNotMatch(fn, /insert\(\{ owner_id: uid\(\), \.\.\.patch \}\)/, "the name-less insert is back");
});

test("the logo card uses the name already typed on the page", () => {
  const settings = read("public/js/modules/dashboard/views/settings.js");
  assert.match(settings, /qs\("#biz-name"\)\?\.value\?\.trim\(\)/, "uploading a logo first is still a dead end");
  assert.match(settings, /if \(typed\) patch\.name = typed;/);
});
