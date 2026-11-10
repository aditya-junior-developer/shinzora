/* ==========================================================================
   Navigation drawer — shell behaviour
   --------------------------------------------------------------------------
   The sidebar used to be a permanent column on desktop and a drawer only on
   phones. It is a drawer at every width now, which means it is modal: the page
   behind it must not scroll, Escape and a click outside must close it, it must
   not stay open across navigation, and focus must land inside it when it opens.

   These tests drive the real shell module in linkedom. CSS cannot be measured
   here, so what is pinned is the state the stylesheet keys off — the classes,
   attributes and focus — which is the part a later refactor can silently break.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

let counter = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/* The markup the dashboard page ships, reduced to the chrome bindChrome binds. */
const SHELL = `
  <div class="app-shell">
    <aside class="app-sidebar" id="app-sidebar" aria-label="Workspace navigation">
      <div class="sidebar-head">
        <a class="nav-brand" href="/app/"><span class="brand-word">SHINZORA</span></a>
        <button class="sidebar-close" data-sidebar-close aria-label="Close navigation">x</button>
      </div>
      <div class="sidebar-workspace">
        <button class="workspace-switch" id="workspace-switch" aria-haspopup="menu" aria-expanded="false">
          <span class="avatar avatar-sm" id="workspace-avatar">SZ</span>
          <span class="ws-meta"><span class="ws-name" id="workspace-name">Your business</span></span>
        </button>
        <div class="menu" id="workspace-menu" hidden><a class="menu-item" href="/app/?view=settings">Settings</a></div>
      </div>
      <div class="sidebar-scroll"><nav id="sidebar-nav"></nav></div>
      <div class="sidebar-foot">
        <button id="sidebar-signout">Sign out</button>
      </div>
    </aside>
    <div class="sidebar-scrim" id="sidebar-scrim"></div>
    <div class="app-main">
      <header class="app-topbar">
        <button class="topbar-toggle" data-sidebar-open aria-label="Open navigation" aria-expanded="false">menu</button>
        <div class="topbar-search" id="global-search-wrap">
          <input type="search" id="global-search" />
          <div class="search-results" id="search-results" hidden></div>
        </div>
        <div class="topbar-actions">
          <button class="topbar-avatar" id="account-toggle" aria-expanded="false">Account</button>
          <div class="menu" id="account-menu" hidden><a class="menu-item" href="/app/?view=settings">Settings</a></div>
        </div>
      </header>
      <main class="app-content" id="app-content"><div id="view-root"></div></main>
    </div>
  </div>
  <div class="drawer" id="notification-drawer" hidden></div>
  <div class="drawer-scrim" id="drawer-scrim"></div>
`;

async function loadShell({ collapsed = "0", accountType = "owner" } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${SHELL}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.location = { pathname: "/app/", search: "", href: "http://localhost/app/", origin: "http://localhost", reload() {} };

  /* linkedom has no focus()/activeElement, so record the intent instead: the
     prototype spy answers "where would focus have gone?". */
  globalThis.__focused = null;
  window.HTMLElement.prototype.focus = function focus() {
    globalThis.__focused = this;
  };

  const store = new Map([["shinzora.sidebar.collapsed", collapsed]]);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  globalThis.__store = store;

  const stub = (contents) => ({ contents, loader: "js" });
  const stubs = {
    store: `
      export const state = {
        profile: { id: "u-1", full_name: "Aditya Sharma", account_type: "${accountType}" },
        business: null, subscription: null, onboarding: null, isAdmin: false, unreadNotifications: 0
      };
      export function aiCredits() { return { used: 0, limit: 30 }; }
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
      export const sb = { channel: () => ({ on: () => ({ subscribe: () => {} }) }), removeChannel() {} };
      export function normalizeError(e) { return e instanceof Error ? e : new Error(String(e)); }
      export class AppError extends Error { constructor(m, o = {}) { super(m); Object.assign(this, o); } }
    `,
    data: `
      export const markAllNotificationsRead = async () => {};
      export const markNotificationRead = async () => {};
      export const notifications = async () => [];
      export const uid = () => "x";
    `,
    site: `export function resolvePublishedSite() { return null; } export function rememberPublishedSite() {}`
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
        "lib/site-url.js$": "site"
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
  return { mod, window, document };
}

const click = (window, node) => node.dispatchEvent(new window.Event("click", { bubbles: true }));

test("the drawer starts closed and reports it", async () => {
  const { document } = await loadShell();
  const sidebar = document.getElementById("app-sidebar");
  assert.equal(sidebar.classList.contains("is-open"), false, "navigation does not reserve space on load");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true", "and is hidden from assistive tech");
  assert.equal(document.body.classList.contains("drawer-open"), false);
  assert.equal(document.querySelector("[data-sidebar-open]").getAttribute("aria-expanded"), "false");
});

test("opening the drawer is modal: scrim, no page scroll, focus inside", async () => {
  const { window, document } = await loadShell();
  click(window, document.querySelector("[data-sidebar-open]"));

  const sidebar = document.getElementById("app-sidebar");
  assert.equal(sidebar.classList.contains("is-open"), true);
  assert.equal(document.getElementById("sidebar-scrim").classList.contains("is-visible"), true, "the scrim covers the page");
  assert.equal(document.body.classList.contains("drawer-open"), true, "so the page behind cannot scroll");
  assert.equal(document.querySelector("[data-sidebar-open]").getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), null, "and it is exposed to assistive tech while open");
  assert.ok(globalThis.__focused?.closest?.("#app-sidebar"), "focus moves into the drawer, not behind it");
  assert.ok(
    globalThis.__focused === sidebar.querySelector(".sidebar-link.is-active"),
    "specifically to the link for the page they are on"
  );
});

test("Escape, the scrim and the close button all close it", async () => {
  const { window, document } = await loadShell();
  const sidebar = () => document.getElementById("app-sidebar");
  const open = () => click(window, document.querySelector("[data-sidebar-open]"));

  open();
  const escape = new window.Event("keydown", { bubbles: true });
  escape.key = "Escape";
  document.dispatchEvent(escape);
  assert.equal(sidebar().classList.contains("is-open"), false, "Escape closes the drawer");
  assert.equal(document.body.classList.contains("drawer-open"), false, "and unlocks the page");

  open();
  click(window, document.getElementById("sidebar-scrim"));
  assert.equal(sidebar().classList.contains("is-open"), false, "a click outside closes it");

  open();
  click(window, document.querySelector("[data-sidebar-close]"));
  assert.equal(sidebar().classList.contains("is-open"), false, "so does its own close button");
});

test("navigating closes the drawer so the next screen is not behind it", async () => {
  const { window, document } = await loadShell();
  click(window, document.querySelector("[data-sidebar-open]"));
  assert.equal(document.getElementById("app-sidebar").classList.contains("is-open"), true);

  click(window, document.querySelector("#sidebar-nav [data-nav]"));
  assert.equal(document.getElementById("app-sidebar").classList.contains("is-open"), false, "a link click closes it");

  click(window, document.querySelector("[data-sidebar-open]"));
  window.dispatchEvent(new window.CustomEvent("shinzora:view", { detail: { view: "orders" } }));
  assert.equal(document.getElementById("app-sidebar").classList.contains("is-open"), false, "so does a view change");
});

test("signing out from inside the drawer does not strand the page in a modal state", async () => {
  const { window, document } = await loadShell();
  click(window, document.querySelector("[data-sidebar-open]"));
  click(window, document.getElementById("sidebar-signout"));

  assert.equal(document.getElementById("app-sidebar").classList.contains("is-open"), false);
  assert.equal(document.body.classList.contains("drawer-open"), false, "the page is not left unscrollable");
});

test("a stale desktop collapse preference changes nothing", async () => {
  const { document } = await loadShell({ collapsed: "1" });
  assert.equal(document.body.classList.contains("sidebar-collapsed"), false, "the old icon-collapse mode is not restored");
  assert.equal(document.getElementById("app-sidebar").classList.contains("is-open"), false, "and the drawer still starts closed");
});

test("an agent gets their own navigation in the drawer", async () => {
  const { document } = await loadShell({ accountType: "agent" });
  const links = [...document.querySelectorAll("#sidebar-nav [data-nav]")].map((a) => a.dataset.nav);
  assert.ok(links.includes("freelancer"), "the agent front door is there");
  assert.ok(links.includes("portfolio"), "and their portfolio");
  assert.equal(links.includes("orders"), false, "an agent is not shown a shop they do not run");
});
