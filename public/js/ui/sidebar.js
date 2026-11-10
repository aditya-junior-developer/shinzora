/* ==========================================================================
   Shinzora — persistent navigation sidebar
   --------------------------------------------------------------------------
   The dashboard sidebar is part of the page, not a modal that covers it. On a
   desktop it is a column of the layout in one of two states:

       expanded  a 258px column with icons, labels, the workspace switcher and
                 the recent-chat list
       rail      a 76px column of icons; the labels stay in the accessibility
                 tree but stop taking space, and each icon grows a tooltip

   The main column is a grid track, so it re-flows as the sidebar changes width.
   Nothing is blurred, darkened or blocked while the sidebar is open on a
   desktop — the page beside it stays live.

   Below 1024px there is no room for a column, so the same panel becomes a
   drawer: it slides over the content, with a scrim, and closes itself when a
   destination is picked.

   This is deliberately NOT `ui/drawer.js`. A drawer is modal by definition —
   it locks the page, traps focus and closes on Escape — and every one of those
   behaviours is wrong for a column the user is meant to keep open. The admin
   console and the marketing menu have no inline mode, so they keep using the
   drawer controller unchanged.
   ========================================================================== */

const DESKTOP_QUERY = "(min-width: 1024px)";
const STORAGE_KEY = "shinzora:sidebar";

const readMode = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "rail" ? "rail" : "expanded";
  } catch {
    /* Storage can be blocked (private mode, sandboxed frame). The default is
       expanded, which is the usable state — never a rail nobody asked for. */
    return "expanded";
  }
};

const writeMode = (mode) => {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* a preference that cannot be saved is still a preference for this page */
  }
};

/**
 * @param {object} options
 * @param {HTMLElement}  options.panel      the <aside> that holds the navigation
 * @param {HTMLElement} [options.scrim]     backdrop used below 1024px only
 * @param {string}      [options.toggles]   selector for the hamburger button(s)
 * @param {Function}    [options.onChange]  called after every state change
 */
export function createSidebar(options = {}) {
  const { panel, scrim = null, toggles = "[data-sidebar-toggle]", onChange = null } = options;
  if (!panel) return null;

  const root = document.documentElement;
  const body = document.body;

  const mq =
    typeof matchMedia === "function"
      ? matchMedia(DESKTOP_QUERY)
      : { matches: true, addEventListener() {}, removeEventListener() {} };

  /* No matchMedia means a test harness, not a phone: behave like a desktop. */
  const isDesktop = () => mq.matches !== false;

  let mode = readMode();
  let overlayOpen = false;

  const toggleButtons = () =>
    (typeof toggles === "string" ? Array.from(document.querySelectorAll(toggles)) : toggles || []).filter(Boolean);

  /* --------------------------------------------------------------- painting */
  function apply() {
    const desktop = isDesktop();
    /* The stylesheet keys off this attribute rather than a class on <body>, so
       the pre-paint script in <head> can set it before the first frame and a
       remembered rail never flashes a full-width sidebar. */
    root.setAttribute("data-sidebar", mode);

    const drawerOpen = !desktop && overlayOpen;
    body.classList.toggle("sidebar-open", drawerOpen);
    if (scrim) scrim.classList.toggle("is-visible", drawerOpen);

    toggleButtons().forEach((button) => {
      button.setAttribute("aria-expanded", String(desktop ? mode === "expanded" : overlayOpen));
      button.setAttribute("aria-label", desktop ? (mode === "expanded" ? "Collapse navigation" : "Expand navigation") : "Open navigation");
    });

    /* Only the drawer is hidden from assistive tech. The column is always in
       the document — hiding it on a desktop would take the whole navigation
       away from a screen reader. */
    if (desktop && mode === "expanded") hideTip();

    if (desktop || overlayOpen) {
      panel.removeAttribute("aria-hidden");
      panel.removeAttribute("inert");
    } else {
      panel.setAttribute("aria-hidden", "true");
      panel.setAttribute("inert", "");
    }

    onChange?.({ mode, desktop, overlayOpen: drawerOpen });
  }

  function setMode(next) {
    mode = next === "rail" ? "rail" : "expanded";
    writeMode(mode);
    apply();
  }

  function setOverlay(next) {
    overlayOpen = Boolean(next);
    apply();
    if (overlayOpen) {
      /* Land on the link for the page you are on, so a keyboard user starts
         inside what they just opened. Deferred a frame: the drawer is still
         transitioning and cannot take focus on the same tick. */
      const focusInside = () => {
        const target = panel.querySelector(".sidebar-link.is-active") || panel.querySelector("a[href], button");
        target?.focus?.({ preventScroll: true });
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusInside);
      else focusInside();
    }
  }

  /* ------------------------------------------------------------------- API */
  const expand = () => (isDesktop() ? setMode("expanded") : setOverlay(true));
  const collapse = () => (isDesktop() ? setMode("rail") : setOverlay(false));
  const toggle = () => (isDesktop() ? setMode(mode === "expanded" ? "rail" : "expanded") : setOverlay(!overlayOpen));

  const isExpanded = () => (isDesktop() ? mode === "expanded" : overlayOpen);
  const isOverlayOpen = () => !isDesktop() && overlayOpen;

  /* ------------------------------------------------------------- tooltips */
  /*
   * In the rail the labels are hidden, so each icon explains itself on hover and
   * on keyboard focus. The bubble is a single element fixed to the viewport
   * rather than a pseudo-element on the link: the navigation lives inside a
   * scrolling region, and `overflow-y: auto` clips both axes — a CSS tooltip
   * would be cut in half at the edge of the rail.
   */
  let tip = null;
  function tooltip() {
    if (tip || typeof document.createElement !== "function") return tip;
    tip = document.createElement("div");
    tip.className = "rail-tip";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
    return tip;
  }

  function showTip(node) {
    const label = node.getAttribute("data-label");
    if (!label || isDesktop() === false || mode !== "rail") return;
    const bubble = tooltip();
    if (!bubble) return;
    bubble.textContent = label;
    const rect = node.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) return; /* no layout yet */
    bubble.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    bubble.style.left = `${Math.round(rect.right + 12)}px`;
    bubble.classList.add("is-visible");
  }

  function hideTip() {
    tip?.classList.remove("is-visible");
  }

  panel.addEventListener("mouseover", (event) => {
    const node = event.target.closest?.("[data-label]");
    if (node) showTip(node);
  });
  panel.addEventListener("mouseleave", hideTip);
  panel.addEventListener("focusin", (event) => {
    const node = event.target.closest?.("[data-label]");
    if (node) showTip(node);
  });
  panel.addEventListener("focusout", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });

  /* ------------------------------------------------------------- bindings */
  toggleButtons().forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      toggle();
    })
  );

  if (scrim) scrim.addEventListener("click", () => setOverlay(false));

  panel.querySelectorAll("[data-sidebar-close]").forEach((button) =>
    button.addEventListener("click", () => setOverlay(false))
  );

  /* Below 1024px the panel covers the content, so picking a destination must
     put it away again. On a desktop the click is just a navigation. */
  panel.addEventListener("click", (event) => {
    if (!isDesktop() && event.target.closest?.("a[href]")) setOverlay(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !isDesktop() && overlayOpen) {
      event.preventDefault();
      setOverlay(false);
    }
  });

  /* A view change also closes the mobile drawer: arriving somewhere new behind
     an overlay would hide the page the user just asked for. */
  window.addEventListener("shinzora:view", () => {
    if (!isDesktop() && overlayOpen) setOverlay(false);
  });

  /* Crossing the breakpoint must not leave the other mode's state behind: an
     overlay left "open" would keep the scrim over a desktop layout. */
  const onBreakpoint = () => {
    if (isDesktop()) overlayOpen = false;
    apply();
  };
  mq.addEventListener?.("change", onBreakpoint);

  apply();

  return { toggle, expand, collapse, isExpanded, isOverlayOpen, close: () => setOverlay(false), refresh: apply };
}
