#!/usr/bin/env node
/* ==========================================================================
   Store operations — client-side parsing and reporting
   --------------------------------------------------------------------------
   The CSV import is the one place in the product where a customer's own file
   is trusted to contain anything at all: quoted commas, doubled quotes, CRLF
   from Excel, a BOM, a missing column, a row with a price of "free". These
   tests pin the behaviour the import relies on, because a parser bug here
   writes wrong stock and wrong prices into a real catalogue.
   ========================================================================== */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { splitCsvLine, splitCsvRecords, parseCsv, csvCell, toCsv } = await import(
  path.join(ROOT, "public/js/lib/csv.js")
);

let passed = 0;
const failures = [];

function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

console.log("\n  CSV parsing\n");

test("a plain row splits on commas", () => {
  assert.deepEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("a quoted field keeps its comma", () => {
  assert.deepEqual(splitCsvLine('Tote bag,"Koramangala, Bengaluru",450'), [
    "Tote bag",
    "Koramangala, Bengaluru",
    "450"
  ]);
});

test("a doubled quote inside a quoted field is one literal quote", () => {
  assert.deepEqual(splitCsvLine('"6"" planter",120'), ['6" planter', "120"]);
});

test("a newline inside quotes does not end the record", () => {
  const { rows } = parseCsv('name,note\nTote,"line one\nline two"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "line one\nline two");
});

test("a doubled quote does not swallow the following record", () => {
  const { rows } = parseCsv('name,note\n"6"" planter",120\nTote,450');
  assert.equal(rows.length, 2, "the record after an escaped quote was lost");
  assert.equal(rows[0].name, '6" planter');
  assert.equal(rows[1].name, "Tote");
});

test("CRLF line endings are handled", () => {
  assert.deepEqual(splitCsvRecords("a,b\r\nc,d"), ["a,b", "c,d"]);
});

test("a UTF-8 BOM from Excel is not part of the first header", () => {
  const { header } = parseCsv("\uFEFFname,price\nTote,450");
  assert.deepEqual(header, ["name", "price"]);
});

test("an empty trailing line is not a row", () => {
  const { rows } = parseCsv("name,price\nTote,450\n\n");
  assert.equal(rows.length, 1);
});

test("headers are matched regardless of case and spacing", () => {
  const { rows } = parseCsv(" Name , Price ,Stock\nTote,450,12");
  assert.deepEqual(rows[0], { name: "Tote", price: "450", stock: "12" });
});

test("a short row leaves the missing column empty rather than shifting values", () => {
  const { rows } = parseCsv("name,price,stock\nTote,450");
  assert.deepEqual(rows[0], { name: "Tote", price: "450", stock: "" });
});

test("a padded row does not create extra keys", () => {
  const { rows } = parseCsv("name,price\nTote,450,ignored");
  assert.deepEqual(rows[0], { name: "Tote", price: "450" });
});

test("every value stays a string, so a SKU of 007 is not turned into 7", () => {
  const { rows } = parseCsv("name,sku,price\nTote,007,450");
  assert.equal(rows[0].sku, "007");
});

console.log("\n  CSV writing\n");

test("a cell containing a comma, quote or newline is quoted", () => {
  assert.equal(csvCell("Koramangala, Bengaluru"), '"Koramangala, Bengaluru"');
  assert.equal(csvCell('6" planter'), '"6"" planter"');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
});

test("a number is written without quotes so a spreadsheet reads it as a number", () => {
  assert.equal(csvCell(450), "450");
});

test("null and undefined become empty cells, not the word null", () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.ok(!/null|undefined/.test(csvCell(null) + csvCell(undefined)));
});

test("a written file parses back to the same rows", () => {
  const columns = ["name", "price", "note"];
  const rows = [
    ['6" planter', 120, "hand-thrown, glazed"],
    ["Tote bag", 450, "line one\nline two"]
  ];
  const text = toCsv(columns, rows);
  const { rows: back } = parseCsv(text);
  assert.equal(back.length, 2);
  assert.equal(back[0].name, '6" planter');
  assert.equal(back[0].note, "hand-thrown, glazed");
  assert.equal(back[1].note, "line one\nline two");
});

test("the header row is the column list that was asked for", () => {
  const text = toCsv(["a", "b"], [[2, 1]]);
  assert.equal(text.split("\n")[0], '"a","b"');
});

console.log("\n  Order timeline labels\n");

/* The same status words drive the dashboard sheet and the public tracking page.
   If one of them ever invents a sixth spelling the customer sees a status the
   business cannot set. */
const { readFileSync } = await import("node:fs");
const tracking = readFileSync(path.join(ROOT, "public/js/boot/track.js"), "utf8");
const ordersView = readFileSync(path.join(ROOT, "public/js/modules/dashboard/views/orders.js"), "utf8");

test("the tracking page never offers a status the database rejects", () => {
  const allowed = ["pending", "paid", "processing", "shipped", "delivered", "cancelled", "refunded", "fulfilled"];
  const labels = tracking.match(/const LABELS = \{([\s\S]*?)\};/);
  assert.ok(labels, "LABELS map is missing from the tracking page");
  const keys = [...labels[1].matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);
  assert.ok(keys.length >= 8, `expected at least 8 statuses, saw ${keys.join(", ")}`);
  keys.forEach((key) => assert.ok(allowed.includes(key), `${key} is not an order status`));
});

test("the orders sheet changes status through the RPC, not a direct column write", () => {
  assert.ok(/order_set_status/.test(ordersView), "orders.js no longer calls order_set_status");
  assert.ok(
    !/from\("store_orders"\)\s*\.update\(\{\s*status/.test(ordersView),
    "orders.js still writes store_orders.status directly, which skips the timeline and the customer notification"
  );
});

console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((failure) => console.error(`  · ${failure}`));
  process.exit(1);
}
