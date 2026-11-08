/* ==========================================================================
   Shinzora — landing page entry
   Progressive enhancement only: the page is fully readable without JS, but
   motion, tabs, the pricing toggle and the contact form need these modules.
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import {
  initReveal,
  initCounters,
  initMarketingNav,
  initTyping,
  initAccordion,
  initTilt,
  initTiltReset,
  initCopyButtons
} from "../ui/reveal.js";
import { qs, qsa, delegate } from "../lib/dom.js";
import { readForm, validateForm, paintErrors, rules } from "../lib/validate.js";
import { toast, toastError } from "../ui/toast.js";
import { initInstallPrompt } from "../ui/pwa.js";
import { initInstallPanel } from "../ui/install-panel.js?v=20261108a";
import { initHeroFx } from "../ui/hero-fx.js";
import { initMotionToggle } from "../ui/motion-toggle.js";
import { sb, normalizeError } from "../lib/supabase.js";

/* ------------------------------------------------------------------ icons -- */
hydrateIcons();

/* ------------------------------------------------------------------ motion - */
initMarketingNav();
initReveal();
initHeroFx();
initMotionToggle();
initInstallPanel();
initCounters();
initTyping();
initAccordion();
initTilt("[data-tilt]");
initTiltReset("[data-tilt]");
initCopyButtons(document);

/* --------------------------------------------------------- scroll progress - */
const progress = qs(".nav-progress");
if (progress) {
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.setProperty("--scroll-progress", `${max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0}%`);
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

/* -------------------------------------------------------------- year stamp - */
qsa("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

/* ---------------------------------------------------------- billing toggle - */
const billingButtons = qsa("[data-billing]");
billingButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const period = button.getAttribute("data-billing");
    billingButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    qsa("[data-price-monthly]").forEach((node) => {
      node.textContent = period === "yearly" ? node.getAttribute("data-price-yearly") : node.getAttribute("data-price-monthly");
    });
    qsa("[data-period]").forEach((node) => {
      const original = node.textContent;
      if (period === "yearly") node.textContent = original.includes("month") ? "/year" : "per year";
      else node.textContent = original.includes("year") ? "/month" : "forever";
    });
  });
});

/* ---------------------------------------------------------------- ops tabs - */
const opsTabs = qsa("[data-ops]");
opsTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.getAttribute("data-ops");
    opsTabs.forEach((other) => other.setAttribute("aria-selected", String(other === tab)));
    qsa("[data-ops-view]").forEach((view) => {
      const active = view.getAttribute("data-ops-view") === target;
      view.classList.toggle("is-active", active);
      if (active) {
        // restart the bar-grow animation when the analytics tab is revealed
        view.querySelectorAll(".ops-bars i").forEach((bar) => {
          bar.style.animation = "none";
          void bar.offsetWidth;
          bar.style.animation = "";
        });
      }
    });
  });
});

/* ------------------------------------------------------------- contact form - */
const form = qs("#contact-form");
if (form) {
  const status = qs("#contact-status");
  const submit = qs("#contact-submit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readForm(form);

    const { valid, errors } = validateForm(values, {
      name: [rules.required, rules.min(2), rules.max(80)],
      email: [rules.required, rules.email],
      message: [rules.required, rules.min(12), rules.max(2000)],
      topic: [rules.required]
    });
    if (!values.consent) errors.consent = "Please accept the privacy terms.";
    paintErrors(form, errors);
    if (!valid || errors.consent) {
      status.innerHTML = `<div class="alert alert-danger"><span><span class="alert-title">Check the highlighted fields</span>Some details are missing or invalid.</span></div>`;
      return;
    }

    submit.setAttribute("aria-busy", "true");
    submit.disabled = true;
    status.innerHTML = "";

    try {
      if (!sb) throw new Error("Client unavailable");
      const { error } = await sb.from("contact_messages").insert({
        name: values.name,
        email: values.email,
        business_name: values.business || null,
        topic: values.topic || "general",
        message: values.message
      });
      if (error) throw normalizeError(error);

      form.reset();
      status.innerHTML = `<div class="alert alert-ok"><span><span class="alert-title">Message received</span>We have your enquiry and will reply to ${values.email}.</span></div>`;
      toast({ title: "Message sent", message: "Our team will get back to you by email." }, { tone: "success" });
    } catch (error) {
      const normalized = normalizeError(error);
      status.innerHTML = `<div class="alert alert-warn"><span><span class="alert-title">Could not submit the form</span>${
        normalized.code === "schema_missing"
          ? "Contact storage is not installed on this deployment yet. Please email us directly at"
          : "The message could not be delivered. Please email us at"
      } <a href="mailto:official.shinzora@proton.me" style="color:var(--lavender);text-decoration:underline">official.shinzora@proton.me</a>.</span></div>`;
      toastError(normalized);
    } finally {
      submit.removeAttribute("aria-busy");
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ cta tracking - */
delegate(document, "click", "[data-track]", (_event, node) => {
  // Lightweight, privacy-preserving intent signal kept in sessionStorage so the
  // signup page can pre-fill the plan the visitor chose. No third-party pixels.
  const plan = node.closest("[data-plan]")?.getAttribute("data-plan");
  if (plan) sessionStorage.setItem("shinzora.intent.plan", plan);
});

/* --------------------------------------------------------------- PWA install */
initInstallPrompt();

/* ---------------------------------------------------- smooth anchor offset - */
qsa('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const id = link.getAttribute("href");
    if (id.length < 2) return;
    const target = qs(id);
    if (!target) return;
    event.preventDefault();
    const top = target.getBoundingClientRect().top + window.scrollY - 78;
    window.scrollTo({ top, behavior: "smooth" });
    history.replaceState(null, "", id);
  });
});
