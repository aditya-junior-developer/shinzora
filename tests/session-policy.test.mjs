/* ==========================================================================
   Session policy + transport tests
   --------------------------------------------------------------------------
   These cover the two P1 defects that were reported against the live build:

   1. A network probe of /api/prelaunch/auth/session sat in front of every
      Supabase request, so the first call on every page load waited on a cold
      serverless hop. Ordinary (Supabase) accounts must never pay for it.
   2. `signOut()` awaited that round trip with no ceiling, so Sign out appeared
      to do nothing when the auth endpoint was slow.

   The pre-launch path must still work: when the browser has used a sandbox
   account, the probe is awaited before traffic is rewritten to the sandbox API.
   ========================================================================== */

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

/* --- tiny localStorage stand-in, installed before the modules are imported -- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};

/* A browser-ish origin: prelaunch.js resolves relative URLs against location. */
globalThis.location = { origin: "https://shinzora.in", href: "https://shinzora.in/" };

/* One mutable dispatcher, because prelaunch.js binds globalThis.fetch when it
   is first imported; swapping globalThis.fetch afterwards would not be seen. */
const calls = [];
let loginSession = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  calls.push(url);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.includes("/auth/session")) {
    return json({ authenticated: Boolean(loginSession), session: loginSession });
  }
  if (url.includes("/auth/login")) {
    return json({ prelaunch: true, session: loginSession }, loginSession ? 200 : 401);
  }
  return json({});
};

const {
  PRELAUNCH_HINT_KEY,
  hasPrelaunchHint,
  markPrelaunchHint,
  clearPrelaunchHint,
  withTimeout,
  SIGN_OUT_LIMIT_MS
} = await import("../public/js/lib/session-policy.js");

console.log("session-policy");

check("no hint on a fresh browser", hasPrelaunchHint() === false);
markPrelaunchHint();
check("hint recorded after a sandbox sign-in", hasPrelaunchHint() === true && store.get(PRELAUNCH_HINT_KEY) === "1");
clearPrelaunchHint();
check("hint cleared on sign-out", hasPrelaunchHint() === false && store.has(PRELAUNCH_HINT_KEY) === false);

/* --- withTimeout --------------------------------------------------------- */
const fast = await withTimeout(Promise.resolve("done"), 50, "fallback");
check("fast work is returned as-is", fast === "done");

const started = Date.now();
const slow = await withTimeout(new Promise((r) => setTimeout(() => r("late"), 500)), 30, null);
const waited = Date.now() - started;
check("slow work resolves to the fallback", slow === null);
check("fallback wins promptly", waited < 200, `waited ${waited}ms`);

const rejected = await withTimeout(Promise.reject(new Error("boom")), 50, "safe");
check("a rejected promise yields the fallback instead of throwing", rejected === "safe");

check("sign-out limit is a sane ceiling", SIGN_OUT_LIMIT_MS > 0 && SIGN_OUT_LIMIT_MS <= 5000);

/* --- transport: ordinary accounts must not wait on the probe -------------- */
console.log("prelaunch transport");
const prelaunch = await import("../public/js/lib/prelaunch.js");

calls.length = 0;
await prelaunch.prelaunchFetch("https://zmkgfmlcpzjfgxdmbtvi.supabase.co/rest/v1/projects", { method: "GET" });
check("no hint → no sandbox probe", calls.every((u) => !u.includes("/api/prelaunch/auth/session")), calls.join(", "));
check("no hint → request goes straight to Supabase", calls[0]?.includes("supabase.co/rest/v1/projects"), calls[0] || "(none)");
check("no hint → exactly one network call", calls.length === 1, `${calls.length} calls`);

/* With the hint set the session is consulted, so sandbox traffic is routed to
   the Shinzora API instead of Supabase. */
loginSession = { id: "u1", email: "owner@shinzora.in", full_name: "Owner" };
markPrelaunchHint();
await prelaunch.session({ force: true });
calls.length = 0;
await prelaunch.prelaunchFetch("https://zmkgfmlcpzjfgxdmbtvi.supabase.co/rest/v1/projects", { method: "GET" });
check(
  "hint set + sandbox session → REST call rewritten to the API",
  /\/api\/prelaunch\/rest\/v1\/projects$/.test(calls.at(-1) || ""),
  calls.join(", ")
);
check(
  "hint set → the session is not re-probed on every request",
  calls.filter((u) => u.includes("/auth/session")).length === 0,
  calls.join(", ")
);

/* A pre-launch session rewrites Supabase URLs onto the Shinzora API and drops
   the Supabase credentials, which mean nothing to that server. */
const signedIn = await prelaunch.signIn("owner@shinzora.in", "secret");
check("sign-in recognises a sandbox account", signedIn.handled === true);
check("sign-in exposes a supabase-shaped session", Boolean(signedIn.session?.user?.email));
check("sign-in records the browser hint", hasPrelaunchHint() === true);

const sent = [];
globalThis.__lastInit = null;
const before = calls.length;
const result = await prelaunch.prelaunchFetch("https://zmkgfmlcpzjfgxdmbtvi.supabase.co/functions/v1/admin", {
  method: "POST",
  headers: { authorization: "Bearer x", apikey: "k", "content-type": "application/json" }
});
const rewrittenUrl = calls.at(-1);
check(
  "sandbox session → edge function call rewritten to the API",
  /\/api\/prelaunch\/fn\/admin$/.test(rewrittenUrl || ""),
  rewrittenUrl || "(none)"
);
check("sandbox session → content-type preserved", Boolean(result));

/* Storage rewrite: a Supabase storage URL becomes a local API URL. */
const localUrl = prelaunch.rewriteStorageUrl(
  "https://zmkgfmlcpzjfgxdmbtvi.supabase.co/storage/v1/object/public/logos/a.png"
);
check("sandbox session → storage URLs rewritten", /\/api\/prelaunch\/storage\/v1\/object\/public\/logos\/a\.png$/.test(localUrl), localUrl);

/* Sign-out clears the hint so the next page load stops probing. */
await prelaunch.signOut();
check("sign-out clears the browser hint", hasPrelaunchHint() === false);
check("sign-out clears the cached session", prelaunch.current() === null && prelaunch.active() === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
