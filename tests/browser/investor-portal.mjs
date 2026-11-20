/* ==========================================================================
   Shinzora — browser harness: investor portal (phase 2)
   --------------------------------------------------------------------------
   Signs in as an investor account and stubs *the network*: Supabase RPCs and
   tables answer with fixed fixture rows, and every RPC call is recorded so the
   test can check what the buttons send. The app code path is the real one.
   Nothing is written to any database.

   It checks, at 1440, 768 and 390 px:
     - the sidebar groups and links the investor is meant to see, and no others
     - the dashboard numbers come from investor_dashboard()
     - Explore Businesses: filters call investor_marketplace(), and "Express
       interest" calls express_investor_interest() and changes the button
     - Investor Network and My Connections: connect, accept and decline call the
       right functions with the right ids
     - Profile saves to investor_profiles with the visibility chosen
     - Subscription is honest (no paid plan, no checkout)
     - no page errors and no horizontal overflow

     BASE=http://127.0.0.1:4173 node tests/browser/investor-portal.mjs
   ========================================================================== */

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "00000000-0000-0000-0000-00000000000b";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "asha@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: {
    id: UID, aud: "authenticated", role: "authenticated", email: "asha@example.com",
    email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z",
    user_metadata: { full_name: "Asha Rao" }, app_metadata: { provider: "email" }
  }
};

const BIZ = [
  { id: "10000000-0000-0000-0000-000000000001", name: "Bakery Co", description: "Artisan bakery with three outlets in Pune and a growing wholesale line.", category: "Food & beverage", stage: "mvp", location: "Pune", goals: ["Raise seed round"], goal_note: null, funding_requirement_inr: 2500000, logo_url: null, created_at: "2026-11-01T09:00:00Z" },
  { id: "10000000-0000-0000-0000-000000000003", name: "Priya Textiles", description: "Handloom saris sold direct to customers across India.", category: "Fashion & apparel", stage: "scaling", location: "Jaipur", goals: [], goal_note: null, funding_requirement_inr: null, logo_url: null, created_at: "2026-10-20T09:00:00Z" }
];
const PEOPLE = [
  { user_id: "00000000-0000-0000-0000-00000000000c", display_name: "Bilal Khan", headline: "Angel investor, climate", interests: ["climate"], preferred_industries: ["Technology & SaaS"], avatar_url: null, visibility: "public", connection_status: "none" },
  { user_id: "00000000-0000-0000-0000-00000000000d", display_name: "Chandra Iyer", headline: "Seed fund partner", interests: ["fintech"], preferred_industries: ["Finance"], avatar_url: null, visibility: "public", connection_status: "request_received" },
  { user_id: "00000000-0000-0000-0000-00000000000e", display_name: "Dev Mehta", headline: "Operator angel", interests: [], preferred_industries: [], avatar_url: null, visibility: "connections", connection_status: "connected" }
];
const CONNECTIONS = [
  { connection_id: "c0000000-0000-0000-0000-000000000001", user_id: "00000000-0000-0000-0000-00000000000d", display_name: "Chandra Iyer", headline: "Seed fund partner", avatar_url: null, status: "pending", direction: "received", created_at: "2026-11-02T09:00:00Z" },
  { connection_id: "c0000000-0000-0000-0000-000000000002", user_id: "00000000-0000-0000-0000-00000000000e", display_name: "Dev Mehta", headline: "Operator angel", avatar_url: null, status: "accepted", direction: "sent", created_at: "2026-10-30T09:00:00Z" }
];
const DASH = { listed_businesses: 2, public_investors: 3, connections: 1, pending_requests_in: 1, open_pitches: 1, unread_messages: 0 };

const ROWS = {
  profiles: [{ id: UID, full_name: "Asha Rao", email: "asha@example.com", account_type: "investor", username: "asha", avatar_url: null, created_at: "2026-10-01T09:00:00Z" }],
  investor_profiles: [{ user_id: UID, display_name: "Asha Rao", headline: "Seed investor", bio: "I back early founders.", interests: ["climate"], preferred_industries: ["Food & beverage"], portfolio: "", visibility: "public", updated_at: "2026-11-01T09:00:00Z" }],
  notifications: [{ id: "n1", title: "New connection request", message: "An investor wants to connect with you.", is_read: false, created_at: "2026-11-03T09:00:00Z", link: "/app/?view=investor-connections" }],
  investor_interests: [],
  businesses: []
};

const RPC = {
  investor_dashboard: DASH,
  investor_marketplace: BIZ,
  investor_business: (args) => BIZ.filter((b) => b.id === args.p_business),
  express_investor_interest: true,
  investor_network_directory: PEOPLE,
  my_connections: CONNECTIONS,
  request_connection: "c0000000-0000-0000-0000-00000000aaaa",
  respond_connection: "accepted",
  investor_profile_detail: (args) => [{ user_id: args.p_user, display_name: "Bilal Khan", headline: "Angel investor", bio: "Climate and hardware.", portfolio: "Two seed cheques.", interests: ["climate"], preferred_industries: ["Technology & SaaS"], avatar_url: null, visibility: "public" }],
  my_conversations: [],
  investor_shared_decks: []
};

const calls = [];
const fulfill = (route, body, extra = {}) =>
  route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "content-type": "application/json", ...extra }, body });

async function stubSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname;
  if (path.includes("/rest/v1/rpc/")) {
    const name = path.split("/rest/v1/rpc/")[1];
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ name, args: body || {} });
    const spec = RPC[name];
    if (spec === undefined) return fulfill(route, "[]");
    const value = typeof spec === "function" ? spec(body || {}) : spec;
    return fulfill(route, JSON.stringify(value));
  }
  const table = Object.keys(ROWS).find((name) => path.endsWith(`/rest/v1/${name}`));
  if (table) {
    if (req.method() === "POST" || req.method() === "PATCH") {
      let body = null;
      try { body = req.postDataJSON(); } catch { body = null; }
      calls.push({ name: `write:${table}`, args: body || {}, method: req.method() });
      const row = Array.isArray(body) ? body[0] : body;
      return fulfill(route, JSON.stringify(row ? { ...ROWS[table][0], ...row } : {}), { "content-range": "0-0/1" });
    }
    return fulfill(route, JSON.stringify(ROWS[table]), { "content-range": `0-${Math.max(0, ROWS[table].length - 1)}/${ROWS[table].length}` });
  }
  if (path.includes("/rest/v1/")) return fulfill(route, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return fulfill(route, JSON.stringify(SESSION.user));
  return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"error":"not in this harness"}' });
}

async function open(browser, { width, height }, url) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((session) => {
    try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed frame */ }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stubSupabase);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  return { ctx, page, errors };
}

let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};
const heading = (page) => page.textContent("#view-root .page-title").then((t) => t?.trim() || "");
const lastCall = (name) => [...calls].reverse().find((c) => c.name === name);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const WIDTHS = [
  { width: 1440, height: 900, label: "desktop" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 390, height: 844, label: "mobile" }
];

/* ------------------------------------------------------ sidebar and landing */
for (const vp of WIDTHS) {
  console.log(`\n[${vp.label} ${vp.width}px]`);
  calls.length = 0;
  const { ctx, page, errors } = await open(browser, vp, "/app/");

  ok("lands on the investor Dashboard", (await heading(page)).startsWith("Dashboard"), await heading(page));
  ok("no page errors on load", errors.length === 0, errors[0]?.slice(0, 90));

  const nav = await page.evaluate(() =>
    [...document.querySelectorAll("#sidebar-nav .sidebar-group")].map((g) => ({
      group: g.querySelector(".sidebar-group-label")?.textContent.trim(),
      items: [...g.querySelectorAll("[data-nav]")].map((a) => a.getAttribute("data-nav"))
    }))
  );
  const groups = nav.map((g) => g.group);
  ok("sidebar groups are Investor, Communication, Account", JSON.stringify(groups) === JSON.stringify(["Investor", "Communication", "Account"]), groups.join(" / "));
  const all = nav.flatMap((g) => g.items);
  const expected = ["investor-home", "investor-explore", "investor-network", "investor-connections", "investor", "investor-messages", "investor-requests", "notifications", "investor-profile", "settings", "investor-subscription"];
  ok("sidebar holds exactly the investor links", JSON.stringify(all) === JSON.stringify(expected), all.join(", "));
  const labels = await page.$$eval("#sidebar-nav [data-nav]", (els) => els.map((e) => e.querySelector(".link-text")?.textContent.trim()));
  ok("sidebar labels match the brief", ["Dashboard", "Explore Businesses", "Investor Network", "My Connections", "Shared With You", "Messages", "Requests", "Notifications", "Profile", "Settings", "Subscription"].every((l) => labels.includes(l)), labels.join(" | "));
  ok("no Billing, Overview or business links for investors", !all.some((id) => ["billing", "overview", "investor-decks", "store", "inventory"].includes(id)));
  ok("AI usage meter and chat list are hidden for investors", await page.evaluate(() => {
    const u = document.querySelector("#ai-usage-card");
    const c = document.querySelector("#sidebar-chats");
    return (!u || u.style.display === "none") && (!c || c.style.display === "none");
  }));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("dashboard has no horizontal overflow", overflow <= 1, `overflow ${overflow}px`);

  /* dashboard numbers come from investor_dashboard() */
  const stats = await page.$$eval("#view-root .stat-value", (els) => els.map((e) => e.textContent.trim()));
  ok("dashboard shows the database numbers", ["2", "1", "3", "1", "1"].every((n) => stats.includes(n)), stats.join(","));
  ok("dashboard called investor_dashboard()", Boolean(lastCall("investor_dashboard")));
  ok("dashboard lists the notification from the database", (await page.textContent("#view-root")).includes("New connection request"));

  if (vp.label === "desktop") await page.screenshot({ path: "/tmp/inv-dashboard-desktop.png", fullPage: false });
  if (vp.label === "mobile") await page.screenshot({ path: "/tmp/inv-dashboard-mobile.png", fullPage: false });

  /* sidebar navigation: open it on a phone like a user, then follow each link */
  const drawer = vp.width < 1024;
  if (drawer) {
    await page.click("#sidebar-toggle");
    await page.waitForTimeout(400);
  }
  const pages = [
    ["investor-explore", "Explore Businesses"],
    ["investor-network", "Investor Network"],
    ["investor-connections", "My Connections"],
    ["investor", "Shared With You"],
    ["investor-messages", "Messages"],
    ["investor-requests", "Requests"],
    ["notifications", "Notifications"],
    ["investor-profile", "Investor profile"],
    ["settings", "Settings"],
    ["investor-subscription", "Subscription"]
  ];
  for (const [id, title] of pages) {
    const link = page.locator(`#sidebar-nav [data-nav="${id}"]`).first();
    /* Below 1024px the sidebar is a drawer: open it only when a link cannot be clicked. */
    await link.click({ timeout: 1500 }).catch(async () => {
      if (!drawer) throw new Error(`link ${id} not clickable`);
      await page.click("#sidebar-toggle");
      await page.waitForTimeout(350);
      await link.click();
    });
    await page.waitForTimeout(900);
    const h = await heading(page);
    ok(`sidebar opens ${title}`, h.toLowerCase().includes(title.toLowerCase()), h || "(no heading)");
  }
  ok("navigation produced no page errors", errors.length === 0, errors[0]?.slice(0, 90));

  await ctx.close();
}

/* ---------------------------------------------------------------- explore */
console.log("\n[Explore Businesses]");
{
  calls.length = 0;
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, "/app/?view=investor-explore");
  ok("lists only the businesses the database returns", (await page.$$("#view-root [data-business]")).length === 2);
  ok("shows the funding need in rupees", (await page.textContent("#view-root")).includes("Rs 25,00,000") || (await page.textContent("#view-root")).includes("Rs 2,500,000"));

  await page.fill("#inv-filters input[name=q]", "bakery");
  await page.waitForTimeout(700);
  const search = lastCall("investor_marketplace");
  ok("search calls investor_marketplace with the query", search?.args?.p_query === "bakery", JSON.stringify(search?.args));

  await page.selectOption("#inv-filters select[name=stage]", "mvp");
  await page.waitForTimeout(500);
  ok("stage filter sends p_stage", lastCall("investor_marketplace")?.args?.p_stage === "mvp");

  await page.fill("#inv-filters input[name=min]", "1000000");
  await page.waitForTimeout(600);
  ok("funding floor is sent as a number of rupees", lastCall("investor_marketplace")?.args?.p_min_funding === 1000000);

  await page.locator("[data-interest]").first().click();
  await page.waitForTimeout(700);
  const interest = lastCall("express_investor_interest");
  ok("Express interest calls express_investor_interest with the business id", interest?.args?.p_business === BIZ[0].id, JSON.stringify(interest?.args));
  ok("the button then says Interest sent", (await page.textContent("#view-root")).includes("Interest sent"));

  await page.locator("[data-details]").nth(1).click();
  await page.waitForTimeout(700);
  const detailText = (await page.locator(".modal-backdrop .modal").first().textContent({ timeout: 4000 }).catch(() => "")) || "";
  ok("details open a read-only profile that states contact details are not shared", detailText.includes("Contact details are not shared with investors"), (detailText || "NO DIALOG").slice(0, 300));
  ok("details show no email, phone or website fields", !/@|mailto:|tel:|\+91|website|phone|email/i.test(detailText.replace(/Contact details are not shared with investors\./, "")));
  ok("details call investor_business()", Boolean(lastCall("investor_business")));
  ok("no page errors on explore", errors.length === 0, errors[0]?.slice(0, 90));
  await page.screenshot({ path: "/tmp/inv-explore-desktop.png" });
  await ctx.close();
}

/* ---------------------------------------------------------------- network */
console.log("\n[Investor Network and My Connections]");
{
  calls.length = 0;
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, "/app/?view=investor-network");
  ok("shows only the profiles the directory returns (3 cards)", (await page.$$("#view-root [data-user]")).length === 3);
  ok("a connections-only profile is marked", (await page.textContent("#view-root")).includes("Connections only"));

  await page.locator("[data-connect]").first().click();
  await page.waitForTimeout(700);
  ok("Connect calls request_connection with that investor", lastCall("request_connection")?.args?.p_user === PEOPLE[0].user_id, JSON.stringify(lastCall("request_connection")?.args));

  await page.locator("[data-respond][data-accept='1']").first().click();
  await page.waitForTimeout(700);
  ok("Accept calls respond_connection with the request id and true", (() => {
    const c = lastCall("respond_connection");
    return c?.args?.p_connection === CONNECTIONS[0].connection_id && c?.args?.p_accept === true;
  })(), JSON.stringify(lastCall("respond_connection")?.args));

  await page.locator("[data-profile]").first().click();
  await page.waitForTimeout(600);
  ok("View profile calls investor_profile_detail", Boolean(lastCall("investor_profile_detail")));
  ok("no page errors on network", errors.length === 0, errors[0]?.slice(0, 90));
  await page.screenshot({ path: "/tmp/inv-network-desktop.png" });
  await ctx.close();
}
{
  calls.length = 0;
  const { ctx, page, errors } = await open(browser, { width: 390, height: 844 }, "/app/?view=investor-connections");
  const sections = await page.$$eval("#view-root .inv-section-title", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok("My Connections groups requests (waiting, sent, connected)", ["Waiting for you", "Requests you sent", "Connected"].every((s) => sections.some((x) => x.startsWith(s))), sections.join(" | "));
  await page.locator("[data-respond][data-accept='0']").first().click();
  await page.waitForTimeout(700);
  ok("Decline calls respond_connection with false", lastCall("respond_connection")?.args?.p_accept === false);
  ok("the connections page has no horizontal overflow on a phone", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  ok("no page errors on connections", errors.length === 0, errors[0]?.slice(0, 90));
  await ctx.close();
}

/* ---------------------------------------------------------------- profile */
console.log("\n[Investor profile]");
{
  calls.length = 0;
  const { ctx, page, errors } = await open(browser, { width: 768, height: 1024 }, "/app/?view=investor-profile");
  ok("profile form is prefilled from the database", (await page.inputValue("#inv-profile-form input[name=display_name]")) === "Asha Rao");
  await page.check("#inv-profile-form input[name=industries][value='Food & beverage']").catch(() => {});
  await page.check("#inv-profile-form input[name=visibility][value='connections']");
  await page.fill("#inv-profile-form input[name=headline]", "Seed investor, climate");
  await page.click("#inv-profile-save");
  await page.waitForTimeout(800);
  const write = lastCall("write:investor_profiles");
  ok("save writes investor_profiles for this investor only", write?.args?.user_id === UID, JSON.stringify(write?.args?.user_id));
  ok("save sends the chosen visibility", write?.args?.visibility === "connections");
  ok("save sends the headline", write?.args?.headline === "Seed investor, climate");
  ok("save sends the preferred industry", Array.isArray(write?.args?.preferred_industries) && write.args.preferred_industries.includes("Food & beverage"));

  await page.fill("#inv-profile-form input[name=display_name]", "A");
  await page.click("#inv-profile-save");
  await page.waitForTimeout(300);
  ok("a one-letter name is refused before saving", (await page.textContent("#inv-profile-status")).includes("at least 2"));
  ok("no page errors on profile", errors.length === 0, errors[0]?.slice(0, 90));
  await page.screenshot({ path: "/tmp/inv-profile-tablet.png" });
  await ctx.close();
}

/* ------------------------------------------------------------ subscription */
console.log("\n[Subscription]");
{
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, "/app/?view=investor-subscription");
  const text = await page.textContent("#view-root");
  ok("says the investor account is free", text.includes("Free"));
  ok("offers no checkout or upgrade button", !(await page.$$("#view-root button, #view-root a")).length || !(await page.$$eval("#view-root button, #view-root a", (els) => els.some((e) => /upgrade|subscribe|buy|checkout|pay/i.test(e.textContent)))));
  ok("no page errors on subscription", errors.length === 0);
  await ctx.close();
}

/* -------------------------------------------------- placeholder honesty */
console.log("\n[Messages and Requests are live (phase 3)]");
{
  const r = await open(browser, { width: 1440, height: 900 }, "/app/?view=investor-requests");
  ok("Requests is the live page, not a placeholder", (await r.page.locator("#req-tabs").count()) === 1 && !(await r.page.textContent("#view-root")).includes("next update"));
  ok("no page errors on requests", r.errors.length === 0);
  await r.ctx.close();
  const m = await open(browser, { width: 1440, height: 900 }, "/app/?view=investor-messages");
  ok("Messages is the live page, not a placeholder", (await m.page.locator(".dm-layout").count()) === 1 && !(await m.page.textContent("#view-root")).includes("next update"));
  ok("no page errors on messages", m.errors.length === 0);
  await m.ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll investor portal browser checks passed");
process.exit(bad ? 1 : 0);
