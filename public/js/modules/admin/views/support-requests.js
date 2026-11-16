/* ==========================================================================
   Shinzora admin — Support requests
   --------------------------------------------------------------------------
   The queue of requests Shinzora users sent from Customer Support:
   - Call requests (a phone number and a best time): call back, then set the
     status here.
   - Chat requests: reply in the thread; the user sees replies under My requests.
   - The response-time note: free text the team chooses. It is shown to users
     exactly as typed, or not at all when it is empty. No time is promised here.

   Every change is an RPC (support_request_update, support_request_reply,
   support_settings_save). Each one checks is_admin() on the server.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { dateTime, timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, emptyState, skeletonView, statusBadge } from "../../dashboard/components.js";
import { toast, toastError } from "../../../ui/toast.js";

const STATUSES = [
  ["received", "Received"],
  ["in_progress", "In progress"],
  ["resolved", "Resolved"],
  ["closed", "Closed"]
];
const CHANNEL = { chat: "Chat", call: "Call" };

const local = {
  rows: [],
  names: new Map(),
  note: "",
  filter: "open",
  channel: "all",
  selected: null,
  thread: []
};

export default async function render(root) {
  root.innerHTML = `${pageHead({
    title: "Support requests",
    desc: "Requests from Shinzora users: call backs and chats with the team. Reply, change the status, and set the response-time note that users see."
  })}${skeleton()}`;
  await load(root);
}

function skeleton() {
  return `<div id="sr-settings"></div><div id="sr-body" class="grid-main-side" style="margin-top:var(--s-4)">${skeletonView(3)}</div>`;
}

async function load(root) {
  try {
    const [settings, requests] = await Promise.all([
      sb.from("support_settings").select("value").eq("key", "response_time_note").maybeSingle(),
      sb
        .from("support_requests")
        .select("id, user_id, channel, subject, message, phone, best_time, status, admin_note, created_at, updated_at, last_message_at")
        .order("created_at", { ascending: false })
        .limit(300)
    ]);
    if (settings.error) throw normalizeError(settings.error);
    if (requests.error) throw normalizeError(requests.error);
    local.note = String(settings.data?.value || "");
    local.rows = requests.data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Support requests" })}<div class="card"><div class="card-body">${esc(
      error?.message || "The support requests could not be loaded."
    )}</div></div>`;
    return;
  }
  await loadNames();
  paint(root);
}

async function loadNames() {
  const ids = [...new Set(local.rows.map((r) => r.user_id))];
  if (!ids.length) return;
  const { data } = await sb.from("profiles").select("id, full_name, email").in("id", ids.slice(0, 300));
  local.names = new Map((data || []).map((p) => [p.id, p.full_name || p.email || p.id]));
}

function visible() {
  return local.rows.filter((r) => {
    const statusOk =
      local.filter === "all" ? true : local.filter === "open" ? ["received", "in_progress"].includes(r.status) : r.status === local.filter;
    const channelOk = local.channel === "all" || r.channel === local.channel;
    return statusOk && channelOk;
  });
}

function paint(root) {
  const count = (fn) => local.rows.filter(fn).length;
  const open = count((r) => ["received", "in_progress"].includes(r.status));
  const calls = count((r) => r.channel === "call" && ["received", "in_progress"].includes(r.status));
  const chats = count((r) => r.channel === "chat" && ["received", "in_progress"].includes(r.status));
  const list = visible();

  qs("#sr-settings", root).innerHTML = `
    <section class="card" style="margin-bottom:var(--s-4)" aria-label="Response-time note">
      <div class="card-head"><div class="card-title">Response-time note</div></div>
      <form class="card-body stack" id="sr-note-form">
        <p class="card-desc">Shown to users under their confirmation, exactly as written. Leave it empty to show no response time. Do not promise a time you cannot keep.</p>
        <label class="field"><span class="field-label">Note (up to 300 characters)</span>
          <textarea class="input" id="sr-note" rows="2" maxlength="300" placeholder="For example: We are reviewing requests during office hours.">${esc(local.note)}</textarea>
        </label>
        <div><button class="btn btn-primary btn-sm" type="submit" id="sr-note-save">Save note</button></div>
      </form>
    </section>
    <div class="grid-3" style="display:grid;gap:var(--s-3);grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="card card-pad"><div class="dim" style="font-size:var(--fs-xs)">Open</div><strong style="font-size:var(--fs-xl)">${open}</strong></div>
      <div class="card card-pad"><div class="dim" style="font-size:var(--fs-xs)">Open calls</div><strong style="font-size:var(--fs-xl)">${calls}</strong></div>
      <div class="card card-pad"><div class="dim" style="font-size:var(--fs-xs)">Open chats</div><strong style="font-size:var(--fs-xl)">${chats}</strong></div>
    </div>`;

  qs("#sr-body", root).className = "grid-main-side";
  qs("#sr-body", root).innerHTML = `
    <section class="card" aria-label="Requests">
      <div class="card-head" style="flex-wrap:wrap;gap:var(--s-2)">
        <div class="segmented" id="sr-status" role="tablist">
          ${[["open", "Open"], ["all", "All"], ...STATUSES]
            .map(([id, label]) => `<button type="button" data-status="${id}" aria-pressed="${local.filter === id}">${label}</button>`)
            .join("")}
        </div>
        <div class="segmented" id="sr-channel">
          ${[["all", "Any"], ["call", "Calls"], ["chat", "Chats"]]
            .map(([id, label]) => `<button type="button" data-channel="${id}" aria-pressed="${local.channel === id}">${label}</button>`)
            .join("")}
        </div>
      </div>
      <div class="card-body" style="padding:0">
        ${list.length
          ? `<ul class="cs-list" role="list" id="sr-list" style="margin:0">${list.map(rowMarkup).join("")}</ul>`
          : `<div style="padding:var(--s-4)">${emptyState({
              icon: "life-buoy",
              title: "No requests here",
              desc: "Requests appear here when a Shinzora user asks for a call or starts a chat."
            })}</div>`}
      </div>
    </section>
    <section class="card" id="sr-detail" aria-label="Request detail">
      ${local.selected ? detailMarkup() : `<div class="card-body dim">Choose a request to see its details.</div>`}
    </section>`;

  bindPage(root);
}

function rowMarkup(r) {
  const who = local.names.get(r.user_id) || r.user_id.slice(0, 8);
  const active = local.selected === r.id ? ' aria-current="true"' : "";
  return `<li><button type="button" class="cs-row" data-open="${esc(r.id)}"${active}>
    <span class="cs-row-main">
      <strong>${esc(r.subject)}</strong>
      <span class="dim">${esc(CHANNEL[r.channel] || r.channel)} · ${esc(who)} · ${esc(timeAgo(r.created_at))}</span>
    </span>
    <span class="cs-row-status">${statusBadge(r.status)}</span>
  </button></li>`;
}

function detailMarkup() {
  const r = local.rows.find((row) => row.id === local.selected);
  if (!r) return `<div class="card-body dim">That request is no longer in the list.</div>`;
  const who = local.names.get(r.user_id) || r.user_id;
  const thread =
    r.channel === "chat"
      ? `<div class="cs-ai-log" style="max-height:340px">${
          local.thread.map((m) => `<div class="cs-msg ${m.author_role === "admin" ? "is-mine" : "is-bot"}">
            <div class="cs-msg-who">${m.author_role === "admin" ? "Team" : "User"} · <span class="dim">${esc(timeAgo(m.created_at))}</span></div>
            <div class="cs-msg-body">${esc(m.body)}</div></div>`).join("") || `<p class="dim">No messages yet.</p>`
        }</div>
        <form class="cs-ai-form" id="sr-reply-form" style="padding:var(--s-3) 0 0">
          <label class="sr-only" for="sr-reply">Reply to the user</label>
          <textarea id="sr-reply" class="input" rows="2" maxlength="4000" placeholder="Reply to the user"></textarea>
          <button class="btn btn-primary btn-sm" type="submit" id="sr-reply-send">Send reply</button>
        </form>`
      : `<p class="card-desc">Call ${esc(r.phone || "(no number)")}${r.best_time ? ` · best time: ${esc(r.best_time)}` : ""}. Call the user, then set the status below.</p>`;
  return `
    <div class="card-head"><div class="card-title">${esc(r.subject)}</div></div>
    <div class="card-body stack" style="gap:var(--s-3)">
      <div class="dim" style="font-size:var(--fs-xs)">${esc(CHANNEL[r.channel] || r.channel)} · from ${esc(who)} · sent ${esc(dateTime(r.created_at))}</div>
      <div class="card" style="padding:var(--s-3);white-space:pre-wrap;word-break:break-word">${esc(r.message)}</div>
      ${thread}
      <form class="stack" id="sr-status-form" style="gap:var(--s-2)">
        <label class="field"><span class="field-label">Status</span>
          <select class="input" id="sr-status-value">
            ${STATUSES.map(([id, label]) => `<option value="${id}" ${r.status === id ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
        <label class="field"><span class="field-label">Internal note (not shown to the user)</span>
          <textarea class="input" id="sr-admin-note" rows="2" maxlength="2000">${esc(r.admin_note || "")}</textarea></label>
        <div><button class="btn btn-primary btn-sm" type="submit" id="sr-status-save">Save status</button></div>
      </form>
    </div>`;
}

function bindPage(root) {
  if (root.dataset.srBound) return;
  root.dataset.srBound = "1";
  delegate(root, "submit", "#sr-note-form", async (event) => {
    event.preventDefault();
    const btn = qs("#sr-note-save", root);
    btn.disabled = true;
    try {
      const { error } = await sb.rpc("support_settings_save", { p_response_time_note: qs("#sr-note", root).value });
      if (error) throw normalizeError(error);
      local.note = qs("#sr-note", root).value.trim();
      toast({ title: "Saved", message: local.note ? "Users will see this note." : "No response time is shown to users." }, { tone: "success" });
    } catch (error) {
      toastError(error, "The note could not be saved.");
    } finally {
      btn.disabled = false;
    }
  });
  delegate(root, "click", "[data-status]", (_e, el) => {
    local.filter = el.getAttribute("data-status");
    paint(root);
  });
  delegate(root, "click", "[data-channel]", (_e, el) => {
    local.channel = el.getAttribute("data-channel");
    paint(root);
  });
  delegate(root, "click", "[data-open]", async (_e, el) => {
    local.selected = el.getAttribute("data-open");
    await openSelected(root);
  });
  delegate(root, "submit", "#sr-status-form", async (event) => {
    event.preventDefault();
    const r = local.rows.find((row) => row.id === local.selected);
    if (!r) return;
    const status = qs("#sr-status-value", root).value;
    const note = qs("#sr-admin-note", root).value;
    const btn = qs("#sr-status-save", root);
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc("support_request_update", { p_request: r.id, p_status: status, p_admin_note: note });
      if (error) throw normalizeError(error);
      Object.assign(r, data || { status });
      toast({ title: "Status saved", message: `Now ${status.replace("_", " ")}.` }, { tone: "success" });
      paint(root);
    } catch (error) {
      toastError(error, "The status could not be saved.");
      btn.disabled = false;
    }
  });
  delegate(root, "submit", "#sr-reply-form", async (event) => {
    event.preventDefault();
    const input = qs("#sr-reply", root);
    const text = (input.value || "").trim();
    if (!text || !local.selected) return;
    const btn = qs("#sr-reply-send", root);
    btn.disabled = true;
    try {
      const { error } = await sb.rpc("support_request_reply", { p_request: local.selected, p_body: text });
      if (error) throw normalizeError(error);
      await openSelected(root);
    } catch (error) {
      toastError(error, "The reply could not be sent.");
      btn.disabled = false;
    }
  });
}

async function openSelected(root) {
  const r = local.rows.find((row) => row.id === local.selected);
  local.thread = [];
  if (r?.channel === "chat") {
    const { data, error } = await sb
      .from("support_request_messages")
      .select("id, author_role, body, created_at")
      .eq("request_id", r.id)
      .order("created_at", { ascending: true });
    if (error) toastError(normalizeError(error), "The thread could not be loaded.");
    local.thread = data || [];
  }
  paint(root);
}

