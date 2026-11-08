/* ==========================================================================
   Shinzora — setup guide page (/install-guide/)
   --------------------------------------------------------------------------
   The guide is a plain document: its content is in the HTML so it reads and
   prints with scripts disabled. This module adds only what markup cannot:

     • mounts the same purple flame aurora as the rest of the site
     • drops the official platform marks into the section headers
     • stamps the copyright year
     • tracks which section is on screen in the sticky nav
   ========================================================================== */

import "../ui/aurora.js";
import { platformMark, PLATFORM_MARKS } from "../lib/platform-icons.js?v=20261108a";
import { icon } from "../lib/icons.js";

const MARKS = {
  android: "android",
  ios: "apple",
  windows: "windows",
  macos: "apple",
  linux: "linux"
};

function mountMarks() {
  document.querySelectorAll("[data-platform-mark]").forEach((host) => {
    const name = host.getAttribute("data-platform-mark") || host.closest("[id]")?.id;
    if (name === "help") {
      host.innerHTML = icon("circle-help", { size: 22 });
      return;
    }
    const mark = MARKS[name] || (PLATFORM_MARKS[name] ? name : null);
    if (!mark) return;
    host.innerHTML = platformMark(mark, 24);
  });
}

function stampYear() {
  const year = String(new Date().getFullYear());
  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = year;
  });
}

function trackActiveSection() {
  const links = Array.from(document.querySelectorAll(".guide-jump a[href^='#']"));
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if (!sections.length || !("IntersectionObserver" in window)) return;

  const setActive = (id) => {
    links.forEach((link) => {
      const active = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    },
    { rootMargin: "-88px 0px -55% 0px", threshold: 0 }
  );

  sections.forEach((section) => observer.observe(section));
  setActive(sections[0].id);
}

mountMarks();
stampYear();
trackActiveSection();
