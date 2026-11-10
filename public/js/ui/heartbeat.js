/* ==========================================================================
   Shinzora — the two background ticks the dashboard needs
   --------------------------------------------------------------------------
   Presence and referral months. Both are "call an RPC, ignore the answer":
   nothing on screen waits for either, and a failure is not worth a toast —
   the worst case is that somebody shows as offline for a minute or that a bonus
   month arrives on the next visit.

   The heartbeat stops when the tab is hidden. A dashboard left open overnight in
   a background tab should not report the person as active at 4am.
   ========================================================================== */

import { sb } from "../lib/supabase.js";

const PRESENCE_MS = 60 * 1000;
const TICK_KEY = "shinzora:referral-tick";
const TICK_EVERY_MS = 24 * 60 * 60 * 1000;

let timer = null;
let started = false;

async function beat() {
  if (!sb) return;
  try {
    await sb.rpc("presence_touch");
  } catch {
    /* offline, or the tab was closed mid-request */
  }
}

export function startPresence() {
  if (started || typeof window === "undefined") return;
  /* No client, no heartbeat. This also keeps the timer out of test environments
     and offline shells, where an interval would keep the process alive for
     nothing. */
  if (typeof sb?.rpc !== "function") return;
  started = true;

  void beat();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void beat();
  }, PRESENCE_MS);
  /* In Node the interval would hold the process open; in a browser this is a
     number and there is nothing to unref. */
  timer?.unref?.();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void beat();
  });
  /* A last mark on the way out. `pagehide` fires on navigation and on a closed
     tab, where `unload` no longer does. */
  window.addEventListener("pagehide", () => {
    if (timer) window.clearInterval(timer);
    timer = null;
    try {
      sb?.rpc("presence_touch");
    } catch {
      /* nothing to do while the page is going away */
    }
  });
}

export function stopPresence() {
  if (timer) window.clearInterval(timer);
  timer = null;
  started = false;
}

/** Grant any referral month that has come due. At most once a day per device. */
export async function runReferralTick() {
  if (!sb) return null;
  try {
    const last = Number(localStorage.getItem(TICK_KEY) || 0);
    if (Date.now() - last < TICK_EVERY_MS) return null;
    localStorage.setItem(TICK_KEY, String(Date.now()));
  } catch {
    /* storage blocked: fall through and let the server decide */
  }
  try {
    const { data, error } = await sb.rpc("referral_bonus_tick");
    return error ? null : data;
  } catch {
    return null;
  }
}
