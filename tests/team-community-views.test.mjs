/* ==========================================================================
   Team, invitations, Find Team and Community — view smoke tests
   --------------------------------------------------------------------------
   These four screens are the phase-3 additions. The database half is exercised
   by the migration checks at the bottom of this file plus the staging run; what
   is covered here is the part that broke last time — the wiring between a
   button and the RPC behind it.

   The specific bug this suite exists to prevent: `team_my_invitations` and
   `team_accept_invite` shipped in 0018 and were never called from the client,
   so invitations were created and silently stranded. Test 1 fails if that ever
   happens again.

   The modules are bundled with esbuild against stubbed Supabase and toast
   modules, then driven in linkedom.
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

const INVITATIONS = [
  {
    inviteId: "inv-1",
    businessId: "biz-1",
    businessName: "Klyro",
    businessLogo: null,
    email: "mangkun150@gmail.com",
    memberType: "freelancer",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    inviterName: "Aditya"
  }
];

const BUSINESSES = [{ id: "biz-1", name: "Klyro", category: "Finance", role: "owner" }];

const MEMBERS = [
  { userId: "owner-1", fullName: "Aditya", username: "aditya", memberType: "owner", isOwner: true, joinedAt: new Date().toISOString() },
  { userId: "agent-1", fullName: "Asha", username: "asha", memberType: "agent", isOwner: false, joinedAt: new Date().toISOString() }
];

const PENDING = [
  {
    inviteId: "inv-9",
    email: "newperson@example.com",
    memberType: "agent",
    createdAt: new Date().toISOString(),
    userExists: false,
    fullName: null,
    username: null
  }
];

const SEARCH_HITS = [
  {
    userId: "agent-2",
    fullName: "Riya Sharma",
    username: "riya.sharma",
    email: "riya@example.com",
    accountType: "agent",
    isMember: false,
    hasPendingInvite: false
  },
  {
    userId: "agent-3",
    fullName: "Dev Kumar",
    username: "dev",
    email: "dev@example.com",
    accountType: "agent",
    isMember: true,
    hasPendingInvite: false
  }
];

const DIRECTORY = [
  {
    userId: "agent-1",
    name: "Asha",
    username: "asha",
    avatarUrl: null,
    headline: "Designer for local businesses",
    skills: ["web design", "figma"],
    availability: "available",
    yearsExperience: 5,
    expectedRate: 1200,
    currency: "INR",
    accountType: "agent",
    equityOk: true,
    esopOk: false
  }
];

const PROFILE = {
  userId: "agent-1",
  name: "Asha",
  username: "asha",
  accountType: "agent",
  isSelf: false,
  headline: "Designer for local businesses",
  bio: "I build sites for small shops.",
  skills: ["web design", "figma"],
  yearsExperience: 5,
  availability: "available",
  hoursPerWeek: 20,
  seeking: "Long-term work with a product team.",
  expectedRate: 1200,
  currency: "INR",
  location: "New Delhi",
  remoteOk: true,
  equityOk: true,
  esopOk: true,
  resumeUrl: "https://example.com/cv.pdf",
  portfolioUrl: "https://asha.example.com",
  socialLinks: { linkedin: "https://linkedin.com/in/asha" },
  experience: [{ role: "Senior designer", company: "Roast Co", from: "2021", to: "2024", summary: "Ran the design system." }],
  languages: ["English", "Hindi"],
  ratingAvg: 4.5,
  ratingCount: 2,
  completedContracts: 3,
  ongoingContracts: 1,
  portfolio: [{ id: "p1", title: "Bakery site", summary: "Six pages", url: "https://asha.example.com/bakery" }]
};

const CHANNELS = [
  { id: "chan-1", slug: "general", name: "General", description: "Introductions and everything else.", sort_order: 10 },
  { id: "chan-2", slug: "wins", name: "Wins", description: "Shipped something? Post it here.", sort_order: 30 }
];

const MESSAGES = [
  {
    id: "m1",
    body: "Hello everyone",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    authorId: "someone-else",
    authorName: "Asha",
    username: "asha",
    avatarUrl: null
  }
];

/* -------------------------------------------------------------- harness */

async function bundle(entry, extraTables = {}) {
  const stub = {
    name: "phase3-stubs",
    setup(build) {
      const supabaseStub = `
        export const sb = {
          rpc: async (name, args) => ({ data: await globalThis.__rpc(name, args), error: null }),
          from: (table) => ({
            select: () => ({
              order: async () => ({ data: globalThis.__table(table), error: null })
            })
          }),
          auth: {
            getSession: async () => ({ data: { session: globalThis.__session } }),
            /* The hub reads the signed-in id the way the app does. */
            getUser: async () => ({ data: { user: globalThis.__session?.user || null } })
          },
          channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
          },
          removeChannel: () => {}
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
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onResolve({ filter: /ui\/toast\.js$/ }, () => ({ path: "toast", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents: args.path === "supabase" ? supabaseStub : toastStub,
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

function makeWorld({ session = { user: { id: "agent-1" } } } = {}) {
  const { window, document } = parseHTML("<!doctype html><html><body><div id='view-root'></div></body></html>");
  globalThis.__session = session;
  const calls = [];
  const toasts = [];
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.__toast = (message, kind) => toasts.push({ message, kind });
  globalThis.location = new URL("https://shinzora.test/app/?view=community");
  window.location = globalThis.location;
  globalThis.history = { replaceState: () => {}, pushState: () => {} };
  globalThis.navigator = { userAgent: "shinzora-test" };

  const answers = {
    team_my_invitations: INVITATIONS,
    team_accept_invite: { ok: true, businessName: "Klyro" },
    team_decline_invite: { ok: true },
    team_accessible_businesses: BUSINESSES,
    team_members_list: MEMBERS,
    team_pending_invites: PENDING,
    team_search_people: SEARCH_HITS,
    team_invite_user: { alreadyMember: false, userExists: true, inviteId: "inv-new" },
    team_revoke_member: { ok: true },
    team_remove_member: { ok: true },
    find_team_search: DIRECTORY,
    agent_public_profile: PROFILE,
    community_messages_list: MESSAGES,
    community_send: { id: "m2", body: "hi", createdAt: new Date().toISOString() }
  };
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? null;
  };
  globalThis.__table = (table) => (table === "community_channels" ? CHANNELS : []);

  const root = document.getElementById("view-root");
  return { window, document, root, calls, toasts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
/* The hub paints in several awaited steps (groups, channels, the room, the
   details column), so the community tests wait a little longer than the rest. */
const settleHub = () => new Promise((resolve) => setTimeout(resolve, 200));
const count = (calls, name) => calls.filter((call) => call.name === name).length;
const lastArgs = (calls, name) => calls.filter((call) => call.name === name).at(-1)?.args;
const click = (window, node) => node.dispatchEvent(new window.Event("click", { bubbles: true }));

/* ---------------------------------------------------------------- tests */

test("the invitation inbox lists what the database holds", async () => {
  const { root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "invitations.js"));
  await view.default(root);

  assert.equal(count(calls, "team_my_invitations"), 1, "the inbox asks the database for invitations");
  assert.equal(root.querySelectorAll("[data-invite]").length, 1, "one card per open invitation");
  assert.match(root.textContent, /Klyro/, "the business name is shown");
  assert.match(root.textContent, /Aditya/, "who invited them is shown");
  assert.match(root.textContent, /freelancer/, "the role is shown");
  assert.match(root.textContent, /mangkun150@gmail\.com/, "the invited address is shown");
  assert.ok(root.querySelector("[data-accept]"), "there is an accept button");
  assert.ok(root.querySelector("[data-decline]"), "there is a decline button");
});

test("accepting an invitation calls accept and drops the card", async () => {
  const { window, root, calls, toasts } = makeWorld();
  const view = await bundle(path.join(viewsDir, "invitations.js"));
  await view.default(root);

  click(window, root.querySelector("[data-accept]"));
  await settle();

  assert.equal(count(calls, "team_accept_invite"), 1, "accept is called exactly once");
  assert.deepEqual(lastArgs(calls, "team_accept_invite"), { p_invite: "inv-1" }, "with the invitation id");
  assert.equal(root.querySelectorAll("[data-invite]").length, 0, "the answered card is gone");
  assert.match(root.textContent, /No invitations waiting/, "and the empty state takes over");
  assert.ok(toasts.some((t) => /Klyro/.test(t.message || "")), "the user is told which team they joined");
});

test("declining an invitation calls decline, not accept", async () => {
  const { window, root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "invitations.js"));
  await view.default(root);

  click(window, root.querySelector("[data-decline]"));
  await settle();

  assert.equal(count(calls, "team_decline_invite"), 1);
  assert.equal(count(calls, "team_accept_invite"), 0, "declining must never accept");
  assert.deepEqual(lastArgs(calls, "team_decline_invite"), { p_invite: "inv-1" });
});

test("an empty inbox explains itself instead of rendering nothing", async () => {
  const { root } = makeWorld();
  globalThis.__rpc = () => [];
  const view = await bundle(path.join(viewsDir, "invitations.js"));
  await view.default(root);

  assert.match(root.textContent, /No invitations waiting/);
  assert.match(root.textContent, /the email you signed in with/i, "it explains how invitations are matched");
});

test("the team screen shows members and the invitations still waiting", async () => {
  const { root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "team.js"));
  await view.default(root);
  await settle();

  assert.equal(count(calls, "team_members_list"), 1);
  assert.equal(count(calls, "team_pending_invites"), 1);
  assert.match(root.textContent, /Klyro/, "the business header uses the business record");
  assert.match(root.textContent, /Asha/, "members are listed");
  assert.match(root.textContent, /Owner/, "the owner is labelled");
  assert.match(root.textContent, /newperson@example\.com/, "pending invitations are visible to the owner");
  assert.match(root.textContent, /not registered yet/, "an unregistered invitee is called out");
});

test("searching people invites a real account, not a typed address", async () => {
  const { window, root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "team.js"));
  await view.default(root);
  await settle();

  const field = root.querySelector("#team-search");
  field.value = "riya";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();

  assert.equal(count(calls, "team_search_people"), 1, "search hits the people RPC");
  assert.deepEqual(lastArgs(calls, "team_search_people"), { p_business: "biz-1", p_query: "riya" });
  assert.equal(root.querySelectorAll("[data-invite-user]").length, 1, "only the non-member gets an invite button");
  assert.match(root.textContent, /On team/, "an existing member is badged instead");

  click(window, root.querySelector("[data-invite-user]"));
  await settle();

  assert.equal(count(calls, "team_invite_user"), 1);
  assert.deepEqual(lastArgs(calls, "team_invite_user"), {
    p_business: "biz-1",
    p_email: "riya@example.com",
    p_member_type: "agent"
  });
});

test("an unknown email still creates an invitation and offers the mail link", async () => {
  const { window, root, calls } = makeWorld();
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    if (name === "team_search_people") return [];
    if (name === "team_invite_user") return { alreadyMember: false, userExists: false, inviteId: "inv-new" };
    if (name === "team_accessible_businesses") return BUSINESSES;
    if (name === "team_members_list") return MEMBERS;
    if (name === "team_pending_invites") return [];
    return null;
  };
  const view = await bundle(path.join(viewsDir, "team.js"));
  await view.default(root);
  await settle();

  const field = root.querySelector("#team-search");
  field.value = "stranger@example.com";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();

  const fallback = root.querySelector("[data-invite-email]");
  assert.ok(fallback, "a not-registered address gets a fallback invite button");
  assert.equal(fallback.dataset.inviteEmail, "stranger@example.com");

  click(window, fallback);
  await settle();

  assert.equal(count(calls, "team_invite_user"), 1, "the invitation is still recorded");
  const mailLink = [...root.querySelectorAll("a")].find((a) => a.getAttribute("href")?.includes("mail.google.com"));
  assert.ok(mailLink, "and the owner gets a prefilled email to send");
  assert.match(decodeURIComponent(mailLink.getAttribute("href")), /to=stranger@example\.com/, "addressed to the invitee");
  assert.match(root.textContent, /Invitation saved for stranger@example\.com/, "the owner is told what happened");
});

test("removing a member and cancelling an invitation are separate calls", async () => {
  const { window, root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "team.js"));
  await view.default(root);
  await settle();

  click(window, root.querySelector("[data-remove]"));
  await settle();
  assert.equal(count(calls, "team_remove_member"), 1);
  assert.deepEqual(lastArgs(calls, "team_remove_member"), { p_business: "biz-1", p_user: "agent-1" });

  click(window, root.querySelector("[data-revoke]"));
  await settle();
  assert.equal(count(calls, "team_revoke_member"), 1);
  assert.deepEqual(lastArgs(calls, "team_revoke_member"), { p_business: "biz-1", p_invite: "inv-9" });
});

test("Find Team renders a card per person with handle and skills", async () => {
  const { root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "find-team.js"));
  await view.default(root);

  assert.equal(count(calls, "find_team_search"), 1, "the directory loads on open");
  assert.equal(root.querySelectorAll(".ft-card").length, 1);
  assert.match(root.textContent, /@asha/, "the handle is on the card");
  assert.match(root.textContent, /web design/, "skills are on the card");
  assert.match(root.textContent, /5 yr/, "experience is on the card");
});

test("opening a card fetches the full profile, including CV and portfolio", async () => {
  const { window, root, document, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "find-team.js"));
  await view.default(root);

  click(window, root.querySelector("[data-person]"));
  await settle();

  assert.equal(count(calls, "agent_public_profile"), 1);
  assert.deepEqual(lastArgs(calls, "agent_public_profile"), { p_username: "asha" });

  const modal = document.querySelector(".modal");
  assert.ok(modal, "a modal opened");
  const text = modal.textContent;
  assert.match(text, /Senior designer/, "experience history is shown");
  assert.match(text, /Bakery site/, "portfolio items are shown");
  const resume = [...modal.querySelectorAll("a")].find((a) => a.getAttribute("href")?.includes("cv.pdf"));
  assert.ok(resume, "the résumé is linked");
  assert.match(resume.textContent, /Résumé/, "and labelled as the CV");
  assert.match(text, /linkedin/, "social links are shown");
  const cells = [...modal.querySelectorAll(".ft-stat-cell")];
  const cellText = cells.map((c) => c.textContent.replace(/\s+/g, " ").trim());
  assert.ok(cells.length >= 8, "the profile shows a labelled stat grid, not a bare list");
  assert.ok(cellText.some((t) => /^Completed\s*3$/.test(t)), "completed project count is shown");
  assert.ok(cellText.some((t) => /^Ongoing\s*1$/.test(t)), "ongoing project count is shown");
  assert.ok(cellText.some((t) => /^Experience\s*5 years$/.test(t)), "experience reads as prose, not a number alone");
});

test("Community renders the same hub every signed-in account gets, and sends text", async () => {
  const { window, root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "community.js"));
  await view.default(root);
  await settleHub();

  /* The three columns: rooms, the thread, the details panel. */
  assert.ok(root.querySelector("#grp-channels"), "the rail lists the public rooms");
  assert.equal(root.querySelectorAll("[data-channel]").length, 2, "every room is listed");
  assert.ok(root.querySelector(".chat-pane-thread"), "the middle column is a thread");
  assert.ok(root.querySelector("#grp-info-col"), "the details column is present");

  assert.equal(count(calls, "community_messages_list"), 1, "the open room loads its messages");
  assert.deepEqual(lastArgs(calls, "community_messages_list"), { p_channel: "general", p_limit: 80 });
  assert.match(root.querySelector(".chat-thread-title").textContent, /#General/, "the open room is named");
  assert.match(root.textContent, /Hello everyone/, "messages render");
  assert.ok(root.querySelector(".bubble-who"), "each message carries its author");
  assert.ok(root.querySelector(".hub-day"), "and the day is announced once");

  /* Text only, enforced by the schema — so the control is not offered. */
  assert.equal(root.querySelector("#grp-files").disabled, true, "attachments are off in a public room");
  assert.equal(root.querySelector('label[for="grp-files"]').hidden, true, "the attach control is not shown");
  assert.match(root.textContent, /Text only/, "the limitation is stated up front");

  const field = root.querySelector("#grp-body");
  field.value = "First post!";
  root.querySelector("#grp-compose").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(count(calls, "community_send"), 1);
  assert.deepEqual(lastArgs(calls, "community_send"), { p_channel: "general", p_body: "First post!" });
});

test("switching rooms in the hub reloads that room's messages", async () => {
  const { window, root, calls } = makeWorld();
  const view = await bundle(path.join(viewsDir, "community.js"));
  await view.default(root);
  await settleHub();

  const wins = [...root.querySelectorAll("[data-channel]")].find((b) => b.dataset.channel === "wins");
  click(window, wins);
  await settleHub();

  assert.equal(count(calls, "community_messages_list"), 2, "a second load for the new room");
  assert.deepEqual(lastArgs(calls, "community_messages_list"), {
    p_channel: "wins",
    p_limit: 80
  });
});

test("a signed-out visitor keeps the read-only room page", async () => {
  /* No account means no groups: the hub's rail would be half empty. These
     visitors get the plainer page, which needs no membership at all. */
  const { root } = makeWorld({ session: null });
  const view = await bundle(path.join(viewsDir, "community.js"));
  await view.default(root);
  await settleHub();

  assert.equal(root.querySelector("#grp-channels"), null, "no hub for a visitor");
  assert.ok(root.querySelector("#cm-body"), "the public composer is there");
});

/* ------------------------------------------------------- schema guarantees */

const migration = (name) => readFile(path.join(repo, "supabase/migrations", name), "utf8");

test("0024 revokes notify_user from clients so nobody can forge notifications", async () => {
  const sql = await migration("0024_community_portfolio_and_invitations.sql");
  assert.match(sql, /revoke all on function public\.notify_user[\s\S]*from public;/);
  assert.match(sql, /revoke all on function public\.notify_user[\s\S]*from authenticated;/);
  assert.ok(!/grant execute on function public\.notify_user/.test(sql), "never granted outwards");
});

test("0024 keeps the community text-only at the schema level", async () => {
  const sql = await migration("0024_community_portfolio_and_invitations.sql");
  const table = sql.slice(sql.indexOf("create table if not exists public.community_messages"));
  const block = table.slice(0, table.indexOf(");"));
  const columns = block
    .slice(block.indexOf("(") + 1)
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && !name.startsWith("--"));
  assert.deepEqual(columns, ["id", "channel_id", "author_id", "body", "created_at", "removed_at"],
    "community_messages carries no attachment column — text only by construction");
  assert.match(block, /char_length\(btrim\(body\)\) between 1 and 4000/, "body is bounded");
});

test("0024 ships the invitation triggers and the new grants", async () => {
  const sql = await migration("0024_community_portfolio_and_invitations.sql");
  assert.match(sql, /create trigger trg_notify_team_invite/);
  assert.match(sql, /create trigger trg_notify_proposal/);
  for (const fn of [
    "community_send(text,text)",
    "team_decline_invite(uuid)",
    "marketplace_decide_proposal(uuid,text,text)",
    "team_search_people(uuid,text)"
  ]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to authenticated`), `${fn} is granted`);
  }
});

test("the new views are registered in the router and the sidebar", async () => {
  const router = await readFile(path.join(repo, "public/js/modules/dashboard/router.js"), "utf8");
  const shell = await readFile(path.join(repo, "public/js/modules/dashboard/shell.js"), "utf8");
  for (const view of ["invitations", "team", "community", "find-team"]) {
    assert.match(router, new RegExp(`["']?${view}["']?: \\(\\) => import`), `${view} has a loader`);
    assert.ok(shell.includes(`id: "${view}"`), `${view} is in the sidebar`);
  }
});

test("every icon the phase-3 views ask for exists", async () => {
  const { iconNames } = await import("../public/js/lib/icons.js");
  const available = new Set(iconNames);
  const missing = [];
  for (const file of ["invitations.js", "team.js", "find-team.js", "community.js"]) {
    const source = await readFile(path.join(viewsDir, file), "utf8");
    for (const match of source.matchAll(/icon\(\s*"([a-z0-9-]+)"/g)) {
      if (!available.has(match[1])) missing.push(`${file}:${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `unknown icons render as a question mark: ${missing.join(", ")}`);
});

test("a one-year profile is written in the singular", async () => {
  const { window, root, document } = makeWorld();
  const single = { ...PROFILE, yearsExperience: 1, completedContracts: 0, ongoingContracts: 0, ratingAvg: null };
  globalThis.__rpc = (name, args) => {
    if (name === "find_team_search") return [DIRECTORY[0]];
    if (name === "agent_public_profile") return single;
    return null;
  };
  const view = await bundle(path.join(viewsDir, "find-team.js"));
  await view.default(root);

  click(window, root.querySelector("[data-person]"));
  await settle();

  const text = document.querySelector(".modal")?.textContent || "";
  assert.match(text, /1 year(?!s)/, "one year is not written as \"1 years\"");
  assert.doesNotMatch(text, /1 years/, "the plural bug does not come back");
});

test("consecutive messages from one person group under a single author line", async () => {
  const { root } = makeWorld();
  const now = Date.now();
  globalThis.__rpc = (name) => {
    if (name === "community_messages_list") {
      return [
        { id: "m1", body: "Hello everyone", createdAt: new Date(now - 90_000).toISOString(), authorId: "someone-else", authorName: "Asha", username: "asha" },
        { id: "m2", body: "Second thought", createdAt: new Date(now - 80_000).toISOString(), authorId: "someone-else", authorName: "Asha", username: "asha" },
        { id: "m3", body: "Different voice", createdAt: new Date(now - 70_000).toISOString(), authorId: "owner-2", authorName: "Aditya", username: "aditya" }
      ];
    }
    if (name === "group_my_groups") return [];
    return null;
  };
  const view = await bundle(path.join(viewsDir, "community.js"));
  await view.default(root);
  await settleHub();

  assert.equal(root.querySelectorAll("[data-message]").length, 3, "all three messages render");
  assert.equal(root.querySelectorAll(".bubble-who").length, 2, "the repeated author line is dropped");
  assert.match(root.querySelector("[data-message=\"m2\"]").textContent, /Second thought/);
  assert.match(root.querySelector("[data-message=\"m3\"]").textContent, /Aditya/, "the new voice is named again");
  assert.equal(root.querySelectorAll(".hub-day").length, 1, "one day pill for one day");
});
