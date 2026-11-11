/* ==========================================================================
   The composer: the emoji set, the attach menu, and the bar that holds them
   --------------------------------------------------------------------------
   Three separate promises, checked separately:

     1. the emoji button opens the *whole* set — nine groups, searchable by
        name — and a pick lands in the message field at the caret
     2. the attach button asks what kind of thing is being attached, because
        four flows behind one system dialog is how a 40 MB video gets sent by
        accident; the menu offers exactly the four the server accepts
     3. the bar is one flex row with the tools at the left and the field taking
        what is left, and it sheds the quick reactions before it shrinks the
        field — checked against the stylesheet, since that is where it lives
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

let counter = 0;

async function bundle(entry) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent"
  });
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  return import(url);
}

function world() {
  const { window, document } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  const root = document.getElementById("root");
  return { window, document, root };
}

const click = (window, node) => node.dispatchEvent(new window.Event("click", { bubbles: true }));

test("the emoji set is the whole thing: nine groups, over two thousand emoji", async () => {
  const emoji = await bundle(path.join(repo, "public/js/lib/emoji.js"));
  assert.equal(emoji.EMOJI_GROUPS.length, 9, "nine groups");
  assert.ok(emoji.ALL_EMOJI.length > 2000, `expected more than 2,000 emoji, found ${emoji.ALL_EMOJI.length}`);
  const names = emoji.EMOJI_GROUPS.map((group) => group.id);
  for (const wanted of ["Smileys & Emotion", "People & Body", "Food & Drink", "Flags"]) {
    assert.ok(names.includes(wanted), `${wanted} is one of the groups`);
  }
  assert.ok(emoji.EMOJI_GROUPS.every((group) => group.emoji.length > 0), "no empty group");
});

test("emoji can be found by word, which is the only way 2,000 of them are usable", async () => {
  const emoji = await bundle(path.join(repo, "public/js/lib/emoji.js"));
  assert.deepEqual(emoji.searchEmoji("rocket")[0], ["🚀", "rocket"]);
  const party = emoji.searchEmoji("party").map(([char]) => char);
  assert.ok(party.includes("🎉"), "a party popper is found by “party”");
  assert.deepEqual(emoji.searchEmoji("zzzz"), [], "nonsense finds nothing");
  assert.deepEqual(emoji.searchEmoji(""), [], "an empty query is not a search");
});

test("the composer offers two buttons, four attach kinds and the quick reactions", async () => {
  const { window, root } = world();
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  root.innerHTML = `<form id="f">${tools.composerPopsMarkup("t", { poll: false })}${tools.composerToolsBar({
    quickEmoji: ["🙂", "👍"]
  })}</form>`;

  assert.ok(root.querySelector('[data-cmp="emoji"]'), "there is an emoji button");
  assert.ok(root.querySelector('[data-cmp="attach"]'), "and an attach button");
  assert.equal(root.querySelectorAll("[data-quick]").length, 2, "the quick reactions are there");

  const kinds = [...root.querySelectorAll("[data-attach-kind]")].map((row) => row.getAttribute("data-attach-kind"));
  assert.deepEqual(kinds, ["media", "document", "audio"], "a surface without polls does not offer a poll");

  tools.bindComposerTools(root.querySelector("#f"), { prefix: "t", onEmoji: () => {}, onAttach: () => {} });
  click(window, root.querySelector('[data-cmp="attach"]'));
  assert.equal(root.querySelector("#t-attach").hidden, false, "the menu opens on a click");
});

test("the poll row appears only where polls exist", async () => {
  const { root } = world();
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  root.innerHTML = `<form id="f">${tools.composerPopsMarkup("t", { poll: true })}</form>`;
  const kinds = [...root.querySelectorAll("[data-attach-kind]")].map((row) => row.getAttribute("data-attach-kind"));
  assert.deepEqual(kinds, ["media", "document", "poll", "audio"]);
});

test("the emoji button opens the grid, search narrows it, and a pick is reported", async () => {
  const { window, root } = world();
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  const picked = [];
  root.innerHTML = `<form id="f">${tools.composerPopsMarkup("t")}${tools.composerToolsBar({ quickEmoji: [] })}</form>`;
  tools.bindComposerTools(root.querySelector("#f"), { prefix: "t", onEmoji: (char) => picked.push(char) });

  const pop = root.querySelector("#t-emoji");
  assert.equal(pop.hidden, true, "the picker starts closed");
  click(window, root.querySelector('[data-cmp="emoji"]'));
  assert.equal(pop.hidden, false, "and opens on a click");
  assert.ok(pop.querySelectorAll("[data-emoji-pick]").length > 50, "the first group is painted");
  assert.equal(pop.querySelectorAll("[data-emoji-group]").length, 9, "nine group tabs");

  const search = pop.querySelector("#t-emoji-search");
  search.value = "rocket";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const hits = [...pop.querySelectorAll("[data-emoji-pick]")];
  assert.equal(hits.length, 1, "the search narrowed the grid to one emoji");
  assert.equal(hits[0].getAttribute("data-emoji-pick"), "🚀");

  click(window, hits[0]);
  assert.deepEqual(picked, ["🚀"], "the pick was reported to the host");
});

test("a group tab repaints the grid, and switching back finds the emoji again", async () => {
  const { window, root } = world();
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  root.innerHTML = `<form id="f">${tools.composerPopsMarkup("t")}${tools.composerToolsBar({ quickEmoji: [] })}</form>`;
  tools.bindComposerTools(root.querySelector("#f"), { prefix: "t", onEmoji: () => {} });
  click(window, root.querySelector('[data-cmp="emoji"]'));

  const pop = root.querySelector("#t-emoji");
  const food = [...pop.querySelectorAll("[data-emoji-group]")].find(
    (tab) => tab.getAttribute("data-emoji-group") === "Food & Drink"
  );
  click(window, food);
  const grid = pop.querySelector("#t-emoji-grid").textContent;
  assert.match(grid, /🍔|🍕|🍎/, "the food group is on screen");
  assert.ok(food.classList.contains("is-active"), "and its tab is marked");
});

test("the attach menu reports the kind that was chosen", async () => {
  const { window, root } = world();
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  const chosen = [];
  let polls = 0;
  root.innerHTML = `<form id="f">${tools.composerPopsMarkup("t")}${tools.composerToolsBar({ quickEmoji: [] })}</form>`;
  tools.bindComposerTools(root.querySelector("#f"), {
    prefix: "t",
    onEmoji: () => {},
    onAttach: (kind) => chosen.push(kind),
    onPoll: () => (polls += 1)
  });

  click(window, root.querySelector('[data-cmp="attach"]'));
  for (const kind of ["media", "document", "audio"]) {
    click(window, root.querySelector(`[data-attach-kind="${kind}"]`));
    assert.equal(root.querySelector("#t-attach").hidden, true, "choosing closes the menu");
  }
  click(window, root.querySelector('[data-cmp="attach"]'));
  click(window, root.querySelector('[data-attach-kind="poll"]'));
  assert.deepEqual(chosen, ["media", "document", "audio"]);
  assert.equal(polls, 1, "a poll is a different flow, not a file");
});

test("each attach kind names the types the server will actually accept", async () => {
  const tools = await bundle(path.join(repo, "public/js/modules/messaging/composer-tools.js"));
  const byId = Object.fromEntries(tools.ATTACH_KINDS.map((kind) => [kind.id, kind]));
  assert.match(byId.media.accept, /image\/jpeg/);
  assert.match(byId.media.accept, /video\/mp4/);
  assert.match(byId.audio.accept, /audio\/mpeg/);
  assert.match(byId.document.accept, /application\/pdf/);
  for (const kind of tools.ATTACH_KINDS) {
    assert.equal(/text\/html|image\/svg/.test(kind.accept), false, `${kind.id} offers nothing the server refuses`);
    assert.ok(kind.hint.length > 10, `${kind.id} explains itself`);
  }
});

test("the bar is one row, and the field gives up space last", async () => {
  const css = await readFile(path.join(repo, "public/css/views.css"), "utf8");
  const bar = css.slice(css.indexOf(".hub-compose-bar {"));
  assert.match(bar.slice(0, 400), /display:\s*flex/, "the bar is a flex row");
  assert.match(css, /\.hub-compose \.hub-compose-bar \{ flex-wrap: nowrap; \}/, "and stays a row");
  const field = bar.slice(bar.indexOf(".hub-compose-bar .chat-input"));
  assert.match(field.slice(0, 300), /flex:\s*1 1 auto/, "the field grows");
  assert.match(field.slice(0, 300), /min-width:\s*0/, "and can shrink below its content");
  assert.match(css, /@media \(max-width: 1080px\) \{\s*\.hub-quick-emoji \{ display: none; \}/, "the quick reactions go first");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]{0,220}\.hub-compose-bar \.chat-send span \{ display: none; \}/, "then Send becomes an icon");
});

test("the picker and the menu are anchored above the bar, not inside it", async () => {
  const css = await readFile(path.join(repo, "public/css/views.css"), "utf8");
  const pop = css.slice(css.indexOf(".cmp-pop {"));
  assert.match(pop.slice(0, 300), /position:\s*absolute/, "the popovers float");
  assert.match(pop.slice(0, 300), /bottom:\s*calc\(100% \+ 8px\)/, "above the bar");
  const panel = css.slice(css.indexOf(".cmp-emoji {"));
  assert.match(panel.slice(0, 400), /max-height/, "with a ceiling, so a long category scrolls inside");
});
