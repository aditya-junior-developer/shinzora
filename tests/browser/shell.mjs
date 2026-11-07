/* ==========================================================================
   Shinzora — browser harness: shell.mjs
   --------------------------------------------------------------------------
   The signed-in surfaces need a session before they render, and this project has
   no demo data (by design: the dashboard only ever shows rows from the database).
   So this harness stubs *the network*, not the app: it seeds a syntactically
   valid local session and answers Supabase REST with a fixed profile/business.
   Nothing is written anywhere, and the app code path is the real one.

   It covers the defects that a static check cannot see:
     - the sidebar is a real scroll region (Billing/Settings are reachable)
     - the topbar search collapses to an icon on a phone and expands on tap
     - the search popover is opaque
     - onboarding label/description pairs stack instead of running together
     - the dashboard, website builder and onboarding shells render without errors

     BASE=http://127.0.0.1:4173 node tests/browser/shell.mjs
   ========================================================================== */

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;

const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: {
    id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com",
    email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z",
    user_metadata: { full_name: "Harness User" }, app_metadata: { provider: "email" }
  }
};

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", phone: "+91 90000 00000", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", category: "Design studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "in_progress", current_step: 2, draft: {} }]
};

const fulfill = (route, body, extra = {}) =>
  route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "content-type": "application/json", ...extra }, body });

async function stubSupabase(route) {
  const path = new URL(route.request().url()).pathname;
  if (path.includes("/rest/v1/rpc/")) return fulfill(route, "false");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return fulfill(route, JSON.stringify(ROWS[table]), { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/")) return fulfill(route, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return fulfill(route, JSON.stringify(SESSION.user));
  return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"error":"edge function not deployed in this environment"}' });
}

async function open(browser, { width, height }, url) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // addInitScript runs in every frame, including the sandboxed builder preview
  // (no allow-same-origin), where touching localStorage throws. Seeding the
  // session is only meaningful in the top document.
  await ctx.addInitScript((session) => {
    try {
      localStorage.setItem("shinzora.auth", JSON.stringify(session));
    } catch {
      /* sandboxed preview frame — nothing to seed */
    }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stubSupabase);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return { ctx, page, errors };
}

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

/* ------------------------------------------------------------- dashboard */
for (const height of [900, 700]) {
  const { ctx, page, errors } = await open(browser, { width: 1440, height }, "/app/");
  ok(`${height}px: dashboard renders a greeting`, /good (morning|afternoon|evening)/i.test(await page.textContent("#view-root")), "");
  ok(`${height}px: no page errors`, errors.length === 0, errors[0]?.slice(0, 60));

  const nav = await page.evaluate(() => {
    const scroll = document.querySelector(".sidebar-scroll");
    const foot = document.querySelector(".sidebar-foot").getBoundingClientRect();
    const links = document.querySelectorAll("#sidebar-nav [data-nav]");
    const last = links[links.length - 1];
    last.scrollIntoView({ block: "nearest" });
    const r = last.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(scroll).overflowY,
      scrollable: scroll.scrollHeight > scroll.clientHeight,
      lastLabel: last.textContent.trim(),
      reachable: r.top >= 0 && r.bottom <= foot.top + 1
    };
  });
  ok(`${height}px: sidebar is a scroll region`, nav.overflowY === "auto" && nav.scrollable, "scrollHeight > clientHeight");
  ok(`${height}px: "${nav.lastLabel}" is reachable above the footer`, nav.reachable);

  // Navigate like a user: click the Billing link inside the sidebar.
  await page.locator("#sidebar-nav [data-nav]", { hasText: "Billing" }).first().click();
  await page.waitForTimeout(1200);
  ok(`${height}px: Billing link opens Billing`, /billing/.test(page.url()) || /billing/i.test(await page.textContent("#view-root h1, #view-root h2")));
  await ctx.close();
}

/* ---------------------------------------------- builder + onboarding copy */
{
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, "/app/?view=website-builder");
  ok("website builder renders", /website builder/i.test(await page.textContent("#view-root h1, #view-root h2")));
  ok("website builder has no page errors", errors.length === 0, errors[0]?.slice(0, 60));
  await ctx.close();
}
{
  const { ctx, page } = await open(browser, { width: 1440, height: 900 }, "/onboarding/");
  const inline = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("[class$='-desc'], [class$='-label'], [class$='-title']")) {
      if (getComputedStyle(el).display === "inline" && el.textContent.trim()) out.push(el.className);
    }
    return [...new Set(out)];
  });
  ok("onboarding label/description pairs stack", inline.length === 0, inline.slice(0, 3).join(", "));
  await ctx.close();
}

/* ------------------------------------------------------- phone-width shell */
{
  const { ctx, page } = await open(browser, { width: 390, height: 844 }, "/app/");
  ok("390px: no horizontal overflow", (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);

  const collapsed = await page.evaluate(() => {
    const el = document.querySelector(".topbar-search");
    return { w: Math.round(el.getBoundingClientRect().width), placeholder: getComputedStyle(document.querySelector("#global-search"), "::placeholder").color };
  });
  ok("390px: search collapsed to an icon", collapsed.w <= 42, `${collapsed.w}px`);
  ok("390px: placeholder hidden while collapsed", /rgba\(0, 0, 0, 0\)|transparent/.test(collapsed.placeholder));

  await page.click("#global-search");
  await page.waitForTimeout(400);
  const expanded = await page.evaluate(() => {
    const r = document.querySelector(".topbar-search").getBoundingClientRect();
    const panel = document.querySelector("#search-results");
    return {
      w: Math.round(r.width), inside: r.left >= 0 && r.right <= window.innerWidth + 1,
      panelBg: panel ? getComputedStyle(panel).backgroundImage : "",
      placeholder: getComputedStyle(document.querySelector("#global-search"), "::placeholder").color
    };
  });
  ok("390px: search expands across the bar", expanded.w > 300 && expanded.inside, `${expanded.w}px`);
  ok("390px: placeholder readable when open", !/rgba\(0, 0, 0, 0\)|transparent/.test(expanded.placeholder));

  await page.fill("#global-search", "billing");
  await page.waitForTimeout(700);
  const results = await page.evaluate(() => {
    const panel = document.querySelector("#search-results");
    return { open: panel && !panel.hidden, text: panel?.textContent.trim() || "", opaque: /gradient|rgb\(/.test(getComputedStyle(panel).backgroundImage + getComputedStyle(panel).backgroundColor) };
  });
  ok("390px: search returns real results", results.open && /billing/i.test(results.text), results.text.replace(/\s+/g, " ").slice(0, 40));
  ok("390px: results popover is opaque", results.opaque);
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} problem${bad === 1 ? "" : "s"}\n` : "\ndashboard shell verified\n");
process.exit(bad ? 1 : 0);
