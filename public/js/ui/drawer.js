/* ==========================================================================
   Shinzora — navigation drawer
   --------------------------------------------------------------------------
   The dashboard sidebar, the admin console sidebar and the marketing menu are
   all the same component in spirit: a panel that slides over the page, holds
   focus while it is open, and gives you three ways out (its own close button, a
   click outside, Escape).

   They used to be three separate implementations, and each one had grown a
   different subset of that behaviour — the dashboard had no body lock, admin
   only worked below 1024px, marketing closed on Escape but not on a scrim
   click. This is that behaviour in one place, so a panel is a drawer or it is
   nothing.

   Deliberately small: it owns state and interaction, never markup. The page
   supplies the panel, the scrim and its toggles; CSS does the sliding.
   ========================================================================== */

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex='-1'])";

/**
 * @param {object} options
 * @param {HTMLElement}  options.panel     the sliding panel
 * @param {HTMLElement} [options.scrim]    the backdrop that closes it
 * @param {HTMLElement[]|string} [options.toggles] buttons that open/close it
 * @param {string} [options.openClass]     class that slides the panel in
 * @param {string} [options.scrimClass]    class that fades the scrim in
 * @param {string} [options.bodyClass]     class on <body> while open (page lock)
 * @param {string} [options.activeSelector] element to focus when it opens
 * @param {Function} [options.onNavigate]  called when a link inside closes it
 */
export function createDrawer(options = {}) {
  const {
    panel,
    scrim = null,
    openClass = "is-open",
    scrimClass = "is-visible",
    bodyClass = "drawer-open",
    activeSelector = ".is-active",
    labelSelector = "[data-drawer-label]",
    closeOnNavigate = true
  } = options;

  if (!panel) return null;

  const toggles = (typeof options.toggles === "string"
    ? Array.from(document.querySelectorAll(options.toggles))
    : options.toggles || []
  ).filter(Boolean);

  let lastFocus = null;

  const isOpen = () => panel.classList.contains(openClass);

  function open() {
    if (isOpen()) return;
    lastFocus = typeof document !== "undefined" ? document.activeElement : null;
    panel.classList.add(openClass);
    scrim?.classList.add(scrimClass);
    document.body?.classList.add(bodyClass);
    panel.removeAttribute("aria-hidden");
    panel.removeAttribute("inert");
    toggles.forEach((button) => button.setAttribute("aria-expanded", "true"));

    /* Focus the link for the page you are on (or the first one) so a keyboard
       user lands inside what they just opened instead of behind it. Deferred by
       a frame: a panel that fades in from `visibility: hidden` cannot take focus
       on the same tick, and the browser silently drops the call. */
    const focusInside = () => {
      const target = panel.querySelector(activeSelector) || panel.querySelector(FOCUSABLE);
      target?.focus?.({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusInside);
    else focusInside();
  }

  function close({ restoreFocus = false } = {}) {
    const wasOpen = isOpen();
    panel.classList.remove(openClass);
    scrim?.classList.remove(scrimClass);
    document.body?.classList.remove(bodyClass);
    panel.setAttribute("aria-hidden", "true");
    toggles.forEach((button) => button.setAttribute("aria-expanded", "false"));
    if (wasOpen && restoreFocus) (lastFocus || toggles[0])?.focus?.({ preventScroll: true });
  }

  const toggle = () => (isOpen() ? close({ restoreFocus: true }) : open());

  toggles.forEach((button) =>
    button.addEventListener("click", (event) => {
      /* A toggle inside the panel would otherwise also match the navigate
         delegate below and close what it just opened. */
      event.stopPropagation();
      toggle();
    })
  );

  if (scrim) scrim.addEventListener("click", () => close({ restoreFocus: true }));

  panel.querySelectorAll("[data-drawer-close]").forEach((button) =>
    button.addEventListener("click", () => close({ restoreFocus: true }))
  );

  /* A drawer is modal: Escape must work, and it must not survive navigation —
     the next screen would otherwise sit behind an invisible overlay. */
  const onKeydown = (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  };
  document.addEventListener("keydown", onKeydown);

  if (closeOnNavigate) {
    panel.addEventListener("click", (event) => {
      if (event.target.closest?.("a[href], [data-drawer-navigate]")) close();
    });
  }

  /* Closed is the only correct start state at every width: the drawer is
     opened on purpose, never inherited from a previous session. */
  close();

  return { open, close, toggle, isOpen, labelSelector };
}
