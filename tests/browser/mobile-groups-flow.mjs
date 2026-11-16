/* ==========================================================================
   Shinzora — browser harness: create, open and use Groups and Channels on a
   phone, the same way Direct Messages work.
   --------------------------------------------------------------------------
     - phone (390) and desktop (1440): "New" opens the group form, the form is
       reachable and submittable on screen, the new group opens with its
       composer, and a message can be sent and appears in the thread
     - a public channel opens from the Community page and its composer works
     - the composer and the send button are inside the viewport on a phone
     - no horizontal page overflow and no page errors

     BASE=http://127.0.0.1:4173 SHOTS=/tmp/shots node tests/browser/mobile-groups-flow.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shots";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" } }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }],
  community_channels: [
    { slug: "general", name: "General", description: "Introductions, questions and everything else." },
    { slug: "projects", name: "Projects", description: "Talk about live projects." }
  ]
};

/* A small in-memory group store, so a group created in the flow is listed,
   opened and written to exactly as the real RPCs would behave. */
const groups = new Map([
  ["g1", { id: "g1", name: "Design crew", description: "Weekly reviews", role: "owner", unread: 0, lastMessage: "", lastMessageAt: null }]
]);
const messages = new Map([["g1", []]]);
const calls = { group_create: 0, group_send: 0, community_send: 0 };

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    if (name === "group_my_groups") return send(route, 200, [...groups.values()].map((g) => ({ ...g })));
    if (name === "group_create") {
      calls.group_create += 1;
      const id = `g${groups.size + 1}`;
      const row = { id, name: body.p_name, description: body.p_description || "", role: "owner", unread: 0, lastMessage: "", lastMessageAt: null };
      groups.set(id, row);
      messages.set(id, []);
      return send(route, 200, { id, name: row.name });
    }
    if (name === "group_get") {
      const g = groups.get(body.p_group);
      if (!g) return send(route, 404, { message: "That group does not exist." });
      return send(route, 200, { ...g, members: [{ user_id: UID, name: "Harness User", role: "owner" }], muted: false, pinned: null, canPost: true });
    }
    if (name === "group_messages_list") return send(route, 200, messages.get(body.p_group) || []);
    if (name === "group_send") {
      calls.group_send += 1;
      const list = messages.get(body.p_group) || [];
      const row = { id: `m${list.length + 1}`, group_id: body.p_group, body: body.p_body, author_id: UID, author_name: "Harness User", created_at: new Date().toISOString(), kind: "text" };
      list.push(row);
      messages.set(body.p_group, list);
      return send(route, 200, row);
    }
    if (name === "community_messages_list") return send(route, 200, []);
    if (name === "community_send") { calls.community_send += 1; return send(route, 200, { id: "c1", body: body.p_body }); }
    return send(route, 200, "[]");
  }
  const table = Object.keys(ROWS).find((n) => path.includes(`/rest/v1/${n}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

/* Is the element on screen and not covered by something else at its centre? */
async function tappable(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const inside = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
    /* A success toast is transient and may sit over the composer for a few
       seconds; it is not what this check is about, so it is ignored. */
    const under = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .filter((node) => !node.closest?.(".toast-region"));
    const top = under[0];
    const covered = !(top && (top === el || el.contains(top)));
    const cover = top && top !== el && !el.contains(top) ? (top.id ? `#${top.id}` : top.className ? String(top.className).slice(0, 80) : top.tagName) : "";
    return { found: true, inside, covered, cover, box: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } };
  }, selector);
}

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  calls.group_create = 0; calls.group_send = 0; calls.community_send = 0;
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/app/?view=messages&tab=groups`, { waitUntil: "load" });
  await page.waitForSelector("#grp-list .chat-item", { timeout: 20000 });
  await page.waitForTimeout(300);

  const newBtn = await tappable(page, "#grp-new");
  ok("the New group button is on screen and tappable", newBtn.found && newBtn.inside && !newBtn.covered, JSON.stringify(newBtn));

  await page.click("#grp-new");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const dialogOpen = await dialog.isVisible().catch(() => false);
  ok("New group opens the form", dialogOpen);
  if (dialogOpen) {
    await page.screenshot({ path: `${SHOTS}/flow-${vp.name}-new-group.png` });
    const nameInput = dialog.locator("input[name='name'], input").first();
    await nameInput.fill("Launch team");
    const submit = dialog.getByRole("button", { name: /create group/i });
    const submitBox = await submit.boundingBox().catch(() => null);
    const inView = submitBox && submitBox.y >= 0 && submitBox.y + submitBox.height <= vp.height + 1;
    ok("the Create group button is inside the viewport", !!inView, JSON.stringify(submitBox));
    await submit.click();
  }
  await page.waitForSelector("#grp-compose:not([hidden])", { timeout: 10000 }).catch(() => {});
  const head = (await page.locator("#grp-head").innerText().catch(() => "")).trim();
  ok("the new group opens with its name", /Launch team/.test(head), `head "${head.slice(0, 60)}"`);
  ok("a group is created on the server", calls.group_create === 1, `calls ${calls.group_create}`);

  if (process.env.DEBUG_BOXES) {
    const boxes = await page.evaluate(() => ["#grp-list", ".hub", ".hub-rail", ".hub-rail-groups", ".chat-pane-thread", "#grp-head", "#grp-messages", "#grp-compose", "#grp-body", "#grp-info-col"].map((sel) => {
      const el = document.querySelector(sel); if (!el) return [sel, null];
      const r = el.getBoundingClientRect(); return [sel, { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom), w: Math.round(r.width), disp: getComputedStyle(el).display, hidden: el.hidden }];
    }));
    console.log(JSON.stringify(boxes));
  }
  /* On a wide screen the new group also opens its details (the existing
     behaviour). That modal is dismissed before the composer is checked. */
  const closeBtn = page.locator(".modal-backdrop [data-modal-close]");
  await closeBtn.first().waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
  if (await closeBtn.first().isVisible().catch(() => false)) {
    await closeBtn.first().click();
    await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  }
  const compose = await tappable(page, "#grp-compose");
  const bodyBox = await tappable(page, "#grp-body");
  ok("the composer is shown after creating the group", compose.found && !(await page.locator("#grp-compose").isHidden()));
  ok("the message box is on screen and usable", bodyBox.found && bodyBox.inside && !bodyBox.covered, JSON.stringify(bodyBox));

  await page.fill("#grp-body", "Hello from the phone");
  await page.click("#grp-send");
  await page.waitForFunction(() => document.querySelector("#grp-messages")?.innerText.includes("Hello from the phone"), null, { timeout: 8000 }).catch(() => {});
  const sent = await page.locator("#grp-messages").innerText();
  ok("a message can be sent and appears in the thread", sent.includes("Hello from the phone") && calls.group_send === 1, `sends ${calls.group_send}`);
  await page.screenshot({ path: `${SHOTS}/flow-${vp.name}-group.png` });

  /* Channels: open a public channel from the Community page and post in it. */
  await page.goto(`${BASE}/app/?view=community`, { waitUntil: "load" });
  await page.waitForSelector("#grp-channels [data-channel]", { timeout: 20000 });
  await page.click("#grp-channels [data-channel='general']");
  await page.waitForSelector("#grp-compose:not([hidden])", { timeout: 10000 }).catch(() => {});
  const chHead = (await page.locator("#grp-head").innerText().catch(() => "")).trim();
  ok("a channel opens from the list", /General/.test(chHead), `head "${chHead.slice(0, 40)}"`);
  const chBody = await tappable(page, "#grp-body");
  ok("the channel composer is on screen and usable", chBody.found && chBody.inside && !chBody.covered, JSON.stringify(chBody));
  await page.fill("#grp-body", "Hi channel");
  await page.click("#grp-send");
  await page.waitForTimeout(600);
  ok("a message can be posted to a channel", calls.community_send === 1, `posts ${calls.community_send}`);
  await page.screenshot({ path: `${SHOTS}/flow-${vp.name}-channel.png` });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal page overflow", overflow <= 1, `overflow ${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll mobile-groups-flow checks passed");
process.exit(bad ? 1 : 0);
