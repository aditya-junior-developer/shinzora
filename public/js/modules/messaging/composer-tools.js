/* ==========================================================================
   Shinzora · composer tools — the emoji picker and the attach menu
   --------------------------------------------------------------------------
   One implementation for every chat surface. The design asked for two buttons
   at the left of the message bar: one that opens the whole emoji set, and one
   that opens a choice of *what kind of thing* is being attached, because
   "attach a file" hiding four different flows behind one system dialog is how
   people end up sending a 40 MB video by accident.

   What lives here:
     • the popovers, their markup and their keyboard/outside-click behaviour
     • the emoji grid: nine groups, searchable by CLDR name, recalled per group
     • the attach menu: photo or video, document, poll, audio — the four the
       composer actually supports, each with a one-line explanation

   What does not live here: what happens when a choice is made. The host surface
   passes `onEmoji`, `onAttach(kind)` and `onPoll`, so a group chat can create a
   poll while a direct conversation — which has no polls — simply does not pass
   `onPoll` and the menu row is not drawn.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { EMOJI_GROUPS, searchEmoji } from "../../lib/emoji.js";

/** The four attachment flows, described once so both the menu and the tip text agree. */
export const ATTACH_KINDS = [
  {
    id: "media",
    label: "Photo or video",
    hint: "Shown in the conversation, with a preview",
    icon: "image",
    accept: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/ogg"
  },
  {
    id: "document",
    label: "Document",
    hint: "PDF, Word, Excel or text — opened, not just downloaded",
    icon: "file",
    accept:
      "application/pdf,text/plain,text/csv,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
  },
  {
    id: "poll",
    label: "Poll",
    hint: "Ask the group and count the answers",
    icon: "list-checks",
    accept: ""
  },
  {
    id: "audio",
    label: "Audio",
    hint: "A voice note or a clip, playable in the chat",
    icon: "audio-lines",
    accept: "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac,audio/flac"
  }
];

const SHORT_GROUP = {
  "Smileys & Emotion": "Smileys",
  "People & Body": "People",
  "Animals & Nature": "Nature",
  "Food & Drink": "Food",
  "Travel & Places": "Travel",
  Activities: "Activity",
  Objects: "Objects",
  Symbols: "Symbols",
  Flags: "Flags"
};

const TAB_ICON = {
  "Smileys & Emotion": "😊",
  "People & Body": "👋",
  "Animals & Nature": "🐻",
  "Food & Drink": "🍔",
  "Travel & Places": "✈️",
  Activities: "⚽",
  Objects: "💡",
  Symbols: "❤️",
  Flags: "🏳️"
};

/**
 * The two popovers. They are inserted straight into the form so they can float
 * above the bar; the buttons that open them come from `composerToolsBar`.
 */
export function composerPopsMarkup(prefix, { poll = true } = {}) {
  const kinds = ATTACH_KINDS.filter((kind) => kind.id !== "poll" || poll);
  return `
    <div class="cmp-pop cmp-emoji" id="${prefix}-emoji" hidden>
      <div class="cmp-emoji-top">
        <label class="sr-only" for="${prefix}-emoji-search">Search emoji</label>
        <input class="input cmp-emoji-search" id="${prefix}-emoji-search" type="search"
               autocomplete="off" placeholder="Search ${EMOJI_GROUPS.reduce((n, g) => n + g.emoji.length, 0).toLocaleString()} emoji — try “rocket”" />
        <button class="cmp-x" type="button" data-cmp-close aria-label="Close emoji">${icon("x", { size: 13 })}</button>
      </div>
      <div class="cmp-emoji-tabs" role="tablist" aria-label="Emoji groups">
        ${EMOJI_GROUPS.map(
          (group, index) => `<button class="cmp-emoji-tab${index === 0 ? " is-active" : ""}" type="button"
            role="tab" aria-selected="${index === 0}" data-emoji-group="${esc(group.id)}"
            title="${esc(group.name)}">${TAB_ICON[group.id] || "•"}<span class="sr-only">${esc(group.name)}</span></button>`
        ).join("")}
      </div>
      <div class="cmp-emoji-grid" id="${prefix}-emoji-grid" role="listbox" aria-label="Emoji"></div>
    </div>

    <div class="cmp-pop cmp-attach" id="${prefix}-attach" hidden role="menu" aria-label="What are you attaching?">
      ${kinds
        .map(
          (kind) => `<button class="cmp-attach-row" type="button" role="menuitem" data-attach-kind="${kind.id}">
            <span class="cmp-attach-icon">${icon(kind.icon, { size: 15 })}</span>
            <span class="cmp-attach-text">
              <span class="cmp-attach-label">${esc(kind.label)}</span>
              <span class="cmp-attach-hint">${esc(kind.hint)}</span>
            </span>
          </button>`
        )
        .join("")}
    </div>

  `;
}

/** The tools that sit at the left of the message bar. */
export function composerToolsBar({ quickEmoji = [] } = {}) {
  return `<div class="hub-compose-tools">
    <button class="hub-tool" type="button" data-cmp="emoji" aria-label="Emoji" aria-expanded="false"
            title="Emoji">${icon("smile", { size: 16 })}</button>
    <button class="hub-tool" type="button" data-cmp="attach" aria-label="Attach" aria-expanded="false"
            title="Attach a photo, video, document, poll or audio">${icon("paperclip", { size: 16 })}</button>
    <div class="hub-quick-emoji" aria-label="Quick emoji">
      ${quickEmoji
        .map(
          (emoji) =>
            `<button class="hub-quick" type="button" data-quick="${esc(emoji)}" aria-label="Insert ${esc(
              emoji
            )}">${esc(emoji)}</button>`
        )
        .join("")}
    </div>
  </div>`;
}

/**
 * Wire the popovers.
 *
 * `onAttach(kind)` is called with one of ATTACH_KINDS' ids. `onPoll` is optional:
 * a surface that cannot hold a poll does not pass it, and the row is not drawn.
 */
export function bindComposerTools(form, { prefix, onEmoji, onAttach, onPoll, onQuick } = {}) {
  if (!form) return () => {};

  const emojiPop = qs(`#${prefix}-emoji`, form);
  const attachPop = qs(`#${prefix}-attach`, form);
  const grid = qs(`#${prefix}-emoji-grid`, form);
  const search = qs(`#${prefix}-emoji-search`, form);
  const emojiBtn = qs('[data-cmp="emoji"]', form);
  const attachBtn = qs('[data-cmp="attach"]', form);

  let group = EMOJI_GROUPS[0]?.id || "";

  function paintEmoji(rows, { searching = false } = {}) {
    if (!grid) return;
    if (!rows.length) {
      grid.innerHTML = `<div class="chat-empty-line">No emoji matches that word.</div>`;
      return;
    }
    grid.innerHTML = rows
      .map(
        ([char, name]) =>
          `<button class="cmp-emoji-cell" type="button" role="option" aria-selected="false"
             data-emoji-pick="${esc(char)}" title="${esc(name)}" aria-label="${esc(name)}">${char}</button>`
      )
      .join("");
    if (!searching) grid.scrollTop = 0;
  }

  function showGroup(id) {
    const found = EMOJI_GROUPS.find((row) => row.id === id) || EMOJI_GROUPS[0];
    if (!found) return;
    group = found.id;
    for (const tab of form.querySelectorAll("[data-emoji-group]")) {
      const active = tab.getAttribute("data-emoji-group") === found.id;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    paintEmoji(found.emoji);
  }

  function closePops() {
    if (emojiPop) emojiPop.hidden = true;
    if (attachPop) attachPop.hidden = true;
    emojiBtn?.setAttribute("aria-expanded", "false");
    attachBtn?.setAttribute("aria-expanded", "false");
  }

  function openEmoji() {
    const wasOpen = emojiPop && !emojiPop.hidden;
    closePops();
    if (!emojiPop || wasOpen) return;
    emojiPop.hidden = false;
    emojiBtn?.setAttribute("aria-expanded", "true");
    if (!grid?.childElementCount) showGroup(group);
    search?.focus({ preventScroll: true });
  }

  function openAttach() {
    const wasOpen = attachPop && !attachPop.hidden;
    closePops();
    if (!attachPop || wasOpen) return;
    attachPop.hidden = false;
    attachBtn?.setAttribute("aria-expanded", "true");
  }

  on(emojiBtn, "click", (event) => {
    event.preventDefault();
    openEmoji();
  });
  on(attachBtn, "click", (event) => {
    event.preventDefault();
    openAttach();
  });

  delegate(form, "click", "[data-cmp-close]", () => closePops());
  delegate(form, "click", "[data-emoji-group]", (_event, tab) => showGroup(tab.getAttribute("data-emoji-group")));
  delegate(form, "click", "[data-emoji-pick]", (_event, cell) => {
    onEmoji?.(cell.getAttribute("data-emoji-pick"));
  });
  delegate(form, "click", "[data-quick]", (_event, chip) => {
    const value = chip.getAttribute("data-quick");
    if (onQuick) onQuick(value);
    else onEmoji?.(value);
  });

  on(search, "input", () => {
    const query = search.value.trim();
    if (query.length < 2) {
      showGroup(group);
      return;
    }
    paintEmoji(searchEmoji(query, 180), { searching: true });
  });

  delegate(form, "click", "[data-attach-kind]", (_event, row) => {
    const kind = row.getAttribute("data-attach-kind");
    closePops();
    if (kind === "poll") onPoll?.();
    else onAttach?.(kind);
  });

  /* A click anywhere else closes the popovers — but not a click on the message
     field, which is where the person is going next. */
  const onDocClick = (event) => {
    if (emojiPop?.hidden && attachPop?.hidden) return;
    if (form.contains(event.target)) return;
    closePops();
  };
  document.addEventListener("click", onDocClick);

  const onKey = (event) => {
    if (event.key === "Escape" && (!emojiPop?.hidden || !attachPop?.hidden)) {
      event.stopPropagation();
      closePops();
    }
  };
  document.addEventListener("keydown", onKey);

  if (grid && !grid.childElementCount) showGroup(group);

  return () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}

export { SHORT_GROUP };
