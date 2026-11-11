/* ==========================================================================
   Shinzora · Messages
   --------------------------------------------------------------------------
   One inbox, two kinds of conversation:

     personal   between two members, found by username. No business involved.
     team       a room inside a business, visible to that business's members.

   Both are rows in the same table and both are read through the same
   membership-checked RPCs, so there is one list, one thread view and one send
   path rather than three. Access is decided by the database: the browser never
   chooses who is in a conversation.

   Search is by username or name — deliberately not by email, because an address
   is not a public identifier.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { timeAgo, dateTime, initials } from "../../lib/format.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { state } from "../../lib/store.js";
import { toast, toastError } from "../../ui/toast.js";
import { presenceDot, presenceState, presenceLabel } from "../../ui/presence.js";
import { createCall, callTopics, turnConfigured } from "./webrtc.js";
import { openCallSurface, watchForCalls, showRingBanner } from "./call-ui.js";

const BUCKET = "team-chat-files";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_FILES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const QUICK_EMOJI = ["🙂", "👍", "🎉", "❤️", "🙏", "✨"];

function linkify(value) {
  const safe = esc(String(value || ""));
  return safe.replace(/https?:\/\/[^\s<]+/gi, (url) => {
    const clean = url.replace(/[),.!?]+$/, "");
    const tail = url.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });
}

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Messages are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

const initialsOf = (name) => initials(String(name || "Member"));

export default async function mountInbox(root, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "chat team-chat";
  wrap.innerHTML = `
    <aside class="chat-pane chat-pane-list">
      <div class="chat-pane-head">
        <div class="chat-pane-title">${icon("message-square", { size: 15 })}<span>Conversations</span></div>
        <button class="btn btn-ghost btn-sm" type="button" id="dm-refresh">${icon("refresh-cw", { size: 13 })}Refresh</button>
      </div>

      <div class="dm-search">
        <label class="sr-only" for="dm-search-input">Find a member by username</label>
        <div class="dm-search-field">
          ${icon("search", { size: 14 })}
          <input class="input" id="dm-search-input" type="search" placeholder="Find a member by username"
                 autocomplete="off" spellcheck="false" aria-controls="dm-search-results" />
        </div>
        <div class="dm-search-results" id="dm-search-results" hidden></div>
      </div>

      <div class="chat-list" id="dm-list"><div class="chat-empty-line">Loading…</div></div>
    </aside>

    <section class="chat-pane chat-pane-thread">
      <div class="chat-thread-head" id="dm-head">
        <div class="dm-head-identity">
          <div class="chat-thread-title">Messages</div>
          <div class="chat-thread-sub">Search a username to start, or pick a conversation.</div>
        </div>
        <div class="dm-head-actions">
          <button class="btn btn-ghost btn-sm" type="button" id="dm-call" hidden>
            ${icon("phone", { size: 13 })}<span>Call</span>
          </button>
          <div class="dm-head-status" id="dm-head-status"></div>
        </div>
      </div>

      <div class="chat-messages" id="dm-messages">
        <div class="chat-empty-line">No conversation open.</div>
      </div>

      <form class="chat-compose" id="dm-compose" hidden>
        <div class="team-compose-tools" aria-label="Quick emoji">
          ${QUICK_EMOJI.map((emoji) => `<button class="btn btn-ghost btn-sm" type="button" data-emoji="${emoji}" aria-label="Insert ${emoji}">${emoji}</button>`).join("")}
          <label class="btn btn-ghost btn-sm" for="dm-files">${icon("paperclip", { size: 14 })}Attach</label>
          <input id="dm-files" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden />
        </div>
        <label class="sr-only" for="dm-body">Message</label>
        <textarea class="textarea chat-input" id="dm-body" rows="2" maxlength="4000" placeholder="Write a message…"></textarea>
        <button class="btn btn-primary chat-send" type="submit" id="dm-send">${icon("send", { size: 15 })}<span>Send</span></button>
      </form>
    </section>`;
  root.appendChild(wrap);

  const listEl = qs("#dm-list", wrap);
  const headEl = qs("#dm-head", wrap);
  const statusEl = qs("#dm-head-status", wrap);
  const messagesEl = qs("#dm-messages", wrap);
  const formEl = qs("#dm-compose", wrap);
  const searchInput = qs("#dm-search-input", wrap);
  const searchResults = qs("#dm-search-results", wrap);
  const callButton = qs("#dm-call", wrap);

  /* One call per tab, and only for a one-to-one conversation: a "call" between
     five people in a team room is a meeting, and that lives in Groups. */
  let currentCall = null;
  let stopWatching = () => {};
  let watchedTopic = null;
  let ringDismiss = null;
  let activeMeta = null;

  let me = null;
  let conversations = [];
  let active = options.conversationId || null;

  /* ------------------------------------------------------------------ list */
  function paintList() {
    if (!conversations.length) {
      listEl.innerHTML = `<div class="chat-empty-line">No conversations yet. Search a username above to start one.</div>`;
      return;
    }
    listEl.innerHTML = conversations
      .map((row) => {
        const title = row.title || (row.kind === "personal" ? "Direct message" : "Team conversation");
        const seen = row.peer?.lastSeenAt ?? null;
        const sub =
          row.kind === "personal"
            ? `${presenceLabel(presenceState(seen))}${row.peer?.username ? ` · @${esc(row.peer.username)}` : ""}`
            : "Team conversation";
        return `<button class="chat-item${row.conversationId === active ? " is-active" : ""}${Number(row.unread) ? " has-unread" : ""}"
          type="button" data-conversation="${esc(row.conversationId)}">
          <span class="chat-avatar-wrap">
            <span class="chat-avatar">${esc(initialsOf(title))}</span>
            ${row.kind === "personal" ? presenceDot(seen, { size: 9 }) : ""}
          </span>
          <span class="chat-item-body">
            <span class="chat-item-top">
              <span class="chat-item-name">${esc(title)}</span>
              <span class="chat-item-time">${row.lastMessageAt ? esc(timeAgo(row.lastMessageAt)) : ""}</span>
            </span>
            <span class="chat-item-snippet">${row.lastMessage ? esc(String(row.lastMessage).slice(0, 80)) : esc(sub)}</span>
          </span>
          ${Number(row.unread) ? `<span class="chat-unread">${esc(row.unread)}</span>` : ""}
        </button>`;
      })
      .join("");
  }

  async function loadList() {
    conversations = (await rpc("dm_inbox")) || [];
    if (!Array.isArray(conversations)) conversations = [];
    paintList();
  }

  /* ---------------------------------------------------------------- search */
  function paintResults(rows) {
    if (!rows.length) {
      searchResults.hidden = false;
      searchResults.innerHTML = `<div class="dm-search-empty">No member with that username. Handles are set in Settings → Profile.</div>`;
      return;
    }
    searchResults.hidden = false;
    searchResults.innerHTML = rows
      .map(
        (person) => `<button type="button" class="dm-search-row" data-start-dm="${esc(person.username || "")}">
          <span class="chat-avatar-wrap">
            <span class="chat-avatar chat-avatar-sm">${esc(initialsOf(person.fullName))}</span>
            ${presenceDot(person.lastSeenAt, { size: 8 })}
          </span>
          <span class="dm-search-meta">
            <span class="dm-search-name">${esc(person.fullName || person.username)}</span>
            <span class="dm-search-handle mono">@${esc(person.username || "")}</span>
          </span>
          <span class="dm-search-go">${icon("arrow-right", { size: 14 })}</span>
        </button>`
      )
      .join("");
  }

  let searchTimer = null;
  on(searchInput, "input", () => {
    const term = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (term.length < 2) {
      searchResults.hidden = true;
      searchResults.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const rows = await rpc("dm_search_people", { p_query: term });
        paintResults(Array.isArray(rows) ? rows : []);
      } catch (error) {
        searchResults.hidden = false;
        searchResults.innerHTML = `<div class="dm-search-empty">${esc(error.message || "Search failed.")}</div>`;
      }
    }, 220);
  });

  on(searchInput, "keydown", (event) => {
    if (event.key === "Escape") {
      searchResults.hidden = true;
      searchInput.blur();
    }
  });

  delegate(searchResults, "click", "[data-start-dm]", async (_event, button) => {
    const username = button.getAttribute("data-start-dm");
    if (!username) return;
    try {
      const result = await rpc("dm_start", { p_username: username });
      searchInput.value = "";
      searchResults.hidden = true;
      await loadList();
      await open(result.conversationId);
    } catch (error) {
      toastError(error);
    }
  });

  /* ---------------------------------------------------------------- thread */
  async function open(id) {
    active = id;
    paintList();
    messagesEl.innerHTML = `<div class="chat-empty-line">Loading conversation…</div>`;
    try {
      const thread = await rpc("team_chat_thread", { p_conversation: id, p_limit: 200 });
      const people = thread.participants || [];
      const other = people.find((person) => person.userId !== me) || people[0] || {};
      const title =
        thread.kind === "personal"
          ? other.name || other.username || "Direct message"
          : thread.title || "Team conversation";
      qs(".chat-thread-title", headEl).textContent = title;
      qs(".chat-thread-sub", headEl).textContent =
        thread.kind === "personal"
          ? `${other.username ? `@${other.username}` : "Member"} · ${presenceLabel(presenceState(other.lastSeenAt))}`
          : people.map((person) => person.name).filter(Boolean).join(" · ") || "Team conversation";
      statusEl.innerHTML =
        thread.kind === "personal" ? presenceDot(other.lastSeenAt, { size: 10 }) : "";
      /* A call makes sense in a one-to-one conversation, not in a team room. */
      activeMeta = { peerName: title, peerId: other.userId || null, personal: thread.kind === "personal" };
      callButton.hidden = thread.kind !== "personal";
      if (thread.kind === "personal") watchConversation(id, title);
      await paintMessages(thread);
      await loadList();
    } catch (error) {
      messagesEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "This conversation is unavailable.")}</div>`;
      formEl.hidden = true;
    }
  }

  async function paintMessages(thread) {
    if (!thread?.messages?.length) {
      messagesEl.innerHTML = `<div class="chat-empty-line">No messages yet. Say something.</div>`;
      formEl.hidden = false;
      return;
    }
    const rows = await Promise.all(
      thread.messages.map(async (message) => {
        const mine = message.senderId === me;
        const person = (thread.participants || []).find((entry) => entry.userId === message.senderId);
        const attachments = await Promise.all(
          (message.attachments || []).map(async (file) => {
            let href = "#";
            try {
              const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(file.path, 3600);
              if (!error) href = data?.signedUrl || "#";
            } catch {
              /* A missing object shows as a filename, never a public URL. */
            }
            return `<a class="team-attachment" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${icon(
              file.mime?.startsWith("image/") ? "image" : "file-text",
              { size: 13 }
            )}${esc(file.name || "Attachment")}</a>`;
          })
        );
        return `<div class="bubble-row${mine ? " is-mine" : ""}"><div class="bubble${mine ? " bubble-mine" : ""}">
          ${mine ? "" : `<div class="bubble-who">${esc(person?.name || "Member")}</div>`}
          ${message.body ? `<div class="bubble-text">${linkify(message.body)}</div>` : ""}
          ${attachments.length ? `<div class="team-attachments">${attachments.join("")}</div>` : ""}
          <div class="bubble-time" title="${esc(dateTime(message.createdAt))}">${esc(timeAgo(message.createdAt))}</div></div></div>`;
      })
    );
    messagesEl.innerHTML = rows.join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
    formEl.hidden = false;
  }

  /* ----------------------------------------------------------------- calls */

  function startCall(conversationId, peerName) {
    const call = createCall({
      kind: "voice",
      topic: callTopics.dm(conversationId),
      title: peerName || "Call",
      self: { userId: me, name: "You" }
    });
    currentCall = call;
    openCallSurface({
      call,
      self: { userId: me, name: "You" },
      subtitle: "Direct call",
      onClose: () => {
        if (currentCall === call) currentCall = null;
      }
    });
    call.join({ audioOnly: true }).catch((error) => {
      const message = String(error?.message || "");
      if (!turnConfigured() && /connect|failed|network/i.test(message)) {
        toastError(
          new Error(
            `${message} This is usually a network between the two of you — a TURN relay is not configured on this deployment.`
          )
        );
        return;
      }
      toastError(error);
    });
  }

  function watchConversation(conversationId, peerName) {
    const topic = callTopics.dm(conversationId);
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
        if (currentCall) return;
        ringDismiss?.();
        ringDismiss = showRingBanner({
          name: name || peerName || "Somebody",
          kind: "voice",
          groupName: "Direct call",
          onJoin: () => {
            ringDismiss = null;
            startCall(conversationId, peerName);
          },
          onDismiss: () => {
            ringDismiss = null;
          }
        });
      }
    });
  }

  on(callButton, "click", () => {
    if (!active || !activeMeta?.peerName) return;
    startCall(active, activeMeta.peerName);
  });

  /* ---------------------------------------------------------------- events */
  delegate(listEl, "click", "[data-conversation]", (_event, button) => open(button.getAttribute("data-conversation")));

  on(qs("#dm-refresh", wrap), "click", async () => {
    try {
      await loadList();
      if (active) await open(active);
    } catch (error) {
      toastError(error);
    }
  });

  delegate(wrap, "click", "[data-emoji]", (_event, button) => {
    const field = qs("#dm-body", wrap);
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.setRangeText(button.dataset.emoji, start, end, "end");
    field.focus();
  });

  on(qs("#dm-body", wrap), "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  on(formEl, "submit", async (event) => {
    event.preventDefault();
    if (!active) return;
    const field = qs("#dm-body", wrap);
    const send = qs("#dm-send", wrap);
    const body = field.value.trim();
    const fileInput = qs("#dm-files", wrap);
    const files = [...(fileInput.files || [])];
    if (!body && !files.length) return;

    send.disabled = true;
    try {
      const uploaded = [];
      for (const file of files) {
        if (!ALLOWED_FILES.has(file.type)) throw new Error("Attach a JPEG, PNG or WebP image, or a PDF.");
        if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("Each attachment must be under 20 MB.");
        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "attachment";
        const path = `${active}/${me}/${crypto.randomUUID()}-${cleanName}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
        if (error) throw normalizeError(error);
        uploaded.push({ path, name: file.name, mime: file.type, size: file.size });
      }
      await rpc("team_chat_send", { p_conversation: active, p_body: body, p_attachments: uploaded });
      field.value = "";
      fileInput.value = "";
      await open(active);
    } catch (error) {
      toastError(error);
    } finally {
      send.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ boot */
  try {
    const { data } = await sb.auth.getUser();
    me = data?.user?.id || state.user?.id || null;
    await loadList();
    if (active && conversations.some((row) => row.conversationId === active)) await open(active);
    else if (conversations.length === 1) await open(conversations[0].conversationId);
  } catch (error) {
    listEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "Messages could not be loaded.")}</div>`;
  }

  return { open, refresh: loadList };
}
