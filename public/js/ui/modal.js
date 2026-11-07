/* ==========================================================================
   Shinzora — modal / dialog
   Accessible (focus trap, Escape, aria-modal, scroll lock) and promise-based
   so call sites read top-to-bottom. Also provides confirm() and a small
   form dialog used by CRUD flows.
   ========================================================================== */

import { icon } from "../lib/icons.js";
import { trapFocus, qs, esc, delegate } from "../lib/dom.js";

let openCount = 0;

/**
 * Open a modal.
 * @param {{title:string, desc?:string, body?:string, size?:'sm'|''|'lg'|'xl',
 *          footer?:string, onMount?:(root:HTMLElement, api:{close:Function})=>void,
 *          dismissible?:boolean, onClose?:Function}} options
 * @returns {{root:HTMLElement, close:Function, body:HTMLElement, footer:HTMLElement}}
 */
export function openModal(options = {}) {
  const {
    title = "",
    desc = "",
    body = "",
    footer = "",
    size = "",
    onMount,
    dismissible = true,
    onClose
  } = options;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal ${size ? `modal-${size}` : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title-${
      Date.now()
    }" ${desc ? `aria-describedby="modal-desc"` : ""}>
      <div class="modal-head">
        <div>
          <div class="modal-title" id="modal-title-${Date.now()}">${esc(title)}</div>
          ${desc ? `<div class="modal-desc" id="modal-desc">${esc(desc)}</div>` : ""}
        </div>
        <button class="modal-close" data-modal-close aria-label="Close dialog">${icon("x", { size: 16 })}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
    </div>`;

  document.body.append(backdrop);
  document.body.style.overflow = "hidden";
  openCount += 1;

  const dialog = qs(".modal", backdrop);
  const disposeTrap = trapFocus(dialog);
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    disposeTrap();
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    openCount = Math.max(0, openCount - 1);
    if (!openCount) document.body.style.overflow = "";
    onClose?.(result);
  };

  const onKey = (event) => {
    if (event.key === "Escape" && dismissible) close();
  };
  document.addEventListener("keydown", onKey);

  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop && dismissible) close();
  });
  delegate(backdrop, "click", "[data-modal-close]", () => close());

  const handle = {
    root: dialog,
    close,
    body: qs(".modal-body", dialog),
    footer: qs(".modal-foot", dialog),
    /** Replace the footer markup after the dialog has mounted. */
    setFooter(html) {
      let foot = qs(".modal-foot", dialog);
      if (!html) {
        foot?.remove();
        return;
      }
      if (!foot) {
        foot = document.createElement("div");
        foot.className = "modal-foot";
        dialog.append(foot);
      }
      foot.innerHTML = html;
    }
  };
  onMount?.(dialog, handle);
  return handle;
}

/** Promise-based confirmation dialog. Resolves true/false. */
export function confirmDialog({
  title = "Are you sure?",
  desc = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  requireText = null
} = {}) {
  return new Promise((resolve) => {
    const inputId = `confirm-${Date.now()}`;
    const modal = openModal({
      title,
      desc,
      size: "sm",
      body: requireText
        ? `<div class="field" data-field="confirm"><label class="field-label" for="${inputId}">Type <span class="mono">${esc(
            requireText
          )}</span> to continue</label><input class="input" id="${inputId}" name="confirm" autocomplete="off" /><div class="field-error"></div></div>`
        : "",
      footer: `<button class="btn btn-ghost" data-modal-close>${esc(cancelLabel)}</button>
               <button class="btn btn-${tone === "danger" ? "danger" : "primary"}" data-confirm>${esc(confirmLabel)}</button>`,
      onClose: () => resolve(false)
    });

    const button = qs("[data-confirm]", modal.root);
    button.addEventListener("click", () => {
      if (requireText) {
        const field = qs("[data-field='confirm']", modal.root);
        const value = qs("input", field).value.trim();
        if (value !== requireText) {
          field.classList.add("invalid");
          qs(".field-error", field).textContent = `Type "${requireText}" exactly to continue.`;
          return;
        }
      }
      resolve(true);
      modal.close();
    });
  });
}

/**
 * Small form dialog. `fields` is an array of
 * { name, label, type, value, placeholder, required, options, hint, rows }.
 * Resolves with the submitted values object, or null when cancelled.
 */
export function formDialog({ title, desc = "", fields = [], submitLabel = "Save", size = "" }) {
  return new Promise((resolve) => {
    const markup = fields
      .map((field) => {
        const id = `f-${field.name}`;
        const common = `id="${id}" name="${esc(field.name)}" ${field.required ? "required" : ""} ${
          field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""
        }`;
        let control;
        if (field.type === "select") {
          control = `<select class="select" ${common}>${(field.options || [])
            .map(
              (opt) =>
                `<option value="${esc(opt.value)}" ${String(opt.value) === String(field.value) ? "selected" : ""}>${esc(
                  opt.label
                )}</option>`
            )
            .join("")}</select>`;
        } else if (field.type === "textarea") {
          control = `<textarea class="textarea" rows="${field.rows || 4}" ${common}>${esc(field.value || "")}</textarea>`;
        } else {
          control = `<input class="input" type="${esc(field.type || "text")}" value="${esc(field.value || "")}" ${common} ${
            field.step ? `step="${esc(field.step)}"` : ""
          } />`;
        }
        return `<div class="field" data-field="${esc(field.name)}">
            <label class="field-label" for="${id}">${esc(field.label)}${
          field.required ? "" : ' <span class="optional">optional</span>'
        }</label>
            ${control}
            ${field.hint ? `<div class="field-hint">${esc(field.hint)}</div>` : ""}
            <div class="field-error"></div>
          </div>`;
      })
      .join("");

    const modal = openModal({
      title,
      desc,
      size,
      body: `<form class="stack gap-4" data-dialog-form novalidate>${markup}</form>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Cancel</button>
               <button class="btn btn-primary" data-submit form="">${esc(submitLabel)}</button>`,
      onMount: (root) => {
        const form = qs("form", root);
        const submit = qs("[data-submit]", root);
        const finish = () => {
          const values = {};
          fields.forEach((field) => {
            const node = form.elements[field.name];
            if (!node) return;
            values[field.name] = field.type === "number" ? Number(node.value) : node.value.trim();
          });
          const missing = fields.find((field) => field.required && !values[field.name]);
          if (missing) {
            const wrap = qs(`[data-field="${missing.name}"]`, form);
            wrap.classList.add("invalid");
            qs(".field-error", wrap).textContent = "This field is required.";
            return;
          }
          resolve(values);
          modal.close();
        };
        submit.addEventListener("click", finish);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          finish();
        });
      },
      onClose: () => resolve(null)
    });
  });
}
