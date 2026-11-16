/* ==========================================================================
   Shinzora — browser harness: brief of 16 November (items 1, 2, 7, 8)
   --------------------------------------------------------------------------
     1  the investor deck page counts the available investors, and an owner's
        ready deck can be pitched to each one
     2  the business summary downloads as a PDF and as a PowerPoint file, and a
        failed AI draft gives its button back its label (no stuck "Drafting…")
     7  Social Media & Ads replaces Extra Services under Ad Campaign: accounts,
        campaign requests and analytics from the member's own records
     8  Messages, Groups and Channels are separate: no Groups tab in Messages, no
        Groups inside Channels, and Groups opens its own list
     no page errors and no horizontal overflow at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/brief-16nov.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r10";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z" }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const INVESTORS = {
  count: 2,
  investors: [
    { userId: "21111111-2222-3333-4444-555555555501", username: "ivy.investor", name: "Ivy Investor" },
    { userId: "21111111-2222-3333-4444-555555555502", username: "kabir.angel", name: "Kabir Angel" }
  ]
};
const DECK = { id: "dddddddd-1111-2222-3333-444444444444", owner_id: UID, title: "Seed deck", mode: "ai", status: "ready", slides: [{ title: "Cover", bullets: ["Hello"] }, { title: "Ask", bullets: ["Raise"] }, { title: "Team", bullets: ["Us"] }], updated_at: "2026-11-10T09:00:00Z" };
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness Owner", username: "harness", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }],
  investor_decks: [DECK],
  marketing_accounts: [
    { id: "ac000000-0000-4000-8000-000000000001", channel: "instagram", handle: "@harness.studio", profile_url: "https://instagram.com/harness.studio", status: "submitted", created_at: "2026-11-01T09:00:00Z" },
    { id: "ac000000-0000-4000-8000-000000000002", channel: "facebook", handle: "Harness Page", profile_url: "https://facebook.com/harness", status: "verified", created_at: "2026-11-02T09:00:00Z" }
  ],
  marketing_requests: [
    { id: "rq000000-0000-4000-8000-000000000001", campaign_type: "meta_ads", objective: "Leads / enquiries", budget_paise: 500000, budget_mode: "total", duration_days: 14, status: "submitted", reference: "SZ-AD-1", created_at: "2026-11-03T09:00:00Z" }
  ]
};

const calls = { deckActions: [], summaryBodies: [], shares: [], directory: 0 };
let aiMode = "fail";
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;

  if (path.includes("/functions/v1/deck")) {
    const body = req.postDataJSON() || {};
    calls.deckActions.push(body.action);
    if (body.action === "summary") {
      calls.summaryBodies.push(body);
      const pdf = Buffer.from("%PDF-1.4\n% stub summary\n");
      const isPdf = body.format === "pdf";
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        body: pdf
      });
    }
    if (body.action === "generate") {
      if (aiMode === "fail") return send(route, 502, { error: "The AI could not draft the deck right now. Nothing was used. Try again in a moment.", code: "ai_unavailable" });
      return send(route, 200, { deck: DECK });
    }
    return send(route, 400, { error: "unknown", code: "unknown_action" });
  }
  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "investor_directory") { calls.directory += 1; return send(route, 200, INVESTORS); }
    if (name === "deck_share") { calls.shares.push(body.p_username); return send(route, 200, { shareId: "s1", investor: body.p_username }); }
    if (name === "deck_data_snapshot") return send(route, 200, { sections: {} });
    if (name === "theme_catalog") return send(route, 200, { collections: [], chosenWallpaperId: null, tier: "elite" });
    if (name === "member_rings") return send(route, 200, []);
    if (name === "notify_admins") return send(route, 200, 0);
    return send(route, 200, "[]");
  }
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  return send(route, 503, { error: "not stubbed" });
}

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

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch, acceptDownloads: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  await ctx.route(`${BASE}/functions/v1/**`, stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|429|supabase-js/.test(m.text())) errors.push(m.text()); });
  const noOverflow = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`no horizontal overflow on ${label}`, overflow <= 1, `${overflow}px`);
  };

  /* 1. Investor deck: the count, and pitching a ready deck. */
  calls.shares.length = 0;
  await page.goto(`${BASE}/app/?view=investor-decks`, { waitUntil: "load" });
  await page.waitForSelector(".deck-investors", { timeout: 20000 });
  const countText = await page.locator("#deck-investors-title").innerText();
  ok("the investor count is shown", /2 investors available/.test(countText), countText);
  ok("each investor handle is listed", (await page.locator(".deck-investors-list").innerText()).includes("@ivy.investor"));
  await page.locator(".deck-card").first().click();
  await page.waitForSelector("#deck-sharing", { timeout: 20000 });
  await page.waitForTimeout(400);
  const pitch = await page.locator("[data-pitch]").count();
  ok("each available investor has a Pitch button", pitch === 2, `buttons=${pitch}`);
  await page.locator('[data-pitch="ivy.investor"]').click();
  await page.waitForTimeout(500);
  ok("Pitch shares the ready deck with that investor", calls.shares.includes("ivy.investor"), calls.shares.join(","));
  await page.screenshot({ path: `${SHOTS}/brief16-investors-${vp.name}.png`, fullPage: false });
  await noOverflow("the investor deck editor");

  /* 2a. A failed AI draft gives the button back its label. */
  aiMode = "fail";
  await page.goto(`${BASE}/app/?view=investor-decks`, { waitUntil: "load" });
  await page.waitForSelector("[data-deck-new]", { timeout: 20000 });
  await page.locator("[data-deck-new]").first().click();
  await page.locator("#deck-title").fill("Seed deck");
  await page.locator("#deck-create").click();
  /* A 502 is retried once after 2.5 s, so wait for the outcome, not a fixed delay. */
  await page.waitForFunction(() => !/Drafting/.test(document.querySelector("#deck-create")?.textContent || "") && document.querySelector("#deck-create")?.disabled === false, null, { timeout: 20000 }).catch(() => {});
  const label = (await page.locator("#deck-create").innerText()).trim();
  ok("a failed AI draft does not stay on 'Drafting…'", !/Drafting/.test(label), label);
  ok("the AI draft shows the reason", (await page.locator("#deck-error").innerText()).length > 0);

  /* 2b. The business summary downloads as a PDF and as a PowerPoint file. */
  await page.goto(`${BASE}/app/?view=investor-decks`, { waitUntil: "load" });
  await page.waitForSelector("[data-summary='pdf']", { timeout: 20000 });
  const pdfDownload = page.waitForEvent("download", { timeout: 20000 });
  await page.locator("[data-summary='pdf']").click();
  const pdf = await pdfDownload;
  ok("the summary downloads as a PDF", pdf.suggestedFilename().endsWith(".pdf"), pdf.suggestedFilename());
  const pptDownload = page.waitForEvent("download", { timeout: 20000 });
  await page.locator("[data-summary='pptx']").click();
  const ppt = await pptDownload;
  ok("the summary downloads as a PowerPoint file", ppt.suggestedFilename().endsWith(".pptx"), ppt.suggestedFilename());
  ok("both summaries asked the deck function for a summary", calls.deckActions.filter((a) => a === "summary").length >= 2);
  ok("the summary is sent with the ticked parts only, and no charge", calls.summaryBodies.every((b) => Array.isArray(b.sections) && b.sections.length >= 1 && b.sections.every((x) => ["business", "inventory", "sales"].includes(x)) && !("amount" in b)), JSON.stringify(calls.summaryBodies[0] || {}));
  await page.screenshot({ path: `${SHOTS}/brief16-summary-${vp.name}.png` });
  await noOverflow("the investor deck list");

  /* 7. Social Media & Ads replaces Extra Services under Ad Campaign. */
  await page.goto(`${BASE}/app/?view=marketing`, { waitUntil: "load" });
  await page.waitForSelector("text=Social-media analytics", { timeout: 20000 });
  const title = (await page.locator("h1").first().innerText()).trim();
  ok("the page is Social Media & Ads", /Social Media & Ads/.test(title), title);
  ok("the Extra Service request wording is gone", (await page.locator("body").innerText()).includes("Request for Extra Service") === false);
  ok("the social accounts card is shown", (await page.getByText("Social accounts").count()) >= 1);
  ok("the analytics show the Instagram count", (await page.locator(".card", { hasText: "Social-media analytics" }).innerText()).includes("Instagram"));
  ok("campaign requests are listed", (await page.getByText("Campaign requests").count()) >= 1);
  await page.screenshot({ path: `${SHOTS}/brief16-social-${vp.name}.png`, fullPage: true });
  await noOverflow("Social Media & Ads");

  /* 8. Messages, Groups and Channels are separate. */
  await page.goto(`${BASE}/app/?view=messages`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  ok("Messages has no Groups tab", (await page.locator(".messages-tab").count()) === 0 && (await page.locator("[data-seg='groups']").count()) === 0);
  await page.goto(`${BASE}/app/?view=groups`, { waitUntil: "load" });
  await page.waitForSelector("#grp-list", { timeout: 20000 }).catch(() => {});
  const groupsTitle = (await page.locator("h1").first().innerText().catch(() => "")).trim();
  ok("the Groups page is titled Groups", /Groups/.test(groupsTitle), groupsTitle);
  await page.goto(`${BASE}/app/?view=community`, { waitUntil: "load" });
  await page.waitForSelector("#grp-channels", { timeout: 20000 }).catch(() => {});
  ok("Channels has no Groups section", (await page.locator(".hub-rail-groups-section").count()) === 0 && (await page.locator("#grp-list").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/brief16-channels-${vp.name}.png` });
  await noOverflow("Channels");

  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();
console.log(bad ? `FAILED ${bad}` : "PASSED");
process.exit(bad ? 1 : 0);
