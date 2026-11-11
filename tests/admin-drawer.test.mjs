/* ==========================================================================
   Admin console — the navigation, at every width
   --------------------------------------------------------------------------
   The console used to open its menu as an overlay drawer at every width: on a
   desktop monitor it dimmed the page behind a scrim, blurred it, and left the
   console looking like a modal over its own content. The dashboard never did
   that — it keeps a column of navigation beside the page.

   The console now uses the dashboard's controller (`ui/sidebar.js`), so:

     desktop (≥1024px)  a docked column; ☰ collapses it to an icon rail; no
                        scrim, no page lock, nothing covered, nothing blurred
     phone  (≤1023px)   the same panel as a modal drawer: scrim, body lock,
                        Escape, its own ✕, closes on navigation

   These tests drive the real controller against the real admin markup, and read
   the real stylesheet for the parts no DOM can prove (which width is which).
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

const PAGE = read("public/admin/index.html");
const BODY = PAGE.slice(PAGE.search(/<body[^>]*>/), PAGE.lastIndexOf("</body>"));
const CSS = read("public/css/admin.css");

let counter = 0;

/* One preference store for the whole file, like one browser: a "fresh mount" is
   a reload, not a new browser, so the remembered rail must survive it. */
const store = new Map();

/** Mount the console's real markup with the real controller. */
async function mount({ desktop = true } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${BODY}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.location = { pathname: "/admin/", search: "", href: "http://localhost/admin/", origin: "http://localhost" };
  window.HTMLElement.prototype.focus = () => {};

  /* Preference storage, so the remembered rail can be asserted. */
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };

  /* The controller asks matchMedia which side of 1024px it is on. */
  const listeners = [];
  globalThis.matchMedia = (query) => ({
    media: query,
    matches: desktop,
    addEventListener: (_type, handler) => listeners.push(handler),
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {}
  });

  const { createSidebar } = await import(
    "data:text/javascript;base64," + Buffer.from(read("public/js/ui/sidebar.js")).toString("base64") + "#" + ++counter
  );

  const panel = document.getElementById("admin-sidebar");
  const scrim = document.getElementById("admin-scrim");
  const toggle = document.getElementById("admin-menu-toggle");
  const sidebar = createSidebar({ panel, scrim, toggles: "#admin-menu-toggle" });

  const click = (node) => node.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  const state = () => ({
    mode: document.documentElement.getAttribute("data-sidebar"),
    scrim: scrim.classList.contains("is-visible"),
    locked: document.body.classList.contains("sidebar-open"),
    expanded: toggle.getAttribute("aria-expanded"),
    hidden: panel.getAttribute("aria-hidden"),
    inert: panel.hasAttribute("inert"),
    stored: store.get("shinzora:sidebar") ?? null
  });

  return { window, document, sidebar, panel, scrim, toggle, click, state };
}

/* --------------------------------------------------------------- desktop */

test("admin: on a desktop the navigation is in the layout, not over it", async () => {
  const { state } = await mount({ desktop: true });
  const now = state();
  assert.equal(now.mode, "expanded", "the column did not start expanded");
  assert.equal(now.scrim, false, "a desktop column still has a scrim over the page");
  assert.equal(now.locked, false, "a desktop column locked the page scroll");
  assert.equal(now.hidden, null, "a desktop column is hidden from assistive tech");
  assert.equal(now.inert, false);
  assert.equal(now.expanded, "true");
});

test("admin: the ☰ collapses the column to a rail and back", async () => {
  const { click, toggle, state } = await mount({ desktop: true });
  click(toggle);
  assert.equal(state().mode, "rail", "the menu button did not collapse the column");
  assert.equal(state().scrim, false, "collapsing a column must not put a scrim on the page");
  assert.equal(state().locked, false, "collapsing a column must not lock the page");
  assert.equal(state().expanded, "false");

  click(toggle);
  assert.equal(state().mode, "expanded", "the menu button did not restore the column");
});

test("admin: the rail is remembered between visits", async () => {
  const { click, toggle, state } = await mount({ desktop: true });
  click(toggle);
  assert.equal(state().stored, "rail", "the collapsed state was not saved");

  /* A fresh mount (new page load) reads the same preference. */
  const again = await mount({ desktop: true });
  assert.equal(again.state().mode, "rail", "a remembered rail was not applied on load");
});

/* ----------------------------------------------------------------- phone */

test("admin: below 1024px the ☰ opens an overlay drawer", async () => {
  const { click, toggle, state } = await mount({ desktop: false });
  assert.equal(state().scrim, false);
  click(toggle);
  const open = state();
  assert.equal(open.scrim, true, "the phone drawer opened without a scrim");
  assert.equal(open.locked, true, "the page still scrolls behind the phone drawer");
  assert.equal(open.expanded, "true");
  assert.equal(open.hidden, null, "an open drawer is still hidden from assistive tech");
});

test("admin: the ✕ closes the phone drawer", async () => {
  const { click, toggle, document, state } = await mount({ desktop: false });
  click(toggle);
  click(document.querySelector(".admin-drawer-close"));
  assert.equal(state().scrim, false);
  assert.equal(state().locked, false);
  assert.equal(state().hidden, "true");
});

test("admin: the scrim closes the phone drawer", async () => {
  const { click, toggle, scrim, state } = await mount({ desktop: false });
  click(toggle);
  click(scrim);
  assert.equal(state().scrim, false);
  assert.equal(state().locked, false);
});

test("admin: Escape closes the phone drawer", async () => {
  const { window, click, toggle, document, state } = await mount({ desktop: false });
  click(toggle);
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  event.key = "Escape";
  document.dispatchEvent(event);
  assert.equal(state().scrim, false, "Escape left the phone drawer open");
  assert.equal(state().locked, false);
});

test("admin: picking a destination closes the phone drawer", async () => {
  const { window, click, toggle, state } = await mount({ desktop: false });
  click(toggle);
  window.dispatchEvent(new window.Event("shinzora:view"));
  assert.equal(state().scrim, false, "the drawer survived a view change");
});

/* ------------------------------------------------------------ stylesheet */

/* Comments quote the rules they explain, so assertions read the declarations
   without the prose around them. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of one block, by exact selector text. */
function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} is missing`);
  return css.slice(start, css.indexOf("}", start));
}

/** Everything inside one media query, by its query text. */
function media(css, query) {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `@media ${query} is missing`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return css.slice(start);
}

test("admin: the stylesheet docks the column on a desktop", () => {
  const css = stripComments(CSS);

  /* The panel is pinned to the left edge, full height, at the layout's width. */
  const panel = rule(css, ".admin-sidebar");
  assert.match(panel, /position:\s*fixed/);
  assert.match(panel, /inset:\s*0 auto 0 0/, "the column no longer spans the viewport height");
  assert.match(panel, /width:\s*var\(--shell-nav\)/, "the column ignores the layout width");
  assert.doesNotMatch(panel, /translateX/, "the desktop column is still off canvas");

  /* The content is offset by the same number, so nothing is covered. */
  assert.match(rule(css, ".admin-main"), /margin-left:\s*var\(--shell-nav\)/);
  assert.match(rule(css, ".admin-shell"), /--shell-nav:\s*280px/);

  /* The rail is a narrower column, not a hidden one. */
  assert.match(css, /:root\[data-sidebar="rail"\]\s+\.admin-shell\s*\{[^}]*--shell-nav:\s*76px/);

  /* Nothing is dimmed or blurred on a desktop. */
  const desktop = media(css, "(min-width: 1024px)");
  assert.match(desktop, /\.admin-scrim\s*\{[^}]*display:\s*none/, "the desktop scrim is still painted");
  assert.doesNotMatch(desktop, /backdrop-filter/, "the desktop view is still blurred");
});

test("admin: the drawer rules live below 1024px only", () => {
  const css = stripComments(CSS);
  const phone = media(css, "(max-width: 1023px)");

  assert.match(phone, /\.admin-main\s*\{[^}]*margin-left:\s*0/, "the phone still offsets content for a column");
  const panel = rule(phone, ".admin-sidebar");
  assert.match(panel, /inset:\s*var\(--nav-h\) auto 0 0/, "the phone drawer covers the menu button");
  assert.match(panel, /transform:\s*translateX\(-102%\)/, "the phone drawer is not off canvas while closed");
  assert.match(panel, /height:\s*calc\(100dvh - var\(--nav-h\)\)/);

  /* Opening is driven by the controller's body class, not by a class nobody sets. */
  assert.match(phone, /body\.sidebar-open \.admin-sidebar\s*\{[^}]*transform:\s*none/);
  assert.match(phone, /body\.sidebar-open\s*\{[^}]*overflow:\s*hidden/);
  assert.match(phone, /\.admin-scrim\.is-visible\s*\{[^}]*opacity:\s*1/);

  /* The bar stays above the panel, so the ☰ remains clickable while it is open. */
  const zOf = (block) => Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
  assert.ok(zOf(rule(css, ".admin-topbar")) > zOf(rule(css, ".admin-sidebar")), "the topbar is under the drawer");
  assert.ok(zOf(rule(css, ".admin-sidebar")) > zOf(rule(phone, ".admin-scrim")), "the drawer is under its own scrim");
});

test("admin: the console asks the shared controller, not the modal drawer", () => {
  const shell = read("public/js/modules/admin/shell.js");
  assert.match(shell, /import \{ createSidebar \} from "\.\.\/\.\.\/ui\/sidebar\.js"/);
  assert.match(shell, /createSidebar\(\{/);
  assert.doesNotMatch(shell, /createDrawer/, "the console went back to the modal drawer");
});

test("admin: the saved rail is applied before the first frame", () => {
  /* A remembered rail that is applied after paint flashes a full-width column
     and then snaps — the same class of bug the dashboard fixed inline. */
  assert.match(PAGE, /data-sidebar[\s\S]{0,160}localStorage\.getItem\("shinzora:sidebar"\)/);
});

test("admin: navigating closes the phone drawer", () => {
  const shell = read("public/js/modules/admin/shell.js");
  const navigate = shell.slice(shell.indexOf("export function navigate"), shell.indexOf("export function navigate") + 400);
  assert.match(navigate, /adminDrawer\?\.close\(\)/);
});

test("every page versions its assets, so a deploy cannot hide behind a cache", () => {
  const pages = [
    "public/app/index.html",
    "public/admin/index.html",
    "public/index.html",
    "public/auth/login/index.html",
    "public/onboarding/index.html"
  ];
  const versions = new Set();
  for (const page of pages) {
    const html = read(page);
    const found = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((match) => match[1]);
    assert.ok(found.length > 0, `${page} ships no asset version`);
    found.forEach((version) => versions.add(version));
  }
  assert.equal(versions.size, 1, `pages disagree on the asset version: ${[...versions].join(", ")}`);
});
