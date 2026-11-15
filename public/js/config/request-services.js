/* ==========================================================================
   Request Services (P7) — the categories, statuses and rules, in one place
   --------------------------------------------------------------------------
   A request is not a purchase. A customer asks for a category, gives a budget
   in INR, and a specialist confirms scope and price with them. Nothing here
   takes payment, and no category is described as ready to buy.

   The database (0055) enforces the same rules: the category list, the five
   statuses, a positive budget up to ₹10 crore, and a description of at least
   10 characters for "Others". tests/request-services.test.mjs fails if these
   lists drift from the migration.
   ========================================================================== */

export const REQUEST_CATEGORIES = Object.freeze([
  { id: "business_cards", label: "Business Cards", icon: "id-card", summary: "Card design and print coordination." },
  { id: "meta_ads", label: "Meta Ads", icon: "megaphone", summary: "Facebook and Instagram ad campaigns." },
  { id: "video_maker", label: "Video Maker", icon: "video", summary: "Short videos for your business." },
  { id: "post_maker", label: "Post Maker", icon: "image", summary: "Social posts and graphics." },
  { id: "nfc_cards", label: "NFC Cards", icon: "scan-line", summary: "Tap-to-share contact cards." },
  { id: "custom_packaging", label: "Customized Packaging", icon: "package", summary: "Branded packaging for your products." },
  { id: "export_international", label: "Export to Other Countries", icon: "globe", summary: "Help shipping and selling abroad." },
  { id: "business_audits", label: "Business Audits", icon: "chart-column", summary: "A review of how your business runs." },
  { id: "ai_calling", label: "AI Calling Function", icon: "phone-call", summary: "Automated calls for enquiries and follow-up." },
  {
    id: "others",
    label: "Others",
    icon: "wand-sparkles",
    summary: "Describe any custom service you need.",
    needsDescription: true
  }
]);

/* The five statuses a request moves through. Order is the track order. */
export const REQUEST_STATUSES = Object.freeze([
  { id: "submitted", label: "Submitted", tone: "info", step: 0 },
  { id: "under_review", label: "Under Review", tone: "warn", step: 1 },
  { id: "in_progress", label: "In Progress", tone: "violet", step: 2 },
  { id: "completed", label: "Completed", tone: "ok", step: 3 },
  { id: "rejected", label: "Rejected", tone: "danger", step: 3 }
]);

export const RESPOND_WITHIN_HOURS = 24;

/* Shown only after the database has accepted the request. Exact wording. */
export const CONFIRMATION_MESSAGE =
  "Thank you for submitting your request! Our team or a dedicated specialist will connect with you within 24 hours to discuss your requirements and budget.";

export const BUDGET_MAX_INR = 100000000;
export const OTHERS_MIN_CHARS = 10;
export const OTHERS_MAX_CHARS = 2000;

export const categoryById = (id) => REQUEST_CATEGORIES.find((c) => c.id === id) || null;
export const statusById = (id) => REQUEST_STATUSES.find((s) => s.id === id) || null;

/**
 * Reads a budget typed by a customer. Accepts "2500", "2,500", "2500.50".
 * Returns the number, or null when it is not a positive amount with at most
 * two decimal places and within the ceiling.
 */
export function parseBudget(raw) {
  const text = String(raw ?? "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > BUDGET_MAX_INR) return null;
  return value;
}

/**
 * Checks what the customer typed before it is sent. The database checks the
 * same rules again; this only keeps the message next to the field it belongs to.
 * Returns { ok, errors, value }.
 */
export function validateRequest({ category, budget, description } = {}) {
  const errors = {};
  const picked = categoryById(category);
  if (!picked) errors.category = "Choose one service.";

  const amount = parseBudget(budget);
  if (amount === null) errors.budget = "Enter your expected budget in rupees, for example 5000.";

  const text = String(description ?? "").trim();
  if (picked?.needsDescription) {
    if (text.length < OTHERS_MIN_CHARS) {
      errors.description = `Describe what you need in at least ${OTHERS_MIN_CHARS} characters.`;
    } else if (text.length > OTHERS_MAX_CHARS) {
      errors.description = `Keep the description to ${OTHERS_MAX_CHARS} characters.`;
    }
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? {
          service_type: picked.id,
          budget_inr: amount,
          custom_description: picked.needsDescription ? text : null
        }
      : null
  };
}
