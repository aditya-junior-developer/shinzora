/* The AI PDF allowance: reserve before rendering, commit only after the PDF
   exists, release on any failure, and the free plan stays at two exports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("an AI deck export reserves a slot before it renders", async () => {
  const deck = await read("supabase/functions/deck/index.ts");
  const reserve = deck.indexOf('sb.rpc("ai_pdf_reserve"');
  const render = deck.indexOf("pdf = buildDeckPdf(");
  assert.ok(reserve > 0 && render > reserve, "reserve comes before the render");
});

test("the slot is committed after the PDF exists and released if it fails", async () => {
  const deck = await read("supabase/functions/deck/index.ts");
  const render = deck.indexOf("pdf = buildDeckPdf(");
  const commit = deck.indexOf('sb.rpc("ai_pdf_commit"');
  assert.ok(commit > render, "commit comes after the render");
  assert.match(deck, /if \(aiReservation\) await sb\.rpc\("ai_pdf_release"/, "a render failure releases the slot");
  assert.match(deck, /export_not_counted/, "a failed commit withholds the PDF");
});

test("a limit refusal is reported as a 402 with the allowance, not a generic error", async () => {
  const deck = await read("supabase/functions/deck/index.ts");
  assert.match(deck, /reserveError\.hint === "ai_pdf_limit_reached"/);
  assert.match(deck, /fail\(402, "ai_pdf_limit_reached"/);
});

test("the allowance is readable through the deck function", async () => {
  const deck = await read("supabase/functions/deck/index.ts");
  assert.match(deck, /case "pdf_allowance":/);
  assert.match(deck, /sb\.rpc\("ai_pdf_allowance"\)/);
});

test("the free plan allows two successful AI PDFs, and it is in the migration", async () => {
  const sql = await read("supabase/migrations/0085_ai_pdf_quota.sql");
  assert.match(sql, /values \('free', 2\)/);
  assert.match(sql, /status in \('succeeded', 'reserved'\)/, "reserved attempts count toward the limit");
  assert.match(sql, /pg_advisory_xact_lock/, "parallel exports cannot both pass the check");
});

test("manual decks keep their paid export and are not metered by the allowance", async () => {
  const deck = await read("supabase/functions/deck/index.ts");
  assert.match(deck, /if \(deck\.mode === "ai"\) \{\s*const \{ data: reserved/);
  assert.match(deck, /deck_export_take/, "manual payment path is unchanged");
});
