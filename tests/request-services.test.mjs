/* ==========================================================================
   Request Services (P7) — the browser, the database and the admin function
   must agree on the categories, the statuses, the budget and the exact
   confirmation text. Reads the migration and the Deno function as text,
   because the function cannot be imported in Node.
   ========================================================================== */

import { readFileSync } from "node:fs";
import {
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  CONFIRMATION_MESSAGE,
  OTHERS_MIN_CHARS,
  BUDGET_MAX_INR,
  parseBudget,
  validateRequest
} from "../public/js/config/request-services.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/0055_request_services.sql");
const adminFn = read("supabase/functions/admin/index.ts");
const requestsView = read("public/js/modules/dashboard/views/requests.js");
const serviceAdmin = read("public/js/modules/admin/views/service-requests.js");

const NEW_CATEGORIES = [
  "business_cards", "meta_ads", "video_maker", "post_maker", "nfc_cards",
  "custom_packaging", "export_international", "business_audits", "ai_calling", "others"
];
const LEGACY_TYPES = ["plan_upgrade", "account_deletion", "domain_registration", "website_setup", "brand_kit", "store_setup"];

/* The quoted list inside the service_type CHECK in the migration. */
const checkList = migration.match(/service_type in \(\s*([\s\S]*?)\)\);/)?.[1] || "";
const sqlTypes = [...checkList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

console.log("categories");
check("the browser lists exactly the ten categories", JSON.stringify(REQUEST_CATEGORIES.map((c) => c.id)) === JSON.stringify(NEW_CATEGORIES));
check("the database accepts every browser category", NEW_CATEGORIES.every((id) => sqlTypes.includes(id)));
check("the database keeps the legacy types that existing rows use", LEGACY_TYPES.every((id) => sqlTypes.includes(id)));
check("the database accepts no type the browser does not know", sqlTypes.every((id) => NEW_CATEGORIES.includes(id) || LEGACY_TYPES.includes(id)));
check("only 'others' asks for a description", REQUEST_CATEGORIES.filter((c) => c.needsDescription).map((c) => c.id).join() === "others");
check("the replaced five-item catalogue is gone", !/google_listing|brand_kit\b.*label/.test(requestsView) && !requestsView.includes("Something else"));

console.log("statuses");
const STATUS_IDS = ["submitted", "under_review", "in_progress", "completed", "rejected"];
check("the browser has exactly the five statuses", JSON.stringify(REQUEST_STATUSES.map((s) => s.id)) === JSON.stringify(STATUS_IDS));
const statusCheck = migration.match(/add constraint service_requests_status_check\s+check \(status in \(([^)]*)\)\)/)?.[1] || "";
check("the database CHECK has exactly the five statuses", STATUS_IDS.every((id) => statusCheck.includes(`'${id}'`)) && !/requested|approved|cancelled/.test(statusCheck));
const adminStatuses = adminFn.match(/const SERVICE_STATUSES = \[([^\]]*)\]/)?.[1] || "";
check("the admin function accepts exactly the five statuses", STATUS_IDS.every((id) => adminStatuses.includes(`"${id}"`)) && !/requested|approved|cancelled/.test(adminStatuses));
check("the admin view offers the five statuses", /REQUEST_STATUSES\.map/.test(serviceAdmin));
check("the admin function no longer writes its own notification", !/serviceRequestUpdate[\s\S]*notifications/.test(adminFn.slice(adminFn.indexOf("async function serviceRequestUpdate"), adminFn.indexOf("async function subscriptions"))));

console.log("exact confirmation");
const EXPECTED = "Thank you for submitting your request! Our team or a dedicated specialist will connect with you within 24 hours to discuss your requirements and budget.";
check("the confirmation text is exactly the agreed wording", CONFIRMATION_MESSAGE === EXPECTED);
check("the customer page shows only the imported confirmation", requestsView.includes("CONFIRMATION_MESSAGE") && !requestsView.includes("Thank you for submitting"));
const insertAt = requestsView.indexOf('.from("service_requests")');
const confirmAt = requestsView.indexOf("svc-callout is-ok");
check("the confirmation is written after the insert succeeds", insertAt > 0 && confirmAt > insertAt);

console.log("budget");
check("'2,500' is accepted as 2500", parseBudget("2,500") === 2500);
check("'2500.5' is accepted", parseBudget("2500.5") === 2500.5);
check("zero is refused", parseBudget("0") === null);
check("a negative is refused", parseBudget("-5") === null);
check("letters are refused", parseBudget("abc") === null);
check("three decimals are refused", parseBudget("1.234") === null);
check("the ceiling is 100000000 rupees", BUDGET_MAX_INR === 100000000 && parseBudget("100000001") === null);
check("the database budget ceiling matches", migration.includes("budget_inr <= 100000000"));

console.log("validation");
const noText = validateRequest({ category: "others", budget: "100", description: "short" });
check("'others' with a short description fails", !noText.ok && Boolean(noText.errors.description));
check(`'others' needs ${OTHERS_MIN_CHARS} characters, as the database does`, migration.includes("btrim(coalesce(custom_description, ''))) >= 10") && OTHERS_MIN_CHARS === 10);
const okOthers = validateRequest({ category: "others", budget: "9000", description: "Printed sleeves for 300 cups." });
check("'others' with a description and budget passes", okOthers.ok && okOthers.value.custom_description.startsWith("Printed"));
const plain = validateRequest({ category: "meta_ads", budget: "7500", description: "ignored" });
check("a standard category drops any description", plain.ok && plain.value.custom_description === null);
check("a missing category fails", !validateRequest({ category: "", budget: "100" }).ok);
check("a legacy category id is refused by the picker", !validateRequest({ category: "google_listing", budget: "100" }).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
