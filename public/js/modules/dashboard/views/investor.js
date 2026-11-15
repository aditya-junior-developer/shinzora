/* ==========================================================================
   Shinzora — Investor view (P9)
   An investor account sees only the decks founders have shared with them.
   It is read-only: no business, no inventory, no sales, no AI tools and no
   admin area. Everything comes from investor_shared_decks(), which the
   database limits to ready decks shared with this account and not revoked.
   ========================================================================== */

import { qs, esc, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { timeAgo } from "../../../lib/format.js";
import { pageHead, emptyState, skeletonView, chip, setupNotice } from "../components.js";
import { toastError, toast } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import { SHARE_NOTE } from "../../../config/investor-deck.js";

let root = null;

export default async function render(host) {
  root = host;
  root.innerHTML = skeletonView(3);
  try {
    const { data, error } = await sb.rpc("investor_shared_decks");
    if (error) throw error;
    paint(Array.isArray(data) ? data : []);
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Shared with you", desc: "Decks founders have shared with you." })}
      ${setupNotice(normalizeError(error), "Shared decks")}`;
  }
}

function paint(shares) {
  /* Each paint replaces this wrapper, so the listeners below die with it and
     a repaint after a removal never stacks a second copy on an old list. */
  root.innerHTML = `<div class="investor-view">
    ${pageHead({
      title: "Shared with you",
      desc: "Decks founders have chosen to share with you. Read-only.",
      badge: chip("Investor", { tone: "violet", iconName: "briefcase" })
    })}
    ${
      shares.length
        ? `<div class="deck-grid">${shares.map(card).join("")}</div>`
        : emptyState({
            iconName: "briefcase",
            title: "Nothing shared yet",
            desc: "When a founder shares a deck with your handle, it appears here. You will only ever see the slides they chose to share."
          })
    }
    <p class="field-hint deck-note">${esc(SHARE_NOTE)}</p>
  </div>`;

  const wrap = qs(".investor-view", root);
  delegate(wrap, "click", "[data-open-deck]", (_event, button) => {
    const share = shares.find((s) => s.deckId === button.getAttribute("data-open-deck"));
    if (share) openDeck(share);
  });

  delegate(wrap, "click", "[data-remove-share]", (_event, button) => {
    const share = shares.find((s) => s.shareId === button.getAttribute("data-remove-share"));
    if (share) confirmRemove(share);
  });
}

function card(share) {
  const count = Array.isArray(share.slides) ? share.slides.length : 0;
  return `<article class="card deck-card deck-card-investor">
    <div class="deck-card-head">${chip("Shared by @" + (share.sharedBy || "founder"), { tone: "info", iconName: "users-round" })}</div>
    <strong class="deck-card-title">${esc(share.title)}</strong>
    <span class="field-hint">${count} slide${count === 1 ? "" : "s"} · shared ${esc(timeAgo(share.sharedAt))}</span>
    <div class="card-actions">
      <button class="btn btn-primary btn-sm" type="button" data-open-deck="${esc(share.deckId)}">${icon("eye", { size: 13 })} Read deck</button>
      <button class="btn btn-ghost btn-sm" type="button" data-remove-share="${esc(share.shareId)}">Remove from my list</button>
    </div>
  </article>`;
}

function openDeck(share) {
  const slides = Array.isArray(share.slides) ? share.slides : [];
  const body = slides.length
    ? `<ol class="deck-read">${slides
        .map(
          (slide, i) => `<li class="deck-read-slide">
            <span class="deck-slide-no">${i + 1}</span>
            <div>
              <strong>${esc(slide.title || "")}</strong>
              ${
                Array.isArray(slide.bullets) && slide.bullets.length
                  ? `<ul>${slide.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
                  : ""
              }
            </div>
          </li>`
        )
        .join("")}</ol>`
    : `<p class="muted">This deck has no slides.</p>`;

  openModal({
    title: share.title,
    desc: `Shared by @${esc(share.sharedBy || "founder")}. Read-only.`,
    size: "lg",
    body: `<div class="deck-read-wrap">${body}</div>`,
    footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`
  });
}

function confirmRemove(share) {
  openModal({
    title: "Remove this deck from your list?",
    size: "sm",
    body: `<p class="muted" style="font-size:var(--fs-sm);line-height:1.7">Only your copy of the link is removed. The founder can share it with you again later.</p>`,
    footer: `<button class="btn btn-ghost" data-modal-close>Keep it</button>
             <button class="btn btn-danger" data-confirm-remove>Remove</button>`,
    onMount: (modal) => {
      qs("[data-confirm-remove]", modal)?.addEventListener("click", async () => {
        try {
          const { error } = await sb.rpc("investor_remove_share", { p_share: share.shareId });
          if (error) throw normalizeError(error);
          toast({ title: "Removed from your list" }, { tone: "success" });
          const { data } = await sb.rpc("investor_shared_decks");
          paint(Array.isArray(data) ? data : []);
        } catch (err) {
          toastError(err);
        }
      });
    }
  });
}
