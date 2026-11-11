/* ==========================================================================
   Messages → Groups tab, driven end to end in a DOM
   --------------------------------------------------------------------------
   The Groups tab is where the whole feature becomes visible, and it is the one
   piece a database test cannot reach. This suite bundles the real view with the
   real group module, stubs only Supabase and toasts, and clicks:
     1. the tab switches and asks the database for the member's groups
     2. an empty list explains itself instead of rendering nothing
     3. a group opens: group_get, then the thread, then it is marked read
     4. a message with a stored mention renders a chip — and a plain `@word`
        with no stored mention renders none
     5. typing `@` lists the group's own members and inserts the handle
     6. the send button calls group_send with the body that was typed
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const viewsDir = path.join(repo, "public/js/modules/dashboard/views");

let counter = 0;

const GROUP = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "design",
  name: "Design team",
  description: "Weekly reviews",
  avatarUrl: null,
  ownerId: "user-a",
  role: "owner",
  muted: false,
  memberCount: 3,
  unread: 1,
  lastMessageAt: new Date(Date.now() - 600_000).toISOString(),
  lastMessage: "hello all",
  lastSender: "Asha"
};

const MEMBERS = [
  { userId: "user-a", name: "Aditya", username: "aditya", avatarUrl: null, role: "owner", muted: false },
  { userId: "user-b", name: "Asha", username: "asha", avatarUrl: null, role: "admin", muted: false },
  { userId: "user-c", name: "Chirag", username: "chirag", avatarUrl: null, role: "member", muted: false }
];

const DETAIL = {
  id: GROUP.id,
  slug: GROUP.slug,
  name: GROUP.name,
  description: GROUP.description,
  avatarUrl: null,
  ownerId: "user-a",
  role: "owner",
  canManage: true,
  isOwner: true,
  allowEveryoneMentions: true,
  everyoneMentionsAdmins: false,
  allowMemberInvites: false,
  members: MEMBERS
};

const THREAD = [
  { id: "m1", body: "hello all", createdAt: new Date(Date.now() - 900_000).toISOString(), authorId: "user-b", authorName: "Asha", mentions: [] },
  { id: "m2", body: "@chirag can you look at the banner?", createdAt: new Date(Date.now() - 600_000).toISOString(), authorId: "user-b", authorName: "Asha", mentions: [{ userId: "user-c", kind: "user", username: "chirag", name: "Chirag" }] },
  { id: "m3", body: "@nobody this is not a real handle", createdAt: new Date(Date.now() - 300_000).toISOString(), authorId: "user-c", authorName: "Chirag", mentions: [] }
];

async function bundle(entry) {
  const stub = {
    name: "groups-view-stubs",
    setup(build) {
      const supabaseStub = `
        export const sb = {
          rpc: async (name, args) => ({ data: await globalThis.__rpc(name, args), error: null }),
          from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }),
          auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }),
                  getUser: async () => ({ data: { user: { id: "user-a" } } }) },
          channel: () => { const api = { on: () => api, subscribe: () => api }; return api; },
          removeChannel: () => {},
          storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) }
        };
        export const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error?.message || error)));
      `;
      const toastStub = `
        export const toast = (payload) => globalThis.__toast(
          typeof payload === "string" ? payload : [payload?.title, payload?.message].filter(Boolean).join(" "), "ok");
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
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  return import(url);
}

function makeWorld({ groups = [GROUP], detail = DETAIL, thread = THREAD, candidates = MEMBERS } = {}) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='view-root'></div><div id='toast-region'></div></body></html>"
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
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  /* The views read `location.search` and rewrite it with `history.replaceState`,
     so both must exist as globals — the harness runs one page at a time. */
  globalThis.location = new URL("https://shinzora.test/app/?view=messages");
  window.location = globalThis.location;
  globalThis.history = { replaceState: () => {}, pushState: () => {} };
  /* Every browser has `navigator`; Node 20 does not. The view only reads it to
     check for a service worker, which this harness deliberately lacks. */
  globalThis.navigator = { userAgent: "shinzora-test" };
  globalThis.__toast = (message, kind) => toasts.push({ message, kind });

  const answers = {
    group_my_groups: groups,
    group_get: detail,
    group_messages_list: thread,
    group_mark_read: { ok: true },
    group_mention_candidates: candidates,
    group_send: { id: "m4", createdAt: new Date().toISOString() },
    dm_inbox: []
  };
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? null;
  };

  const root = document.getElementById("view-root");
  return { window, document, root, calls, toasts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const count = (calls, name) => calls.filter((call) => call.name === name).length;
const lastArgs = (calls, name) => calls.filter((call) => call.name === name).at(-1)?.args;
const click = (window, node) => node.dispatchEvent(new window.Event("click", { bubbles: true }));

async function openGroupsTab(world) {
  const view = await bundle(path.join(viewsDir, "messages.js"));
  await view.default(world.root, {});
  const tab = world.root.querySelector('[data-tab="groups"]');
  assert.ok(tab, "the Groups tab exists");
  click(world.window, tab);
  await settle();
}

/* ------------------------------------------------------------------- tests */

test("the Groups tab asks the database for the member's groups", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  assert.ok(count(world.calls, "group_my_groups") >= 1, "group_my_groups was called");
  const item = world.root.querySelector("[data-group]");
  assert.ok(item, "a group row rendered");
  assert.match(world.root.textContent, /Design team/, "the group name is on screen");
  assert.match(world.root.textContent, /Asha: hello all/, "the last sender and preview are shown");
});

test("an empty list explains itself instead of rendering nothing", async () => {
  const world = makeWorld({ groups: [] });
  await openGroupsTab(world);

  assert.equal(world.root.querySelectorAll("[data-group]").length, 0, "no group rows");
  assert.match(world.root.textContent, /You are not in a group yet/, "the empty state is spelled out");
});

test("the first group opens by itself, so the tab is never a blank pane", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  assert.equal(count(world.calls, "group_get"), 1, "the first group was read without a click");
  assert.equal(count(world.calls, "group_messages_list"), 1, "its thread was requested");
  assert.equal(count(world.calls, "group_mark_read"), 1, "and it was marked read after painting");
  assert.equal(world.root.querySelectorAll("[data-message]").length, 3, "three messages painted");
});

test("clicking a group row re-opens it", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  click(world.window, world.root.querySelector("[data-group]"));
  await settle();

  assert.equal(count(world.calls, "group_get"), 2, "opened once on boot and once by the click");
  assert.deepEqual(lastArgs(world.calls, "group_get"), { p_group: GROUP.id });
  assert.equal(world.root.querySelectorAll("[data-message]").length, 3, "the thread is still painted");
});

test("a stored mention becomes a chip; a bare @word does not", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  click(world.window, world.root.querySelector("[data-group]"));
  await settle();

  const chips = [...world.root.querySelectorAll(".mention")];
  assert.equal(chips.length, 1, `expected exactly one mention chip, found ${chips.length}`);
  assert.equal(chips[0].getAttribute("data-mention"), "chirag", "the chip is the real mention");
  /* The third message contains "@nobody" with no stored mention. It must stay
     plain text, because no mention row exists for it. */
  const third = world.root.querySelector('[data-message="m3"] .bubble-text');
  assert.ok(third, "the third message rendered");
  assert.equal(third.querySelectorAll(".mention").length, 0, "an unmentioned @word must not be a chip");
  assert.match(third.textContent, /@nobody/, "and the text is still there");
});

test("typing @ lists this group's members and inserts the handle", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  click(world.window, world.root.querySelector("[data-group]"));
  await settle();

  const field = world.root.querySelector("#grp-body");
  assert.ok(field, "the composer exists");
  field.value = "@ch";
  field.selectionStart = 3;
  field.selectionEnd = 3;
  field.dispatchEvent(new world.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(count(world.calls, "group_mention_candidates") >= 1, "candidates were requested");
  const rows = [...world.root.querySelectorAll("[data-pick]")];
  assert.ok(rows.length >= 1, "the menu opened with at least one row");
  assert.match(world.root.textContent, /chirag/, "Chirag is offered");

  /* Mousedown is what the module listens for, so a blur cannot race the click. */
  rows[0].dispatchEvent(new world.window.Event("mousedown", { bubbles: true }));
  await settle();
  assert.match(field.value, /^@chirag $/, `the handle was inserted, got "${field.value}"`);
});

test("sending calls group_send with what was typed", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  click(world.window, world.root.querySelector("[data-group]"));
  await settle();

  const field = world.root.querySelector("#grp-body");
  field.value = "@chirag look at this";
  const form = world.root.querySelector("#grp-compose");
  form.dispatchEvent(new world.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();

  assert.equal(count(world.calls, "group_send"), 1, "group_send called once");
  assert.deepEqual(lastArgs(world.calls, "group_send"), { p_group: GROUP.id, p_body: "@chirag look at this" });
});

test("the composer is hidden until a group is open", async () => {
  const world = makeWorld({ groups: [] });
  await openGroupsTab(world);
  const form = world.root.querySelector("#grp-compose");
  assert.ok(form, "the composer element exists");
  assert.equal(form.hidden, true, "an empty inbox shows no compose box");
});

test("an account with no groups gets a real empty state with a create button", async () => {
  const world = makeWorld({ groups: [] });
  await openGroupsTab(world);

  const empty = world.root.querySelector(".grp-empty");
  assert.ok(empty, "the empty state rendered");
  assert.match(empty.textContent, /No groups yet/, "it says what is missing");
  assert.ok(world.root.querySelector("[data-new-group]"), "and offers to create one");
  assert.equal(count(world.calls, "group_get"), 0, "nothing is opened when there is nothing to open");
});
