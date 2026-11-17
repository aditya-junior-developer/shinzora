/* ==========================================================================
   Theme presets — whole-dashboard looks (pure data, no browser APIs)
   --------------------------------------------------------------------------
   Each preset re-colours the same layout: surfaces, brand accent, text and
   gradients. None of them is a wallpaper. The layouts, spacing and components
   stay identical, so every screen keeps working in every look.

   Violet is the Shinzora default and needs no overrides: tokens.css already
   defines it. The other three follow the dashboard references the team shared
   (warm cocoa, ember orange, and plum dusk).

   `theme` on the profile holds the id. An unknown or retired value (the six old
   palette names) resolves to Violet, so nothing reads a stale palette.
   ========================================================================== */

export const DEFAULT_PRESET = "violet";

/* Token values per preset. Keys are the CSS custom properties in tokens.css
   without the leading `--`. Only the keys that change are listed. */
export const PRESETS = Object.freeze([
  {
    id: "violet",
    name: "Violet",
    blurb: "Shinzora's purple-and-black default.",
    swatches: ["#08070e", "#151221", "#7c3aed", "#c9b8f5"],
    tokens: {}
  },
  {
    id: "cocoa",
    name: "Cocoa",
    blurb: "Warm dark brown with copper highlights.",
    swatches: ["#1a120d", "#2f2219", "#c07a45", "#f3dcc6"],
    tokens: {
      void: "#120c08",
      base: "#1a120d",
      "base-elev": "#1f160f",
      panel: "#261b14",
      "panel-2": "#2f2219",
      "panel-3": "#382920",
      "ink-glass": "rgba(38, 27, 20, 0.62)",
      "ink-glass-strong": "rgba(26, 18, 13, 0.86)",
      "grad-panel": "linear-gradient(168deg, rgba(47, 34, 25, 0.9) 0%, rgba(26, 18, 13, 0.92) 58%, rgba(20, 14, 10, 0.96) 100%)",
      "purple-900": "#3d2516",
      "purple-800": "#5a3620",
      "purple-700": "#7a4b2c",
      "purple-600": "#9a5f36",
      "purple-500": "#c07a45",
      "purple-400": "#d9955c",
      violet: "#e0a06a",
      "violet-soft": "#f0c196",
      lavender: "#f3dcc6",
      "lavender-dim": "#c9a88a",
      white: "#fff8f2",
      text: "#f3e9e0",
      "text-2": "#c9b5a6",
      "text-3": "#a8968a",
      "text-4": "#a18f83",
      "grad-brand": "linear-gradient(135deg, #d9955c 0%, #b8703f 34%, #7a4b2c 72%, #4a2c19 100%)",
      "grad-brand-soft": "linear-gradient(135deg, rgba(217, 149, 92, 0.22), rgba(122, 75, 44, 0.14))",
      "grad-text": "linear-gradient(102deg, #ffffff 12%, #f5e2cf 46%, #e0a06a 88%)",
      "grad-line": "linear-gradient(90deg, transparent, rgba(217, 149, 92, 0.55), transparent)",
      "glow-violet": "radial-gradient(60% 60% at 50% 0%, rgba(192, 122, 69, 0.38), transparent 72%)",
      "glow-soft": "radial-gradient(50% 50% at 50% 50%, rgba(217, 149, 92, 0.14), transparent 70%)",
      "line-violet": "rgba(217, 149, 92, 0.26)",
      "line-violet-soft": "rgba(217, 149, 92, 0.14)",
      "shadow-violet": "0 24px 64px -28px rgba(192, 122, 69, 0.5)"
    },
    accentRgb: "192, 122, 69",
    violetRgb: "217, 149, 92"
  },
  {
    id: "ember",
    name: "Ember",
    blurb: "Near-black with an orange dusk glow.",
    swatches: ["#14100c", "#241d18", "#f0662b", "#ffd9bf"],
    tokens: {
      void: "#0d0907",
      base: "#14100c",
      "base-elev": "#171210",
      panel: "#1d1713",
      "panel-2": "#241d18",
      "panel-3": "#2c241e",
      "ink-glass": "rgba(29, 23, 19, 0.62)",
      "ink-glass-strong": "rgba(20, 16, 12, 0.86)",
      "grad-panel": "linear-gradient(168deg, rgba(36, 29, 24, 0.9) 0%, rgba(20, 16, 12, 0.92) 58%, rgba(15, 12, 9, 0.96) 100%)",
      "purple-900": "#3a180a",
      "purple-800": "#5e2611",
      "purple-700": "#8f3a16",
      "purple-600": "#c24f1c",
      "purple-500": "#f0662b",
      "purple-400": "#ff8a4c",
      violet: "#ff9d5c",
      "violet-soft": "#ffb98a",
      lavender: "#ffd9bf",
      "lavender-dim": "#c99a7c",
      white: "#fff9f4",
      text: "#f6ece4",
      "text-2": "#cbb8a9",
      "text-3": "#ab9a8b",
      "text-4": "#a29080",
      "grad-brand": "linear-gradient(135deg, #ff9a55 0%, #f0662b 40%, #b8441a 74%, #5e2611 100%)",
      "grad-brand-soft": "linear-gradient(135deg, rgba(255, 122, 46, 0.22), rgba(143, 58, 22, 0.14))",
      "grad-text": "linear-gradient(102deg, #ffffff 12%, #ffe6d2 46%, #ff9d5c 88%)",
      "grad-line": "linear-gradient(90deg, transparent, rgba(255, 122, 46, 0.55), transparent)",
      "glow-violet": "radial-gradient(60% 60% at 50% 0%, rgba(240, 102, 43, 0.4), transparent 72%)",
      "glow-soft": "radial-gradient(50% 50% at 50% 50%, rgba(255, 122, 46, 0.15), transparent 70%)",
      "line-violet": "rgba(255, 122, 46, 0.26)",
      "line-violet-soft": "rgba(255, 122, 46, 0.14)",
      "shadow-violet": "0 24px 64px -28px rgba(240, 102, 43, 0.5)"
    },
    accentRgb: "240, 102, 43",
    violetRgb: "255, 157, 92"
  },
  {
    id: "plum",
    name: "Plum",
    blurb: "Deep plum with a soft lilac highlight.",
    swatches: ["#0f0b10", "#201721", "#a85fc0", "#efd6f7"],
    tokens: {
      void: "#09070b",
      base: "#0f0b10",
      "base-elev": "#130e15",
      panel: "#181119",
      "panel-2": "#201721",
      "panel-3": "#291e2b",
      "ink-glass": "rgba(32, 23, 33, 0.62)",
      "ink-glass-strong": "rgba(19, 14, 21, 0.86)",
      "grad-panel": "linear-gradient(168deg, rgba(41, 30, 43, 0.9) 0%, rgba(20, 14, 22, 0.92) 58%, rgba(15, 11, 17, 0.96) 100%)",
      "purple-900": "#3a1d44",
      "purple-800": "#53285f",
      "purple-700": "#6f3a80",
      "purple-600": "#8e4fa6",
      "purple-500": "#a85fc0",
      "purple-400": "#c07fd6",
      violet: "#d08ae0",
      "violet-soft": "#e6b3f0",
      lavender: "#efd6f7",
      "lavender-dim": "#b99fc4",
      white: "#fdf9ff",
      text: "#f1e8f4",
      "text-2": "#c3b2cb",
      "text-3": "#a291aa",
      "text-4": "#9a88a2",
      "grad-brand": "linear-gradient(135deg, #e7a3d8 0%, #a85fc0 40%, #6f3a80 74%, #3a1d44 100%)",
      "grad-brand-soft": "linear-gradient(135deg, rgba(192, 127, 214, 0.22), rgba(111, 58, 128, 0.14))",
      "grad-text": "linear-gradient(102deg, #ffffff 12%, #f3e0fb 46%, #d08ae0 88%)",
      "grad-line": "linear-gradient(90deg, transparent, rgba(192, 127, 214, 0.55), transparent)",
      "glow-violet": "radial-gradient(60% 60% at 50% 0%, rgba(168, 95, 192, 0.4), transparent 72%)",
      "glow-soft": "radial-gradient(50% 50% at 50% 50%, rgba(192, 127, 214, 0.15), transparent 70%)",
      "line-violet": "rgba(192, 127, 214, 0.26)",
      "line-violet-soft": "rgba(192, 127, 214, 0.14)",
      "shadow-violet": "0 24px 64px -28px rgba(168, 95, 192, 0.5)"
    },
    accentRgb: "168, 95, 192",
    violetRgb: "192, 127, 214"
  }
]);

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

/** The preset for an id, or Violet for anything unknown, empty or retired. */
export function presetById(id) {
  return BY_ID.get(String(id ?? "")) ?? BY_ID.get(DEFAULT_PRESET);
}

/** The stored id if it is a live preset, otherwise the default. */
export function normalizePreset(id) {
  return BY_ID.has(String(id ?? "")) ? String(id) : DEFAULT_PRESET;
}
