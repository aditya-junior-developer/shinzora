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

/** AI pitch-deck draft cost in credits. Mirrors DECK_AI_CREDITS in deck/index.ts. */
export const DECK_AI_CREDITS = 5;

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

/* How a deck starts. `creatable` decides what the builder offers today:
   - ai      an AI draft from the parts of the business the owner ticks (5 credits)
   - expert  "Written by Experts": the request goes to the Shinzora team, who
             deliver the finished file to the member's registered email. No price
             is shown: a quote follows the team's review of the brief.
   - manual  decks written by the owner before experts were offered. Still open,
             edited and exported; no longer offered for new decks. */
export const DECK_MODES = {
  ai: {
    id: "ai",
    label: "AI draft",
    price: `${DECK_AI_CREDITS} credits`,
    desc: "The AI drafts slides from the parts of your business you choose. You review and edit before anything is shared.",
    creatable: true
  },
  expert: {
    id: "expert",
    label: "Written by Experts",
    price: "Quote after review",
    desc: "A specialist writes the complete deck from your brief. Our team delivers the finished file to your registered email, and you can follow its status below.",
    creatable: true
  },
  manual: {
    id: "manual",
    label: "Written by you",
    price: `Rs ${DECK_PDF_RUPEES} PDF export`,
    desc: "Decks you wrote slide by slide. Exporting the PDF costs Rs 20 per export, paid once.",
    creatable: false
  }
};

export const EXPERT_REQUEST_TYPE = "investor_deck_expert";
export const EXPERT_BRIEF_MIN = 10;
export const EXPERT_BRIEF_MAX = 600;
export const EXPERT_CONFIRMATION =
  "Thank you. Our team has your request for a written investor deck. The finished file will be sent to your registered email. You can follow its status on this page.";

export const SHARE_NOTE =
  "Only the slides you choose to share are visible to the investor. They never see your live data, your other decks, or your account.";
