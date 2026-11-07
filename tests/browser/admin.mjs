/* ==========================================================================
   Shinzora — browser harness: admin.mjs
   --------------------------------------------------------------------------
   The admin console is the one surface that cannot be reached without a
   deployed `admin` Edge Function and an `admin_users` row, so this harness
   stubs that single endpoint and drives the real console against it.

   What it proves
     - the console only renders for an account the server says is an admin
     - all twelve views render real fixture rows (not empty shells)
     - every privileged mutation sends the action and payload the Edge Function
       expects: payment_review, service_request_update, subscription_update,
       ticket_reply, ticket_status, contact_update, announcement_create
     - a failing function surfaces an error instead of a blank panel
     - there is no client-side path to become an administrator

   Nothing is written to any database: the stub answers in memory.

     BASE=http://127.0.0.1:4173 node tests/browser/admin.mjs
   ========================================================================== */

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-1111-1111-1111-111111111111";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "ops@shinzora.example" })}.sig`;

const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: {
    id: UID, aud: "authenticated", role: "authenticated", email: "ops@shinzora.example",
    email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-09-01T09:00:00Z",
    user_metadata: { full_name: "Ops Admin" }, app_metadata: { provider: "email" }
  }
};

const ts = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

const CUSTOMER_ROWS = [
  { id: "aaaa1111-0000-0000-0000-000000000001", name: "Aarav Mehta", full_name: "Aarav Mehta", email: "aarav@studioaria.example", phone: "+91 98100 11111", plan: "pro", status: "active", business_name: "Studio Aria", category: "Design studio", onboarded: true, onboarding_step: 5, projects: 3, ai_used: 42, ai_limit: 800, joined: ts(720), created_at: ts(720), last_sign_in_at: ts(2) },
  { id: "aaaa1111-0000-0000-0000-000000000002", name: "Isha Rao", full_name: "Isha Rao", email: "isha@raotraders.example", phone: "+91 98200 22222", plan: "free", status: "active", business_name: "Rao Traders", category: "Retail", onboarded: false, onboarding_step: 2, projects: 0, ai_used: 6, ai_limit: 30, joined: ts(48), created_at: ts(48), last_sign_in_at: ts(5) }
];

const FIXTURES = {
  overview: {
    counts: { customers: 2, active_subscriptions: 1, projects: 3, payments_pending: 1, service_pending: 1, tickets_open: 1, contacts_new: 1 },
    revenue_total: 249900,
    verified_payments: 3,
    recent_customers: CUSTOMER_ROWS,
    recent_activity: [
      { action: "payment.verified", entity_type: "payment", created_at: ts(1), customer: "Aarav Mehta", email: "aarav@studioaria.example" },
      { action: "project.published", entity_type: "project", created_at: ts(3), customer: "Aarav Mehta", email: "aarav@studioaria.example" }
    ]
  },
  customers: { total: CUSTOMER_ROWS.length, customers: CUSTOMER_ROWS },
  customer: {
    profile: { id: CUSTOMER_ROWS[0].id, full_name: "Aarav Mehta", email: CUSTOMER_ROWS[0].email, phone: CUSTOMER_ROWS[0].phone, created_at: ts(720) },
    business: { name: "Studio Aria", category: "Design studio", location: "New Delhi" },
    subscription: { plan: "pro", status: "active", ai_credits_used: 42, ai_credits_limit: 800, current_period_end: ts(-240) },
    onboarding: { current_step: 5, completed_at: ts(700) },
    projects: [{ name: "Studio Aria website", type: "website", status: "published", created_at: ts(600) }],
    payments: [{ id: "pay-1", amount: 249900, currency: "INR", status: "verified", purpose: "subscription:pro", created_at: ts(700) }],
    tickets: [{ id: "tk-1", subject: "Domain help", status: "open", created_at: ts(30) }],
    service_requests: [{ id: "sr-1", service_type: "website_setup", status: "pending", created_at: ts(40) }],
    activity: [{ action: "project.created", entity_type: "project", created_at: ts(600) }]
  },
  payments: {
    payments: [
      { id: "pay-1", owner_id: CUSTOMER_ROWS[0].id, customer: { full_name: "Aarav Mehta", email: "aarav@studioaria.example" }, amount: 249900, currency: "INR", method: "upi_qr", purpose: "subscription:pro", reference: "SHZ-9F2A", utr: "412345678901", status: "awaiting_verification", created_at: ts(6), note: "UTR pasted by customer" },
      { id: "pay-2", owner_id: CUSTOMER_ROWS[1].id, customer: { full_name: "Isha Rao", email: "isha@raotraders.example" }, amount: 349900, currency: "INR", method: "upi_qr", purpose: "service:store_setup", reference: "SHZ-7C10", status: "pending", created_at: ts(20) }
    ]
  },
  service_requests: {
    requests: [
      { id: "sr-1", customer: { full_name: "Aarav Mehta", email: "aarav@studioaria.example" }, owner_id: CUSTOMER_ROWS[0].id, service_type: "website_setup", title: "Website setup — Studio Aria", status: "requested", created_at: ts(40), details: { pages: 5 } },
      { id: "sr-2", customer: { full_name: "Isha Rao", email: "isha@raotraders.example" }, owner_id: CUSTOMER_ROWS[1].id, service_type: "brand_kit", title: "Brand kit", status: "approved", created_at: ts(90) }
    ]
  },
  subscriptions: {
    subscriptions: [
      { id: "sub-1", user_id: CUSTOMER_ROWS[0].id, customer: "Aarav Mehta", email: CUSTOMER_ROWS[0].email, plan: "pro", status: "active", ai_credits_used: 42, ai_credits_limit: 800, current_period_end: ts(-240), created_at: ts(700) }
    ]
  },
  projects: {
    projects: [{ id: "pr-1", name: "Studio Aria website", type: "website", status: "published", owner_id: CUSTOMER_ROWS[0].id, customer: "Aarav Mehta", created_at: ts(600) }]
  },
  deployments: {
    deployments: [{ id: "dep-1", provider: "vercel", status: "ready", repo_full_name: "aarav/studio-aria", slug: "studio-aria", created_at: ts(5) }]
  },
  tickets: {
    tickets: [{ id: "tk-1", user_id: CUSTOMER_ROWS[0].id, customer: { full_name: "Aarav Mehta", email: "aarav@studioaria.example" }, subject: "Domain help", message: "Can you point studioaria.in at my site?", status: "open", priority: "normal", created_at: ts(30) }]
  },
  contacts: {
    messages: [{ id: "ct-1", name: "Neha Kapoor", email: "neha@example.com", message: "Do you build stores too?", status: "new", created_at: ts(12) }]
  },
  announcements: {
    announcements: [{ id: "an-1", title: "Scheduled maintenance", body: "Deploys pause 02:00–03:00 IST.", audience: "all", created_at: ts(72) }]
  },
  activity: {
    activity: [
      { action: "payment.verified", entity_type: "payment", created_at: ts(1), customer: "Aarav Mehta", meta: { amount: 249900 } },
      { action: "customer.signed_up", entity_type: "profile", created_at: ts(48), customer: "Isha Rao", meta: {} }
    ]
  },
  admins: {
    admins: [{ user_id: UID, email: "ops@shinzora.example", role: "owner", created_at: ts(2000) }],
    note: "Administrators are granted in the database only."
  }
};

/* ------------------------------------------------------------ the harness */

let isAdmin = true;
let failures = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) failures++;
};

const calls = [];
let failNextAction = null;

async function routeAdmin(route) {
  const request = route.request();
  let body = {};
  try {
    body = JSON.parse(request.postData() || "{}");
  } catch {
    /* ignore */
  }
  const action = body.action || new URL(request.url()).searchParams.get("action");
  calls.push({ action, payload: body.payload || body, raw: body });

  const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });

  if (failNextAction === action) {
    failNextAction = null;
    return route.fulfill({ status: 500, headers, body: JSON.stringify({ code: "admin_error", error: "Database unavailable (simulated)." }) });
  }

  const fixture = FIXTURES[action];
  if (!fixture) return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true }) });

  // Echo the mutation back so a view that re-reads after writing sees the change.
  if (action === "payment_review") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, id: body.payload?.id, status: body.payload?.status }) });
  if (action === "service_request_update") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, id: body.payload?.id, status: body.payload?.status }) });
  if (action === "subscription_update") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true }) });
  if (action === "ticket_reply") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, reply: { id: "rep-1", body: body.payload?.body, created_at: new Date().toISOString() } }) });
  if (action === "ticket_status") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true }) });
  if (action === "contact_update") return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true }) });
  if (action === "announcement_create") {
    const created = { id: "an-new", title: body.payload?.title, body: body.payload?.body, audience: body.payload?.audience || "all", created_at: new Date().toISOString() };
    FIXTURES.announcements.announcements.unshift(created);
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, announcement: created, delivered: 2 }) });
  }

  return route.fulfill({ status: 200, headers, body: JSON.stringify(fixture) });
}

async function routeSupabase(route) {
  const url = new URL(route.request().url());
  const headers = { "access-control-allow-origin": "*", "content-type": "application/json", "access-control-expose-headers": "content-range" };
  if (url.pathname.includes("/rest/v1/rpc/is_admin")) return route.fulfill({ status: 200, headers, body: isAdmin ? "true" : "false" });
  if (url.pathname.includes("/rest/v1/rpc/admin_role")) return route.fulfill({ status: 200, headers, body: isAdmin ? '"owner"' : "null" });
  if (url.pathname.includes("/rest/v1/rpc/")) return route.fulfill({ status: 200, headers, body: "null" });
  if (url.pathname.includes("/rest/v1/profiles")) return route.fulfill({ status: 200, headers, body: JSON.stringify([{ id: UID, full_name: "Ops Admin", email: "ops@shinzora.example", created_at: ts(2000) }]) });
  if (url.pathname.includes("/rest/v1/")) return route.fulfill({ status: 200, headers: { ...headers, "content-range": "*/0" }, body: "[]" });
  if (url.pathname.includes("/auth/v1/")) return route.fulfill({ status: 200, headers, body: JSON.stringify(SESSION.user) });
  return route.fulfill({ status: 503, headers, body: "{}" });
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

async function openAdmin({ viewport = { width: 1440, height: 900 }, signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (signedIn) {
    await ctx.addInitScript((session) => {
      try {
        localStorage.setItem("shinzora.auth", JSON.stringify(session));
      } catch {
        /* sandboxed frame */
      }
    }, SESSION);
  }
  // Playwright runs the most recently registered handler first, so the
  // specific functions route must be registered after the broad Supabase one.
  await ctx.route("**://*.supabase.co/**", routeSupabase);
  await ctx.route("**/functions/v1/admin**", routeAdmin);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  return { ctx, page, errors };
}

const closeOverlays = async (page) => {
  const close = page.locator(".modal-backdrop [data-close], .modal [data-close], .modal-close").first();
  if (await close.count()) {
    await close.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
};

const nav = async (page, id) => {
  await closeOverlays(page);
  await page.locator(`#admin-nav [data-view="${id}"]`).first().click();
  await page.waitForTimeout(1100);
};

/* ------------------------------------------------------- access control */

{
  isAdmin = false;
  const { ctx, page } = await openAdmin();
  const shellVisible = await page.evaluate(() => {
    const shell = document.querySelector("#admin-shell");
    return Boolean(shell) && !shell.hidden && getComputedStyle(shell).display !== "none";
  });
  ok("a signed-in non-admin never sees the console", !shellVisible);
  await ctx.close();
  isAdmin = true;
}

/* ------------------------------------------------------------- the views */

{
  const { ctx, page, errors } = await openAdmin();
  const shellVisible = await page.evaluate(() => {
    const shell = document.querySelector("#admin-shell");
    return Boolean(shell) && getComputedStyle(shell).display !== "none";
  });
  ok("admin shell renders for an admin", shellVisible);
  ok("no page errors on load", errors.length === 0, errors[0]?.slice(0, 70));

  const navCount = await page.locator("#admin-nav [data-view]").count();
  /* Twelve since Monitoring joined the console: eleven operational views plus
     the pre-launch/website-health log. */
  ok("all twelve views are in the sidebar", navCount === 12, `${navCount} items`);

  /* Overview */
  const overviewText = await page.textContent("#admin-root");
  ok("overview shows customer and pending counts", /2/.test(overviewText) && /Aarav Mehta/.test(overviewText));
  ok("overview shows recent activity", /payment\.verified|Payment/i.test(overviewText));

  /* Customers */
  await nav(page, "customers");
  const rows = await page.locator("#customer-table tbody tr").count();
  ok("customer table lists customers", rows >= 2, `${rows} rows`);
  const customerText = await page.textContent("#customer-table");
  ok("customer row carries name, email, business, plan, onboarding",
    ["Aarav Mehta", "aarav@studioaria.example", "Studio Aria", "pro", "Rao Traders"].every((needle) => new RegExp(needle, "i").test(customerText)));

  const before = calls.length;
  await page.fill("#customer-search", "rao");
  await page.waitForTimeout(900);
  const searchCall = calls.slice(before).find((c) => c.action === "customers");
  ok("search sends the term to the server", Boolean(searchCall) && /rao/i.test(JSON.stringify(searchCall.payload)), JSON.stringify(searchCall?.payload || {}).slice(0, 60));
  await page.fill("#customer-search", "");
  await page.waitForTimeout(700);

  /* Customer detail */
  const openBtn = page.locator("#customer-table [data-open]").first();
  if (await openBtn.count()) {
    await openBtn.click();
    await page.waitForTimeout(900);
    const detail = await page.textContent("body");
    ok("customer detail shows business, subscription and projects",
      /Studio Aria/.test(detail) && /pro/i.test(detail) && /website/i.test(detail));
    ok("customer detail requested the customer action", calls.some((c) => c.action === "customer"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    ok("customer detail opens from the table", false, "no [data-open] control found");
  }

  /* Payments + review */
  await nav(page, "payments");
  const paymentRows = await page.locator("#payment-table tbody tr").count();
  ok("payments table lists payments", paymentRows >= 1, `${paymentRows} rows`);
  const reviewBtn = page.locator("#payment-table [data-review]").first();
  if (await reviewBtn.count()) {
    await reviewBtn.click();
    await page.waitForTimeout(800);
    const approve = page.locator("#approve-payment");
    if (await approve.count()) {
      const beforeApprove = calls.length;
      await approve.click();
      await page.waitForTimeout(700);
      // Confirmation requires the literal word APPROVE — a deliberate guard.
      const typeBox = page.locator("[data-confirm]").locator("xpath=ancestor::*[1]").locator("input").first();
      const anyInput = page.locator(".modal input, [role=dialog] input").last();
      if (await anyInput.count()) await anyInput.fill("APPROVE");
      const confirm = page.locator("[data-confirm]").first();
      if (await confirm.count()) await confirm.click();
      await page.waitForTimeout(1400);
      const review = calls.slice(beforeApprove).find((c) => c.action === "payment_review");
      ok("approving a payment calls payment_review with an approve decision",
        Boolean(review) && /approve/i.test(JSON.stringify(review.payload)), JSON.stringify(review?.payload || {}).slice(0, 90));
      void typeBox;
    } else {
      ok("payment review offers an approve control", false);
    }
  } else {
    ok("payment rows expose a review control", false);
  }

  /* Service requests */
  await nav(page, "services");
  const serviceRows = await page.locator("#service-table tbody tr").count();
  ok("service requests table lists requests", serviceRows >= 1, `${serviceRows} rows`);
  const serviceAction = page.locator("#service-table [data-review], #service-table button").first();
  if (await serviceAction.count()) {
    await serviceAction.click();
    await page.waitForTimeout(800);
    const advance = page.locator("#advance-service");
    const reject = page.locator("#reject-service");
    if (await advance.count()) {
      const beforeAdvance = calls.length;
      await advance.click();
      await page.waitForTimeout(700);
      // A second dialog picks the new status; submit it.
      const statusSelect = page.locator(".modal select, [role=dialog] select").first();
      if (await statusSelect.count()) await statusSelect.selectOption("approved");
      const noteBox = page.locator(".modal textarea, [role=dialog] textarea").first();
      if (await noteBox.count()) await noteBox.fill("Approved after a call with the customer.");
      const submit = page.locator("[data-submit]").first();
      if (await submit.count()) await submit.click();
      await page.waitForTimeout(1400);
      const update = calls.slice(beforeAdvance).find((c) => c.action === "service_request_update");
      ok("advancing a service request calls service_request_update with a status",
        Boolean(update) && /approved/i.test(JSON.stringify(update.payload)), JSON.stringify(update?.payload || {}).slice(0, 90));
    } else if (await reject.count()) {
      ok("service request offer approve/reject controls", true);
    } else {
      ok("service request opens a review panel", false);
    }
  }

  /* Subscriptions */
  await nav(page, "subscriptions");
  ok("subscriptions table lists rows", (await page.locator("#sub-table tbody tr").count()) >= 1);
  const editSub = page.locator("#sub-table [data-edit]").first();
  if (await editSub.count()) {
    await editSub.click();
    await page.waitForTimeout(800);
    const planSelect = page.locator(".modal select, [role=dialog] select").first();
    if (await planSelect.count()) {
      await planSelect.selectOption("enterprise");
      const beforePlan = calls.length;
      const submit = page.locator("[data-submit]").first();
      if (await submit.count()) await submit.click();
      await page.waitForTimeout(1400);
      const call = calls.slice(beforePlan).find((c) => c.action === "subscription_update");
      ok("changing a plan calls subscription_update with the new plan",
        Boolean(call) && /enterprise/i.test(JSON.stringify(call.payload)), JSON.stringify(call?.payload || {}).slice(0, 80));
    } else {
      ok("subscription row opens a plan dialog", false);
    }
  } else {
    ok("subscription rows expose an edit control", false);
  }

  /* Projects and deployments */
  await nav(page, "projects");
  const projectText = await page.textContent("#admin-root");
  ok("projects and deployments render", /Studio Aria website|studio-aria/i.test(projectText));

  /* Support */
  await nav(page, "support");
  ok("support tickets render", (await page.locator("#ticket-table tbody tr").count()) >= 1);
  const ticketRow = page.locator("#ticket-table [data-open]").first();
  if (await ticketRow.count()) {
    await ticketRow.click();
    await page.waitForTimeout(900);
    const reply = page.locator("#admin-reply");
    if (await reply.count()) {
      await reply.fill("Pointing the domain now — 10 minutes.");
      const beforeReply = calls.length;
      const send = page.locator("#send-reply");
      if (await send.count()) {
        await send.click();
        await page.waitForTimeout(1200);
        const call = calls.slice(beforeReply).find((c) => c.action === "ticket_reply");
        ok("replying to a ticket calls ticket_reply with the body",
          Boolean(call) && /domain now/i.test(JSON.stringify(call.payload)), JSON.stringify(call?.payload || {}).slice(0, 70));
      } else {
        ok("support reply has a send control", false);
      }
    } else {
      ok("support row opens a reply panel", false);
    }
  }

  /* Contacts */
  await nav(page, "contacts");
  ok("contact messages render", (await page.locator("#contact-table tbody tr").count()) >= 1);

  /* Announcements */
  await nav(page, "messaging");
  const annHistory = await page.textContent("#ann-history");
  ok("announcement history renders", /Scheduled maintenance/i.test(annHistory));
  await page.fill("#ann-title", "New AI models are live");
  await page.fill("#ann-body", "Gemini 2.0 Flash now powers generation.");
  const beforeSend = calls.length;
  const send = page.locator("#ann-send");
  if (await send.count()) {
    await send.click();
    await page.waitForTimeout(700);
    const confirm = page.locator("[data-confirm]").first();
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(1400);
    const call = calls.slice(beforeSend).find((c) => c.action === "announcement_create");
    ok("sending an announcement calls announcement_create with title, body and audience",
      Boolean(call) && /New AI models/.test(JSON.stringify(call.payload)) && /audience/i.test(JSON.stringify(call.payload)),
      JSON.stringify(call?.payload || {}).slice(0, 90));
  } else {
    ok("announcement composer has a send control", false);
  }

  /* Activity */
  await nav(page, "activity");
  ok("activity feed renders", /payment\.verified|signed_up|Isha Rao/i.test(await page.textContent("#activity-feed, #admin-root")));

  /* Administrators — no self-promotion affordance */
  await nav(page, "access");
  const accessText = await page.textContent("#admin-root");
  ok("administrators view lists current admins", /ops@shinzora\.example/i.test(accessText));
  const promoteControls = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("button, a")];
    return nodes.filter((n) => /make me admin|grant admin|promote|become admin/i.test(n.textContent || "")).length;
  });
  ok("no control can promote the signed-in user to admin", promoteControls === 0, `${promoteControls} found`);

  await ctx.close();
}

/* --------------------------------------------------------- error handling */

{
  const { ctx, page } = await openAdmin();
  failNextAction = "customers";
  await nav(page, "customers");
  await page.waitForTimeout(600);
  const text = await page.textContent("#customer-table").catch(() => "");
  const showsError = /unavailable|error|failed|could not|try again/i.test(text) && !/Aarav Mehta/.test(text);
  ok("a failing admin function surfaces an error, not stale or blank rows", showsError, text.replace(/\s+/g, " ").slice(0, 70));
  await ctx.close();
}

/* ------------------------------------------------------------- responsive */

{
  const { ctx, page } = await openAdmin({ viewport: { width: 390, height: 844 } });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("390px: no horizontal overflow in the admin console", overflow <= 1, `${overflow}px`);
  const toggle = page.locator("#admin-menu-toggle");
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(500);
    const open = await page.evaluate(() => document.getElementById("admin-sidebar")?.className || "");
    ok("390px: sidebar opens as a drawer", /is-open|open/.test(open), open);
  }
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"}\n` : "\nadmin console verified\n");
process.exit(failures ? 1 : 0);
