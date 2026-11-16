/* ==========================================================================
   Shinzora — profile rings on every avatar
   --------------------------------------------------------------------------
   A member who has applied a ring design (₹10 each time, see 0069) wears it on
   their photo or initials wherever their avatar appears. The choice is decided
   by the database, never by the browser:

     - an avatar carries data-ring-user="<member id>" (see avatar.js)
     - markRings() asks member_rings() for the design of the members on the page,
       in one call per 200, and caches the answer for five minutes
     - the design is written as data-ring and --ring-art, which components.css
       draws as an overlay

   Only the design leaves the database: no order, payment or contact detail.
   A member with no ring has no overlay. A failed lookup leaves the avatar plain
   and is retried the next time the page changes.
   ========================================================================== */

import { sb } from "./supabase.js";
import { RING_DESIGNS, ringArtUrl } from "../config/rings.js";

const TTL_MS = 5 * 60 * 1000;
const CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN = new Set(RING_DESIGNS.map((design) => design.id));

/** member id -> { ring: { id, name } | null, at }. ring is null for a member with no ring. */
const cache = new Map();
const inflight = new Map();
let watching = false;
let scheduled = null;

/** Write the ring onto one element. A null or unknown ring removes it. */
export function applyRing(node, ring) {
  if (!node) return;
  if (ring?.id && KNOWN.has(ring.id)) {
    node.setAttribute("data-ring", ring.id);
    node.style.setProperty("--ring-art", `url("${ringArtUrl(ring.id)}")`);
    const blend = RING_DESIGNS.find((design) => design.id === ring.id)?.blend;
    if (blend === "screen") node.setAttribute("data-ring-blend", "screen");
    else node.removeAttribute("data-ring-blend");
  } else {
    node.removeAttribute("data-ring");
    node.removeAttribute("data-ring-blend");
    node.style.removeProperty("--ring-art");
  }
}

/** Drop cached rings (one member, or all when id is null) and repaint. */
export function forgetRing(id) {
  if (id) cache.delete(id);
  else cache.clear();
  if (typeof document !== "undefined") markRings(document).catch(() => {});
}

function fresh(id, now) {
  const hit = cache.get(id);
  return Boolean(hit && now - hit.at < TTL_MS);
}

/** Fetch rings for ids that are not cached yet. Failures are not cached. */
async function fetchRings(ids) {
  const now = Date.now();
  const wanted = ids.filter((id) => !fresh(id, now));
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const pending = chunk.filter((id) => !inflight.has(id));
    if (pending.length) {
      const request = sb
        .rpc("member_rings", { p_user_ids: pending })
        .then(({ data, error }) => {
          if (error) throw error;
          const seen = new Map((Array.isArray(data) ? data : []).map((row) => [row.member_id, row]));
          const stamp = Date.now();
          for (const id of pending) {
            const row = seen.get(id);
            cache.set(id, {
              ring: row?.ring_id ? { id: row.ring_id, name: row.ring_name || "" } : null,
              at: stamp
            });
          }
        })
        .catch(() => {
          /* Leave the avatars plain; the next page change asks again. */
        })
        .finally(() => {
          for (const id of pending) inflight.delete(id);
        });
      for (const id of pending) inflight.set(id, request);
    }
    await Promise.all(chunk.map((id) => inflight.get(id)).filter(Boolean));
  }
}

/** Paint the ring on every avatar under `root` (or `root` itself) that names a member. */
export async function markRings(root = document) {
  const nodes = [...(root.matches?.("[data-ring-user]") ? [root] : []), ...root.querySelectorAll("[data-ring-user]")];
  if (!nodes.length) return;
  const ids = [...new Set(nodes.map((node) => node.getAttribute("data-ring-user")).filter((id) => UUID.test(id || "")))];
  await fetchRings(ids);
  const now = Date.now();
  for (const node of nodes) {
    const id = node.getAttribute("data-ring-user");
    if (!UUID.test(id || "")) continue;
    if (fresh(id, now)) applyRing(node, cache.get(id)?.ring);
  }
}

/**
 * Watch the page so avatars rendered later (a thread, a member list, a search
 * result) get their ring too. Safe to call more than once.
 */
export function startRingWatch(root = document.body) {
  if (watching || !root || typeof MutationObserver === "undefined") return;
  watching = true;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      markRings(document).catch(() => {});
    }, 50);
  });
  observer.observe(root, { childList: true, subtree: true });
  markRings(document).catch(() => {});
}
