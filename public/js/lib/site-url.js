/* ==========================================================================
   Shinzora — where a customer's public website actually lives
   --------------------------------------------------------------------------
   "View public site" used to link to "/" — Shinzora's own marketing homepage.
   A customer clicking it left their workspace and landed on our sales page,
   which is the opposite of what the label promises.

   The published address is resolved from the customer's own records:

     1. a verified custom domain connected to one of their published projects
     2. otherwise the platform's own address for that project: /site/?p=<slug>

   Nothing is invented: when there is no published project the function returns
   null and the caller must say so instead of sending the customer somewhere
   plausible-looking.
   ========================================================================== */

import { sb, getSession } from "./supabase.js";

/** Statuses that mean "a visitor can reach this project". */
const LIVE = ["published"];

/**
 * The signed-in customer's published site, as a URL string, or null.
 *
 * @param {{ client?: object, userId?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function resolvePublishedSite(options = {}) {
  const client = options.client || sb;
  if (!client) return null;

  const userId = options.userId || (await getSession().catch(() => null))?.user?.id;
  if (!userId) return null;

  /* RLS already scopes these rows to the owner; the explicit filter keeps the
     query honest if a policy is ever widened. */
  const { data: projects, error } = await client
    .from("projects")
    .select("id, slug, status, updated_at, published_at")
    .eq("owner_id", userId)
    .in("status", LIVE)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) throw error;
  const live = (projects || []).filter((project) => project.slug);
  if (!live.length) return null;

  /* A verified custom domain beats the platform path. */
  const ids = live.map((project) => project.id);
  const { data: domains } = await client
    .from("domains")
    .select("fqdn, project_id, status, verified_at")
    .in("project_id", ids);

  const verified = (domains || []).find(
    (row) => row.fqdn && (row.verified_at || ["verified", "active", "connected"].includes(String(row.status).toLowerCase()))
  );

  if (verified) {
    const host = String(verified.fqdn).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${host}`;
  }

  return `/site/?p=${encodeURIComponent(live[0].slug)}`;
}

/** Synchronous best guess for render-time decisions (no network). */
export function publishedSiteUrl() {
  try {
    const cached = globalThis.__shinzoraSiteUrl;
    return typeof cached === "string" && cached ? cached : null;
  } catch {
    return null;
  }
}

/** Cache the resolved URL so header paint does not need to await twice. */
export function rememberPublishedSite(url) {
  try {
    globalThis.__shinzoraSiteUrl = url || null;
  } catch {
    /* nothing to do */
  }
}
