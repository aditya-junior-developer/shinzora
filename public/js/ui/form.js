/* ==========================================================================
   Shinzora — form UI helpers
   Loading states, inline alerts and password visibility toggles shared by the
   auth, onboarding and dashboard forms.
   ========================================================================== */

import { icon } from "../lib/icons.js";
import { esc } from "../lib/dom.js";

/**
 * Toggle a button between idle and busy without losing its label.
 * @param {HTMLButtonElement} button
 * @param {boolean} busy
 * @param {string} [busyLabel]
 */
export function setBusy(button, busy, busyLabel = "Working") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span><span>${esc(busyLabel)}</span>`;
  } else {
    button.removeAttribute("aria-busy");
    button.disabled = false;
    if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
  }
}

const ICONS = { error: "circle-alert", success: "circle-check", warning: "triangle-alert", info: "info", violet: "sparkles" };
const CLASS = { error: "alert-danger", success: "alert-ok", warning: "alert-warn", info: "alert-info", violet: "alert-violet" };

/**
 * Render an inline alert into a container.
 * @param {HTMLElement} container
 * @param {'error'|'success'|'warning'|'info'|'violet'|null} tone  null clears it
 * @param {string} title
 * @param {string} [message]
 */
export function setAlert(container, tone, title = "", message = "") {
  if (!container) return;
  if (!tone) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<div class="alert ${CLASS[tone] || "alert-info"}" role="alert">
      ${icon(ICONS[tone] || "info", { size: 16 })}
      <span><span class="alert-title">${esc(title)}</span>${message ? esc(message) : ""}</span>
    </div>`;
}

/** Show an AppError in a container, including its actionable hint. */
export function showError(container, error) {
  const message = error?.message || "Something went wrong.";
  const hint = error?.hint && error.hint !== message ? ` ${error.hint}` : "";
  setAlert(container, "error", message, hint);
}

/** Enable password visibility toggles for every [data-pw-toggle] button. */
export function initPasswordToggles(root = document) {
  root.querySelectorAll("[data-pw-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.getAttribute("data-pw-toggle"));
      if (!target) return;
      const reveal = target.type === "password";
      target.type = reveal ? "text" : "password";
      button.innerHTML = icon(reveal ? "eye-off" : "eye", { size: 16 });
      button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
      button.setAttribute("aria-pressed", String(reveal));
    });
  });
}

/** Field-level error painting for a single input wrapper. */
export function fieldError(input, message) {
  const field = input?.closest("[data-field]");
  if (!field) return;
  field.classList.toggle("invalid", Boolean(message));
  const slot = field.querySelector(".field-error");
  if (slot) slot.innerHTML = message ? `<span>${esc(message)}</span>` : "";
  input.setAttribute("aria-invalid", message ? "true" : "false");
}

export default { setBusy, setAlert, showError, initPasswordToggles, fieldError };
