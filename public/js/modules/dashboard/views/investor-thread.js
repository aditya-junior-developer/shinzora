/* ==========================================================================
   Shinzora — direct message thread (investor portal, phase 3)
   One conversation between two people who are allowed to talk: two connected
   investors, or an investor and an owner with a pitch between them. The
   database decides who may open or read a conversation (RLS and the
   open_direct_conversation RPC). This file only draws the thread, sends
   through send_direct_message, and listens for new rows in real time.

   Live updates use the Realtime "postgres_changes" feed. Supabase applies the
   table's row-level security to that feed, so a person only receives messages
   from conversations they belong to.
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { openLiveChannel, closeLiveChannel } from "../../../lib/live-channel.js";
import { state } from "../../../lib/store.js";
import { toastError } from "../../../ui/toast.js";
import { icon } from "../../../lib/icons.js";
import { skeletonView } from "../components.js";
import { rpc, fmtTime } from "./investor-kit.js";

export const THREAD_KEY = "dm-thread";
const MESSAGE_LIMIT = 300;

const myId = () => state.user?.id || state.session?.user?.id || null;

/**
 * Draw a conversation into `box` and keep it live.
 * Returns { destroy } — call it when the thread is no longer on screen.
 */
export async function mountThread(box, conversationId, { otherName = "Member", onSent = () => {} } = {}) {
  const me = myId();
  box.innerHTML = `
    <div class="dm-thread" data-conversation="${esc(conversationId)}">
      <header class="dm-thread-head">
        <strong class="truncate">${esc(otherName)}</strong>
        <span class="field-hint dm-live" data-live>Connecting…</span>
      </header>
      <div class="dm-stream" id="dm-stream" role="log" aria-live="polite" aria-label="Messages with ${esc(otherName)}">${skeletonView(2)}</div>
      <form class="dm-compose" id="dm-compose" novalidate>
        <label class="sr-only" for="dm-body">Message</label>
        <textarea id="dm-body" class="input dm-input" name="body" rows="1" maxlength="4000"
          placeholder="Write a message. Enter sends, Shift+Enter starts a new line."></textarea>
        <button class="btn btn-primary btn-sm" type="submit" id="dm-send">${icon("send", { size: 14 })} Send</button>
      </form>
    </div>`;

  const stream = qs("#dm-stream", box);
  const form = qs("#dm-compose", box);
  const input = qs("#dm-body", box);
  const send = qs("#dm-send", box);
  const live = qs("[data-live]", box);
  const seen = new Set();
  let alive = true;

  const bubble = (m) => {
    const mine = m.sender_id === me;
    return `<div class="dm-row ${mine ? "is-me" : ""}">
      <div class="dm-bubble" data-id="${esc(m.id)}">
        <p class="dm-text">${esc(m.body)}</p>
        <time class="dm-time" datetime="${esc(m.created_at)}">${esc(fmtTime(m.created_at))}</time>
      </div>
    </div>`;
  };

  const scrollToEnd = () => {
    stream.scrollTop = stream.scrollHeight;
  };

  async function markRead() {
    try {
      await rpc("mark_conversation_read", { p_conversation: conversationId });
    } catch {
      /* Read marks are best effort; the inbox count catches up on the next refresh. */
    }
  }

  function append(m) {
    if (!alive || !stream.isConnected || seen.has(m.id)) return;
    seen.add(m.id);
    if (stream.querySelector(".dm-empty")) stream.innerHTML = "";
    stream.insertAdjacentHTML("beforeend", bubble(m));
    scrollToEnd();
  }

  async function load() {
    const { data, error } = await sb
      .from("direct_messages")
      .select("id, sender_id, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(MESSAGE_LIMIT);
    if (!alive || !stream.isConnected) return;
    if (error) {
      stream.innerHTML = `<p class="field-error">${esc(normalizeError(error).message || "Messages could not be loaded.")}</p>`;
      return;
    }
    const rows = data || [];
    seen.clear();
    rows.forEach((m) => seen.add(m.id));
    stream.innerHTML = rows.length
      ? rows.map(bubble).join("")
      : `<p class="dm-empty field-hint">No messages yet. Say hello.</p>`;
    scrollToEnd();
    await markRead();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await rpc("send_direct_message", { p_conversation: conversationId, p_body: text });
      input.value = "";
      await load();
      onSent();
    } catch (error) {
      toastError(error);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  openLiveChannel(sb, THREAD_KEY, {
    topic: `dm-thread:${conversationId}`,
    bind: (channel) =>
      channel.on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "direct_messages", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          if (payload?.new) {
            append(payload.new);
            markRead();
          }
        }
      ),
    onStatus: (status) => {
      if (live && live.isConnected) live.textContent = status === "SUBSCRIBED" ? "Live" : "Reconnecting…";
    }
  });

  await load();

  return {
    destroy() {
      alive = false;
      closeLiveChannel(THREAD_KEY);
    }
  };
}

export function destroyThreads() {
  return closeLiveChannel(THREAD_KEY);
}
