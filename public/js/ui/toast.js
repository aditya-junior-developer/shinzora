/* ==========================================================================
   Shinzora — toasts
   Non-blocking feedback for async actions. Screen-reader announced via
   aria-live so success and failure are never colour-only signals.
   ========================================================================== */

import { icon } from "../lib/icons.js";
import { esc } from "../lib/dom.js";

let region = null;

function ensureRegion() {
  if (region && document.body.contains(region)) return region;
  region = document.createElement("div");
  region.className = "toast-region";
  region.setAttribute("role", "region");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-label", "Notifications");
  document.body.append(region);
  return region;
}

const TONES = {
  success: { cls: "toast-ok", icon: "check-check", label: "Success" },
  error: { cls: "toast-error", icon: "circle-alert", label: "Error" },
  info: { cls: "toast-info", icon: "info", label: "Information" },
  warning: { cls: "toast-warn", icon: "triangle-alert", label: "Warning" }
};

/**
 * Show a toast.
 * @param {string|{title:string, message?:string}} message
 * @param {{tone?:'success'|'error'|'info'|'warning', duration?:number, action?:{label:string, onClick:Function}}} [opts]
 */
export function toast(message, opts = {}) {
  const tone = TONES[opts.tone] || TONES.info;
  const payload = typeof message === "string" ? { title: message } : message;
  const host = ensureRegion();

  const node = document.createElement("div");
  node.className = `toast ${tone.cls}`;
  node.innerHTML = `
    ${icon(tone.icon, { size: 17 })}
    <div class="toast-body">
      <div class="toast-title">${esc(payload.title || "")}</div>
      ${payload.message ? `<div class="muted" style="font-size:var(--fs-xs);margin-top:2px">${esc(payload.message)}</div>` : ""}
      ${opts.action ? `<button class="btn btn-sm btn-violet-outline" style="margin-top:8px" data-toast-action>${esc(opts.action.label)}</button>` : ""}
    </div>
    <button class="toast-close" aria-label="Dismiss notification">${icon("x", { size: 14 })}</button>`;

  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 200);
  };

  node.querySelector(".toast-close").addEventListener("click", dismiss);
  if (opts.action) {
    node.querySelector("[data-toast-action]").addEventListener("click", () => {
      opts.action.onClick?.();
      dismiss();
    });
  }

  host.append(node);
  const timeout = opts.duration ?? (tone.cls === "toast-error" ? 7000 : 4500);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return dismiss;
}

export const toastError = (error, fallback = "Something went wrong.") =>
  toast(
    {
      title: error?.message || fallback,
      message: error?.hint && error.hint !== error.message ? error.hint : ""
    },
    { tone: "error", duration: 8000 }
  );

export const toastSuccess = (title, message) => toast({ title, message }, { tone: "success" });
export default toast;
