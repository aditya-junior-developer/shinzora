/* ==========================================================================
   Shinzora — browser harness: a member's own PNG or GIF wallpaper (R7)
   --------------------------------------------------------------------------
     - a free member sees the upload locked, with the way to unlock it
     - a Glow member sees their uploads; the chosen one is marked
     - a file that is not PNG or GIF, or is over 5 MB, is refused before any upload
     - a valid PNG is uploaded to the caller's folder, recorded, and put in use
     - at five uploads the input is disabled and the count is shown
     - removing an upload deletes its record and its stored file
     - no horizontal overflow and no page errors at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/member-wallpaper.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r7";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: {} }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};
const CATALOG = {
  collections: [{ id: "open", name: "Open", description: "Free for everyone", requiredTier: null, locked: false, wallpapers: [] }],
  chosenWallpaperId: null,
  tier: "glow"
};

/* The stub's own memory of this member's uploads. */
let tierOk = true;
let uploads = [];
let chosenId = null;
const calls = { storageUploads: [], registers: [], uses: [], deletes: [], storageRemoves: [] };
let nextId = 1;

function state() {
  const chosen = uploads.find((row) => row.id === chosenId) || null;
  return {
    tierOk,
    limit: 5,
    chosenId: chosen ? chosen.id : null,
    chosenPath: tierOk && chosen ? chosen.path : null,
    uploads: uploads.map((row) => ({ ...row, chosen: row.id === chosenId }))
  };
}

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;

  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "theme_catalog") return send(route, 200, CATALOG);
    if (name === "member_wallpaper_state") return send(route, 200, state());
    if (name === "member_wallpaper_register") {
      calls.registers.push(body.p_path);
      nextId += 1;
      const row = { id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`, path: body.p_path, mimeType: "image/png", byteSize: 1200, createdAt: new Date().toISOString() };
      uploads.push(row);
      return send(route, 200, { ok: true, id: row.id, path: body.p_path });
    }
    if (name === "member_wallpaper_use") {
      calls.uses.push(body.p_id);
      chosenId = body.p_id;
      return send(route, 200, { ok: true, id: body.p_id });
    }
    if (name === "member_wallpaper_delete") {
      calls.deletes.push(body.p_id);
      const row = uploads.find((r) => r.id === body.p_id);
      uploads = uploads.filter((r) => r.id !== body.p_id);
      if (chosenId === body.p_id) chosenId = null;
      return send(route, 200, { ok: true, path: row?.path || null });
    }
    if (name === "theme_set_wallpaper" || name === "theme_clear_wallpaper") return send(route, 200, { ok: true });
    return send(route, 200, "[]");
  }

  if (path.startsWith("/storage/v1/object/sign/member-wallpapers/")) {
    const objectPath = decodeURIComponent(path.replace("/storage/v1/object/sign/member-wallpapers/", ""));
    const token = `tok-${uploads.findIndex((r) => r.path === objectPath) + 1}`;
    return send(route, 200, { signedURL: `/object/sign/member-wallpapers/${objectPath}?token=${token}` });
  }
  if (path === "/storage/v1/object/member-wallpapers" || path === "/storage/v1/object/member-wallpapers/") {
    const prefixes = req.postDataJSON()?.prefixes || [];
    calls.storageRemoves.push(...prefixes);
    return send(route, 200, []);
  }
  if (path.startsWith("/storage/v1/object/member-wallpapers/")) {
    calls.storageUploads.push(decodeURIComponent(path.replace("/storage/v1/object/member-wallpapers/", "")));
    return send(route, 200, { Key: `member-wallpapers/${path}`, Id: "x" });
  }

  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};
const reset = (mode) => {
  tierOk = mode !== "free";
  uploads = [];
  chosenId = null;
  calls.storageUploads.length = 0;
  calls.registers.length = 0;
  calls.uses.length = 0;
  calls.deletes.length = 0;
  calls.storageRemoves.length = 0;
  if (mode === "chosen") {
    uploads = [{ id: "00000000-0000-4000-8000-000000000101", path: `${UID}/00000000-0000-4000-8000-0000000000aa.png`, mimeType: "image/png", byteSize: 2048, createdAt: "2026-11-01T10:00:00Z" }];
    chosenId = uploads[0].id;
  }
  if (mode === "full") {
    uploads = Array.from({ length: 5 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000010${i}`,
      path: `${UID}/00000000-0000-4000-8000-00000000f00${i}.${i % 2 ? "gif" : "png"}`,
      mimeType: i % 2 ? "image/gif" : "image/png",
      byteSize: 1000 * (i + 1),
      createdAt: `2026-11-0${i + 1}T10:00:00Z`
    }));
    chosenId = uploads[0].id;
  }
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

/* Settings always opens on Profile; a member reaches Appearance from its tab. */
async function open(page) {
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector(".wallpaper-card #wallpaper-body .wallpaper-collection", { timeout: 20000 });
  await page.waitForTimeout(400);
}

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  /* A free member: locked, with the way to unlock. */
  reset("free");
  await open(page);
  const locked = await page.locator(".wallpaper-collection.is-locked").first().innerText().catch(() => "");
  ok("a free member sees the upload locked", /Part of the Glow or Elite profile/.test(locked), locked.slice(0, 60));
  ok("a free member has no upload input", (await page.locator("#own-wallpaper-input").count()) === 0);
  ok("the unlock link goes to Billing", (await page.locator('a[href="/app/?view=billing"]').count()) >= 1);
  await page.locator("#wallpaper-body").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/own-free-${vp.name}.png` });

  /* A Glow member with one upload in use. */
  reset("chosen");
  await open(page);
  const chosenTile = await page.locator("[data-own-use].is-selected").count();
  ok("the Glow member's chosen upload is marked", chosenTile === 1, `tiles=${chosenTile}`);
  ok("the Glow member can upload", (await page.locator("#own-wallpaper-input").isEnabled()) === true);
  const applied = await page.evaluate(() => document.getElementById("theme-wallpaper")?.style.backgroundImage || "");
  ok("the chosen upload is the page background", applied.includes("token=tok-1"), applied.slice(0, 120));

  /* A file that is not PNG or GIF: refused before any upload. */
  await page.setInputFiles("#own-wallpaper-input", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForTimeout(500);
  ok("a text file is refused with the reason", (await page.getByText("Only PNG and GIF files can be used as wallpapers.").count()) >= 1);
  ok("a refused type makes no upload", calls.storageUploads.length === 0 && calls.registers.length === 0);

  /* A file over 5 MB: refused before any upload. */
  await page.setInputFiles("#own-wallpaper-input", { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024, 1) });
  await page.waitForTimeout(500);
  ok("a file over 5 MB is refused with its size", (await page.getByText(/at most 5 MB/).count()) >= 1);
  ok("an oversized file makes no upload", calls.storageUploads.length === 0);

  /* A valid PNG: uploaded to the caller's folder, recorded, and put in use. */
  reset("glow-empty");
  await open(page);
  await page.setInputFiles("#own-wallpaper-input", { name: "ok.png", mimeType: "image/png", buffer: Buffer.alloc(1200, 2) });
  await page.waitForTimeout(1200);
  ok("a valid PNG is stored in the caller's own folder", calls.storageUploads.length === 1 && calls.storageUploads[0].startsWith(`${UID}/`) && calls.storageUploads[0].endsWith(".png"), calls.storageUploads.join(","));
  ok("the upload is recorded once", calls.registers.length === 1 && calls.registers[0] === calls.storageUploads[0]);
  ok("the new upload is put in use", calls.uses.length === 1, `uses=${calls.uses.length}`);
  ok("the new upload is the background", (await page.evaluate(() => document.getElementById("theme-wallpaper")?.style.backgroundImage || "")).includes("token=tok-1"));
  await page.screenshot({ path: `${SHOTS}/own-uploaded-${vp.name}.png` });

  /* Five uploads: the input is off and the count says why. */
  reset("full");
  await open(page);
  ok("at five uploads the input is disabled", (await page.locator("#own-wallpaper-input").isDisabled()) === true);
  ok("at five uploads the count is shown", (await page.getByText("You have 5 of 5.").count()) === 1);
  await page.locator("#wallpaper-body").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/own-full-${vp.name}.png` });

  /* Removing an upload deletes the record and the stored file. */
  reset("chosen");
  await open(page);
  const beforeRemoved = uploads.length;
  await page.locator("[data-own-remove]").first().click();
  await page.waitForTimeout(800);
  ok("removing an upload deletes its record", calls.deletes.length === 1 && beforeRemoved === 1);
  ok("removing an upload deletes the stored file", calls.storageRemoves.length === 1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("no horizontal overflow", overflow <= 1, `${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll member-wallpaper checks passed");
process.exit(bad ? 1 : 0);
