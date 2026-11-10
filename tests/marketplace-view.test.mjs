/* ==========================================================================
   Marketplace view — render and interaction smoke test
   --------------------------------------------------------------------------
   The RPC layer is covered by tests/marketplace-db.test.mjs against a real
   Postgres. This suite covers the other half: the browser module. It bundles
   views/marketplace.js with esbuild, swapping the Supabase and toast modules
   for stubs, then drives it in a linkedom document.

   The failures this is designed to catch are the quiet ones that no type
   checker sees:
     · delegate() called with its selector and event name swapped, so clicks
       never reach a handler
     · listeners stacking on a node that paint() reuses, so one click runs
       the RPC twice
     · a reused dialog node keeping the previous form's submit handler
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

let bundleCounter = 0;

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const viewPath = path.join(repo, "public/js/modules/dashboard/views/marketplace.js");

/* --------------------------------------------------------------- fixtures */
const WORKSPACE = {
  accountType: "owner",
  username: "aditya",
  profile: {
    user_id: "me",
    headline: "Full-stack designer",
    bio: "I build small business sites.",
    skills: ["web design"],
    hourly_rate: 1500,
    currency: "INR",
    availability: "available",
    portfolio_url: null,
    years_experience: 4,
    is_published: true
  },
  myJobs: [
    {
      jobId: "job-mine",
      title: "Bakery website",
      status: "open",
      currency: "INR",
      budgetMin: 20000,
      budgetMax: 40000,
      createdAt: new Date().toISOString(),
      requirements: "Six pages and a case-study CMS.",
      questions: [
        { questionId: "jq-1", prompt: "Link the last site you shipped" },
        { questionId: "jq-2", prompt: "How would you approach the CMS?" }
      ],
      proposals: [
        {
          proposalId: "prop-1",
          freelancerId: "freelancer",
          name: "Asha",
          coverNote: "I have built three bakery sites.",
          bidAmount: 25000,
          currency: "INR",
          deliveryDays: 14,
          status: "submitted",
          ratingAvg: 4.5,
          completedContracts: 3,
          skills: ["web design"],
          answers: { "jq-1": "https://asha.example.com/bakery" }
        }
      ]
    }
  ],
  myProposals: [
    {
      proposalId: "prop-mine",
      jobId: "job-open",
      jobTitle: "Landing page",
      jobStatus: "open",
      coverNote: "Available next week.",
      bidAmount: 18000,
      currency: "INR",
      deliveryDays: 7,
      status: "submitted",
      createdAt: new Date().toISOString()
    }
  ],
  contracts: [
    {
      contractId: "contract-1",
      jobId: "job-mine",
      jobTitle: "Logo refresh",
      amount: 12000,
      currency: "INR",
      status: "completed",
      role: "client",
      counterparty: "Asha",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      canReview: true
    }
  ]
};

const BUSINESSES = [
  {
    businessId: "biz-1",
    name: "Klyro",
    category: "Finance",
    description: "A B2B agency building sites.",
    location: "New Delhi",
    websiteUrl: "https://klyro.example.com",
    ownerName: "Aditya",
    ownerUsername: "aditya",
    openProjects: 2
  }
];

const BOARD = [
  {
    jobId: "job-open",
    title: "Landing page for a coffee brand",
    description: "One page, photography-led, needs copy too. ".repeat(4),
    skills: ["web design", "copywriting"],
    budgetMin: 15000,
    budgetMax: 30000,
    currency: "INR",
    deliveryDays: 10,
    status: "open",
    createdAt: new Date().toISOString(),
    ownerId: "someone-else",
    businessName: "Roast Co",
    proposals: 1,
    mine: false,
    requirements: "Six pages, a CMS for case studies, and analytics.",
    questions: [
      { questionId: "q-1", prompt: "Link the last site you shipped" },
      { questionId: "q-2", prompt: "How would you approach the CMS?" }
    ],
    myProposal: null
  }
];

const PEOPLE = [
  {
    userId: "freelancer",
    name: "Asha",
    headline: "Designer for local businesses",
    bio: "",
    skills: ["web design"],
    hourlyRate: 1200,
    currency: "INR",
    availability: "available",
    portfolioUrl: "https://example.com",
    yearsExperience: 5,
    ratingAvg: 4.5,
    ratingCount: 2,
    completedContracts: 3
  }
];

/* -------------------------------------------------------------- harness */

/** Minimal FormData: linkedom's does not accept a form element. */
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

async function bundleView(calls, toasts) {
  const stub = {
    name: "marketplace-view-stubs",
    setup(build) {
      const supabaseStub = `
        export const sb = {
          rpc: async (name, args) => ({ data: await globalThis.__rpc(name, args), error: null })
        };
        export const normalizeError = (error) => error instanceof Error ? error : new Error(String(error?.message || error));
      `;
      const toastStub = `
        export const toast = (message) => globalThis.__toast(message, "ok");
        export const toastError = (error) => globalThis.__toast(String(error?.message || error), "error");
      `;
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onResolve({ filter: /ui\/toast\.js$/ }, () => ({ path: "toast", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents: args.path === "supabase" ? supabaseStub : toastStub,
        loader: "js"
      }));
    }
  };

  const result = await esbuild.build({
    entryPoints: [viewPath],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [stub]
  });
  const code = result.outputFiles[0].text;
  /* A unique fragment gives each test its own module instance: the view keeps
     the active tab in module scope, and a shared instance would leak one
     test's tab into the next. */
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64") +
    "#" + (++bundleCounter);
  return import(url);
}

/**
 * Fresh world: one linkedom document, one module instance, RPC stub that
 * answers each marketplace_* call from the fixtures and records every call.
 */
async function world() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='view-root'></div></body></html>"
  );
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

  /* Record the call, then answer it with the matching fixture. */
  const answers = {
    marketplace_my_workspace: WORKSPACE,
    marketplace_browse_jobs: BOARD,
    marketplace_list_freelancers: PEOPLE,
    marketplace_list_businesses: BUSINESSES,
    marketplace_find_user: {
      userId: "freelancer", username: "asha", name: "Asha",
      accountType: "agent", headline: "Designer for local businesses",
      skills: ["web design"], isPublished: true, isSelf: false
    }
  };
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? null;
  };

  const view = await bundleView(calls, toasts);
  const root = document.getElementById("view-root");
  return { window, document, root, calls, toasts, view };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const answersFor = (name) =>
  ({ marketplace_browse_jobs: BOARD, marketplace_list_freelancers: PEOPLE, marketplace_list_businesses: BUSINESSES })[name] ?? null;
const count = (calls, name) => calls.filter((call) => call.name === name).length;

/* ---------------------------------------------------------------- tests */

test("marketplace view renders the board from the RPC payload", async () => {
  const { root, view } = await world();
  await view.default(root);

  assert.match(root.textContent, /Marketplace/, "page heading renders");
  root.querySelector('[data-mk-tab="browse"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(root.querySelectorAll("[data-mk-tab]").length, 5, "five tabs");
  assert.match(root.textContent, /@aditya/, "the handle is shown in the header");

  assert.equal(root.querySelectorAll(".mk-job-card").length, 1, "each open project renders as a card");
  assert.match(root.textContent, /Landing page for a coffee brand/);

  /* The agent directory lives on the Businesses tab, next to the businesses. */
  root.querySelector('[data-mk-tab="businesses"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(root.textContent, /Asha/, "agents are listed");
  root.querySelector('[data-mk-tab="browse"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(root.textContent, /Landing page for a coffee brand/);

  /* Amounts are major units: ₹15,000 must not be printed as ₹150. */
  assert.match(root.textContent, /15,000/, "budget formatted in major units");
  assert.ok(!/₹150\b/.test(root.textContent), "no 100x understatement");
});

test("an owner lands on their projects; a tab click reaches its handler", async () => {
  const { root, view } = await world();
  await view.default(root);

  /* The tab an account type opens on is the whole point of the fork. */
  assert.equal(root.querySelector(".mk-tab.is-active").dataset.mkTab, "hire", "an owner opens on My projects");
  assert.ok(root.querySelector("[data-mk-form='job']"), "the project form is rendered");

  root.querySelector('[data-mk-tab="browse"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(root.querySelector(".mk-tab.is-active").dataset.mkTab, "browse");
  assert.ok(root.querySelectorAll(".mk-card").length > 0, "the board renders");
});

test("an agent lands on the project board instead", async () => {
  const { root, document } = await world();
  globalThis.__rpc = (name, args) => {
    if (name === "marketplace_my_workspace") return { ...WORKSPACE, accountType: "agent", myJobs: [] };
    return answersFor(name);
  };
  const agentView = await bundleView([], []);
  const agentRoot = document.createElement("div");
  document.body.append(agentRoot);
  await agentView.default(agentRoot);

  assert.equal(agentRoot.querySelector(".mk-tab.is-active").dataset.mkTab, "browse", "an agent opens on Projects");
  assert.ok(agentRoot.querySelector("[data-mk-pitch]"), "a pitch button is offered");
});

test("root-level delegates do not stack across repaints", async () => {
  const { root, view, calls } = await world();
  await view.default(root);

  /* Two repaints via tab clicks, then one refresh click. */
  for (const id of ["hire", "browse"]) {
    root.querySelector(`[data-mk-tab="${id}"]`)
      .dispatchEvent(new window.Event("click", { bubbles: true }));
  }
  const before = count(calls, "marketplace_browse_jobs");

  const refresh = root.querySelector("[data-mk='refresh']");
  refresh.dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();

  assert.equal(
    count(calls, "marketplace_browse_jobs") - before, 1,
    "one refresh click reloads the board exactly once"
  );
});

test("posting a project calls create_project once with its requirements and questions", async () => {
  const { root, view, calls } = await world();
  await view.default(root);

  root.querySelector('[data-mk-tab="hire"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  root.querySelector('[data-mk-tab="hire"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  const form = root.querySelector("[data-mk-form='job']");
  form.querySelector("[name='title']").value = "Bakery site";
  form.querySelector("[name='description']").value = "A four page site with a menu and a contact form.";
  form.querySelector("[name='requirements']").value = "Four pages, a menu, and a contact form that emails the shop.";
  form.querySelector("[name='skills']").value = " web design , copywriting , ";
  form.querySelector("[name='budgetMin']").value = "20000";
  form.querySelector("[name='budgetMax']").value = "40000";
  form.querySelector("[name='deliveryDays']").value = "14";
  form.querySelector("[name='theme']").value = "Editorial";
  form.querySelector("[name='questions']").value = "Link the last site you shipped\nHow would you approach the CMS?\n\n";

  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  const creates = calls.filter((call) => call.name === "marketplace_create_project");
  assert.equal(creates.length, 1, "submitted exactly once");
  const args = creates[0].args;
  assert.equal(args.p_title, "Bakery site");
  assert.deepEqual(args.p_skills, ["web design", "copywriting"], "skills trimmed and dropped empty");
  assert.equal(args.p_budget_min, 20000);
  assert.equal(args.p_delivery_days, 14);
  assert.equal(args.p_currency, "INR");
  assert.equal(args.p_theme, "Editorial");
  assert.deepEqual(args.p_questions, ["Link the last site you shipped", "How would you approach the CMS?"], "questions split on lines, blanks dropped");
  assert.ok(args.p_requirements.startsWith("Four pages"), "requirements are sent");
});

test("a pitch dialog asks the client's questions and sends one pitch", async () => {
  const { root, view, calls } = await world();
  await view.default(root);
  root.querySelector('[data-mk-tab="browse"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  const open = () => root.querySelector("[data-mk-pitch='job-open']")
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  open();
  const firstForm = root.querySelector("[data-mk-pitch-form]");
  assert.ok(firstForm, "dialog opened");
  assert.ok(firstForm.querySelector("[name='q_q-1']"), "the client's first question is on the form");
  assert.ok(firstForm.querySelector("[name='q_q-2']"), "and the second");

  /* Cancel, reopen, then submit the second dialog. */
  firstForm.querySelector("[data-mk-close-dialog]")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(root.querySelector("[data-mk-pitch-form]"), null, "dialog closed cleanly");

  open();
  const form = root.querySelector("[data-mk-pitch-form]");
  form.querySelector("[name='coverNote']").value = "I can start Monday.";
  form.querySelector("[name='bidAmount']").value = "18000";
  form.querySelector("[name='deliveryDays']").value = "7";
  form.querySelector("[name='q_q-1']").value = "https://example.com/work";
  form.querySelector("[name='q_q-2']").value = "Sanity-backed case studies.";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  const sends = calls.filter((call) => call.name === "marketplace_pitch");
  assert.equal(sends.length, 1, "one submit, one RPC call");
  assert.equal(sends[0].args.p_job, "job-open");
  assert.equal(sends[0].args.p_bid_amount, 18000);
  assert.deepEqual(
    sends[0].args.p_answers,
    { "q-1": "https://example.com/work", "q-2": "Sanity-backed case studies." },
    "answers are keyed by question id, which is what the database expects"
  );
  assert.equal(root.querySelector("[data-mk-pitch-form]"), null, "dialog dismissed after send");
});

test("a client can find somebody by handle", async () => {
  const { root, view, calls } = await world();
  await view.default(root);
  root.querySelector('[data-mk-tab="businesses"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  const form = root.querySelector("[data-mk-form='find']");
  form.querySelector("[name='username']").value = "@asha";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  const searches = calls.filter((call) => call.name === "marketplace_find_user");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].args.p_username, "asha", "the @ is stripped before searching");
});

test("the businesses tab lists businesses an agent can approach", async () => {
  const { root, view } = await world();
  await view.default(root);
  root.querySelector('[data-mk-tab="businesses"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(root.textContent, /Klyro/);
  assert.match(root.textContent, /@aditya/);
});

test("accepting a proposal asks for confirmation first", async () => {
  const { root, view, calls, window } = await world();
  await view.default(root);
  root.querySelector('[data-mk-tab="hire"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  /* Declining the confirm() prompt must not reach the database. */
  globalThis.confirm = () => false;
  root.querySelector("[data-mk-accept='prop-1']")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(count(calls, "marketplace_accept_proposal"), 0, "declined prompt sends nothing");

  globalThis.confirm = () => true;
  root.querySelector("[data-mk-accept='prop-1']")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(count(calls, "marketplace_accept_proposal"), 1, "accepted prompt sends one RPC");
  assert.equal(root.querySelectorAll(".mk-dialog").length, 0, "no dialog left open");
});

test("completed contracts offer a review that posts once", async () => {
  const { root, view, calls } = await world();
  await view.default(root);

  root.querySelector('[data-mk-tab="work"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  root.querySelector("[data-mk-review='contract-1']")
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  const form = root.querySelector("[data-mk-review-form]");
  assert.ok(form, "review dialog opened");
  form.querySelector("[name='comment']").value = "Great work.";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  const reviews = calls.filter((call) => call.name === "marketplace_submit_review");
  assert.equal(reviews.length, 1, "one review RPC");
  assert.equal(reviews[0].args.p_contract, "contract-1");
  assert.equal(reviews[0].args.p_rating, 5);
});

test("the client sees each pitch with its answers paired to the questions", async () => {
  const { root, view } = await world();
  await view.default(root);
  root.querySelector('[data-mk-tab="hire"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));

  /* Give the fixture pitch answers for the questions its project asked. */
  assert.match(root.textContent, /Link the last site you shipped/, "the question is shown");
  assert.match(root.textContent, /asha\.example\.com\/bakery/, "the answer sits under it");
  assert.match(root.textContent, /— no answer —/, "an unanswered question is called out rather than hidden");
});

test("an empty board shows the empty state, not a blank panel", async () => {
  const { document, calls } = await world();
  /* No fixtures: a brand-new account has no jobs, no proposals, no profile. */
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    if (name === "marketplace_my_workspace") {
      return { profile: null, myJobs: [], myProposals: [], contracts: [] };
    }
    return [];
  };
  const emptyView = await bundleView(calls, []);
  const emptyRoot = document.createElement("div");
  document.body.append(emptyRoot);

  await emptyView.default(emptyRoot);
  assert.match(emptyRoot.textContent, /Nothing posted yet/, "empty projects explained");
  emptyRoot.querySelector('[data-mk-tab="browse"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(emptyRoot.textContent, /No open projects yet/, "empty board explained");
  assert.ok(!emptyRoot.querySelector(".mk-card"), "no phantom cards");

  emptyRoot.querySelector('[data-mk-tab="work"]')
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.match(emptyRoot.textContent, /No pitches yet/, "empty pitches explained");
  assert.match(emptyRoot.textContent, /No contracts yet/, "empty contracts explained");
});

test("every icon the view asks for exists", async () => {
  const { iconNames } = await import("../public/js/lib/icons.js");
  const available = new Set(iconNames);
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(viewPath, "utf8");
  const used = new Set(
    [...source.matchAll(/icon\(\s*"([a-z0-9-]+)"/g)].map((match) => match[1])
      .concat([...source.matchAll(/icon(?:Name)?:\s*"([a-z0-9-]+)"/g)].map((match) => match[1]))
  );
  const missing = [...used].filter((name) => !available.has(name));
  assert.deepEqual(missing, [], `unknown icons fall back to a question mark: ${missing.join(", ")}`);
});
