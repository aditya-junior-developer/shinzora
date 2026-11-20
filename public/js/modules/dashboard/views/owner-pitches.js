/* ==========================================================================
   Shinzora — owner pitches (investor portal, phase 3)
   A business owner sends a pitch to a public investor, attaches up to five PDF
   or image files (10 MB each), and then follows its status: pending, interested,
   question asked, accepted or declined. The owner can message the investor once
   a pitch links them.

   Order matters: send_pitch creates the pitch, the files are uploaded under
   <pitch_id>/<file> (storage allows that only while the pitch is open), and then
   each file is recorded with add_pitch_attachment. If a file fails, the pitch
   still exists and the failure is reported, not hidden.
   ========================================================================== */

import { esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { chip, emptyState, setupNotice } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import { rpc, fmtTime, rupees } from "./investor-kit.js";
import { mountThread, destroyThreads } from "./investor-thread.js";

export const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_COUNT = 5;
const TITLE_MIN = 3;
const SUMMARY_MIN = 20;
const SIGNED_URL_SECONDS = 300;

const STATUS = {
  pending: { label: "Waiting for reply", tone: "neutral" },
  interested: { label: "Investor is interested", tone: "violet" },
  info_requested: { label: "Investor asked a question", tone: "warn" },
  accepted: { label: "Accepted", tone: "ok" },
  declined: { label: "Declined", tone: "danger" }
};

/** Pitches this owner has sent, or a notice if they cannot be read. */
export async function loadPitches() {
  try {
    const rows = await rpc("my_pitches");
    return { rows: (Array.isArray(rows) ? rows : []).filter((p) => p.role === "sent"), error: null };
  } catch (error) {
    return { rows: [], error: normalizeError(error) };
  }
}

/** The owner's pitch panel: the send button and the tracker. */
export function pitchesMarkup({ rows, error }, { businesses = [], investors = [] } = {}) {
  const canSend = businesses.length > 0 && investors.length > 0;
  return `<section class="inv-section owner-pitches" aria-labelledby="owner-pitches-title">
    <div class="owner-pitches-head">
      <h2 class="inv-section-title" id="owner-pitches-title">Pitches you sent</h2>
      <button class="btn btn-primary btn-sm" type="button" data-pitch-new ${canSend ? "" : "disabled"}
        title="${canSend ? "" : "You need a business and at least one public investor to send a pitch."}">
        ${icon("plus", { size: 14 })} Send a pitch
      </button>
    </div>
    ${!canSend && !error ? `<p class="field-hint">${!businesses.length
      ? "Create a business first, then send a pitch to an investor who has a public profile."
      : "No investor has a public profile yet, so there is nobody to pitch."}</p>` : ""}
    ${error
      ? setupNotice(error, "Pitches")
      : rows.length
        ? `<div class="req-list">${rows.map(trackerCard).join("")}</div>`
        : emptyState({ iconName: "send", title: "No pitches sent", desc: "Send a pitch to a public investor. You will see every reply here." })}
  </section>`;
}

function trackerCard(p) {
  const st = STATUS[p.status] || { label: p.status, tone: "neutral" };
  const files = Array.isArray(p.attachments) ? p.attachments : [];
  return `<article class="card req-card inv-rise">
    <header class="req-head">
      <div class="req-title">
        <h3 class="req-name">${esc(p.title || "Pitch")}</h3>
        <p class="field-hint">${esc(p.business_name || "Business")} · to ${esc(p.counterpart_name || "Investor")} · ${esc(fmtTime(p.created_at))}</p>
      </div>
      ${chip(st.label, { tone: st.tone })}
    </header>
    <dl class="req-facts">
      <div><dt>Funding asked</dt><dd>${p.funding_requested_inr != null ? esc(rupees(p.funding_requested_inr)) : "Not stated"}</dd></div>
      <div><dt>Files</dt><dd>${files.length}</dd></div>
      <div><dt>Last update</dt><dd>${esc(fmtTime(p.updated_at || p.created_at))}</dd></div>
    </dl>
    ${p.status === "info_requested" && p.info_request ? `<p class="req-info"><strong>Their question:</strong> ${esc(p.info_request)}</p>` : ""}
    ${files.length ? `<ul class="req-files" aria-label="Files you attached">${files.map((f) => `<li>
        <button type="button" class="btn btn-ghost btn-sm" data-owner-file="${esc(f.path)}" data-file-name="${esc(f.name || "file")}">${icon("eye", { size: 13 })} ${esc(f.name || "File")}</button>
      </li>`).join("")}</ul>` : ""}
    <div class="card-actions req-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-owner-message="${esc(p.counterpart_id)}" data-owner-name="${esc(p.counterpart_name || "Investor")}">${icon("messages-square", { size: 13 })} Message investor</button>
    </div>
  </article>`;
}

/* The page re-paints several times; one listener on the root reads the latest context. */
let ctx = { refresh: null, businesses: [], investors: [] };
let bound = null;

/** Wire the panel. `refresh` re-renders the whole page after a change. */
export function bindPitches(root, { refresh, businesses = [], investors = [] }) {
  ctx = { refresh, businesses, investors };
  if (bound === root) return;
  bound = root;
  root.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-pitch-new]")) return openSendForm(ctx);
    const file = event.target.closest?.("[data-owner-file]");
    if (file) return openOwnerFile(file);
    const message = event.target.closest?.("[data-owner-message]");
    if (message) return openMessage(message);
  });
}

/* ------------------------------------------------------------ send form */

function openSendForm({ businesses, investors, refresh }) {
  const options = (list, valueKey, labelFn) =>
    list.map((item) => `<option value="${esc(item[valueKey])}">${esc(labelFn(item))}</option>`).join("");

  const modal = openModal({
    title: "Send a pitch",
    desc: "Only public investors can receive a pitch. Attach up to five PDF or image files, 10 MB each.",
    size: "lg",
    body: `<form id="pitch-form" class="stack" novalidate>
      <div class="field" data-field="business">
        <label class="field-label" for="pitch-business">Business</label>
        <select class="select" id="pitch-business" name="business" required>${options(businesses, "id", (b) => b.name || "Business")}</select>
      </div>
      <div class="field" data-field="investor">
        <label class="field-label" for="pitch-investor">Investor</label>
        <select class="select" id="pitch-investor" name="investor" required>${options(investors, "userId", (i) => `${i.name || i.username || "Investor"}${i.username ? ` (@${i.username})` : ""}`)}</select>
      </div>
      <div class="field" data-field="title">
        <label class="field-label" for="pitch-title">Title</label>
        <input class="input" id="pitch-title" name="title" maxlength="120" required placeholder="For example: Seed round for our bakery chain" />
        <p class="field-error" data-error hidden></p>
      </div>
      <div class="field" data-field="summary">
        <label class="field-label" for="pitch-summary">Summary</label>
        <textarea class="input" id="pitch-summary" name="summary" rows="5" maxlength="2000" required placeholder="What the business does, what you need, and how the money would be used."></textarea>
        <p class="field-hint"><span data-count>0</span> / 2000</p>
        <p class="field-error" data-error hidden></p>
      </div>
      <div class="field" data-field="funding">
        <label class="field-label" for="pitch-funding">Funding asked (Rs) <span class="optional">optional</span></label>
        <input class="input" id="pitch-funding" name="funding" inputmode="numeric" placeholder="For example: 2500000" />
        <p class="field-error" data-error hidden></p>
      </div>
      <div class="field" data-field="files">
        <label class="field-label" for="pitch-files">Files <span class="optional">optional, up to ${FILE_MAX_COUNT}</span></label>
        <input class="input" id="pitch-files" name="files" type="file" multiple accept="${FILE_TYPES.join(",")}" />
        <p class="field-hint" id="pitch-files-hint">PDF, PNG, JPEG or WebP. 10 MB each.</p>
        <p class="field-error" data-error hidden></p>
      </div>
      <p class="field-error" id="pitch-form-error" hidden></p>
      <div class="card-actions"><button class="btn btn-primary" type="submit" id="pitch-submit">Send pitch</button></div>
    </form>`,
    onMount: (node) => {
      const form = node.querySelector("#pitch-form");
      const summary = node.querySelector("#pitch-summary");
      const count = node.querySelector("[data-count]");
      summary.addEventListener("input", () => (count.textContent = String(summary.value.length)));
      form.addEventListener("submit", (event) => submitPitch(event, node, { refresh }));
    }
  });
  return modal;
}

function setFieldError(node, name, message) {
  const field = node.querySelector(`[data-field="${name}"]`);
  if (!field) return;
  field.classList.toggle("invalid", Boolean(message));
  const error = field.querySelector("[data-error]");
  if (error) {
    error.textContent = message || "";
    error.hidden = !message;
  }
}

function parseFunding(raw) {
  const text = String(raw || "").replace(/[,\s]/g, "");
  if (!text) return { value: null, error: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { value: null, error: "Enter the amount in rupees, numbers only." };
  const value = Number(text);
  if (value <= 0 || value > 1e12) return { value: null, error: "Enter an amount between 1 and 1,000,000,000,000." };
  return { value, error: null };
}

function safeFileName(name, index) {
  const clean = String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "").slice(-80) || "file";
  return `${index + 1}-${clean}`;
}

async function submitPitch(event, node, { refresh }) {
  event.preventDefault();
  const form = node.querySelector("#pitch-form");
  const submit = node.querySelector("#pitch-submit");
  const formError = node.querySelector("#pitch-form-error");
  formError.hidden = true;

  const values = {
    business: form.business.value,
    investor: form.investor.value,
    title: form.title.value.trim(),
    summary: form.summary.value.trim(),
    funding: parseFunding(form.funding.value)
  };
  const files = Array.from(form.files.files || []);

  const problems = {
    title: values.title.length < TITLE_MIN ? `Use at least ${TITLE_MIN} characters.` : "",
    summary: values.summary.length < SUMMARY_MIN ? `Use at least ${SUMMARY_MIN} characters.` : "",
    funding: values.funding.error || "",
    files: files.length > FILE_MAX_COUNT
      ? `Attach no more than ${FILE_MAX_COUNT} files.`
      : files.find((f) => !FILE_TYPES.includes(f.type))
        ? "Only PDF and image files can be attached."
        : files.find((f) => f.size > FILE_MAX_BYTES)
          ? "Each file must be 10 MB or smaller."
          : ""
  };
  if (!values.business) problems.business = "Choose a business.";
  if (!values.investor) problems.investor = "Choose an investor.";
  Object.entries(problems).forEach(([name, message]) => setFieldError(node, name, message));
  if (Object.values(problems).some(Boolean)) return;

  submit.disabled = true;
  submit.textContent = "Sending…";
  let pitchId = null;
  try {
    pitchId = String(await rpc("send_pitch", {
      p_business: values.business,
      p_investor: values.investor,
      p_title: values.title,
      p_summary: values.summary,
      p_funding: values.funding.value
    }));
  } catch (error) {
    submit.disabled = false;
    submit.textContent = "Send pitch";
    formError.textContent = normalizeError(error).message || "The pitch could not be sent.";
    formError.hidden = false;
    return;
  }

  /* The pitch exists now. Attach files one at a time and report each failure. */
  const failed = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const path = `${pitchId}/${safeFileName(file.name, i)}`;
    submit.textContent = `Uploading ${i + 1} of ${files.length}…`;
    try {
      const { error: uploadError } = await sb.storage.from("pitch-attachments").upload(path, file, {
        contentType: file.type,
        upsert: false
      });
      if (uploadError) throw uploadError;
      await rpc("add_pitch_attachment", {
        p_pitch: pitchId,
        p_path: path,
        p_name: file.name,
        p_size: file.size,
        p_type: file.type
      });
    } catch (error) {
      failed.push(`${file.name}: ${normalizeError(error).message || "not saved"}`);
    }
  }

  if (failed.length) {
    toast({ title: "Pitch sent, but some files were not attached", desc: failed.join(" · ") }, { tone: "warn" });
  } else {
    toast({ title: "Pitch sent" }, { tone: "success" });
  }
  node.querySelector("[data-modal-close]")?.click();
  refresh?.();
}

/* ------------------------------------------------------------- files */

async function openOwnerFile(button) {
  button.disabled = true;
  try {
    const { data, error } = await sb.storage
      .from("pitch-attachments")
      .createSignedUrl(button.getAttribute("data-owner-file"), SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw error || new Error("No link was returned.");
    window.open(data.signedUrl, "_blank", "noopener");
  } catch (error) {
    toastError(error);
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------------------------------------- messages */

async function openMessage(button) {
  const id = button.getAttribute("data-owner-message");
  const name = button.getAttribute("data-owner-name") || "Investor";
  button.disabled = true;
  try {
    const conversation = String(await rpc("open_direct_conversation", { p_user: id }));
    openModal({
      title: `Conversation with ${name}`,
      size: "lg",
      body: `<div class="owner-thread" id="owner-thread-box"></div>`,
      onMount: (node) => {
        mountThread(node.querySelector("#owner-thread-box"), conversation, { otherName: name }).catch(toastError);
      },
      onClose: () => destroyThreads()
    });
  } catch (error) {
    toastError(error);
  } finally {
    button.disabled = false;
  }
}
