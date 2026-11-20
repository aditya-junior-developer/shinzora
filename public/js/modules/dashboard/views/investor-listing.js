/* ==========================================================================
   Shinzora — investor listing for owners (phase 2)
   An owner chooses which of their businesses investors may browse. Turning it
   on needs a real description, because investors read it before anyone else
   contacts the owner. The write goes straight to the owner's own business row,
   which row-level security allows.
   ========================================================================== */

import { esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { chip } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { stageName } from "./investor-kit.js";

const DESC_MIN = 40;

const ownerUid = () => state.user?.id || state.session?.user?.id || null;

/** The owner's businesses, or throws. */
export async function loadListing() {
  const { data, error } = await sb
    .from("businesses")
    .select("id, name, category, stage, location, description, investor_visible, funding_requirement_inr")
    .eq("owner_id", ownerUid())
    .order("created_at", { ascending: false });
  if (error) throw normalizeError(error);
  return data || [];
}

/** `rows` is null when loading failed. */
export function listingMarkup(rows) {
  if (rows === null) {
    return `<section class="card inv-panel" aria-labelledby="listing-title">
      <h2 class="card-title" id="listing-title">${icon("building-2", { size: 15 })} Investor listing</h2>
      <p class="field-hint">Your businesses could not be loaded. Try again in a moment.</p>
    </section>`;
  }
  if (!rows.length) return "";
  return `<section class="card inv-panel inv-rise" aria-labelledby="listing-title">
    <div class="card-head">
      <div>
        <h2 class="card-title" id="listing-title">${icon("building-2", { size: 15 })} Investor listing</h2>
        <p class="field-hint">Choose which businesses investors can browse. Investors see the name, industry, stage, location, description and funding need. Your contact details are never shown.</p>
      </div>
    </div>
    <div class="inv-list">${rows.map(row).join("")}</div>
  </section>`;
}

function row(b) {
  const on = Boolean(b.investor_visible);
  const funding = b.funding_requirement_inr === null || b.funding_requirement_inr === undefined ? "" : String(Math.round(Number(b.funding_requirement_inr)));
  const ready = String(b.description || "").trim().length >= DESC_MIN;
  return `<form class="inv-listing-row" data-listing="${esc(b.id)}" data-desc-ok="${ready ? "1" : "0"}">
    <div class="inv-card-title">
      <strong class="truncate">${esc(b.name || "Untitled business")}</strong>
      <span class="field-hint truncate">${esc(b.category || "No industry")} · ${esc(stageName(b.stage))}</span>
      ${on ? chip("Visible to investors", { tone: "violet", iconName: "eye" }) : chip("Not listed", { tone: "neutral" })}
      ${ready ? "" : `<span class="field-hint">Write a description of at least ${DESC_MIN} characters to list this business.</span>`}
    </div>
    <label class="inv-check"><input type="checkbox" name="visible" ${on ? "checked" : ""} /><span>List for investors</span></label>
    <label class="inv-field">
      <span class="field-label">Funding sought (Rs)</span>
      <input class="input" name="funding" inputmode="numeric" value="${esc(funding)}" placeholder="Not stated" />
    </label>
    <button class="btn btn-secondary btn-sm" type="submit">Save listing</button>
  </form>`;
}

/** Wire the save buttons. `repaint` redraws the page after a save. */
export function bindListing(root, repaint) {
  root.querySelectorAll("[data-listing]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.getAttribute("data-listing");
      const f = new FormData(form);
      const visible = f.get("visible") === "on";
      const raw = String(f.get("funding") || "").replace(/,/g, "").trim();
      const funding = raw === "" ? null : Number(raw);

      if (funding !== null && (!Number.isFinite(funding) || funding < 0 || funding > 1e12)) {
        toast({ title: "Check the funding amount", message: "Enter a number of rupees, or leave it blank." }, { tone: "warn" });
        return;
      }
      if (visible && form.getAttribute("data-desc-ok") !== "1") {
        toast({ title: "Add a description first", message: `Investors read the description. Write at least ${DESC_MIN} characters.` }, { tone: "warn" });
        return;
      }

      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const { error } = await sb
          .from("businesses")
          .update({ investor_visible: visible, funding_requirement_inr: funding })
          .eq("id", id)
          .eq("owner_id", ownerUid());
        if (error) throw normalizeError(error);
        toast({ title: visible ? "Listed for investors" : "Removed from investor listing" }, { tone: "success" });
        repaint?.();
      } catch (error) {
        button.disabled = false;
        toastError(error);
      }
    });
  });
}

