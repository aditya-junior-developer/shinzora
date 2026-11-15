/* ==========================================================================
   Shinzora — Investor decks (owner only, P9)
   A business owner builds a short deck, reads the draft, marks it ready, and
   shares it with an investor by handle. Two ways to start:

     AI draft        free. The AI writes from the parts of the business you tick.
     Write it yourself  you write every slide; the PDF export is Rs 20 per export.

   The browser shows the rules; the database and the deck function enforce them
   (ready needs three slides, sharing needs ready, export needs a payment for a
   manual deck, and only an owner can do any of it).
   ========================================================================== */

import { qs, qsa, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { api } from "../../../lib/api.js";
import { pageHead, emptyState, skeletonView, chip, setupNotice } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import { timeAgo } from "../../../lib/format.js";
import { statusById } from "../../../config/request-services.js";
import {
  EXPERT_REQUEST_TYPE,
  EXPERT_BRIEF_MIN,
  EXPERT_BRIEF_MAX,
  EXPERT_CONFIRMATION,
  DECK_SECTIONS,
  DECK_MODES,
  DECK_MAX_SLIDES,
  DECK_MIN_READY_SLIDES,
  DECK_MAX_BULLETS,
  DECK_MAX_BULLET_CHARS,
  DECK_PDF_RUPEES,
  DECK_AI_CREDITS,
  SHARE_NOTE
} from "../../../config/investor-deck.js";

const DECK_COLUMNS = "id, title, mode, status, data_sections, slides, updated_at, created_at";

let root = null;
let navigateTo = () => {};

export default async function render(host, { params, navigate }) {
  root = host;
  navigateTo = navigate;
  const id = params.get("id");
  const paid = params.get("paid");
  root.innerHTML = skeletonView(3);

  try {
    if (id) await paintEditor(id, { paid });
    else await paintList({ fresh: params.get("new") === "1" });
  } catch (error) {
    const normalized = normalizeError(error);
    root.innerHTML = `${pageHead({ title: "Investor decks", desc: "Share a short deck with an investor." })}
      ${setupNotice(normalized, "Investor decks")}`;
  }
}

/* ------------------------------------------------------------------ helpers */

const inr = (value) =>
  Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

function slideCount(deck) {
  return Array.isArray(deck.slides) ? deck.slides.length : 0;
}

function statusChip(deck) {
  return deck.status === "ready"
    ? chip("Ready to share", { tone: "ok", iconName: "circle-check" })
    : chip("Draft", { tone: "neutral", iconName: "pencil" });
}

function modeChip(deck) {
  return deck.mode === "ai" ? chip("AI draft", { tone: "info", iconName: "wand-sparkles" }) : chip("Written by you", { tone: "violet", iconName: "file-pen-line" });
}

/* Turns a data snapshot into slide bullets. The wording states the figure and
   its source, so nothing reads as a claim the owner did not put there. */
function bulletsFor(section, data) {
  if (!data) return [];
  if (section === "business" && data.business) {
    const b = data.business;
    return [
      [b.name, b.category, b.location].filter(Boolean).join(" · "),
      b.stage ? `Stage: ${b.stage}` : "",
      b.targetAudience ? `Audience: ${b.targetAudience}` : "",
      b.description ? String(b.description).slice(0, DECK_MAX_BULLET_CHARS) : ""
    ].filter(Boolean);
  }
  if (section === "inventory" && data.inventory) {
    const i = data.inventory;
    return [
      `${inr(i.products)} products listed`,
      `${inr(i.unitsInStock)} units in stock`,
      `${inr(i.publishedOnWebsite)} shown on your website`
    ];
  }
  if (section === "sales") {
    const rows = Array.isArray(data.sales) ? data.sales : [];
    if (!rows.length) return ["No orders in the last 30 days."];
    return rows.map((row) => `Last 30 days: ${inr(row.orders)} orders, revenue ${row.currency === "INR" || !row.currency ? "Rs " : `${row.currency} `}${inr(row.revenue)}`);
  }
  return [];
}

const sectionLabel = (id) => DECK_SECTIONS.find((s) => s.id === id)?.label || id;

/* ------------------------------------------------------------------ list */

async function paintList({ fresh = false } = {}) {
  const { data: decks, error } = await sb.from("investor_decks").select(DECK_COLUMNS).order("updated_at", { ascending: false });
  if (error) throw error;

  /* Expert requests the member has sent, with the status the team sets. Read
     under the member's own row-level security. */
  const { data: expertRows } = await sb
    .from("service_requests")
    .select("id, title, status, created_at")
    .eq("service_type", EXPERT_REQUEST_TYPE)
    .order("created_at", { ascending: false })
    .limit(20);
  const expertRequests = expertRows || [];

  root.innerHTML = `
    ${pageHead({
      title: "Investor deck",
      desc: "Build a short deck for an investor. Share only the slides you choose.",
      actions: `<button class="btn btn-primary btn-sm" type="button" data-deck-new>${icon("plus", { size: 14 })} New deck</button>`
    })}
    <div id="deck-builder" ${fresh ? "" : "hidden"}>${builderMarkup()}</div>
    ${expertRequestsMarkup(expertRequests)}
    ${
      (decks || []).length
        ? `<div class="deck-grid">${(decks || []).map(deckCard).join("")}</div>`
        : emptyState({
            iconName: "layers",
            title: "No decks yet",
            desc: "Start with an AI draft (5 credits), or send your brief to our experts and we deliver the finished deck to your email. You can share a deck once it has at least three slides.",
            action: `<button class="btn btn-primary btn-sm" type="button" data-deck-new>${icon("plus", { size: 14 })} Start a deck</button>`
          })
    }
    <p class="field-hint deck-note">${esc(SHARE_NOTE)}</p>`;

  qsa("[data-deck-new]", root).forEach((btn) => on(btn, "click", () => toggleBuilder(true)));
  bindBuilder();
}

function deckCard(deck) {
  return `<a class="card deck-card" href="?view=investor-decks&id=${esc(deck.id)}">
    <div class="deck-card-head">${modeChip(deck)} ${statusChip(deck)}</div>
    <strong class="deck-card-title">${esc(deck.title)}</strong>
    <span class="field-hint">${slideCount(deck)} slide${slideCount(deck) === 1 ? "" : "s"} · edited ${esc(timeAgo(deck.updated_at))}</span>
  </a>`;
}

function builderMarkup() {
  return `
    <form class="card deck-builder" id="deck-form" novalidate>
      <h2 class="card-title">${icon("layers", { size: 16 })} Start a deck</h2>
      <div class="field" data-field="title">
        <label class="field-label" for="deck-title">Deck title</label>
        <input class="input" id="deck-title" maxlength="120" placeholder="Seed round, 2027" autocomplete="off" />
      </div>
      <div class="deck-modes" role="radiogroup" aria-label="How to start">
        ${Object.values(DECK_MODES)
          .filter((mode) => mode.creatable)
          .map(
            (mode, i) => `<label class="deck-mode ${i === 0 ? "is-selected" : ""}">
              <input type="radio" name="deck-mode" value="${mode.id}" ${i === 0 ? "checked" : ""} />
              <strong>${esc(mode.label)}</strong>
              <span class="deck-mode-price">${esc(mode.price)}</span>
              <span class="field-hint">${esc(mode.desc)}</span>
            </label>`
          )
          .join("")}
      </div>
      <fieldset class="deck-sections" id="deck-sections" data-field="sections">
        <legend class="field-label">Parts of your business the draft may use</legend>
        ${DECK_SECTIONS.map(
          (s) => `<label class="deck-section"><input type="checkbox" name="deck-section" value="${s.id}" ${s.id === "business" ? "checked" : ""} />
            <span><strong>${esc(s.label)}</strong><span class="field-hint">${esc(s.desc)}</span></span></label>`
        ).join("")}
        <span class="field-hint">Nothing else is read. The draft uses only what you tick.</span>
      </fieldset>
      <div class="field" id="deck-brief-field">
        <label class="field-label" for="deck-brief">What is this deck for? <span class="field-hint" id="deck-brief-hint">(optional)</span></label>
        <textarea class="input" id="deck-brief" rows="3" maxlength="600" placeholder="A seed round to open a second roastery in Gurugram."></textarea>
      </div>
      <div class="field-error" id="deck-error" role="alert"></div>
      <div class="card-actions">
        <button class="btn btn-primary" type="submit" id="deck-create">${icon("wand-sparkles", { size: 14 })} Draft with AI · ${DECK_AI_CREDITS} credits</button>
        <button class="btn btn-ghost" type="button" data-deck-cancel>Cancel</button>
      </div>
    </form>`;
}

function toggleBuilder(open) {
  const panel = qs("#deck-builder", root);
  if (!panel) return;
  panel.hidden = !open;
  if (open) qs("#deck-title", root)?.focus();
}

function bindBuilder() {
  const form = qs("#deck-form", root);
  if (!form) return;

  const syncMode = () => {
    const mode = form.querySelector("input[name=deck-mode]:checked")?.value || "ai";
    qsa(".deck-mode", form).forEach((label) => label.classList.toggle("is-selected", label.querySelector("input").checked));
    const isAi = mode === "ai";
    /* Both kinds read the parts of the business the owner ticks and the brief.
       An expert brief is required; an AI brief is optional. */
    qs("#deck-sections", form).hidden = false;
    qs("#deck-brief-field", form).hidden = false;
    qs("#deck-brief-hint", form).textContent = isAi ? "(optional)" : `(required, at least ${EXPERT_BRIEF_MIN} characters)`;
    qs("#deck-create", form).innerHTML = isAi
      ? `${icon("wand-sparkles", { size: 14 })} Draft with AI · ${DECK_AI_CREDITS} credits`
      : `${icon("users", { size: 14 })} Send to our experts`;
  };
  qsa("input[name=deck-mode]", form).forEach((input) => on(input, "change", syncMode));
  syncMode();

  on(qs("[data-deck-cancel]", form), "click", () => toggleBuilder(false));

  on(form, "submit", async (event) => {
    event.preventDefault();
    const error = qs("#deck-error", form);
    error.textContent = "";
    const title = String(qs("#deck-title", form).value || "").trim();
    const mode = form.querySelector("input[name=deck-mode]:checked")?.value || "ai";
    const sections = qsa("input[name=deck-section]:checked", form).map((i) => i.value);
    if (title.length < 2) {
      error.textContent = "Give the deck a title of at least two characters.";
      qs("#deck-title", form).focus();
      return;
    }
    const submit = qs("#deck-create", form);
    if (mode === "expert") {
      const brief = String(qs("#deck-brief", form).value || "").trim();
      if (brief.length < EXPERT_BRIEF_MIN) {
        error.textContent = `Describe what the deck should say, at least ${EXPERT_BRIEF_MIN} characters.`;
        qs("#deck-brief", form).focus();
        return;
      }
      if (brief.length > EXPERT_BRIEF_MAX) {
        error.textContent = `Keep the brief to ${EXPERT_BRIEF_MAX} characters.`;
        return;
      }
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
      try {
        await submitExpertRequest({ title, sections, brief });
        form.reset();
        toast({ title: "Request sent", message: EXPERT_CONFIRMATION }, { tone: "success" });
        await paintList({ fresh: false });
      } catch (err) {
        const normalized = normalizeError(err);
        error.textContent = normalized.message || "The request could not be sent. Please try again.";
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
      }
      return;
    }
    submit.disabled = true;
    try {
      if (mode === "ai") {
        if (!sections.length) {
          error.textContent = "Tick at least one part of your business for the draft to use.";
          return;
        }
        submit.innerHTML = `${icon("loader-circle", { size: 14 })} Drafting…`;
        const response = await api.deck.generate({
          title,
          sections,
          brief: String(qs("#deck-brief", form).value || "").trim()
        });
        toast({ title: "Draft ready", message: "Read it through, edit anything, then mark it ready to share." }, { tone: "success" });
        navigateTo("investor-decks", { id: response.deck.id });
      } else {
        const { data, error: insertError } = await sb
          .from("investor_decks")
          .insert({ owner_id: state.user?.id, title, mode: "manual", status: "draft", data_sections: [], slides: [{ title, bullets: [] }] })
          .select("id")
          .single();
        if (insertError) throw normalizeError(insertError);
        navigateTo("investor-decks", { id: data.id });
      }
    } catch (err) {
      const normalized = normalizeError(err);
      error.textContent = normalized.message || "The deck could not be started.";
      if (normalized.code === "owner_only") error.textContent = "Only business owners can build an investor deck.";
    } finally {
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------- written by experts */

/** Sends the brief to the team. The row is what admins see and act on. */
async function submitExpertRequest({ title, sections, brief }) {
  const email = state.user?.email || state.session?.user?.email || "";
  if (!email) throw new Error("Your registered email is needed to deliver the deck. Check your account details and try again.");
  const name = String(state.profile?.full_name || state.profile?.business_name || email).slice(0, 120);
  const parts = sections.length ? sections.join(", ") : "none";

  const { data, error } = await sb
    .from("service_requests")
    .insert({
      owner_id: state.user.id,
      service_type: EXPERT_REQUEST_TYPE,
      title: `Investor deck: ${title}`.slice(0, 120),
      details: brief,
      custom_description: `Deck title: ${title}\nParts of the business to use: ${parts}\n\n${brief}`,
      budget_inr: null,
      contact_name: name,
      contact_email: email,
      contact_phone: null,
      status: "submitted"
    })
    .select("id")
    .single();
  if (error) throw normalizeError(error);
  return data;
}

function expertRequestsMarkup(rows) {
  if (!rows.length) return "";
  return `<section class="card deck-requests" aria-labelledby="deck-requests-title">
    <h2 class="card-title" id="deck-requests-title">${icon("users", { size: 16 })} Written by experts</h2>
    <ul class="deck-request-list">
      ${rows
        .map((row) => {
          const status = statusById(row.status) || { label: row.status || "Submitted", tone: "info" };
          return `<li class="deck-request">
            <div class="deck-request-body">
              <strong>${esc(row.title || "Investor deck")}</strong>
              <span class="field-hint">Requested ${esc(timeAgo(row.created_at))}. The finished file goes to your registered email.</span>
            </div>
            ${chip(status.label, { tone: status.tone })}
          </li>`;
        })
        .join("")}
    </ul>
  </section>`;
}

/* ------------------------------------------------------------------ editor */

async function paintEditor(id, { paid = null } = {}) {
  const { data: deck, error } = await sb.from("investor_decks").select(DECK_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!deck) {
    root.innerHTML = `${pageHead({ title: "Deck not found", desc: "It may have been removed." })}
      <div class="card"><a class="btn btn-secondary btn-sm" href="?view=investor-decks">Back to decks</a></div>`;
    return;
  }

  const shares = await loadShares(id);
  const draft = {
    id: deck.id,
    title: deck.title,
    mode: deck.mode,
    status: deck.status,
    slides: (Array.isArray(deck.slides) ? deck.slides : []).map((s) => ({ title: s.title || "", bullets: Array.isArray(s.bullets) ? s.bullets.slice() : [] }))
  };

  root.innerHTML = `
    ${pageHead({
      title: draft.title,
      desc: draft.mode === "ai" ? "An AI draft. Read it, edit it, then mark it ready." : "Written by you. The PDF export is Rs 20 per export.",
      actions: `<a class="btn btn-ghost btn-sm" href="?view=investor-decks">${icon("arrow-up", { size: 13 })} All decks</a>`
    })}
    ${paid === "1" ? `<div class="deck-notice is-good">${icon("circle-check", { size: 14 })} Payment noted. The export unlocks once the payment is verified, usually within a day.</div>` : ""}
    <div class="deck-editor">
      <section class="card deck-slides" id="deck-slides" aria-label="Slides"></section>
      <aside class="deck-side">
        <div class="card deck-panel">
          <h2 class="card-title">${icon("layers", { size: 15 })} Deck</h2>
          <div class="field" data-field="title">
            <label class="field-label" for="deck-name">Title</label>
            <input class="input" id="deck-name" maxlength="120" value="${esc(draft.title)}" />
          </div>
          <div class="deck-status-row">${modeChip(draft)} ${statusChip(draft)}</div>
          <div class="card-actions deck-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-deck-save>${icon("download", { size: 13 })} Save</button>
            <button class="btn btn-primary btn-sm" type="button" data-deck-ready>${draft.status === "ready" ? "Back to draft" : "Mark ready to share"}</button>
          </div>
          <p class="field-hint">Ready needs at least ${DECK_MIN_READY_SLIDES} slides. You can change a deck back to draft at any time.</p>
        </div>
        <div class="card deck-panel" id="deck-export"></div>
        <div class="card deck-panel" id="deck-sharing"></div>
        <div class="card deck-panel deck-danger">
          <button class="btn btn-ghost btn-sm" type="button" data-deck-delete>${icon("trash-2", { size: 13 })} Delete deck</button>
        </div>
      </aside>
    </div>`;

  renderSlides(draft);
  renderExport(draft);
  renderSharing(draft, shares);
  bindEditor(draft);
}

async function loadShares(deckId) {
  const { data, error } = await sb
    .from("investor_deck_shares")
    .select("id, investor_id, shared_at, revoked_at, investor:profiles!investor_id(username)")
    .eq("deck_id", deckId)
    .order("shared_at", { ascending: false });
  if (error) return [];
  return data || [];
}

function slideMarkup(slide, i, total) {
  return `<div class="deck-slide" data-slide="${i}">
    <div class="deck-slide-head">
      <span class="deck-slide-no">${i + 1}</span>
      <input class="input deck-slide-title" data-slide-title maxlength="120" value="${esc(slide.title)}" aria-label="Slide ${i + 1} title" />
      <div class="deck-slide-tools">
        <button class="btn btn-ghost btn-sm" type="button" data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="Move slide up">${icon("arrow-up", { size: 13 })}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-move="1" ${i === total - 1 ? "disabled" : ""} aria-label="Move slide down">${icon("arrow-down", { size: 13 })}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-remove ${total === 1 ? "disabled" : ""} aria-label="Remove slide">${icon("x", { size: 13 })}</button>
      </div>
    </div>
    <textarea class="input deck-slide-body" data-slide-body rows="${Math.max(3, slide.bullets.length + 1)}" placeholder="One point per line. Up to ${DECK_MAX_BULLETS}.">${esc(slide.bullets.join("\n"))}</textarea>
  </div>`;
}

function renderSlides(draft) {
  const host = qs("#deck-slides", root);
  if (!host) return;
  const total = draft.slides.length;
  const addDisabled = total >= DECK_MAX_SLIDES;
  host.innerHTML = `
    <div class="deck-slides-head">
      <h2 class="card-title">${icon("file-text", { size: 16 })} Slides <span class="field-hint">${total} of ${DECK_MAX_SLIDES}</span></h2>
      <div class="deck-add">
        <button class="btn btn-secondary btn-sm" type="button" data-add-slide ${addDisabled ? "disabled" : ""}>${icon("plus", { size: 13 })} Add slide</button>
        <select class="input deck-data-pick" data-data-section aria-label="Add a slide from your data" ${addDisabled ? "disabled" : ""}>
          <option value="">Add from my data…</option>
          ${DECK_SECTIONS.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}
        </select>
      </div>
    </div>
    ${draft.slides.map((slide, i) => slideMarkup(slide, i, total)).join("")}
    <p class="field-hint">Data slides are copied in as they are today. They do not stay linked to your account.</p>`;
}

/* Read what the owner typed before any structural change, so nothing is lost. */
function readSlides(draft) {
  qsa(".deck-slide", root).forEach((node, i) => {
    if (!draft.slides[i]) return;
    draft.slides[i].title = qs("[data-slide-title]", node).value;
    draft.slides[i].bullets = qs("[data-slide-body]", node).value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  });
  draft.title = qs("#deck-name", root)?.value ?? draft.title;
}

function validateDraft(draft) {
  if (!draft.title || draft.title.trim().length < 2) return "Give the deck a title of at least two characters.";
  if (draft.slides.length < 1) return "A deck needs at least one slide.";
  if (draft.slides.length > DECK_MAX_SLIDES) return `A deck holds at most ${DECK_MAX_SLIDES} slides.`;
  for (const slide of draft.slides) {
    if (!slide.title.trim()) return "Every slide needs a title.";
    if (slide.bullets.length > DECK_MAX_BULLETS) return `A slide holds at most ${DECK_MAX_BULLETS} points.`;
    if (slide.bullets.some((b) => b.length > DECK_MAX_BULLET_CHARS)) return `Keep each point under ${DECK_MAX_BULLET_CHARS} characters.`;
  }
  return "";
}

function renderExport(draft) {
  const host = qs("#deck-export", root);
  if (!host) return;
  const isAi = draft.mode === "ai";
  host.innerHTML = `
    <h2 class="card-title">${icon("download", { size: 15 })} PDF</h2>
    <p class="field-hint">${isAi ? "AI drafts export free." : `Each export costs Rs ${DECK_PDF_RUPEES}. Pay once per export.`}</p>
    <button class="btn btn-secondary btn-sm" type="button" data-export>${icon("download", { size: 13 })} ${isAi ? "Download PDF" : `Export PDF · Rs ${DECK_PDF_RUPEES}`}</button>`;
}

function renderSharing(draft, shares) {
  const host = qs("#deck-sharing", root);
  if (!host) return;
  if (draft.status !== "ready") {
    host.innerHTML = `
      <h2 class="card-title">${icon("users-round", { size: 15 })} Share with an investor</h2>
      <p class="field-hint">Mark the deck ready to share it. An investor needs an investor account to receive it.</p>`;
    return;
  }
  const active = shares.filter((s) => !s.revoked_at);
  host.innerHTML = `
    <h2 class="card-title">${icon("users-round", { size: 15 })} Share with an investor</h2>
    <form id="deck-share-form" class="deck-share-form" novalidate>
      <div class="field" data-field="investor">
        <label class="field-label" for="deck-share-handle">Their handle</label>
        <input class="input" id="deck-share-handle" maxlength="30" placeholder="ivy.investor" autocomplete="off" spellcheck="false" />
        <span class="field-hint">Ask them for their @handle. They must have joined as an investor.</span>
      </div>
      <div class="field-error" id="deck-share-error" role="alert"></div>
      <button class="btn btn-primary btn-sm" type="submit">${icon("send", { size: 13 })} Share</button>
    </form>
    <ul class="deck-shares">
      ${
        active.length
          ? active
              .map(
                (s) => `<li class="deck-share">
                  <span>@${esc(s.investor?.username || "investor")} <span class="field-hint">since ${esc(timeAgo(s.shared_at))}</span></span>
                  <button class="btn btn-ghost btn-sm" type="button" data-unshare="${esc(s.id)}">Stop sharing</button>
                </li>`
              )
              .join("")
          : `<li class="field-hint">Not shared with anyone yet.</li>`
      }
    </ul>`;

}

async function refreshSharing(draft) {
  const shares = await loadShares(draft.id);
  renderSharing(draft, shares);
}

function bindEditor(draft) {
  /* Every listener that reads `draft` hangs off the editor element, not the
     persistent root, so a repaint never stacks a second copy of an old handler. */
  const editor = qs(".deck-editor", root);

  delegate(editor, "submit", "#deck-share-form", async (event, form) => {
    event.preventDefault();
    const handle = String(qs("#deck-share-handle", form).value || "").trim().replace(/^@/, "");
    const error = qs("#deck-share-error", form);
    error.textContent = "";
    if (!handle) {
      error.textContent = "Enter the investor's handle.";
      return;
    }
    try {
      const { error: rpcError } = await sb.rpc("deck_share", { p_deck: draft.id, p_username: handle });
      if (rpcError) throw normalizeError(rpcError);
      toast({ title: "Shared", message: `@${handle} can now open this deck.` }, { tone: "success" });
      await refreshSharing(draft);
    } catch (err) {
      error.textContent = normalizeError(err).message || "The deck could not be shared.";
    }
  });

  delegate(editor, "click", "[data-unshare]", async (_event, button) => {
    const shareId = button.getAttribute("data-unshare");
    button.disabled = true;
    try {
      const { error: rpcError } = await sb.rpc("deck_unshare", { p_share: shareId });
      if (rpcError) throw normalizeError(rpcError);
      toast({ title: "Sharing stopped", message: "They no longer see this deck." }, { tone: "success" });
      await refreshSharing(draft);
    } catch (err) {
      toastError(err);
      button.disabled = false;
    }
  });

  const save = async ({ quiet = false } = {}) => {
    readSlides(draft);
    const problem = validateDraft(draft);
    if (problem) {
      toastError(new Error(problem));
      return false;
    }
    const { error } = await sb
      .from("investor_decks")
      .update({ title: draft.title.trim(), slides: draft.slides, updated_at: new Date().toISOString() })
      .eq("id", draft.id);
    if (error) {
      toastError(normalizeError(error));
      return false;
    }
    if (!quiet) toast({ title: "Saved" }, { tone: "success" });
    return true;
  };

  on(qs("[data-deck-save]", root), "click", () => save());

  on(qs("[data-deck-ready]", root), "click", async (event) => {
    const button = event.currentTarget;
    readSlides(draft);
    const nextStatus = draft.status === "ready" ? "draft" : "ready";
    if (nextStatus === "ready" && draft.slides.length < DECK_MIN_READY_SLIDES) {
      toastError(new Error(`Add at least ${DECK_MIN_READY_SLIDES} slides before you mark the deck ready.`));
      return;
    }
    if (!(await save({ quiet: true }))) return;
    button.disabled = true;
    const { error } = await sb.from("investor_decks").update({ status: nextStatus, updated_at: new Date().toISOString() }).eq("id", draft.id);
    button.disabled = false;
    if (error) {
      toastError(normalizeError(error));
      return;
    }
    draft.status = nextStatus;
    button.textContent = nextStatus === "ready" ? "Back to draft" : "Mark ready to share";
    qs(".deck-status-row", root).innerHTML = `${modeChip(draft)} ${statusChip(draft)}`;
    renderSharing(draft, await loadShares(draft.id));
    toast({ title: nextStatus === "ready" ? "Ready to share" : "Back to draft" }, { tone: "success" });
  });

  delegate(editor, "click", "[data-add-slide]", () => {
    readSlides(draft);
    if (draft.slides.length >= DECK_MAX_SLIDES) return;
    draft.slides.push({ title: "New slide", bullets: [] });
    renderSlides(draft);
  });

  delegate(editor, "change", "[data-data-section]", async (_event, select) => {
    const section = select.value;
    if (!section) return;
    readSlides(draft);
    if (draft.slides.length >= DECK_MAX_SLIDES) {
      toastError(new Error(`A deck holds at most ${DECK_MAX_SLIDES} slides.`));
      select.value = "";
      return;
    }
    try {
      const { data, error } = await sb.rpc("deck_data_snapshot", { p_sections: [section] });
      if (error) throw normalizeError(error);
      const bullets = bulletsFor(section, data?.sections).slice(0, DECK_MAX_BULLETS);
      draft.slides.push({ title: sectionLabel(section), bullets });
      renderSlides(draft);
    } catch (err) {
      toastError(err);
      select.value = "";
    }
  });

  delegate(editor, "click", "[data-move]", (_event, button) => {
    readSlides(draft);
    const i = Number(button.closest("[data-slide]").getAttribute("data-slide"));
    const j = i + Number(button.getAttribute("data-move"));
    if (j < 0 || j >= draft.slides.length) return;
    [draft.slides[i], draft.slides[j]] = [draft.slides[j], draft.slides[i]];
    renderSlides(draft);
  });

  delegate(editor, "click", "[data-remove]", (_event, button) => {
    readSlides(draft);
    if (draft.slides.length <= 1) return;
    const i = Number(button.closest("[data-slide]").getAttribute("data-slide"));
    draft.slides.splice(i, 1);
    renderSlides(draft);
  });

  on(qs("[data-export]", root), "click", () => exportPdf(draft, save));

  on(qs("[data-deck-delete]", root), "click", () => {
    openModal({
      title: "Delete this deck?",
      size: "sm",
      body: `<p class="muted" style="font-size:var(--fs-sm);line-height:1.7">"${esc(draft.title)}" and its sharing will be removed. Investors lose access straight away.</p>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Keep it</button>
               <button class="btn btn-danger" data-deck-confirm-delete>Delete</button>`,
      onMount: (modal) => {
        on(qs("[data-deck-confirm-delete]", modal), "click", async () => {
          const { error } = await sb.from("investor_decks").delete().eq("id", draft.id);
          if (error) {
            toastError(normalizeError(error));
            return;
          }
          toast({ title: "Deck deleted" });
          navigateTo("investor-decks");
        });
      }
    });
  });
}

async function exportPdf(draft, save) {
  const ok = await save({ quiet: true });
  if (!ok) return;
  try {
    const blob = await api.deck.export({ deckId: draft.id });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(draft.title || "investor-deck").replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "investor-deck"}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.code === "payment_required") {
      openModal({
        title: "Pay for this export",
        size: "sm",
        body: `<p class="muted" style="font-size:var(--fs-sm);line-height:1.7">A PDF export of a manual deck costs Rs ${DECK_PDF_RUPEES}. Pay once, and the export unlocks when the payment is verified.</p>`,
        footer: `<button class="btn btn-ghost" data-modal-close>Not now</button>
                 <button class="btn btn-primary" data-deck-pay>Pay Rs ${DECK_PDF_RUPEES}</button>`,
        onMount: (modal) => {
          on(qs("[data-deck-pay]", modal), "click", () => {
            navigateTo("billing", { buy: "deck_pdf", deck: draft.id });
          });
        }
      });
      return;
    }
    toastError(normalized);
  }
}
