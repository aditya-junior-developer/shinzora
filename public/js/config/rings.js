/* ==========================================================================
   Shinzora — the eight profile rings (0069, 0070)
   --------------------------------------------------------------------------
   A member picks one design. Each time a design is applied it is paid for
   through the payments function (purpose ring_apply:<id>). Four premium designs
   cost ₹20; the rest cost ₹10 (0071). The server reads the price from
   public.ring_designs; this list only drives the picker, the artwork and the
   price shown. Keep the ids and prices in step with that table.
   ========================================================================== */

export const RING_PRICE_STANDARD_RUPEES = 10;
export const RING_PRICE_PREMIUM_RUPEES = 20;

/* The RGB ring (0074) is a separate product: one purchase of ₹30, never one of
   the PFP designs above. It is not in RING_DESIGNS, so it never shows in the
   design grid, and it has no artwork file. */
export const RGB_PRICE_RUPEES = 30;
export const RGB_RING = Object.freeze({ id: "rgb", name: "RGB ring", rgb: true, premium: false });

export const RING_DESIGNS = Object.freeze([
  { id: "kuromi-neon", name: "Kuromi neon", blend: "normal", premium: false },
  { id: "starlight-vine", name: "Starlight vine", blend: "normal", premium: false },
  { id: "sakura", name: "Sakura", blend: "normal", premium: false },
  { id: "thorn-rose", name: "Thorn and rose", blend: "normal", premium: false },
  { id: "gothic-skull", name: "Gothic skull", blend: "normal", premium: true },
  { id: "tiger-gold", name: "Tiger gold", blend: "normal", premium: true },
  { id: "diamond-wings", name: "Diamond wings", blend: "normal", premium: true },
  { id: "pink-gold", name: "Pink gold", blend: "normal", premium: true }
]);

/** The artwork for a design, or "" when the id is not in the catalogue. */
export function ringArtUrl(id) {
  return RING_DESIGNS.some((design) => design.id === id) ? `/assets/rings/${id}.png` : "";
}

/** Price in rupees for one ring: ₹30 for the RGB ring, ₹20 for the four premium designs, ₹10 otherwise. */
export function ringPriceRupees(design) {
  if (design?.rgb) return RGB_PRICE_RUPEES;
  return design?.premium ? RING_PRICE_PREMIUM_RUPEES : RING_PRICE_STANDARD_RUPEES;
}

/** The payment purpose for buying one ring. The server reads the price from this purpose. */
export function ringPurpose(design) {
  return design?.rgb ? "rgb_ring" : `ring_apply:${design?.id}`;
}

/** The label shown on the payment. */
export function ringLabel(design) {
  return design?.rgb ? RGB_RING.name : `Profile ring: ${design?.name}`;
}
