/* ==========================================================================
   Shinzora · Groups
   --------------------------------------------------------------------------
   A group is a conversation, not a second inbox: messages live in the same
   `community_messages` table the rest of Community uses, and every read and
   write goes through the membership-checked RPCs in 0037. Nothing here decides
   who may do what — the database does. This file only decides what to show.

   Three things worth knowing before editing:

     • The `@` menu is a convenience. `group_send` re-parses the body, resolves
       handles against that group's members, and refuses `@everyone` when the
       group's settings do not allow it. Deleting the popup would not weaken
       anything; deleting the server checks would.
     • Mentions are painted from `mentions[]` on the message, which the server
       derived from stored rows, so a chip can only appear where a real mention
       row exists.
     • Actions the caller cannot perform are hidden *and* enforced. Hiding is
       for tidiness, never for safety.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { timeAgo, dateTime, initials } from "../../lib/format.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { avatarMarkup, paintAvatar } from "../../lib/avatar.js";
import { toast, toastError } from "../../ui/toast.js";
import { openModal, confirmDialog, formDialog } from "../../ui/modal.js";
import { openProfile } from "../dashboard/views/find-team.js";
import { createCall, callTopics, turnConfigured } from "./webrtc.js";
import { openCallSurface, watchForCalls, showRingBanner } from "./call-ui.js";

const ROLE_LABEL = { owner: "Owner", admin: "Group admin", member: "Member" };
const AVATAR_BUCKET = "avatars";
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const FILES_BUCKET = "group-chat-files";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_FILES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
const QUICK_EMOJI = ["🙂", "👍", "🎉", "❤️", "🙏", "✨"];

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Groups are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

/* ------------------------------------------------------------------ mentions */

/**
 * Escape a stretch of plain text and turn `@handle` into a chip, but only when
 * the server told us that mention really exists on this message.
 */
function paintMentions(text, named, everyone) {
  return esc(text).replace(/(^|[\s>])@([a-zA-Z0-9._-]{0,32})/g, (whole, lead, handle) => {
    const key = handle.toLowerCase();
    const isPerson = named.has(key);
    const isEveryone = everyone && (key === "everyone" || key === "all");
    if (!isPerson && !isEveryone) return whole;
    const label = isPerson ? `@${handle}` : "@everyone";
    const title = isPerson
      ? `Mentioned @${handle}`
      : "Mentioned everyone in this group";
    return `${lead}<button type="button" class="mention${isPerson ? "" : " mention-all"}" data-mention="${esc(
      key
    )}" title="${esc(title)}">${esc(label)}</button>`;
  });
}

/** Links first, mentions second — so an `@` inside a URL never becomes a chip. */
function paintBody(body, mentions = []) {
  const named = new Set();
  let everyone = false;
  for (const mention of mentions || []) {
    if (mention.kind === "everyone") everyone = true;
    else if (mention.username) named.add(String(mention.username).toLowerCase());
  }

  const text = String(body || "");
  const urlRe = /https?:\/\/[^\s<]+/gi;
  let out = "";
  let cursor = 0;
  let match;
  while ((match = urlRe.exec(text))) {
    out += paintMentions(text.slice(cursor, match.index), named, everyone);
    const raw = match[0];
    const clean = raw.replace(/[),.!?]+$/, "");
    const tail = raw.slice(clean.length);
    out += `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a>${esc(tail)}`;
    cursor = match.index + raw.length;
  }
  out += paintMentions(text.slice(cursor), named, everyone);
  return out;
}

/* ---------------------------------------------------------------- the surface */

export default async function mountGroups(root, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "chat group-chat";
  wrap.innerHTML = `
    <aside class="chat-pane chat-pane-list">
      <div class="chat-pane-head">
        <div class="chat-pane-title">${icon("users", { size: 15 })}<span>Groups</span></div>
        <div class="pane-head-actions">
          <button class="btn btn-primary btn-sm" type="button" id="grp-new">${icon("plus", { size: 13 })}New</button>
          <button class="btn btn-ghost btn-sm" type="button" id="grp-refresh" aria-label="Refresh groups">${icon(
            "refresh-cw",
            { size: 13 }
          )}</button>
        </div>
      </div>
      <div class="chat-list" id="grp-list"><div class="chat-empty-line">Loading groups…</div></div>
    </aside>

    <section class="chat-pane chat-pane-thread">
      <div class="chat-thread-head" id="grp-head">
        <div class="grp-head-lead">
          <span class="grp-head-avatar" id="grp-avatar" hidden></span>
          <div class="dm-head-identity">
            <div class="chat-thread-title">Groups</div>
            <div class="chat-thread-sub">Pick a group, or start one. Only members can read what is posted here.</div>
          </div>
        </div>
        <div class="pane-head-actions">
          <button class="btn btn-ghost btn-sm" type="button" id="grp-call" hidden>
            ${icon("video", { size: 13 })}<span>Meet</span>
          </button>
          <button class="btn btn-ghost btn-sm" type="button" id="grp-info" hidden>${icon("info", { size: 13 })}<span>Group info</span></button>
        </div>
      </div>

      <div class="chat-messages" id="grp-messages">
        <div class="chat-empty-line">No group open.</div>
      </div>

      <form class="chat-compose" id="grp-compose" hidden>
        <div class="mention-pop" id="grp-mentions" role="listbox" aria-label="Mention somebody in this group" hidden></div>
        <div class="team-compose-tools" aria-label="Message tools">
          ${QUICK_EMOJI.map(
            (emoji) =>
              `<button class="btn btn-ghost btn-sm" type="button" data-emoji="${emoji}" aria-label="Insert ${emoji}">${emoji}</button>`
          ).join("")}
          <label class="btn btn-ghost btn-sm" for="grp-files" title="Attach a picture or PDF">
            ${icon("paperclip", { size: 14 })}<span>Attach</span>
          </label>
          <input id="grp-files" type="file" hidden multiple
                 accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" />
          <span class="grp-file-count" id="grp-file-count" hidden></span>
        </div>
        <div class="grp-pending" id="grp-pending" hidden></div>
        <label class="sr-only" for="grp-body">Message</label>
        <textarea class="textarea chat-input" id="grp-body" rows="2" maxlength="4000"
          placeholder="Write a message… type @ to mention somebody"></textarea>
        <button class="btn btn-primary chat-send" type="submit" id="grp-send">${icon("send", { size: 15 })}<span>Send</span></button>
      </form>
    </section>`;
  root.appendChild(wrap);

  const listEl = qs("#grp-list", wrap);
  const headEl = qs("#grp-head", wrap);
  const avatarEl = qs("#grp-avatar", wrap);
  const infoBtn = qs("#grp-info", wrap);
  const messagesEl = qs("#grp-messages", wrap);
  const formEl = qs("#grp-compose", wrap);
  const bodyEl = qs("#grp-body", wrap);
  const popEl = qs("#grp-mentions", wrap);
  const filesInput = qs("#grp-files", wrap);
  const pendingEl = qs("#grp-pending", wrap);
  const fileCountEl = qs("#grp-file-count", wrap);

  let me = null;
  let groups = [];
  let active = options.groupId || null;
  let detail = null; // group_get payload for the open group
  let candidateCache = [];
  let popItems = [];
  let popIndex = 0;
  let popRange = null;
  let popSeq = 0;
  /** Files chosen but not sent yet. Cleared on send, on group change and on leave. */
  let pending = [];
  /** Signed URLs for attachments already on screen, so a repaint does not re-sign. */
  const signedCache = new Map();

  /* ------------------------------------------------------------------- list */
  function paintList() {
    if (!groups.length) {
      listEl.innerHTML = `<div class="chat-empty-line">You are not in a group yet. Press <strong>New</strong> to create one, then add people you work with.</div>`;
      return;
    }
    listEl.innerHTML = groups
      .map((group) => {
        const mine = group.id === active;
        return `<button class="chat-item${mine ? " is-active" : ""}${Number(group.unread) ? " has-unread" : ""}"
          type="button" data-group="${esc(group.id)}">
          <span class="chat-avatar-wrap grp-avatar-wrap">${avatarMarkup({
            name: group.name,
            avatarUrl: group.avatarUrl,
            alt: `${group.name} picture`
          })}</span>
          <span class="chat-item-body">
            <span class="chat-item-top">
              <span class="chat-item-name">${esc(group.name)}</span>
              <span class="chat-item-time">${group.lastMessageAt ? esc(timeAgo(group.lastMessageAt)) : ""}</span>
            </span>
            <span class="chat-item-snippet">${
              group.lastMessage
                ? `${group.lastSender ? `${esc(group.lastSender)}: ` : ""}${esc(String(group.lastMessage).slice(0, 80))}`
                : `${Number(group.memberCount) || 1} member${Number(group.memberCount) === 1 ? "" : "s"}`
            }</span>
          </span>
          ${Number(group.unread) ? `<span class="chat-unread">${esc(group.unread)}</span>` : ""}
        </button>`;
      })
      .join("");
  }

  async function loadList() {
    const rows = await rpc("group_my_groups");
    groups = Array.isArray(rows) ? rows : [];
    paintList();
    return groups;
  }

  /* ----------------------------------------------------------------- thread */
  /** The first thing a new member sees: one sentence and one button. */
  function paintEmptyGroups() {
    messagesEl.innerHTML = `<div class="grp-empty">
        <span class="grp-empty-mark">${icon("users", { size: 22 })}</span>
        <h3 class="grp-empty-title">No groups yet</h3>
        <p class="grp-empty-desc">
          A group is a private room: you choose who is in it, and only they can read
          what is posted. Mentions work inside groups — type <strong>@</strong> to call
          somebody out by handle.
        </p>
        <button class="btn btn-primary" type="button" data-new-group>
          ${icon("plus", { size: 14 })}<span>Create your first group</span>
        </button>
        <p class="grp-empty-foot">You become the owner. Add people once it exists.</p>
      </div>`;
    formEl.hidden = true;
  }

  function paintHead(group) {
    const title = qs(".chat-thread-title", headEl);
    const sub = qs(".chat-thread-sub", headEl);
    if (!group) {
      qs(".grp-head-avatar", wrap).hidden = true;
      if (title) title.textContent = "Groups";
      if (sub) sub.textContent = "Pick a group, or start one. Only members can read what is posted here.";
      infoBtn.hidden = true;
      qs("#grp-call", wrap).hidden = true;
      return;
    }
    avatarEl.hidden = false;
    paintAvatar(avatarEl, {
      name: group.name,
      avatarUrl: group.avatarUrl,
      alt: `${group.name} picture`
    });
    if (title) title.textContent = group.name;
    const count = (group.members || []).length;
    const role = ROLE_LABEL[group.role] || "Member";
    if (sub) {
      sub.textContent = `${count} member${count === 1 ? "" : "s"} · you are ${role.toLowerCase()}${
        group.description ? ` · ${group.description}` : ""
      }`;
    }
    infoBtn.hidden = false;
    qs("#grp-call", wrap).hidden = false;
  }

  async function open(id, focusMessageId = null) {
    active = id;
    paintList();
    messagesEl.innerHTML = `<div class="chat-empty-line">Loading…</div>`;
    formEl.hidden = true;
    try {
      detail = await rpc("group_get", { p_group: id });
      paintHead(detail);
      const rows = await rpc("group_messages_list", { p_group: id, p_limit: 80 });
      paintThread(Array.isArray(rows) ? rows : [], focusMessageId);
      formEl.hidden = false;
      bodyEl.focus({ preventScroll: true });
      await rpc("group_mark_read", { p_group: id });
      watchThisGroup();
      await loadList();
    } catch (error) {
      detail = null;
      paintHead(null);
      messagesEl.innerHTML = `<div class="chat-empty-line">${esc(
        error.message || "This group could not be opened."
      )}</div>`;
      toastError(error);
    }
  }

  /* ---------------------------------------------------------------- files */

  function renderPending() {
    pendingEl.hidden = pending.length === 0;
    fileCountEl.hidden = pending.length === 0;
    fileCountEl.textContent = pending.length ? `${pending.length} attached` : "";
    pendingEl.innerHTML = pending
      .map(
        (file, index) => `<span class="grp-pending-item">
            ${icon(file.type === "application/pdf" ? "file-text" : "image", { size: 12 })}
            <span class="grp-pending-name">${esc(file.name)}</span>
            <span class="grp-pending-size">${Math.round(file.size / 1024)} KB</span>
            <button type="button" class="grp-pending-x" data-drop-pending="${index}" aria-label="Remove ${esc(
              file.name
            )}">${icon("x", { size: 11 })}</button>
          </span>`
      )
      .join("");
  }

  function acceptFiles(list) {
    const incoming = [...list];
    if (!incoming.length) return;
    for (const file of incoming) {
      if (!ALLOWED_FILES.has(file.type)) {
        toastError(new Error(`${file.name} is not a JPEG, PNG, WebP, GIF or PDF.`));
        continue;
      }
      if (!file.size || file.size > MAX_FILE_BYTES) {
        toastError(new Error(`${file.name} is over 20 MB.`));
        continue;
      }
      if (pending.length >= 5) {
        toastError(new Error("Five files at most in one message."));
        break;
      }
      pending.push(file);
    }
    renderPending();
  }

  on(filesInput, "change", () => {
    acceptFiles(filesInput.files || []);
    filesInput.value = "";
  });

  delegate(pendingEl, "click", "[data-drop-pending]", (_event, button) => {
    pending.splice(Number(button.getAttribute("data-drop-pending")), 1);
    renderPending();
  });

  /* Dragging a picture onto the thread is how most people attach one. */
  on(messagesEl, "dragover", (event) => {
    if (!detail) return;
    event.preventDefault();
    messagesEl.classList.add("is-drop-target");
  });
  on(messagesEl, "dragleave", () => messagesEl.classList.remove("is-drop-target"));
  on(messagesEl, "drop", (event) => {
    if (!detail) return;
    event.preventDefault();
    messagesEl.classList.remove("is-drop-target");
    acceptFiles(event.dataTransfer?.files || []);
  });

  /** Upload everything pending, in order, and return the attachment objects. */
  async function uploadPending() {
    const uploaded = [];
    for (const file of pending) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
      /* The path starts with the group id and then the uploader's id: the
         storage policies in 0039 read both straight out of it. */
      const path = `${active}/${me}/${crypto.randomUUID()}-${cleanName}`;
      const { error } = await sb.storage
        .from(FILES_BUCKET)
        .upload(path, file, { upsert: false, contentType: file.type });
      if (error) throw normalizeError(error);
      uploaded.push({ path, name: file.name, mime: file.type, size: file.size });
    }
    return uploaded;
  }

  async function attachmentUrl(path) {
    if (signedCache.has(path)) return signedCache.get(path);
    const { data, error } = await sb.storage.from(FILES_BUCKET).createSignedUrl(path, 3600);
    const url = error ? "" : data?.signedUrl || "";
    signedCache.set(path, url);
    return url;
  }

  /**
   * An attachment as markup.
   *
   * Pictures are shown as pictures — a group where you have to click a filename
   * to see a photo is not a group people will use. Everything else is a link,
   * and a link that could not be signed says so instead of looking broken.
   */
  async function attachmentMarkup(file) {
    const isImage = String(file.mime || "").startsWith("image/");
    const url = await attachmentUrl(file.path);
    if (!url) {
      return `<span class="grp-attach is-broken">${icon("triangle-alert", { size: 12 })}${esc(
        file.name || "Attachment"
      )} · could not be opened</span>`;
    }
    if (isImage) {
      return `<a class="grp-attach-image" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
          <img src="${esc(url)}" alt="${esc(file.name || "Attached picture")}" loading="lazy" decoding="async" />
        </a>`;
    }
    return `<a class="team-attachment" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
        ${icon("file-text", { size: 13 })}${esc(file.name || "Attachment")}
      </a>`;
  }

  async function paintThread(rows, focusMessageId = null) {
    if (!rows.length) {
      messagesEl.innerHTML = `<div class="chat-empty-line">Nothing here yet. Say hello — the others will see it in their notifications.</div>`;
      return;
    }
    /* Sign every attachment before painting: a signed URL needs an await, and a
       bubble that renders before its picture is ready would flash broken. */
    const painted = await Promise.all(
      rows.map(async (message) => ({
        message,
        attachments: (message.attachments || []).length
          ? (await Promise.all(message.attachments.map(attachmentMarkup))).join("")
          : ""
      }))
    );

    let lastAuthor = null;
    messagesEl.innerHTML = painted
      .map(({ message, attachments }) => {
        const mine = message.authorId === me;
        const showWho = message.authorId !== lastAuthor;
        lastAuthor = message.authorId;
        const highlighted = focusMessageId && message.id === focusMessageId;
        return `<div class="bubble-row${mine ? " is-mine" : ""}${highlighted ? " is-focused" : ""}" data-message="${esc(
          message.id
        )}">
          ${showWho && !mine ? `<span class="bubble-avatar">${initials(message.authorName || "Member")}</span>` : ""}
          <div class="bubble${mine ? " bubble-mine" : ""}">
            ${mine || !showWho ? "" : `<div class="bubble-who">${esc(message.authorName || "Member")}</div>`}
            ${message.body ? `<div class="bubble-text">${paintBody(message.body, message.mentions)}</div>` : ""}
            ${attachments ? `<div class="grp-attachments">${attachments}</div>` : ""}
            <div class="bubble-time" title="${esc(dateTime(message.createdAt))}">${esc(timeAgo(message.createdAt))}</div>
          </div>
        </div>`;
      })
      .join("");

    if (focusMessageId) {
      const node = qs(`[data-message="${focusMessageId}"]`, messagesEl);
      if (node) {
        node.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => node.classList.remove("is-focused"), 2600);
      }
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ----------------------------------------------------------- @ autocomplete */
  function hidePop() {
    popEl.hidden = true;
    popEl.innerHTML = "";
    popItems = [];
    popRange = null;
  }

  /**
 * Put text where the caret is.
 *
 * `setRangeText` is the clean way and is what browsers use, but it is not
 * universal (older Safari, some embedded webviews), and when it is missing the
 * @ menu would silently insert nothing. The splice path is the fallback, and it
 * restores the caret to just after the inserted text either way.
 */
function insertAtCaret(field, text, start, end) {
  if (typeof field.setRangeText === "function") {
    field.setRangeText(text, start, end, "end");
    return;
  }
  const value = String(field.value || "");
  field.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
  const caret = start + text.length;
  try {
    field.selectionStart = caret;
    field.selectionEnd = caret;
  } catch {
    /* a field that cannot hold a selection simply keeps the text */
  }
}

/** The `@word` immediately before the caret, if the caret sits inside one. */
  function mentionSpot() {
    const caret = bodyEl.selectionStart ?? 0;
    const before = bodyEl.value.slice(0, caret);
    const match = before.match(/(^|[\s\u00a0])@([a-zA-Z0-9._-]{0,32})$/);
    if (!match) return null;
    return { start: caret - match[2].length - 1, end: caret, term: match[2] };
  }

  function canEveryone() {
    if (!detail?.allowEveryoneMentions) return false;
    if (!detail.everyoneMentionsAdmins) return true;
    return detail.role === "owner" || detail.role === "admin";
  }

  async function candidates(term) {
    const seq = ++popSeq;
    const rows = await rpc("group_mention_candidates", {
      p_group: active,
      p_query: term || null
    });
    if (seq !== popSeq) return null; // a newer keystroke already asked
    candidateCache = Array.isArray(rows) ? rows : [];
    const list = candidateCache
      .filter((person) => person.userId !== me)
      .map((person) => ({
        key: person.username,
        name: person.name || person.username || "Member",
        username: person.username,
        role: person.role,
        avatarUrl: person.avatarUrl
      }));

    const every = canEveryone();
    const needle = String(term || "").toLowerCase();
    if (every && (!needle || "everyone".startsWith(needle) || "all".startsWith(needle))) {
      list.unshift({
        key: every && needle.startsWith("all") ? "all" : "everyone",
        name: "Everyone in this group",
        username: "everyone",
        everyone: true
      });
    }
    /* With no term typed, everybody; otherwise a second filter so a slow RPC
       cannot show the wrong people under what you are typing. */
    return needle ? list.filter((item) => item.everyone || String(item.key).toLowerCase().includes(needle)) : list;
  }

  function paintPop() {
    if (!popItems.length) {
      hidePop();
      return;
    }
    popEl.hidden = false;
    popEl.innerHTML = popItems
      .map(
        (item, index) => `<button type="button" role="option" aria-selected="${index === popIndex}"
          class="mention-row${index === popIndex ? " is-active" : ""}" data-pick="${index}">
          <span class="mention-row-avatar">${
            item.everyone
              ? icon("megaphone", { size: 13 })
              : avatarMarkup({ name: item.name, avatarUrl: item.avatarUrl, alt: "" })
          }</span>
          <span class="mention-row-body">
            <span class="mention-row-name">${esc(item.name)}</span>
            <span class="mention-row-handle mono">@${esc(item.username)}</span>
          </span>
          ${item.everyone ? "" : `<span class="mention-row-role">${esc(ROLE_LABEL[item.role] || "")}</span>`}
        </button>`
      )
      .join("");
  }

  let popTimer = null;
  function schedulePop() {
    const spot = mentionSpot();
    clearTimeout(popTimer);
    if (!spot) {
      hidePop();
      return;
    }
    popRange = { start: spot.start, end: spot.end };
    popTimer = setTimeout(async () => {
      try {
        const list = await candidates(spot.term);
        if (!list || !popRange) return;
        popItems = list;
        popIndex = 0;
        paintPop();
      } catch (error) {
        hidePop();
        if (error?.message) toastError(error);
      }
    }, 130);
  }

  function insertMention(item) {
    if (!item || !popRange) return;
    insertAtCaret(bodyEl, `@${item.key} `, popRange.start, popRange.end);
    bodyEl.focus();
    hidePop();
  }

  on(bodyEl, "input", schedulePop);

  on(bodyEl, "blur", () => {
    /* A click on the popup fires before blur on most browsers, but a delayed
       hide keeps both orders working. */
    setTimeout(hidePop, 120);
  });

  on(bodyEl, "keydown", (event) => {
    if (!popEl.hidden && popItems.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        popIndex = (popIndex + (event.key === "ArrowDown" ? 1 : popItems.length - 1)) % popItems.length;
        paintPop();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(popItems[popIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hidePop();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  delegate(popEl, "mousedown", "[data-pick]", (event, button) => {
    event.preventDefault();
    insertMention(popItems[Number(button.getAttribute("data-pick"))]);
  });

  /* ------------------------------------------------------------------- send */
  on(formEl, "submit", async (event) => {
    event.preventDefault();
    if (!active) return;
    const body = bodyEl.value.trim();
    if (!body && !pending.length) return;
    const send = qs("#grp-send", wrap);
    const label = qs("span", send);
    send.disabled = true;
    if (label && pending.length) label.textContent = "Sending…";
    try {
      const attachments = pending.length ? await uploadPending() : [];
      await rpc("group_send", { p_group: active, p_body: body, p_attachments: attachments });
      bodyEl.value = "";
      pending = [];
      renderPending();
      hidePop();
      await open(active);
    } catch (error) {
      /* A refused `@everyone`, a non-member mention or a rejected file arrives
         here as the database's own words. The pending files stay put so nothing
         the member chose is lost. */
      toastError(error);
    } finally {
      send.disabled = false;
      if (label) label.textContent = "Send";
    }
  });

  delegate(formEl, "click", "[data-emoji]", (_event, button) => {
    const start = bodyEl.selectionStart ?? bodyEl.value.length;
    insertAtCaret(bodyEl, button.dataset.emoji, start, bodyEl.selectionEnd ?? start);
    bodyEl.focus();
  });

  /* ---------------------------------------------------------------- calls */

  /* One meeting at a time per tab. Starting a second would open a second
     microphone stream and confuse the level meter. */
  let currentCall = null;
  let stopWatching = () => {};
  let ringDismiss = null;
  let watchedTopic = null;

  function closeCall() {
    currentCall?.leave("The call ended.");
    currentCall = null;
  }

  async function joinMeeting({ ringing = false } = {}) {
    if (!detail) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toastError(
        new Error("This browser cannot capture audio or video. Calls need an https address and a modern browser.")
      );
      return;
    }

    const call = createCall({
      kind: "video",
      topic: callTopics.group(detail.id),
      title: detail.name,
      self: { userId: me, name: selfName() }
    });
    currentCall = call;

    openCallSurface({
      call,
      self: { userId: me, name: selfName() },
      subtitle: `${detail.name} · ${(detail.members || []).length} members`,
      onClose: () => {
        if (currentCall === call) currentCall = null;
      }
    });

    try {
      /* Somebody already in the room may not have a camera (they joined voice
         only), so falling back to audio is better than refusing to join. */
      await call.join({ audioOnly: false });
    } catch (error) {
      const message = String(error?.message || "");
      if (/camera|video/i.test(message)) {
        try {
          await call.join({ audioOnly: true });
          toastError(new Error("Joined with the microphone only — no camera was available."));
          return;
        } catch (second) {
          toastError(second);
          return;
        }
      }
      if (/refused|channel|member/i.test(message)) {
        toastError(new Error(`${message} Meeting links only work for members.`));
        return;
      }
      if (!turnConfigured()) {
        toastError(
          new Error(
            `${message} If this happens on a mobile network, a TURN relay is required — it is not configured on this deployment yet.`
          )
        );
        return;
      }
      toastError(error);
    }
  }

  function selfName() {
    const mine = (detail?.members || []).find((row) => row.userId === me);
    return mine?.name || "You";
  }

  /** Watch this group's call topic so a ring can be shown while it is open. */
  function watchThisGroup() {
    if (!detail) return;
    const topic = callTopics.group(detail.id);
    if (watchedTopic === topic) return;
    stopWatching();
    watchedTopic = topic;
    stopWatching = watchForCalls(sb, {
      topics: [topic],
      onRing: ({ ended, from, name }) => {
        if (ended) {
          ringDismiss?.();
          return;
        }
        if (currentCall) return; // already in the meeting
        ringDismiss?.();
        ringDismiss = showRingBanner({
          name: name || "Somebody",
          kind: "video",
          groupName: detail.name,
          onJoin: () => {
            ringDismiss = null;
            joinMeeting({ ringing: true });
          },
          onDismiss: () => {
            ringDismiss = null;
          }
        });
      }
    });
  }

  on(qs("#grp-call", wrap), "click", () => joinMeeting());

  /* ------------------------------------------------------------- group info */
  function memberRow(member) {
    const isMe = member.userId === me;
    const canPromote = detail.role === "owner" && member.role !== "owner";
    const canRemove =
      member.role !== "owner" &&
      (detail.role === "owner" || (detail.role === "admin" && member.role === "member"));
    const canTransfer = detail.role === "owner" && member.role === "admin";
    return `<div class="grp-member" data-member="${esc(member.userId)}">
      <button class="grp-member-ident" type="button" data-profile="${esc(member.username || "")}">
        ${avatarMarkup({ name: member.name, avatarUrl: member.avatarUrl, alt: "" })}
        <span class="grp-member-meta">
          <span class="grp-member-name">${esc(member.name || "Member")}${isMe ? " · you" : ""}</span>
          <span class="grp-member-handle mono">@${esc(member.username || "")}</span>
        </span>
      </button>
      <span class="grp-role is-${esc(member.role)}">${esc(ROLE_LABEL[member.role] || member.role)}</span>
      ${
        canPromote || canRemove || canTransfer
          ? `<span class="grp-member-actions">
              ${canPromote ? `<button class="btn btn-ghost btn-sm" type="button" data-role-member="${esc(member.userId)}" data-role="${
                member.role === "admin" ? "member" : "admin"
              }">${member.role === "admin" ? "Demote" : "Make admin"}</button>` : ""}
              ${canTransfer ? `<button class="btn btn-ghost btn-sm" type="button" data-transfer="${esc(member.userId)}">Make owner</button>` : ""}
              ${canRemove ? `<button class="btn btn-ghost btn-sm is-danger" type="button" data-remove="${esc(member.userId)}">Remove</button>` : ""}
            </span>`
          : ""
      }
    </div>`;
  }

  function openInfo() {
    if (!detail) return;
    const canManage = Boolean(detail.canManage);
    const members = detail.members || [];
    const mine = members.find((row) => row.userId === me) || null;
    const modal = openModal({
      title: detail.name,
      desc: detail.description || "Group",
      size: "lg",
      body: `
        <div class="grp-info-head">
          <div class="grp-info-avatar">${avatarMarkup({
            name: detail.name,
            avatarUrl: detail.avatarUrl,
            alt: `${detail.name} picture`
          })}</div>
          <div class="grp-info-summary">
            <div class="grp-info-line"><strong>${members.length}</strong> member${members.length === 1 ? "" : "s"}</div>
            <div class="grp-info-line">You are ${esc((ROLE_LABEL[detail.role] || "Member").toLowerCase())}</div>
            <div class="grp-info-line muted">Everyone mentions: ${
              detail.allowEveryoneMentions
                ? detail.everyoneMentionsAdmins
                  ? "admins only"
                  : "any member"
                : "off"
            }</div>
          </div>
          ${
            canManage
              ? `<div class="grp-info-tools">
                  <label class="btn btn-ghost btn-sm" for="grp-picture">${icon("image", { size: 13 })}<span>Change picture</span></label>
                  <input id="grp-picture" type="file" accept="image/png,image/jpeg,image/webp" hidden />
                  <button class="btn btn-ghost btn-sm" type="button" data-edit-group>${icon("settings", { size: 13 })}<span>Edit</span></button>
                  <button class="btn btn-ghost btn-sm" type="button" data-add-people>${icon("user-plus", { size: 13 })}<span>Add people</span></button>
                </div>`
              : detail.allowMemberInvites
              ? `<div class="grp-info-tools">
                  <button class="btn btn-ghost btn-sm" type="button" data-add-people>${icon("user-plus", { size: 13 })}<span>Add people</span></button>
                </div>`
              : ""
          }
        </div>
        <div class="grp-member-list">${members.map(memberRow).join("")}</div>
        <div class="grp-info-footer">
          <button class="btn btn-ghost btn-sm" type="button" data-toggle-mute>
            ${icon(mine?.muted ? "bell-ring" : "bell", { size: 13 })}
            <span>${mine?.muted ? "Unmute this group" : "Mute this group"}</span>
          </button>
          ${
            detail.isOwner
              ? `<span class="muted">Ownership moves only with “Make owner”.</span>`
              : `<button class="btn btn-ghost btn-sm is-danger" type="button" data-leave-group>Leave group</button>`
          }
        </div>`,
      onMount: (root2) => {
        delegate(root2, "click", "[data-profile]", (_event, button) => {
          const handle = button.getAttribute("data-profile");
          if (handle) openProfile(handle);
        });

        delegate(root2, "click", "[data-role-member]", async (_event, button) => {
          const userId = button.getAttribute("data-role-member");
          const role = button.getAttribute("data-role");
          try {
            await rpc("group_set_role", { p_group: detail.id, p_user: userId, p_role: role });
            modal.close();
            await open(detail.id);
            toast({ title: role === "admin" ? "Group admin added" : "Back to member" }, { tone: "success" });
          } catch (error) {
            toastError(error);
          }
        });

        delegate(root2, "click", "[data-transfer]", async (_event, button) => {
          const userId = button.getAttribute("data-transfer");
          const person = members.find((row) => row.userId === userId);
          const yes = await confirmDialog({
            title: "Hand over ownership?",
            desc: `${person?.name || "This member"} becomes the owner and you become a group admin. Only the owner can undo it.`,
            confirmLabel: "Make owner"
          });
          if (!yes) return;
          try {
            await rpc("group_transfer_owner", { p_group: detail.id, p_user: userId });
            modal.close();
            await loadList();
            await open(detail.id);
          } catch (error) {
            toastError(error);
          }
        });

        delegate(root2, "click", "[data-remove]", async (_event, button) => {
          const userId = button.getAttribute("data-remove");
          const person = members.find((row) => row.userId === userId);
          const yes = await confirmDialog({
            title: "Remove from group?",
            desc: `${person?.name || "This member"} loses access to the group and its history immediately.`,
            confirmLabel: "Remove"
          });
          if (!yes) return;
          try {
            await rpc("group_remove_member", { p_group: detail.id, p_user: userId });
            modal.close();
            await open(detail.id);
          } catch (error) {
            toastError(error);
          }
        });

        delegate(root2, "click", "[data-toggle-mute]", async () => {
          if (!mine) return;
          try {
            /* Muting stops that group's message notices. Mentions the member is
               allowed to receive still arrive — the database decides, and
               `group_send` keeps them. */
            await rpc("group_set_muted", { p_group: detail.id, p_muted: !mine.muted });
            modal.close();
            await open(detail.id);
          } catch (error) {
            toastError(error);
          }
        });

        delegate(root2, "click", "[data-leave-group]", async () => {
          const yes = await confirmDialog({
            title: "Leave this group?",
            desc: "You will stop receiving its messages and notifications.",
            confirmLabel: "Leave"
          });
          if (!yes) return;
          try {
            await rpc("group_leave", { p_group: detail.id });
            modal.close();
            active = null;
            detail = null;
            paintHead(null);
            formEl.hidden = true;
            messagesEl.innerHTML = `<div class="chat-empty-line">No group open.</div>`;
            await loadList();
            if (groups.length) await open(groups[0].id);
          } catch (error) {
            toastError(error);
          }
        });

        delegate(root2, "click", "[data-add-people]", () => openAddPeople(modal));
        delegate(root2, "click", "[data-edit-group]", () => openEdit(modal));

        on(qs("#grp-picture", root2), "change", async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            await uploadPicture(file);
            modal.close();
            await open(detail.id);
            await loadList();
            toast({ title: "Group picture updated" }, { tone: "success" });
          } catch (error) {
            toastError(error);
          }
        });
      }
    });
  }

  async function uploadPicture(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use a PNG, JPEG or WebP image.");
    if (file.size > MAX_PICTURE_BYTES) throw new Error("Keep the picture under 4 MB.");
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    /* The existing `avatars` bucket only lets you write inside your own folder,
       so a group picture is filed under the manager who uploaded it. Reusing
       that bucket means no new storage policy to get wrong. */
    const path = `${me}/group-${detail.id}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw normalizeError(error);
    const { data } = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    await rpc("group_update", { p_group: detail.id, p_avatar_url: data?.publicUrl || "" });
  }

  function openEdit(previous) {
    formDialog({
      title: "Edit group",
      desc: "Name, description and who may use @everyone.",
      submitLabel: "Save changes",
      fields: [
        { name: "name", label: "Group name", value: detail.name, required: true },
        { name: "description", label: "Description", type: "textarea", rows: 3, value: detail.description || "" },
        {
          name: "everyone",
          label: "Who may use @everyone",
          type: "select",
          value: !detail.allowEveryoneMentions ? "off" : detail.everyoneMentionsAdmins ? "admins" : "members",
          options: [
            { value: "off", label: "Nobody" },
            { value: "admins", label: "Owner and group admins only" },
            { value: "members", label: "Any member" }
          ]
        },
        {
          name: "invites",
          label: "Who may add people",
          type: "select",
          value: detail.allowMemberInvites ? "members" : "managers",
          options: [
            { value: "managers", label: "Owner and group admins only" },
            { value: "members", label: "Any member" }
          ]
        }
      ]
    }).then(async (values) => {
      if (!values) return;
      try {
        await rpc("group_update", {
          p_group: detail.id,
          p_name: values.name,
          p_description: values.description,
          p_allow_everyone_mentions: values.everyone !== "off",
          p_everyone_mentions_admins: values.everyone === "admins",
          p_allow_member_invites: values.invites === "members"
        });
        previous?.close();
        await loadList();
        await open(detail.id);
        toast({ title: "Group updated" }, { tone: "success" });
      } catch (error) {
        toastError(error);
      }
    });
  }

  function openAddPeople(previous) {
    const modal = openModal({
      title: "Add people",
      desc: "Search by username. Whoever you add can read this group's history from now on.",
      body: `
        <div class="dm-search-field grp-invite-field">
          ${icon("search", { size: 14 })}
          <input class="input" id="grp-invite-search" type="search" placeholder="Find a member by username"
                 autocomplete="off" spellcheck="false" aria-label="Find a member by username" />
        </div>
        <div class="grp-invite-results" id="grp-invite-results"><div class="chat-empty-line">Type at least two characters.</div></div>`,
      onMount: (root2) => {
        const search = qs("#grp-invite-search", root2);
        const results = qs("#grp-invite-results", root2);
        const present = new Set((detail.members || []).map((row) => row.userId));
        let timer = null;

        on(search, "input", () => {
          const term = search.value.trim();
          clearTimeout(timer);
          if (term.length < 2) {
            results.innerHTML = `<div class="chat-empty-line">Type at least two characters.</div>`;
            return;
          }
          timer = setTimeout(async () => {
            try {
              const rows = await rpc("dm_search_people", { p_query: term });
              const people = (Array.isArray(rows) ? rows : []).filter((person) => !present.has(person.userId));
              results.innerHTML = people.length
                ? people
                    .map(
                      (person) => `<button class="dm-search-row" type="button" data-invite="${esc(person.userId)}">
                        ${avatarMarkup({ name: person.fullName, avatarUrl: person.avatarUrl, alt: "" })}
                        <span class="dm-search-meta">
                          <span class="dm-search-name">${esc(person.fullName || person.username)}</span>
                          <span class="dm-search-handle mono">@${esc(person.username || "")}</span>
                        </span>
                        <span class="dm-search-go">${icon("plus", { size: 13 })}</span>
                      </button>`
                    )
                    .join("")
                : `<div class="chat-empty-line">Nobody new matches that handle, or they are already in this group.</div>`;
            } catch (error) {
              results.innerHTML = `<div class="chat-empty-line">${esc(error.message || "Search failed.")}</div>`;
            }
          }, 220);
        });

        delegate(results, "click", "[data-invite]", async (_event, button) => {
          const userId = button.getAttribute("data-invite");
          try {
            await rpc("group_add_member", { p_group: detail.id, p_user: userId });
            present.add(userId);
            button.closest(".dm-search-row")?.remove();
            await loadList();
            toast({ title: "Added to the group" }, { tone: "success" });
          } catch (error) {
            toastError(error);
          }
        });
      }
    });
    previous?.close();
  }

  /* ------------------------------------------------------------------ events */
  delegate(listEl, "click", "[data-group]", (_event, button) => open(button.getAttribute("data-group")));
  on(infoBtn, "click", openInfo);

  on(qs("#grp-refresh", wrap), "click", async () => {
    try {
      await loadList();
      if (active) await open(active);
    } catch (error) {
      toastError(error);
    }
  });

  async function createGroup() {
    const values = await formDialog({
      title: "New group",
      desc: "You become the owner. Add people once it exists.",
      submitLabel: "Create group",
      fields: [
        { name: "name", label: "Group name", required: true, placeholder: "Design team" },
        {
          name: "description",
          label: "What is it for?",
          type: "textarea",
          rows: 3,
          placeholder: "Weekly reviews, files and decisions."
        }
      ]
    });
    if (!values) return;
    try {
      const created = await rpc("group_create", { p_name: values.name, p_description: values.description || null });
      await loadList();
      await open(created.id);
      toast({ title: "Group created", message: "You are the owner of this group." }, { tone: "success" });
      /* A group of one is not useful, so the next step is offered rather than
         left to be discovered inside Group info. */
      openInfo();
    } catch (error) {
      toastError(error);
    }
  }

  on(qs("#grp-new", wrap), "click", createGroup);
  delegate(messagesEl, "click", "[data-new-group]", createGroup);

  /* Mention chips open the person's profile. `@everyone` has nobody to open. */
  delegate(messagesEl, "click", ".mention[data-mention]", (_event, chip) => {
    const key = chip.getAttribute("data-mention");
    if (!key || key === "everyone" || key === "all") return;
    openProfile(key);
  });

  /* -------------------------------------------------------------------- boot */
  try {
    const { data } = await sb.auth.getUser();
    me = data?.user?.id || null;
    await loadList();
    /* Another window (or the notification layer in this one) saw a group
       message. Reload the list so unread counts are honest, and only re-render
       a thread the member is actually looking at. */
    if (mountGroups.__detach) mountGroups.__detach();
    const liveHandler = (event) => {
      const detail = event.detail || {};
      if (!detail.groupId) return;
      loadList()
        .then(() => {
          if (detail.groupId === active && !document.hidden) return open(active, detail.messageId || null);
          return null;
        })
        .catch(() => {});
    };
    document.addEventListener("shinzora:group-message", liveHandler);
    mountGroups.__detach = () => {
      document.removeEventListener("shinzora:group-message", liveHandler);
      /* A navigated-away page must not keep the microphone open. */
      closeCall();
      stopWatching();
      ringDismiss?.();
    };

    const wanted = options.groupId && groups.find((group) => group.id === options.groupId);
    if (wanted) await open(wanted.id, options.messageId || null);
    else if (groups.length) await open(groups[0].id, options.messageId || null);
    else {
      paintHead(null);
      paintEmptyGroups();
    }
  } catch (error) {
    listEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "Groups could not be loaded.")}</div>`;
  }

  return {
    open,
    refresh: loadList,
    /** Called by the notification layer when a group message arrives live. */
    async onGroupMessage(groupId, messageId) {
      await loadList();
      if (groupId === active && !document.hidden) await open(active, messageId || null);
    }
  };
}
