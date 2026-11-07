/* ==========================================================================
   Shinzora — miniature PostgREST over the pre-launch sandbox
   --------------------------------------------------------------------------
   The application talks to PostgREST through supabase-js. For a pre-launch
   session there is no Supabase JWT, so those requests are re-pointed here by a
   custom `fetch` in `public/js/lib/supabase.js`. This module answers the subset
   of the protocol the app actually uses:

     filters   eq, neq, gt, gte, lt, lte, in, is, like, ilike
     shaping   select, order, limit, offset, Range header
     counts    Prefer: count=exact/planned/estimated → Content-Range
     single    Accept: application/vnd.pgrst.object+json
     writes    POST (insert), PATCH (update), DELETE, upsert via Prefer

   Authorisation mirrors RLS: a "user" session only ever sees its own tenant's
   rows and can only write its own tenant's rows; an "admin" session sees and
   changes everything. Nothing here trusts a client-supplied role.
   ========================================================================== */

import { load, save, table as tableOf, hasTable, nextId } from "./store.mjs";

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and", "not"]);

/* ------------------------------------------------------------------ errors */

export class RestError extends Error {
  constructor(message, { status = 400, code = "PGRST100", details = null, hint = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return { message: this.message, code: this.code, details: this.details, hint: this.hint };
  }
}

/* ---------------------------------------------------------------- helpers */

const eq = (a, b) => String(a ?? "") === String(b ?? "");

function coerce(column, value) {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function compare(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== "" && b !== "") return an - bn;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** `%foo%` and `*foo*` → case-insensitive contains (ilike). */
function likeMatcher(pattern, caseInsensitive) {
  const raw = String(pattern).replace(/\*/g, "%");
  const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  const re = new RegExp(`^${escaped}$`, caseInsensitive ? "i" : "");
  return (value) => re.test(String(value ?? ""));
}

function applyFilter(rows, column, operator, rawValue) {
  switch (operator) {
    case "eq":
      return rows.filter((row) => eq(row[column], coerce(column, rawValue)));
    case "neq":
      return rows.filter((row) => !eq(row[column], coerce(column, rawValue)));
    case "gt":
      return rows.filter((row) => compare(row[column], rawValue) > 0);
    case "gte":
      return rows.filter((row) => compare(row[column], rawValue) >= 0);
    case "lt":
      return rows.filter((row) => compare(row[column], rawValue) < 0);
    case "lte":
      return rows.filter((row) => compare(row[column], rawValue) <= 0);
    case "is":
      return rows.filter((row) => (row[column] ?? null) === coerce(column, rawValue));
    case "like":
      return rows.filter((row) => likeMatcher(rawValue, false)(row[column]));
    case "ilike":
      return rows.filter((row) => likeMatcher(rawValue, true)(row[column]));
    case "in": {
      const list = String(rawValue).replace(/^\(|\)$/g, "").split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
      return rows.filter((row) => list.some((candidate) => eq(row[column], candidate)));
    }
    default:
      throw new RestError(`Unsupported operator "${operator}" on "${column}".`, { code: "PGRST100" });
  }
}

/** `or=(full_name.ilike.*a*,email.ilike.*a*)` */
function applyOr(rows, expression) {
  const groups = String(expression)
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((clause) => clause.trim())
    .filter(Boolean);
  return rows.filter((row) =>
    groups.some((clause) => {
      const [column, ...rest] = clause.split(".");
      const operator = rest.shift();
      const value = rest.join(".");
      return applyFilter([row], column, operator, value).length === 1;
    })
  );
}

/* ------------------------------------------------------------ authorisation */

function scope(rows, session) {
  if (!session) return [];
  if (session.account.role === "admin") return rows;
  return rows.filter((row) => row.tenant_id === session.account.tenantId);
}

function assertWritable(row, session) {
  if (session.account.role === "admin") return;
  if (row.tenant_id !== session.account.tenantId) {
    throw new RestError("You do not have access to this resource.", {
      status: 403,
      code: "42501",
      details: "Row Level Security denied the write."
    });
  }
}

/* --------------------------------------------------------------- handlers */

function readTable(root, name, session) {
  const rows = tableOf(root, name);
  return scope(rows, session);
}

function project(rows, columns) {
  if (!columns || columns === "*") return rows;
  const fields = String(columns)
    .split(",")
    .map((field) => field.trim().split(":").pop().trim())
    .filter((field) => field && field !== "*");
  if (!fields.length) return rows;
  return rows.map((row) => {
    const out = {};
    fields.forEach((field) => {
      if (field in row) out[field] = row[field];
    });
    if ("id" in row) out.id = row.id;
    return out;
  });
}

function paginate(rows, { limit, offset, range }) {
  let start = offset;
  let end = null;
  if (range) {
    const match = /^(\d+)-(\d+)?$/.exec(range);
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) + 1 : start + 1;
    }
  }
  if (typeof limit === "number") end = start + limit;
  const slice = rows.slice(start, end ?? undefined);
  return { rows: slice, start, end: start + slice.length, total: rows.length };
}

/**
 * Handle a request.
 * @param {{root:string, table:string|null, rpc:string|null, method:string, query:URLSearchParams, body:any, headers:object, session:object|null}} input
 */
export function handleRest(input) {
  const { root, table, rpc, method, query, headers = {}, session } = input;
  if (!session) throw new RestError("Sign in to continue.", { status: 401, code: "PGRST301" });

  if (rpc) return handleRpc(root, rpc, input);

  if (!table) throw new RestError("No table in the request path.", { code: "PGRST100" });

  if (!hasTable(root, table)) {
    throw new RestError(`Table "${table}" does not exist in the pre-launch sandbox.`, {
      status: 404,
      code: "PGRST205",
      hint: "The sandbox mirrors the production schema; new tables are added by migrations, not by requests."
    });
  }

  const accept = String(headers.accept || "");
  const wantsObject = accept.includes("application/vnd.pgrst.object+json");
  const prefer = String(headers.prefer || "");
  const wantsCount = /count=(exact|planned|estimated)/.test(prefer);
  const returnBody = /return=representation/.test(prefer) || method !== "POST";
  const single = wantsObject || /return=representation/.test(prefer) === false;

  let rows = readTable(root, table, session);

  /* filters */
  for (const [key, raw] of query.entries()) {
    if (key === "or") {
      rows = applyOr(rows, raw);
      continue;
    }
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf(".");
    if (dot === -1) continue;
    const operator = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    rows = applyFilter(rows, key, operator, value);
  }

  /* order */
  const order = query.get("order");
  if (order) {
    const [clause] = order.split(",");
    const [column, directionRaw] = clause.split(".");
    const direction = (directionRaw || "asc").toLowerCase().startsWith("desc") ? -1 : 1;
    rows = [...rows].sort((a, b) => compare(a[column], b[column]) * direction);
  }

  /* writes */
  if (method === "POST") {
    const incoming = Array.isArray(input.body) ? input.body : [input.body];
    const inserted = incoming.filter(Boolean).map((row) => {
      const now = new Date().toISOString();
      const clean = { ...row };
      delete clean.tenant_id; /* never let a client choose its tenant */
      const record = {
        id: clean.id || nextId(table.slice(0, 3)),
        ...clean,
        tenant_id: session.account.tenantId,
        created_at: clean.created_at || now,
        updated_at: now
      };
      if ("owner_id" in record && !record.owner_id) record.owner_id = session.account.id;
      if ("user_id" in record && !record.user_id) record.user_id = session.account.id;
      return record;
    });
    const collection = tableOf(root, table);
    collection.push(...inserted);
    save(root);
    if (!returnBody) return { body: null, headers: {} };
    return { body: wantsObject ? inserted[0] || null : inserted, headers: {} };
  }

  if (method === "PATCH") {
    const patch = { ...(input.body || {}) };
    delete patch.tenant_id;
    delete patch.id;
    patch.updated_at = new Date().toISOString();
    const updated = [];
    const collection = tableOf(root, table);
    rows.forEach((row) => {
      assertWritable(row, session);
      const target = collection.find((entry) => entry.id === row.id);
      if (target) {
        Object.assign(target, patch);
        updated.push(target);
      }
    });
    save(root);
    return { body: wantsObject ? updated[0] || null : updated, headers: {} };
  }

  if (method === "DELETE") {
    const collection = tableOf(root, table);
    rows.forEach((row) => assertWritable(row, session));
    const ids = new Set(rows.map((row) => row.id));
    const kept = collection.filter((row) => !ids.has(row.id));
    collection.length = 0;
    collection.push(...kept);
    save(root);
    return { body: null, headers: {} };
  }

  /* reads */
  const columns = query.get("select");
  const page = paginate(rows, {
    limit: query.has("limit") ? Number(query.get("limit")) : undefined,
    offset: query.has("offset") ? Number(query.get("offset")) : 0,
    range: headers.range
  });

  const shaped = project(page.rows, columns);

  const responseHeaders = {};
  if (wantsCount) {
    const last = page.rows.length ? page.start + page.rows.length - 1 : page.start;
    responseHeaders["content-range"] = `${page.rows.length ? `${page.start}-${last}` : "*"}/${page.total}`;
  }

  const isHead = method === "HEAD";
  let body = isHead ? null : shaped;

  if (!isHead) {
    /* supabase-js `.single()` / `.maybeSingle()` ask for one object. */
    if (wantsObject) {
      /* PostgREST contract: Accept: application/vnd.pgrst.object+json requires
         exactly one row. 0 rows → 406 PGRST116 "The result contains 0 rows"
         (supabase-js .maybeSingle() turns that specific details string into
         `data: null, error: null`, while .single() surfaces the error). */
      if (shaped.length !== 1) {
        throw new RestError("JSON object requested, multiple (or no) rows returned", {
          status: 406,
          code: "PGRST116",
          details: shaped.length
            ? `Results contain ${shaped.length} rows, application/vnd.pgrst.object+json requires 1 row`
            : "The result contains 0 rows"
        });
      }
      body = shaped[0];
      responseHeaders["content-range"] = "0-0/1";
    }
  }

  return { body, headers: responseHeaders };
}

/* ------------------------------------------------------------------- rpcs */

function handleRpc(root, name, input) {
  const { session, body = {} } = input;
  switch (name) {
    case "is_admin":
      return { body: session.account.role === "admin", headers: {} };
    case "admin_role":
      return { body: session.account.role === "admin" ? "owner" : null, headers: {} };
    case "log_activity": {
      const rows = tableOf(root, "customer_activity");
      rows.push({
        id: nextId("act"),
        tenant_id: session.account.tenantId,
        user_id: body.p_user_id || session.account.id,
        action: String(body.p_action || "activity"),
        entity_type: body.p_entity_type || null,
        entity_id: body.p_entity_id || null,
        meta: body.p_meta || {},
        created_at: new Date().toISOString()
      });
      save(root);
      return { body: null, headers: {} };
    }
    case "ai_usage_quota": {
      const subs = tableOf(root, "subscriptions");
      const sub = subs.find((row) => row.user_id === session.account.id);
      return {
        body: { used: sub?.ai_credits_used ?? 0, limit: sub?.ai_credits_limit ?? 30 },
        headers: {}
      };
    }
    default:
      throw new RestError(`Function ${name} is not available in the pre-launch sandbox.`, {
        status: 404,
        code: "PGRST202"
      });
  }
}

export default handleRest;
