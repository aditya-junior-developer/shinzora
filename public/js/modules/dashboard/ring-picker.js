/* ==========================================================================
   Shinzora — the profile ring picker (0073)
   --------------------------------------------------------------------------
   Shared by Billing and Settings. A member:
     - previews any design on their own photo (or initials) before buying;
     - buys a design once (a payment, through onBuy); after that it is theirs;
     - wears any design they own, at no cost, and can change it at will;
     - removes the ring to go back to the default look, at no cost.

   The database decides what is owned and worn (profile_ring_owned and
   profile_ring_choices, written only by a verified payment or by ring_wear and
   ring_remove). This module only reads those tables and calls those functions.
   The preview is drawn with the same CSS as a worn ring, and it is never saved
   on its own.
   ========================================================================== */

import { RING_DESIGNS, ringArtUrl, ringPriceRupees } from "../../config/rings.js";
import { avatarMarkup } from "../../lib/avatar.js";
import { applyRing, forgetRing } from "../../lib/rings.js";
import { sb, normalizeError } from "../../lib/supabase.js";
import { esc, qs, delegate } from "../../lib/dom.js";
import { toast, toastError } from "../../ui/toast.js";

const NONE = "none";

/**
 * Mount the picker into `host`. Returns { refresh } so the caller can repaint
 * after a purchase is verified.
 *
 * @param {HTMLElement} host
 * @param {{ userId: string, name?: string, email?: string, avatarUrl?: string|null,
 *           onBuy: (design: object) => void }} options
 */
export async function mountRingPicker(host, { userId, name = "", email = "", avatarUrl = null, onBuy }) {
  if (!host) return { refresh: async () => {} };
  let owned = new Set();
  let worn = null;
  let selected = NONE;
  let busy = false;
  let loaded = false;

  async function load() {
    const [ownedRes, wornRes] = await Promise.all([
      sb.from("profile_ring_owned").select("ring_id").eq("user_id", userId),
      sb.from("profile_ring_choices").select("ring_id").eq("user_id", userId).maybeSingle()
    ]);
    if (ownedRes.error) throw normalizeError(ownedRes.error);
    owned = new Set((ownedRes.data || []).map((row) => row.ring_id));
    worn = wornRes?.data?.ring_id || null;
    if (!loaded) {
      selected = worn || NONE;
      loaded = true;
    }
  }

  function design(id) {
    return RING_DESIGNS.find((d) => d.id === id) || null;
  }

  function stateOf(d) {
    if (worn === d.id) return "Wearing";
    if (owned.has(d.id)) return "Owned";
    return `₹${ringPriceRupees(d)}`;
  }

  function copyFor(chosen) {
    if (!chosen) {
      return worn
        ? { title: "Default look (no ring)", text: "Your ring is off. Pick a design to wear it, or keep the default look." }
        : { title: "Default look (no ring)", text: "You are using the default look. Pick a design to preview it on your photo." };
    }
    if (worn === chosen.id) return { title: chosen.name, text: "You are wearing this ring." };
    if (owned.has(chosen.id)) return { title: chosen.name, text: "You own this ring. Wearing it costs nothing." };
    return {
      title: chosen.name,
      text: `Preview only. Buy it once for ₹${ringPriceRupees(chosen)} and keep it. You can wear, change or remove it at no extra cost.`
    };
  }

  function actionsFor(chosen) {
    const parts = [];
    if (chosen && worn !== chosen.id) {
      if (owned.has(chosen.id)) {
        parts.push(`<button class="btn btn-primary btn-sm" type="button" data-ring-wear="${esc(chosen.id)}" ${busy ? "disabled" : ""}>Wear this ring</button>`);
      } else {
        parts.push(`<button class="btn btn-primary btn-sm" type="button" data-ring-buy="${esc(chosen.id)}" ${busy ? "disabled" : ""}>Buy and wear · ₹${ringPriceRupees(chosen)}</button>`);
      }
    }
    if (worn) {
      parts.push(`<button class="btn btn-secondary btn-sm" type="button" data-ring-remove ${busy ? "disabled" : ""}>Remove my ring</button>`);
    }
    return parts.join("");
  }

  function paint() {
    const chosen = design(selected);
    const copy = copyFor(chosen);
    const stage = `<div class="ring-preview-stage" data-ring-stage>${avatarMarkup({ name, email, avatarUrl, size: "xl" })}</div>`;

    host.innerHTML = `
      <div class="ring-pick">
        <div class="ring-preview" aria-live="polite">
          ${stage}
          <div class="ring-preview-copy">
            <strong>${esc(copy.title)}</strong>
            <span class="field-hint">${esc(copy.text)}</span>
            <div class="ring-preview-actions">${actionsFor(chosen)}</div>
          </div>
        </div>
        <div class="ring-picker" role="listbox" aria-label="Profile rings">
          <button type="button" class="ring-option ${selected === NONE ? "is-selected" : ""}" data-ring-select="${NONE}" aria-pressed="${selected === NONE}" ${worn ? "" : 'aria-current="true"'}>
            <span class="ring-option-art ring-option-none" aria-hidden="true">${esc("∅")}</span>
            <strong>Default look</strong>
            <span class="ring-option-state">${worn ? "No ring" : "Wearing"}</span>
          </button>
          ${RING_DESIGNS.map(
            (d) => `<button type="button" class="ring-option ${selected === d.id ? "is-selected" : ""}" data-ring-select="${esc(d.id)}" aria-pressed="${selected === d.id}" ${worn === d.id ? 'aria-current="true"' : ""}>
              <span class="ring-option-art" ${d.blend === "screen" ? 'data-blend="screen"' : ""}><img src="${esc(ringArtUrl(d.id))}" alt="" loading="lazy" decoding="async" /></span>
              <strong>${esc(d.name)}</strong>
              <span class="ring-option-state">${esc(stateOf(d))}</span>
            </button>`
          ).join("")}
        </div>
      </div>`;

    /* The preview ring is drawn with the same attributes a worn ring has, so it
       looks exactly like it will. It is not saved and it is not in the database. */
    const avatar = qs("[data-ring-stage] .avatar", host);
    if (avatar) applyRing(avatar, chosen ? { id: chosen.id, name: chosen.name } : null);
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    paint();
    try {
      await action();
    } catch (error) {
      toastError(error);
    } finally {
      busy = false;
      paint();
    }
  }

  delegate(host, "click", "[data-ring-select]", (_event, button) => {
    selected = button.getAttribute("data-ring-select");
    paint();
  });

  delegate(host, "click", "[data-ring-wear]", (_event, button) => {
    const id = button.getAttribute("data-ring-wear");
    run(async () => {
      const { error } = await sb.rpc("ring_wear", { p_ring_id: id });
      if (error) throw normalizeError(error);
      worn = id;
      toast({ title: "Ring worn", message: `${design(id)?.name || "Your ring"} is on your profile now.` }, { tone: "success" });
      forgetRing(userId);
    });
  });

  delegate(host, "click", "[data-ring-remove]", () => {
    run(async () => {
      const { error } = await sb.rpc("ring_remove");
      if (error) throw normalizeError(error);
      worn = null;
      toast({ title: "Ring removed", message: "Your profile is back to the default look. The ring stays yours." }, { tone: "success" });
      forgetRing(userId);
    });
  });

  delegate(host, "click", "[data-ring-buy]", (_event, button) => {
    const chosen = design(button.getAttribute("data-ring-buy"));
    if (!chosen || typeof onBuy !== "function") return;
    onBuy(chosen);
  });

  host.innerHTML = `<div class="skeleton" style="height:180px;border-radius:var(--r-lg)" aria-hidden="true"></div>`;
  try {
    await load();
  } catch (error) {
    host.innerHTML = `<p class="field-hint">${esc(normalizeError(error).message || "Your rings could not be loaded. Try again in a moment.")}</p>`;
    return { refresh: async () => {} };
  }
  paint();

  return {
    refresh: async () => {
      await load();
      paint();
    }
  };
}
