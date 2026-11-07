#!/usr/bin/env node
/* ==========================================================================
   Shinzora — developer fixture loader
   --------------------------------------------------------------------------
   The shipped environment starts clean: two accounts, no customers, no orders,
   no payments. The browser test suites assert on realistic records, so they
   need a fixture — and that fixture must be something you ask for explicitly,
   never something a customer can stumble into.

     node scripts/seed-demo.mjs            # load the demo fixture
     node scripts/seed-demo.mjs --empty    # wipe back to a clean store
     node scripts/seed-demo.mjs --status   # show what is in the store now
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, storePath, reset, load } from "../server/prelaunch/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.slice(2).find((a) => a.startsWith("--")) || "--demo";

if (arg === "--status") {
  const store = load(ROOT);
  const counts = Object.entries(store.tables).map(([name, rows]) => [name, rows.length]);
  console.log(`  store: ${storePath(ROOT)}  (seed: ${store.seed_kind || "demo"})`);
  for (const [name, n] of counts) if (n) console.log(`   ${name.padEnd(22)} ${n}`);
  console.log(`   ${"total rows".padEnd(22)} ${counts.reduce((a, [, n]) => a + n, 0)}`);
  process.exit(0);
}

const demo = arg !== "--empty";
const store = reset(ROOT, { demo });
const total = Object.values(store.tables).reduce((a, rows) => a + rows.length, 0);

console.log(`\n  ${demo ? "Demo fixture loaded" : "Clean store restored"} — ${total} rows across ${Object.keys(store.tables).length} tables`);
console.log(`  ${storePath(ROOT)}\n`);
if (demo) {
  console.log("  This is a developer fixture. It is not part of the shipped site and holds no customer data.");
  console.log("  Restore the clean store with:  node scripts/seed-demo.mjs --empty\n");
}
