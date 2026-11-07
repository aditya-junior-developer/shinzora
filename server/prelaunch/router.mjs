/* ==========================================================================
   Shinzora — pre-launch API router (server only)
   --------------------------------------------------------------------------
   One request handler shared by the local dev server and the Vercel function,
   so the two deployments can never drift apart.

   Routes (all under /api/prelaunch):
     GET  health                    what is configured (no secrets)
     POST auth/login                {email,password} → HttpOnly session cookie
     POST auth/logout
     GET  auth/session              {authenticated, role, email, expiresAt}
     GET  identity                  profile/business/subscription for the store
     ALL  rest/v1/:table            mini PostgREST over the sandbox store
     ALL  rest/v1/rpc/:fn           is_admin, admin_role, log_activity, ai_usage_quota
     POST fn/:name                  {action, ...payload} — ai | admin | site
     GET  monitor                   event log + change summary (admin only)
     POST monitor/read              mark the log read (admin only)
     POST events                    client error / activity reporting
     POST reset                     re-seed the sandbox (admin only)
   ========================================================================== */

import {
  accounts,
  findByEmail,
  verifyPassword,
  issueSession,
  sessionFromRequest,
  sessionCookie,
  clearCookie
} from "./auth-core.mjs";
import { handleRest, RestError } from "./rest.mjs";
import { handleFunction, FunctionError } from "./functions.mjs";
import { load, reset, table as tableOf, ADMIN_ACCOUNT } from "./store.mjs";
import monitor from "./monitor.mjs";
import { handleStorage } from "./storage.mjs";

const PREFIX = "/api/prelaunch";
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 25;
/* Loopback is a developer machine, not an attacker. Throttling it would only
   lock the person running the local preview out of their own test accounts. */
const TRUSTED = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"]);
const attempts = new Map();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function throttled(ip) {
  if (TRUSTED.has(ip)) return false;
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    attempts.set(ip, { start: now, count: 0 });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function noteAttempt(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) attempts.set(ip, { start: now, count: 1 });
  else entry.count += 1;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RestError("Malformed JSON body.", { status: 400, code: "invalid_json" });
  }
}

const json = (res, status, body, headers = {}) => {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(payload);
};

function isSecure(req) {
  return (
    (req.headers["x-forwarded-proto"] || "").split(",")[0] === "https" ||
    Boolean(req.socket?.encrypted)
  );
}

function actorOf(session) {
  if (!session) return null;
  return { id: session.account.id, email: session.account.displayEmail, role: session.account.role };
}

function publicSession(session) {
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    id: session.account.id,
    email: session.account.displayEmail,
    name: session.account.name,
    role: session.account.role,
    isAdmin: session.account.role === "admin",
    tenantId: session.account.tenantId,
    expiresAt: new Date(session.payload.exp * 1000).toISOString(),
    sandbox: true
  };
}

/** The identity payload the client store consumes. */
function identityFor(root, session) {
  const account = session.account;
  const people = tableOf(root, "profiles");
  const profile = people.find((row) => row.id === account.id) || null;
  const business = tableOf(root, "businesses").find((row) => row.owner_id === account.id) || null;
  const subscription = tableOf(root, "subscriptions").find((row) => row.user_id === account.id) || null;
  const onboarding = tableOf(root, "onboarding_progress").find((row) => row.user_id === account.id) || null;
  const notifications = tableOf(root, "notifications").filter((row) => row.user_id === account.id && !row.read_at);

  return {
    account: {
      id: account.id,
      email: account.displayEmail,
      name: account.name,
      role: account.role,
      isAdmin: account.role === "admin",
      prelaunch: true
    },
    profile,
    business,
    subscription,
    onboarding,
    isAdmin: account.role === "admin",
    unread: notifications.length,
    sandbox: true
  };
}

/**
 * Handle one API request. Returns true when the request was handled here, so
 * the dev server can fall through to static files for everything else.
 */

/* --------------------------------------------------------------------------
   Administrator identity, two ways in.

   The monitoring panel is the only part of the console that reads the
   pre-launch service, so it must accept whoever the console already trusts:

     · a pre-launch session cookie (the sandbox accounts), or
     · a Supabase access token belonging to a row in public.admin_users.

   The token is verified against the project's own /auth/v1/user endpoint, and
   the admin check is a REST read performed *with that user's token*, so the
   same row level security that protects the admin console decides the answer.
   No secret is used here and none leaves the server.
   -------------------------------------------------------------------------- */
const adminCache = new Map();

async function supabaseAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const cached = adminCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.account;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) return null;

  try {
    const userRes = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user?.id) return null;

    const adminRes = await fetch(
      `${url}/rest/v1/admin_users?select=role,email&user_id=eq.${encodeURIComponent(user.id)}`,
      { headers: { apikey: key, Authorization: `Bearer ${token}` } }
    );
    if (!adminRes.ok) return null;
    const rows = await adminRes.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const account = {
      id: user.id,
      email: user.email || rows[0].email,
      role: "admin",
      tenantId: null,
      via: "supabase"
    };
    /* Short-lived: revocation in admin_users takes effect within a minute. */
    adminCache.set(token, { account, expires: Date.now() + 60_000 });
    return account;
  } catch {
    return null;
  }
}

/** The administrator behind this request, or null. */
async function adminAccount(req) {
  const session = sessionFromRequest(req);
  if (session?.account?.role === "admin") return { ...session.account, via: "prelaunch" };
  return supabaseAdmin(req);
}

export async function handlePrelaunchRequest(req, res, { root, url }) {
  const pathname = url.pathname;
  if (!pathname.startsWith(PREFIX)) return false;

  const route = pathname.slice(PREFIX.length) || "/";
  const method = (req.method || "GET").toUpperCase();
  const secure = isSecure(req);

  try {
    /* -------------------------------------------------------------- health */
    if (route === "/health") {
      const list = accounts();
      json(res, 200, {
        enabled: list.length > 0,
        accounts: list.map((account) => ({ role: account.role, email: account.displayEmail })),
        ai_configured: Boolean(process.env.SHINZORA_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        sandbox: true
      });
      return true;
    }

    /* --------------------------------------------------------------- login */
    if (route === "/auth/login" && method === "POST") {
      const ip = clientIp(req);
      if (throttled(ip)) {
        monitor.record(root, {
          type: "auth.login",
          severity: "warn",
          message: "Sign-in throttled — too many attempts from this address",
          actor: null,
          meta: { ip }
        });
        json(res, 429, { error: "Too many sign-in attempts. Wait a few minutes and try again.", code: "rate_limited" });
        return true;
      }
      noteAttempt(ip);

      const body = await readBody(req);
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const account = findByEmail(email);

      if (!account) {
        /* Not a pre-launch account: say so explicitly so the client falls
           through to Supabase Auth instead of treating this as a bad password. */
        json(res, 200, { prelaunch: false, reason: "not_prelaunch_account" });
        return true;
      }

      if (!password || !verifyPassword(password, account.hash)) {
        monitor.record(root, {
          type: "auth.login",
          severity: "warn",
          message: `Failed pre-launch sign-in for ${account.displayEmail}`,
          actor: { id: account.id, email: account.displayEmail, role: account.role },
          meta: { ip }
        });
        json(res, 401, { error: "Email or password is incorrect.", code: "invalid_credentials" });
        return true;
      }

      load(root);
      const { token, payload, maxAge } = issueSession(account);
      monitor.record(root, {
        type: "auth.login",
        severity: "info",
        message: `${account.role === "admin" ? "Administrator" : "Pre-launch user"} signed in`,
        actor: actorOf({ account }),
        meta: { ip, expires: new Date(payload.exp * 1000).toISOString() }
      });

      json(
        res,
        200,
        { prelaunch: true, session: publicSession({ account, payload }) },
        { "set-cookie": sessionCookie(token, { secure, maxAge }) }
      );
      return true;
    }

    /* -------------------------------------------------------------- logout */
    if (route === "/auth/logout" && method === "POST") {
      const session = sessionFromRequest(req);
      if (session) {
        monitor.record(root, {
          type: "auth.logout",
          severity: "info",
          message: "Signed out",
          actor: actorOf(session),
          meta: null
        });
      }
      json(res, 200, { ok: true }, { "set-cookie": clearCookie({ secure }) });
      return true;
    }

    /* ------------------------------------------------------------- session */
    if (route === "/auth/session") {
      const session = sessionFromRequest(req);
      json(res, 200, publicSession(session));
      return true;
    }

    /* ------------------------------------------------------------ identity */
    if (route === "/identity") {
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { error: "Not signed in.", code: "unauthenticated" });
        return true;
      }
      json(res, 200, identityFor(root, session));
      return true;
    }

    /* ------------------------------------------------------------ storage */
    if (route.startsWith("/storage/v1/")) {
      const handled = await handleStorage({ req, res, root, url });
      if (handled) return true;
    }

    /* --------------------------------------------------------------- rest */
    if (route.startsWith("/rest/v1/")) {
      const session = sessionFromRequest(req);
      const rest = route.slice("/rest/v1/".length);
      const isRpc = rest.startsWith("rpc/");
      const body = method === "GET" || method === "HEAD" ? null : await readBody(req);

      let result;
      try {
        result = handleRest({
          root,
          table: isRpc ? null : rest,
          rpc: isRpc ? rest.slice(4) : null,
          method,
          query: url.searchParams,
          body,
          headers: req.headers,
          session
        });
      } catch (error) {
        if (error instanceof RestError) {
          json(res, error.status, error.toJSON());
          return true;
        }
        throw error;
      }

      if (["POST", "PATCH", "DELETE"].includes(method) && session) {
        monitor.record(root, {
          type: "data.write",
          severity: "info",
          message: `${method} ${isRpc ? `rpc/${rest.slice(4)}` : rest}`,
          actor: actorOf(session),
          meta: null
        });
      }
      json(res, 200, result.body, result.headers);
      return true;
    }

    /* ---------------------------------------------------------- functions */
    if (route.startsWith("/fn/")) {
      const session = sessionFromRequest(req);
      const name = route.slice(4);

      /* Two functions are public in the deployed project (verify_jwt=false) and
         must behave identically here:
           · config — provider booleans + model name, read before sign-in
           · site   — the /site/?p=slug renderer, published projects only
         Neither returns user data or a key. Every other function requires a
         session, exactly like the deployed verify_jwt=true functions. */
      if (!session && name !== "config" && name !== "site") {
        json(res, 401, { error: "Sign in to continue.", code: "unauthenticated" });
        return true;
      }

      const body = await readBody(req);
      const action = body.action || "default";
      const { action: _ignored, ...payload } = body;
      const result = await handleFunction(root, name, action, payload, session);
      if (session) {
        monitor.record(root, {
          type: name === "admin" ? "admin.action" : "service.call",
          severity: "info",
          message: `${name}:${action}`,
          actor: actorOf(session),
          meta: name === "admin" ? payload : null
        });
      }
      json(res, 200, result);
      return true;
    }

    /* ------------------------------------------------------------ monitor */
    if (route === "/monitor") {
      const account = await adminAccount(req);
      if (!account) {
        json(res, 403, {
          error: "Administrator access required.",
          code: "forbidden",
          hint:
            "Add this account to public.admin_users, or sign in with an account that is already on that list."
        });
        return true;
      }
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
      const changes = monitor.trackChanges(root, { log: true });
      json(res, 200, {
        events: monitor.events(root, { limit, type: url.searchParams.get("type") || null }),
        unread: monitor.unread(root),
        changes,
        ai_configured: Boolean(process.env.SHINZORA_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      });
      return true;
    }

    if (route === "/monitor/read" && method === "POST") {
      const account = await adminAccount(req);
      if (!account) {
        json(res, 403, { error: "Administrator access required.", code: "forbidden" });
        return true;
      }
      json(res, 200, monitor.markRead(root));
      return true;
    }

    /* ------------------------------------------------------------- events */
    if (route === "/events" && method === "POST") {
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { error: "Not signed in.", code: "unauthenticated" });
        return true;
      }
      const body = await readBody(req);
      const kind = String(body.type || "client.error");
      if (kind === "client.error") monitor.recordClientError(root, session, body);
      else if (kind === "feature.use") {
        monitor.record(root, {
          type: "feature.use",
          severity: "info",
          message: String(body.message || "Feature used").slice(0, 200),
          actor: actorOf(session),
          meta: { view: String(body.view || "").slice(0, 80) }
        });
      }
      json(res, 200, { ok: true });
      return true;
    }

    /* -------------------------------------------------------------- reset */
    if (route === "/reset" && method === "POST") {
      const session = sessionFromRequest(req);
      if (!session || session.account.role !== "admin") {
        json(res, 403, { error: "Administrator access required.", code: "forbidden" });
        return true;
      }
      reset(root);
      monitor.record(root, {
        type: "system.reset",
        severity: "notice",
        message: "Sandbox data re-seeded by the administrator",
        actor: actorOf(session),
        meta: null
      });
      json(res, 200, { ok: true, sandbox: "reseeded" });
      return true;
    }

    json(res, 404, { error: `No pre-launch route for ${route}.`, code: "not_found" });
    return true;
  } catch (error) {
    const known = error instanceof RestError || error instanceof FunctionError;
    const status = known ? error.status : 500;
    if (!known) {
      console.error("[prelaunch]", error);
      monitor.record(root, {
        type: "server.error",
        severity: "error",
        message: String(error?.message || error).slice(0, 300),
        actor: null,
        meta: { route }
      });
    }
    json(res, status, known ? error.toJSON() : { error: "Pre-launch service error.", code: "server_error" });
    return true;
  }
}

/** Boot-time monitoring: record the start and diff the public tree. */
export function bootMonitor(root) {
  monitor.record(root, {
    type: "system.boot",
    severity: "info",
    message: "Pre-launch service started",
    actor: null,
    meta: { pid: process.pid }
  });
  const changes = monitor.trackChanges(root, { log: true });
  return changes;
}

export { ADMIN_ACCOUNT };
export default handlePrelaunchRequest;
