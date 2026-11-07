/* ==========================================================================
   Shinzora — pre-launch sandbox store (server only)
   --------------------------------------------------------------------------
   The two pre-launch accounts need a workspace that behaves like a real one
   without touching customer data. Everything they read and write lives in this
   file, on the server, in `.prelaunch/sandbox.json` — never in Supabase, never
   in `public/`, so it can never be served as a static asset.

   Tenancy mirrors RLS:
     • role "user"  → rows whose tenant_id matches the session tenant
     • role "admin" → every row, plus the ability to change anything

   Rows are ordinary table rows with the same column names the migrations use,
   so the application queries them unchanged.
   ========================================================================== */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

export const USER_TENANT = "pl_tenant_user";
export const ADMIN_TENANT = "pl_tenant_admin";
export const USER_ACCOUNT = "pl_user_1";
export const ADMIN_ACCOUNT = "pl_admin_1";

let cached = null;
let writeChain = Promise.resolve();

/* ------------------------------------------------------------------ utils */

const iso = (date) => new Date(date).toISOString();
const daysAgo = (days, hours = 0) => iso(Date.now() - days * 86400000 - hours * 3600000);
const daysAhead = (days) => iso(Date.now() + days * 86400000);
const id = (prefix, n) => `${prefix}_${String(n).padStart(3, "0")}`;

/* ------------------------------------------------------------------- seed */

function demoSeed() {
  const T = USER_TENANT;

  /* ---- the pre-launch tester's own business ---- */
  const profiles = [
    {
      id: USER_ACCOUNT,
      tenant_id: T,
      full_name: "Pre-Launch Tester",
      email: "business@business.com",
      phone: "+91 98110 20001",
      avatar_url: null,
      role: "customer",
      created_at: daysAgo(21),
      updated_at: daysAgo(1)
    },
    {
      id: ADMIN_ACCOUNT,
      tenant_id: ADMIN_TENANT,
      full_name: "Shinzora Owner",
      email: "Shinzora@admin",
      phone: "+91 98110 20000",
      avatar_url: null,
      role: "admin",
      created_at: daysAgo(120),
      updated_at: daysAgo(1)
    },
    {
      id: "pl_cust_1",
      tenant_id: "pl_tenant_c1",
      full_name: "Riya Sharma",
      email: "riya@lumenstudio.test",
      phone: "+91 90000 11111",
      avatar_url: null,
      role: "customer",
      created_at: daysAgo(9),
      updated_at: daysAgo(2)
    },
    {
      id: "pl_cust_2",
      tenant_id: "pl_tenant_c2",
      full_name: "Arjun Menon",
      email: "arjun@harborsupply.test",
      phone: "+91 90000 22222",
      avatar_url: null,
      role: "customer",
      created_at: daysAgo(6),
      updated_at: daysAgo(1)
    }
  ];

  const businesses = [
    {
      id: "pl_biz_user",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      name: "Aurora & Co.",
      category: "Home & lifestyle retail",
      description: "Small-batch homeware, candles and ceramics, sold online and at two weekend markets.",
      logo_url: null,
      location: "New Delhi, India",
      website_url: "https://aurora-and-co.test",
      phone: "+91 98110 20001",
      email: "hello@aurora-and-co.test",
      stage: "growing",
      brand_colors: { primary: "#a855f7", accent: "#c4b5fd" },
      website_style: "editorial",
      target_audience: "Urban buyers aged 25-40 furnishing first homes",
      domain_preference: "auroraandco.in",
      goals: ["sell_online", "automate_orders", "grow_instagram"],
      goal_note: "Move weekend-market customers to the online store and stop losing orders in DMs.",
      socials: { instagram: "@auroraandco" },
      created_at: daysAgo(21),
      updated_at: daysAgo(1)
    },
    {
      id: "pl_biz_c1",
      tenant_id: "pl_tenant_c1",
      owner_id: "pl_cust_1",
      name: "Lumen Studio",
      category: "Design services",
      description: "Brand and packaging design studio.",
      logo_url: null,
      location: "Bengaluru, India",
      website_url: null,
      phone: null,
      email: "riya@lumenstudio.test",
      stage: "starting",
      brand_colors: {},
      website_style: "minimal",
      target_audience: "D2C founders",
      domain_preference: null,
      goals: ["get_clients"],
      goal_note: null,
      socials: {},
      created_at: daysAgo(9),
      updated_at: daysAgo(3)
    }
  ];

  const subscriptions = [
    {
      id: "pl_sub_user",
      tenant_id: T,
      user_id: USER_ACCOUNT,
      plan: "pro",
      status: "active",
      business_id: "pl_biz_user",
      ai_credits_used: 34,
      ai_credits_limit: 800,
      ai_period_start: daysAgo(12),
      current_period_end: daysAhead(18),
      created_at: daysAgo(21),
      updated_at: daysAgo(1)
    },
    {
      id: "pl_sub_admin",
      tenant_id: ADMIN_TENANT,
      user_id: ADMIN_ACCOUNT,
      plan: "enterprise",
      status: "active",
      business_id: null,
      ai_credits_used: 12,
      ai_credits_limit: 6000,
      ai_period_start: daysAgo(30),
      current_period_end: daysAhead(30),
      created_at: daysAgo(120),
      updated_at: daysAgo(40)
    },
    {
      id: "pl_sub_c1",
      tenant_id: "pl_tenant_c1",
      user_id: "pl_cust_1",
      plan: "free",
      status: "active",
      business_id: "pl_biz_c1",
      ai_credits_used: 9,
      ai_credits_limit: 30,
      ai_period_start: daysAgo(9),
      current_period_end: daysAhead(21),
      created_at: daysAgo(9),
      updated_at: daysAgo(9)
    }
  ];

  const onboarding_progress = [
    {
      tenant_id: T,
      user_id: USER_ACCOUNT,
      current_step: 5,
      data: { completed: true, source: "prelaunch" },
      completed_at: daysAgo(21),
      created_at: daysAgo(21),
      updated_at: daysAgo(21)
    },
    {
      tenant_id: "pl_tenant_c1",
      user_id: "pl_cust_1",
      current_step: 3,
      data: { completed: false },
      completed_at: null,
      created_at: daysAgo(9),
      updated_at: daysAgo(4)
    }
  ];

  const projects = [
    {
      id: "pl_proj_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      business_id: "pl_biz_user",
      name: "Aurora & Co. storefront",
      description: "Editorial storefront with collection pages, cart and Razorpay-ready checkout.",
      type: "store",
      status: "published",
      slug: "aurora-and-co",
      framework: "static",
      preview_data: { pages: ["home", "shop", "product", "about", "contact"] },
      version_count: 4,
      published_version_id: "pl_pv_4",
      published_at: daysAgo(4),
      created_at: daysAgo(19),
      updated_at: daysAgo(4)
    },
    {
      id: "pl_proj_2",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      business_id: "pl_biz_user",
      name: "Spring collection landing page",
      description: "Campaign page for the spring drop, linked from Instagram.",
      type: "website",
      status: "ready",
      slug: "spring-drop",
      framework: "static",
      preview_data: { pages: ["home"] },
      version_count: 2,
      published_version_id: null,
      published_at: null,
      created_at: daysAgo(6),
      updated_at: daysAgo(2)
    },
    {
      id: "pl_proj_c1",
      tenant_id: "pl_tenant_c1",
      owner_id: "pl_cust_1",
      business_id: "pl_biz_c1",
      name: "Lumen Studio portfolio",
      description: "Minimal portfolio with case studies.",
      type: "website",
      status: "draft",
      slug: "lumen-studio",
      framework: "static",
      preview_data: { pages: ["home", "work"] },
      version_count: 1,
      published_version_id: null,
      published_at: null,
      created_at: daysAgo(8),
      updated_at: daysAgo(3)
    }
  ];

  const project_versions = [
    {
      id: "pl_pv_4",
      tenant_id: T,
      project_id: "pl_proj_1",
      version_number: 4,
      prompt: "Add a spring collection row and tighten the product grid spacing.",
      files: { "index.html": "<!-- generated -->", "styles.css": "/* generated */" },
      meta: { pages: 5, model: "gemini", published: true },
      created_by: USER_ACCOUNT,
      created_at: daysAgo(4)
    },
    {
      id: "pl_pv_3",
      tenant_id: T,
      project_id: "pl_proj_1",
      version_number: 3,
      prompt: "Rewrite the hero copy for the spring launch.",
      files: { "index.html": "<!-- generated -->" },
      meta: { pages: 5, published: false },
      created_by: USER_ACCOUNT,
      created_at: daysAgo(7)
    }
  ];

  const store_products = [
    ["Amber Noir candle", "Amber, cedar and smoked vanilla. 220 g soy wax.", "CND-220", 1290, 42, "active", "Home fragrance"],
    ["Cedar & Fig candle", "Green fig over cedarwood. 220 g soy wax.", "CND-221", 1290, 18, "active", "Home fragrance"],
    ["Ash glaze mug", "Stoneware, 320 ml, dishwasher safe.", "CER-101", 890, 6, "active", "Ceramics"],
    ["Ash glaze bowl", "Stoneware serving bowl, 18 cm.", "CER-102", 1150, 0, "active", "Ceramics"],
    ["Linen table runner", "Stonewashed linen, 180 × 45 cm.", "TXT-301", 1690, 24, "active", "Textiles"],
    ["Ribbed glass vase", "Hand-blown, 21 cm.", "GLS-410", 2190, 9, "active", "Glassware"],
    ["Brass taper holder", "Solid brass, pair.", "MTL-512", 1490, 12, "active", "Metalware"],
    ["Terracotta planter", "Unglazed, 14 cm with drainage tray.", "CER-118", 690, 3, "active", "Ceramics"],
    ["Gift wrap set", "Recycled kraft, twine and a dried sprig.", "PKG-900", 240, 120, "active", "Packaging"],
    ["Winter wreath", "Dried eucalyptus wreath, seasonal.", "DEC-720", 2490, 0, "archived", "Seasonal"]
  ].map((row, index) => ({
    id: id("pl_prd", index + 1),
    tenant_id: T,
    owner_id: USER_ACCOUNT,
    name: row[0],
    description: row[1],
    sku: row[2],
    price: row[3],
    currency: "INR",
    stock: row[4],
    status: row[5],
    image_url: null,
    category: row[6],
    created_at: daysAgo(20 - index),
    updated_at: daysAgo(index % 5)
  }));

  const store_customers = [
    ["Meera Kapoor", "meera.k@example.test", "+91 98111 33333", "New Delhi", "instagram"],
    ["Rohit Bansal", "rohit.b@example.test", "+91 98111 44444", "Gurugram", "referral"],
    ["Sana Qureshi", "sana.q@example.test", "+91 98111 55555", "Mumbai", "market"],
    ["Dev Patel", "dev.p@example.test", "+91 98111 66666", "Ahmedabad", "instagram"],
    ["Nikhil Rao", "nikhil.r@example.test", "+91 98111 77777", "Bengaluru", "returning"],
    ["Isha Nair", "isha.n@example.test", "+91 98111 88888", "Kochi", "market"],
    ["Kabir Sethi", "kabir.s@example.test", "+91 98111 99999", "Chandigarh", "returning"]
  ].map((row, index) => ({
    id: id("pl_cust", index + 1),
    tenant_id: T,
    owner_id: USER_ACCOUNT,
    name: row[0],
    email: row[1],
    phone: row[2],
    city: row[3],
    notes: index === 4 ? "Repeat buyer, prefers gift wrapping." : null,
    source: row[4],
    created_at: daysAgo(18 - index),
    updated_at: daysAgo(index % 4)
  }));

  const orderPlan = [
    ["shipped", 2, ["Amber Noir candle", "Linen table runner"]],
    ["delivered", 4, ["Ash glaze mug"]],
    ["pending", 0, ["Ribbed glass vase", "Brass taper holder"]],
    ["delivered", 7, ["Cedar & Fig candle", "Cedar & Fig candle"]],
    ["cancelled", 9, ["Terracotta planter"]],
    ["delivered", 11, ["Gift wrap set"]],
    ["shipped", 1, ["Ash glaze bowl", "Gift wrap set"]],
    ["packed", 0, ["Linen table runner"]],
    ["delivered", 14, ["Amber Noir candle"]],
    ["pending", 0, ["Terracotta planter", "Ash glaze mug"]],
    ["delivered", 17, ["Ribbed glass vase"]],
    ["refunded", 20, ["Winter wreath"]]
  ];

  const store_orders = orderPlan.map((row, index) => {
    const customer = store_customers[index % store_customers.length];
    const items = row[2];
    const total = items.reduce((sum, name) => {
      const product = store_products.find((entry) => entry.name === name);
      return sum + (product ? product.price : 0);
    }, 0);
    return {
      id: id("pl_ord", index + 1),
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      order_number: `AUR-${1040 + index}`,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_id: customer.id,
      status: row[0],
      total_amount: total,
      currency: "INR",
      payment_method: index % 3 === 0 ? "cod" : "upi",
      notes: index === 2 ? "Leave with the security desk." : null,
      placed_at: daysAgo(row[1], index),
      created_at: daysAgo(row[1], index),
      updated_at: daysAgo(row[1], index)
    };
  });

  const store_order_items = store_orders.flatMap((order, orderIndex) =>
    orderPlan[orderIndex][2].map((name, itemIndex) => {
      const product = store_products.find((entry) => entry.name === name);
      return {
        id: `pl_oi_${orderIndex + 1}_${itemIndex + 1}`,
        tenant_id: T,
        order_id: order.id,
        product_id: product?.id ?? null,
        product_name: name,
        quantity: 1,
        unit_price: product?.price ?? 0,
        currency: "INR",
        created_at: order.created_at
      };
    })
  );

  const campaigns = [
    {
      id: "pl_cmp_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      name: "Spring drop announcement",
      channel: "instagram",
      status: "active",
      goal: "Drive pre-orders for the spring collection",
      budget: 6000,
      currency: "INR",
      start_date: daysAgo(5).slice(0, 10),
      end_date: daysAhead(9).slice(0, 10),
      notes: "Two carousels and one reel per week.",
      plan: "Three posts, email to the list, and a store banner.",
      created_at: daysAgo(5),
      updated_at: daysAgo(2)
    },
    {
      id: "pl_cmp_2",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      name: "Weekend market follow-up",
      channel: "email",
      status: "draft",
      goal: "Convert market sign-ups into first orders",
      budget: 0,
      currency: "INR",
      start_date: daysAhead(2).slice(0, 10),
      end_date: daysAhead(16).slice(0, 10),
      notes: "Segment by city.",
      plan: "One email with the top three sellers and free shipping over ₹2,000.",
      created_at: daysAgo(3),
      updated_at: daysAgo(3)
    }
  ];

  const support_tickets = [
    {
      id: "pl_tkt_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      subject: "Order AUR-1042 arrived with a chipped bowl",
      message: "The ash glaze bowl in order AUR-1042 has a chip on the rim. Can it be replaced?",
      ticket_type: "order",
      status: "open",
      priority: "high",
      assigned_to: null,
      created_at: daysAgo(1, 3),
      updated_at: daysAgo(1, 3)
    },
    {
      id: "pl_tkt_2",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      subject: "How do I connect the custom domain?",
      message: "I bought auroraandco.in. What is the DNS step?",
      ticket_type: "technical",
      status: "resolved",
      priority: "normal",
      assigned_to: ADMIN_ACCOUNT,
      created_at: daysAgo(8),
      updated_at: daysAgo(6)
    },
    {
      id: "pl_tkt_3",
      tenant_id: "pl_tenant_c1",
      owner_id: "pl_cust_1",
      subject: "Can I export my product list?",
      message: "I would like a CSV of my catalogue.",
      ticket_type: "product",
      status: "open",
      priority: "low",
      assigned_to: null,
      created_at: daysAgo(2),
      updated_at: daysAgo(2)
    }
  ];

  const support_replies = [
    {
      id: "pl_rep_1",
      tenant_id: T,
      ticket_id: "pl_tkt_2",
      author_id: ADMIN_ACCOUNT,
      author_role: "admin",
      body: "Add the A record we show in Dashboard → Domains, then wait for verification (usually under an hour).",
      created_at: daysAgo(6)
    }
  ];

  const service_requests = [
    {
      id: "pl_srv_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      service_type: "brand_identity",
      title: "Packaging refresh for the spring drop",
      details: "New label design for three candle SKUs plus a gift box sleeve.",
      amount: 18000,
      status: "in_progress",
      admin_note: "First concepts shared on the 2nd.",
      payment_id: "pl_pay_2",
      created_at: daysAgo(10),
      updated_at: daysAgo(3)
    },
    {
      id: "pl_srv_2",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      service_type: "seo_setup",
      title: "Search setup for the storefront",
      details: "Titles, descriptions and a sitemap.",
      amount: 6500,
      status: "requested",
      admin_note: null,
      payment_id: null,
      created_at: daysAgo(2),
      updated_at: daysAgo(2)
    }
  ];

  const domains = [
    {
      id: "pl_dom_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      project_id: "pl_proj_1",
      fqdn: "auroraandco.in",
      name: "auroraandco",
      tld: "in",
      provider: "manual",
      provider_domain_id: null,
      status: "verified",
      auto_renew: false,
      dns_records: [{ type: "A", name: "@", value: "76.76.21.21", ttl: 3600 }],
      registered_at: daysAgo(12),
      expires_at: daysAhead(353),
      verified_at: daysAgo(11),
      created_at: daysAgo(12),
      updated_at: daysAgo(11)
    }
  ];

  const domain_orders = [
    {
      id: "pl_do_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      domain_name: "auroraandco",
      tld: "in",
      price: 899,
      currency: "INR",
      years: 1,
      provider: "manual",
      status: "paid",
      payment_id: "pl_pay_3",
      registrar_order_id: null,
      error: null,
      created_at: daysAgo(12),
      updated_at: daysAgo(11)
    }
  ];

  const payments = [
    {
      id: "pl_pay_1",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      reference: "SZ-PL-1001",
      purpose: "subscription:pro",
      label: "Pro plan · monthly",
      amount: 249900,
      currency: "INR",
      method: "upi",
      status: "verified",
      plan: "pro",
      utr: "402318874421",
      paid_at: daysAgo(12),
      proof_url: null,
      note: null,
      admin_note: "Approved by administrator",
      verified_by: ADMIN_ACCOUNT,
      verified_at: daysAgo(12, 1),
      provider: "manual",
      provider_payment_id: null,
      created_at: daysAgo(12),
      updated_at: daysAgo(12, 1)
    },
    {
      id: "pl_pay_2",
      tenant_id: T,
      owner_id: USER_ACCOUNT,
      reference: "SZ-PL-1002",
      purpose: "service:brand_identity",
      label: "Brand identity · packaging",
      amount: 1800000,
      currency: "INR",
      method: "upi",
      status: "awaiting_verification",
      plan: null,
      utr: "402318991002",
      paid_at: daysAgo(2),
      proof_url: null,
      note: "Paid from the business account.",
      admin_note: null,
      verified_by: null,
      verified_at: null,
      provider: "manual",
      provider_payment_id: null,
      created_at: daysAgo(2),
      updated_at: daysAgo(2)
    },
    {
      id: "pl_pay_3",
      tenant_id: "pl_tenant_c1",
      owner_id: "pl_cust_1",
      reference: "SZ-PL-1003",
      purpose: "subscription:pro",
      label: "Pro plan · yearly",
      amount: 2499000,
      currency: "INR",
      method: "upi",
      status: "pending",
      plan: "pro",
      utr: null,
      paid_at: null,
      proof_url: null,
      note: null,
      admin_note: null,
      verified_by: null,
      verified_at: null,
      provider: "manual",
      provider_payment_id: null,
      created_at: daysAgo(1),
      updated_at: daysAgo(1)
    }
  ];

  const notifications = [
    ["Storefront published", "aurora-and-co is live at auroraandco.in.", "project", "/app/?view=projects", null, 0.2],
    ["New order AUR-1041", "Ash glaze bowl · ₹1,150 · shipped.", "order", "/app/?view=orders", null, 0.6],
    ["Payment verified", "Pro plan payment SZ-PL-1001 is confirmed.", "payment", "/app/?view=billing", 4, 12],
    ["Low stock", "Ash glaze bowl is out of stock; Terracotta planter is down to 3.", "product", "/app/?view=products", 1, 26],
    ["Support reply", "An administrator answered your domain question.", "support", "/app/?view=support", null, 30]
  ].map((row, index) => ({
    id: id("pl_ntf", index + 1),
    tenant_id: T,
    user_id: USER_ACCOUNT,
    title: row[0],
    body: row[1],
    type: row[2],
    link: row[3],
    meta: { prelaunch: true },
    read_at: row[4] === null ? null : daysAgo(row[4]),
    created_at: daysAgo(row[5])
  }));

  const activity = [
    ["project_published", "project", "pl_proj_1", 4],
    ["order_updated", "order", "pl_ord_001", 2],
    ["product_updated", "product", "pl_prd_004", 1],
    ["ai_generation", "project", "pl_proj_2", 2],
    ["service_requested", "service_request", "pl_srv_2", 2],
    ["payment_submitted", "payment", "pl_pay_2", 2],
    ["support_ticket_opened", "support_ticket", "pl_tkt_1", 1],
    ["domain_verified", "domain", "pl_dom_1", 11]
  ].map((row, index) => ({
    id: id("pl_act", index + 1),
    tenant_id: T,
    user_id: USER_ACCOUNT,
    action: row[0],
    entity_type: row[1],
    entity_id: row[2],
    meta: { prelaunch: true },
    created_at: daysAgo(row[3], index)
  }));

  const ai_conversations = [
    {
      id: "pl_aic_1",
      tenant_id: T,
      user_id: USER_ACCOUNT,
      title: "Spring collection landing page",
      kind: "builder",
      project_id: "pl_proj_2",
      created_at: daysAgo(6),
      updated_at: daysAgo(2)
    }
  ];

  const ai_messages = [
    {
      id: "pl_aim_1",
      tenant_id: T,
      conversation_id: "pl_aic_1",
      role: "user",
      content: "Write a hero for the spring drop. Warm, short, no exclamation marks.",
      tokens: 24,
      meta: {},
      created_at: daysAgo(6)
    },
    {
      id: "pl_aim_2",
      tenant_id: T,
      conversation_id: "pl_aic_1",
      role: "assistant",
      content: "Spring, in soft light. New ceramics and two candles, made in small batches.",
      tokens: 38,
      meta: { model: "gemini" },
      created_at: daysAgo(6)
    }
  ];

  const admin_announcements = [
    {
      id: "pl_ann_1",
      tenant_id: ADMIN_TENANT,
      title: "Pre-launch testing window",
      body: "Sandbox data is reset by deleting .prelaunch/sandbox.json. Nothing here touches customer data.",
      audience: "all",
      created_by: ADMIN_ACCOUNT,
      published_at: daysAgo(3),
      expires_at: null,
      created_at: daysAgo(3)
    }
  ];

  const contact_messages = [
    {
      id: "pl_con_1",
      tenant_id: ADMIN_TENANT,
      name: "Riya Sharma",
      email: "riya@lumenstudio.test",
      phone: null,
      company: "Lumen Studio",
      topic: "pricing",
      message: "Do you have a yearly option for the Pro plan?",
      status: "new",
      created_at: daysAgo(1, 5)
    }
  ];

  return {
    version: SCHEMA_VERSION,
    seeded_at: iso(Date.now()),
    tables: {
      profiles,
      businesses,
      subscriptions,
      onboarding_progress,
      projects,
      project_versions,
      store_products,
      store_orders,
      store_order_items,
      store_customers,
      campaigns,
      support_tickets,
      support_replies,
      service_requests,
      domains,
      domain_orders,
      payments,
      notifications,
      customer_activity: activity,
      ai_conversations,
      ai_messages,
      admin_announcements,
      contact_messages,
      admin_users: [
        { tenant_id: ADMIN_TENANT, user_id: ADMIN_ACCOUNT, email: "Shinzora@admin", role: "owner", created_by: null, created_at: daysAgo(120) }
      ]
    }
  };
}

/* ------------------------------------------------------------- clean seed ---
   What a fresh environment starts with: the two pre-launch accounts and nothing
   else. No sample customers, projects, orders, payments or notifications — the
   product must be usable without a wall of fake records, and a demo row that
   looks like a real customer is exactly the thing that gets mistaken for one. */
export function emptySeed() {
  const T = USER_TENANT;
  const profiles = [
    {
      id: USER_ACCOUNT,
      tenant_id: T,
      full_name: "Pre-Launch Tester",
      email: process.env.PRELAUNCH_USER_EMAIL || "business@business.com",
      phone: null,
      avatar_url: null,
      role: "customer",
      created_at: iso(Date.now()),
      updated_at: iso(Date.now())
    },
    {
      id: ADMIN_ACCOUNT,
      tenant_id: ADMIN_TENANT,
      full_name: "Shinzora Owner",
      email: process.env.PRELAUNCH_ADMIN_EMAIL || "Shinzora@admin",
      phone: null,
      avatar_url: null,
      role: "admin",
      created_at: iso(Date.now()),
      updated_at: iso(Date.now())
    }
  ];

  return {
    version: SCHEMA_VERSION,
    seeded_at: iso(Date.now()),
    seed_kind: "clean",
    tables: {
      profiles,
      businesses: [],
      subscriptions: [],
      onboarding_progress: [],
      projects: [],
      project_versions: [],
      store_products: [],
      store_orders: [],
      store_order_items: [],
      store_customers: [],
      campaigns: [],
      support_tickets: [],
      support_replies: [],
      service_requests: [],
      domains: [],
      domain_orders: [],
      payments: [],
      notifications: [],
      customer_activity: [],
      ai_conversations: [],
      ai_messages: [],
      admin_announcements: [],
      contact_messages: [],
      admin_users: [
        { tenant_id: ADMIN_TENANT, user_id: ADMIN_ACCOUNT, email: process.env.PRELAUNCH_ADMIN_EMAIL || "Shinzora@admin", role: "owner", created_by: null, created_at: iso(Date.now()) }
      ]
    }
  };
}

/* ---------------------------------------------------------------------- IO */

/**
 * Where pre-launch data lives. Kept out of the project's tracked files and
 * overridable, because a serverless host (Vercel) has a read-only project
 * directory and an ephemeral `/tmp` — set PRELAUNCH_DATA_DIR to a writable
 * directory on such a host.
 */
export function dataDir(root) {
  return process.env.PRELAUNCH_DATA_DIR
    ? path.resolve(process.env.PRELAUNCH_DATA_DIR)
    : path.join(root, ".prelaunch");
}

export function storePath(root) {
  return path.join(dataDir(root), "sandbox.json");
}

function ensureDirs(root) {
  fs.mkdirSync(dataDir(root), { recursive: true });
}

export function load(root) {
  if (cached) return cached;
  const file = storePath(root);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === SCHEMA_VERSION && parsed.tables) {
      cached = parsed;
      return cached;
    }
  } catch {
    /* missing or unreadable → seed below */
  }
  cached = emptySeed();
  ensureDirs(root);
  fs.writeFileSync(file, JSON.stringify(cached, null, 2));
  return cached;
}

export function save(root) {
  const file = storePath(root);
  ensureDirs(root);
  const snapshot = JSON.stringify(cached, null, 2);
  /* Serialise writes so two requests can never interleave a half-written file. */
  writeChain = writeChain.then(() => fsp.writeFile(`${file}.tmp`, snapshot).then(() => fsp.rename(`${file}.tmp`, file)));
  return writeChain;
}

export function reset(root, { demo = false } = {}) {
  cached = demo ? demoSeed() : emptySeed();
  ensureDirs(root);
  fs.writeFileSync(storePath(root), JSON.stringify(cached, null, 2));
  return cached;
}

export function table(root, name) {
  const data = load(root);
  if (!data.tables[name]) data.tables[name] = [];
  return data.tables[name];
}

/** True when the table exists in the sandbox schema (seeded, not lazily created). */
export function hasTable(root, name) {
  const data = load(root);
  return Object.prototype.hasOwnProperty.call(data.tables, name);
}

export function tableNames(root) {
  return Object.keys(load(root).tables);
}

export function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
