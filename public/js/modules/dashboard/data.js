/* ==========================================================================
   Shinzora — dashboard data access
   --------------------------------------------------------------------------
   Every read goes through here so the views stay thin and identical error
   handling applies everywhere. Row Level Security is the real authority: these
   queries simply ask for the caller's own rows.
   ========================================================================== */

import { sb, normalizeError, AppError } from "../../lib/supabase.js";
import { state } from "../../lib/store.js";

function db() {
  if (!sb) throw new AppError("Supabase client unavailable.", { code: "client_missing" });
  return sb;
}

export const uid = () => state.user?.id || null;

/** Wrap a Supabase response, throwing a normalised AppError when it fails. */
const unwrap = ({ data, error, count }) => {
  if (error) throw normalizeError(error);
  return { data: data ?? [], count: count ?? (Array.isArray(data) ? data.length : 0) };
};

/* ----------------------------------------------------------------- writes */
export async function updateProfile(patch) {
  const { data, error } = await db()
    .from("profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", uid())
    .select("*")
    .maybeSingle();
  if (error) throw normalizeError(error);
  return data;
}

/**
 * Upsert the caller's business row. The first save creates it; later saves
 * patch only the submitted fields so a partial form never blanks a column.
 */
export async function updateBusiness(patch) {
  const existing = state.business?.id
    ? { id: state.business.id }
    : (await db().from("businesses").select("id").eq("owner_id", uid()).maybeSingle()).data;

  if (existing?.id) {
    const { data, error } = await db()
      .from("businesses")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();
    if (error) throw normalizeError(error);
    return data;
  }

  const { data, error } = await db()
    .from("businesses")
    .insert({ owner_id: uid(), ...patch })
    .select("*")
    .maybeSingle();
  if (error) throw normalizeError(error);
  return data;
}

/* ------------------------------------------------------------------ reads */
export async function projects({ status, type, limit = 50 } = {}) {
  let query = db().from("projects").select("*").order("updated_at", { ascending: false }).limit(limit);
  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);
  return unwrap(await query);
}

export async function project(id) {
  const { data } = unwrap(await db().from("projects").select("*").eq("id", id).maybeSingle());
  return Array.isArray(data) ? data[0] : data;
}

export async function projectVersions(projectId) {
  return unwrap(
    await db()
      .from("project_versions")
      .select("id, project_id, version_number, prompt, meta, created_at")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false })
      .limit(30)
  );
}

export async function projectVersion(id) {
  const { data } = unwrap(await db().from("project_versions").select("*").eq("id", id).maybeSingle());
  return Array.isArray(data) ? data[0] : data;
}

export async function products({ search, lowStock } = {}) {
  let query = db().from("store_products").select("*").order("created_at", { ascending: false }).limit(200);
  if (search) query = query.ilike("name", `%${search}%`);
  if (lowStock) query = query.lte("stock", 5);
  return unwrap(await query);
}

export async function orders({ status, limit = 100 } = {}) {
  let query = db()
    .from("store_orders")
    .select("*, items:store_order_items(*)")
    .order("placed_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  return unwrap(await query);
}

export async function customers({ search, limit = 200 } = {}) {
  let query = db().from("store_customers").select("*").order("created_at", { ascending: false }).limit(limit);
  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  return unwrap(await query);
}

export async function campaigns(limit = 50) {
  return unwrap(await db().from("campaigns").select("*").order("created_at", { ascending: false }).limit(limit));
}

export async function tickets(status, limit = 100) {
  let query = db().from("support_tickets").select("*").order("created_at", { ascending: false }).limit(limit);
  if (status) query = query.eq("status", status);
  return unwrap(await query);
}

export async function domains(limit = 100) {
  return unwrap(await db().from("domains").select("*").order("created_at", { ascending: false }).limit(limit));
}

export async function domainOrders(limit = 50) {
  return unwrap(
    await db().from("domain_orders").select("*").order("created_at", { ascending: false }).limit(limit)
  );
}

export async function payments(limit = 50) {
  return unwrap(await db().from("payments").select("*").order("created_at", { ascending: false }).limit(limit));
}

export async function notifications(limit = 40) {
  return unwrap(
    await db()
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit)
  );
}

export async function activity(limit = 20) {
  return unwrap(
    await db().from("customer_activity").select("*").order("created_at", { ascending: false }).limit(limit)
  );
}

export async function serviceRequests(limit = 50) {
  return unwrap(
    await db().from("service_requests").select("*").order("created_at", { ascending: false }).limit(limit)
  );
}

export async function conversations(limit = 30) {
  return unwrap(
    await db()
      .from("ai_conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit)
  );
}

export async function messages(conversationId, limit = 100) {
  return unwrap(
    await db()
      .from("ai_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit)
  );
}

export async function announcements(limit = 20) {
  return unwrap(
    await db()
      .from("admin_announcements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit)
  );
}

export async function subscription() {
  const { data } = unwrap(
    await db().from("subscriptions").select("*").eq("user_id", uid()).maybeSingle()
  );
  return Array.isArray(data) ? data[0] : data;
}

/* ------------------------------------------------- aggregate overview data */
export async function overview() {
  const client = db();
  const [projectRows, orderRows, customerRows, productRows, ticketRows, notifRows, activityRows, paymentRows] =
    await Promise.all([
      client.from("projects").select("id, name, type, status, updated_at, slug").order("updated_at", { ascending: false }).limit(6),
      client
        .from("store_orders")
        .select("id, order_number, total_amount, currency, status, placed_at, customer_name")
        .order("placed_at", { ascending: false })
        .limit(50),
      client.from("store_customers").select("id", { count: "exact", head: true }),
      client.from("store_products").select("id, name, stock", { count: "exact" }).limit(500),
      client.from("support_tickets").select("id, status", { count: "exact" }).eq("status", "open"),
      client.from("notifications").select("id, title, body, type, created_at, read_at").order("created_at", { ascending: false }).limit(6),
      client.from("customer_activity").select("action, entity_type, created_at, meta").order("created_at", { ascending: false }).limit(8),
      client.from("payments").select("id, amount, status, purpose, created_at").order("created_at", { ascending: false }).limit(10)
    ]);

  const firstError = [projectRows, orderRows, customerRows, productRows, ticketRows, notifRows, activityRows, paymentRows]
    .map((r) => r.error)
    .find(Boolean);
  if (firstError) throw normalizeError(firstError);

  const orders = orderRows.data || [];
  const paidStatuses = ["paid", "processing", "shipped", "delivered", "fulfilled"];
  const revenue = orders
    .filter((o) => paidStatuses.includes(o.status))
    .reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

  const products = productRows.data || [];
  const lowStock = products.filter((p) => Number(p.stock) <= 5);

  return {
    projects: projectRows.data || [],
    orders,
    revenue,
    orderCount: orders.length,
    customerCount: customerRows.count || 0,
    productCount: productRows.count || products.length,
    lowStock,
    openTickets: ticketRows.count || 0,
    notifications: notifRows.data || [],
    activity: activityRows.data || [],
    pendingPayments: (paymentRows.data || []).filter((p) => p.status !== "verified"),
    lastPayment: (paymentRows.data || [])[0] || null
  };
}

/* ---------------------------------------------------------------- writes */
export async function markNotificationRead(id) {
  const { error } = await db().from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
  if (error) throw normalizeError(error);
}

export async function markAllNotificationsRead() {
  const { error } = await db()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw normalizeError(error);
}

export async function logActivity(action, entityType, entityId, meta = {}) {
  if (!uid()) return;
  try {
    await db().rpc("log_activity", {
      p_action: action,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_meta: meta
    });
  } catch {
    /* activity logging must never break a user flow */
  }
}

export async function unreadCount() {
  const { count, error } = await db().from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  if (error) return 0;
  return count || 0;
}

/** True when the error means the migrations have not been applied yet. */
export const isSchemaMissing = (error) => normalizeError(error).code === "schema_missing";
