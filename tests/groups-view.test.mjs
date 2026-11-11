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

const CHANNELS = [
  { id: "chan-1", slug: "general", name: "General", description: "Everything and anything", sort_order: 1 },
  { id: "chan-2", slug: "wins", name: "Wins", description: "Post a win", sort_order: 2 }
];

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

const THREAD_WITH_IMAGE = [
  {
    id: "m9",
    body: "",
    createdAt: new Date().toISOString(),
    authorId: "user-b",
    authorName: "Asha",
    mentions: [],
    attachments: [{ path: `${GROUP.id}/user-b/uuid-banner.png`, name: "banner.png", mime: "image/png", size: 12000 }]
  },
  ...THREAD
];

async function bundle(entry) {
  const stub = {
    name: "groups-view-stubs",
    setup(build) {
      const supabaseStub = `
        export const sb = {
          rpc: async (name, args) => ({ data: await globalThis.__rpc(name, args), error: null }),
          from: (table) => ({ select: () => ({ order: async () => ({
            data: table === "community_channels" ? globalThis.__channels || [] : [],
            error: null
          }) }) }),
          auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }),
                  getUser: async () => ({ data: { user: { id: "user-a" } } }) },
          channel: () => { const api = { on: () => api, subscribe: () => api }; return api; },
          removeChannel: () => {},
          storage: { from: () => ({
            upload: async (path) => { globalThis.__uploads.push(path); return { error: null }; },
            getPublicUrl: () => ({ data: { publicUrl: "" } }),
            createSignedUrl: async (path) => ({ data: { signedUrl: "https://files.test/" + path }, error: null })
          }) }
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

function makeWorld({
  groups = [GROUP],
  detail = DETAIL,
  thread = THREAD,
  candidates = MEMBERS,
  channels = CHANNELS,
  pinned = null,
  searchHits = []
} = {}) {
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
  /* linkedom has no layout, so scrollIntoView does not exist. The thread uses it
     to bring a focused message into view; stubbing it keeps that path honest
     instead of skipping it. */
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  /* The views read `location.search` and rewrite it with `history.replaceState`,
     so both must exist as globals — the harness runs one page at a time. */
  globalThis.location = new URL("https://shinzora.test/app/?view=messages");
  window.location = globalThis.location;
  globalThis.history = { replaceState: () => {}, pushState: () => {} };
  /* Every browser has `navigator`; Node 20 does not. The view only reads it to
     check for a service worker, which this harness deliberately lacks. */
  globalThis.navigator = { userAgent: "shinzora-test" };
  globalThis.__toast = (message, kind) => toasts.push({ message, kind });
  globalThis.__channels = channels;
  globalThis.__uploads = [];

  const answers = {
    group_my_groups: groups,
    group_get: detail,
    group_messages_list: thread,
    group_mark_read: { ok: true },
    group_mention_candidates: candidates,
    group_send: { id: "m4", createdAt: new Date().toISOString() },
    group_pinned: pinned,
    group_pin: pinned,
    group_unpin: { pinned: null },
    group_messages_search: searchHits,
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
  assert.deepEqual(lastArgs(world.calls, "group_send"), {
    p_group: GROUP.id,
    p_body: "@chirag look at this",
    p_attachments: []
  });
});

test("the composer is hidden until a group is open", async () => {
  const world = makeWorld({ groups: [] });
  await openGroupsTab(world);
  const form = world.root.querySelector("#grp-compose");
  assert.ok(form, "the composer element exists");
  assert.equal(form.hidden, true, "an empty inbox shows no compose box");
});

test("a picture on a message is shown as a picture, not a filename", async () => {
  const world = makeWorld({ thread: THREAD_WITH_IMAGE });
  await openGroupsTab(world);

  const image = world.root.querySelector(".grp-attach-image img");
  assert.ok(image, "the picture must render");
  assert.match(image.getAttribute("src"), /files\.test/, "through a signed URL, never a public path");
  assert.equal(image.getAttribute("alt"), "banner.png", "with alt text");
});

test("choosing a file shows it before sending, and it can be removed", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const input = world.root.querySelector("#grp-files");
  assert.ok(input, "the group composer has an attach control");
  const file = new File([new Uint8Array(1024)], "diagram.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
  await settle();

  const pending = world.root.querySelector("#grp-pending");
  assert.equal(pending.hidden, false, "the pending row must be visible");
  assert.match(pending.textContent, /diagram\.png/, "the chosen file is named");

  const drop = world.root.querySelector("[data-drop-pending]");
  drop.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(world.root.querySelector("#grp-pending").hidden, true, "removing it clears the row");
});

test("a file-only message uploads under the group and sends its path", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const input = world.root.querySelector("#grp-files");
  const file = new File([new Uint8Array(2048)], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
  await settle();

  world.root
    .querySelector("#grp-compose")
    .dispatchEvent(new world.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle(120);

  assert.equal(globalThis.__uploads.length, 1, "exactly one upload");
  assert.match(globalThis.__uploads[0], new RegExp(`^${GROUP.id}/`), "the path must start with the group id");

  const args = lastArgs(world.calls, "group_send");
  assert.equal(args.p_body, "", "a picture-only message sends an empty body");
  assert.equal(args.p_attachments.length, 1, "and one attachment");
  assert.equal(args.p_attachments[0].mime, "image/jpeg");
});

test("the group header offers a meeting button once a group is open", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  const meet = world.root.querySelector("#grp-call");
  assert.ok(meet, "the Meet button exists");
  assert.equal(meet.hidden, false, "and is visible with a group open");
  assert.equal(meet.getAttribute("aria-label"), "Start a video meeting", "and is named for a screen reader");
  const voice = world.root.querySelector("#grp-call-voice");
  assert.equal(voice.hidden, false, "the voice-meeting button is there too");
  assert.equal(voice.getAttribute("aria-label"), "Start a voice meeting");
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

/* ------------------------------------------------------- the hub, as a surface */

test("the rail lists the public channels above the groups", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const rail = world.root.querySelector("#grp-channels");
  assert.ok(rail, "the channels section exists");
  const rows = [...rail.querySelectorAll("[data-channel]")];
  assert.deepEqual(rows.map((row) => row.getAttribute("data-channel")), ["general", "wins"]);
  assert.match(rail.textContent, /General/);
  assert.equal(world.root.querySelectorAll("#grp-list [data-group]").length, 1, "the groups are still there");
  /* The order is part of the design: public rooms on top, the member's own
     groups under them. */
  const channels = world.root.querySelector("#grp-channels");
  const groups = world.root.querySelector("#grp-list");
  assert.ok(
    channels.compareDocumentPosition(groups) & 4,
    "the channels section comes before the groups section"
  );
});

test("a channel opens in the middle column and is text-only", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  const channel = world.root.querySelector('[data-channel="general"]');
  click(world.window, channel);
  await settle();

  assert.deepEqual(lastArgs(world.calls, "community_messages_list"), { p_channel: "general", p_limit: 80 });
  assert.equal(world.root.querySelector("#grp-files").disabled, true, "attachments are off in a public room");
  assert.equal(world.root.querySelector('[data-cmp="attach"]').hidden, true, "and the control is not shown");
  assert.match(world.root.querySelector(".chat-thread-title").textContent, /#General/);
  assert.match(world.root.querySelector("#grp-info-col").textContent, /everyone can read it/);
  assert.equal(
    world.root.querySelector("#grp-list .is-active"),
    null,
    "no group is lit while a channel is open"
  );
});

test("the details panel is part of the page, not a dialog", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const panel = world.root.querySelector("#grp-info-col");
  assert.ok(panel, "the column exists");
  assert.match(panel.textContent, /Design team/, "the group name");
  assert.match(panel.textContent, /Weekly reviews/, "the About line");
  assert.match(panel.textContent, /3 members/, "the member count");
  assert.ok(panel.querySelector("[data-add-people]"), "Add members is a row");
  assert.ok(panel.querySelector("[data-edit-group]"), "Group permissions is a row");
  assert.ok(panel.querySelector("[data-toggle-mute]"), "Mute is a row with its own switch");
  assert.equal(panel.querySelector("[data-leave-group]"), null, "the owner is not offered Leave");
  assert.ok(panel.querySelectorAll(".hub-member-chip").length >= 3, "the member strip is painted");
  assert.ok(panel.querySelector("[data-open-members]"), "See all members");
  assert.match(panel.textContent, /Group media/, "the media section is labelled");
});

test("the same hub layout is what every role gets — nothing in it is role-shaped", async () => {
  /* A plain member: fewer rows, identical structure. The mockup is one surface
     for admins, users and freelancers, so the columns and the sections must not
     move — only the actions the database would refuse are left out. */
  const world = makeWorld({
    detail: { ...DETAIL, role: "member", canManage: false, isOwner: false }
  });
  await openGroupsTab(world);
  const panel = world.root.querySelector("#grp-info-col");
  assert.ok(panel.querySelector("[data-open-members]"), "members see the member strip");
  assert.match(panel.textContent, /Group media/, "and the media grid");
  assert.equal(panel.querySelector("[data-add-people]"), null, "but not the manager-only rows");
  assert.ok(panel.querySelector("[data-leave-group]"), "and the way out of the group");
  assert.ok(panel.querySelector("[data-toggle-mute]"), "mute is personal, so every member has it");
  assert.ok(world.root.querySelector("#grp-search"), "and the header is the same");
});

test("a pinned message shows under the header and jumps to the message", async () => {
  const world = makeWorld({
    pinned: {
      id: "m1",
      body: "release notes for friday",
      authorId: "user-b",
      authorName: "Asha",
      createdAt: new Date().toISOString()
    }
  });
  await openGroupsTab(world);

  const bar = world.root.querySelector("#grp-pin");
  assert.equal(bar.hidden, false, "the pin bar is visible");
  assert.match(bar.textContent, /release notes for friday/);
  assert.equal(world.root.querySelector("#grp-pin-clear").hidden, false, "the owner may unpin it");

  click(world.window, world.root.querySelector("#grp-pin-text"));
  await settle();
  assert.equal(count(world.calls, "group_get") >= 2, true, "clicking the pin re-opens the thread to it");
});

test("an admin can pin from a message, and unpin from the bar", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const pinButton = world.root.querySelector("[data-pin-msg]");
  assert.ok(pinButton, "the pin affordance is on the bubbles");
  click(world.window, pinButton);
  await settle();
  assert.deepEqual(lastArgs(world.calls, "group_pin"), { p_group: GROUP.id, p_message: "m1" });

  click(world.window, world.root.querySelector("#grp-pin-clear"));
  await settle();
  assert.deepEqual(lastArgs(world.calls, "group_unpin"), { p_group: GROUP.id });
});

test("search asks the database for this group's messages", async () => {
  const world = makeWorld({
    searchHits: [
      { id: "m2", body: "the banner is ready", createdAt: new Date().toISOString(), authorName: "Asha" }
    ]
  });
  await openGroupsTab(world);

  click(world.window, world.root.querySelector("#grp-search"));
  assert.equal(world.root.querySelector("#grp-search-panel").hidden, false, "the search field opens");
  const input = world.root.querySelector("#grp-search-input");
  input.value = "banner";
  input.dispatchEvent(new world.window.Event("input", { bubbles: true }));
  await settle();

  assert.deepEqual(lastArgs(world.calls, "group_messages_search"), {
    p_group: GROUP.id,
    p_query: "banner",
    p_limit: 30
  });
  const hits = [...world.root.querySelectorAll("[data-search-hit]")];
  assert.equal(hits.length, 1, "the hit is listed");
  assert.match(hits[0].textContent, /the banner is ready/);
});

test("the header carries search, voice, video and more — and no group means no controls", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  for (const id of ["#grp-search", "#grp-call-voice", "#grp-call", "#grp-more"]) {
    assert.equal(world.root.querySelector(id).hidden, false, `${id} is visible with a group open`);
  }

  const empty = makeWorld({ groups: [] });
  await openGroupsTab(empty);
  for (const id of ["#grp-call-voice", "#grp-call", "#grp-more"]) {
    assert.equal(empty.root.querySelector(id).hidden, true, `${id} is hidden with nothing open`);
  }
  assert.equal(empty.root.querySelector("#grp-pin").hidden, true, "and there is no pin bar");
});

test("a member is offered Leave, which the owner never is", async () => {
  const world = makeWorld({ detail: { ...DETAIL, role: "member", canManage: false, isOwner: false } });
  await openGroupsTab(world);
  const leave = world.root.querySelector("#grp-info-col [data-leave-group]");
  assert.ok(leave, "the member has a way out");
  assert.match(leave.textContent, /Leave group/);
});

/* --------------------------------------------- the composer, in a real thread */

test("the emoji button opens the whole set and a pick lands in the field", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  const open = world.root.querySelector('[data-cmp="emoji"]');
  assert.ok(open, "the emoji button is in the bar");
  click(world.window, open);
  const pop = world.root.querySelector("#grp-cmp-emoji");
  assert.equal(pop.hidden, false, "the picker opens");

  const search = pop.querySelector("#grp-cmp-emoji-search");
  search.value = "rocket";
  search.dispatchEvent(new world.window.Event("input", { bubbles: true }));
  const cell = pop.querySelector('[data-emoji-pick="🚀"]');
  assert.ok(cell, "searching “rocket” finds the rocket");

  const field = world.root.querySelector("#grp-body");
  field.value = "ship it ";
  field.selectionStart = field.value.length;
  click(world.window, cell);
  assert.equal(field.value, "ship it 🚀", "the emoji is inserted at the caret");
});

test("the attach button asks which kind, and each kind filters the file picker", async () => {
  const world = makeWorld();
  await openGroupsTab(world);

  click(world.window, world.root.querySelector('[data-cmp="attach"]'));
  const menu = world.root.querySelector("#grp-cmp-attach");
  assert.equal(menu.hidden, false, "the menu opens");
  const kinds = [...menu.querySelectorAll("[data-attach-kind]")].map((row) => row.getAttribute("data-attach-kind"));
  assert.deepEqual(kinds, ["media", "document", "poll", "audio"], "the four kinds the server accepts");

  const input = world.root.querySelector("#grp-files");
  let opened = 0;
  input.click = () => (opened += 1);
  click(world.window, menu.querySelector('[data-attach-kind="media"]'));
  assert.match(input.accept, /video\/mp4/, "media opens the picker for pictures and video");
  assert.equal(opened, 1, "and the picker was opened");

  click(world.window, world.root.querySelector('[data-cmp="attach"]'));
  click(world.window, menu.querySelector('[data-attach-kind="audio"]'));
  assert.match(input.accept, /^audio\//, "audio opens the picker for audio only");
});

test("a poll is created from the composer and lands in the thread", async () => {
  const world = makeWorld({
    detail: { ...DETAIL, members: MEMBERS },
    thread: THREAD
  });
  await openGroupsTab(world);

  click(world.window, world.root.querySelector('[data-cmp="attach"]'));
  click(world.window, world.root.querySelector('#grp-cmp-attach [data-attach-kind="poll"]'));

  const dialog = world.document.querySelector(".modal");
  assert.ok(dialog, "the poll dialog opened");
  dialog.querySelector("#poll-question").value = "Where should we meet?";
  const field = dialog.querySelector("[data-poll-option]");
  field.value = "Office";
  field.dispatchEvent(new world.window.Event("input", { bubbles: true }));
  dialog.querySelector('[data-poll-option="1"]').value = "Cafe";
  dialog.querySelector('[data-poll-option="1"]').dispatchEvent(new world.window.Event("input", { bubbles: true }));

  click(world.window, dialog.querySelector("#poll-create"));
  await settle();

  const args = lastArgs(world.calls, "group_poll_create");
  assert.ok(args, "group_poll_create was called");
  assert.equal(args.p_question, "Where should we meet?");
  assert.deepEqual(args.p_options, ["Office", "Cafe"]);
  assert.equal(args.p_multiple, false);
});

test("a poll in the thread renders its options, and a click votes", async () => {
  const poll = {
    id: "poll-1",
    groupId: GROUP.id,
    question: "Where should we meet?",
    multiple: false,
    closed: false,
    options: [
      { index: 0, label: "Office", count: 2 },
      { index: 1, label: "Cafe", count: 1 }
    ],
    mine: [0],
    totalVoters: 3
  };
  const world = makeWorld({
    thread: [
      ...THREAD,
      {
        id: "m-poll",
        body: "Where should we meet?",
        createdAt: new Date().toISOString(),
        authorId: "user-b",
        authorName: "Asha",
        mentions: [],
        attachments: [
          { kind: "poll", mime: "application/x-shinzora-poll", pollId: "poll-1", path: "poll:poll-1", name: "Poll", size: 1 }
        ]
      }
    ]
  });
  globalThis.__rpc = ((original) => (name, args) => {
    world.calls.push({ name, args });
    if (name === "group_poll_get") return poll;
    if (name === "group_poll_vote") return { ...poll, mine: [1], options: [{ index: 0, label: "Office", count: 1 }, { index: 1, label: "Cafe", count: 2 }] };
    return original(name, args);
  })(globalThis.__rpc);

  await openGroupsTab(world);
  await settle(120);

  const card = world.root.querySelector('[data-poll="poll-1"]');
  assert.ok(card, "the poll is painted in the thread");
  const options = [...card.querySelectorAll("[data-poll-vote]")];
  assert.equal(options.length, 2, "both options are there");
  assert.match(card.textContent, /Office/);
  assert.match(card.textContent, /3 voted/, "the voter count is shown");
  assert.ok(card.querySelector(".is-chosen"), "the option this member chose is marked");

  click(world.window, options[1]);
  await settle();
  const args = lastArgs(world.calls, "group_poll_vote");
  assert.deepEqual(args, { p_poll: "poll-1", p_option: 1, p_on: true });
  assert.match(
    world.root.querySelector('[data-poll="poll-1"]').textContent,
    /Cafe/,
    "the tally repainted after voting"
  );
});

test("video, audio and documents get a real preview, not a filename", async () => {
  const world = makeWorld({
    thread: [
      {
        id: "m-media",
        body: "",
        createdAt: new Date().toISOString(),
        authorId: "user-b",
        authorName: "Asha",
        mentions: [],
        attachments: [
          { path: `${GROUP.id}/user-b/clip.mp4`, name: "clip.mp4", mime: "video/mp4", size: 2_400_000 },
          { path: `${GROUP.id}/user-b/note.mp3`, name: "note.mp3", mime: "audio/mpeg", size: 90_000 },
          { path: `${GROUP.id}/user-b/brief.pdf`, name: "brief.pdf", mime: "application/pdf", size: 120_000 }
        ]
      }
    ]
  });
  await openGroupsTab(world);
  await settle(120);

  assert.ok(world.root.querySelector("video.grp-attach-video"), "the video has a player");
  assert.ok(world.root.querySelector("audio.grp-attach-player"), "the audio clip plays in the bubble");
  const doc = world.root.querySelector(".grp-attach-doc");
  assert.ok(doc, "the document is a card");
  assert.match(doc.textContent, /brief\.pdf/);
  assert.match(doc.getAttribute("href"), /#view=FitH$/, "a PDF opens the browser's preview at the top");
});

/* ------------------------------------------------- the defects this round fixed */

test("the rail's clock is compact, so the group name is not squeezed", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  const time = world.root.querySelector("[data-group] .chat-item-time");
  assert.ok(time, "the row shows a time");
  assert.match(time.textContent.trim(), /^(now|\d+[mhdw]|\w{3} \d+)$/, `compact clock, got "${time.textContent}"`);
  assert.doesNotMatch(world.root.querySelector("[data-group]").textContent, /minutes? ago/, "no spelled-out clock in the rail");
});

test("a public room does not offer mentions it cannot resolve", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  const channel = world.root.querySelector('[data-channel="general"]');
  assert.ok(channel, "the channel row rendered");
  click(world.window, channel);
  await settle();

  const field = world.root.querySelector("#grp-body");
  assert.ok(field, "the composer is there");
  assert.doesNotMatch(field.placeholder, /@/, "the field does not promise mentions");

  /* Typing @ must not ask a group-scoped RPC with no group. */
  field.value = "@as";
  field.dispatchEvent(new world.window.Event("input", { bubbles: true }));
  await settle(200);
  assert.equal(count(world.calls, "group_mention_candidates"), 0, "no mention lookup in a room");
  assert.equal(world.root.querySelector("#grp-mentions").hidden, true, "no @ menu in a room");
  assert.deepEqual(world.toasts, [], "and nothing failed loudly");
});

test("a group opened after a room promises mentions again", async () => {
  const world = makeWorld();
  await openGroupsTab(world);
  click(world.window, world.root.querySelector('[data-channel="general"]'));
  await settle();
  click(world.window, world.root.querySelector("[data-group]"));
  await settle();
  assert.match(world.root.querySelector("#grp-body").placeholder, /@/, "the promise comes back with a group");
});
