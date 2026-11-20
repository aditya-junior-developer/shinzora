/* ==========================================================================
   Shinzora — browser harness: investor portal (phase 3)
   --------------------------------------------------------------------------
   Signs in as an investor and as an owner, and stubs *the network*: Supabase
   RPCs, table reads and storage answer from fixture rows. Each RPC call and each
   storage upload is recorded, so the test can check what the buttons send. The
   app code path is the real one. Nothing is written to any database.

   It checks:
     Messages (investor)  inbox with unread counts, opening a thread marks it
                          read, sending calls send_direct_message and shows the
                          message, ?conversation= opens directly, unknown ids
                          show a notice, phone layout switches panes (390 px)
     Requests (investor)  status tabs and counts, the actions each status allows,
                          accept/decline ask first, "request more info" validates
                          its text, express interest, message owner, signed file
                          links
     Owner pitches        the send form validates, creates the pitch, uploads each
                          file under <pitch_id>/, records it, and the tracker and
                          the message dialog work
     no page errors on any of these pages

     BASE=http://127.0.0.1:4173 node tests/browser/investor-phase3.mjs
   ========================================================================== */

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = Math.floor(Date.now() / 1000);

const INVESTOR = { uid: "00000000-0000-0000-0000-00000000000b", type: "investor", name: "Asha Rao", username: "asha" };
const OWNER = { uid: "00000000-0000-0000-0000-00000000000f", type: "owner", name: "Ravi Kumar", username: "ravi" };
const CHANDRA = "00000000-0000-0000-0000-00000000000d";
const BUSINESS = "10000000-0000-0000-0000-000000000001";
const PITCH = {
  p1: "f0000000-0000-0000-0000-000000000001",
  p2: "f0000000-0000-0000-0000-000000000002",
  p3: "f0000000-0000-0000-0000-000000000003",
  p4: "f0000000-0000-0000-0000-000000000004",
  sent: "f0000000-0000-0000-0000-000000000009"
};
const CONV = { c1: "d0000000-0000-0000-0000-000000000001", c2: "d0000000-0000-0000-0000-000000000002" };
const NEW_PITCH = "f0000000-0000-0000-0000-0000000000aa";

const sessionFor = (me) => {
  const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: me.uid, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: `${me.username}@example.com` })}.sig`;
  return {
    access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
    user: {
      id: me.uid, aud: "authenticated", role: "authenticated", email: `${me.username}@example.com`,
      email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z",
      user_metadata: { full_name: me.name }, app_metadata: { provider: "email" }
    }
  };
};

const iso = (minsAgo) => new Date(NOW * 1000 - minsAgo * 60000).toISOString();

/* ------------------------------------------------------------- fixtures */

const FX = {
  businesses: [
    { id: BUSINESS, owner_id: OWNER.uid, name: "Bakery Co", category: "Food & beverage", stage: "mvp", location: "Pune", description: "Artisan bakery with three outlets in Pune and a growing wholesale line.", investor_visible: true, funding_requirement_inr: 2500000, created_at: iso(900) }
  ],
  conversations: [
    { conversation_id: CONV.c1, other_user_id: CHANDRA, other_name: "Chandra Iyer", other_avatar: null, last_message_at: iso(12), last_body: "Can we talk on Monday?", unread_count: 2 },
    { conversation_id: CONV.c2, other_user_id: OWNER.uid, other_name: "Ravi Kumar", other_avatar: null, last_message_at: iso(300), last_body: "Thanks for the reply", unread_count: 0 }
  ],
  direct_messages: [
    { id: "a0000000-0000-0000-0000-000000000001", conversation_id: CONV.c1, sender_id: CHANDRA, body: "Hi Asha, saw your profile.", created_at: iso(40) },
    { id: "a0000000-0000-0000-0000-000000000002", conversation_id: CONV.c1, sender_id: CHANDRA, body: "Can we talk on Monday?", created_at: iso(12) },
    { id: "a0000000-0000-0000-0000-000000000003", conversation_id: CONV.c2, sender_id: OWNER.uid, body: "Thanks for the reply", created_at: iso(300) }
  ],
  pitches: [
    { id: PITCH.p1, role: "received", business_id: BUSINESS, business_name: "Bakery Co", counterpart_name: "Ravi Kumar", counterpart_id: OWNER.uid, title: "Seed round for the wholesale line", summary: "We need Rs 25 lakh to open the wholesale line in three cities.", funding_requested_inr: 2500000, status: "pending", info_request: null, attachments: [{ path: `${PITCH.p1}/1-deck.pdf`, name: "deck.pdf", size: 120000, type: "application/pdf" }], created_at: iso(600), updated_at: iso(600) },
    { id: PITCH.p2, role: "received", business_id: BUSINESS, business_name: "Bakery Co", counterpart_name: "Ravi Kumar", counterpart_id: OWNER.uid, title: "Equipment bridge loan", summary: "A short bridge for two ovens.", funding_requested_inr: null, status: "interested", info_request: null, attachments: [], created_at: iso(2000), updated_at: iso(1000) },
    { id: PITCH.p3, role: "received", business_id: BUSINESS, business_name: "Bakery Co", counterpart_name: "Ravi Kumar", counterpart_id: OWNER.uid, title: "Old pitch, already accepted", summary: "Closed earlier this year.", funding_requested_inr: 500000, status: "accepted", info_request: null, attachments: [], created_at: iso(9000), updated_at: iso(8000) },
    { id: PITCH.p4, role: "received", business_id: BUSINESS, business_name: "Bakery Co", counterpart_name: "Ravi Kumar", counterpart_id: OWNER.uid, title: "Question pending", summary: "Waiting on our answer.", funding_requested_inr: 800000, status: "info_requested", info_request: "Which cities do you plan to enter first?", attachments: [], created_at: iso(3000), updated_at: iso(2500) },
    { id: PITCH.sent, role: "sent", business_id: BUSINESS, business_name: "Bakery Co", counterpart_name: "Asha Rao", counterpart_id: INVESTOR.uid, title: "Our first pitch", summary: "Summary of the first pitch.", funding_requested_inr: 1000000, status: "info_requested", info_request: "Need the margin sheet", attachments: [], created_at: iso(500), updated_at: iso(400) }
  ]
};

const calls = [];
const uploads = [];
const signed = [];

/* ---------------------------------------------------------- the stub */

const fulfillJson = (route, body, extra = {}) =>
  route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "content-type": "application/json", ...extra }, body });

function filterRows(rows, url) {
  let out = rows;
  for (const [key, value] of url.searchParams) {
    if (!value.startsWith("eq.")) continue;
    const want = decodeURIComponent(value.slice(3));
    if (!out.length || !(key in out[0])) continue;
    out = out.filter((r) => String(r[key]) === want);
  }
  return out;
}

function profileOf(me) {
  return { id: me.uid, full_name: me.name, email: `${me.username}@example.com`, account_type: me.type, username: me.username, avatar_url: null, created_at: "2026-10-01T09:00:00Z", theme: null, member_type: me.type };
}

function rpcSpec(me) {
  return {
    my_conversations: () => FX.conversations,
    my_pitches: () => FX.pitches,
    mark_conversation_read: null,
    send_direct_message: (args) => {
      const id = `a1000000-0000-0000-0000-${String(FX.direct_messages.length + 1).padStart(12, "0")}`;
      FX.direct_messages.push({ id, conversation_id: args.p_conversation, sender_id: me.uid, body: String(args.p_body).trim(), created_at: new Date().toISOString() });
      return id;
    },
    open_direct_conversation: (args) => (args.p_user === OWNER.uid ? CONV.c2 : args.p_user === CHANDRA ? CONV.c1 : "00000000-0000-0000-0000-00000000dead"),
    investor_respond_pitch: (args) => {
      const p = FX.pitches.find((x) => x.id === args.p_pitch);
      if (p) {
        p.status = args.p_status;
        if (args.p_status === "info_requested") p.info_request = args.p_info;
      }
      return args.p_status;
    },
    investor_directory: { count: 1, investors: [{ userId: CHANDRA, username: "chandra", name: "Chandra Iyer" }] },
    send_pitch: (args) => {
      FX.pitches.unshift({ id: NEW_PITCH, role: "sent", business_id: args.p_business, business_name: "Bakery Co", counterpart_name: "Chandra Iyer", counterpart_id: args.p_investor, title: args.p_title, summary: args.p_summary, funding_requested_inr: args.p_funding, status: "pending", info_request: null, attachments: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return NEW_PITCH;
    },
    add_pitch_attachment: (args) => {
      const p = FX.pitches.find((x) => x.id === args.p_pitch);
      if (p) p.attachments = [...p.attachments, { path: args.p_path, name: args.p_name, size: args.p_size, type: args.p_type }];
      return null;
    },
    investor_dashboard: { listed_businesses: 1, public_investors: 1, connections: 0, pending_requests_in: 0, open_pitches: 1, unread_messages: 2 },
    investor_marketplace: [],
    investor_network_directory: [],
    my_connections: []
  };
}

function stubFor(me) {
  const spec = rpcSpec(me);
  return async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path.includes("/rest/v1/rpc/")) {
      const name = path.split("/rest/v1/rpc/")[1];
      let body = null;
      try { body = req.postDataJSON(); } catch { body = null; }
      calls.push({ name, args: body || {}, who: me.type });
      if (!(name in spec)) return fulfillJson(route, "[]");
      const value = typeof spec[name] === "function" ? spec[name](body || {}) : spec[name];
      if (value === null) return fulfillJson(route, "null");
      return fulfillJson(route, JSON.stringify(value));
    }

    if (path.includes("/rest/v1/")) {
      const table = path.split("/rest/v1/")[1];
      if (req.method() === "POST" || req.method() === "PATCH") {
        let body = null;
        try { body = req.postDataJSON(); } catch { body = null; }
        calls.push({ name: `write:${table}`, args: body || {}, who: me.type, method: req.method() });
        return fulfillJson(route, JSON.stringify(Array.isArray(body) ? body[0] : body || {}));
      }
      let rows = [];
      if (table === "profiles") rows = [profileOf(me)];
      else if (table === "investor_profiles") rows = me.type === "investor" ? [{ user_id: me.uid, display_name: me.name, headline: "Seed investor", bio: "I back early founders.", interests: [], preferred_industries: [], portfolio: "", visibility: "public", connections_open: true }] : [];
      else if (table === "businesses") rows = FX.businesses.filter((b) => b.owner_id === me.uid || me.type === "investor");
      else if (FX[table]) rows = FX[table];
      rows = filterRows(rows, url);
      return fulfillJson(route, JSON.stringify(rows), { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
    }

    if (path.includes("/storage/v1/object/sign/pitch-attachments/")) {
      const file = decodeURIComponent(path.split("/storage/v1/object/sign/pitch-attachments/")[1]);
      signed.push(file);
      return fulfillJson(route, JSON.stringify({ signedURL: `/object/sign/pitch-attachments/${file}?token=t` }));
    }
    if (req.method() === "POST" && path.includes("/storage/v1/object/pitch-attachments/")) {
      const file = decodeURIComponent(path.split("/storage/v1/object/pitch-attachments/")[1]);
      uploads.push(file);
      return fulfillJson(route, JSON.stringify({ Key: `pitch-attachments/${file}` }));
    }
    if (req.method() === "GET" && path.includes("/storage/v1/object/sign/pitch-attachments/")) {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/pdf" }, body: "%PDF-1.4 harness" });
    }
    if (path.includes("/auth/v1/")) return fulfillJson(route, JSON.stringify(sessionFor(me).user));
    return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: '{"error":"not in this harness"}' });
  };
}

async function open(browser, { width, height }, me, url) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((session) => {
    try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed frame */ }
  }, sessionFor(me));
  await ctx.route("**://*.supabase.co/**", stubFor(me));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const page_wait_shot = async (page, path) => { await page.waitForTimeout(500); await page.screenshot({ path }); };
let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};
const callsOf = (name) => calls.filter((c) => c.name === name);
const lastCall = (name) => [...calls].reverse().find((c) => c.name === name);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/* ----------------------------------------------------------- scenarios */

async function messages(browser) {
  console.log("\n[Messages — investor, 1440px]");
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, INVESTOR, "/app/?view=investor-messages");
  const items = await page.locator(".dm-item").count();
  ok("inbox lists both conversations", items === 2, `count ${items}`);
  const unread = await page.locator(".dm-item.is-unread .link-badge").first().textContent().catch(() => "");
  ok("unread count shows on the conversation", unread.trim() === "2", `badge "${unread.trim()}"`);
  const times = await page.locator(".dm-item time").count();
  ok("each conversation shows a timestamp", times === 2);

  await page.locator(`.dm-item[data-open="${CONV.c1}"]`).click();
  await page.waitForTimeout(800);
  const bubbles = await page.locator(".dm-bubble").count();
  ok("opening a conversation shows its messages", bubbles === 2, `bubbles ${bubbles}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/inv3-messages-desktop.png" });
  ok("read marker sent for the opened conversation", callsOf("mark_conversation_read").some((c) => c.args.p_conversation === CONV.c1));
  ok("URL carries the conversation id", page.url().includes(`conversation=${CONV.c1}`));

  const body = "See you on Monday at 11";
  await page.fill("#dm-body", body);
  await page.locator("#dm-compose button[type=submit]").click();
  await page.waitForTimeout(900);
  const sent = lastCall("send_direct_message");
  ok("send calls send_direct_message with the conversation and text", sent?.args.p_conversation === CONV.c1 && sent?.args.p_body === body, JSON.stringify(sent?.args));
  ok("the sent message appears in the thread", (await page.textContent("#dm-stream")).includes(body));
  ok("the sent message is on the right", (await page.locator(".dm-row.is-me .dm-text").count()) >= 1);
  const empty = await page.fill("#dm-body", "   ").then(() => page.locator("#dm-compose button[type=submit]").click()).then(() => page.waitForTimeout(300)).then(() => callsOf("send_direct_message").length);
  ok("blank message is not sent", empty === 1, `send calls ${empty}`);

  ok("no page errors on messages (desktop)", errors.length === 0, errors[0]?.slice(0, 120));
  await ctx.close();

  console.log("\n[Messages — deep link and missing conversation]");
  {
    const s = await open(browser, { width: 1440, height: 900 }, INVESTOR, `/app/?view=investor-messages&conversation=${CONV.c2}`);
    await s.page.waitForTimeout(400);
    ok("?conversation= opens that thread directly", (await s.page.textContent("#dm-main")).includes("Ravi Kumar"));
    await s.ctx.close();
    const m = await open(browser, { width: 1440, height: 900 }, INVESTOR, "/app/?view=investor-messages&conversation=00000000-0000-0000-0000-00000000dead");
    ok("an unknown conversation shows a notice, not a crash", (await m.page.textContent("#dm-main")).includes("not available"));
    ok("unknown conversation: no page errors", m.errors.length === 0);
    await m.ctx.close();
  }

  console.log("\n[Messages — empty inbox]");
  {
    const saved = FX.conversations;
    FX.conversations = [];
    const e = await open(browser, { width: 1440, height: 900 }, INVESTOR, "/app/?view=investor-messages");
    ok("empty inbox explains how to start", (await e.page.textContent("#dm-list")).includes("No conversations yet"));
    FX.conversations = saved;
    await e.ctx.close();
  }

  console.log("\n[Messages — phone, 390px]");
  {
    const m = await open(browser, { width: 390, height: 844 }, INVESTOR, "/app/?view=investor-messages");
    const inboxVisible = await m.page.locator(".dm-inbox").isVisible();
    await page_wait_shot(m.page, "/tmp/inv3-messages-phone.png");
  ok("phone shows the inbox first", inboxVisible);
    await m.page.locator(`.dm-item[data-open="${CONV.c1}"]`).click();
    await m.page.waitForTimeout(500);
    ok("phone switches to the thread", !(await m.page.locator(".dm-inbox").isVisible()) && (await m.page.locator(".dm-main").isVisible()));
    ok("phone shows a Back button", await m.page.locator("[data-back]").isVisible());
    await m.page.locator("[data-back]").click();
    await m.page.waitForTimeout(300);
    ok("Back returns to the inbox", await m.page.locator(".dm-inbox").isVisible());
    ok("no horizontal overflow on phone", (await noOverflow(m.page)) <= 1, `overflow ${await noOverflow(m.page)}px`);
    ok("no page errors on messages (phone)", m.errors.length === 0, m.errors[0]?.slice(0, 120));
    await m.ctx.close();
  }
}

async function requests(browser) {
  console.log("\n[Requests — investor, 1440px]");
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, INVESTOR, "/app/?view=investor-requests");
  const tabText = await page.textContent("#req-tabs");
  ok("status tabs show the counts", /All\s*4/.test(tabText) && /Pending\s*1/.test(tabText) && /Accepted\s*1/.test(tabText), tabText.replace(/\s+/g, " ").trim());
  ok("each request shows the business, funding and sender", (await page.textContent(`[data-pitch="${PITCH.p1}"]`)).includes("Bakery Co") && (await page.textContent(`[data-pitch="${PITCH.p1}"]`)).includes("Rs 25,00,000") && (await page.textContent(`[data-pitch="${PITCH.p1}"]`)).includes("Ravi Kumar"));

  await page.locator('[data-filter="accepted"]').click();
  await page.waitForTimeout(200);
  const acceptedCards = await page.locator(".req-card").count();
  ok("the Accepted tab shows only accepted requests", acceptedCards === 1, `cards ${acceptedCards}`);
  ok("an accepted request has no Accept or Decline button", (await page.locator('.req-card [data-decide="accepted"]').count()) === 0);
  await page.locator('[data-filter="all"]').click();

  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/inv3-requests-desktop.png" });
  const p1 = page.locator(`[data-pitch="${PITCH.p1}"]`);
  ok("a pending request offers accept, decline, interest, question and message", (await p1.locator("[data-decide=accepted]").count()) === 1 && (await p1.locator("[data-decide=declined]").count()) === 1 && (await p1.locator("[data-decide=interested]").count()) === 1 && (await p1.locator("[data-ask]").count()) === 1 && (await p1.locator("[data-message-owner]").count()) === 1);

  console.log("\n[Requests — actions]");
  await p1.locator("[data-decide=interested]").click();
  await page.waitForTimeout(700);
  const interest = lastCall("investor_respond_pitch");
  ok("express interest calls investor_respond_pitch with 'interested'", interest?.args.p_pitch === PITCH.p1 && interest?.args.p_status === "interested", JSON.stringify(interest?.args));
  ok("the card then shows Interested", (await page.textContent(`[data-pitch="${PITCH.p1}"]`)).includes("Interested"));

  await page.locator(`[data-pitch="${PITCH.p1}"] [data-ask]`).click();
  await page.waitForTimeout(400);
  await page.fill("#ask-text", "ab");
  await page.locator("#ask-form button[type=submit]").click();
  await page.waitForTimeout(300);
  ok("a question under three characters is refused", (await page.isVisible("#ask-error")) && callsOf("investor_respond_pitch").length === 1);
  await page.fill("#ask-text", "Please share the cap table and the lease terms.");
  await page.locator("#ask-form button[type=submit]").click();
  await page.waitForTimeout(800);
  const asked = lastCall("investor_respond_pitch");
  ok("a valid question calls investor_respond_pitch with its text", asked?.args.p_status === "info_requested" && asked?.args.p_info === "Please share the cap table and the lease terms.", JSON.stringify(asked?.args));

  await page.locator(`[data-pitch="${PITCH.p2}"] [data-decide=accepted]`).click();
  await page.waitForTimeout(400);
  ok("accept asks for confirmation first", (await page.isVisible(".modal [data-confirm]")) && callsOf("investor_respond_pitch").filter((c) => c.args.p_status === "accepted").length === 0);
  await page.locator(".modal [data-confirm]").click();
  await page.waitForTimeout(800);
  const accepted = lastCall("investor_respond_pitch");
  ok("confirmed accept calls investor_respond_pitch with 'accepted'", accepted?.args.p_pitch === PITCH.p2 && accepted?.args.p_status === "accepted", JSON.stringify(accepted?.args));

  await page.locator(`[data-pitch="${PITCH.p3}"] [data-message-owner]`).click();
  await page.waitForTimeout(800);
  const dm = lastCall("open_direct_conversation");
  ok("message owner opens a conversation with the owner", dm?.args.p_user === OWNER.uid, JSON.stringify(dm?.args));
  ok("message owner opens the Messages page on that conversation", page.url().includes("view=investor-messages") && page.url().includes(`conversation=${CONV.c2}`), page.url());
  await page.waitForTimeout(600);
  ok("the Messages page shows that thread", (await page.textContent("#dm-main")).includes("Ravi Kumar"));

  console.log("\n[Requests — attachments]");
  await page.goto(`${BASE}/app/?view=investor-requests`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await page.locator(`[data-pitch="${PITCH.p1}"] [data-file]`).click();
  const popup = await popupPromise;
  ok("a file opens through a signed link", (await signed.some((f) => f === `${PITCH.p1}/1-deck.pdf`)) && Boolean(popup), `popup ${popup ? popup.url().slice(0, 60) : "none"}`);
  ok("no page errors on requests (desktop)", errors.length === 0, errors[0]?.slice(0, 120));
  await ctx.close();

  console.log("\n[Requests — phone, 390px]");
  const m = await open(browser, { width: 390, height: 844 }, INVESTOR, "/app/?view=investor-requests");
  ok("no horizontal overflow on phone", (await noOverflow(m.page)) <= 1, `overflow ${await noOverflow(m.page)}px`);
  ok("phone: no page errors", m.errors.length === 0, m.errors[0]?.slice(0, 120));
  await m.ctx.close();
}

async function ownerPitches(browser) {
  console.log("\n[Owner — pitches, 1440px]");
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 }, OWNER, "/app/?view=investor-decks");
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/inv3-owner-desktop.png" });
  ok("the owner sees the Pitches you sent panel", (await page.locator("#owner-pitches-title").count()) === 1);
  ok("the tracker shows the status of the pitch sent", (await page.textContent(".owner-pitches")).includes("Investor asked a question") && (await page.textContent(".owner-pitches")).includes("Need the margin sheet"));
  ok("the Send a pitch button is enabled", await page.locator("[data-pitch-new]").isEnabled());

  console.log("\n[Owner — send a pitch]");
  await page.locator("[data-pitch-new]").click();
  await page.waitForTimeout(400);
  await page.fill("#pitch-title", "Hi");
  await page.fill("#pitch-summary", "too short");
  await page.locator("#pitch-form button[type=submit]").click();
  await page.waitForTimeout(400);
  ok("short title and summary are refused", callsOf("send_pitch").length === 0 && (await page.locator('[data-field="title"].invalid').count()) === 1 && (await page.locator('[data-field="summary"].invalid').count()) === 1);

  await page.fill("#pitch-title", "Seed round for the second outlet");
  await page.fill("#pitch-summary", "We will open a second outlet in Bengaluru with Rs 15 lakh of seed funding.");
  await page.fill("#pitch-funding", "1,500,000");
  await page.setInputFiles("#pitch-files", [
    { name: "Deck v2.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 deck") },
    { name: "menu.png", mimeType: "image/png", buffer: Buffer.from("png") }
  ]);
  await page.locator("#pitch-form button[type=submit]").click();
  await page.waitForTimeout(1500);

  const sendCall = lastCall("send_pitch");
  ok("send calls send_pitch with the business, investor, title and funding", sendCall?.args.p_investor === CHANDRA && sendCall?.args.p_title === "Seed round for the second outlet" && sendCall?.args.p_funding === 1500000 && sendCall?.args.p_business === BUSINESS, JSON.stringify(sendCall?.args));
  const names = uploads.filter((u) => u.startsWith(`${NEW_PITCH}/`));
  ok("each file is uploaded under <pitch_id>/", names.length === 2 && names.every((u) => u.startsWith(`${NEW_PITCH}/`)), names.join(", "));
  ok("each uploaded file is recorded with add_pitch_attachment", callsOf("add_pitch_attachment").filter((c) => c.args.p_pitch === NEW_PITCH).length === 2);
  ok("file names are cleaned for storage", names.every((u) => !/\s/.test(u)), names.join(", "));
  ok("the new pitch appears in the tracker", (await page.textContent(".owner-pitches")).includes("Seed round for the second outlet"));

  console.log("\n[Owner — message the investor]");
  const card = page.locator(`.owner-pitches .req-card`).filter({ hasText: "Our first pitch" });
  await card.locator("[data-owner-message]").click();
  await page.waitForTimeout(900);
  const dm = lastCall("open_direct_conversation");
  ok("message investor opens the conversation for that investor", dm?.args.p_user === INVESTOR.uid, JSON.stringify(dm?.args));
  ok("the message dialog opens with a thread", (await page.locator(".modal #dm-compose").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  ok("no page errors on owner pitches (desktop)", errors.length === 0, errors[0]?.slice(0, 120));
  await ctx.close();

  console.log("\n[Owner — pitch panel, phone 390px]");
  const m = await open(browser, { width: 390, height: 844 }, OWNER, "/app/?view=investor-decks");
  ok("phone: no horizontal overflow", (await noOverflow(m.page)) <= 1, `overflow ${await noOverflow(m.page)}px`);
  ok("phone: no page errors", m.errors.length === 0, m.errors[0]?.slice(0, 120));
  await m.ctx.close();
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  await messages(browser);
  await requests(browser);
  await ownerPitches(browser);
} finally {
  await browser.close();
}
if (bad) {
  console.log(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log("\nAll investor phase 3 browser checks passed");
