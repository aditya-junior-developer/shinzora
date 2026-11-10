/* ==========================================================================
   Admin console — the navigation drawer actually closes
   --------------------------------------------------------------------------
   The admin drawer is the shared `createDrawer` controller, so it has the same
   four exits as every other drawer: its own ✕, the scrim, Escape, and the button
   that opened it. Those were asserted by reading source; this drives the real
   controller against the real `public/admin/index.html` and checks the state the
   stylesheet keys off, which is what actually makes the panel disappear.

   It exists because "the drawer opens but will not close" was reported against
   the console. Two things could produce that and neither was covered:

     • a controller whose close paths silently stop working, and
     • a stale cached page, where old CSS leaves the panel permanently on screen
       and no click can move it — which is why the console now registers the
       service worker itself and every page's asset URLs are versioned.
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

let counter = 0;

async function mount() {
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

  const { createDrawer } = await import(
    "data:text/javascript;base64," +
      Buffer.from(read("public/js/ui/drawer.js")).toString("base64") +
      "#" +
      ++counter
  );

  const panel = document.getElementById("admin-sidebar");
  const scrim = document.getElementById("admin-scrim");
  const toggle = document.getElementById("admin-menu-toggle");
  const drawer = createDrawer({
    panel,
    scrim,
    toggles: "#admin-menu-toggle",
    activeSelector: ".admin-nav-link.is-active, .is-active"
  });

  const click = (node) => node.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  const state = () => ({
    open: panel.classList.contains("is-open"),
    scrim: scrim.classList.contains("is-visible"),
    locked: document.body.classList.contains("drawer-open"),
    expanded: toggle.getAttribute("aria-expanded"),
    hidden: panel.getAttribute("aria-hidden")
  });

  return { window, document, drawer, panel, scrim, toggle, click, state };
}

const OPEN = { open: true, scrim: true, locked: true, expanded: "true", hidden: null };
const CLOSED = { open: false, scrim: false, locked: false, expanded: "false", hidden: "true" };

test("admin: the drawer starts closed and off the screen", async () => {
  const { state } = await mount();
  assert.deepEqual(state(), CLOSED);
});

test("admin: the menu button opens it", async () => {
  const { click, toggle, state } = await mount();
  click(toggle);
  assert.deepEqual(state(), OPEN);
});

test("admin: the same button closes it again", async () => {
  const { click, toggle, state } = await mount();
  click(toggle);
  assert.deepEqual(state(), OPEN);
  click(toggle);
  assert.deepEqual(state(), CLOSED, "the drawer stayed open after a second click on its own button");
});

test("admin: its own ✕ closes it", async () => {
  const { click, toggle, document, state } = await mount();
  click(toggle);
  click(document.querySelector(".admin-drawer-close"));
  assert.deepEqual(state(), CLOSED);
});

test("admin: the scrim closes it", async () => {
  const { click, toggle, scrim, state } = await mount();
  click(toggle);
  click(scrim);
  assert.deepEqual(state(), CLOSED);
});

test("admin: Escape closes it and unlocks the page", async () => {
  const { window, click, toggle, document, state } = await mount();
  click(toggle);
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  event.key = "Escape";
  document.dispatchEvent(event);
  assert.deepEqual(state(), CLOSED);
});

test("admin: navigating inside the drawer closes it", async () => {
  const { click, toggle, panel, state } = await mount();
  click(toggle);
  /* The console's nav items are buttons; the shell calls navigate(), which calls
     the drawer's close(). A link would also close it through the shared
     close-on-navigate rule. */
  const stub = panel.ownerDocument.createElement("a");
  stub.setAttribute("href", "/admin/?view=customers");
  panel.appendChild(stub);
  click(stub);
  assert.deepEqual(state(), CLOSED);
});

test("admin: a stale cached stylesheet cannot leave the panel permanently open", () => {
  /* The panel is only on screen while `.is-open` is present, and it is off canvas
     otherwise. If a browser runs an older admin.css, the drawer really does stay
     put — no click can fix that, which is why the console now registers the
     service worker (see below) and every page versions its asset URLs. */
  const css = read("public/css/admin.css");
  assert.match(css, /\.admin-sidebar\s*\{[^}]*transform:\s*translateX\(-102%\)/);
  assert.match(css, /\.admin-sidebar\.is-open\s*\{[^}]*transform:\s*none/);

  /* The button that opens the drawer stays clickable while the scrim is up. */
  const toggleRule = css.slice(css.indexOf(".admin-menu-toggle"), css.indexOf("}", css.indexOf(".admin-menu-toggle")));
  assert.match(toggleRule, /z-index:\s*65/, "the menu button sits under the scrim, so it cannot close the drawer");
  const scrimRule = css.slice(css.indexOf(".admin-scrim {"), css.indexOf("}", css.indexOf(".admin-scrim {")));
  assert.match(scrimRule, /z-index:\s*55/);

  /* And the console keeps its own worker registration, so a stale cache is
     replaced on the next visit instead of lasting forever. */
  const boot = read("public/js/boot/admin.js");
  assert.match(boot, /registerServiceWorker\(\)/);
  assert.match(read("public/js/ui/pwa.js"), /controllerchange[\s\S]{0,200}location\.reload\(\)/);
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
