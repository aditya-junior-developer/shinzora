/* ==========================================================================
   Shinzora — investor Messages (phase 3)
   Conversations with investors you are connected with, and owners who have a
   pitch with you. The inbox comes from my_conversations(), which carries the
   unread count for each one. Opening a conversation marks it read. The inbox
   refreshes when any new message arrives for this person.
   ========================================================================== */

import { qs, esc, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb } from "../../../lib/supabase.js";
import { openLiveChannel, closeLiveChannel } from "../../../lib/live-channel.js";
import { pageHead, skeletonView, emptyState, setupNotice, chip } from "../components.js";
import { toastError } from "../../../ui/toast.js";
import { rpc, fmtTime } from "./investor-kit.js";
import { mountThread, destroyThreads } from "./investor-thread.js";

const INBOX_KEY = "dm-inbox";

let host = null;
let conversations = [];
let activeId = null;
let thread = null;

export default async function render(root, { params } = {}) {
  /* The router has no teardown hook, so release the previous page's feeds first. */
  if (thread) thread.destroy();
  thread = null;
  closeLiveChannel(INBOX_KEY);
  destroyThreads();

  host = root;
  activeId = params?.get("conversation") || null;

  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Messages",
      desc: "Talk with investors you are connected with, and owners who have pitched you.",
      badge: chip("Live", { tone: "violet", iconName: "messages-square" })
    })}
    <div class="dm-layout" id="dm-layout">
      <aside class="dm-inbox card" aria-label="Conversations">
        <div class="dm-inbox-head"><strong>Conversations</strong></div>
        <div id="dm-list" aria-live="polite">${skeletonView(3)}</div>
      </aside>
      <section class="dm-main card" id="dm-main" aria-label="Conversation">
        ${emptyState({ iconName: "messages-square", title: "Choose a conversation", desc: "Pick someone on the left to read and send messages." })}
      </section>
    </div>
  </div>`;

  host.addEventListener("click", onClick);
  startInboxFeed();
  await loadInbox();

  if (activeId) {
    const row = conversations.find((c) => c.conversation_id === activeId);
    if (row) await openConversation(row.conversation_id, { updateUrl: false });
    else showMissing();
  }
}

/* -------------------------------------------------------------- inbox */

async function loadInbox() {
  const list = qs("#dm-list", host);
  if (!list) return;
  try {
    const rows = await rpc("my_conversations");
    conversations = Array.isArray(rows) ? rows : [];
    paintInbox();
  } catch (error) {
    list.innerHTML = setupNotice(error, "Messages");
  }
}

function paintInbox() {
  const list = qs("#dm-list", host);
  if (!list) return;
  if (!conversations.length) {
    list.innerHTML = emptyState({
      iconName: "messages-square",
      title: "No conversations yet",
      desc: "Connect with an investor, or wait for an owner to pitch you. Then you can message them here."
    });
    return;
  }
  list.innerHTML = `<ul class="dm-list-items" role="list">${conversations
    .map((c) => {
      const unread = Number(c.unread_count || 0);
      const current = c.conversation_id === activeId;
      return `<li><button type="button" class="dm-item ${current ? "is-active" : ""} ${unread ? "is-unread" : ""}"
          data-open="${esc(c.conversation_id)}" aria-current="${current ? "true" : "false"}">
          <span class="dm-item-main">
            <strong class="truncate">${esc(c.other_name || "Member")}</strong>
            <span class="field-hint truncate">${esc(c.last_body || "No messages yet")}</span>
          </span>
          <span class="dm-item-meta">
            <time class="field-hint">${esc(c.last_message_at ? fmtTime(c.last_message_at) : "")}</time>
            ${unread ? `<span class="link-badge" aria-label="${unread} unread">${unread}</span>` : ""}
          </span>
        </button></li>`;
    })
    .join("")}</ul>`;
}

/** Re-read the inbox when any message arrives for this person. */
function startInboxFeed() {
  const refresh = debounce(() => {
    if (host?.isConnected) loadInbox();
  }, 300);
  openLiveChannel(sb, INBOX_KEY, {
    topic: "dm-inbox",
    bind: (channel) =>
      channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "direct_messages" }, refresh)
  });
}

/* -------------------------------------------------------- conversation */

async function openConversation(id, { updateUrl = true } = {}) {
  const row = conversations.find((c) => c.conversation_id === id);
  if (!row) return showMissing();
  activeId = id;
  paintInbox();
  if (updateUrl) history.replaceState(history.state, "", `/app/?view=investor-messages&conversation=${encodeURIComponent(id)}`);

  const main = qs("#dm-main", host);
  const layout = qs("#dm-layout", host);
  layout?.classList.add("is-thread-open");
  /* The name is shown once, in the thread header. This bar only carries Back on phones. */
  main.innerHTML = `<header class="dm-main-head">
      <button class="btn btn-ghost btn-sm dm-back" type="button" data-back aria-label="Back to conversations">${icon("arrow-left", { size: 14 })} Back</button>
    </header>
    <div id="dm-thread-box" class="dm-thread-box"></div>`;

  if (thread) thread.destroy();
  thread = null;
  try {
    thread = await mountThread(qs("#dm-thread-box", main), id, {
      otherName: row.other_name || "Member",
      onSent: () => loadInbox()
    });
  } catch (error) {
    toastError(error);
  }
}

function showMissing() {
  const main = qs("#dm-main", host);
  if (!main) return;
  main.innerHTML = emptyState({
    iconName: "messages-square",
    title: "That conversation is not available",
    desc: "It may have been removed, or you are no longer connected with that person."
  });
}

function onClick(event) {
  const open = event.target.closest?.("[data-open]");
  if (open) {
    openConversation(open.getAttribute("data-open"));
    return;
  }
  if (event.target.closest?.("[data-back]")) {
    qs("#dm-layout", host)?.classList.remove("is-thread-open");
    activeId = null;
    paintInbox();
  }
}
