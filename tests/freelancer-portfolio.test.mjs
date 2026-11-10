/* ==========================================================================
   Freelancer dashboard, Portfolio editor, and account-aware navigation
   --------------------------------------------------------------------------
   Phase 4. Three things are asserted here:

     1. an agent account gets its own front door and its own sidebar, while an
        owner's navigation is untouched
     2. the freelancer dashboard derives every number from rows, and the
        "finish your profile" list disappears once there is nothing to do
     3. the portfolio editor writes through the right RPC with the right
        arguments — including the two-call split between the existing
        marketplace_save_agent and the extended agent_save_portfolio_profile

   The modules run in linkedom against stubbed Supabase and toast modules.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const viewsDir = path.join(repo, "public/js/modules/dashboard/views");

let bundleCounter = 0;

/* --------------------------------------------------------------- fixtures */

const AGENT_PROFILE = {
  user_id: "agent-1",
  headline: "Product designer",
  bio: "I build calm interfaces.",
  skills: ["figma", "web design", "react"],
  expected_rate: 1200,
  expected_currency: "INR",
  currency: "INR",
  availability: "available",
  years_experience: 5,
  hours_per_week: 20,
  notice_period_days: 15,
  location: "New Delhi",
  remote_ok: true,
  equity_ok: true,
  equity_min_pct: 1,
  equity_max_pct: 3,
  esop_ok: true,
  seeking: "Long-term product work.",
  is_published: true,
  resume_url: "https://example.com/cv.pdf",
  portfolio_url: null,
  social_links: { linkedin: "https://linkedin.com/in/asha" },
  languages: ["English", "Hindi"],
  timezone: "Asia/Kolkata",
  experience: [
    { role: "Senior designer", company: "Roast Co", from: "2021", to: "2024", summary: "Ran the design system." }
  ]
};

const WORKSPACE = {
  accountType: "agent",
  username: "asha",
  profile: AGENT_PROFILE,
  myJobs: [],
  myProposals: [
    { proposalId: "p1", jobId: "job-1", jobTitle: "Bakery site", status: "submitted", bidAmount: 25000, currency: "INR", createdAt: new Date().toISOString() },
    { proposalId: "p2", jobId: "job-2", jobTitle: "Logo", status: "rejected", bidAmount: 8000, currency: "INR", createdAt: new Date().toISOString() }
  ],
  contracts: [
    { contractId: "c1", jobId: "job-3", jobTitle: "Landing page", status: "active", counterparty: "Klyro", role: "agent" },
    { contractId: "c2", jobId: "job-4", jobTitle: "Old site", status: "completed", counterparty: "Roast", role: "agent" }
  ]
};

const BOARD = [
  { jobId: "job-1", title: "Bakery website", businessName: "Klyro", budgetMin: 20000, budgetMax: 40000, currency: "INR", skills: ["web design"], createdAt: new Date().toISOString() },
  { jobId: "job-2", title: "Logo refresh", businessName: "Roast", budgetMin: 5000, budgetMax: 8000, currency: "INR", skills: ["branding"], createdAt: new Date().toISOString() }
];

const PORTFOLIO_ITEMS = [
  { id: "pi-1", title: "Bakery site", summary: "Six pages", url: "https://x.example.com", skills: ["web design"], completed_on: "2024-03-01", sort_order: 0 }
];

/* -------------------------------------------------------------- harness */

async function bundle(entry) {
  const stub = {
    name: "phase4-stubs",
    setup(build) {
      const supabaseStub = `
        export const sb = {
          rpc: async (name, args) => ({ data: await globalThis.__rpc(name, args), error: null }),
          from: (table) => {
            const api = {
              select: () => api,
              eq: () => api,
              order: () => api,
              then: (resolve) => resolve({ data: globalThis.__table(table), error: null })
            };
            return api;
          }
        };
        export const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error?.message || error)));
      `;
      const toastStub = `
        export const toast = (payload) =>
          globalThis.__toast(
            typeof payload === "string" ? payload : [payload?.title, payload?.message].filter(Boolean).join(" "),
            "ok"
          );
        export const toastError = (error) => globalThis.__toast(String(error?.message || error), "error");
      `;
      const storeStub = `
        export const state = globalThis.__state;
      `;
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onResolve({ filter: /ui\/toast\.js$/ }, () => ({ path: "toast", namespace: "stub" }));
      build.onResolve({ filter: /lib\/store\.js$/ }, () => ({ path: "store", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents: args.path === "supabase" ? supabaseStub : args.path === "store" ? storeStub : toastStub,
        loader: "js"
      }));
    }
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [stub]
  });
  const code = result.outputFiles[0].text;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64") + "#" + ++bundleCounter;
  return import(url);
}

/** linkedom's FormData cannot read a form element, so build one manually. */
class FormDataShim {
  constructor(form) {
    this.map = new Map();
    for (const field of form.querySelectorAll("input, textarea, select")) {
      if (!field.name) continue;
      if (field.type === "checkbox") {
        if (field.checked) this.map.set(field.name, field.value || "on");
        continue;
      }
      if (field.tagName === "SELECT") {
        const chosen = [...field.querySelectorAll("option")].find((option) => option.selected) ||
          field.querySelectorAll("option")[0];
        this.map.set(field.name, chosen ? chosen.getAttribute("value") : "");
        continue;
      }
      this.map.set(field.name, field.value ?? "");
    }
  }
  get(name) {
    return this.map.has(name) ? this.map.get(name) : null;
  }
}

function makeWorld({ accountType = "agent", profile = AGENT_PROFILE, workspace = WORKSPACE, props = {} } = {}) {
  const { window, document } = parseHTML("<!doctype html><html><body><div id='view-root'></div></body></html>");
  const calls = [];
  const toasts = [];

  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.FormData = FormDataShim;
  globalThis.confirm = () => true;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.__toast = (message, kind) => toasts.push({ message, kind });
  globalThis.__state = {
    user: { id: "agent-1" },
    profile: { id: "agent-1", full_name: "Asha", account_type: accountType, avatar_url: null },
    business: null
  };

  const answers = {
    marketplace_my_workspace: { ...workspace, profile: { ...profile, ...props.profilePatch } },
    marketplace_browse_jobs: props.board ?? BOARD,
    team_my_invitations: props.invitations ?? [],
    marketplace_save_agent: { userId: "agent-1", isPublished: true },
    agent_save_portfolio_profile: { ok: true },
    portfolio_item_save: { itemId: "pi-new", title: "New thing" },
    portfolio_item_delete: { ok: true }
  };
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? null;
  };
  globalThis.__table = (table) => (table === "freelancer_portfolio_items" ? props.items ?? PORTFOLIO_ITEMS : []);

  const root = document.getElementById("view-root");
  return { window, document, root, calls, toasts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const count = (calls, name) => calls.filter((call) => call.name === name).length;
const lastArgs = (calls, name) => calls.filter((call) => call.name === name).at(-1)?.args;
const click = (window, node) => node.dispatchEvent(new window.Event("click", { bubbles: true }));

/* ---------------------------------------------------------------- tests */

test("an agent lands on the freelancer dashboard and sees its own numbers", async () => {
  const { root } = makeWorld();
  const view = await bundle(path.join(viewsDir, "freelancer.js"));
  await view.default(root);

  assert.match(root.textContent, /Welcome back, Asha/, "the page greets the agent");
  assert.match(root.textContent, /@asha/, "their handle is shown");
  assert.match(root.textContent, /Open projects[\s\S]*2/, "open projects counted from the board");
  assert.match(root.textContent, /Pitches sent[\s\S]*1/, "only submitted pitches count as 'sent'");
  assert.match(root.textContent, /Active contracts[\s\S]*1/, "active contracts counted");
  assert.match(root.textContent, /Invitations[\s\S]*0/, "zero invitations is stated, not blank");
});

test("the dashboard is built from calls that actually ran", async () => {
  const { root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "freelancer.js"));
  await view.default(root);

  assert.equal(count(calls, "marketplace_my_workspace"), 1);
  assert.equal(count(calls, "marketplace_browse_jobs"), 1);
  assert.equal(count(calls, "team_my_invitations"), 1);
});

test("a complete profile shows no 'finish your profile' nag", async () => {
  const { root } = makeWorld({ props: { items: PORTFOLIO_ITEMS } });
  const view = await bundle(path.join(viewsDir, "freelancer.js"));
  await view.default(root);

  assert.ok(!/Finish your profile/.test(root.textContent), "nothing left to do, so no list");
});

test("an incomplete profile lists what is missing, and nothing that is done", async () => {
  const sparse = {
    is_published: false,
    headline: "",
    skills: [],
    expected_rate: null,
    experience: [],
    social_links: {},
    languages: []
  };
  const { root } = makeWorld({
    profile: sparse,
    workspace: { ...WORKSPACE, profile: sparse },
    props: { items: [] }
  });
  const view = await bundle(path.join(viewsDir, "freelancer.js"));
  await view.default(root);

  assert.match(root.textContent, /Finish your profile/, "the list appears");
  assert.match(root.textContent, /Publish your profile/, "publishing is the first blocker");
  assert.match(root.textContent, /Set expected pay/, "pay is called out");
  assert.match(root.textContent, /Add a headline/, "headline is called out");
  /* Skills are present in the sparse fixture only if they are done; they are
     not, so the item must appear — but a done item must never appear. */
  assert.ok(!/Add at least three skills/.test(root.textContent) === false, "missing skills listed");
});

test("the dashboard tolerates a failed board without losing the page", async () => {
  const { root } = makeWorld({ props: { board: [] } });
  const view = await bundle(path.join(viewsDir, "freelancer.js"));
  await view.default(root);

  assert.match(root.textContent, /No open projects yet/, "empty board is explained");
  assert.match(root.textContent, /Welcome back/, "the rest of the page still renders");
});

test("the portfolio editor loads the profile and the portfolio items", async () => {
  const { root } = makeWorld();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  assert.equal(root.querySelector('[name="headline"]').value, "Product designer", "headline prefilled");
  assert.equal(root.querySelector('[name="skills"]').value, "figma, web design, react", "skills comma-joined");
  assert.equal(root.querySelector('[name="resume_url"]').value, "https://example.com/cv.pdf", "CV link prefilled");
  assert.match(root.textContent, /Senior designer/, "work history listed");
  assert.match(root.textContent, /Bakery site/, "portfolio items listed");
  assert.match(root.textContent, /Published/, "a published profile says so");
});

test("saving the basics calls the existing profile writer with parsed values", async () => {
  const { root, calls, window } = makeWorld();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  const form = root.querySelector("#pf-basics");
  form.querySelector('[name="headline"]').value = "Design lead";
  form.querySelector('[name="skills"]').value = "figma, strategy";
  form.querySelector('[name="expected_rate"]').value = "1800";
  form.dispatchEvent(new window.Event("submit", { bubbles: true }));
  await settle();

  assert.equal(count(calls, "marketplace_save_agent"), 1, "one save");
  const args = lastArgs(calls, "marketplace_save_agent");
  assert.equal(args.p_headline, "Design lead");
  assert.deepEqual(args.p_skills, ["figma", "strategy"], "comma string split into an array");
  assert.equal(args.p_expected_rate, 1800, "numeric, not a string");
  assert.equal(args.p_publish, true, "publish flag preserved");
  assert.equal(args.p_equity_ok, true, "equity checkbox preserved");
});

test("saving links calls the extended writer, keeping experience intact", async () => {
  const { root, calls, window } = makeWorld();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  const form = root.querySelector("#pf-links");
  form.querySelector('[name="resume_url"]').value = "https://example.com/cv2.pdf";
  form.querySelector('[name="social_github"]').value = "https://github.com/asha";
  form.querySelector('[name="languages"]').value = "English, Hindi, Marathi";
  form.dispatchEvent(new window.Event("submit", { bubbles: true }));
  await settle();

  assert.equal(count(calls, "agent_save_portfolio_profile"), 1);
  const args = lastArgs(calls, "agent_save_portfolio_profile");
  assert.equal(args.p_resume_url, "https://example.com/cv2.pdf");
  assert.equal(args.p_social_links.github, "https://github.com/asha", "new social link included");
  assert.deepEqual(args.p_languages, ["English", "Hindi", "Marathi"], "languages split");
  assert.equal(args.p_experience.length, 1, "existing experience is not wiped by a links save");
  assert.equal(args.p_experience[0].role, "Senior designer");
});

test("adding a role appends to history through the same writer", async () => {
  const { root, calls, window } = await (async () => makeWorld())();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  const form = root.querySelector("#pf-exp-form");
  form.querySelector('[name="role"]').value = "Design intern";
  form.querySelector('[name="company"]').value = "Tiny Co";
  form.querySelector('[name="from"]').value = "2019";
  form.querySelector('[name="to"]').value = "2020";
  form.dispatchEvent(new window.Event("submit", { bubbles: true }));
  await settle();

  const args = lastArgs(calls, "agent_save_portfolio_profile");
  assert.equal(args.p_experience.length, 2, "the new role is appended, not replacing");
  assert.equal(args.p_experience[1].role, "Design intern");
  assert.match(root.textContent, /Design intern/, "and it renders immediately");
});

test("adding and removing portfolio items are separate RPCs", async () => {
  const { root, calls, window } = makeWorld();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  const form = root.querySelector("#pf-item-form");
  form.querySelector('[name="title"]').value = "Coffee brand site";
  form.querySelector('[name="url"]').value = "https://coffee.example.com";
  form.querySelector('[name="skills"]').value = "web design, copy";
  form.dispatchEvent(new window.Event("submit", { bubbles: true }));
  await settle();

  assert.equal(count(calls, "portfolio_item_save"), 1);
  const saved = lastArgs(calls, "portfolio_item_save");
  assert.equal(saved.p_id, null, "a new item has no id");
  assert.equal(saved.p_title, "Coffee brand site");
  assert.deepEqual(saved.p_skills, ["web design", "copy"]);
  assert.equal(saved.p_sort_order, 1, "sorted after the existing item");

  click(window, root.querySelector("[data-item-remove]"));
  await settle();
  assert.equal(count(calls, "portfolio_item_delete"), 1);
  assert.deepEqual(lastArgs(calls, "portfolio_item_delete"), { p_id: "pi-1" });
});

test("removing a role saves the shrunken list", async () => {
  const { root, calls, window } = makeWorld();
  const view = await bundle(path.join(viewsDir, "portfolio.js"));
  await view.default(root);
  await settle();

  click(window, root.querySelector("[data-exp-remove]"));
  await settle();

  const args = lastArgs(calls, "agent_save_portfolio_profile");
  assert.deepEqual(args.p_experience, [], "the removed role is gone");
  assert.ok(!/Senior designer[\s\S]*Roast Co/.test(root.textContent.split("Work history")[1]?.split("Portfolio")[0] || ""),
    "and it no longer renders in the history section");
});

/* -------------------------------------------------- navigation + wiring */

test("the sidebar differs by account type and both are registered", async () => {
  const shell = await readFile(path.join(repo, "public/js/modules/dashboard/shell.js"), "utf8");
  assert.match(shell, /export const AGENT_NAV/, "agents have their own navigation");
  assert.match(shell, /navFor = \(\) =>/, "navigation is chosen at render time");
  assert.match(shell, /navFor\(\)\.map/, "the sidebar uses it");
  assert.match(shell, /navFor\(\)\.flatMap/, "so does the command palette");

  for (const view of ["freelancer", "portfolio"]) {
    assert.ok(shell.includes(`id: "${view}"`), `${view} appears in the agent sidebar`);
  }
  /* The owner nav must keep its own identity rather than becoming the agent one. */
  assert.match(shell, /export const NAV = \[/);
  assert.ok(shell.includes('{ id: "overview", label: "Overview"'), "owners still land on Overview");
});

test("the router sends an agent to the dashboard but an owner to overview", async () => {
  const router = await readFile(path.join(repo, "public/js/modules/dashboard/router.js"), "utf8");
  assert.match(router, /export function landingView/);
  assert.match(router, /account_type === "agent" \? "freelancer"/);
  assert.match(router, /freelancer: \(\) => import/);
  assert.match(router, /portfolio: \(\) => import/);
  assert.match(router, /return \{ view: LOADERS\[view\] \? view : landingView\(\), params \}/,
    "an unknown or absent view falls back to the account's landing");
});

test("the marketplace still honours an explicit tab param", async () => {
  const source = await readFile(path.join(viewsDir, "marketplace.js"), "utf8");
  assert.match(source, /params\?\.get\?\.\("tab"\)/, "the tab comes from the URL");
  assert.match(source, /TABS\.some\(\(entry\) => entry\.id === requested\)/, "an unknown tab is ignored");
  assert.match(source, /if \(!tab\) tab = isAgent\(\) \? "browse" : "hire"/, "the account default survives");
});

test("every icon the phase-4 views ask for exists", async () => {
  const { iconNames } = await import("../public/js/lib/icons.js");
  const available = new Set(iconNames);
  const missing = [];
  for (const file of ["freelancer.js", "portfolio.js"]) {
    const source = await readFile(path.join(viewsDir, file), "utf8");
    for (const match of source.matchAll(/icon\(\s*"([a-z0-9-]+)"/g)) {
      if (!available.has(match[1])) missing.push(`${file}:${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `unknown icons render as a question mark: ${missing.join(", ")}`);
});

test("0027 scopes every write to the caller", async () => {
  const sql = await readFile(path.join(repo, "supabase/migrations/0027_portfolio_and_resume_rpc.sql"), "utf8");
  assert.match(sql, /where id = p_id and user_id = actor/, "portfolio update is owner-scoped");
  assert.match(sql, /delete from public\.freelancer_portfolio_items where id = p_id and user_id = actor/,
    "portfolio delete is owner-scoped");
  assert.match(sql, /key in \('linkedin','github'/, "unknown social keys are dropped, not stored");
  assert.ok(!/grant execute on function public\.notify_user/.test(sql));
});
