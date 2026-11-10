/* ==========================================================================
   Shinzora — hero atmosphere controller
   --------------------------------------------------------------------------
   The heavy lifting lives in `/js/ui/aurora.js`, which paints the purple flame
   aurora and manages its own lifecycle (offscreen pause, resize, reduced
   motion). This module only adds what is specific to the marketing hero:

     • the device-class flags used by fx.css (fx-low-power / fx-reduced)
     • pausing the CSS-only layers (.fx-grid scroll, badge sheen, CTA flow)
       when the hero is off screen or the tab is hidden

   The previous implementation drew a floating particle field and drifted glass
   orbs with pointer parallax. Those were removed on request: the aurora is the
   single background treatment now, and nothing tracks the pointer over it.
   ========================================================================== */

import { autoMountAurora } from "./aurora.js?v=20261110b";

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function isLowPower() {
  const cores = navigator.hardwareConcurrency || 8;
  const memory = navigator.deviceMemory || 8;
  const connection = navigator.connection || {};
  return (
    cores <= 2 ||
    memory <= 2 ||
    connection.saveData === true ||
    /(^|-)2g$/.test(connection.effectiveType || "")
  );
}

export function initHeroFx() {
  if (isLowPower()) document.documentElement.classList.add("fx-low-power");
  if (prefersReducedMotion()) document.documentElement.classList.add("fx-reduced");

  /* Mount any canvas that was added after the initial module pass (for
     example by a section loaded on demand). */
  autoMountAurora();

  const hero = document.querySelector(".hero");
  const stage = hero?.querySelector(".fx-stage");
  if (!hero || !stage) return;

  const setPaused = (paused) => stage.classList.toggle("fx-paused", paused);

  /* The footer's motion switch stops the looping layers even while the hero is
     on screen — 2.2.2 needs a user-controlled stop, not just an automatic one. */
  document.documentElement.addEventListener("shinzora:motion", (event) => {
    setPaused(event.detail.paused || document.hidden);
  });
  if (document.documentElement.classList.contains("motion-paused")) setPaused(true);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting), {
      rootMargin: "120px"
    }).observe(hero);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setPaused(true);
    else if (hero.getBoundingClientRect().bottom > 0) setPaused(false);
  });
}

export default initHeroFx;
