/* ==========================================================================
   Navigation drawer — the surfaces
   --------------------------------------------------------------------------
   The 3-line menu button is meant to work everywhere: the dashboard, the admin
   console and the marketing site, at phone width and at 4K. Three separate
   implementations had drifted apart (one only drew below 1024px, one had no
   scrim, one had no close button), and they are now one controller plus a
   stylesheet each.

   These tests pin the parts a stylesheet refactor can quietly undo: the button
   is never hidden, the scrim exists, and the shell modules use the shared
   controller instead of a private copy of the logic.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

/** Every rule body in a stylesheet, with the at-rule context left out on purpose:
 *  a declaration either exists somewhere or it does not. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) out.push({ selector: match[1].trim(), body: match[2] });
  return out;
}

const declares = (css, selector, declaration) =>
  rules(css).some(
    (rule) =>
      rule.selector.split(",").some((part) => part.trim() === selector) &&
      declaration.test(rule.body)
  );

/* ------------------------------------------------------------------ shared */

test("all three surfaces share one drawer controller", () => {
  const drawer = read("public/js/ui/drawer.js");
  assert.match(drawer, /export function createDrawer/);

  for (const file of [
    "public/js/modules/dashboard/shell.js",
    "public/js/modules/admin/shell.js",
    "public/js/ui/reveal.js"
  ]) {
    const source = read(file);
    assert.match(source, /import \{ createDrawer \} from "[./]*\/?.*drawer\.js"/, `${file} does not import the shared drawer`);
    assert.match(source, /createDrawer\(\{/, `${file} does not create a drawer`);
    /* No surface keeps a private copy of the open/close bookkeeping. */
    assert.doesNotMatch(
      source,
      /classList\.toggle\("is-open"\)/,
      `${file} still hand-rolls the drawer toggle`
    );
  }
});

test("the controller is modal, and every surface gets the same exits", () => {
  const drawer = read("public/js/ui/drawer.js");
  assert.match(drawer, /bodyClass\s*=\s*"drawer-open"/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /scrim\.addEventListener\("click"/);
  assert.match(drawer, /\[data-drawer-close\]/);
  /* Closed on navigation, so the next screen is not behind an overlay. */
  assert.match(drawer, /\[data-drawer-navigate\]/);
});

/* ------------------------------------------------------------------- admin */

test("admin: the drawer button is offered at every width", () => {
  const css = read("public/css/admin.css");
  assert.equal(
    declares(css, ".admin-menu-toggle", /display:\s*none/),
    false,
    "the admin menu button is hidden again"
  );
  assert.match(css, /\.admin-menu-toggle\s*\{[^}]*display:\s*inline-flex/);
});

test("admin: the sidebar is off canvas until it is opened", () => {
  const css = read("public/css/admin.css");
  assert.match(css, /\.admin-sidebar\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /\.admin-sidebar\s*\{[^}]*transform:\s*translateX\(-102%\)/);
  assert.match(css, /\.admin-sidebar\.is-open\s*\{[^}]*transform:\s*none/);
  /* No width-based exception puts it back in the grid. */
  assert.doesNotMatch(css, /grid-template-columns:\s*248px/);
  assert.match(css, /\.admin-shell\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test("admin: there is a scrim to click and no page scroll behind it", () => {
  const html = read("public/admin/index.html");
  assert.match(html, /id="admin-scrim"/);
  assert.match(html, /id="admin-sidebar"/);
  const css = read("public/css/admin.css");
  assert.match(css, /\.admin-scrim\.is-visible\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /body\.drawer-open\s*\{[^}]*overflow:\s*hidden/);
  /* The panel needs its own way out for anyone who cannot hit a 30px target. */
  assert.match(html, /class="admin-drawer-close"[^>]*data-drawer-close/);
});

test("admin: navigating closes the drawer", () => {
  const shell = read("public/js/modules/admin/shell.js");
  const navigate = shell.slice(shell.indexOf("export function navigate"), shell.indexOf("export function navigate") + 400);
  assert.match(navigate, /adminDrawer\?\.close\(\)/);
  assert.doesNotMatch(navigate, /max-width: 1024px/);
});

/* --------------------------------------------------------------- marketing */

test("marketing: the menu button is in the bar at every width", () => {
  const css = read("public/css/marketing.css");
  assert.equal(
    declares(css, ".nav-toggle", /display:\s*none/),
    false,
    "the marketing menu button is hidden on desktop again"
  );
  assert.equal(
    declares(css, ".mobile-menu", /display:\s*none/),
    false,
    "the marketing drawer is disabled on desktop again"
  );
});

test("marketing: the drawer has a close button and the bar still fits", () => {
  const html = read("public/index.html");
  const menu = html.slice(html.indexOf('data-mobile-menu'), html.indexOf('data-mobile-menu') + 600);
  assert.match(menu, /data-nav-close[^>]*data-drawer-close/);
  /* Seven links, three actions and the button share one row on a wide window. */
  const css = read("public/css/marketing.css");
  assert.match(css, /@media \(min-width: 1400px\)/);
});

/* ------------------------------------------------------------- dashboard */

test("dashboard: the page ships the scrim, the opener and a close button", () => {
  const html = read("public/app/index.html");
  assert.match(html, /id="sidebar-scrim"/);
  assert.match(html, /data-sidebar-open/);
  assert.match(html, /data-sidebar-close[^>]*data-drawer-close/);
});
