/* ==========================================================================
   Shinzora — browser harness: business stage (brief A)
   --------------------------------------------------------------------------
     - onboarding: the exact heading and subtext, four cards with the approved
       names, click and arrow-key selection, no old labels
     - overview with a saved stage: the coloured badge in the page head, the
       roadmap with links to real pages, the "Next" step
     - overview with no stage: the prompt is shown, Continue stays disabled
       until a card is chosen, and the choice is saved through the owner RPC
       (business_set_stage) and the roadmap then follows it
     - Settings > Business: the stage card saves through the same RPC and the
       badge updates in place
     - no page errors and no horizontal overflow at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/business-stage.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-stage";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const BIZ = "aaaaaaaa-1111-2222-3333-444444444444";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z" }
};
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-range",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"
};
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

/* One mutable scenario per run. `stage` is what the businesses row holds. */
let scenario = {};
const rpcCalls = [];

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "business_set_stage") {
      rpcCalls.push({ name, body });
      if (scenario.rpcFails) return send(route, 400, { code: "22023", message: "Choose one of the four stages." });
      scenario.stage = body.p_stage;
      return send(route, 200, { ok: true, businessId: BIZ, stage: body.p_stage });
    }
    if (name === "theme_catalog") return send(route, 200, { collections: [], chosenWallpaperId: null, tier: null });
    return send(route, 200, "[]");
  }
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  const rows = scenario.rows || {};
  const table = Object.keys(rows).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) {
    const data = typeof rows[table] === "function" ? rows[table]() : rows[table];
    return send(route, 200, data, { "content-range": `0-${Math.max(0, data.length - 1)}/${data.length}` });
  }
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  return send(route, 503, { error: "not stubbed" });
}

const businessRows = () => (scenario.stage === undefined ? [] : [{ id: BIZ, owner_id: UID, name: "Harness Studio", category: "Retail", description: "Coffee beans sold online.", stage: scenario.stage, created_at: "2026-10-02T09:00:00Z" }]);

const baseRows = () => ({
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: businessRows,
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 5, data: {} }]
});

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};

async function newPage(vp, errors) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource|supabase-js/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const errors = [];

  /* 1. Onboarding: the stage question on step 2. */
  scenario = { rows: { ...baseRows(), onboarding_progress: [{ id: "c1", user_id: UID, current_step: 2, data: {} }], businesses: [] }, stage: undefined };
  let { ctx, page } = await newPage(vp, errors);
  await page.goto(`${BASE}/onboarding/`, { waitUntil: "load" });
  await page.waitForSelector("#ob-stage-options [data-stage-option]", { timeout: 20000 });
  const heading = await page.evaluate(() => ({
    h: document.querySelector("#ob-stage-title")?.textContent.trim(),
    sub: document.querySelector("#ob-stage-sub")?.textContent.trim(),
    cards: [...document.querySelectorAll("#ob-stage-options [data-stage-option]")].map((b) => b.querySelector(".stage-option-title").textContent.trim()),
    old: /Idea stage|Just starting|Growing/.test(document.querySelector("#ob-step2-title")?.parentElement?.textContent || "") || !!document.querySelector('[data-stage="idea"]')
  }));
  ok("onboarding heading is exact", heading.h === "What stage is your business currently in?");
  ok("onboarding subtext is exact", heading.sub === "Tell us where you are today so SHINZORA can help you move forward.");
  ok("four cards with the approved names", heading.cards.join("|") === "Ideation|MVP|Scaling|Established Business", heading.cards.join("|"));
  ok("no old stage labels or attributes", heading.old === false);
  await page.locator("#ob-stage-options [data-stage-option='scaling']").scrollIntoViewIfNeeded();
  await page.locator("#ob-stage-options [data-stage-option='scaling']").click();
  await page.waitForTimeout(350);
  const picked = await page.evaluate(() => [...document.querySelectorAll("#ob-stage-options [data-stage-option]")].map((b) => [b.dataset.stageOption, b.getAttribute("aria-checked")]));
  ok("clicking a card selects only that card", picked.filter(([, v]) => v === "true").map(([k]) => k).join() === "scaling");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  const afterKey = await page.evaluate(() => document.querySelector("#ob-stage-options [aria-checked='true']")?.dataset.stageOption);
  ok("arrow key moves the selection", afterKey === "established", `now ${afterKey}`);
  await page.locator("#ob-stage-title").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/onboarding-${vp.name}.png`, fullPage: false });
  ok("onboarding has no horizontal overflow", await noOverflow(page));
  await ctx.close();

  /* 2. Overview with a saved stage: badge, roadmap, next step. */
  errors.length = 0;
  scenario = { rows: baseRows(), stage: "mvp" };
  ({ ctx, page } = await newPage(vp, errors));
  await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
  await page.waitForSelector(".stage-card .stage-checklist li", { timeout: 20000 });
  const roadmap = await page.evaluate(() => ({
    badge: document.querySelector(".page-title [data-stage-badge]")?.dataset.stageBadge,
    items: [...document.querySelectorAll(".stage-checklist li")].length,
    links: [...document.querySelectorAll(".stage-checklist li a")].map((a) => a.getAttribute("href")),
    next: document.querySelector(".stage-checklist li.is-next a")?.textContent.trim(),
    done: document.querySelectorAll(".stage-checklist li.is-done").length
  }));
  ok("the badge sits in the overview heading", roadmap.badge === "mvp", `badge=${roadmap.badge}`);
  ok("the MVP roadmap has four steps", roadmap.items === 4, `items=${roadmap.items}`);
  ok("every roadmap step links to a dashboard view", roadmap.links.every((h) => /^\/app\/\?view=[a-z-]+$/.test(h)), roadmap.links.join(" "));
  ok("the first open step is marked Next", /publish/i.test(roadmap.next || ""), roadmap.next);
  ok("steps are confirmed only from records (the description-less MVP has none confirmed)", roadmap.done === 0, `done=${roadmap.done}`);
  await page.locator(".stage-card").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/overview-${vp.name}.png` });
  ok("overview has no horizontal overflow", await noOverflow(page));
  await ctx.close();

  /* 3. Overview with no stage: the prompt saves through the RPC. */
  errors.length = 0;
  scenario = { rows: baseRows(), stage: null };
  rpcCalls.length = 0;
  ({ ctx, page } = await newPage(vp, errors));
  await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
  await page.waitForSelector("#stage-ask", { timeout: 20000 });
  const disabledAtStart = await page.locator("#stage-ask-save").isDisabled();
  ok("the prompt is shown and Continue starts disabled", disabledAtStart === true);
  await page.locator("#stage-ask [data-stage-option='mvp']").click();
  await page.waitForTimeout(200);
  const enabledAfterPick = await page.locator("#stage-ask-save").isEnabled();
  ok("Continue enables after a card is chosen", enabledAfterPick === true);
  await page.locator("#stage-ask-save").click();
  await page.waitForSelector(".stage-card .stage-checklist li", { timeout: 20000 });
  const call = rpcCalls.find((c) => c.name === "business_set_stage");
  ok("the choice is saved through business_set_stage", !!call && call.body.p_stage === "mvp" && call.body.p_business === BIZ, JSON.stringify(call?.body));
  const afterSave = await page.evaluate(() => document.querySelector(".page-title [data-stage-badge]")?.dataset.stageBadge);
  ok("the roadmap follows the saved stage", afterSave === "mvp", `badge=${afterSave}`);
  ok("overview has no horizontal overflow after save", await noOverflow(page));
  await ctx.close();

  /* 4. Settings > Business: change the stage and save it. */
  errors.length = 0;
  scenario = { rows: baseRows(), stage: "ideation" };
  rpcCalls.length = 0;
  ({ ctx, page } = await newPage(vp, errors));
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="business"]').first().click();
  await page.waitForSelector("#settings-stage-options [data-stage-option]", { timeout: 20000 });
  const settingsBefore = await page.evaluate(() => ({
    badge: document.querySelector("#stage-card-badge [data-stage-badge]")?.dataset.stageBadge,
    saveDisabled: document.querySelector("#save-stage")?.disabled
  }));
  ok("Settings shows the saved stage badge", settingsBefore.badge === "ideation", `badge=${settingsBefore.badge}`);
  ok("Save stage is disabled until a change is made", settingsBefore.saveDisabled === true);
  await page.locator("#settings-stage-options [data-stage-option='established']").click();
  await page.locator("#save-stage").click();
  await page.waitForFunction(() => document.querySelector("#stage-card-badge [data-stage-badge]")?.dataset.stageBadge === "established", null, { timeout: 20000 }).catch(() => {});
  const settingsCall = rpcCalls.find((c) => c.name === "business_set_stage");
  ok("Settings saves through business_set_stage", !!settingsCall && settingsCall.body.p_stage === "established", JSON.stringify(settingsCall?.body));
  const settingsAfter = await page.evaluate(() => document.querySelector("#stage-card-badge [data-stage-badge]")?.dataset.stageBadge);
  ok("the Settings badge updates in place", settingsAfter === "established", `badge=${settingsAfter}`);
  await page.locator("#stage-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/settings-${vp.name}.png` });
  ok("Settings has no horizontal overflow", await noOverflow(page));
  await ctx.close();

  ok(`no page errors at ${vp.width}px`, errors.length === 0, errors.slice(0, 3).join(" | "));
}

await browser.close();
console.log(bad ? `\nFAILED (${bad})` : "\nPASSED");
process.exit(bad ? 1 : 0);
