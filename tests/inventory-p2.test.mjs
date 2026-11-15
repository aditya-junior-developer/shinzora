/* Inventory part 2: push to website, photos, per-product low-stock levels,
   resolvable alerts. These are the guarantees the UI depends on. The database
   behaviour itself was exercised against the live project inside a rolled-back
   transaction; this file keeps the source from drifting away from it. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const migration = read("supabase/migrations/0048_inventory_p2.sql");
const alignment = read("supabase/migrations/0049_inventory_movements_align.sql");
const inventory = read("public/js/modules/dashboard/views/inventory.js");
const store = read("public/js/modules/dashboard/views/store.js");
const shop = read("public/shop/index.html");

// --- database -------------------------------------------------------------
assert.match(migration, /create unique index if not exists store_products_owner_sku_uidx/, "SKU unique per owner");
assert.match(migration, /where sku is not null and btrim\(sku\) <> ''/, "SKU stays optional");
assert.match(migration, /after insert or update of stock, low_stock_threshold/, "alert trigger watches the threshold");
assert.match(migration, /limit_at int := coalesce\(new\.low_stock_threshold, 5\)/, "alert uses the product's own level");
assert.match(migration, /function public\.product_set_website\(p_product uuid, p_publish boolean\)/, "publish function exists");
assert.match(migration, /set the product to Active/, "publish gate: status");
assert.match(migration, /add at least one image/, "publish gate: image");
assert.match(migration, /set a price above zero/, "publish gate: price");
assert.match(migration, /coalesce\(\s*item\.website_slug,/, "slug is kept on republish");
assert.match(migration, /create or replace view public\.public_store_products/, "public view exists");
assert.match(migration, /where p\.website_published = true[\s\S]*and p\.status = 'active'/, "view shows only published, active products");
assert.doesNotMatch(migration.split("create or replace view public.public_store_products")[1] || "", /\bsku\b|owner_id/, "view hides SKU and owner");
assert.match(migration, /grant select on public\.public_store_products to anon, authenticated/, "anonymous read of the view");
assert.match(migration, /function public\.product_alert_resolve/, "resolve function exists");
assert.match(migration, /revoke all on function public\.product_set_website\(uuid, boolean\) from public, anon/, "publish not callable anonymously");

assert.match(alignment, /add column if not exists actor_id/, "movements table gains actor_id");
assert.match(alignment, /'correction' else 'adjustment'/, "trigger reasons are allowed values");
assert.doesNotMatch(alignment, /'manual'|'system'/, "no reason outside the live check constraint");

// --- inventory view ------------------------------------------------------
assert.match(inventory, /sb\.rpc\("product_set_website"/, "push goes through the database function");
assert.match(inventory, /sb\.rpc\("product_alert_resolve"/, "resolve goes through the database function");
assert.match(inventory, /brand-assets/, "photos use the owner-scoped bucket");
assert.match(inventory, /upload\(path, file/, "photos are uploaded to storage");
assert.match(inventory, /MAX_PHOTOS = 8/, "photo count is capped");
assert.match(inventory, /PHOTO_MAX_BYTES = 5 \* 1024 \* 1024/, "photo size is capped");
assert.doesNotMatch(inventory, /website_published:\s*true|website_published"\s*:\s*true/, "browser never sets the publish flag directly");
assert.doesNotMatch(inventory, /Number\(row\.stock\) <= 5/, "no hardcoded low-stock level");
assert.match(inventory, /code === "23505"/, "duplicate SKU has a plain message");

// --- storefront ------------------------------------------------------------
assert.match(store, /row\.low_stock_threshold \?\? 5/, "store view uses the product's level");
assert.doesNotMatch(store, /Number\(row\.stock\) <= 5\)/, "store view has no hardcoded level");

// --- public product page ---------------------------------------------------
assert.match(shop, /public_store_products/, "public page reads only the public view");
assert.doesNotMatch(shop, /service_role|SUPABASE_SERVICE|secret/i, "no service credentials on the public page");
assert.doesNotMatch(shop, /\.innerHTML\s*=\s*[^;]*item\./, "product fields are never injected as HTML");
assert.match(shop, /\/\^https:\\\/\\\/\/\.test\(url\)/, "only https images are shown");

console.log("inventory-p2: all checks passed");
