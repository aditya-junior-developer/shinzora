/* ==========================================================================
   SHINZORA CONNECT — the browser's side of the `daily` Edge Function
   --------------------------------------------------------------------------
   Every call goes through lib/api.js, so the signed-in session is attached the
   same way as every other function. The browser never holds Daily's API key:
   it only ever receives a per-person meeting token and the room URL.

   Errors come back from the server with a code and a readable message. They
   are shown as they are; nothing here invents a reason.
   ========================================================================== */

import { invoke } from "../../../lib/api.js";

/** Call one action of the `daily` function. */
export function connect(action, payload = {}, opts = {}) {
  return invoke("daily", action, payload, { timeout: 60000, ...opts });
}

/** A short, human reason for a failed request, or the server's own message. */
export function explain(error, fallback = "Something went wrong. Try again.") {
  const code = String(error?.code || "");
  if (code === "daily_not_configured") {
    return "Video meetings are not set up on this server yet. Ask the administrator to add the Daily key.";
  }
  if (code === "fn_error" || code === "fn_500" || code === "fn_503") {
    return "The meeting service is not responding. Check your connection and try again.";
  }
  return String(error?.message || fallback);
}

/** Lowercase, nine-letter meeting code, the way the server stores it. */
export function cleanCode(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A fresh identity for one create request, so a double click cannot make two meetings. */
export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Local date and time for a moment, for "valid until" and "booked for" text. */
export function whenText(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
