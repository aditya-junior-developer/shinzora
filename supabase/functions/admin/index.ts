// ============================================================================
// Shinzora · Edge Function `admin`
// ----------------------------------------------------------------------------
// The administrator API. Every action is authorised against public.admin_users
// server-side; there is no client-side flag that can influence this decision.
//
//   POST /functions/v1/admin  { action, ... }
//     overview | customers | customer | payments | payment_review
//     service_requests | service_request_update | subscriptions
//     subscription_update | projects | deployments | tickets | ticket_reply
//     ticket_status | announcements | announcement_create | activity
//     contacts | contact_update | admins | premium | themes
//
// Payment approval is the only place a manual payment becomes 'verified', and
// it is recorded against the approving administrator.
// ============================================================================

import { clean, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin, requireAdmin, scoped, type Caller } from "../_shared/auth.ts";

const PLAN_LIMITS: Record<string, { credits: number; label: string }> = {
  free: { credits: 30, label: "Free" },
  pro: { credits: 800, label: "Pro" },
  enterprise: { credits: 6000, label: "Enterprise" }
};

/* A malformed id used to reach Postgres and come back as a 500, which reads to
   an operator like the console is broken. Reject it here with a plain 400. */
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const guard = await requireAdmin(req);
  if ("response" in guard) {
    const body = await guard.response.text();
    return new Response(body, { status: guard.response.status, headers: { ...guard.response.headers } });
  }
  const { caller } = guard;

  const body = await readBody<Record<string, unknown>>(req);
  const action = clean(body.action, 40);

  try {
    switch (action) {
      case "overview":
        return await overview();
      case "customers":
        return await customers(body);
      case "customer":
        return await customer(clean(body.userId, 64));
      case "payments":
        return await payments(body);
      case "payment_review":
        return await paymentReview(caller.user.id, body);
      case "premium":
        return await premium(caller.user.id, body);
      case "themes":
        return await themes(caller.user.id, body);
      case "service_requests":
        return await serviceRequests(body);
      case "service_request_update":
        return await serviceRequestUpdate(caller.user.id, body);
      case "subscriptions":
        return await subscriptions(body);
      case "subscription_update":
        /* Kept for the existing view; both names now reach the audited function. */
        return await subscriptionChange(body, caller);
      case "projects":
        return await projects(body);
      case "deployments":
        return await deployments(body);
      case "tickets":
        return await tickets(body);
      case "ticket_reply":
        return await ticketReply(caller.user.id, body);
      case "ticket_status":
        return await ticketStatus(body);
      case "announcements":
        return await announcements();
      case "announcement_create":
        return await announcementCreate(caller.user.id, body);
      case "activity":
        return await activity(body);
      case "contacts":
        return await contacts();
      case "contact_update":
        return await contactUpdate(body);
      case "admins":
        return await admins();
      /* ---- Phase 3: authority, audit, archival (migration 0009) ---------- */
      case "directory":
        return await directory(caller);
      case "set_role":
        return await setRole(caller.user.id, body, caller);
      case "reset_credits":
        return await resetCredits(body, caller);
      case "subscription_change":
        return await subscriptionChange(body, caller);
      case "payment_delete":
        return await paymentDelete(body, caller);
      case "archive_record":
        return await archiveRecord(body, caller);
      case "audit":
        return await auditLog(body, caller);
      case "monitor":
        return await monitorProbes();
      default:
        return fail(400, "unknown_action", "Unknown admin action.");
    }
  } catch (error) {
    console.error("admin error", (error as Error).message);
    return fail(500, "admin_error", "The administrator request failed.");
  }
});

/* ----------------------------------------------------------------- overview */
async function overview() {
  const db = admin();
  const count = async (table: string, filter?: (q: any) => any) => {
    let query = db.from(table).select("id", { count: "exact", head: true });
    if (filter) query = filter(query);
    const { count: total } = await query;
    return total ?? 0;
  };

  const [
    users,
    projects,
    published,
    paymentsPending,
    servicePending,
    marketingPending,
    ticketsOpen,
    contactsNew,
    revenueRows,
    recentActivity,
    recentCustomers
  ] = await Promise.all([
    count("profiles"),
    count("projects"),
    count("projects", (q) => q.eq("status", "published")),
    count("payments", (q) => q.in("status", ["pending", "awaiting_verification"])),
    count("service_requests", (q) => q.in("status", ["submitted", "under_review", "in_progress"])),
    count("marketing_requests", (q) => q.in("status", ["submitted", "under_review", "more_information_required"])),
    count("support_tickets", (q) => q.eq("status", "open")),
    count("contact_messages", (q) => q.eq("status", "new")),
    db.from("payments").select("amount, status, created_at").eq("status", "verified").limit(1000),
    db.from("customer_activity").select("user_id, action, entity_type, created_at, meta").order("created_at", { ascending: false }).limit(12),
    db.from("profiles").select("id, full_name, email, created_at, avatar_url").order("created_at", { ascending: false }).limit(6)
  ]);

  const revenue = (revenueRows.data ?? []).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  return json({
    counts: {
      users,
      projects,
      published,
      payments_pending: paymentsPending,
      service_pending: servicePending,
      marketing_pending: marketingPending,
      tickets_open: ticketsOpen,
      contacts_new: contactsNew,
      revenue_total: revenue,
      verified_payments: (revenueRows.data ?? []).length
    },
    recent_activity: recentActivity.data ?? [],
    recent_customers: recentCustomers.data ?? []
  });
}

/* ---------------------------------------------------------------- customers */
async function customers(body: Record<string, unknown>) {
  const term = clean(body.search, 80);
  const limit = Math.min(Number(body.limit) || 50, 200);
  const offset = Math.max(Number(body.offset) || 0, 0);

  let query = admin()
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at, last_sign_in_at, avatar_url", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (term) query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);

  const { data: profiles, error, count } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ids = (profiles ?? []).map((row) => row.id);
  if (!ids.length) return json({ customers: [], total: count ?? 0 });

  const [subs, businesses, onboarding, projectRows] = await Promise.all([
    admin().from("subscriptions").select("user_id, plan, status, ai_credits_used, ai_credits_limit, current_period_end").in("user_id", ids),
    admin().from("businesses").select("owner_id, name, category, location").in("owner_id", ids),
    admin().from("onboarding_progress").select("user_id, current_step, completed_at").in("user_id", ids),
    admin().from("projects").select("owner_id, status").in("owner_id", ids)
  ]);

  const index = <T extends { user_id?: string; owner_id?: string }>(rows: T[] | null, key: "user_id" | "owner_id") => {
    const map = new Map<string, T[]>();
    (rows ?? []).forEach((row) => {
      const id = (row as Record<string, unknown>)[key] as string;
      map.set(id, [...(map.get(id) ?? []), row]);
    });
    return map;
  };

  const subMap = index(subs.data ?? [], "user_id");
  const businessMap = index(businesses.data ?? [], "owner_id");
  const onboardingMap = index(onboarding.data ?? [], "user_id");
  const projectMap = index(projectRows.data ?? [], "owner_id");

  return json({
    total: count ?? 0,
    customers: (profiles ?? []).map((profile) => {
      const sub = subMap.get(profile.id)?.[0] as Record<string, unknown> | undefined;
      const business = businessMap.get(profile.id)?.[0] as Record<string, unknown> | undefined;
      const onboard = onboardingMap.get(profile.id)?.[0] as Record<string, unknown> | undefined;
      const projectsForUser = projectMap.get(profile.id) ?? [];
      return {
        id: profile.id,
        name: profile.full_name,
        email: profile.email,
        phone: profile.phone,
        /* The photo the customer uploaded, so the console's own list can show a
           face instead of initials. */
        avatar_url: profile.avatar_url ?? null,
        joined: profile.created_at,
        last_sign_in: profile.last_sign_in_at,
        business_name: business?.name ?? null,
        category: business?.category ?? null,
        location: business?.location ?? null,
        plan: sub?.plan ?? "free",
        subscription_status: sub?.status ?? "active",
        ai_used: sub?.ai_credits_used ?? 0,
        ai_limit: sub?.ai_credits_limit ?? 30,
        onboarding_step: onboard?.current_step ?? 1,
        onboarded: Boolean(onboard?.completed_at),
        projects: projectsForUser.length,
        published: projectsForUser.filter((p) => (p as Record<string, unknown>).status === "published").length
      };
    })
  });
}

async function customer(userId: string) {
  if (!userId) return fail(400, "invalid_input", "A customer id is required.");
  const db = admin();

  const [profile, businesses, sub, projects, paymentsRows, tickets, services, activityRows, onboarding] = await Promise.all([
    db.from("profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("businesses").select("*").eq("owner_id", userId),
    db.from("subscriptions").select("*").eq("user_id", userId).maybeSingle(),
    db.from("projects").select("id, name, type, status, slug, updated_at, version_count").eq("owner_id", userId),
    db.from("payments").select("*").eq("owner_id", userId).order("created_at", { ascending: false }).limit(20),
    db.from("support_tickets").select("*").eq("owner_id", userId).order("created_at", { ascending: false }).limit(20),
    db.from("service_requests").select("*").eq("owner_id", userId).order("created_at", { ascending: false }).limit(20),
    db.from("customer_activity").select("action, entity_type, entity_id, meta, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(40),
    db.from("onboarding_progress").select("*").eq("user_id", userId).maybeSingle()
  ]);

  if (!profile.data) return fail(404, "not_found", "Customer not found.");

  return json({
    profile: profile.data,
    business: businesses.data?.[0] ?? null,
    subscription: sub.data ?? null,
    onboarding: onboarding.data ?? null,
    projects: projects.data ?? [],
    payments: paymentsRows.data ?? [],
    tickets: tickets.data ?? [],
    service_requests: services.data ?? [],
    activity: activityRows.data ?? []
  });
}

/* ----------------------------------------------------------------- payments */
async function payments(body: Record<string, unknown>) {
  const status = clean(body.status, 30);
  let query = admin().from("payments").select("*").order("created_at", { ascending: false }).limit(200);
  /* "escalated" is not a status — an escalated ticket can be open, pending or
     resolved. It is its own filter so the queue has one obvious place to look. */
  if (status === "escalated") query = query.not("escalated_at", "is", null);
  else if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ownerIds = [...new Set((data ?? []).map((row) => row.owner_id))];
  const { data: profiles } = ownerIds.length
    ? await admin().from("profiles").select("id, full_name, email, phone, avatar_url").in("id", ownerIds)
    : { data: [] };

  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({
    payments: (data ?? []).map((row) => ({
      ...row,
      customer: owners.get(row.owner_id) ?? null
    }))
  });
}

async function paymentReview(adminId: string, body: Record<string, unknown>) {
  const paymentId = clean(body.paymentId, 64);
  const decision = clean(body.decision, 20);
  const note = clean(body.note, 500);

  if (!paymentId) return fail(400, "invalid_input", "Payment id is required.");
  if (!["approve", "reject"].includes(decision)) return fail(400, "invalid_input", "Decision must be approve or reject.");

  const db = admin();
  const { data: payment } = await db.from("payments").select("*").eq("id", paymentId).maybeSingle();
  if (!payment) return fail(404, "not_found", "Payment not found.");
  if (payment.status === "verified" && decision === "approve") {
    return fail(409, "already_verified", "This payment is already verified.");
  }

  const nextStatus = decision === "approve" ? "verified" : "rejected";

  const { data: updated, error } = await db
    .from("payments")
    .update({
      status: nextStatus,
      admin_note: note || (decision === "approve" ? "Approved by administrator" : "Rejected by administrator"),
      verified_by: decision === "approve" ? adminId : null,
      verified_at: decision === "approve" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    })
    .eq("id", paymentId)
    .select("*")
    .single();

  if (error) return fail(500, "admin_error", error.message);

  if (decision === "approve") {
    await applyPaymentEffect(payment);
  }

  await db.from("notifications").insert({
    user_id: payment.owner_id,
    title: decision === "approve" ? "Payment verified" : "Payment needs attention",
    body:
      decision === "approve"
        ? `Payment ${payment.reference} for ${payment.label ?? payment.purpose} is confirmed.${
            payment.purpose?.startsWith("subscription:") ? " Your plan change is active now." : ""
          }`
        : `Payment ${payment.reference} could not be verified. ${note || "Please check the transaction ID and submit it again, or contact support."}`,
    type: "payment",
    link: "/app/?view=billing"
  });

  await db.from("customer_activity").insert({
    user_id: payment.owner_id,
    action: decision === "approve" ? "payment_approved" : "payment_rejected",
    entity_type: "payment",
    entity_id: payment.id,
    meta: { admin_id: adminId, amount: payment.amount, note }
  });

  return json({ ok: true, payment: updated });
}

/** Deliver what was paid for. Only ever called after an approval. */
async function applyPaymentEffect(payment: Record<string, any>) {
  const db = admin();
  const purpose = String(payment.purpose ?? "");

  if (purpose.startsWith("subscription:")) {
    const plan = purpose.split(":")[1];
    const limits = PLAN_LIMITS[plan];
    if (!limits) return;

    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 30);

    await db.from("subscriptions").upsert(
      {
        user_id: payment.owner_id,
        plan,
        status: "active",
        ai_credits_limit: limits.credits,
        ai_credits_used: 0,
        ai_period_start: new Date().toISOString(),
        current_period_end: periodEnd.toISOString(),
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );
    return;
  }

  if (purpose.startsWith("service:")) {
    const serviceType = purpose.split(":")[1];
    const { data: existing } = await db
      .from("service_requests")
      .select("id")
      .eq("owner_id", payment.owner_id)
      .eq("service_type", serviceType)
      .in("status", ["submitted", "under_review"])
      .maybeSingle();

    if (existing) {
      await db
        .from("service_requests")
        .update({ status: "under_review", payment_id: payment.id, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await db.from("service_requests").insert({
        owner_id: payment.owner_id,
        service_type: serviceType,
        title: payment.label ?? serviceType,
        details: "Created automatically from a verified payment.",
        amount: payment.amount,
        status: "under_review",
        payment_id: payment.id
      });
    }
    return;
  }

  if (purpose.startsWith("domain:")) {
    const orderId = purpose.split(":")[1];
    await db
      .from("domain_orders")
      .update({ status: "paid", payment_id: payment.id, updated_at: new Date().toISOString() })
      .eq("id", orderId);
  }
}

/* ------------------------------------------------------- premium profiles */
/* P6. A premium order exists only for a verified payment (database trigger,
   0054). An administrator activates it here, within 24 hours of verification.
   Activation writes the entitlement with the service role; the browser cannot. */
const PREMIUM_RANK: Record<string, number> = { glow: 1, elite: 2 };
const PREMIUM_ACCENTS = ["violet", "rose", "amber", "teal", "sky"];

async function premium(adminId: string, body: Record<string, unknown>) {
  const op = clean(body.op, 20) || "list";
  const db = admin();

  if (op === "list") {
    const status = clean(body.status, 30) || "awaiting_activation";
    let query = db
      .from("premium_orders")
      .select("id, owner_id, payment_id, tier, status, due_by, activated_at, admin_note, created_at")
      .order("due_by", { ascending: true })
      .limit(200);
    if (status !== "all") query = query.eq("status", status);
    const { data, error } = await query;
    if (error) return fail(500, "admin_error", error.message);

    const rows = data ?? [];
    const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
    const paymentIds = [...new Set(rows.map((row) => row.payment_id))];
    const [{ data: people }, { data: payments }, { data: entitlements }] = await Promise.all([
      ownerIds.length
        ? db.from("profiles").select("id, full_name, email").in("id", ownerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      paymentIds.length
        ? db.from("payments").select("id, reference, amount, label, verified_at, status").in("id", paymentIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ownerIds.length
        ? db.from("profile_entitlements").select("user_id, tier, accent").in("user_id", ownerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] })
    ]);

    const personById = new Map((people ?? []).map((row: any) => [row.id, row]));
    const paymentById = new Map((payments ?? []).map((row: any) => [row.id, row]));
    const tierById = new Map((entitlements ?? []).map((row: any) => [row.user_id, row.tier]));
    const now = Date.now();

    return json({
      now: new Date(now).toISOString(),
      orders: rows.map((row: any) => {
        const person = personById.get(row.owner_id) as any;
        const payment = paymentById.get(row.payment_id) as any;
        return {
          ...row,
          customer: person?.full_name || person?.email || "Member",
          email: person?.email ?? null,
          payment: payment ?? null,
          currentTier: tierById.get(row.owner_id) ?? null,
          overdue: row.status === "awaiting_activation" && new Date(row.due_by).getTime() < now
        };
      })
    });
  }

  const orderId = clean(body.orderId, 64);
  if (!isUuid(orderId)) return fail(400, "invalid_input", "An order id is required.");

  const { data: order } = await db.from("premium_orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return fail(404, "not_found", "That premium order does not exist.");
  if (order.status !== "awaiting_activation") {
    return fail(409, "not_awaiting", `This order is already ${order.status}.`);
  }

  if (op === "cancel") {
    const note = clean(body.note, 500);
    if (!note) return fail(400, "invalid_input", "A reason is required to cancel an order.", {
      hint: "Refunds are handled outside this panel. Record the reason here."
    });
    const { data: updated, error } = await db
      .from("premium_orders")
      .update({ status: "cancelled", admin_note: note, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("status", "awaiting_activation")
      .select("*")
      .single();
    if (error) return fail(500, "admin_error", error.message);

    await db.from("notifications").insert({
      user_id: order.owner_id,
      title: "Premium request cancelled",
      body: `Your ${String(order.tier).replace(/^./, (c: string) => c.toUpperCase())} profile request was cancelled. ${note}`,
      type: "payment",
      link: "/app/?view=billing"
    }).then(() => undefined, () => undefined);
    await db.from("customer_activity").insert({
      user_id: order.owner_id,
      action: "premium_order_cancelled",
      entity_type: "premium_order",
      entity_id: orderId,
      meta: { admin_id: adminId, tier: order.tier, note }
    }).then(() => undefined, () => undefined);
    return json({ ok: true, order: updated });
  }

  if (op !== "activate") return fail(400, "invalid_input", "Operation must be list, activate or cancel.");

  /* Only a verified payment can be activated. The trigger is what created the
     order, but the payment is re-read here so a stale order cannot be used. */
  const { data: payment } = await db.from("payments").select("id, status, owner_id").eq("id", order.payment_id).maybeSingle();
  if (!payment || payment.status !== "verified" || payment.owner_id !== order.owner_id) {
    return fail(409, "payment_not_verified", "The payment for this order is not verified, so the profile cannot be activated.");
  }

  const { data: current } = await db
    .from("profile_entitlements")
    .select("tier, accent")
    .eq("user_id", order.owner_id)
    .maybeSingle();
  if (current && (PREMIUM_RANK[current.tier] ?? 0) > (PREMIUM_RANK[order.tier] ?? 0)) {
    return fail(409, "would_downgrade", `This member already has the ${current.tier} profile. Activating ${order.tier} would be a downgrade.`, {
      hint: "Cancel this order and refund it outside the panel, or activate a higher tier."
    });
  }

  /* Claim the order first, so two administrators cannot activate it twice. */
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db
    .from("premium_orders")
    .update({ status: "activated", activated_at: now, activated_by: adminId, updated_at: now })
    .eq("id", orderId)
    .eq("status", "awaiting_activation")
    .select("id")
    .maybeSingle();
  if (claimError) return fail(500, "admin_error", claimError.message);
  if (!claimed) return fail(409, "not_awaiting", "This order was just handled by another administrator.");

  const keepAccent = order.tier === "elite" && current?.tier === "elite" ? current.accent ?? null : null;
  const { error: grantError } = await db.from("profile_entitlements").upsert(
    {
      user_id: order.owner_id,
      tier: order.tier,
      accent: keepAccent,
      granted_order_id: orderId,
      granted_at: now,
      updated_at: now
    },
    { onConflict: "user_id" }
  );
  if (grantError) {
    await db.from("premium_orders").update({ status: "awaiting_activation", activated_at: null, activated_by: null, updated_at: new Date().toISOString() }).eq("id", orderId);
    return fail(500, "admin_error", grantError.message);
  }

  const tierName = String(order.tier).replace(/^./, (c: string) => c.toUpperCase());
  await db.from("notifications").insert({
    user_id: order.owner_id,
    title: `${tierName} profile is live`,
    body: `Your ${tierName} profile is active. Thank you for supporting Shinzora.`,
    type: "payment",
    link: "/app/?view=settings"
  }).then(() => undefined, () => undefined);
  await db.from("customer_activity").insert({
    user_id: order.owner_id,
    action: "premium_activated",
    entity_type: "premium_order",
    entity_id: orderId,
    meta: { admin_id: adminId, tier: order.tier }
  }).then(() => undefined, () => undefined);

  return json({ ok: true, order: { id: orderId, status: "activated", tier: order.tier, activated_at: now } });
}

/* ------------------------------------------------------------------ themes */

const THEME_TIERS = new Set(["glow", "elite"]);
const THEME_ID = /^[a-z][a-z0-9-]{1,40}$/;

/* Themes are managed by deactivating rows, never deleting them: a member's saved
   choice and the audit history both point at these rows. */
function themeSortOrder(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(9999, Math.trunc(n))) : fallback;
}

/* A database CHECK refusal is bad input, not a server fault. */
function themeWriteFailure(error: { message?: string; code?: string }) {
  if (error.code === "23514") return fail(400, "invalid_input", error.message || "That value was refused.");
  return fail(500, "admin_error", error.message || "The theme could not be saved.");
}

function themeImageOk(url: string) {
  return /^\/assets\/themes\/[a-z0-9._-]+$/.test(url) || /^https:\/\/\S+$/.test(url);
}

async function themes(adminId: string, body: Record<string, unknown>) {
  const op = clean(body.op, 30) || "list";
  const db = admin();

  if (op === "list") {
    const [{ data: collections, error: cError }, { data: wallpapers, error: wError }] = await Promise.all([
      db.from("theme_collections").select("*").order("sort_order").order("name"),
      db.from("theme_wallpapers").select("*").order("sort_order").order("title")
    ]);
    if (cError || wError) return fail(500, "admin_error", (cError ?? wError)!.message);
    return json({ collections: collections ?? [], wallpapers: wallpapers ?? [], tiers: [...THEME_TIERS] });
  }

  if (op === "save_collection") {
    const id = clean(body.id, 41).toLowerCase();
    const name = clean(body.name, 60);
    const description = clean(body.description, 280);
    const tierRaw = body.requiredTier === null || body.requiredTier === "" ? null : clean(body.requiredTier, 20);
    if (!THEME_ID.test(id)) return fail(400, "invalid_input", "A collection id must be lower case letters, digits and hyphens.");
    if (name.length < 2) return fail(400, "invalid_input", "A collection needs a name of at least two characters.");
    if (tierRaw !== null && !THEME_TIERS.has(tierRaw)) return fail(400, "invalid_input", "Tier must be Glow, Elite or none.");

    const { data: before } = await db.from("theme_collections").select("*").eq("id", id).maybeSingle();
    const reason = clean(body.reason, 400) || null;
    const tierChanged = !!before && (before.required_tier ?? null) !== tierRaw;
    const deactivating = !!before && before.active && body.active === false;
    if ((tierChanged || deactivating) && !reason) {
      return fail(400, "invalid_input", "A reason is required when a tier changes or a collection is deactivated.", {
        hint: "Members who chose this collection are affected, so the reason is kept in the audit trail."
      });
    }

    const row = {
      id,
      name,
      description,
      required_tier: tierRaw,
      active: typeof body.active === "boolean" ? body.active : before?.active ?? true,
      sort_order: themeSortOrder(body.sortOrder, before?.sort_order ?? 0),
      updated_at: new Date().toISOString()
    };
    const { data: saved, error } = await db.from("theme_collections").upsert(row, { onConflict: "id" }).select("*").single();
    if (error) return themeWriteFailure(error);

    const { error: auditError } = await db.rpc("theme_admin_audit", {
      p_actor: adminId,
      p_action: before ? "theme_collection_update" : "theme_collection_create",
      p_target_table: "theme_collections",
      p_target_id: null,
      p_reason: reason,
      p_before: before ?? null,
      p_after: saved
    });
    if (auditError) console.error("theme audit", auditError.message);
    return json({ ok: true, collection: saved });
  }

  if (op === "save_wallpaper") {
    const wallpaperId = clean(body.id, 64);
    const collectionId = clean(body.collectionId, 41).toLowerCase();
    const title = clean(body.title, 60);
    const imageUrl = clean(body.imageUrl, 500);
    if (wallpaperId && !isUuid(wallpaperId)) return fail(400, "invalid_input", "That is not a valid wallpaper id.");
    if (!THEME_ID.test(collectionId)) return fail(400, "invalid_input", "Choose a collection for this wallpaper.");
    if (title.length < 2) return fail(400, "invalid_input", "A wallpaper needs a title of at least two characters.");
    if (!themeImageOk(imageUrl)) {
      return fail(400, "invalid_input", "The image must be a Shinzora theme path or an https address.");
    }

    const { data: before } = wallpaperId
      ? await db.from("theme_wallpapers").select("*").eq("id", wallpaperId).maybeSingle()
      : { data: null };
    if (wallpaperId && !before) return fail(404, "not_found", "That wallpaper does not exist.");

    const row = {
      ...(before ? { id: before.id } : {}),
      collection_id: collectionId,
      title,
      image_url: imageUrl,
      active: typeof body.active === "boolean" ? body.active : before?.active ?? true,
      sort_order: themeSortOrder(body.sortOrder, before?.sort_order ?? 0),
      updated_at: new Date().toISOString()
    };
    const { data: saved, error } = await db.from("theme_wallpapers").upsert(row).select("*").single();
    if (error) return themeWriteFailure(error);

    const { error: auditError } = await db.rpc("theme_admin_audit", {
      p_actor: adminId,
      p_action: before ? "theme_wallpaper_update" : "theme_wallpaper_create",
      p_target_table: "theme_wallpapers",
      p_target_id: saved.id,
      p_reason: clean(body.reason, 400) || null,
      p_before: before ?? null,
      p_after: saved
    });
    if (auditError) console.error("theme audit", auditError.message);
    return json({ ok: true, wallpaper: saved });
  }

  if (op === "set_active") {
    const kind = clean(body.kind, 20);
    const reason = clean(body.reason, 400) || null;
    const active = body.active === true;
    if (kind !== "collection" && kind !== "wallpaper") return fail(400, "invalid_input", "Kind must be collection or wallpaper.");
    const table = kind === "collection" ? "theme_collections" : "theme_wallpapers";
    const key = clean(body.id, 64);
    if (kind === "wallpaper" && !isUuid(key)) return fail(400, "invalid_input", "That is not a valid wallpaper id.");
    if (kind === "collection" && !THEME_ID.test(key)) return fail(400, "invalid_input", "That is not a valid collection id.");
    if (!active && !reason) return fail(400, "invalid_input", "A reason is required to deactivate a theme.");

    const { data: before } = await db.from(table).select("*").eq("id", key).maybeSingle();
    if (!before) return fail(404, "not_found", "That theme item does not exist.");
    const { data: saved, error } = await db
      .from(table)
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", key)
      .select("*")
      .single();
    if (error) return fail(500, "admin_error", error.message);

    const { error: auditError } = await db.rpc("theme_admin_audit", {
      p_actor: adminId,
      p_action: active ? "theme_activate" : "theme_deactivate",
      p_target_table: table,
      p_target_id: kind === "wallpaper" ? key : null,
      p_reason: reason,
      p_before: before,
      p_after: saved
    });
    if (auditError) console.error("theme audit", auditError.message);
    return json({ ok: true, item: saved });
  }

  return fail(400, "invalid_input", "Operation must be list, save_collection, save_wallpaper or set_active.");
}

/* --------------------------------------------------------- service requests */
async function serviceRequests(body: Record<string, unknown>) {
  const status = clean(body.status, 30);
  let query = admin().from("service_requests").select("*").order("created_at", { ascending: false }).limit(200);
  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ownerIds = [...new Set((data ?? []).map((row) => row.owner_id))];
  const { data: profiles } = ownerIds.length
    ? await admin().from("profiles").select("id, full_name, email, phone, avatar_url").in("id", ownerIds)
    : { data: [] };
  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({ requests: (data ?? []).map((row) => ({ ...row, customer: owners.get(row.owner_id) ?? null })) });
}

/* 0055: the five statuses a request moves through. Anything else is refused. */
const SERVICE_STATUSES = ["submitted", "under_review", "in_progress", "completed", "rejected"];

/**
 * Updates one Request Services row: status, optional note, optional assignee.
 * The owner's notification is written by the service_requests_notify trigger,
 * so this handler does not insert one itself. An assignee must be an existing
 * administrator; a customer account cannot be assigned work.
 */
async function serviceRequestUpdate(adminId: string, body: Record<string, unknown>) {
  const id = clean(body.id, 64);
  const status = clean(body.status, 30);
  const hasNote = Object.prototype.hasOwnProperty.call(body, "note");
  const note = hasNote ? clean(body.note, 2000) : null;
  const hasAssignee = Object.prototype.hasOwnProperty.call(body, "assigned_to");
  const assignee = hasAssignee ? clean(body.assigned_to, 64) : null;

  if (!id || !SERVICE_STATUSES.includes(status)) {
    return fail(400, "invalid_input", "A valid request id and status are required.", {
      allowed: SERVICE_STATUSES
    });
  }

  const db = admin();

  if (hasAssignee && assignee) {
    const { data: staff } = await db.from("admin_users").select("user_id").eq("user_id", assignee).maybeSingle();
    if (!staff) return fail(400, "invalid_input", "Assign the request to an administrator.");
  }

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (hasNote) patch.admin_note = note || null;
  if (hasAssignee) patch.assigned_to = assignee || null;

  const { data, error } = await db.from("service_requests").update(patch).eq("id", id).select("*").single();
  if (error) return fail(500, "admin_error", error.message);

  await db.from("customer_activity").insert({
    user_id: data.owner_id,
    action: "service_request_updated",
    entity_type: "service_request",
    entity_id: id,
    meta: { status, admin_id: adminId, assigned_to: hasAssignee ? assignee || null : undefined }
  });

  return json({ ok: true, request: data });
}

/* -------------------------------------------------------------- subscriptions */
async function subscriptions(body: Record<string, unknown>) {
  let query = admin()
    .from("subscriptions")
    .select("user_id, plan, status, ai_credits_used, ai_credits_limit, current_period_end, updated_at")
    .order("updated_at", { ascending: false })
    .limit(200);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ids = (data ?? []).map((row) => row.user_id);
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email, avatar_url").in("id", ids) : { data: [] };
  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({ subscriptions: (data ?? []).map((row) => ({ ...row, customer: owners.get(row.user_id) ?? null })) });
}

async function subscriptionUpdate(adminId: string, body: Record<string, unknown>) {
  const userId = clean(body.userId, 64);
  const plan = clean(body.plan, 20);
  const status = clean(body.status, 20) || "active";
  if (!userId || !PLAN_LIMITS[plan]) return fail(400, "invalid_input", "A customer and a valid plan are required.");

  const { data, error } = await admin()
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        plan,
        status,
        ai_credits_limit: PLAN_LIMITS[plan].credits,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();
  if (error) return fail(500, "admin_error", error.message);

  await admin().from("notifications").insert({
    user_id: userId,
    title: "Subscription updated",
    body: `An administrator set your plan to ${PLAN_LIMITS[plan].label} (${status}).`,
    type: "account",
    link: "/app/?view=billing"
  });

  await admin().from("customer_activity").insert({
    user_id: userId,
    action: "subscription_updated",
    entity_type: "subscription",
    entity_id: userId,
    meta: { plan, status, admin_id: adminId }
  });

  return json({ ok: true, subscription: data });
}

/* ------------------------------------------------- projects / deployments */
async function projects(body: Record<string, unknown>) {
  const type = clean(body.type, 20);
  let query = admin()
    .from("projects")
    .select("id, owner_id, name, type, status, slug, version_count, updated_at, created_at")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (type && type !== "all") query = query.eq("type", type);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ids = [...new Set((data ?? []).map((row) => row.owner_id))];
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email, avatar_url").in("id", ids) : { data: [] };
  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({ projects: (data ?? []).map((row) => ({ ...row, customer: owners.get(row.owner_id) ?? null })) });
}

async function deployments(body: Record<string, unknown>) {
  const { data, error } = await admin()
    .from("deployments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return fail(500, "admin_error", error.message);
  return json({ deployments: data ?? [] });
}

/* --------------------------------------------------------------- support */
async function tickets(body: Record<string, unknown>) {
  const status = clean(body.status, 20);
  let query = admin().from("support_tickets").select("*").order("created_at", { ascending: false }).limit(200);
  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ids = [...new Set((data ?? []).map((row) => row.owner_id))];
  const [{ data: profiles }, { data: replies }] = await Promise.all([
    ids.length ? admin().from("profiles").select("id, full_name, email, avatar_url").in("id", ids) : Promise.resolve({ data: [] }),
    (data ?? []).length ? admin().from("support_replies").select("ticket_id, body, author_role, created_at").in("ticket_id", (data ?? []).map((row) => row.id)).order("created_at") : Promise.resolve({ data: [] })
  ]);

  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));
  const thread = new Map<string, unknown[]>();
  (replies ?? []).forEach((reply) => thread.set(reply.ticket_id, [...(thread.get(reply.ticket_id) ?? []), reply]));

  return json({
    tickets: (data ?? []).map((row) => ({
      ...row,
      customer: owners.get(row.owner_id) ?? null,
      replies: thread.get(row.id) ?? []
    }))
  });
}

async function ticketReply(adminId: string, body: Record<string, unknown>) {
  const ticketId = clean(body.ticketId, 64);
  const message = clean(body.body, 4000);
  if (!ticketId || !message) return fail(400, "invalid_input", "A ticket and a message are required.");

  const db = admin();
  const { data: ticket } = await db.from("support_tickets").select("*").eq("id", ticketId).maybeSingle();
  if (!ticket) return fail(404, "not_found", "Ticket not found.");

  const { error } = await db.from("support_replies").insert({
    ticket_id: ticketId,
    author_id: adminId,
    author_role: "admin",
    body: message
  });
  if (error) return fail(500, "admin_error", error.message);

  await db.from("support_tickets").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", ticketId);

  await db.from("notifications").insert({
    user_id: ticket.owner_id,
    title: "Shinzora support replied",
    body: `${ticket.subject} — a member of the team has answered your ticket.`,
    type: "support",
    link: "/app/?view=support"
  });

  return json({ ok: true });
}

async function ticketStatus(body: Record<string, unknown>) {
  const ticketId = clean(body.ticketId, 64);
  const status = clean(body.status, 20);
  if (!ticketId || !["open", "pending", "resolved", "closed"].includes(status)) {
    return fail(400, "invalid_input", "A ticket and a valid status are required.");
  }
  const { data, error } = await admin()
    .from("support_tickets")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", ticketId)
    .select("*")
    .single();
  if (error) return fail(500, "admin_error", error.message);
  return json({ ok: true, ticket: data });
}

/* ------------------------------------------------------------ announcements */
async function announcements() {
  const { data, error } = await admin()
    .from("admin_announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return fail(500, "admin_error", error.message);
  return json({ announcements: data ?? [] });
}

async function announcementCreate(adminId: string, body: Record<string, unknown>) {
  const title = clean(body.title, 160);
  const message = clean(body.body, 4000);
  const audience = clean(body.audience, 80) || "all";
  const requestKey = clean(body.requestKey, 36);
  if (!title || !message) return fail(400, "invalid_input", "Title and message are required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
    return fail(400, "invalid_input", "A valid announcement request key is required.");
  }

  const { data, error } = await admin().rpc("admin_create_announcement", {
    p_admin_id: adminId,
    p_title: title,
    p_body: message,
    p_audience: audience,
    p_request_key: requestKey
  });
  if (error) return fail(500, "admin_error", "The announcement could not be delivered.");
  return json({ ok: true, ...(data ?? {}) });
}

/* ---------------------------------------------------------------- activity */
async function activity(body: Record<string, unknown>) {
  const limit = Math.min(Number(body.limit) || 100, 300);
  const { data, error } = await admin()
    .from("customer_activity")
    .select("id, user_id, action, entity_type, entity_id, meta, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail(500, "admin_error", error.message);

  const ids = [...new Set((data ?? []).map((row) => row.user_id))];
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email, avatar_url").in("id", ids) : { data: [] };
  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({ activity: (data ?? []).map((row) => ({ ...row, customer: owners.get(row.user_id) ?? null })) });
}

/* ---------------------------------------------------------------- contacts */
async function contacts() {
  const { data, error } = await admin()
    .from("contact_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return fail(500, "admin_error", error.message);
  return json({ messages: data ?? [] });
}

async function contactUpdate(body: Record<string, unknown>) {
  const id = clean(body.id, 64);
  const status = clean(body.status, 20);
  if (!id || !["new", "read", "replied", "archived"].includes(status)) {
    return fail(400, "invalid_input", "A message and a valid status are required.");
  }
  const { error } = await admin().from("contact_messages").update({ status }).eq("id", id);
  if (error) return fail(500, "admin_error", error.message);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ admins */
async function admins() {
  const { data, error } = await admin()
    .from("admin_users")
    .select("user_id, email, role, created_at, protected, granted_at")
    .order("created_at", { ascending: true });
  if (error) return fail(500, "admin_error", error.message);
  return json({
    admins: data ?? [],
    note:
      "Roles are changed through public.set_admin_role(), which refuses anything a super administrator could not authorise. The protected owner can never be demoted."
  });
}

/* ------------------------------------------------- Phase 3 · new surfaces --
   Every one of these calls a SECURITY DEFINER function that re-checks the
   caller's own role in the database. The Edge Function adds no authority of its
   own: if `set_admin_role()` refuses, so does the API, with the same words. */

/** Translate a Postgres refusal into the API's error shape, keeping the reason. */
function rpcFailure(error: { message?: string; code?: string; details?: string } | null, fallback: string) {
  const message = error?.message || fallback;
  if (error?.code === "42501") return fail(403, "forbidden", message);
  if (error?.code === "22023") return fail(400, "invalid_input", message);
  if (error?.code === "P0002") return fail(404, "not_found", message);
  if (error?.code === "23505") return fail(409, "conflict", message);
  return fail(500, "admin_error", message);
}

async function directory(caller: Caller) {
  const { data, error } = await scoped(caller).rpc("admin_directory");
  if (error) return rpcFailure(error, "The user directory could not be read.");
  return json({ users: data ?? [] });
}

async function setRole(actorId: string, body: Record<string, unknown>, caller: Caller) {
  const userId = clean(body.userId, 64);
  const role = clean(body.role, 20);
  const reason = clean(body.reason, 400) || null;
  if (!userId) return fail(400, "invalid_input", "A user id is required.");
  if (!isUuid(userId)) return fail(400, "invalid_input", "That is not a valid account id.");
  if (userId === actorId && role !== "superadmin") {
    /* Not a security boundary (the database enforces that too) — it is here so
       the console cannot even offer the button that would drop your own rights. */
    return fail(400, "invalid_input", "You cannot remove your own administrator access.");
  }
  const { data, error } = await scoped(caller).rpc("set_admin_role", {
    p_user: userId,
    p_role: role,
    p_reason: reason
  });
  if (error) return rpcFailure(error, "The role change was refused.");
  return json({ ok: true, result: data });
}

async function resetCredits(body: Record<string, unknown>, caller: Caller) {
  const userId = clean(body.userId, 64);
  if (!userId) return fail(400, "invalid_input", "A user id is required.");
  if (!isUuid(userId)) return fail(400, "invalid_input", "That is not a valid account id.");
  const { data, error } = await scoped(caller).rpc("admin_reset_ai_credits", {
    p_user: userId,
    p_reason: clean(body.reason, 400) || null
  });
  if (error) return rpcFailure(error, "The credit reset was refused.");
  return json({ ok: true, result: data });
}

async function subscriptionChange(body: Record<string, unknown>, caller: Caller) {
  const userId = clean(body.userId, 64);
  const plan = clean(body.plan, 20) || null;
  const status = clean(body.status, 20) || null;
  if (!userId) return fail(400, "invalid_input", "A user id is required.");
  if (!isUuid(userId)) return fail(400, "invalid_input", "That is not a valid account id.");
  if (!plan && !status) return fail(400, "invalid_input", "Supply a plan or a status.");
  const { data, error } = await scoped(caller).rpc("admin_update_subscription", {
    p_user: userId,
    p_plan: plan,
    p_status: status,
    p_reason: clean(body.reason, 400) || null
  });
  if (error) return rpcFailure(error, "The subscription change was refused.");
  return json({ ok: true, result: data });
}

async function paymentDelete(body: Record<string, unknown>, caller: Caller) {
  const paymentId = clean(body.paymentId, 64);
  const reason = clean(body.reason, 400);
  if (!paymentId) return fail(400, "invalid_input", "A payment id is required.");
  if (!isUuid(paymentId)) return fail(400, "invalid_input", "That is not a valid payment id.");
  if (!reason) return fail(400, "invalid_input", "A reason is required to remove a payment.", {
    hint: "The reason is stored in the audit trail; it is what makes a removal explainable later."
  });
  const { data, error } = await scoped(caller).rpc("admin_delete_payment", {
    p_payment: paymentId,
    p_reason: reason,
    p_hard: body.hard === true
  });
  if (error) return rpcFailure(error, "The payment could not be removed.");
  return json({ ok: true, result: data });
}

async function archiveRecord(body: Record<string, unknown>, caller: Caller) {
  const table = clean(body.table, 40);
  const id = clean(body.id, 64);
  if (!table || !id) return fail(400, "invalid_input", "A table and a record id are required.");
  if (!isUuid(id)) return fail(400, "invalid_input", "That is not a valid record id.");
  const { data, error } = await scoped(caller).rpc("admin_archive_record", {
    p_table: table,
    p_id: id,
    p_reason: clean(body.reason, 400) || null
  });
  if (error) return rpcFailure(error, "The record could not be archived.");
  return json({ ok: true, result: data });
}

async function auditLog(body: Record<string, unknown>, caller: Caller) {
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500);
  const { data, error } = await scoped(caller).rpc("admin_audit_log", { p_limit: limit });
  if (error) return rpcFailure(error, "The audit trail could not be read.");
  return json({ entries: data ?? [] });
}

/* ------------------------------------------------------------- monitoring --
   Probes, not charts. Each line is a real request made now, with its own
   latency and its own failure text; nothing here is a stored "uptime". */
async function monitorProbes() {
  const db = admin();
  const probe = async (name: string, table: string) => {
    const started = Date.now();
    const { error } = await db.from(table).select("id", { head: true, count: "exact" }).limit(1);
    return {
      name,
      ok: !error,
      ms: Date.now() - started,
      detail: error ? error.message : "reachable"
    };
  };

  const checks = await Promise.all([
    probe("Database · profiles", "profiles"),
    probe("Database · payments", "payments"),
    probe("Database · projects", "projects")
  ]);

  /* Storage: a real listing call, not a bucket flag. */
  const storageStart = Date.now();
  const listing = await db.storage.from("avatars").list("", { limit: 1 });
  checks.push({
    name: "Storage · avatars",
    ok: !listing.error,
    ms: Date.now() - storageStart,
    detail: listing.error ? listing.error.message : "reachable"
  });

  /* Auth: the admin API answers or it does not. */
  const authStart = Date.now();
  const users = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
  checks.push({
    name: "Auth · admin API",
    ok: !users.error,
    ms: Date.now() - authStart,
    detail: users.error ? users.error.message : "reachable"
  });

  /* Last generation outcome and recent AI failures, read from the log. */
  const [{ data: recentAi }, { data: lastProjects }] = await Promise.all([
    db.from("ai_usage_log").select("mode, ok, error, created_at").order("created_at", { ascending: false }).limit(10),
    db.from("projects").select("id, name, updated_at").order("updated_at", { ascending: false }).limit(3)
  ]);

  const failedAi = (recentAi ?? []).filter((row) => row.ok === false);
  checks.push({
    name: "AI · last 10 calls",
    ok: failedAi.length === 0,
    ms: null,
    detail:
      (recentAi ?? []).length === 0
        ? "no AI calls recorded yet"
        : failedAi.length
          ? `${failedAi.length} of ${recentAi!.length} failed — most recent: ${failedAi[0].error ?? "unknown"}`
          : `all ${recentAi!.length} succeeded`
  });

  return json({
    checks,
    last_projects: lastProjects ?? [],
    checked_at: new Date().toISOString(),
    source: "live probes run by the admin Edge Function on every request"
  });
}
