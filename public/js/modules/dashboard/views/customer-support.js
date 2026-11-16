/* ==========================================================================
   Shinzora — Customer Support (for Shinzora users)
   --------------------------------------------------------------------------
   First screen: "Talk to AI" and "Talk to a Human Representative".

   - Talk to AI: the support assistant (function `support-ai`). It has its own
     prompt and history. It is not the Website Builder AI or the Gemini
     assistant. An unresolved answer offers a human.
   - Talk to a Human: choose "Via Call" (a callback request with a phone number
     and a best time) or "Via Chat" (a message thread with the team). Both are
     stored in support_requests and tracked by status under "My requests".
   - Business tickets: the existing store-ticket queue (support.js), kept as a
     tab so nothing a store owner already uses is lost.

   Nothing here promises a response time. The only time text shown is the note
   an administrator typed in settings, and it is hidden when empty.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { dateTime, timeAgo } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { invoke } from "../../../lib/api.js";
import { pageHead, setupNotice, emptyState, skeletonView, statusBadge } from "../components.js";
import { toastError } from "../../../ui/toast.js";
import legacyBusinessTickets from "./support.js";

/** The exact text shown after a human support request is received. Do not change it. */
export const RECEIVED_TEXT =
  "Your support request has been received! Our human support representative will connect with you as soon as possible and help resolve your issue.";

const CHANNEL_LABEL = { chat: "Chat", call: "Call", ai: "AI" };
const STATUS_LABEL = { received: "Received", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

const state = {
  tab: "help", // help | requests | business
  screen: "home", // home | ai | human | human-call | human-chat | received
  aiMessages: [],
  aiReady: true,
  aiBusy: false,
  lastAiQuestion: "",
  requests: [],
  openRequest: null,
  thread: [],
  note: "",
  root: null
};

export default async function render(root) {
  state.root = root;
  if (state.tab === "business") return renderBusiness(root);
  root.innerHTML = `${pageHead({
    title: "Customer Support",
    desc: "Get help from the Shinzora assistant, or ask a person on our team."
  })}${tabs()}<div id="cs-body">${skeletonView(2)}</div>`;
  bindShell(root);
  await paintBody();
}

function tabs() {
  const entries = [
    ["help", "Get help"],
    ["requests", "My requests"],
    ["business", "Business tickets"]
  ];
  return `<div class="segmented cs-tabs" id="cs-tabs" role="tablist">
    ${entries
      .map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-pressed="${state.tab === id}">${label}</button>`)
      .join("")}
  </div>`;
}

/* One set of handlers per page root, bound once. Repaints replace the content
   inside, never the handlers, so nothing piles up across visits. */
function bindShell(root) {
  if (root.dataset.csBound) return;
  root.dataset.csBound = "1";
  delegate(root, "click", "[data-tab]", (_event, el) => {
    state.tab = el.getAttribute("data-tab");
    state.screen = "home";
    state.openRequest = null;
    render(root);
  });
  delegate(root, "click", "[data-back]", () => goBack());
  delegate(root, "click", "[data-escalate]", () => {
    state.tab = "help";
    state.screen = "human";
    render(root);
  });
}

function goBack() {
  if (state.tab === "requests" && state.openRequest) {
    state.openRequest = null;
  } else if (state.screen === "human-call" || state.screen === "human-chat") {
    state.screen = "human";
  } else {
    state.screen = "home";
  }
  paintBody();
}

async function renderBusiness(root) {
  root.innerHTML = `${pageHead({ title: "Customer Support", desc: "Store tickets from your own customers." })}${tabs()}<div id="cs-body"></div>`;
  bindShell(root);
  const host = qs("#cs-body", root);
  await legacyBusinessTickets(host);
}

async function paintBody() {
  const body = qs("#cs-body", state.root);
  if (!body) return;
  if (state.tab === "requests") return paintRequests(body);
  if (state.screen === "ai") return paintAi(body);
  if (state.screen === "human") return paintHumanChoice(body);
  if (state.screen === "human-call") return paintCallForm(body);
  if (state.screen === "human-chat") return paintChatForm(body);
  if (state.screen === "received") return paintReceived(body);
  return paintHome(body);
}

/* ---------------------------------------------------------------------------
   Home: the two choices
   ------------------------------------------------------------------------- */

function paintHome(body) {
  body.innerHTML = `
    <div class="cs-choices">
      <button type="button" class="card cs-choice" id="cs-to-ai">
        <span class="cs-choice-icon">${icon("sparkles", { size: 20 })}</span>
        <span class="cs-choice-title">Talk to AI</span>
        <span class="cs-choice-desc">Ask the Shinzora support assistant about features, your account, the website builder, payments, groups, channels or a problem you are seeing.</span>
      </button>
      <button type="button" class="card cs-choice" id="cs-to-human">
        <span class="cs-choice-icon">${icon("messages-square", { size: 20 })}</span>
        <span class="cs-choice-title">Talk to a Human Representative</span>
        <span class="cs-choice-desc">Request a call back, or start a chat with our team. Your request is saved and tracked under My requests.</span>
      </button>
    </div>`;
  on(qs("#cs-to-ai", body), "click", () => {
    state.screen = "ai";
    paintBody();
  });
  on(qs("#cs-to-human", body), "click", () => {
    state.screen = "human";
    paintBody();
  });
}

function backButton(label = "Back") {
  return `<button type="button" class="btn btn-ghost btn-sm cs-back" data-back>${icon("arrow-left", { size: 14 })}${label}</button>`;
}

/* ---------------------------------------------------------------------------
   Talk to AI
   ------------------------------------------------------------------------- */

async function paintAi(body) {
  body.innerHTML = `
    <section class="card cs-ai" aria-label="Talk to AI">
      <div class="card-head cs-ai-head">
        ${backButton()}
        <div>
          <div class="card-title">Shinzora support assistant</div>
          <div class="card-desc">This is a separate assistant for Shinzora questions. It is not the Website Builder AI.</div>
        </div>
      </div>
      <div class="cs-ai-log" id="cs-ai-log" aria-live="polite">${skeletonView(1)}</div>
      <form class="cs-ai-form" id="cs-ai-form" autocomplete="off">
        <label class="sr-only" for="cs-ai-input">Your question</label>
        <textarea id="cs-ai-input" class="input" rows="2" maxlength="1500" placeholder="Describe what you need help with"></textarea>
        <button class="btn btn-primary" type="submit" id="cs-ai-send">${icon("send", { size: 14 })}Send</button>
      </form>
      <p class="cs-ai-foot">Still stuck? <button type="button" class="btn btn-ghost btn-sm" data-escalate>Talk to a Human Representative</button></p>
    </section>`;
  on(qs("#cs-ai-form", body), "submit", (event) => {
    event.preventDefault();
    sendAi(body);
  });
  await loadAiHistory(body);
}

async function loadAiHistory(body) {
  const log = qs("#cs-ai-log", body);
  try {
    const { data, error } = await sb
      .from("support_ai_messages")
      .select("id, role, body, created_at")
      .order("created_at", { ascending: true })
      .limit(60);
    if (error) throw normalizeError(error);
    state.aiMessages = data || [];
  } catch (error) {
    if (log) log.innerHTML = setupNotice(error, "Customer Support");
    return;
  }
  paintAiLog(body);
}

function paintAiLog(body) {
  const log = qs("#cs-ai-log", body);
  if (!log) return;
  if (!state.aiMessages.length) {
    log.innerHTML = `<div class="cs-ai-hello">
      <p>Hi, I am the Shinzora support assistant. Ask me how something works, or what to do next.</p>
      <p class="dim">For example: "How do I create a group?", "Where do I buy a profile ring?", "My website will not publish."</p>
    </div>`;
    return;
  }
  log.innerHTML = state.aiMessages
    .map((m, i) => {
      const mine = m.role === "user";
      const last = i === state.aiMessages.length - 1;
      const escalate = !mine && last && !state.aiBusy
        ? `<div class="cs-ai-escalate"><span>Did this solve it?</span> <button type="button" class="btn btn-secondary btn-sm" data-escalate>No, talk to a human</button></div>`
        : "";
      return `<div class="cs-msg ${mine ? "is-mine" : "is-bot"}">
        <div class="cs-msg-who">${mine ? "You" : "Shinzora support"}</div>
        <div class="cs-msg-body">${esc(m.body)}</div>
        ${escalate}
      </div>`;
    })
    .join("");
  if (state.aiBusy) {
    log.insertAdjacentHTML("beforeend", `<div class="cs-msg is-bot"><div class="cs-msg-who">Shinzora support</div><div class="cs-msg-body dim">Typing…</div></div>`);
  }
  log.scrollTop = log.scrollHeight;
}

async function sendAi(body) {
  const input = qs("#cs-ai-input", body);
  const send = qs("#cs-ai-send", body);
  const text = (input?.value || "").trim();
  if (!text || state.aiBusy) return;
  state.aiBusy = true;
  state.lastAiQuestion = text;
  state.aiMessages = [...state.aiMessages, { id: `tmp-${Date.now()}`, role: "user", body: text, created_at: new Date().toISOString() }];
  input.value = "";
  if (send) send.disabled = true;
  paintAiLog(body);
  try {
    const reply = await invoke("support-ai", "ask", { message: text }, { timeout: 60000 });
    state.aiMessages = [...state.aiMessages, { id: `bot-${Date.now()}`, role: "assistant", body: reply?.reply || "", created_at: new Date().toISOString() }];
    state.aiReady = true;
  } catch (error) {
    state.aiMessages = state.aiMessages.filter((m) => !String(m.id).startsWith("tmp-") || m.body !== text);
    input.value = text;
    if (error?.code === "rate_limited" || error?.status === 429) {
      toastError(error, "You have sent many questions. Try again later.");
    } else if (error?.code === "fn_503" || error?.status === 503) {
      state.aiReady = false;
      toastError(error, "The support assistant is not switched on yet.");
    } else {
      toastError(error, "The assistant could not answer. Try again.");
    }
  } finally {
    state.aiBusy = false;
    if (send) send.disabled = false;
    paintAiLog(body);
  }
}

/* ---------------------------------------------------------------------------
   Talk to a Human: Via Call or Via Chat
   ------------------------------------------------------------------------- */

function paintHumanChoice(body) {
  body.innerHTML = `
    <section class="card cs-human" aria-label="Talk to a human">
      <div class="card-head">${backButton()}<div class="card-title">Talk to a Human Representative</div></div>
      <div class="card-body">
        <p class="card-desc">Choose how you would like to reach us.</p>
        <div class="cs-choices">
          <button type="button" class="card cs-choice" id="cs-via-call">
            <span class="cs-choice-icon">${icon("phone", { size: 20 })}</span>
            <span class="cs-choice-title">Via Call</span>
            <span class="cs-choice-desc">Leave your phone number. A representative will call you back.</span>
          </button>
          <button type="button" class="card cs-choice" id="cs-via-chat">
            <span class="cs-choice-icon">${icon("message-square", { size: 20 })}</span>
            <span class="cs-choice-title">Via Chat</span>
            <span class="cs-choice-desc">Write your issue here. A representative replies in this thread.</span>
          </button>
        </div>
      </div>
    </section>`;
  on(qs("#cs-via-call", body), "click", () => {
    state.screen = "human-call";
    paintBody();
  });
  on(qs("#cs-via-chat", body), "click", () => {
    state.screen = "human-chat";
    paintBody();
  });
}

function requestFields(channel) {
  const prefill = channel === "chat" ? state.lastAiQuestion : "";
  return `
    <label class="field"><span class="field-label">Subject</span>
      <input class="input" name="subject" maxlength="160" required placeholder="A short title for your issue"></label>
    <label class="field"><span class="field-label">What do you need help with?</span>
      <textarea class="input" name="message" rows="5" maxlength="4000" required placeholder="What you tried, what you expected, and what happened instead">${esc(prefill)}</textarea></label>`;
}

function paintCallForm(body) {
  body.innerHTML = `
    <section class="card cs-human" aria-label="Request a call">
      <div class="card-head">${backButton("Back to options")}<div class="card-title">Via Call</div></div>
      <form class="card-body stack" id="cs-form">
        <p class="card-desc">We will call the number you give. Tell us when it is best to reach you.</p>
        ${requestFields("call")}
        <label class="field"><span class="field-label">Phone number</span>
          <input class="input" name="phone" type="tel" inputmode="tel" maxlength="20" required placeholder="+91 98765 43210"></label>
        <label class="field"><span class="field-label">Best time to call (optional)</span>
          <input class="input" name="best_time" maxlength="120" placeholder="For example: weekdays after 6 pm"></label>
        <div class="cs-actions">
          <button class="btn btn-primary" type="submit" id="cs-submit">Request a call</button>
        </div>
      </form>
    </section>`;
  on(qs("#cs-form", body), "submit", (event) => submitRequest(event, "call", body));
}

function paintChatForm(body) {
  body.innerHTML = `
    <section class="card cs-human" aria-label="Start a chat">
      <div class="card-head">${backButton("Back to options")}<div class="card-title">Via Chat</div></div>
      <form class="card-body stack" id="cs-form">
        <p class="card-desc">Your first message starts the thread. You can follow the reply and send more under My requests.</p>
        ${requestFields("chat")}
        <div class="cs-actions">
          <button class="btn btn-primary" type="submit" id="cs-submit">Start chat</button>
        </div>
      </form>
    </section>`;
  on(qs("#cs-form", body), "submit", (event) => submitRequest(event, "chat", body));
}

async function submitRequest(event, channel, body) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = qs("#cs-submit", body);
  const fd = new FormData(form);
  const payload = {
    p_channel: channel,
    p_subject: String(fd.get("subject") || "").trim(),
    p_message: String(fd.get("message") || "").trim(),
    p_phone: channel === "call" ? String(fd.get("phone") || "").trim() : null,
    p_best_time: channel === "call" ? String(fd.get("best_time") || "").trim() : null
  };
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Sending…";
  }
  try {
    const { data, error } = await sb.rpc("support_request_create", payload);
    if (error) throw normalizeError(error);
    state.openRequest = data || null;
    state.screen = "received";
    state.lastAiQuestion = "";
    await loadNote();
    paintBody();
  } catch (error) {
    toastError(error, "Your request could not be sent. Check the form and try again.");
    if (submit) {
      submit.disabled = false;
      submit.textContent = channel === "call" ? "Request a call" : "Start chat";
    }
  }
}

async function loadNote() {
  try {
    const { data } = await sb.from("support_settings").select("value").eq("key", "response_time_note").maybeSingle();
    state.note = String(data?.value || "").trim();
  } catch {
    state.note = "";
  }
}

function paintReceived(body) {
  const req = state.openRequest;
  body.innerHTML = `
    <section class="card cs-received" role="status" aria-live="polite">
      <div class="cs-received-mark">${icon("circle-check", { size: 22 })}</div>
      <p class="cs-received-text" id="cs-received-text">${esc(RECEIVED_TEXT)}</p>
      ${state.note ? `<p class="cs-received-note">Team note: ${esc(state.note)}</p>` : ""}
      <p class="dim cs-received-meta">${req ? `${esc(CHANNEL_LABEL[req.channel] || "Support")} request · ${esc(req.subject)}` : ""}</p>
      <div class="cs-actions">
        <button class="btn btn-primary btn-sm" type="button" id="cs-see-requests">View my requests</button>
        <button class="btn btn-secondary btn-sm" type="button" id="cs-new-request">Back to support</button>
      </div>
    </section>`;
  on(qs("#cs-see-requests", body), "click", () => {
    state.tab = "requests";
    state.screen = "home";
    state.openRequest = null;
    render(state.root);
  });
  on(qs("#cs-new-request", body), "click", () => {
    state.screen = "home";
    paintBody();
  });
}

/* ---------------------------------------------------------------------------
   My requests: status, and the chat thread for chat requests
   ------------------------------------------------------------------------- */

async function paintRequests(body) {
  if (state.openRequest?.id) return paintRequestDetail(body);
  body.innerHTML = skeletonView(3);
  try {
    const { data, error } = await sb
      .from("support_requests")
      .select("id, channel, subject, status, created_at, updated_at, last_message_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw normalizeError(error);
    state.requests = data || [];
  } catch (error) {
    body.innerHTML = setupNotice(error, "Customer Support");
    return;
  }
  if (!state.requests.length) {
    body.innerHTML = `<div class="card">${emptyState({
      icon: "life-buoy",
      title: "No requests yet",
      desc: "When you ask for a call or start a chat with our team, it appears here with its status.",
      action: `<button class="btn btn-primary btn-sm" type="button" id="cs-empty-human">Talk to a Human Representative</button>`
    })}</div>`;
    on(qs("#cs-empty-human", body), "click", () => {
      state.tab = "help";
      state.screen = "human";
      render(state.root);
    });
    return;
  }
  body.innerHTML = `
    <div class="card cs-requests">
      <div class="cs-requests-head">
        <span class="dim">${state.requests.length} request${state.requests.length === 1 ? "" : "s"}</span>
        <button class="btn btn-ghost btn-sm" type="button" id="cs-refresh">${icon("repeat", { size: 14 })}Refresh</button>
      </div>
      <ul class="cs-list" role="list">
        ${state.requests
          .map(
            (r) => `<li><button type="button" class="cs-row" data-request="${esc(r.id)}">
              <span class="cs-row-main">
                <strong>${esc(r.subject)}</strong>
                <span class="dim">${esc(CHANNEL_LABEL[r.channel] || "Support")} · ${esc(timeAgo(r.created_at))}</span>
              </span>
              <span class="cs-row-status">${statusTag(r.status)}</span>
            </button></li>`
          )
          .join("")}
      </ul>
    </div>`;
  on(qs("#cs-refresh", body), "click", () => paintRequests(body));
  delegate(body, "click", "[data-request]", (_e, el) => {
    state.openRequest = state.requests.find((r) => r.id === el.getAttribute("data-request")) || null;
    paintRequests(body);
  });
}

function statusTag(status) {
  const label = STATUS_LABEL[status] || status;
  return `<span class="cs-status cs-status-${esc(status)}">${esc(label)}</span>`;
}

async function paintRequestDetail(body) {
  const req = state.openRequest;
  body.innerHTML = skeletonView(2);
  if (req.channel === "chat") {
    try {
      const { data, error } = await sb
        .from("support_request_messages")
        .select("id, author_role, body, created_at")
        .eq("request_id", req.id)
        .order("created_at", { ascending: true });
      if (error) throw normalizeError(error);
      state.thread = data || [];
    } catch (error) {
      body.innerHTML = setupNotice(error, "Customer Support");
      return;
    }
  } else {
    state.thread = [];
  }
  const closed = ["resolved", "closed"].includes(req.status);
  body.innerHTML = `
    <section class="card cs-detail">
      <div class="card-head cs-ai-head">
        ${backButton("All requests")}
        <div class="cs-detail-title">
          <div class="card-title">${esc(req.subject)}</div>
          <div class="card-desc">${esc(CHANNEL_LABEL[req.channel] || "Support")} · sent ${esc(dateTime(req.created_at))} · ${statusTag(req.status)}</div>
        </div>
      </div>
      ${req.channel === "call"
        ? `<div class="card-body"><p class="card-desc">A representative will call the number you gave. Status changes here as the team works on it.</p></div>`
        : `<div class="cs-ai-log" id="cs-thread">${state.thread.map(threadRow).join("") || `<p class="dim">No messages yet.</p>`}</div>
           ${closed
             ? `<p class="cs-ai-foot">This request is ${esc((STATUS_LABEL[req.status] || req.status).toLowerCase())}. Start a new request if you still need help.</p>`
             : `<form class="cs-ai-form" id="cs-reply-form">
                  <label class="sr-only" for="cs-reply">Reply</label>
                  <textarea id="cs-reply" class="input" rows="2" maxlength="4000" placeholder="Write a reply"></textarea>
                  <button class="btn btn-primary" type="submit" id="cs-reply-send">${icon("send", { size: 14 })}Send</button>
                </form>`}`}
    </section>`;
  const form = qs("#cs-reply-form", body);
  if (form) {
    on(form, "submit", async (event) => {
      event.preventDefault();
      const input = qs("#cs-reply", body);
      const text = (input.value || "").trim();
      if (!text) return;
      const send = qs("#cs-reply-send", body);
      send.disabled = true;
      try {
        const { error } = await sb.rpc("support_request_reply", { p_request: req.id, p_body: text });
        if (error) throw normalizeError(error);
        await paintRequestDetail(body);
      } catch (error) {
        toastError(error, "Your reply could not be sent.");
        send.disabled = false;
      }
    });
  }
}

function threadRow(m) {
  const mine = m.author_role === "user";
  return `<div class="cs-msg ${mine ? "is-mine" : "is-bot"}">
    <div class="cs-msg-who">${mine ? "You" : "Shinzora team"} · <span class="dim">${esc(timeAgo(m.created_at))}</span></div>
    <div class="cs-msg-body">${esc(m.body)}</div>
  </div>`;
}
