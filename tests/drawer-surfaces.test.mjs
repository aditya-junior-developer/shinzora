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


/** The stylesheet with every narrow-screen block removed, so a rule found in the
 *  result is one that applies at desktop width. */
function desktopOnly(css) {
  let out = "";
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf("@media (max-width: 1023px)", index);
    if (start === -1) {
      out += css.slice(index);
      break;
    }
    out += css.slice(index, start);
    let depth = 0;
    let cursor = css.indexOf("{", start);
    for (; cursor < css.length; cursor += 1) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ shared */

test("the modal surfaces share one drawer controller", () => {
  const drawer = read("public/js/ui/drawer.js");
  assert.match(drawer, /export function createDrawer/);

  /* The admin console and the marketing menu are drawers: they cover the page,
     lock it, and go away when a destination is picked. */
  for (const file of [
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

/* --------------------------------------------------------------- dashboard */
/*
 * The dashboard sidebar is the exception, and deliberately so: above 1024px it
 * is a column of the layout, not a modal. A drawer that locks the page would be
 * the wrong component for something the user keeps open while they work, so it
 * has its own controller — and this test makes sure it stays that way instead of
 * quietly inheriting the modal behaviour.
 */
test("dashboard: the sidebar is a column, not a drawer", () => {
  const shell = read("public/js/modules/dashboard/shell.js");
  assert.match(shell, /import \{ createSidebar \} from "[./]*\/?.*sidebar\.js"/);
  assert.equal(/createDrawer\(/.test(shell), false, "the dashboard sidebar went back to being a modal drawer");

  const css = read("public/css/app.css");
  /* Fixed panel + content offset by the same number. Both `width` and
     `margin-left` animate everywhere, which a grid track does not. */
  assert.match(css, /\.app-sidebar\s*\{[^}]*position:\s*fixed/, "the sidebar is not fixed");
  assert.match(css, /\.app-sidebar\s*\{[^}]*width:\s*var\(--shell-nav\)/, "the panel does not take the shell's width");
  assert.match(css, /\.app-main\s*\{[^}]*margin-left:\s*var\(--shell-nav\)/, "the content is not offset by the sidebar, so the panel would cover it");
  assert.match(css, /:root\[data-sidebar="rail"\]\s*\.app-shell\s*\{[^}]*--shell-nav:\s*var\(--sidebar-w-collapsed\)/, "the rail does not narrow the navigation");
  assert.match(css, /\.app-sidebar\s*\{[^}]*transition:\s*width/, "collapsing is not animated");
  assert.match(css, /\.app-main\s*\{[^}]*transition:\s*margin-left/, "the content does not move with it");
});

test("dashboard: the scrim and the scroll lock only exist below 1024px", () => {
  const css = read("public/css/app.css");
  /* The base scrim rule must not be a visible overlay... */
  assert.match(css, /\.sidebar-scrim\s*\{\s*display:\s*none;\s*\}/, "a scrim is drawn at desktop width again");
  /* ...and the blocking behaviour has to live inside the phone media query. */
  const start = css.indexOf("@media (max-width: 1023px) {\n  .sidebar-scrim");
  assert.ok(start > 0, "the scrim is not scoped to the phone breakpoint");
  const block = css.slice(start, css.indexOf("\n  .sidebar-scrim.is-visible", start) + 200);
  assert.match(block, /position:\s*fixed/);
  assert.match(block, /background:/);

  /* No blur, no darkening, and no page lock while the column is open. */
  assert.equal(/\.app-sidebaris-open/.test(css), false);
  const desktopRules = desktopOnly(css);
  /* The sticky topbar blurs its own strip; nothing may blur or darken the page
     because the sidebar is open. */
  assert.equal(
    /\.sidebar-scrim[^{]*\{[^}]*backdrop-filter/.test(desktopRules),
    false,
    "the scrim blurs the desktop page"
  );
  assert.equal(
    /body\.sidebar-open\s*\{[^}]*overflow:\s*hidden/.test(desktopRules),
    false,
    "the desktop page locks scroll while the sidebar is open"
  );
});

test("dashboard: the icon rail keeps the labels for screen readers", () => {
  const css = read("public/css/app.css");
  const rail = css.slice(
    css.indexOf(':root[data-sidebar="rail"] .brand-word'),
    css.indexOf("Overlay mode (below 1024px)")
  );
  assert.match(rail, /clip-path:\s*inset\(50%\)/, "rail labels are removed from the accessibility tree");
  /* The label block itself must clip, never `display:none` — that would take
     the accessible name away from the only thing left in the rail. */
  const labelRule = rail.slice(rail.indexOf(".link-text"), rail.indexOf("}", rail.indexOf(".link-text")));
  assert.match(labelRule, /clip-path:\s*inset\(50%\)/);
  assert.equal(/display:\s*none\s*;/.test(labelRule), false, "the rail hides its labels with display:none");
  /* The tooltip is a fixed-position bubble owned by sidebar.js: a pseudo-element
     would be clipped by the navigation's own scroll box. */
  assert.match(css, /\.rail-tip\s*\{[^}]*position:\s*fixed/, "the rail tooltip is not free of the scroll box");
  assert.match(read("public/js/ui/sidebar.js"), /className = "rail-tip"/);
});

test("dashboard: a phone drawer always shows its labels", () => {
  const css = read("public/css/app.css");
  const phone = css.slice(css.indexOf("@media (max-width: 1023px) {\n  .app-main"));
  assert.match(phone, /clip:\s*auto/, "a remembered rail hides the labels on a phone too");
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

test("dashboard: the page ships the scrim, one hamburger and a close button", () => {
  const html = read("public/app/index.html");
  assert.match(html, /id="sidebar-scrim"/);
  assert.match(html, /data-sidebar-toggle/);
  assert.match(html, /data-sidebar-close/);
  assert.equal(html.match(/data-sidebar-toggle/g).length, 1, "there is more than one sidebar toggle");
});
