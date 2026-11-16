/* ==========================================================================
   Shinzora — the eight profile rings (0069, 0070)
   --------------------------------------------------------------------------
   A member picks one design. Each time a design is applied it costs ₹10, paid
   through the payments function (purpose ring_apply:<id>). The price and the
   ids are enforced on the server; this list only drives the picker and the
   artwork. Keep the ids in step with public.ring_designs and with
   supabase/functions/payments/index.ts.
   ========================================================================== */

export const RING_PRICE_RUPEES = 10;

export const RING_DESIGNS = Object.freeze([
  { id: "kuromi-neon", name: "Kuromi neon", blend: "screen" },
  { id: "starlight-vine", name: "Starlight vine", blend: "normal" },
  { id: "sakura", name: "Sakura", blend: "normal" },
  { id: "thorn-rose", name: "Thorn and rose", blend: "normal" },
  { id: "gothic-skull", name: "Gothic skull", blend: "normal" },
  { id: "tiger-gold", name: "Tiger gold", blend: "normal" },
  { id: "diamond-wings", name: "Diamond wings", blend: "normal" },
  { id: "pink-gold", name: "Pink gold", blend: "normal" }
]);

/** The artwork for a design, or "" when the id is not in the catalogue. */
export function ringArtUrl(id) {
  return RING_DESIGNS.some((design) => design.id === id) ? `/assets/rings/${id}.png` : "";
}
