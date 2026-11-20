/* ==========================================================================
   Shinzora — investor Requests (phase 3)
   Pitches that business owners have sent to this investor, from my_pitches().
   The investor can accept, decline, mark interest, or ask for more information.
   Accept and decline are final, so they ask first. Attachments open through a
   short-lived signed link; storage only allows the sender and the recipient.
   ========================================================================== */

import { qs, qsa, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead, skeletonView, emptyState, setupNotice, chip } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import { rpc, fmtTime, rupees } from "./investor-kit.js";

const STATUS = {
  pending: { label: "Pending", tone: "neutral" },
  interested: { label: "Interested", tone: "violet" },
  info_requested: { label: "Info requested", tone: "warn" },
  accepted: { label: "Accepted", tone: "ok" },
  declined: { label: "Declined", tone: "danger" }
};
const FILTERS = [["all", "All"], ["pending", "Pending"], ["interested", "Interested"], ["info_requested", "Info requested"], ["accepted", "Accepted"], ["declined", "Declined"]];
const OPEN = new Set(["pending", "interested", "info_requested"]);
const SIGNED_URL_SECONDS = 300;

let host = null;
let navigateTo = () => {};
let pitches = [];
let filter = "all";

export default async function render(root, { navigate } = {}) {
  host = root;
  navigateTo = navigate || (() => {});
  filter = "all";
  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Requests",
      desc: "Pitches from business owners. Read the details, then accept, decline, mark interest, or ask a question.",
      badge: chip("Pitches", { tone: "violet", iconName: "inbox" })
    })}
    <div id="req-tabs" class="req-tabs" role="tablist" aria-label="Filter by status"></div>
    <div id="req-results" aria-live="polite">${skeletonView(3)}</div>
  </div>`;
  host.addEventListener("click", onClick);
  await load();
}

async function load() {
  const box = qs("#req-results", host);
  if (!box) return;
  try {
    const rows = await rpc("my_pitches");
    pitches = (Array.isArray(rows) ? rows : []).filter((p) => p.role === "received");
    paintTabs();
    paint();
  } catch (error) {
    box.innerHTML = setupNotice(error, "Requests");
  }
}

function paintTabs() {
  const tabs = qs("#req-tabs", host);
  if (!tabs) return;
  tabs.innerHTML = FILTERS.map(([id, label]) => {
    const count = id === "all" ? pitches.length : pitches.filter((p) => p.status === id).length;
    const selected = filter === id;
    return `<button type="button" role="tab" class="req-tab" data-filter="${id}" aria-selected="${selected}">
      ${esc(label)} <span class="req-tab-count">${count}</span></button>`;
  }).join("");
}

function paint() {
  const box = qs("#req-results", host);
  if (!box) return;
  const rows = filter === "all" ? pitches : pitches.filter((p) => p.status === filter);
  if (!pitches.length) {
    box.innerHTML = emptyState({
      iconName: "inbox",
      title: "No pitches yet",
      desc: "When a business owner sends you a pitch, it appears here with its files and status."
    });
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<p class="field-hint">No pitches with this status.</p>`;
    return;
  }
  box.innerHTML = `<div class="req-list">${rows.map(card).join("")}</div>`;
}

function card(p) {
  const st = STATUS[p.status] || { label: p.status, tone: "neutral" };
  const files = Array.isArray(p.attachments) ? p.attachments : [];
  const isOpen = OPEN.has(p.status);
  return `<article class="card req-card inv-rise" data-pitch="${esc(p.id)}">
    <header class="req-head">
      <div class="req-title">
        <h2 class="req-name">${esc(p.title || "Pitch")}</h2>
        <p class="field-hint">${esc(p.business_name || "Business")} · from ${esc(p.counterpart_name || "Business owner")} · ${esc(fmtTime(p.created_at))}</p>
      </div>
      ${chip(st.label, { tone: st.tone })}
    </header>
    <dl class="req-facts">
      <div><dt>Funding asked</dt><dd>${p.funding_requested_inr != null ? esc(rupees(p.funding_requested_inr)) : "Not stated"}</dd></div>
      <div><dt>Attachments</dt><dd>${files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "None"}</dd></div>
      <div><dt>Last update</dt><dd>${esc(fmtTime(p.updated_at || p.created_at))}</dd></div>
    </dl>
    <p class="req-summary">${esc(p.summary || "")}</p>
    ${p.status === "info_requested" && p.info_request ? `<p class="req-info"><strong>You asked:</strong> ${esc(p.info_request)}</p>` : ""}
    ${files.length ? `<ul class="req-files" aria-label="Attachments">${files.map((f) => `<li>
        <button type="button" class="btn btn-ghost btn-sm" data-file="${esc(f.path)}" data-file-name="${esc(f.name || "file")}">${icon("eye", { size: 13 })} ${esc(f.name || "File")}</button>
      </li>`).join("")}</ul>` : ""}
    <div class="card-actions req-actions">
      ${isOpen ? `
        <button type="button" class="btn btn-primary btn-sm" data-decide="accepted" data-pitch-id="${esc(p.id)}">${icon("check", { size: 13 })} Accept</button>
        <button type="button" class="btn btn-ghost btn-sm" data-decide="declined" data-pitch-id="${esc(p.id)}">Decline</button>
        ${p.status !== "interested" ? `<button type="button" class="btn btn-ghost btn-sm" data-decide="interested" data-pitch-id="${esc(p.id)}">${icon("sparkles", { size: 13 })} Express interest</button>` : ""}
        <button type="button" class="btn btn-ghost btn-sm" data-ask="${esc(p.id)}">${icon("messages-square", { size: 13 })} Request more info</button>` : ""}
      <button type="button" class="btn btn-ghost btn-sm" data-message-owner="${esc(p.counterpart_id)}">${icon("messages-square", { size: 13 })} Message owner</button>
    </div>
  </article>`;
}

/* ----------------------------------------------------------- actions */

function find(id) {
  return pitches.find((p) => p.id === id);
}

async function respond(id, status, info = null) {
  await rpc("investor_respond_pitch", { p_pitch: id, p_status: status, p_info: info });
  const labels = { accepted: "Pitch accepted", declined: "Pitch declined", interested: "Interest sent to the owner", info_requested: "Question sent to the owner" };
  toast({ title: labels[status] || "Saved" }, { tone: "success" });
  await load();
}

function confirmDecision(id, status) {
  const p = find(id);
  if (!p) return;
  const accept = status === "accepted";
  const modal = openModal({
    title: accept ? "Accept this pitch?" : "Decline this pitch?",
    desc: "This answer is final. The owner is told straight away.",
    body: `<p class="req-summary">${esc(p.title || "Pitch")} from ${esc(p.counterpart_name || "the owner")}</p>`,
    footer: `<button class="btn btn-ghost" type="button" data-modal-close>Cancel</button>
      <button class="btn ${accept ? "btn-primary" : "btn-ghost"}" type="button" data-confirm>${accept ? "Accept" : "Decline"}</button>`,
    onMount: (node) => {
      node.querySelector("[data-confirm]")?.addEventListener("click", async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
          await respond(id, status);
          node.querySelector("[data-modal-close]")?.click();
        } catch (error) {
          btn.disabled = false;
          toastError(error);
        }
      });
    }
  });
  return modal;
}

function askForInfo(id) {
  const p = find(id);
  if (!p) return;
  openModal({
    title: "Request more information",
    desc: "Say what you need. The owner receives this with the pitch.",
    body: `<form id="ask-form" class="stack" novalidate>
      <div class="field" id="ask-field">
        <label class="field-label" for="ask-text">What do you need to know?</label>
        <textarea class="input" id="ask-text" name="info" rows="4" maxlength="1000" required></textarea>
        <p class="field-error" id="ask-error" hidden>Write at least three characters.</p>
      </div>
      <div class="card-actions"><button class="btn btn-primary" type="submit">Send question</button></div>
    </form>`,
    onMount: (node) => {
      const form = node.querySelector("#ask-form");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = node.querySelector("#ask-text").value.trim();
        const field = node.querySelector("#ask-field");
        const error = node.querySelector("#ask-error");
        if (text.length < 3) {
          field.classList.add("invalid");
          error.hidden = false;
          return;
        }
        const btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          await respond(id, "info_requested", text);
          node.querySelector("[data-modal-close]")?.click();
        } catch (err) {
          btn.disabled = false;
          toastError(err);
        }
      });
    }
  });
}

async function openFile(button) {
  const path = button.getAttribute("data-file");
  const name = button.getAttribute("data-file-name");
  button.disabled = true;
  try {
    const { data, error } = await sb.storage.from("pitch-attachments").createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw error || new Error("No link was returned.");
    window.open(data.signedUrl, "_blank", "noopener");
  } catch (error) {
    toast({ title: `Could not open ${name}`, desc: normalizeError(error).message }, { tone: "danger" });
  } finally {
    button.disabled = false;
  }
}

async function messageOwner(button) {
  const id = button.getAttribute("data-message-owner");
  button.disabled = true;
  try {
    const conversation = await rpc("open_direct_conversation", { p_user: id });
    navigateTo("investor-messages", { conversation: String(conversation) });
  } catch (error) {
    button.disabled = false;
    toastError(error);
  }
}

function onClick(event) {
  const tab = event.target.closest?.("[data-filter]");
  if (tab) {
    filter = tab.getAttribute("data-filter");
    qsa(".req-tab", host).forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    paint();
    return;
  }
  const decide = event.target.closest?.("[data-decide]");
  if (decide) {
    const status = decide.getAttribute("data-decide");
    const id = decide.getAttribute("data-pitch-id");
    if (status === "interested") {
      decide.disabled = true;
      respond(id, "interested").catch((error) => {
        decide.disabled = false;
        toastError(error);
      });
    } else {
      confirmDecision(id, status);
    }
    return;
  }
  const ask = event.target.closest?.("[data-ask]");
  if (ask) return askForInfo(ask.getAttribute("data-ask"));
  const file = event.target.closest?.("[data-file]");
  if (file) return openFile(file);
  const message = event.target.closest?.("[data-message-owner]");
  if (message) return messageOwner(message);
}

