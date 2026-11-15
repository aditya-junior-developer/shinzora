/* ==========================================================================
   Investor decks and the investor role — shared constants (P9)
   The database and the Edge Function enforce every limit here. This file only
   tells the browser what to show. tests/investor-config.test.mjs fails if the
   price or the section list drifts from the server.
   ========================================================================== */

/** The owner's choice of which parts of their business a deck may use. */
export const DECK_SECTIONS = [
  {
    id: "business",
    label: "Business profile",
    desc: "Name, category, location, stage, description, audience and goals."
  },
  {
    id: "inventory",
    label: "Inventory summary",
    desc: "How many products you have, units in stock, and how many are on your website."
  },
  {
    id: "sales",
    label: "Sales, last 30 days",
    desc: "Orders placed and revenue in the last 30 days, by currency."
  }
];

export const DECK_SECTION_IDS = DECK_SECTIONS.map((section) => section.id);

/** A manual deck's PDF export. Mirrors DECK_PDF_PRICE in payments/index.ts. */
export const DECK_PDF_RUPEES = 20;

/** Matches the database check and the PDF writer. */
export const DECK_MAX_SLIDES = 12;
export const DECK_MIN_READY_SLIDES = 3;
export const DECK_MAX_BULLETS = 6;
export const DECK_MAX_BULLET_CHARS = 220;

/** The views an investor may open. Everything else is refused in the router. */
export const INVESTOR_VIEWS = ["investor", "notifications", "settings"];

/** Views only a business owner may open. */
export const OWNER_ONLY_VIEWS = ["investor-decks"];

export const DECK_MODES = {
  ai: { id: "ai", label: "AI draft", price: "Free", desc: "The AI drafts slides from the parts of your business you choose. You review and edit before anything is shared." },
  manual: { id: "manual", label: "Write it yourself", price: `Rs ${DECK_PDF_RUPEES} PDF`, desc: "You write every slide. Exporting the PDF costs Rs 20 per export, paid once." }
};

export const SHARE_NOTE =
  "Only the slides you choose to share are visible to the investor. They never see your live data, your other decks, or your account.";
