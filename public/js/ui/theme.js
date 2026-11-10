/* ==========================================================================
   Shinzora — theme
   --------------------------------------------------------------------------
   Three themes, one preference, stored twice on purpose:

     localStorage  applied by the inline pre-paint script, so no page ever
                   flashes the wrong colours while the profile loads
     profiles.theme  carried across devices, read once at boot

   The stylesheet does the work; this module only decides which value is
   current and keeps the two stores in step.
   ========================================================================== */

import { sb, normalizeError } from "../lib/supabase.js";

export const THEMES = [
  {
    id: "midnight",
    name: "Midnight",
    note: "The original. Black-purple, low glow, built for long sessions in a dark room.",
    swatch: ["#08070e", "#191329", "#7c3aed", "#c9b8f5"]
  },
  {
    id: "blossom",
    name: "Blossom",
    note: "White page, purple type, pink in the rules and washes. Bright and clean, for daylight.",
    swatch: ["#fdfbff", "#f4ecfd", "#7c3aed", "#db2777"]
  },
  {
    id: "daylight",
    name: "Daylight",
    note: "Warm paper, ink text, soft rose wash. No pure white and no glare, for tired eyes.",
    swatch: ["#fbf7f4", "#f1e9e4", "#7c3aed", "#be185d"]
  }
];

/* Two of the three are light. The stylesheet draws its shared corrections from
   `data-tone`, so a fourth light theme would be a palette and a line here rather
   than another fifty selectors. */
const TONE = { midnight: "dark", blossom: "light", daylight: "light" };

const KEY = "shinzora:theme";
const VALID = new Set(THEMES.map((theme) => theme.id));
const META_COLOR = { midnight: "#08070e", blossom: "#fdfbff", daylight: "#fbf7f4" };

export const isTheme = (value) => VALID.has(String(value || ""));

/** The tone the stylesheet corrects against: "light" or "dark". */
export const currentTone = () => TONE[currentTheme()] || "dark";

/** The theme in force right now, from the document itself. */
export function currentTheme() {
  const set = document.documentElement.getAttribute("data-theme");
  return isTheme(set) ? set : "midnight";
}

/** Store on this device and repaint. Called on click, before any network. */
export function applyTheme(id) {
  const theme = isTheme(id) ? id : "midnight";
  if (theme === "midnight") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-tone", TONE[theme] || "dark");

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Private mode: the theme still applies for this page. */
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLOR[theme]);
  return theme;
}

/**
 * Save to the profile so the next device starts in the chosen theme. A failure
 * here is not worth interrupting anybody over — the local preference already
 * works, so the error is returned rather than thrown.
 */
export async function saveThemeToProfile(id) {
  if (!sb) return { error: "offline" };
  const theme = isTheme(id) ? id : "midnight";
  const { data: session } = await sb.auth.getSession();
  const userId = session?.session?.user?.id;
  if (!userId) return { error: "signed_out" };
  const { error } = await sb.from("profiles").update({ theme }).eq("id", userId);
  return error ? { error: normalizeError(error) } : { ok: true };
}

/** At boot: adopt the profile's theme when this device has never chosen one. */
export function adoptProfileTheme(profileTheme) {
  if (!isTheme(profileTheme)) return currentTheme();
  let local = null;
  try {
    local = localStorage.getItem(KEY);
  } catch {
    local = null;
  }
  if (isTheme(local)) return local;
  return applyTheme(profileTheme);
}

/** The picker markup. Two cards, each a real preview of its own palette. */
export function themePicker(current = currentTheme()) {
  return `<div class="theme-choices" role="group" aria-label="Theme">
    ${THEMES.map(
      (theme) => `<button type="button" class="theme-choice" data-theme-choice="${theme.id}" aria-pressed="${
        current === theme.id
      }">
        <span class="theme-choice-swatch" aria-hidden="true">
          ${theme.swatch.map((colour) => `<span style="background:${colour}"></span>`).join("")}
        </span>
        <span class="theme-choice-name">${theme.name}</span>
        <span class="theme-choice-note">${theme.note}</span>
      </button>`
    ).join("")}
  </div>`;
}
