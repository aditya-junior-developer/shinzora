/* ==========================================================================
   Shinzora — pre-launch accounts: credentials and sessions (server only)
   --------------------------------------------------------------------------
   The two pre-launch accounts are NOT Supabase Auth users. They are verified
   here, in Node, on the server:

     • passwords are stored only as scrypt digests (never plaintext, never in
       anything the browser can download)
     • comparison is constant-time
     • a successful sign-in mints an HMAC-SHA256 signed token that lives in an
       HttpOnly cookie, so page JavaScript cannot read it
     • the browser can only ask "who am I?" — it can never assert a role

   Environment (server-side only, .env / Vercel project settings):
     PRELAUNCH_USER_EMAIL            business@business.com
     PRELAUNCH_USER_PASSWORD_HASH    scrypt$N$r$p$salt$key
     PRELAUNCH_ADMIN_EMAIL           Shinzora@admin
     PRELAUNCH_ADMIN_PASSWORD_HASH   scrypt$N$r$p$salt$key
     PRELAUNCH_SESSION_SECRET        >= 32 random bytes, hex
   ========================================================================== */

import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/* ------------------------------------------------------------- passwords */

/** Hash a plaintext password. Used by scripts/prelaunch-credentials.mjs. */
export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const { N, r, p, keylen } = SCRYPT;
  const key = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time verification against a stored scrypt digest. */
export function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.startsWith("scrypt$")) return false;
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = stored.split("$");
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!N || !r || !p || !saltRaw || !keyRaw) return false;

  let expected;
  let salt;
  try {
    salt = Buffer.from(saltRaw, "base64url");
    expected = Buffer.from(keyRaw, "base64url");
  } catch {
    return false;
  }
  if (!expected.length) return false;

  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* --------------------------------------------------------------- accounts */

/**
 * The account catalogue, read from the environment on every call so a changed
 * .env (or a redeploy) takes effect without a code change.
 * Ids are stable: sandbox rows are keyed by them.
 */
export function accounts(env = process.env) {
  const list = [];
  if (env.PRELAUNCH_USER_EMAIL && env.PRELAUNCH_USER_PASSWORD_HASH) {
    list.push({
      id: "pl_user_1",
      tenantId: "pl_tenant_user",
      role: "user",
      email: String(env.PRELAUNCH_USER_EMAIL).trim().toLowerCase(),
      displayEmail: String(env.PRELAUNCH_USER_EMAIL).trim(),
      hash: env.PRELAUNCH_USER_PASSWORD_HASH,
      name: "Pre-Launch Tester",
      business: "Aurora & Co."
    });
  }
  if (env.PRELAUNCH_ADMIN_EMAIL && env.PRELAUNCH_ADMIN_PASSWORD_HASH) {
    list.push({
      id: "pl_admin_1",
      tenantId: "pl_tenant_admin",
      role: "admin",
      email: String(env.PRELAUNCH_ADMIN_EMAIL).trim().toLowerCase(),
      displayEmail: String(env.PRELAUNCH_ADMIN_EMAIL).trim(),
      hash: env.PRELAUNCH_ADMIN_PASSWORD_HASH,
      name: "Shinzora Owner",
      business: "Shinzora"
    });
  }
  return list;
}

export function findByEmail(email, env = process.env) {
  const needle = String(email || "").trim().toLowerCase();
  if (!needle) return null;
  return accounts(env).find((account) => account.email === needle) || null;
}

/* ---------------------------------------------------------------- sessions */

const COOKIE = "sz_prelaunch";
const TTL_SECONDS = 60 * 60 * 12;

const b64 = (value) => Buffer.from(value).toString("base64url");

function secret(env = process.env) {
  const value = env.PRELAUNCH_SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "PRELAUNCH_SESSION_SECRET is missing or too short. Run `node scripts/prelaunch-credentials.mjs --init` to generate one."
    );
  }
  return value;
}

export function signToken(payload, env = process.env) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret(env)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(token, env = process.env) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret(env)).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export function issueSession(account, env = process.env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: account.id,
    tid: account.tenantId,
    role: account.role,
    email: account.displayEmail,
    name: account.name,
    iat: now,
    exp: now + TTL_SECONDS
  };
  return { token: signToken(payload, env), payload, maxAge: TTL_SECONDS };
}

export function sessionFromRequest(req, env = process.env) {
  const raw = req.headers?.cookie || "";
  const match = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const payload = verifyToken(decodeURIComponent(match.slice(COOKIE.length + 1)), env);
  if (!payload) return null;
  const account = accounts(env).find((entry) => entry.id === payload.sub);
  if (!account) return null;
  return { account, payload };
}

export function sessionCookie(token, { secure = false, maxAge = TTL_SECONDS } = {}) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie({ secure = false } = {}) {
  return sessionCookie("", { secure, maxAge: 0 });
}

export const SESSION_COOKIE_NAME = COOKIE;
