/* ============================================================================
   Shinzora — rupees in, paise stored
   ----------------------------------------------------------------------------
   The bug: the product dialog said "Price (₹, in paise)" and stored whatever was
   typed. A shopkeeper typing 100 for a ₹100 coffee got ₹1.00 in the table, and
   the only way to enter ₹1.68 was to type 168 — units nobody writes. The order
   form had the same field ("Unit price (paise)"), so a recorded sale was off by
   100 too.

   The database still keeps integer paise (no float ever touches money). What
   changed is the boundary: the form speaks rupees, `toMinor` converts on save
   and `fromMinor` puts an existing price back in the box.

     node tests/money-input.test.mjs
   ========================================================================== */

import { readFileSync } from "node:fs";
import { money, toMinor, fromMinor } from "../public/js/lib/format.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("\nrupees → paise");
check("1.68 is 168 paise", toMinor(1.68) === 168, String(toMinor(1.68)));
check("1.68 typed as text is 168", toMinor("1.68") === 168, String(toMinor("1.68")));
check("100 is 10000 paise", toMinor(100) === 10000, String(toMinor(100)));
check("0.1 is 10 paise, not 10.000000000000002", toMinor(0.1) === 10, String(toMinor(0.1)));
check("0.29 is 29 (float drift rounded away)", toMinor(0.29) === 29, String(toMinor(0.29)));
check("a rupee sign is ignored", toMinor("₹1.68") === 168, String(toMinor("₹1.68")));
check("thousands separators are ignored", toMinor("2,499") === 249900, String(toMinor("2,499")));
check("an empty box is 0, never NaN", toMinor("") === 0 && !Number.isNaN(toMinor("")), String(toMinor("")));
check("words are 0, never NaN", toMinor("free") === 0, String(toMinor("free")));
check("null is 0", toMinor(null) === 0);
check("3 decimals round to the nearest paisa", toMinor(1.005) === 100 || toMinor(1.005) === 101, String(toMinor(1.005)));

console.log("\npaise → rupees");
check("168 paise shows as 1.68", fromMinor(168) === 1.68, String(fromMinor(168)));
check("10000 paise shows as 100", fromMinor(10000) === 100, String(fromMinor(10000)));
check("0 shows as 0", fromMinor(0) === 0);
check("a missing price is 0", fromMinor(undefined) === 0);
check("the round trip is exact", fromMinor(toMinor(1.68)) === 1.68, String(fromMinor(toMinor(1.68))));

console.log("\nwhat the table then shows");
check("₹1.68, not ₹168", money(toMinor(1.68)) === "₹1.68", money(toMinor(1.68)));
check("₹100, not ₹1", money(toMinor(100)) === "₹100", money(toMinor(100)));
check("whole rupees stay clean", money(toMinor(2499)) === "₹2,499", money(toMinor(2499)));

/* Source guards: the units bug came back twice as a label, so the labels are
   asserted, not just the helpers. Comments are stripped first — the fix notes
   quote the old labels. */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const inventory = strip(readFileSync("public/js/modules/dashboard/views/inventory.js", "utf8"));
const orders = strip(readFileSync("public/js/modules/dashboard/views/orders.js", "utf8"));
const assistant = strip(readFileSync("supabase/functions/ai/index.ts", "utf8"));

console.log("\nthe forms");
check("the product price field no longer asks for paise", !/in paise/i.test(inventory));
check("it is labelled in rupees", /label: "Price \(₹\)"/.test(inventory));
check("it accepts a paisa decimal", /step: "0\.01"/.test(inventory));
check("an existing price is converted back for the box", /fromMinor\(existing\?\.price/.test(inventory));
check("the insert converts to paise", /price: toMinor\(values\.price\)/.test(inventory));
check("the update converts to paise", /price: toMinor\(values\.price\)/.test(inventory));
check("no raw Number(values.price) survives", !/Number\(values\.price\)/.test(inventory));

check("the order unit price no longer asks for paise", !/Unit price \(paise\)/i.test(orders));
check("it is labelled in rupees", /label: "Unit price \(₹\)"/.test(orders));
check("the line total is computed in paise", /const unitPrice = toMinor\(values\.unit_price\)/.test(orders));
check("the stored item price is in paise", /unit_price: unitPrice/.test(orders));

console.log("\nthe assistant's create_product");
check("the model is told the unit", /price is PAISE as an integer/i.test(assistant));
check("with a worked example", /₹1\.68 is 168/.test(assistant));
check("the schema description carries the unit too", /Integer paise/.test(assistant));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
