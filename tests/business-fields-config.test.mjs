/* ==========================================================================
   Business profile fields (brief item 8) — config and server agreement
   --------------------------------------------------------------------------
     - the Settings checklist, the payments function and migration 0065 list
       the same eight fields, in the same keys
     - ₹10 per field: the Settings constant is 10, the server's paise value is 1000
     - the payments function never reads an amount from the request body
     - only ticked fields that are not already active are charged
   ========================================================================== */

import { readFileSync } from "node:fs";
import { BUSINESS_FIELDS, BUSINESS_FIELD_RUPEES, BUSINESS_FIELD_MAX, chargeableKeys, fieldsTotalRupees } from "../public/js/config/business-fields.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const payments = readFileSync(new URL("../supabase/functions/payments/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/0065_business_field_purchases.sql", import.meta.url), "utf8");

const uiKeys = BUSINESS_FIELDS.map((field) => field.key);

console.log("business profile fields");

const serverKeys = payments.match(/const BUSINESS_FIELD_KEYS = (\[[^\]]*\])/)?.[1];
check("the payments function lists the eight fields", serverKeys !== undefined);
const serverList = serverKeys ? JSON.parse(serverKeys) : [];
check("server and Settings list the same keys, in order", JSON.stringify(serverList) === JSON.stringify(uiKeys), `${serverList} vs ${uiKeys}`);

const migrationKeys = [...migration.matchAll(/\('([a-z_]+)', '[^']*', \d+\)/g)].map((m) => m[1]);
check("the migration catalogue lists the same keys", JSON.stringify(migrationKeys) === JSON.stringify(uiKeys), migrationKeys.join(","));
const checkList = migration.match(/ai_fields <@ array\[([^\]]*)\]/)?.[1] ?? "";
const checkKeys = [...checkList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check("the column check lists the same keys", JSON.stringify(checkKeys) === JSON.stringify(uiKeys));

const paise = Number(payments.match(/const BUSINESS_FIELD_PAISE = (\d+)/)?.[1]);
check("₹10 per field: the server value is 1000 paise and the screen says ₹10", paise === BUSINESS_FIELD_RUPEES * 100 && BUSINESS_FIELD_RUPEES === 10, `paise ${paise}`);
check("the cap is eight fields on both sides", BUSINESS_FIELD_MAX === 8 && /length > BUSINESS_FIELD_KEYS\.length/.test(payments));

check("the server never reads an amount from the request body",
  !/body\.amount|body\.price|body\.total/.test(payments));
check("the server recomputes the field amount from the ticked list",
  /amount:\s*fields\.length \* BUSINESS_FIELD_PAISE/.test(payments));

check("the total is ticked count × ₹10", fieldsTotalRupees(["name", "email", "phone"]) === 30);
check("zero ticked fields costs nothing", fieldsTotalRupees([]) === 0);
check("an already active field is not charged again",
  JSON.stringify(chargeableKeys(["name", "email"], ["name"])) === JSON.stringify(["email"]));
check("the charge only covers ticked fields",
  JSON.stringify(chargeableKeys(["phone"], ["name"])) === JSON.stringify(["phone"]));
check("an unknown key is never charged", chargeableKeys(["favourite_colour"]).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
