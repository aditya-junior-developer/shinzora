// Investor role and deck: the browser's copy of each rule must match the server.
// The server is the authority; these checks fail loudly when the two drift.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
};

const config = read("public/js/config/investor-deck.js");
const payments = read("supabase/functions/payments/index.ts");
const deckFn = read("supabase/functions/deck/index.ts");
const deckPdf = read("supabase/functions/_shared/deck-pdf.js");
const migration = read("supabase/migrations/0058_investor_role_and_decks.sql");
const router = read("public/js/modules/dashboard/router.js");
const shell = read("public/js/modules/dashboard/shell.js");
const onboarding = read("public/js/boot/onboarding.js");
const onboardingHtml = read("public/onboarding/index.html");
const ai = read("supabase/functions/ai/index.ts");
const settings = read("public/js/modules/dashboard/views/settings.js");

const num = (source, name) => {
  const m = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `${name} not found`);
  return Number(m[1]);
};

console.log("investor config");

check("deck PDF price: browser Rs 20 equals server 2000 paise", () => {
  const rupees = num(config, "DECK_PDF_RUPEES");
  const paise = Number(payments.match(/DECK_PDF_PRICE = \{ amount: (\d+)/)?.[1]);
  assert.equal(rupees, 20);
  assert.equal(paise, rupees * 100);
  assert.equal(Number(deckFn.match(/DECK_PDF_AMOUNT_PAISE = (\d+)/)?.[1]), paise);
});

check("slide and bullet limits match the PDF writer", () => {
  assert.equal(num(config, "DECK_MAX_SLIDES"), num(deckPdf, "MAX_SLIDES"));
  assert.equal(num(config, "DECK_MAX_BULLETS"), num(deckPdf, "MAX_BULLETS"));
});

check("ready needs at least three slides in the browser and the database", () => {
  assert.equal(num(config, "DECK_MIN_READY_SLIDES"), 3);
  assert.match(migration, /jsonb_array_length\(slides\) >= 3/);
});

check("the database caps slides at the same number as the browser", () => {
  assert.match(migration, new RegExp(`jsonb_array_length\\(slides\\) <= ${num(config, "DECK_MAX_SLIDES")}`));
});

check("deck data sections match the database allow-list", () => {
  for (const id of ["business", "inventory", "sales"]) {
    assert.match(config, new RegExp(`id: "${id}"`));
    assert.match(migration, new RegExp(`'${id}'`));
  }
});

check("investor views never include owner or admin surfaces", () => {
  const allowed = config.match(/INVESTOR_VIEWS = \[([^\]]+)\]/)[1];
  for (const forbidden of ["billing", "investor-decks", "overview", "assistant", "store", "inventory", "orders", "website-builder", "app-builder", "domains", "admin"]) {
    assert.ok(!allowed.includes(`"${forbidden}"`), `investor can open ${forbidden}`);
  }
  assert.ok(allowed.includes('"investor"'));
});

check("the router refuses investor-only and owner-only views", () => {
  assert.match(router, /export function allowedView\(view\)/);
  assert.match(router, /const view = allowedView\(requested\) \? requested : landingView\(\)/);
  assert.match(router, /if \(view === "investor"\) return false;/);
});

check("the investor sidebar has no billing or business items", () => {
  const block = shell.match(/export const INVESTOR_NAV = (\[[\s\S]*?\n\]);/)[1];
  assert.ok(!/billing|overview|store|inventory|assistant/.test(block));
  assert.match(block, /id: "investor"/);
});

check("the AI tools refuse investor accounts on the server", () => {
  assert.match(ai, /accountTypeOf\(caller\.user\.id\)\) === "investor"/);
});

check("payments refuse investors and non-owners buying a deck export", () => {
  assert.match(payments, /accountType === "investor"/);
  assert.match(payments, /purpose === "deck_pdf" && accountType !== "owner"/);
});

check("the deck function is owner-only and refuses to share without ready status", () => {
  assert.match(deckFn, /accountType !== "owner"/);
  assert.match(migration, /check \(status = 'draft' or jsonb_array_length\(slides\) >= 3\)/);
});

check("settings never lets an investor change role", () => {
  assert.match(settings, /profile\.account_type === "investor"/);
  assert.match(settings, /form\.account_type && form\.account_type\.value/);
});

check("onboarding offers an investor card and finishes the investor path with investor_join", () => {
  assert.match(onboardingHtml, /data-account-type="investor"/);
  assert.match(onboarding, /sb\.rpc\("investor_join"/);
  assert.match(onboarding, /draft\.account\.type === "investor"/);
});

console.log(`\n${passed} passed, 0 failed`);
