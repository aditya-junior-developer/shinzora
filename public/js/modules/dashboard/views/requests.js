/* ==========================================================================
   Shinzora — Service requests
   The customer side of a service order: what was asked for, who is handling
   it, where it is, and what happens next. Everything here is read back from
   the service_requests table — no status is invented in the browser, and a
   request with no assigned owner says so instead of guessing.
   ========================================================================== */

import { qs, qsa, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime, money } from "../../../lib/format.js";
import { serviceRequests, logActivity, isSchemaMissing } from "../data.js";
import { normalizeError, sb } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { pageHead, setupNotice, emptyState, skeletonView, chip, statusBadge, statCard } from "../components.js";
import { formDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

/* The services a customer can ask for without a payment first. Anything that
   has a fixed price is bought from Billing; it lands here as a request once
   the payment is verified, so this catalogue is deliberately the "talk to a
   human" list. */
const CATALOGUE = [
  { value: "website_setup", label: "Managed website setup" },
  { value: "brand_kit", label: "Brand kit and copywriting" },
  { value: "store_setup", label: "Store and catalogue setup" },
  { value: "google_listing", label: "Get listed on Google" },
  { value: "custom", label: "Something else" }
];

const SERVICE_LABEL = Object.fromEntries(CATALOGUE.map((s) => [s.value, s.label]));

/* The steps a live request moves through. Terminal states end the track. */
const TRACK = [
  { id: "requested", label: "Requested", desc: "We have your request and it is queued." },
  { id: "approved", label: "Approved", desc: "Shinzora accepted the scope and assigned an owner." },
  { id: "in_progress", label: "In progress", desc: "Work is under way on this request." },
  { id: "completed", label: "Completed", desc: "Delivered and closed." }
];
const TERMINAL = { rejected: "Rejected", cancelled: "Cancelled", completed: "Completed" };
const OPEN_STATUSES = ["requested", "approved", "in_progress"];

function reference(row) {
  return row.reference || `SR-${String(row.id || "").slice(0, 8).toUpperCase()}`;
}

function label(row) {
  if (row.title) return row.title;
  return SERVICE_LABEL[row.service_type] || String(row.service_type || "Service request").replace(/_/g, " ");
}

/* A due date is only "overdue" while the request is still open. Once it is
   completed or cancelled the date is history, not a warning. */
function dueMeta(row) {
  if (!row.due_at) return null;
  const due = new Date(row.due_at);
  const overdue = OPEN_STATUSES.includes(row.status) && due.getTime() < Date.now();
  return { due, overdue, text: dateTime(row.due_at) };
}

function track(row) {
  const reached = TRACK.findIndex((step) => step.id === row.status);
  if (TERMINAL[row.status]) {
    return `<ol class="track track-${row.status === "completed" ? "done" : "stopped"}">${TRACK.slice(0, 3)
      .map(
        (step, i) => `<li class="track-step ${i <= 1 ? "is-done" : "is-pending"}">
          <span class="track-dot">${i <= 1 ? icon("check", { size: 11 }) : ""}</span>
          <span class="track-label">${esc(step.label)}</span>
        </li>`
      )
      .join("")}<li class="track-step is-final">
        <span class="track-dot">${icon(row.status === "completed" ? "check" : "x", { size: 11 })}</span>
        <span class="track-label">${esc(TERMINAL[row.status])}</span>
      </li></ol>`;
  }
  return `<ol class="track">${TRACK.map((step, i) => {
    const done = reached > i;
    const current = reached === i;
    return `<li class="track-step ${done ? "is-done" : current ? "is-current" : "is-pending"}"${
      current ? ' aria-current="step"' : ""
    }>
      <span class="track-dot">${done ? icon("check", { size: 11 }) : current ? '<span class="pulse"></span>' : ""}</span>
      <span class="track-label">${esc(step.label)}</span>
    </li>`;
  }).join("")}</ol>`;
}

function trackNote(row) {
  const step = TRACK.find((s) => s.id === row.status);
  if (step) return step.desc;
  if (row.status === "rejected") return "Shinzora could not take this on. The note below explains why.";
  if (row.status === "cancelled") return "This request was cancelled. Nothing further is scheduled.";
  return "";
}

function card(row) {
  const due = dueMeta(row);
  return `<article class="card request-card" data-id="${esc(row.id)}">
    <div class="card-head">
      <div>
        <div class="card-title">${esc(label(row))}</div>
        <div class="muted small">${esc(reference(row))} · raised ${esc(timeAgo(row.created_at))}</div>
      </div>
      <div class="row gap-2" style="align-items:center">
        ${due && due.overdue ? chip("Overdue", { tone: "danger", iconName: "circle-alert" }) : ""}
        ${row.amount ? chip(money(row.amount), { tone: "neutral" }) : ""}
        ${statusBadge(row.status)}
      </div>
    </div>
    <div class="card-body stack gap-4">
      ${track(row)}
      <p class="muted small" style="margin:0">${esc(trackNote(row))}</p>
      ${
        due
          ? `<div class="field-hint" style="margin:0">${icon(due.overdue ? "circle-alert" : "calendar", {
              size: 12
            })} Target ${esc(due.text)}${due.overdue ? " — running past the target, we will follow up." : ""}</div>`
          : ""
      }
      ${row.details ? `<p class="request-details" style="margin:0">${esc(row.details)}</p>` : ""}
      ${
        row.admin_note
          ? `<div class="notice notice-info"><div class="notice-body"><strong>Note from Shinzora</strong><p style="margin:4px 0 0">${esc(
              row.admin_note
            )}</p></div></div>`
          : ""
      }
      <div class="row gap-2">
        <button class="btn btn-secondary btn-sm" data-action="message" data-id="${esc(row.id)}">${icon("message-square", {
          size: 14
        })}Message us about this</button>
        <a class="btn btn-ghost btn-sm" href="/docs/#services">${icon("book-open", { size: 14 })}How this works</a>
      </div>
    </div>
  </article>`;
}

export default async function render(root) {
  root.innerHTML = skeletonView(3);

  let rows = [];
  try {
    const result = await serviceRequests(100);
    /* The data layer normally hands back the rows; a mirror that answers with
       { data } must not turn the whole page into a crash, so accept both. */
    rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Service requests" })}${setupNotice(error, "Service requests")}`;
    if (!isSchemaMissing(error)) console.error(error);
    return;
  }

  const open = rows.filter((r) => OPEN_STATUSES.includes(r.status));
  const closed = rows.filter((r) => !OPEN_STATUSES.includes(r.status));

  root.innerHTML = `
    ${pageHead({
      title: "Service requests",
      desc: "Work you have asked Shinzora to do, with its current stage and target date.",
      actions: `<button class="btn btn-primary btn-sm" id="new-request">${icon("plus", { size: 14 })}Request a service</button>`
    })}
    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Open requests", value: open.length, iconName: "route", foot: `${open.filter((r) => r.status === "in_progress").length} in progress` })}
      ${statCard({ label: "Awaiting review", value: open.filter((r) => r.status === "requested").length, iconName: "inbox", foot: "queued for a human" })}
      ${statCard({ label: "Completed", value: rows.filter((r) => r.status === "completed").length, iconName: "circle-check", foot: "all time" })}
      ${statCard({ label: "Total raised", value: rows.length, iconName: "file-text", foot: "closed requests included" })}
    </div>
    <div class="stack gap-4" id="request-list">${
      rows.length
        ? `${open.length ? `<h2 class="section-title">Open</h2>${open.map(card).join("")}` : ""}
           ${closed.length ? `<h2 class="section-title">Closed</h2>${closed.map(card).join("")}` : ""}`
        : emptyState({
            icon: "route",
            title: "No service requests yet",
            desc: "Ask Shinzora to build, set up or fix something and it will appear here with its progress.",
            action: `<button class="btn btn-primary btn-sm" data-action="new">${icon("plus", { size: 14 })}Request a service</button>`
          })
    }</div>`;

  async function newRequest() {
    const values = await formDialog({
      title: "Request a service",
      desc: "Tell us what you need. We reply within one working day, and the request appears here once it is raised.",
      submitLabel: "Submit request",
      fields: [
        {
          name: "service_type",
          label: "Service",
          type: "select",
          required: true,
          value: "website_setup",
          options: CATALOGUE.map((s) => ({ value: s.value, label: s.label }))
        },
        { name: "title", label: "Short title", required: true, placeholder: "Homepage refresh for my store" },
        {
          name: "details",
          label: "Details",
          type: "textarea",
          rows: 5,
          required: true,
          placeholder: "What should exist when this is done? Links, references and deadlines help."
        }
      ]
    });
    if (!values) return;

    try {
      const { data, error } = await sb
        .from("service_requests")
        .insert({
          owner_id: state.user.id,
          service_type: values.service_type,
          title: values.title,
          details: values.details,
          status: "requested"
        })
        .select("*")
        .single();
      if (error) throw normalizeError(error);

      await logActivity("service_requested", "service_request", data?.id || null, {
        service_type: values.service_type
      }).catch(() => {});

      toast(
        {
          title: "Request submitted",
          message: "It is queued for review and now visible in this list. We contact you within 24 hours on working days."
        },
        { tone: "success", duration: 8000 }
      );
      render(root);
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  delegate(root, "click", "#new-request", newRequest);
  delegate(root, "click", '[data-action="new"]', newRequest);
  delegate(root, "click", '[data-action="message"]', (event, el) => {
    const row = rows.find((r) => r.id === el.dataset.id);
    const subject = `Question about ${row ? reference(row) : "my service request"}`;
    location.href = `/app/?view=support&subject=${encodeURIComponent(subject)}`;
  });

  /* Deep link: /app/?view=requests&id=… scrolls to that request. */
  const wanted = new URLSearchParams(location.search).get("id");
  if (wanted) qs(`.request-card[data-id="${CSS.escape(wanted)}"]`, root)?.scrollIntoView({ block: "center" });
  qsa(".request-card", root).forEach((node) => node.classList.add("is-ready"));
}
