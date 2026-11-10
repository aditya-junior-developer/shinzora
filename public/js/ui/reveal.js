/* ==========================================================================
   Shinzora — motion helpers
   Scroll reveals, counters, mobile navigation and small interactions shared by
   the marketing pages. Respects prefers-reduced-motion.
   ========================================================================== */

import { createDrawer } from "./drawer.js";

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reveal [data-reveal] elements as they enter the viewport. */
export function initReveal(root = document) {
  const targets = Array.from(root.querySelectorAll("[data-reveal]"));
  if (!targets.length) return;

  document.documentElement.classList.add("motion-ready");
  // Safety net: never leave content invisible if the observer misfires.
  setTimeout(() => targets.forEach((node) => node.classList.add("is-visible")), 4000);

  if (reduced() || !("IntersectionObserver" in window)) {
    targets.forEach((node) => node.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const delay = Number(entry.target.getAttribute("data-reveal-delay") || 0);
        entry.target.style.setProperty("--reveal-delay", `${delay}ms`);
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );

  targets.forEach((node) => observer.observe(node));
}

/** Animate [data-count="120"] numeric counters once visible. */
export function initCounters(root = document) {
  const nodes = Array.from(root.querySelectorAll("[data-count]"));
  if (!nodes.length) return;
  if (reduced() || !("IntersectionObserver" in window)) {
    nodes.forEach((node) => {
      node.textContent = node.getAttribute("data-count");
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const node = entry.target;
        const target = Number(node.getAttribute("data-count") || 0);
        const suffix = node.closest("[data-count-wrap]")?.querySelector("[data-count-suffix]") || null;
        const duration = 1100;
        const start = performance.now();
        const step = (now) => {
          const progress = Math.min(1, (now - start) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          node.textContent = new Intl.NumberFormat("en-IN").format(Math.round(target * eased));
          if (progress < 1) requestAnimationFrame(step);
          else {
            node.textContent = new Intl.NumberFormat("en-IN").format(target);
            if (suffix) suffix.style.opacity = "1";
          }
        };
        requestAnimationFrame(step);
        observer.unobserve(node);
      });
    },
    { threshold: 0.5 }
  );
  nodes.forEach((node) => observer.observe(node));
}

/** Sticky nav state + mobile drawer for the marketing header. */
export function initMarketingNav() {
  const nav = document.querySelector(".site-nav");
  if (!nav) return;

  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* Same drawer as the dashboard and the admin console. The marketing menu is
     full-bleed rather than a side panel, so it gets no scrim, but the behaviour
     — modal, body-locked, closed on Escape, on its own close button and on any
     link it contains — is identical. */
  createDrawer({
    panel: document.querySelector("[data-mobile-menu]"),
    toggles: "[data-nav-toggle]",
    activeSelector: "[data-nav-close], a[href]"
  });
}

/** Animated typing effect for the hero prompt example. */
export function initTyping() {
  const node = document.querySelector("[data-typing]");
  if (!node) return;
  const phrases = JSON.parse(node.getAttribute("data-typing") || "[]");
  if (!phrases.length) return;
  if (reduced()) {
    node.textContent = phrases[0];
    return;
  }
  let phrase = 0;
  let char = 0;
  let deleting = false;
  let timer = null;
  /* The loop used to schedule another timeout forever, whether the hero was on
     screen or the tab was hidden. On a laptop that is a 30fps timer running for
     the whole session — one of the reasons Chrome felt heavy after a while.
     It now runs only while the element is actually visible and the document is
     visible, and stops entirely when the hero scrolls away. */
  let onScreen = true;

  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState !== "visible" || !onScreen) return;
      tick();
    }, delay);
  };

  const tick = () => {
    const current = phrases[phrase];
    node.textContent = current.slice(0, char);
    if (!deleting && char < current.length) {
      char += 1;
      schedule(26 + Math.random() * 34);
    } else if (!deleting && char === current.length) {
      deleting = true;
      schedule(1900);
    } else if (deleting && char > 0) {
      char -= 1;
      schedule(12);
    } else {
      deleting = false;
      phrase = (phrase + 1) % phrases.length;
      schedule(260);
    }
  };

  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen) schedule(0);
      else clearTimeout(timer);
    }).observe(node);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && onScreen) schedule(0);
    else clearTimeout(timer);
  });

  tick();
}

/**
 * Accordion behaviour for the FAQ (one open at a time, keyboard friendly).
 *
 * The open/closed state belongs to the <button>. Putting `aria-expanded` on the
 * wrapping <div> announced nothing — a plain div has no supported ARIA state —
 * so the state now lives on the trigger, the panel carries the id the trigger
 * points at with `aria-controls`, and a closed panel is `hidden` instead of
 * merely collapsed to zero height (a zero-height panel was still read out by
 * screen readers and still reachable with the Tab key).
 */
export function initAccordion(root = document) {
  root.querySelectorAll("[data-accordion]").forEach((group, groupIndex) => {
    /* Wire each trigger to its panel once, so the relationship survives without
       hand-written ids in the markup. */
    group.querySelectorAll("[data-acc-item]").forEach((item, itemIndex) => {
      const trigger = item.querySelector("[data-acc-trigger]");
      const panel = item.querySelector("[data-acc-panel]");
      if (!trigger || !panel) return;
      if (!panel.id) panel.id = `faq-panel-${groupIndex + 1}-${itemIndex + 1}`;
      trigger.setAttribute("aria-controls", panel.id);
      trigger.setAttribute("aria-expanded", "false");
      if (trigger.tagName === "BUTTON" && !trigger.getAttribute("type")) trigger.type = "button";
      panel.hidden = true;
      item.classList.remove("is-open");
    });

    const setOpen = (item, open) => {
      const trigger = item.querySelector("[data-acc-trigger]");
      const panel = item.querySelector("[data-acc-panel]");
      if (!trigger || !panel) return;
      trigger.setAttribute("aria-expanded", String(open));
      item.classList.toggle("is-open", open);
      if (open) {
        panel.hidden = false;
        panel.style.maxHeight = `${panel.scrollHeight}px`;
      } else {
        panel.style.maxHeight = "0px";
        panel.hidden = true;
      }
    };

    group.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-acc-trigger]");
      if (!trigger) return;
      const item = trigger.closest("[data-acc-item]");
      const open = trigger.getAttribute("aria-expanded") === "true";
      if (!group.hasAttribute("data-accordion-multi")) {
        group.querySelectorAll("[data-acc-item]").forEach((other) => setOpen(other, false));
      }
      if (!open) setOpen(item, true);
    });
  });
}

/** Copy-to-clipboard buttons: [data-copy="text"]. */
export function initCopyButtons(root = document) {
  root.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-copy]");
    if (!trigger) return;
    const text = trigger.getAttribute("data-copy");
    try {
      await navigator.clipboard.writeText(text);
      trigger.classList.add("is-copied");
      const original = trigger.getAttribute("data-copy-label") || trigger.textContent;
      trigger.textContent = "Copied";
      setTimeout(() => {
        trigger.classList.remove("is-copied");
        trigger.textContent = original;
      }, 1400);
    } catch {
      /* clipboard blocked: silent, the value is still selectable */
    }
  });
}

/** Parallax-ish tilt for the hero product shot (pointer only). */
export function initTilt(selector = "[data-tilt]") {
  if (reduced() || window.matchMedia("(pointer: coarse)").matches) return;
  document.querySelectorAll(selector).forEach((node) => {
    const strength = Number(node.getAttribute("data-tilt")) || 6;
    /* getBoundingClientRect on every pointermove forces layout each time, fifty
       or more times a second while the pointer crosses the hero. The rect is
       read once per frame at most, and the write is deferred to the next frame. */
    let pending = null;
    let frame = 0;
    node.addEventListener("pointermove", (event) => {
      pending = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const move = pending;
        pending = null;
        if (!move) return;
        const rect = node.getBoundingClientRect();
        const x = (move.clientX - rect.left) / rect.width - 0.5;
        const y = (move.clientY - rect.top) / rect.height - 0.5;
        node.style.transform = `perspective(1200px) rotateY(${x * strength}deg) rotateX(${-y * strength}deg)`;
      });
    });
  });
}

/* Pointer leaving the element returns it to rest. Kept separate from the
   throttled move handler above so the reset is not delayed by a pending frame. */
export function initTiltReset(selector = "[data-tilt]") {
  if (reduced() || window.matchMedia("(pointer: coarse)").matches) return;
  document.querySelectorAll(selector).forEach((node) => {
    node.addEventListener("pointerleave", () => {
      node.style.transform = "";
    });
  });
}
