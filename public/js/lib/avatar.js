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
 * @param {"cover"|"contain"} [options.fit] how the image fills the circle
 */
export function avatarMarkup({ name = "", email = "", avatarUrl = null, size = "", className = "", alt = "", fit = "cover" } = {}) {
  const variant = !size ? "" : size.startsWith("avatar-") ? size : `avatar-${size}`;
  const url = usableAvatar(avatarUrl) ? avatarUrl.trim() : "";
  const fitClass = url && fit === "contain" ? "is-logo" : "";
  const cls = ["avatar", variant, fitClass, className].filter(Boolean).join(" ");

  if (!url) return `<span class="${cls}">${esc(initials(name || email || "SZ"))}</span>`;

  return `<span class="${cls}">${avatarImage(url, alt || name || "Profile photo")}</span>`;
}

/** The <img> on its own, for a caller that already owns the circle. */
export function avatarImage(url, alt = "Profile photo") {
  return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async" />`;
}

/**
 * Paint an avatar INTO an element that is already the circle.
 *
 * The topbar and the sidebar ship their own `<span class="avatar avatar-sm">`
 * in the HTML. Returning `avatarMarkup()` into one of those produced
 * `<span class="avatar avatar-sm"><span class="avatar">…</span></span>`: a
 * second circle at the *default* 34px, inside a 26px one, clipped by the outer
 * border-radius. The photo came out zoomed and pushed off centre and the brand
 * gradient showed at the edge — reported as "I want the pfp in the centre".
 *
 * So the markup helpers are for holders, and this is for the real thing: it
 * touches contents and one state class, never nesting a circle in a circle.
 */
export function paintAvatar(node, { name = "", email = "", avatarUrl = null, alt = "", fit = "cover" } = {}) {
  if (!node) return;
  const url = usableAvatar(avatarUrl) ? avatarUrl.trim() : "";
  node.classList.toggle("is-logo", Boolean(url) && fit === "contain");
  node.innerHTML = url ? avatarImage(url, alt || name || "Profile photo") : esc(initials(name || email || "SZ"));
}

/** True when a stored value can be used as an image source. */
export function usableAvatar(url) {
  return typeof url === "string" && /^(https?:\/\/|\/)/i.test(url.trim());
}
