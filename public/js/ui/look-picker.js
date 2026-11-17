/* ==========================================================================
   Shinzora — the theme ("look") picker
   --------------------------------------------------------------------------
   One picker for every panel: the dashboard's Settings and the admin
   Appearance view both use it, so the tiles, the "Current" marker and the
   save path cannot drift apart.

   The caller owns the save. `save(id)` must resolve once the choice is stored
   (for example on profiles.theme) and reject if it could not be stored; the
   picker then puts the previous look back.
   ========================================================================== */

import { qsa, esc, delegate } from "../lib/dom.js";
import { toast, toastError } from "./toast.js";
import { normalizeError } from "../lib/supabase.js";
import { applyPreset, currentPreset } from "./theme.js";
import { PRESETS, presetById } from "../config/theme-presets.js";

/** The tiles and their heading, as one card. */
export function lookPickerHtml({ title = "Theme", sub = "Changes the colours of the whole panel: surfaces, accent, text and charts. Saved to your account and used on every device." } = {}) {
  const active = currentPreset();
  const tiles = PRESETS.map((preset) => {
    const selected = preset.id === active;
    return `<button type="button" class="look-tile ${selected ? "is-selected" : ""}" data-preset="${esc(preset.id)}"
        data-look="${esc(preset.id)}" aria-pressed="${selected}" aria-label="${esc(preset.name)} theme. ${esc(preset.blurb)}">
        <span class="look-preview" aria-hidden="true">
          <span class="look-preview-side"></span>
          <span class="look-preview-main">
            <span class="look-preview-bar"></span>
            <span class="look-preview-row"><span class="look-preview-card"></span><span class="look-preview-card"></span></span>
            <span class="look-preview-chart"></span>
          </span>
        </span>
        <span class="look-name">${esc(preset.name)}${selected ? ` <span class="look-current">Current</span>` : ""}</span>
        <span class="look-blurb">${esc(preset.blurb)}</span>
      </button>`;
  }).join("");
  return `<div class="card look-card">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(title)}</div>
          <div class="card-sub">${esc(sub)}</div>
        </div>
      </div>
      <div class="card-body">
        <div class="look-grid" role="group" aria-label="${esc(title)}">${tiles}</div>
        <div class="field-hint" id="look-status" role="status" aria-live="polite"></div>
      </div>
    </div>`;
}

/** Mark the tile of the look in use. Safe to call after any repaint. */
export function paintLookSelection(root = document) {
  const active = currentPreset();
  qsa("[data-look]", root).forEach((tile) => {
    const selected = tile.dataset.look === active;
    tile.classList.toggle("is-selected", selected);
    tile.setAttribute("aria-pressed", String(selected));
    const name = tile.querySelector(".look-name");
    if (name) name.innerHTML = `${esc(presetById(tile.dataset.look).name)}${selected ? ` <span class="look-current">Current</span>` : ""}`;
  });
}

/**
 * Wire the tiles inside `root`. Picking a tile applies it at once; `save` then
 * stores it. A failed save puts the previous look back and says so.
 */
export function bindLookPicker(root, { save } = {}) {
  delegate(root, "click", "[data-look]", async (_event, tile) => {
    const id = presetById(tile.dataset.look).id;
    const previous = currentPreset();
    if (id === previous) return;
    const status = root.querySelector("#look-status") || document.getElementById("look-status");
    applyPreset(id);
    paintLookSelection(root);
    if (!save) {
      if (status) status.textContent = `${presetById(id).name} is used on this device.`;
      return;
    }
    try {
      await save(id);
      if (status) status.textContent = `${presetById(id).name} saved to your account.`;
      toast(`${presetById(id).name} theme applied.`);
    } catch (error) {
      applyPreset(previous);
      paintLookSelection(root);
      if (status) status.textContent = "The theme could not be saved. The previous one is showing.";
      toastError(normalizeError(error));
    }
  });
}
