/* ==========================================================================
   Shinzora — profile rings on every avatar (brief item 6)
   --------------------------------------------------------------------------
   A member who holds Glow or Elite wears a ring on their photo or initials
   wherever their avatar appears. The ring is decided by the database, never by
   the browser:

     - an avatar carries data-ring-user="<member id>" (see avatar.js)
     - markRings() asks member_rings() (migration 0066) for the tier and accent
       of the members on the page, in one call per 200, and caches the answer
       for five minutes
     - the answer is written as data-tier / data-accent, which components.css
       and views.css turn into the ring

   Only the ring leaves the database: no order, payment or contact detail.
   A member with no tier has no ring. A failed lookup leaves the avatar plain
   and is retried the next time the page changes.
   ========================================================================== */

import { sb } from "./supabase.js";

const TTL_MS = 5 * 60 * 1000;
const CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** member id -> { tier, accent, at }. tier is null for a member with no ring. */
const cache = new Map();
const inflight = new Map();
let watching = false;
let scheduled = null;

/** Write the ring onto one element. A null ring removes it. */
export function applyRing(node, ring) {
  if (!node) return;
  if (ring?.tier) {
    node.setAttribute("data-tier", ring.tier);
    if (ring.accent) node.setAttribute("data-accent", ring.accent);
    else node.removeAttribute("data-accent");
  } else {
    node.removeAttribute("data-tier");
    node.removeAttribute("data-accent");
  }
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
            cache.set(id, { tier: row?.ring_tier || null, accent: row?.ring_accent || null, at: stamp });
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

/** Paint the ring on every avatar under `root` that names a member. */
export async function markRings(root = document) {
  const nodes = [...root.querySelectorAll("[data-ring-user]")];
  if (!nodes.length) return;
  const ids = [...new Set(nodes.map((node) => node.getAttribute("data-ring-user")).filter((id) => UUID.test(id || "")))];
  await fetchRings(ids);
  const now = Date.now();
  for (const node of nodes) {
    const id = node.getAttribute("data-ring-user");
    if (!UUID.test(id || "")) continue;
    if (fresh(id, now)) applyRing(node, cache.get(id));
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
