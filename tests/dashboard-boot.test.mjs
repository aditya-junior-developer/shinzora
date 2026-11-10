/* ==========================================================================
   Dashboard boot — the blank-shell regression
   --------------------------------------------------------------------------
   Reported symptom: opening the freelancer dashboard showed an empty sidebar,
   an empty content area and the static "Your business / Free plan" placeholder
   — no navigation, no message, nothing to click. That is what the entry module
   did when anything in identity resolution rejected: `requireSession()` said
   "not ok", boot returned quietly, and the shell was never painted.

   These tests pin the two halves of the fix:
     1. a session lookup that fails is classified (dead token vs dropped
        connection) and only retried when retrying can help;
     2. a failed boot always paints navigation and a retry panel — never a
        blank frame.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { classifySessionError, withRetry, retrySession, withDeadline } from "../public/js/lib/identity-retry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bootDir = path.join(repo, "public/js");

let counter = 0;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/* --------------------------------------------------------------- harness */

function world() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div class='app-content' id='app-content'><div id='view-root'></div></div></body></html>"
  );
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.location = { pathname: "/app/", search: "", reload: () => (globalThis.__reloaded = true), replace: () => {} };
  globalThis.URLSearchParams = URLSearchParams;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  /* The entry point logs every recoverable failure on purpose; capture it so a
     passing run stays readable. */
  globalThis.__errors = [];
  globalThis.console = { ...console, error: (...args) => globalThis.__errors.push(args) };
  return { window, document };
}

/* Stubs for the modules the entry point orchestrates. Each scenario decides
   what the guard and the store do; shell/router are observed, not exercised. */
async function loadBoot({ gate, identityThrows = false, routerThrows = false }) {
  const calls = [];
  const stubs = {
    guard: `
      export async function requireSession() { return globalThis.__gate; }
      export async function watchSession() {}
      export async function logoutEverywhere() {}
    `,
    store: `
      export const state = { profile: null, identityFailures: [] };
      export function shellIdentity() { return globalThis.__shellIdentity || null; }
      export function applyShellIdentity() {
        if (state.profile) return false;
        if (!globalThis.__shellIdentity) return false;
        state.profile = { id: "u-1", full_name: "Asha Verma", account_type: globalThis.__shellIdentity.accountType };
        return true;
      }
      export async function loadIdentity() {
        if (globalThis.__identityThrows) throw new Error("profiles query was denied");
        return state;
      }
    `,
    shell: `
      export function renderSidebar(view) {
        const nav = document.getElementById("sidebar-nav");
        if (nav) nav.innerHTML = '<a href="/app/?view=freelancer">Dashboard</a><a href="/app/?view=find-team">Find Team</a>';
      }
      export function paintIdentity() {}
      export function bindChrome() {}
      export async function subscribeNotifications() {}
      export async function refreshNotificationBadge() {}
    `,
    router: `
      export const DEFAULT_VIEW = "overview";
      export function landingView() { return "freelancer"; }
      export async function start() {
        if (globalThis.__routerThrows) throw new Error("view failed to import");
        const root = document.getElementById("view-root");
        if (root) root.innerHTML = '<div class="page-title">Welcome back</div>';
      }
      export function currentView() { return "freelancer"; }
    `,
    dom: `
      export const qs = (sel, root) => (root || document).querySelector(sel);
      export const qsa = (sel, root) => [...(root || document).querySelectorAll(sel)];
      export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      export const on = (node, type, fn) => node && node.addEventListener(type, fn);
      export const param = () => null;
      export const delegate = () => {};
      export const debounce = (fn) => fn;
    `,
    icons: `
      export function icon() { return ""; }
      export function hydrateIcons() {}
    `,
    toast: `export function toast() {} export function toastError() {}`,
    pwa: `export function initInstallPrompt() {}`
  };

  const plugin = {
    name: "boot-stubs",
    setup(build) {
      const map = {
        "lib/guard.js$": "guard",
        "lib/store.js$": "store",
        "modules/dashboard/shell.js$": "shell",
        "modules/dashboard/router.js$": "router",
        "lib/dom.js$": "dom",
        "lib/icons.js$": "icons",
        "ui/toast.js$": "toast",
        "ui/pwa.js$": "pwa"
      };
      for (const [filter, name] of Object.entries(map)) {
        build.onResolve({ filter: new RegExp(filter) }, () => ({ path: name, namespace: "stub" }));
      }
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    }
  };

  globalThis.__gate = gate;
  globalThis.__identityThrows = identityThrows;
  globalThis.__routerThrows = routerThrows;
  globalThis.__calls = calls;

  /* The entry module runs on import (it boot()s immediately), so the URL needs
     a unique fragment to get a fresh instance per scenario. */
  const result = await esbuild.build({
    entryPoints: [path.join(bootDir, "boot/dashboard.js")],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [plugin]
  });
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  await import(url);
  await settle();
  return { calls };
}

/* ------------------------------------------------------ classification */

test("a dead refresh token is an auth failure, not a network failure", () => {
  assert.equal(classifySessionError(new Error("Invalid Refresh Token: Refresh Token Not Found")), "auth");
  assert.equal(classifySessionError({ status: 400, message: "invalid_grant" }), "auth");
  assert.equal(classifySessionError({ name: "AuthRetryableFetchError", message: "Failed to fetch" }), "network");
  assert.equal(classifySessionError(new Error("fetch failed")), "network");
  assert.equal(classifySessionError({ status: 503, message: "Service Unavailable" }), "network");
});

test("a dropped connection is retried once and then given up on", async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Failed to fetch");
    return { session: "restored" };
  };
  const result = await retrySession(flaky, { wait: async () => {} });
  assert.deepEqual(result, { session: "restored" });
  assert.equal(attempts, 2, "the transient failure was retried exactly once");
});

test("a dead token is not retried — retrying cannot fix it", async () => {
  let attempts = 0;
  const dead = async () => {
    attempts += 1;
    throw new Error("Invalid Refresh Token: Refresh Token Not Found");
  };
  await assert.rejects(() => retrySession(dead, { wait: async () => {} }), /Invalid Refresh Token/);
  assert.equal(attempts, 1, "an auth failure is not retried");
});

test("withRetry surfaces the last error after exhausting its attempts", async () => {
  let attempts = 0;
  const alwaysDown = async () => {
    attempts += 1;
    throw new Error("offline");
  };
  await assert.rejects(() => withRetry(alwaysDown, { attempts: 3, wait: async () => {} }), /offline/);
  assert.equal(attempts, 3);
});

test("a session lookup that never answers is cut off instead of hanging the page", async () => {
  /* supabase-js retries an expired token with backoff. With the network down
     that promise never settles, which is how the dashboard ended up as a boot
     overlay that never went away. */
  const never = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(() => withDeadline(never, 60, "Checking your session"), /timed out/i);
  assert.ok(Date.now() - started < 2000, "it gives up quickly rather than waiting on the network");
  assert.equal(classifySessionError(Object.assign(new Error("x"), { name: "TimeoutError" })), "network",
    "a timeout is a connection problem, so the user is not signed out for it");
});

/* ------------------------------------------------------- remembered shell */

test("the remembered identity seeds the shell, and never overrides the real one", async () => {
  world();
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  store.set(
    "shinzora.identity.shell",
    JSON.stringify({ userId: "u-1", fullName: "Asha Verma", accountType: "agent", businessName: "" })
  );

  const mod = await import("../public/js/lib/store.js?case=" + ++counter);
  assert.equal(mod.cachedIdentity().accountType, "agent", "the last known account type is available offline");

  assert.equal(mod.applyShellIdentity(), true, "it seeds a provisional profile");
  assert.equal(mod.state.profile.account_type, "agent", "so an agent is not shown the owner navigation");
  assert.equal(mod.state.profile.__provisional, true, "and the copy is marked provisional");

  /* A real profile always wins. */
  mod.state.profile = { id: "u-1", full_name: "Asha Verma", account_type: "owner" };
  assert.equal(mod.applyShellIdentity(), false, "a loaded profile is never replaced by the cache");
  assert.equal(mod.state.profile.account_type, "owner");
});

test("a browser with no remembered identity simply has none", async () => {
  world();
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const mod = await import("../public/js/lib/store.js?case=" + ++counter);
  assert.equal(mod.cachedIdentity(), null);
  assert.equal(mod.applyShellIdentity(), false, "and seeding does nothing rather than inventing a profile");
  assert.equal(mod.state.profile, null);
});

/* --------------------------------------------------------------- boot */

test("a workspace whose identity fails still paints navigation and a retry", async () => {
  world();
  document.body.insertAdjacentHTML("beforeend", '<nav id="sidebar-nav"></nav>');
  await loadBoot({ gate: { ok: true, session: {}, identityError: new Error("profiles query was denied") } });

  const nav = document.getElementById("sidebar-nav");
  assert.ok(nav.querySelectorAll("a").length >= 1, "the sidebar is painted even when identity fails");
  assert.equal(document.querySelectorAll(".boot-warning").length, 1, "the user is told part of their account did not load");
  assert.match(document.querySelector(".boot-warning").textContent, /didn't load/);
  assert.ok(document.querySelector("[data-identity-retry]"), "and given a retry");
  assert.match(document.getElementById("view-root").innerHTML, /Welcome back/, "the view still renders");
});

test("an unreachable server shows a retry panel instead of an empty dashboard", async () => {
  world();
  document.body.insertAdjacentHTML("beforeend", '<nav id="sidebar-nav"></nav>');
  await loadBoot({ gate: { ok: false, reason: "unavailable", error: new Error("Failed to fetch") } });

  const root = document.getElementById("view-root");
  assert.ok(document.querySelector("[data-boot-failure]"), "a failure panel is rendered");
  assert.match(root.textContent, /couldn't load your workspace/i);
  assert.match(root.textContent, /Failed to fetch/, "the real reason is shown, not a generic apology");
  assert.match(root.textContent, /still signed in/, "the user is reassured they were not logged out");
  assert.ok(document.querySelector("[data-boot-retry]"), "there is something to click");
  assert.ok(
    document.getElementById("sidebar-nav").querySelectorAll("a").length >= 1,
    "and the navigation is still usable"
  );
});

test("an agent keeps their own navigation when the server is unreachable", async () => {
  world();
  document.body.insertAdjacentHTML("beforeend", '<nav id="sidebar-nav"></nav>');
  globalThis.__shellIdentity = { userId: "u-1", fullName: "Asha Verma", accountType: "agent", businessName: "" };

  await loadBoot({ gate: { ok: false, reason: "unavailable", error: new Error("Failed to fetch") } });

  assert.equal(globalThis.__shellIdentity.accountType, "agent");
  assert.ok(document.querySelector("[data-boot-failure]"), "the failure is still reported");
  assert.ok(document.getElementById("sidebar-nav").querySelectorAll("a").length >= 1, "and navigation is painted");
  globalThis.__shellIdentity = null;
});

test("a signed-out visitor is left alone — no panel, no shell work", async () => {
  world();
  document.body.insertAdjacentHTML("beforeend", '<nav id="sidebar-nav"></nav>');
  await loadBoot({ gate: { ok: false, reason: "signed_out" } });

  assert.equal(document.querySelector("[data-boot-failure]"), null, "the guard owns this case (it redirected)");
  assert.equal(document.getElementById("sidebar-nav").innerHTML, "", "and boot does not paint over it");
});

test("a view that fails to import becomes a retry panel, not a blank page", async () => {
  world();
  document.body.insertAdjacentHTML("beforeend", '<nav id="sidebar-nav"></nav>');
  await loadBoot({ gate: { ok: true, session: {} }, routerThrows: true });

  assert.ok(document.querySelector("[data-boot-failure]"), "the router failure is reported");
  assert.match(document.getElementById("view-root").textContent, /view failed to import/);
  assert.ok(document.getElementById("sidebar-nav").querySelectorAll("a").length >= 1, "navigation survives");
});
