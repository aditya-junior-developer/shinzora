/* ==========================================================================
   Shinzora — platform marks
   --------------------------------------------------------------------------
   The main icon set (`lib/icons.js`) is a generated Lucide subset of stroke
   primitives, and it deliberately contains no brand logos. The download centre
   needs four, so they live here instead of editing generated data.

   These are solid silhouettes rather than stroke outlines (a windowed outline
   of the Apple mark reads as a blob at 20px), drawn on the same 24×24 grid and
   filling `currentColor` so they inherit the surrounding text colour.
   ========================================================================== */

const MARKS = {
  /* Android robot head — the shape people actually recognise at small sizes. */
  android: `<path d="M7.4 8.2 6.2 6a.45.45 0 0 1 .78-.45l1.2 2.2a7.9 7.9 0 0 1 7.64 0l1.2-2.2a.45.45 0 0 1 .78.45L16.6 8.2A8.4 8.4 0 0 1 20.4 15H3.6a8.4 8.4 0 0 1 3.8-6.8Z"/>
    <circle cx="8.9" cy="11.4" r="1.05" fill="#0b0813"/>
    <circle cx="15.1" cy="11.4" r="1.05" fill="#0b0813"/>
    <path d="M4.1 16.2h15.8v3.3a1.4 1.4 0 0 1-1.4 1.4h-1.2v1.4a1.15 1.15 0 0 1-2.3 0V21H8.9v1.3a1.15 1.15 0 0 1-2.3 0V21H5.5a1.4 1.4 0 0 1-1.4-1.4Z"/>`,

  /* Apple. */
  apple: `<path d="M16.2 12.7c0-2.2 1.8-3.3 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.8.8-3.6 2.1-1.6 2.7-.4 6.7 1.1 8.9.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.7.7 2.8.7 1.1 0 1.9-1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4-.1 0-2-.8-2-3.7Z"/>
    <path d="M14.1 6.1c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.7 1.3-.6.6-1 1.6-.9 2.6 1 .1 2-.5 2.7-1.2Z"/>`,

  /* Windows — four panes with the characteristic perspective split. */
  windows: `<path d="M3 4.6 10.6 3.6v7.7H3Z"/>
    <path d="M11.7 3.4 21 2.1v9.2h-9.3Z"/>
    <path d="M3 12.4h7.6v7.7L3 19.1Z"/>
    <path d="M11.7 12.4H21v9.2l-9.3-1.3Z"/>`,

  /* Tux, simplified: body, white belly, eyes, beak. */
  linux: `<path d="M12 2.4c-1.9 0-3.2 1.6-3.2 3.5 0 1.3.3 2.4-.4 3.8-.8 1.5-2.1 2.7-2.5 4.4-.3 1.3-.1 2.5.6 3.4.4.5 1 .8 1.7.8.5 0 .9.3 1.2.7.4.6 1.3 1.1 2.6 1.1s2.2-.5 2.6-1.1c.3-.4.7-.7 1.2-.7.7 0 1.3-.3 1.7-.8.7-.9.9-2.1.6-3.4-.4-1.7-1.7-2.9-2.5-4.4-.7-1.4-.4-2.5-.4-3.8 0-1.9-1.3-3.5-3.2-3.5Z"/>
    <ellipse cx="12" cy="16.4" rx="3.5" ry="4.1" fill="#0b0813" opacity=".55"/>
    <circle cx="10.6" cy="6.3" r=".95" fill="#0b0813"/>
    <circle cx="13.4" cy="6.3" r=".95" fill="#0b0813"/>
    <path d="M12 7.9c.9 0 1.7.5 1.7.9 0 .5-.8.9-1.7.9s-1.7-.4-1.7-.9c0-.4.8-.9 1.7-.9Z" fill="#0b0813"/>`
};

/** Solid brand mark for a platform key, sized in px. */
export function platformMark(name, size = 24) {
  const d = MARKS[name];
  if (!d) return "";
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">${d}</svg>`;
}

export const PLATFORM_MARKS = MARKS;
export default platformMark;
