/* ==========================================================================
   Shinzora — Request Services (customer side)
   A request is a request, not a purchase: the customer picks one of ten
   services, states a budget in rupees, and a specialist contacts them within
   24 hours. Nothing is charged here and nothing is described as available
   beyond the ten categories listed in config/request-services.js.

   The confirmation message is shown only after the database has accepted the
   row. Status is read back from service_requests; the browser never invents
   one.
   ========================================================================== */

import { qs, qsa, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { timeAgo, dateTime } from "../../../lib/format.js";
import { serviceRequests, logActivity, isSchemaMissing } from "../data.js";
import { normalizeError, sb } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { pageHead, setupNotice, emptyState, skeletonView, chip, statCard } from "../components.js";
import { fieldError } from "../../../ui/form.js";
import { toastError } from "../../../ui/toast.js";
import {
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  CONFIRMATION_MESSAGE,
  OTHERS_MAX_CHARS,
  categoryById,
  statusById,
  validateRequest
} from "../../../config/request-services.js";

/* Rows written before 0055 use older status names. Show them as their
   current equivalent; the database migration already converted stored rows. */
const LEGACY_STATUS = { requested: "submitted", approved: "under_review", cancelled: "rejected" };
const normalizeStatus = (s) => statusById(s)?.id || LEGACY_STATUS[s] || "submitted";
const OPEN = new Set(["submitted", "under_review", "in_progress"]);

const categoryLabel = (row) => categoryById(row.service_type)?.label || row.title || "Service request";

function reference(row) {
  return row.reference || `SR-${String(row.id || "").slice(0, 8).toUpperCase()}`;
}

/* The 24-hour target is respond_by (0055). Older rows only have due_at. */
function targetOf(row) {
  const raw = row.respond_by || row.due_at;
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const overdue = OPEN.has(normalizeStatus(row.status)) && at.getTime() < Date.now();
  return { at, overdue, text: dateTime(raw) };
}

/* Five steps. Rejected ends the track early at the last step with a red end. */
function track(status) {
  const steps = REQUEST_STATUSES.filter((s) => s.id !== "rejected");
  if (status === "rejected") {
    const reviewed = steps.slice(0, 2);
    return `<ol class="track track-stopped" aria-label="Request progress">
      ${reviewed
        .map(
          (s) => `<li class="track-step is-done"><span class="track-dot">${icon("check", { size: 11 })}</span>
          <span class="track-label">${esc(s.label)}</span></li>`
        )
        .join("")}
      <li class="track-step is-final"><span class="track-dot">${icon("x", { size: 11 })}</span>
        <span class="track-label">Rejected</span></li></ol>`;
  }
  const reached = statusById(status)?.step ?? 0;
  const current = statusById(status)?.id;
  return `<ol class="track${status === "completed" ? " track-done" : ""}" aria-label="Request progress">${steps
    .map((s, i) => {
      const done = status === "completed" ? true : reached > i;
      const here = !done && current === s.id;
      const cls = done ? "is-done" : here ? "is-current" : "is-pending";
      return `<li class="track-step ${cls}"${here ? ' aria-current="step"' : ""}>
        <span class="track-dot">${done ? icon("check", { size: 11 }) : here ? '<span class="pulse"></span>' : ""}</span>
        <span class="track-label">${esc(s.label)}</span></li>`;
    })
    .join("")}</ol>`;
}

const STATUS_NOTE = {
  submitted: "We have your request. A specialist will connect with you within 24 hours.",
  under_review: "A specialist is reviewing your requirements and budget.",
  in_progress: "Work is under way on this request.",
  completed: "Delivered and closed. Thank you for working with Shinzora.",
  rejected: "We could not take this on. The note below explains why."
};

function card(row) {
  const status = normalizeStatus(row.status);
  const meta = statusById(status);
  const target = targetOf(row);
  const budget = row.budget_inr != null ? `₹${Number(row.budget_inr).toLocaleString("en-IN")}` : "";
  return `<article class="card request-card svc-reveal" data-id="${esc(row.id)}">
    <div class="card-head">
      <div>
        <div class="card-title">${esc(categoryLabel(row))}</div>
        <div class="muted small">${esc(reference(row))} · submitted ${esc(timeAgo(row.created_at))}</div>
      </div>
      <div class="row gap-2" style="align-items:center;flex-wrap:wrap">
        ${target?.overdue ? chip("Past 24 h", { tone: "danger", iconName: "circle-alert" }) : ""}
        ${budget ? chip(`Budget ${budget}`, { tone: "neutral" }) : ""}
        <span class="badge badge-${meta.tone}"><span class="dot"></span>${esc(meta.label)}</span>
      </div>
    </div>
    <div class="card-body stack gap-4">
      ${track(status)}
      <p class="muted small" style="margin:0">${esc(STATUS_NOTE[status])}</p>
      ${
        target && OPEN.has(status)
          ? `<div class="field-hint" style="margin:0">${icon(target.overdue ? "circle-alert" : "clock", { size: 12 })} Contact by ${esc(target.text)}${
              target.overdue ? " — this has passed, and we will follow up." : ""
            }</div>`
          : ""
      }
      ${row.custom_description ? `<p class="request-details" style="margin:0;white-space:pre-wrap">${esc(row.custom_description)}</p>` : ""}
      ${
        row.admin_note
          ? `<div class="svc-callout is-info"><strong>Note from Shinzora</strong><p>${esc(row.admin_note)}</p></div>`
          : ""
      }
      <div class="row gap-2">
        <button class="btn btn-secondary btn-sm" data-action="message" data-id="${esc(row.id)}">${icon("message-square", { size: 14 })}Message us about this</button>
      </div>
    </div>
  </article>`;
}

function statsMarkup(rows) {
  const st = rows.map((r) => normalizeStatus(r.status));
  const open = st.filter((s) => OPEN.has(s)).length;
  return `
    ${statCard({ label: "Open", value: open, iconName: "route", foot: `${st.filter((s) => s === "in_progress").length} in progress` })}
    ${statCard({ label: "Awaiting review", value: st.filter((s) => s === "under_review" || s === "submitted").length, iconName: "inbox", foot: "waiting for a specialist" })}
    ${statCard({ label: "Completed", value: st.filter((s) => s === "completed").length, iconName: "circle-check", foot: "all time" })}
    ${statCard({ label: "Total", value: rows.length, iconName: "file-text", foot: "including closed" })}`;
}

function listMarkup(rows) {
  return `<h2 class="section-title" style="margin:0">Your requests</h2>${
    rows.length
      ? rows.map(card).join("")
      : emptyState({
          icon: "route",
          title: "No requests yet",
          desc: "Choose a service on the left. Your requests appear here with each step of their progress."
        })
  }`;
}

function tileMarkup(cat, selected) {
  return `<label class="svc-tile${selected ? " is-selected" : ""}" data-tile="${esc(cat.id)}">
    <input type="checkbox" name="service" value="${esc(cat.id)}" class="svc-radio"${selected ? " checked" : ""}>
    <span class="svc-tile-icon">${icon(cat.icon, { size: 18 })}</span>
    <span class="svc-tile-text">
      <span class="svc-tile-title">${esc(cat.label)}</span>
      <span class="svc-tile-sub">${esc(cat.summary)}</span>
    </span>
    <span class="svc-tile-tick" aria-hidden="true">${icon("check", { size: 12 })}</span>
  </label>`;
}

function formMarkup() {
  const name = state.profile?.full_name || "";
  const email = state.user?.email || "";
  const phone = state.profile?.phone || "";
  return `<section class="card svc-form-card svc-reveal" id="request-form" aria-labelledby="request-form-title">
    <div class="card-head">
      <div>
        <div class="card-title" id="request-form-title">Request a service</div>
        <div class="muted small">Choose one or more. They are sent together, and a specialist connects with you within 24 hours to discuss each one.</div>
      </div>
    </div>
    <form class="card-body stack gap-5" id="svc-form" novalidate>
      <fieldset class="svc-fieldset">
        <legend class="field-label svc-legend">Services</legend>
        <div class="svc-grid" role="group" aria-label="Services">
          ${REQUEST_CATEGORIES.map((cat) => tileMarkup(cat, false)).join("")}
        </div>
        <div class="field-error" data-error="category" role="alert"></div>
      </fieldset>

      <div class="svc-others" id="svc-others" hidden>
        <div class="field" data-field="description">
          <label class="field-label" for="svc-description">Describe what you need</label>
          <textarea class="input" id="svc-description" name="description" rows="4" maxlength="${OTHERS_MAX_CHARS}"
            placeholder="What should be delivered, for whom, and by when? Links and references help."></textarea>
          <div class="field-hint"><span id="svc-count">0</span> / ${OTHERS_MAX_CHARS} · at least 10 characters</div>
          <div class="field-error"></div>
        </div>
      </div>

      <div class="svc-lines" id="svc-lines" hidden></div>

      <div class="svc-two">
        <div class="field" data-field="name">
          <label class="field-label" for="svc-name">Your name</label>
          <input class="input" id="svc-name" name="name" type="text" autocomplete="name" value="${esc(name)}" maxlength="120">
          <div class="field-error"></div>
        </div>
        <div class="field" data-field="email">
          <label class="field-label" for="svc-email">Email</label>
          <input class="input" id="svc-email" name="email" type="email" autocomplete="email" value="${esc(email)}" maxlength="254">
          <div class="field-error"></div>
        </div>
        <div class="field" data-field="phone">
          <label class="field-label" for="svc-phone">Phone <span class="optional">optional</span></label>
          <input class="input" id="svc-phone" name="phone" type="tel" autocomplete="tel" value="${esc(phone)}" maxlength="20">
          <div class="field-error"></div>
        </div>
      </div>

      <div class="row gap-3 svc-actions">
        <button class="btn btn-primary" type="submit" id="svc-submit">${icon("send", { size: 14 })}<span>Submit request</span></button>
        <span class="muted small">No payment is taken here. We contact you first.</span>
      </div>
      <div class="svc-confirm" id="svc-confirm" role="status" aria-live="polite" hidden></div>
    </form>
  </section>`;
}

function validateContact({ name, email, phone }) {
  const errors = {};
  if (name.trim().length < 2) errors.name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter a valid email address.";
  if (phone.trim() && !/^[+\d][\d\s-]{6,18}$/.test(phone.trim())) errors.phone = "Enter a valid phone number, or leave it blank.";
  return errors;
}

export default async function render(root) {
  root.innerHTML = skeletonView(3);

  let rows = [];
  try {
    const result = await serviceRequests(100);
    rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Request Services" })}${setupNotice(error, "Request Services")}`;
    if (!isSchemaMissing(error)) console.error(error);
    return;
  }


  root.innerHTML = `
    ${pageHead({
      title: "Request Services",
      desc: "Tell us what you need. A specialist confirms scope and budget with you, then you can follow every step here."
    })}
    <div class="grid-4 svc-stats" id="svc-stats" style="margin-bottom:var(--s-4)">${statsMarkup(rows)}</div>
    <div class="svc-layout">
      ${formMarkup()}
      <div class="stack gap-4" id="request-list">${listMarkup(rows)}</div>
    </div>`;

  const form = qs("#svc-form", root);
  const tiles = qsa(".svc-tile", root);
  const others = qs("#svc-others", root);
  const description = qs("#svc-description", root);
  const count = qs("#svc-count", root);
  const submit = qs("#svc-submit", root);
  const confirm = qs("#svc-confirm", root);
  const lines = qs("#svc-lines", root);

  /* The services picked, in the order they are listed. */
  const pickedIds = () => tiles.filter((t) => t.querySelector("input").checked).map((t) => t.dataset.tile);

  /* One budget field per picked service: each request row carries its own
     expected budget, so the amounts are never shared or double counted. Values
     typed so far are kept when the list is redrawn. */
  function paintLines() {
    const kept = {};
    lines.querySelectorAll("[data-line-budget]").forEach((input) => (kept[input.dataset.lineBudget] = input.value));
    const ids = pickedIds();
    lines.hidden = ids.length === 0;
    lines.innerHTML = ids
      .map((id) => {
        const cat = categoryById(id);
        return `<div class="field" data-field="budget" data-line="${esc(id)}">
          <label class="field-label" for="svc-budget-${esc(id)}">${esc(cat?.label || id)} · expected budget (₹)</label>
          <div class="svc-money">
            <span class="svc-money-sign" aria-hidden="true">₹</span>
            <input class="input" id="svc-budget-${esc(id)}" data-line-budget="${esc(id)}" type="text" inputmode="numeric" autocomplete="off"
              placeholder="5000" value="${esc(kept[id] || "")}">
          </div>
          <div class="field-hint">In Indian rupees. Up to ₹10,00,00,000.</div>
          <div class="field-error"></div>
        </div>`;
      })
      .join("");
    lines.querySelectorAll("[data-line-budget]").forEach((input) => {
      input.addEventListener("input", (e) => {
        /* Keep only digits, commas and one decimal point, as the customer types. */
        e.target.value = e.target.value.replace(/[^\d.,]/g, "");
        fieldError(e.target, "");
      });
    });
  }

  /* Ticking or unticking a service reveals or hides its budget field, and the
     description field only when Others is among the picked services. */
  function choose(id) {
    const on = tiles.find((t) => t.dataset.tile === id)?.querySelector("input")?.checked;
    tiles.forEach((t) => t.classList.toggle("is-selected", t.querySelector("input").checked));
    const needs = pickedIds().some((pid) => categoryById(pid)?.needsDescription === true);
    others.hidden = !needs;
    if (on && needs && categoryById(id)?.needsDescription) requestAnimationFrame(() => description.focus());
    paintLines();
    qs('[data-error="category"]', root).textContent = "";
    confirm.hidden = true;
  }

  tiles.forEach((tile) => tile.querySelector("input").addEventListener("change", (e) => choose(e.target.value)));

  description.addEventListener("input", () => {
    count.textContent = String(description.value.length);
    fieldError(description, "");
  });

  ["#svc-name", "#svc-email", "#svc-phone"].forEach((sel) =>
    qs(sel, root).addEventListener("input", (e) => fieldError(e.target, ""))
  );

  function showErrors(errors) {
    const category = qs('[data-error="category"]', root);
    category.textContent = errors.category || "";
    fieldError(description, errors.description || "");
    const map = { name: "#svc-name", email: "#svc-email", phone: "#svc-phone" };
    for (const [key, sel] of Object.entries(map)) {
      fieldError(qs(sel, root), errors[key] || "");
    }
    lines.querySelectorAll("[data-line]").forEach((box) => {
      fieldError(box.querySelector("input"), errors[`budget:${box.dataset.line}`] || "");
    });
    const first = Object.keys(errors)[0];
    if (first) {
      const target =
        first === "category"
          ? tiles[0]
          : first.startsWith("budget:")
            ? lines.querySelector(`[data-line="${CSS.escape(first.slice(7))}"] input`)
            : first === "description"
              ? description
              : qs(map[first], root);
      target?.focus?.();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    confirm.hidden = true;

    const ids = pickedIds();
    const contact = {
      name: qs("#svc-name", root).value,
      email: qs("#svc-email", root).value,
      phone: qs("#svc-phone", root).value
    };

    /* Each picked service is checked on its own, with its own budget, using the
       same rules as before. The shared description applies to Others only. */
    const errors = { ...validateContact(contact) };
    const checkedRows = [];
    if (!ids.length) errors.category = "Choose at least one service.";
    for (const id of ids) {
      const budgetInput = lines.querySelector(`[data-line-budget="${CSS.escape(id)}"]`);
      const checked = validateRequest({
        category: id,
        budget: budgetInput ? budgetInput.value : "",
        description: description.value
      });
      if (!checked.ok) {
        if (checked.errors.budget) errors[`budget:${id}`] = checked.errors.budget;
        if (checked.errors.description) errors.description = checked.errors.description;
      } else {
        checkedRows.push({ id, value: checked.value });
      }
    }
    if (Object.keys(errors).length) {
      showErrors(errors);
      return;
    }
    showErrors({});

    /* One insert for the whole selection: every row is written, or none is. */
    const payload = checkedRows.map(({ id, value }) => {
      const category = categoryById(id);
      return {
        owner_id: state.user.id,
        service_type: value.service_type,
        title: category.label,
        details: value.custom_description,
        custom_description: value.custom_description,
        budget_inr: value.budget_inr,
        contact_name: contact.name.trim(),
        contact_email: contact.email.trim(),
        contact_phone: contact.phone.trim() || null,
        status: "submitted"
      };
    });

    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    submit.querySelector("span").textContent = "Submitting…";

    try {
      const { data, error } = await sb.from("service_requests").insert(payload).select("*");
      if (error) throw normalizeError(error);
      const saved = Array.isArray(data) ? data : [];

      /* Only rows the database accepted get the confirmation. */
      await Promise.all(
        saved.map((row) =>
          logActivity("service_requested", "service_request", row?.id || null, {
            service_type: row.service_type,
            budget_inr: row.budget_inr
          }).catch(() => {})
        )
      );

      confirm.innerHTML = `<div class="svc-callout is-ok"><span class="svc-callout-icon">${icon("circle-check", { size: 18 })}</span><p>${esc(CONFIRMATION_MESSAGE)}</p></div>`;
      confirm.hidden = false;
      confirm.classList.remove("is-shown");
      requestAnimationFrame(() => confirm.classList.add("is-shown"));
      form.reset();
      tiles.forEach((t) => {
        t.classList.remove("is-selected");
        t.querySelector("input").checked = false;
      });
      others.hidden = true;
      count.textContent = "0";
      paintLines();
      qs("#svc-name", root).value = contact.name;
      qs("#svc-email", root).value = contact.email;
      qs("#svc-phone", root).value = contact.phone;

      /* Refresh the list from the database so the new rows show with their real references. */
      const fresh = await serviceRequests(100).catch(() => null);
      const list = Array.isArray(fresh) ? fresh : Array.isArray(fresh?.data) ? fresh.data : null;
      if (list) {
        rows = list;
        qs("#svc-stats", root).innerHTML = statsMarkup(rows);
        qs("#request-list", root).innerHTML = listMarkup(rows);
      }
    } catch (error) {
      toastError(normalizeError(error));
    } finally {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      submit.querySelector("span").textContent = "Submit request";
    }
  });

  delegate(root, "click", '[data-action="message"]', (event, el) => {
    const row = rows.find((r) => r.id === el.dataset.id);
    const subject = `Question about ${row ? reference(row) : "my service request"}`;
    location.href = `/app/?view=support&subject=${encodeURIComponent(subject)}`;
  });

  /* Deep link: /app/?view=requests&id=… scrolls to that request. */
  const wanted = new URLSearchParams(location.search).get("id");
  if (wanted) qs(`.request-card[data-id="${CSS.escape(wanted)}"]`, root)?.scrollIntoView({ block: "center", behavior: "smooth" });
}
