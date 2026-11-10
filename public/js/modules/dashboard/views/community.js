/* ==========================================================================
   Shinzora — Community
   --------------------------------------------------------------------------
   A public room, deliberately plainer than team chat: text only. There is no
   attachment column in `community_messages` and no upload control here, so
   "no images, no files" is enforced by the schema rather than by this file.

   Reads go through `community_messages_list` and writes through
   `community_send`; both are security-definer RPCs, so a signed-out visitor or
   a forged author id never reaches the table. New messages arrive over
   realtime — the subscription only tells us *that* something changed, and we
   re-read the last page so the display name always comes from the profile.
   ========================================================================== */

import { qs, delegate, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, avatar } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
};

let channels = [];
let active = null;
let messages = [];
let channel = null;
let sending = false;
let selfId = null;

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  try {
    const { data: session } = await sb.auth.getSession();
    selfId = session?.session?.user?.id || null;
    const { data, error } = await sb
      .from("community_channels")
      .select("id,slug,name,description,sort_order")
      .order("sort_order", { ascending: true });
    if (error) throw normalizeError(error);
    channels = data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Community" })}<div class="card"><div class="card-body">
        <p class="muted">${esc(error.message || "The community is unavailable right now.")}</p></div></div>`;
    return;
  }

  if (!channels.length) {
    root.innerHTML = pageHead({ title: "Community" }) + emptyState({ icon: "messages-square", title: "No channels yet", desc: "An admin has not opened any community channels." });
    return;
  }

  active = channels[0].slug;
  paint(root);
  await loadMessages(root);
  subscribe(root);
  root.__cmCleanup?.();
  root.__cmCleanup = () => unsubscribe();
}

function paint(root) {
  const current = channels.find((c) => c.slug === active) || channels[0];
  root.innerHTML = `
    ${pageHead({
      title: "Community",
      desc: "One shared room for everyone on Shinzora. Text only — introductions, questions, and what you shipped.",
      badge: `<span class="badge badge-neutral">${icon("message-circle", { size: 12 })}Text only</span>`
    })}
    <div class="cm-shell">
      <aside class="cm-channels" role="tablist" aria-label="Community channels">
        ${channels
          .map(
            (c) => `<button class="cm-channel ${c.slug === active ? "is-active" : ""}" role="tab"
              aria-selected="${c.slug === active}" data-channel="${esc(c.slug)}">
              <span class="cm-channel-hash">#</span>
              <span>${esc(c.name)}</span>
            </button>`
          )
          .join("")}
      </aside>
      <section class="cm-room">
        <header class="cm-room-head">
          <div>
            <div class="cm-room-title">#${esc(current.slug)}</div>
            <div class="cm-room-desc">${esc(current.description || "")}</div>
          </div>
        </header>
        <div class="cm-stream" id="cm-stream" aria-live="polite"></div>
        <form class="cm-composer" id="cm-form">
          <textarea id="cm-body" rows="1" maxlength="4000" placeholder="Message #${esc(current.slug)} — Enter to send, Shift+Enter for a new line" aria-label="Message"></textarea>
          <button class="btn btn-primary btn-sm" id="cm-send" type="submit">${icon("send", { size: 14 })}Send</button>
        </form>
        <div class="cm-hint">Plain text only. Images and files are not accepted here.</div>
      </section>
    </div>`;

  delegate(root, "click", "[data-channel]", async (_event, button) => {
    if (button.dataset.channel === active) return;
    active = button.dataset.channel;
    messages = [];
    paint(root);
    await loadMessages(root);
    subscribe(root);
  });

  const form = qs("#cm-form", root);
  const field = qs("#cm-body", root);

  on(form, "submit", async (event) => {
    event.preventDefault();
    await send(root);
  });

  on(field, "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(root);
    }
  });

  field.focus();
}

async function send(root) {
  if (sending) return;
  const field = qs("#cm-body", root);
  if (!field) return;
  const body = field.value.trim();
  if (!body) return;
  sending = true;
  qs("#cm-send", root).disabled = true;
  try {
    await rpc("community_send", { p_channel: active, p_body: body });
    field.value = "";
    await loadMessages(root, { scroll: true });
  } catch (error) {
    toastError(error);
  } finally {
    sending = false;
    const button = qs("#cm-send", root);
    if (button) button.disabled = false;
    field.focus();
  }
}

async function loadMessages(root, { scroll = true } = {}) {
  const stream = qs("#cm-stream", root);
  if (!stream) return;
  try {
    const page = await rpc("community_messages_list", { p_channel: active, p_before: null, p_limit: 80 });
    messages = Array.isArray(page) ? page : [];
  } catch (error) {
    stream.innerHTML = `<div class="cm-empty">${esc(error.message || "Messages could not be loaded.")}</div>`;
    return;
  }
  paintStream(stream, scroll);
}

function paintStream(stream, scroll) {
  if (!messages.length) {
    stream.innerHTML = `<div class="cm-empty">${icon("message-circle", { size: 18 })}<div>No messages yet. Say hello.</div></div>`;
    return;
  }
  stream.innerHTML = messages
    .map(
      (m) => `<div class="cm-msg ${m.authorId === selfId ? "is-self" : ""}">
        ${avatar(m.authorName, null, "sm")}
        <div class="cm-msg-main">
          <div class="cm-msg-head">
            <span class="cm-msg-author">${esc(m.authorName || "Member")}</span>
            ${m.username ? `<span class="cm-msg-handle">@${esc(m.username)}</span>` : ""}
            <span class="cm-msg-time" title="${esc(m.createdAt || "")}">${esc(timeAgo(m.createdAt))}</span>
          </div>
          <div class="cm-msg-body">${esc(m.body)}</div>
        </div>
      </div>`
    )
    .join("");
  if (scroll) stream.scrollTop = stream.scrollHeight;
}

const refresh = debounce(() => {
  const root = qs("#view-root");
  if (root && qs("#cm-stream", root)) loadMessages(root, { scroll: true });
}, 250);

function subscribe(root) {
  unsubscribe();
  const current = channels.find((c) => c.slug === active);
  if (!current) return;
  channel = sb
    .channel(`community:${current.slug}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "community_messages", filter: `channel_id=eq.${current.id}` },
      () => refresh()
    )
    .subscribe();
}

function unsubscribe() {
  if (channel) {
    try { sb.removeChannel(channel); } catch { /* already gone */ }
    channel = null;
  }
}
