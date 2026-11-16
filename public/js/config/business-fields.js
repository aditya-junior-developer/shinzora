/* ==========================================================================
   Business profile fields for the AI (brief item 8)
   --------------------------------------------------------------------------
   Each ticked field costs ₹10. The total is ticked count × ₹10. The server
   (supabase/functions/payments) recomputes the amount from the ticked list and
   ignores any amount the browser sends. These values must match the server's
   BUSINESS_FIELD_KEYS and BUSINESS_FIELD_PAISE, and the catalogue in migration
   0065. tests/business-fields-config.test.mjs checks that they agree.
   ========================================================================== */

export const BUSINESS_FIELD_RUPEES = 10;
export const BUSINESS_FIELD_MAX = 8;

export const BUSINESS_FIELDS = [
  { key: "name", label: "Business name" },
  { key: "category", label: "Category" },
  { key: "location", label: "Location" },
  { key: "description", label: "What the business does" },
  { key: "target_audience", label: "Target audience" },
  { key: "website_url", label: "Website" },
  { key: "phone", label: "Business phone" },
  { key: "email", label: "Business email" }
];

/* Ticked fields that are not already granted. Only these are charged. */
export function chargeableKeys(ticked, granted = []) {
  const held = new Set(granted || []);
  return BUSINESS_FIELDS.map((field) => field.key).filter((key) => ticked.includes(key) && !held.has(key));
}

/* Total in rupees for a list of keys. */
export function fieldsTotalRupees(keys) {
  return keys.length * BUSINESS_FIELD_RUPEES;
}
