/* ==========================================================================
   Shinzora — motion preference switch
   --------------------------------------------------------------------------
   WCAG 2.2.2 (Pause, Stop, Hide) applies to anything that moves for more than
   five seconds: the looping hero grid, the aurora canvas, the button sheen and
   the typing effect all qualify. This adds one control in the footer that stops
   them, remembers the choice, and applies it on the next visit before the first
   frame is painted.
   ========================================================================== */

const KEY = "shinzora.motion.paused";
const root = document.documentElement;

/** True when the visitor chose to stop motion on a previous visit. */
export function motionPaused() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Apply the switch: CSS pauses every animation, JS layers check the class. */
function apply(paused) {
  root.classList.toggle("motion-paused", paused);
  root.dispatchEvent(new CustomEvent("shinzora:motion", { detail: { paused } }));
  document.querySelectorAll("[data-motion-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", String(paused));
    const label = button.querySelector("[data-motion-label]");
    if (label) label.textContent = paused ? "Resume motion" : "Pause motion";
  });
}

export function initMotionToggle() {
  const buttons = document.querySelectorAll("[data-motion-toggle]");
  if (!buttons.length) return;

  /* Restore immediately, including for visitors who set the preference last
     time and arrived before any animation started. */
  apply(motionPaused());

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const next = !root.classList.contains("motion-paused");
      apply(next);
      try {
        if (next) localStorage.setItem(KEY, "1");
        else localStorage.removeItem(KEY);
      } catch {
        /* storage blocked: the setting still applies to this visit */
      }
    });
  });
}

export default initMotionToggle;
