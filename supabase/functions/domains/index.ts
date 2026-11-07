// ============================================================================
// Shinzora · Edge Function `domains`
// ----------------------------------------------------------------------------
// Registrar-agnostic domain workflow.
//
//   POST /functions/v1/domains   { action, ... }
//     search       { query }              → live availability + price, or an
//                                           honest "provider not connected"
//     availability { domain }
//     create_order { domain, years? }     → order row (pending_payment)
//     connect      { fqdn, projectId }    → DNS records to add, status pending
//     dns          { domainId }           → stored records + instructions
//
// This function NEVER invents availability or prices.
//
// Availability has two sources:
//   · a registrar (providerReady())  → availability AND price, orderable
//   · public RDAP, when no registrar is connected (free, no account, no key)
//     → availability only; price stays unknown and nothing can be ordered,
//       because a price that came from nowhere would be a lie.
//
// RDAP is the registries' own data (the JSON successor to WHOIS): 200 = the
// domain exists, 404 = no record, anything else = "could not check".
//
// Provider contract (set DOMAIN_PROVIDER + DOMAIN_API_URL + DOMAIN_API_KEY):
//   POST {DOMAIN_API_URL}/check   { domains: string[] }
//     → { results: [{ domain, available, price, renewal, currency }] }
//   POST {DOMAIN_API_URL}/register { domain, years, contact }
//     → { orderId, status }
//   POST {DOMAIN_API_URL}/dns     { fqdn, records }
//     → { ok: true }
// ============================================================================

import { clean, fail, json, preflight, readBody } from "../_shared/http.ts";
import { admin, getCaller } from "../_shared/auth.ts";

const env = (key: string) => (Deno.env.get(key) ?? "").trim();
const PROVIDER = () => env("DOMAIN_PROVIDER") || "none";
const API_URL = () => env("DOMAIN_API_URL");
const API_KEY = () => env("DOMAIN_API_KEY");
const SUBDOMAIN_ROOT = () => env("SUBDOMAIN_ROOT") || "shinzora.in";

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*\.[a-z]{2,24}$/i;

function providerReady() {
  return PROVIDER() !== "none" && Boolean(API_URL() && API_KEY());
}

/* `DOMAIN_AVAILABILITY=off` turns the public check off entirely; anything else
   keeps it on. A connected registrar always wins. */
function availabilityMode(): "registrar" | "rdap" | "off" {
  if (providerReady()) return "registrar";
  return (env("DOMAIN_AVAILABILITY") || "rdap").toLowerCase() === "off" ? "off" : "rdap";
}

/* Small per-isolate cache: a search box invites repeat lookups of the same
   name, and registries are rate-limited. */
const rdapCache = new Map<string, { at: number; value: RdapResult }>();
type RdapResult = {
  available: boolean | null;
  status: "available" | "registered" | "unknown";
  detail?: string;
};

const RDAP_TTL_MS = 10 * 60 * 1000;

async function rdapLookup(domain: string): Promise<RdapResult> {
  const cached = rdapCache.get(domain);
  if (cached && Date.now() - cached.at < RDAP_TTL_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let result: RdapResult;
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      redirect: "follow",
      headers: {
        accept: "application/rdap+json, application/json;q=0.9",
        "user-agent": "Shinzora/1.0 (+https://shinzora.in)"
      },
      signal: controller.signal
    });
    if (response.status === 404) {
      result = { available: true, status: "available" };
    } else if (response.status === 200) {
      result = { available: false, status: "registered" };
    } else {
      result = { available: null, status: "unknown", detail: `registry answered ${response.status}` };
    }
  } catch (error) {
    result = {
      available: null,
      status: "unknown",
      detail: (error as Error)?.name === "AbortError" ? "registry timed out" : "registry unreachable"
    };
  } finally {
    clearTimeout(timer);
  }

  rdapCache.set(domain, { at: Date.now(), value: result });
  return result;
}

async function providerCall(path: string, payload: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_URL()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY()}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`registrar ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const caller = await getCaller(req);
  if (!caller) return fail(401, "not_authenticated", "Sign in to manage domains.");

  const body = await readBody<Record<string, unknown>>(req);
  const action = clean(body.action, 40);

  try {
    switch (action) {
      case "search":
        return await search(body);
      case "availability":
        return await search({ query: body.domain });
      case "create_order":
        return await createOrder(caller.user.id, body);
      case "connect":
        return await connectDomain(caller.user.id, body);
      case "dns":
        return await dnsRecords(caller.user.id, body);
      default:
        return fail(400, "unknown_action", "Unknown domains action.");
    }
  } catch (error) {
    console.error("domains error", (error as Error).message);
    return fail(502, "domains_error", "The registrar request failed. Nothing has been ordered or charged.");
  }
});

/* -------------------------------------------------------------------- search */
async function search(body: Record<string, unknown>) {
  const query = clean(body.query, 100).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (!query) return fail(400, "invalid_input", "Enter a domain to check.");
  if (!DOMAIN_RE.test(query)) {
    return fail(400, "invalid_input", "That does not look like a domain. Try name.com or name.in.");
  }

  const mode = availabilityMode();

  if (mode === "off") {
    return json({
      provider_configured: false,
      availability: "off",
      registration_available: false,
      provider: PROVIDER(),
      message:
        "Availability checks are switched off on this deployment (DOMAIN_AVAILABILITY=off) and no registrar is connected.",
      results: []
    });
  }

  if (mode === "rdap") {
    const check = await rdapLookup(query);
    return json({
      provider_configured: false,
      availability: "rdap",
      registration_available: false,
      provider: PROVIDER(),
      source: "Public registry data (RDAP)",
      message:
        "Availability comes from the public registry, so it is live. Pricing and registration need a registrar account — no price is shown because none has been quoted.",
      results: [
        {
          domain: query,
          available: check.available,
          status: check.status,
          price: null,
          renewal: null,
          currency: null,
          price_known: false,
          detail: check.detail ?? null
        }
      ]
    });
  }

  const payload = await providerCall("/check", { domains: [query] });
  const results = Array.isArray(payload?.results)
    ? payload.results.map((row: Record<string, unknown>) => ({
        domain: String(row.domain ?? query),
        available: Boolean(row.available),
        price: Number(row.price ?? 0),
        renewal: Number(row.renewal ?? 0),
        currency: String(row.currency ?? "INR")
      }))
    : [];

  return json({ provider_configured: true, provider: PROVIDER(), results });
}

/* --------------------------------------------------------------- create_order */
async function createOrder(userId: string, body: Record<string, unknown>) {
  const domain = clean(body.domain, 120).toLowerCase();
  if (!DOMAIN_RE.test(domain)) return fail(400, "invalid_input", "Enter a valid domain name.");

  if (!providerReady()) {
    return fail(503, "domains_unconfigured", "Domain registration is not available on this deployment yet.", {
      hint:
        "Availability checks are live, but ordering needs a registrar: set DOMAIN_PROVIDER, DOMAIN_API_URL and DOMAIN_API_KEY as Edge Function secrets. No order is created and no money is taken until then."
    });
  }

  // Never trust a client-supplied price: re-check with the registrar.
  const check = await providerCall("/check", { domains: [domain] });
  const quote = check?.results?.[0];
  if (!quote?.available) {
    return fail(409, "unavailable", `${domain} is not available to register.`);
  }

  const price = Math.round(Number(quote.price ?? 0));
  if (price <= 0) return fail(502, "quote_failed", "The registrar did not return a price.");

  const { data: existing } = await admin()
    .from("domain_orders")
    .select("id")
    .eq("owner_id", userId)
    .eq("domain_name", domain)
    .in("status", ["pending_payment", "paid", "processing"])
    .maybeSingle();
  if (existing) return fail(409, "order_exists", "There is already an open order for this domain.");

  const { data, error } = await admin()
    .from("domain_orders")
    .insert({
      owner_id: userId,
      domain_name: domain,
      tld: domain.split(".").pop(),
      price,
      currency: quote.currency ?? "INR",
      years: Math.min(Math.max(Number(body.years) || 1, 1), 5),
      provider: PROVIDER(),
      status: "pending_payment"
    })
    .select("*")
    .single();

  if (error) return fail(500, "domains_error", "Could not create the domain order.", { detail: error.message });

  return json({
    order: data,
    next: "pay",
    payment_purpose: `domain:${data.id}`,
    message: "Order created. Complete the payment and the registration starts after verification."
  });
}

/* ------------------------------------------------------------------- connect */
async function connectDomain(userId: string, body: Record<string, unknown>) {
  const fqdn = clean(body.fqdn || body.domain, 120).toLowerCase();
  const projectId = clean(body.projectId, 64) || null;

  if (!DOMAIN_RE.test(fqdn)) return fail(400, "invalid_input", "Enter a valid domain.");
  if (fqdn.endsWith(`.${SUBDOMAIN_ROOT()}`)) {
    return fail(400, "invalid_input", "Shinzora subdomains are managed automatically — no DNS changes are needed.");
  }

  if (projectId) {
    const { data: project } = await admin()
      .from("projects")
      .select("id, owner_id")
      .eq("id", projectId)
      .eq("owner_id", userId)
      .maybeSingle();
    if (!project) return fail(404, "not_found", "That project does not belong to your account.");
  }

  const records = [
    { type: "CNAME", name: "@", value: "sites.shinzora.in", ttl: 3600, note: "Points the apex domain at Shinzora hosting" },
    { type: "CNAME", name: "www", value: "sites.shinzora.in", ttl: 3600, note: "Optional www alias" },
    { type: "TXT", name: "_shinzora", value: `verify=${userId.slice(0, 8)}${projectId ? `-${projectId.slice(0, 8)}` : ""}`, ttl: 3600, note: "Ownership verification" }
  ];

  const { data, error } = await admin()
    .from("domains")
    .upsert(
      {
        owner_id: userId,
        project_id: projectId,
        fqdn,
        name: fqdn.split(".")[0],
        tld: fqdn.split(".").pop(),
        provider: "manual",
        status: "pending_dns",
        dns_records: records
      },
      { onConflict: "fqdn" }
    )
    .select("*")
    .single();

  if (error) return fail(500, "domains_error", "Could not save the domain.", { detail: error.message });

  return json({
    domain: data,
    records,
    status_note:
      "Status stays pending until DNS resolves. Shinzora does not report a domain as connected before verification succeeds."
  });
}

/* ----------------------------------------------------------------------- dns */
async function dnsRecords(userId: string, body: Record<string, unknown>) {
  const domainId = clean(body.domainId, 64);
  const { data } = await admin()
    .from("domains")
    .select("id, fqdn, status, dns_records, provider, verified_at, expires_at")
    .eq("id", domainId)
    .eq("owner_id", userId)
    .maybeSingle();

  if (!data) return fail(404, "not_found", "Domain not found.");
  return json({
    domain: data,
    records: Array.isArray(data.dns_records) ? data.dns_records : [],
    managed: data.provider !== "manual"
  });
}
