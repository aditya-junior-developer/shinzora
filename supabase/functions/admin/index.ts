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
//     contacts | contact_update | admins
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
    count("service_requests", (q) => q.in("status", ["requested", "approved", "in_progress"])),
    count("marketing_requests", (q) => q.in("status", ["submitted", "under_review", "more_information_required"])),
    count("support_tickets", (q) => q.eq("status", "open")),
    count("contact_messages", (q) => q.eq("status", "new")),
    db.from("payments").select("amount, status, created_at").eq("status", "verified").limit(1000),
    db.from("customer_activity").select("user_id, action, entity_type, created_at, meta").order("created_at", { ascending: false }).limit(12),
    db.from("profiles").select("id, full_name, email, created_at").order("created_at", { ascending: false }).limit(6)
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
    .select("id, full_name, email, phone, role, created_at, last_sign_in_at", { count: "exact" })
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
  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ownerIds = [...new Set((data ?? []).map((row) => row.owner_id))];
  const { data: profiles } = ownerIds.length
    ? await admin().from("profiles").select("id, full_name, email, phone").in("id", ownerIds)
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
      .in("status", ["requested", "approved"])
      .maybeSingle();

    if (existing) {
      await db
        .from("service_requests")
        .update({ status: "approved", payment_id: payment.id, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await db.from("service_requests").insert({
        owner_id: payment.owner_id,
        service_type: serviceType,
        title: payment.label ?? serviceType,
        details: "Created automatically from a verified payment.",
        amount: payment.amount,
        status: "approved",
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

/* --------------------------------------------------------- service requests */
async function serviceRequests(body: Record<string, unknown>) {
  const status = clean(body.status, 30);
  let query = admin().from("service_requests").select("*").order("created_at", { ascending: false }).limit(200);
  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return fail(500, "admin_error", error.message);

  const ownerIds = [...new Set((data ?? []).map((row) => row.owner_id))];
  const { data: profiles } = ownerIds.length
    ? await admin().from("profiles").select("id, full_name, email, phone").in("id", ownerIds)
    : { data: [] };
  const owners = new Map((profiles ?? []).map((row) => [row.id, row]));

  return json({ requests: (data ?? []).map((row) => ({ ...row, customer: owners.get(row.owner_id) ?? null })) });
}

async function serviceRequestUpdate(adminId: string, body: Record<string, unknown>) {
  const id = clean(body.id, 64);
  const status = clean(body.status, 30);
  const note = clean(body.note, 500);
  const allowed = ["requested", "approved", "in_progress", "completed", "rejected", "cancelled"];
  if (!id || !allowed.includes(status)) return fail(400, "invalid_input", "A valid request id and status are required.");

  const db = admin();
  const { data, error } = await db
    .from("service_requests")
    .update({ status, admin_note: note || null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return fail(500, "admin_error", error.message);

  await db.from("notifications").insert({
    user_id: data.owner_id,
    title: `Service request ${status.replace(/_/g, " ")}`,
    body: `${data.title ?? data.service_type} — ${status.replace(/_/g, " ")}.${note ? ` ${note}` : ""}`,
    type: "account",
    link: "/app/?view=billing"
  });

  await db.from("customer_activity").insert({
    user_id: data.owner_id,
    action: "service_request_updated",
    entity_type: "service_request",
    entity_id: id,
    meta: { status, admin_id: adminId }
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
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
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
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
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
    ids.length ? admin().from("profiles").select("id, full_name, email").in("id", ids) : Promise.resolve({ data: [] }),
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
  const audience = clean(body.audience, 30) || "all";
  if (!title || !message) return fail(400, "invalid_input", "Title and message are required.");

  const db = admin();
  const { data: announcement, error } = await db
    .from("admin_announcements")
    .insert({ title, body: message, audience, created_by: adminId })
    .select("*")
    .single();
  if (error) return fail(500, "admin_error", error.message);

  // Fan out one notification per recipient so read state is per user.
  let recipients: string[] = [];
  if (audience === "all") {
    const { data } = await db.from("profiles").select("id").limit(5000);
    recipients = (data ?? []).map((row) => row.id);
  } else if (["customers", "free", "pro", "enterprise"].includes(audience)) {
    const plan = ["free", "pro", "enterprise"].includes(audience) ? audience : null;
    let query = db.from("subscriptions").select("user_id").limit(5000);
    if (plan) query = query.eq("plan", plan);
    const { data } = await query;
    recipients = (data ?? []).map((row) => row.user_id);
  } else if (audience.startsWith("user:")) {
    recipients = [audience.slice(5)];
  }

  if (recipients.length) {
    const rows = recipients.map((userId) => ({
      user_id: userId,
      title,
      body: message,
      type: "admin",
      link: "/app/?view=notifications",
      meta: { announcement_id: announcement.id, audience }
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db.from("notifications").insert(rows.slice(i, i + 500));
    }
  }

  return json({ ok: true, announcement, delivered: recipients.length });
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
  const { data: profiles } = ids.length ? await admin().from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
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
