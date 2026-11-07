/* ==========================================================================
   Shinzora · Messaging — one conversation surface for both shells
   --------------------------------------------------------------------------
   Used by /app/?view=messages (a business talking to the platform) and by
   /admin/?view=chat (administrators talking to each other or to a business).

   Everything privileged happens in the database:

     messaging_list()      the caller's conversations, newest first, with counts
     messaging_thread(id)  one conversation — and it marks it read for the caller
     messaging_send(id,b)  stored read/write; refuses non-members and empty text
     messaging_start(uids) opens (or reuses) a conversation
     messaging_contacts()  who this caller is allowed to write to

   The browser never decides who may read what: every function derives the
   caller from auth.uid() and raises 42501 for anyone outside the conversation.
   ========================================================================== */

import { qs, esc, delegate, on } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { timeAgo, dateTime, initials } from "../../lib/format.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { toast, toastError } from "../../ui/toast.js";
import { emptyState } from "../dashboard/components.js";

let pendingConversation = null;
let listTimer = null;

/** Open this conversation the next time the chat surface mounts. */
export function focusConversation(id) {
  pendingConversation = id || null;
}

async function rpc(name, args = {}) {
  if (!sb) throw normalizeError({ message: "Messaging is not available." });
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

export async function unreadMessageCount() {
  try {
    const count = await rpc("messaging_unread");
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

export default async function mountChat(root, options = {}) {
  const variant = options.variant === "admin" ? "admin" : "app";
  const initial = options.conversationId || pendingConversation || new URLSearchParams(location.search).get("c");
  pendingConversation = null;

  const wrap = document.createElement("div");
  wrap.className = `chat chat-${variant}`;
  wrap.innerHTML = `
    <aside class="chat-pane chat-pane-list">
      <div class="chat-pane-head">
        <div class="chat-pane-title">${icon("messages-square", { size: 15 })}<span>Conversations</span></div>
        <button class="btn btn-ghost btn-sm" type="button" id="chat-new">${icon("plus", { size: 14 })}New</button>
      </div>
      <div class="chat-list" id="chat-list"><div class="chat-empty-line">Loading…</div></div>
    </aside>
    <section class="chat-pane chat-pane-thread">
      <div class="chat-thread-head" id="chat-thread-head">
        <div class="chat-thread-title">Select a conversation</div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <form class="chat-compose" id="chat-form" hidden>
        <label class="sr-only" for="chat-body">Message</label>
        <textarea class="textarea chat-input" id="chat-body" rows="2" maxlength="4000" placeholder="Write a message…" required></textarea>
        <button class="btn btn-primary chat-send" type="submit" id="chat-send">${icon("send", { size: 15 })}<span>Send</span></button>
      </form>
    </section>`;
  root.appendChild(wrap);

  const listEl = qs("#chat-list", wrap);
  const headEl = qs("#chat-thread-head", wrap);
  const messagesEl = qs("#chat-messages", wrap);
  const formEl = qs("#chat-form", wrap);

  let conversations = [];
  let active = null;

  /* ----------------------------------------------------------- list paint */
  function paintList() {
    if (!conversations.length) {
      listEl.innerHTML = `<div class="chat-empty-line">No conversations yet.</div>`;
      return;
    }
    listEl.innerHTML = conversations
      .map((conversation) => {
        const unread = Number(conversation.unread) || 0;
        const mine = conversation.lastSenderId === myId;
        return `<button class="chat-item${conversation.conversationId === active ? " is-active" : ""}${
          unread ? " has-unread" : ""
        }" type="button" data-conversation="${esc(conversation.conversationId)}">
          <span class="chat-avatar">${esc(initials(conversation.title || "Shinzora"))}</span>
          <span class="chat-item-body">
            <span class="chat-item-top">
              <span class="chat-item-name">${esc(conversation.title || "Conversation")}</span>
              <span class="chat-item-time">${conversation.lastMessageAt ? esc(timeAgo(conversation.lastMessageAt)) : ""}</span>
            </span>
            <span class="chat-item-snippet">${conversation.lastMessage ? `${mine ? "You: " : ""}${esc(String(conversation.lastMessage).slice(0, 90))}` : "No messages yet"}</span>
          </span>
          ${unread ? `<span class="chat-unread">${unread}</span>` : ""}
        </button>`;
      })
      .join("");
  }

  /* --------------------------------------------------------- thread paint */
  function paintThread(thread) {
    if (!thread) {
      headEl.innerHTML = `<div class="chat-thread-title">Select a conversation</div>`;
      messagesEl.innerHTML = emptyState({
        icon: "messages-square",
        title: "No conversation selected",
        desc: "Pick a conversation on the left, or start a new one."
      });
      formEl.hidden = true;
      return;
    }

    const people = (thread.participants || []).filter((person) => person.userId !== myId);
    headEl.innerHTML = `
      <div>
        <div class="chat-thread-title">${esc(thread.title || people.map((p) => p.name).join(", ") || "Conversation")}</div>
        <div class="chat-thread-sub">${esc(
          (thread.participants || [])
            .map((p) => `${p.name}${p.role === "admin" || p.role === "superadmin" ? " (administrator)" : ""}`)
            .join(" · ")
        )}</div>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" id="chat-refresh">${icon("refresh-cw", { size: 13 })}Refresh</button>`;

    const messages = thread.messages || [];
    if (!messages.length) {
      messagesEl.innerHTML = emptyState({
        icon: "send",
        title: "Nothing said yet",
        desc: "The conversation is open. The first message starts the thread."
      });
    } else {
      messagesEl.innerHTML = messages
        .map((message) => {
          const mine = message.senderId === myId;
          const who = (thread.participants || []).find((p) => p.userId === message.senderId);
          return `<div class="bubble-row${mine ? " is-mine" : ""}">
            <div class="bubble${mine ? " bubble-mine" : ""}">
              ${mine ? "" : `<div class="bubble-who">${esc(who?.name || "Member")}</div>`}
              <div class="bubble-text">${esc(message.body)}</div>
              <div class="bubble-time" title="${esc(dateTime(message.createdAt))}">${esc(timeAgo(message.createdAt))}</div>
            </div>
          </div>`;
        })
        .join("");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    formEl.hidden = false;
    qs("#chat-body", wrap)?.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------ data load */
  let myId = null;

  async function loadConversations() {
    try {
      conversations = (await rpc("messaging_list")) || [];
      paintList();
      return conversations;
    } catch (error) {
      listEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "Conversations could not be loaded.")}</div>`;
      return [];
    }
  }

  async function open(conversationId) {
    if (!conversationId) return;
    active = conversationId;
    paintList();
    messagesEl.innerHTML = `<div class="chat-empty-line">Loading…</div>`;
    try {
      const thread = await rpc("messaging_thread", { p_conversation: conversationId, p_limit: 200 });
      paintThread(thread);
      await loadConversations();
    } catch (error) {
      messagesEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "This conversation could not be opened.")}</div>`;
      toastError(error);
    }
  }

  /* ------------------------------------------------------- new conversation */
  async function startNew() {
    let contacts = [];
    try {
      contacts = (await rpc("messaging_contacts")) || [];
    } catch (error) {
      return toastError(error);
    }
    if (!contacts.length) {
      return toast({ title: "Nobody to message", message: "No other accounts are visible to you yet." }, { tone: "warning" });
    }

    const admins = contacts.filter((person) => person.kind === "admin");
    const businesses = contacts.filter((person) => person.kind !== "admin");
    const group = (label, people) =>
      people.length
        ? `<div class="chat-picker-group">${esc(label)}</div>${people
            .map(
              (person) => `<button class="chat-picker-item" type="button" data-peer="${esc(person.userId)}" data-name="${esc(
                person.name || person.email || "Account"
              )}">
                <span class="chat-avatar chat-avatar-sm">${esc(initials(person.name || person.email || "S"))}</span>
                <span class="chat-picker-name">${esc(person.name || person.email || "Account")}</span>
                <span class="chat-picker-role">${esc(person.role === "business" ? "Business" : person.role === "superadmin" ? "Super admin" : "Administrator")}</span>
              </button>`
            )
            .join("")}`
        : "";

    headEl.innerHTML = `<div><div class="chat-thread-title">Start a conversation</div>
      <div class="chat-thread-sub">Choose who to write to. The conversation is stored server-side.</div></div>`;
    messagesEl.innerHTML = `<div class="chat-picker">${group("Administrators", admins)}${group("Businesses", businesses)}</div>`;
    formEl.hidden = true;

    delegate(messagesEl, "click", "[data-peer]", async (_event, node) => {
      const peer = node.getAttribute("data-peer");
      try {
        const result = await rpc("messaging_start", { p_participants: [peer], p_title: null });
        await loadConversations();
        await open(result.conversationId);
      } catch (error) {
        toastError(error);
      }
    });
  }

  /* --------------------------------------------------------------- wiring */
  delegate(listEl, "click", "[data-conversation]", (_event, node) => open(node.getAttribute("data-conversation")));
  on(qs("#chat-new", wrap), "click", startNew);
  delegate(headEl, "click", "#chat-refresh", () => open(active));

  on(formEl, "submit", async (event) => {
    event.preventDefault();
    const field = qs("#chat-body", wrap);
    const body = field.value.trim();
    if (!body) return;
    const send = qs("#chat-send", wrap);
    send.disabled = true;
    try {
      await rpc("messaging_send", { p_conversation: active, p_body: body });
      field.value = "";
      await open(active);
    } catch (error) {
      toastError(error);
    } finally {
      send.disabled = false;
    }
  });

  /* Enter sends, Shift+Enter adds a line — how every messaging surface behaves. */
  on(qs("#chat-body", wrap), "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit ? formEl.requestSubmit() : formEl.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  /* ------------------------------------------------------------ first paint */
  paintThread(null);
  const { data: auth } = await sb.auth.getUser();
  myId = auth?.user?.id || null;
  const list = await loadConversations();
  if (initial && list.some((row) => row.conversationId === initial)) {
    await open(initial);
  } else if (list.length === 1) {
    await open(list[0].conversationId);
  }

  /* Keep unread badges honest without hammering the database. */
  if (listTimer) clearInterval(listTimer);
  listTimer = setInterval(() => {
    if (document.hidden) return;
    loadConversations();
  }, 30000);
  window.addEventListener("shinzora:view", () => clearInterval(listTimer), { once: true });
  window.addEventListener("popstate", () => clearInterval(listTimer), { once: true });
}
