/* ==========================================================================
   Sidebar — persistent navigation
   --------------------------------------------------------------------------
   The sidebar is a column of the layout on a desktop: one click narrows it to an
   icon rail, another click brings the labels back, and the page beside it keeps
   working throughout — no scrim, no blur, no scroll lock. Below 1024px the same
   panel becomes an overlay drawer that closes itself on navigation.

   These tests drive the real controller (public/js/ui/sidebar.js) against the
   real markup (public/app/index.html), so a change to either that breaks the
   agreement between them fails here rather than in front of a customer.

   CSS cannot be measured in linkedom. What is pinned is the state the
   stylesheet keys off — the html attribute, the body class, the scrim class,
   the ARIA wiring and storage — plus the layout rules themselves in
   tests/drawer-surfaces.test.mjs.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

let counter = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The dashboard's real body markup, so the tests cannot drift from the page. */
const PAGE = read("public/app/index.html");
const BODY = PAGE.slice(PAGE.indexOf("<body>"), PAGE.indexOf("</body>"));

/**
 * A DOM with one honest switch: matchMedia answers the breakpoint the test asks
 * for. Everything else is the real page.
 */
function dom({ desktop = true } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${BODY}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.location = {
    pathname: "/app/",
    search: "",
    href: "http://localhost/app/",
    origin: "http://localhost",
    reload() {},
    assign() {}
  };

  /* linkedom has no focus(); record the intent instead. */
  globalThis.__focused = null;
  window.HTMLElement.prototype.focus = function focus() {
    globalThis.__focused = this;
  };

  const listeners = new Set();
  const media = {
    matches: desktop,
    media: "(min-width: 1024px)",
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler)
  };
  window.matchMedia = () => media;
  globalThis.matchMedia = window.matchMedia;

  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };

  /** Pretend the window was resized across the breakpoint. */
  const resizeTo = (nextDesktop) => {
    media.matches = nextDesktop;
    listeners.forEach((handler) => handler({ matches: nextDesktop, media: media.media }));
  };

  return { window, document, store, resizeTo };
}

const click = (window, node) =>
  node.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

const escape = (window) => {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  event.key = "Escape";
  document.dispatchEvent(event);
};

async function loadSidebar(options = {}) {
  /* `html` lets a test run the controller against markup cached from an older
     deploy — the mixed-version case that a stale service worker produces. */
  if (options.html) {
    const { window, document } = parseHTML(`<!doctype html><html><body>${options.html}</body></html>`);
    globalThis.window = window;
    globalThis.document = document;
    globalThis.Element = window.Element;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Node = window.Node;
    globalThis.Event = window.Event;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.location = { pathname: "/app/", search: "", href: "http://localhost/app/", origin: "http://localhost", reload() {} };
    window.HTMLElement.prototype.focus = function focus() {
      globalThis.__focused = this;
    };
    const media = { matches: options.desktop !== false, addEventListener() {}, removeEventListener() {} };
    window.matchMedia = () => media;
    globalThis.matchMedia = window.matchMedia;
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    };
    const { createSidebar } = await import(
      "data:text/javascript;base64," + Buffer.from(read("public/js/ui/sidebar.js")).toString("base64") + "#" + ++counter
    );
    const sidebar = createSidebar({ panel: document.getElementById("app-sidebar"), scrim: document.getElementById("sidebar-scrim") });
    await settle();
    return { window, document, store, sidebar, toggle: document.querySelector("[data-sidebar-open]") };
  }

  const env = dom(options);
  const { createSidebar } = await import(
    "data:text/javascript;base64," +
      Buffer.from(read("public/js/ui/sidebar.js")).toString("base64") +
      "#" + ++counter
  );
  const sidebar = createSidebar({
    panel: env.document.getElementById("app-sidebar"),
    scrim: env.document.getElementById("sidebar-scrim")
  });
  await settle();
  return { ...env, sidebar, toggle: env.document.getElementById("sidebar-toggle") };
}

/* ------------------------------------------------------------- desktop ---- */

test("desktop: the sidebar is a column, expanded, and the page is not locked", async () => {
  const { document, sidebar, toggle } = await loadSidebar();

  assert.equal(document.documentElement.getAttribute("data-sidebar"), "expanded");
  assert.equal(sidebar.isExpanded(), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(document.body.classList.contains("sidebar-open"), false, "no overlay class on a desktop");
  assert.equal(document.getElementById("sidebar-scrim").classList.contains("is-visible"), false, "no scrim over the content");
  assert.equal(document.getElementById("app-sidebar").getAttribute("aria-hidden"), null, "the navigation stays available to a screen reader");
  assert.equal(document.body.classList.contains("drawer-open"), false, "and the page behind is not scroll-locked");
});

test("desktop: one click collapses to the icon rail, another expands it", async () => {
  const { document, sidebar, toggle, store } = await loadSidebar();

  click(window, toggle);
  assert.equal(document.documentElement.getAttribute("data-sidebar"), "rail");
  assert.equal(sidebar.isExpanded(), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "Expand navigation");
  assert.equal(store.get("shinzora:sidebar"), "rail", "the choice is remembered");
  assert.equal(document.getElementById("app-sidebar").getAttribute("aria-hidden"), null, "the rail is still a real navigation");
  assert.equal(document.body.classList.contains("sidebar-open"), false, "collapsing never puts an overlay on the page");

  click(window, toggle);
  assert.equal(document.documentElement.getAttribute("data-sidebar"), "expanded");
  assert.equal(sidebar.isExpanded(), true);
  assert.equal(store.get("shinzora:sidebar"), "expanded");
});

test("desktop: a remembered rail is restored without a full sidebar flashing first", async () => {
  globalThis.localStorage = { getItem: () => "rail", setItem() {}, removeItem() {} };
  const env = dom();
  globalThis.localStorage = { getItem: () => "rail", setItem() {}, removeItem() {} };
  const { createSidebar } = await import(
    "data:text/javascript;base64," + Buffer.from(read("public/js/ui/sidebar.js")).toString("base64") + "#" + ++counter
  );
  createSidebar({ panel: env.document.getElementById("app-sidebar"), scrim: env.document.getElementById("sidebar-scrim") });
  assert.equal(env.document.documentElement.getAttribute("data-sidebar"), "rail");

  /* And the page itself sets it before the first paint, so the width is right
     from the first frame rather than after hydration. */
  assert.match(PAGE, /localStorage\.getItem\("shinzora:sidebar"\)/, "the pre-paint script reads the same key");
});

/* -------------------------------------------------------------- mobile ---- */

test("phone: the panel is off canvas and hidden from assistive tech until opened", async () => {
  const { document, sidebar } = await loadSidebar({ desktop: false });

  assert.equal(document.getElementById("app-sidebar").getAttribute("aria-hidden"), "true");
  assert.ok(document.getElementById("app-sidebar").hasAttribute("inert"), "a closed overlay is not tabbable");
  assert.equal(sidebar.isExpanded(), false);
  assert.equal(document.getElementById("sidebar-scrim").classList.contains("is-visible"), false);
});

test("phone: the hamburger opens an overlay with a scrim and focus inside", async () => {
  const { window, document, sidebar, toggle } = await loadSidebar({ desktop: false });

  click(window, toggle);
  const panel = document.getElementById("app-sidebar");
  assert.equal(sidebar.isExpanded(), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(document.body.classList.contains("sidebar-open"), true, "the page behind stops scrolling");
  assert.equal(document.getElementById("sidebar-scrim").classList.contains("is-visible"), true);
  assert.equal(panel.getAttribute("aria-hidden"), null);
  assert.equal(panel.hasAttribute("inert"), false);
  assert.ok(globalThis.__focused?.closest?.("#app-sidebar"), "focus moves into the panel");
});

test("phone: choosing a destination puts the panel away", async () => {
  const { window, document, sidebar, toggle } = await loadSidebar({ desktop: false });

  click(window, toggle);
  click(window, document.querySelector("[data-sidebar-new-chat]"));
  assert.equal(sidebar.isExpanded(), false, "a link inside the panel closes the overlay");
  assert.equal(document.body.classList.contains("sidebar-open"), false);

  click(window, toggle);
  window.dispatchEvent(new window.CustomEvent("shinzora:view", { detail: { view: "orders" } }));
  assert.equal(sidebar.isExpanded(), false, "so does arriving on a new view");
});

test("phone: Escape and a scrim click both close the overlay", async () => {
  const { window, document, sidebar, toggle } = await loadSidebar({ desktop: false });

  click(window, toggle);
  escape(window);
  assert.equal(sidebar.isExpanded(), false);

  click(window, toggle);
  click(window, document.getElementById("sidebar-scrim"));
  assert.equal(sidebar.isExpanded(), false);

  click(window, toggle);
  click(window, document.querySelector("[data-sidebar-close]"));
  assert.equal(sidebar.isExpanded(), false, "the panel keeps its own close button for a phone");
});

test("crossing the breakpoint does not leave an overlay over a desktop layout", async () => {
  const { window, document, resizeTo, toggle } = await loadSidebar({ desktop: false });

  click(window, toggle);
  assert.equal(document.body.classList.contains("sidebar-open"), true);

  resizeTo(true);
  assert.equal(document.body.classList.contains("sidebar-open"), false, "the scroll lock is released");
  assert.equal(document.getElementById("sidebar-scrim").classList.contains("is-visible"), false, "the scrim is gone");
  assert.equal(document.getElementById("app-sidebar").getAttribute("aria-hidden"), null, "and the column is visible again");
  assert.equal(document.documentElement.getAttribute("data-sidebar"), "expanded");
});

/* ---------------------------------------------------------------- shell ---- */

/** The shell, bundled with its data layer stubbed, against the real markup. */
async function loadShell({ accountType = "owner", conversations = [] } = {}) {
  const env = dom({ desktop: true });

  const stub = (contents) => ({ contents, loader: "js" });
  const stubs = {
    store: `
      export const state = {
        profile: { id: "u-1", full_name: "Aditya Sharma", account_type: "${accountType}" },
        business: null, subscription: null, onboarding: null, isAdmin: false, unreadNotifications: 0
      };
      export function aiCredits() { return { used: 3, limit: 30 }; }
      export function plan() { return { name: "Free" }; }
      export function hasCompletedOnboarding() { return true; }
      export const on = () => {};
    `,
    format: `
      export function initials(name) { return String(name || "SZ").slice(0, 2).toUpperCase(); }
      export function timeAgo() { return "now"; }
    `,
    guard: `export async function logoutEverywhere() {}`,
    toast: `export function toast() {} export function toastError() {}`,
    supabase: `
      export const sb = {
        from(table) {
          const rows = ${JSON.stringify(conversations)};
          const chain = {
            select: () => chain,
            eq: () => chain,
            order: () => chain,
            limit: () => Promise.resolve({ data: table === "ai_conversations" ? rows : [], error: null })
          };
          return chain;
        },
        channel: () => ({ on: () => ({ subscribe: () => {} }) }),
        removeChannel() {}
      };
      export function normalizeError(e) { return e instanceof Error ? e : new Error(String(e)); }
      export async function getSession() { return { user: { id: "u-1" } }; }
      export class AppError extends Error { constructor(m, o = {}) { super(m); Object.assign(this, o); } }
    `,
    data: `
      export const markAllNotificationsRead = async () => {};
      export const markNotificationRead = async () => {};
      export const notifications = async () => [];
      export const uid = () => "x";
    `,
    site: `export function resolvePublishedSite() { return Promise.resolve(null); } export function rememberPublishedSite() {}`,
    heartbeat: `export function startPresence() {} export function runReferralTick() { return Promise.resolve(); }`
  };

  const plugin = {
    name: "shell-stubs",
    setup(build) {
      const map = {
        "lib/store.js$": "store",
        "lib/format.js$": "format",
        "lib/guard.js$": "guard",
        "ui/toast.js$": "toast",
        "lib/supabase.js$": "supabase",
        "dashboard/data.js$": "data",
        "lib/site-url.js$": "site",
        "ui/heartbeat.js$": "heartbeat"
      };
      for (const [filter, name] of Object.entries(map)) {
        build.onResolve({ filter: new RegExp(filter) }, () => ({ path: name, namespace: "stub" }));
      }
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => stub(stubs[args.path]));
    }
  };

  const result = await esbuild.build({
    entryPoints: [path.join(repo, "public/js/modules/dashboard/shell.js")],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [plugin]
  });
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  const mod = await import(url);
  mod.renderSidebar("overview");
  mod.bindChrome({ navigate: () => {} });
  await settle();
  return { ...env, mod };
}

test("every navigation item is a real link with a label the rail can still read", async () => {
  const { document } = await loadShell();
  const links = [...document.querySelectorAll("#sidebar-nav a[data-nav]")];

  assert.ok(links.length >= 15, `expected the full navigation, saw ${links.length} links`);
  links.forEach((link) => {
    assert.match(link.getAttribute("href"), /^\/app\/\?view=[a-z-]+$/, `${link.dataset.nav} does not point at a view`);
    assert.ok(link.querySelector(".link-text")?.textContent.trim(), `${link.dataset.nav} lost its label`);
    assert.ok(link.getAttribute("data-label"), `${link.dataset.nav} has no tooltip label for the rail`);
  });

  const current = document.querySelector('#sidebar-nav a[aria-current="page"]');
  assert.equal(current?.dataset.nav, "overview", "the page you are on is marked for assistive tech");
});

test("the sidebar lists real conversations, and each one links to that conversation", async () => {
  const { document } = await loadShell({
    conversations: [
      { id: "c-1", title: "Pricing for the tote line", updated_at: "2026-11-04T10:00:00Z" },
      { id: "c-2", title: "Instagram captions", updated_at: "2026-11-03T10:00:00Z" }
    ]
  });

  const chats = [...document.querySelectorAll("#sidebar-recent .sidebar-chat[data-chat]")];
  assert.equal(chats.length, 2);
  assert.equal(chats[0].getAttribute("href"), "/app/?view=assistant&conversation=c-1");
  assert.match(chats[0].textContent, /Pricing for the tote line/);

  /* And one honest way to see the rest, pointing at the assistant's own list. */
  const all = document.querySelector("#sidebar-recent .sidebar-chat-all");
  assert.equal(all.getAttribute("href"), "/app/?view=assistant&history=1");
});

test("an account with no conversations is told so instead of shown invented ones", async () => {
  const { document } = await loadShell({ conversations: [] });
  const empty = document.querySelector("#sidebar-recent .sidebar-chat-empty");
  assert.ok(empty, "no empty state rendered");
  assert.match(empty.textContent, /no conversations/i);
  assert.equal(document.querySelectorAll("#sidebar-recent .sidebar-chat").length, 0, "an empty list must not offer \"All chats\"");
});

test("a new chat is one click away from the sidebar", async () => {
  const { document } = await loadShell();
  const link = document.querySelector("[data-sidebar-new-chat]");
  assert.equal(link.getAttribute("href"), "/app/?view=assistant&new=1");
  assert.equal(link.getAttribute("aria-label"), "Start a new chat");
});

test("the workspace switcher expands the rail, so its menu is not clipped to 76px", async () => {
  const { window, document, store } = await loadShell();

  /* Nobody would leave the menu open in a 76px column: clicking the switcher
     widens the sidebar first and then opens the menu inside it. */
  document.documentElement.setAttribute("data-sidebar", "rail");
  click(window, document.getElementById("workspace-switch"));

  assert.equal(document.documentElement.getAttribute("data-sidebar"), "expanded");
  assert.equal(store.get("shinzora:sidebar"), "expanded", "and the choice is remembered");
});

test("an agent's sidebar is their own, not a shop they do not run", async () => {
  const { document } = await loadShell({ accountType: "agent" });
  const links = [...document.querySelectorAll("#sidebar-nav [data-nav]")].map((a) => a.dataset.nav);
  assert.ok(links.includes("freelancer"));
  assert.equal(links.includes("orders"), false);
});

test("a cached copy of the old markup still gets a working hamburger", async () => {
  /* What a stale service worker used to hand a returning visitor: yesterday's
     buttons on today's page. The controller binds the old attribute too, so the
     sidebar can still be collapsed instead of freezing open. */
  const legacy = BODY.replace(/id="sidebar-toggle" data-sidebar-toggle/, 'id="sidebar-toggle" data-sidebar-open');
  const { document, toggle, sidebar } = await loadSidebar({ html: legacy });

  assert.ok(toggle, "the legacy toggle was not found");
  assert.equal(sidebar.isExpanded(), true);
  click(window, toggle);
  assert.equal(document.documentElement.getAttribute("data-sidebar"), "rail", "the old button could not collapse the sidebar");
  click(window, toggle);
  assert.equal(document.documentElement.getAttribute("data-sidebar"), "expanded");
});

/* ------------------------------------------------------- the page itself ---- */

test("the page ships one hamburger, and no leftover collapse button", () => {
  assert.match(BODY, /data-sidebar-toggle/, "the hamburger is missing");
  assert.match(BODY, /aria-controls="app-sidebar"/, "the button does not describe what it controls");
  assert.equal(/id="sidebar-collapse"/.test(BODY), false, "the old second toggle is still in the page");
  assert.equal(/data-sidebar-open/.test(BODY), false, "the old opener attribute is still in the page");
});

test("the service worker never serves code from an older deploy", () => {
  const sw = read("public/sw.js");
  /* Navigations are network-first, so HTML is always current. Code must match
     it: cache-first JS is what made the hamburger dead on the first visit after
     the sidebar shipped. */
  const codeBlock = sw.slice(sw.indexOf("if (sameOrigin && isCode)"), sw.indexOf("if (sameOrigin && isAsset)"));
  assert.match(codeBlock, /fetch\(request\)\s*\.then/, "code is not fetched from the network first");
  assert.equal(
    /return cached \|\| network/.test(codeBlock),
    false,
    "code is still served from the cache first"
  );
  assert.match(codeBlock, /catch\(async \(\) => \(await caches\.match\(request\)\)/, "there is no offline fallback for code");

  /* Images may keep the cheap strategy. */
  const assetBlock = sw.slice(sw.indexOf("if (sameOrigin && isAsset)"));
  assert.match(assetBlock, /return cached \|\| network/);
});

test("no keyboard shortcut opens or closes the sidebar", () => {
  const sidebar = read("public/js/ui/sidebar.js");
  const shell = read("public/js/modules/dashboard/shell.js");
  for (const source of [sidebar, shell]) {
    assert.equal(/ctrlKey[\s\S]{0,80}shiftKey[\s\S]{0,80}sidebar/i.test(source), false, "a Ctrl+Shift shortcut came back");
    assert.equal(/KeyS/.test(source), false, "a keyboard shortcut on S came back");
  }
  /* The only shortcut the shell keeps is the documented ⌘K search focus. */
  assert.match(shell, /event\.key\.toLowerCase\(\) === "k"/);
});
