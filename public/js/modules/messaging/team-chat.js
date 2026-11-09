/* ==========================================================================
   Shinzora · Business team chat
   --------------------------------------------------------------------------
   Data access is exclusively through membership-checked SECURITY DEFINER RPCs.
   Attachments are private, typed, size-limited, and stored under a per-user
   conversation prefix. All message text is escaped before linkification.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { timeAgo, dateTime, initials } from "../../lib/format.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { state } from "../../lib/store.js";
import { toast, toastError } from "../../ui/toast.js";

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
  if (!sb) throw new Error("Team chat is not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

function makeGmailDraft(email, businessName) {
  const subject = `Invitation to join ${businessName} on Shinzora`;
  const body = `Hi,\n\nI invited you to collaborate with ${businessName} on Shinzora. Sign in with this email address and open Team chat to accept the invitation.\n\nThanks!`;
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default async function mountTeamChat(root, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "chat team-chat";
  wrap.innerHTML = `
    <aside class="chat-pane chat-pane-list">
      <div class="chat-pane-head">
        <div class="chat-pane-title">${icon("users", { size: 15 })}<span>Team</span></div>
        <button class="btn btn-ghost btn-sm" type="button" id="team-refresh">${icon("refresh-cw", { size: 13 })}Refresh</button>
      </div>
      <label class="sr-only" for="team-business">Business</label>
      <select class="input" id="team-business" aria-label="Business workspace" style="margin:10px;width:calc(100% - 20px)"></select>
      <div class="chat-list" id="team-list"><div class="chat-empty-line">Loading…</div></div>
    </aside>
    <section class="chat-pane chat-pane-thread">
      <div class="chat-thread-head" id="team-head">
        <div><div class="chat-thread-title">Team chat</div><div class="chat-thread-sub">Private conversations for your business.</div></div>
        <button class="btn btn-secondary btn-sm" type="button" id="team-new-chat">${icon("plus", { size: 13 })}New chat</button>
      </div>
      <div class="team-invite-bar" id="team-invite-bar">
        <form class="row gap-2 wrap" id="team-invite-form">
          <label class="sr-only" for="team-invite-email">Teammate email</label>
          <input class="input" id="team-invite-email" type="email" autocomplete="email" placeholder="Invite by email" required />
          <label class="sr-only" for="team-invite-role">Member role</label>
          <select class="input" id="team-invite-role"><option value="freelancer">Freelancer</option><option value="agent">Agent</option></select>
          <button class="btn btn-secondary btn-sm" type="submit" id="team-invite-submit">Invite</button>
        </form>
        <div id="team-invite-result" class="field-hint" aria-live="polite"></div>
      </div>
      <div class="chat-messages" id="team-messages"></div>
      <form class="chat-compose" id="team-compose" hidden>
        <div class="team-compose-tools" aria-label="Quick emoji">
          ${QUICK_EMOJI.map((emoji) => `<button class="btn btn-ghost btn-sm" type="button" data-emoji="${emoji}" aria-label="Insert ${emoji}">${emoji}</button>`).join("")}
          <label class="btn btn-ghost btn-sm" for="team-files">${icon("paperclip", { size: 14 })}Attach</label>
          <input id="team-files" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden />
        </div>
        <label class="sr-only" for="team-body">Message</label>
        <textarea class="textarea chat-input" id="team-body" rows="2" maxlength="4000" placeholder="Write to your team…"></textarea>
        <button class="btn btn-primary chat-send" type="submit" id="team-send">${icon("send", { size: 15 })}<span>Send</span></button>
      </form>
    </section>`;
  root.appendChild(wrap);

  const listEl = qs("#team-list", wrap);
  const headEl = qs("#team-head", wrap);
  const messagesEl = qs("#team-messages", wrap);
  const formEl = qs("#team-compose", wrap);
  const businessSelect = qs("#team-business", wrap);
  let businesses = [];
  let activeBusiness = null;
  let activeConversation = options.conversationId || null;
  let currentUserId = null;
  let conversations = [];

  const chosenBusiness = () => businesses.find((b) => b.id === activeBusiness) || null;

  function paintList() {
    if (!conversations.length) {
      listEl.innerHTML = `<div class="chat-empty-line">No team conversations yet. Start one with an accepted teammate.</div>`;
      return;
    }
    listEl.innerHTML = conversations.map((row) => `<button class="chat-item${row.conversationId === activeConversation ? " is-active" : ""}${Number(row.unread) ? " has-unread" : ""}" type="button" data-team-conversation="${esc(row.conversationId)}">
      <span class="chat-avatar">${esc(initials(row.title || "Team"))}</span>
      <span class="chat-item-body"><span class="chat-item-top"><span class="chat-item-name">${esc(row.title || (row.kind === "direct" ? "Direct chat" : "Team conversation"))}</span><span class="chat-item-time">${row.lastMessageAt ? esc(timeAgo(row.lastMessageAt)) : ""}</span></span>
      <span class="chat-item-snippet">${row.lastMessage ? esc(String(row.lastMessage).slice(0, 80)) : "No messages yet"}</span></span>
      ${Number(row.unread) ? `<span class="chat-unread">${esc(row.unread)}</span>` : ""}
    </button>`).join("");
  }

  async function paintMessages(thread) {
    if (!thread?.messages?.length) {
      messagesEl.innerHTML = `<div class="chat-empty-line">Choose a conversation, or start a new one.</div>`;
      formEl.hidden = !activeConversation;
      return;
    }
    const rows = await Promise.all(thread.messages.map(async (message) => {
      const mine = message.senderId === currentUserId;
      const person = (thread.participants || []).find((p) => p.userId === message.senderId);
      const attachments = await Promise.all((message.attachments || []).map(async (file) => {
        let href = "#";
        try {
          const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(file.path, 3600);
          if (!error) href = data?.signedUrl || "#";
        } catch { /* A missing object is shown as a filename, never a public URL. */ }
        return `<a class="team-attachment" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${icon(file.mime?.startsWith("image/") ? "image" : "file-text", { size: 13 })}${esc(file.name || "Attachment")}</a>`;
      }));
      return `<div class="bubble-row${mine ? " is-mine" : ""}"><div class="bubble${mine ? " bubble-mine" : ""}">
        ${mine ? "" : `<div class="bubble-who">${esc(person?.name || "Teammate")}</div>`}
        ${message.body ? `<div class="bubble-text">${linkify(message.body)}</div>` : ""}
        ${attachments.length ? `<div class="team-attachments">${attachments.join("")}</div>` : ""}
        <div class="bubble-time" title="${esc(dateTime(message.createdAt))}">${esc(timeAgo(message.createdAt))}</div></div></div>`;
    }));
    messagesEl.innerHTML = rows.join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
    formEl.hidden = false;
  }

  async function loadConversations() {
    if (!activeBusiness) return;
    conversations = await rpc("team_chat_list", { p_business: activeBusiness });
    conversations = Array.isArray(conversations) ? conversations : [];
    paintList();
  }

  async function openConversation(id) {
    activeConversation = id;
    paintList();
    messagesEl.innerHTML = `<div class="chat-empty-line">Loading conversation…</div>`;
    try {
      const thread = await rpc("team_chat_thread", { p_conversation: id, p_limit: 200 });
      const participants = (thread.participants || []).map((p) => esc(p.name || "Member")).join(" · ");
      headEl.querySelector(".chat-thread-sub").textContent = participants || chosenBusiness()?.name || "Team conversation";
      await paintMessages(thread);
      await loadConversations();
    } catch (error) {
      messagesEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "This conversation is unavailable.")}</div>`;
      formEl.hidden = true;
      toastError(error);
    }
  }

  async function loadBusinesses() {
    businesses = await rpc("team_accessible_businesses");
    businesses = Array.isArray(businesses) ? businesses : [];
    businessSelect.innerHTML = businesses.map((b) => `<option value="${esc(b.id)}">${esc(b.name || "Business")}</option>`).join("");
    activeBusiness = businesses.some((b) => b.id === (state.business?.id || options.businessId))
      ? (state.business?.id || options.businessId)
      : businesses[0]?.id || null;
    if (activeBusiness) businessSelect.value = activeBusiness;
    if (!activeBusiness) {
      listEl.innerHTML = `<div class="chat-empty-line">No business workspace is available to this account.</div>`;
      messagesEl.innerHTML = `<div class="chat-empty-line">Accept a team invitation or finish business setup to use Team chat.</div>`;
      qs("#team-invite-bar", wrap).hidden = true;
      qs("#team-new-chat", wrap).disabled = true;
      return;
    }
    const business = chosenBusiness();
    qs("#team-invite-email", wrap).placeholder = `Invite to ${business?.name || "your team"}`;
    await loadConversations();
    if (activeConversation && conversations.some((c) => c.conversationId === activeConversation)) await openConversation(activeConversation);
    else if (conversations.length === 1) await openConversation(conversations[0].conversationId);
  }

  on(businessSelect, "change", async () => {
    activeBusiness = businessSelect.value;
    activeConversation = null;
    await loadConversations();
    await paintMessages(null);
  });
  on(qs("#team-refresh", wrap), "click", async () => {
    try { await loadConversations(); if (activeConversation) await openConversation(activeConversation); }
    catch (error) { toastError(error); }
  });
  delegate(listEl, "click", "[data-team-conversation]", (_event, button) => openConversation(button.dataset.teamConversation));

  on(qs("#team-new-chat", wrap), "click", async () => {
    const email = window.prompt("Enter the exact email address of an accepted teammate");
    if (!email) return;
    try {
      const people = await rpc("team_search_by_email", { p_business: activeBusiness, p_email: email.trim() });
      const peer = (people || []).find((p) => p.userId !== currentUserId);
      if (!peer) return toast({ title: "No teammate found", message: "They must accept the invitation before you can start a chat." }, { tone: "warning" });
      const result = await rpc("team_chat_start", { p_business: activeBusiness, p_participants: [peer.userId], p_title: null });
      await loadConversations();
      await openConversation(result.conversationId);
    } catch (error) { toastError(error); }
  });

  on(qs("#team-invite-form", wrap), "submit", async (event) => {
    event.preventDefault();
    const email = qs("#team-invite-email", wrap).value.trim();
    const role = qs("#team-invite-role", wrap).value;
    const button = qs("#team-invite-submit", wrap);
    const result = qs("#team-invite-result", wrap);
    button.disabled = true;
    result.textContent = "Creating invitation…";
    try {
      const invite = await rpc("team_invite_user", { p_business: activeBusiness, p_email: email, p_member_type: role });
      if (invite.alreadyMember) {
        result.textContent = "This person is already a team member.";
      } else {
        const gmailUrl = makeGmailDraft(email, chosenBusiness()?.name || "our business");
        result.innerHTML = `Invitation saved. <a href="${esc(gmailUrl)}" target="_blank" rel="noopener noreferrer">Open Gmail to send the invite</a>. The invitation is accepted only by the matching email.`;
        qs("#team-invite-email", wrap).value = "";
      }
    } catch (error) {
      result.textContent = error.message || "Invitation could not be created.";
      toastError(error);
    } finally { button.disabled = false; }
  });

  delegate(wrap, "click", "[data-emoji]", (_event, button) => {
    const field = qs("#team-body", wrap);
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.setRangeText(button.dataset.emoji, start, end, "end");
    field.focus();
  });

  on(formEl, "submit", async (event) => {
    event.preventDefault();
    if (!activeConversation) return;
    const field = qs("#team-body", wrap);
    const send = qs("#team-send", wrap);
    const body = field.value.trim();
    const fileInput = qs("#team-files", wrap);
    const files = [...(fileInput.files || [])];
    if (!body && !files.length) return;
    send.disabled = true;
    try {
      const uploaded = [];
      for (const file of files) {
        if (!ALLOWED_FILES.has(file.type)) throw new Error("Team chat accepts JPEG, PNG, WebP images and PDF files only.");
        if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("Each attachment must be under 20 MB.");
        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "attachment";
        const path = `${activeConversation}/${currentUserId}/${crypto.randomUUID()}-${cleanName}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
        if (error) throw normalizeError(error);
        uploaded.push({ path, name: file.name, mime: file.type, size: file.size });
      }
      await rpc("team_chat_send", { p_conversation: activeConversation, p_body: body, p_attachments: uploaded });
      field.value = "";
      fileInput.value = "";
      await openConversation(activeConversation);
    } catch (error) {
      toastError(error);
    } finally { send.disabled = false; }
  });

  on(qs("#team-body", wrap), "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      formEl.requestSubmit();
    }
  });

  try {
    const { data } = await sb.auth.getUser();
    currentUserId = data?.user?.id || state.user?.id || null;
    await loadBusinesses();
  } catch (error) {
    listEl.innerHTML = `<div class="chat-empty-line">${esc(error.message || "Team chat could not be loaded.")}</div>`;
  }
}
