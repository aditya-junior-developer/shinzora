/* ==========================================================================
   Shinzora — one avatar, everywhere
   --------------------------------------------------------------------------
   A picture beat initials, but only where the picture exists. The dashboard
   topbar already showed an uploaded photo while every list — the admin's
   customers, freelancers and payments, the team screen, the settings card —
   still painted two letters from the name, so the same person appeared as
   "AS" in one place and as their face in another.

   This module is the single answer: given a name, an email and an optional
   URL, it renders the photo when there is one and initials when there is not.
   Every surface uses it, so a photo uploaded once shows up in all of them.

   Markup only — no DOM, no fetching — so it can be unit-tested in Node.
   ========================================================================== */

import { esc } from "./dom.js";
import { initials } from "./format.js";

/**
 * @param {object} options
 * @param {string} [options.name]        full name, for the initials fallback
 * @param {string} [options.email]       used when there is no name
 * @param {string|null} [options.avatarUrl] uploaded photo URL
 * @param {string} [options.size]        "sm" | "lg" | "xl" | "" (default)
 * @param {string} [options.className]   extra classes on the wrapper
 * @param {string} [options.alt]         alt text; defaults to the name
 */
export function avatarMarkup({ name = "", email = "", avatarUrl = null, size = "", className = "", alt = "" } = {}) {
  const variant = !size ? "" : size.startsWith("avatar-") ? size : `avatar-${size}`;
  const cls = ["avatar", variant, className].filter(Boolean).join(" ");
  const label = initials(name || email || "SZ");
  const url = typeof avatarUrl === "string" ? avatarUrl.trim() : "";

  /* Only an http(s) URL or a same-origin path is ever put in a src. A stored
     value is data from the database, and an avatar is not a place to discover
     that someone saved `javascript:`. */
  const safe = /^(https?:\/\/|\/)/i.test(url) ? url : "";
  if (!safe) return `<span class="${cls}">${esc(label)}</span>`;

  return `<span class="${cls}"><img src="${esc(safe)}" alt="${esc(alt || name || "Profile photo")}" loading="lazy" decoding="async" /></span>`;
}

/** True when a stored value can be used as an image source. */
export function usableAvatar(url) {
  return typeof url === "string" && /^(https?:\/\/|\/)/i.test(url.trim());
}
