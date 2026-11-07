/* ==========================================================================
   Routing decisions — where a signed-in account is sent
   --------------------------------------------------------------------------
   Two reported faults are locked down here:

     • the designated administrator kept landing in the customer dashboard and
       being shown the ordinary plan experience, because the old rule only sent
       an administrator to /admin/ if they had NOT completed onboarding
     • "View public site" linked to "/" — Shinzora's own homepage — instead of the
       customer's published website

   Neither decision is allowed to guess: the admin flag comes from the server-side
   is_admin() function, and the published address comes from the customer's own
   project/domain records or not at all.
   ========================================================================== */

import { landingPath, state, resetIdentity } from "../public/js/lib/store.js";
import { resolvePublishedSite } from "../public/js/lib/site-url.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("landingPath");

resetIdentity();
check("signed out → the sign-in page", landingPath() === "/auth/login/", landingPath());

/* A plain customer who has not finished setup. */
state.session = { user: { id: "u1", email: "c@example.com" } };
state.isAdmin = false;
state.onboarding = null;
state.business = null;
check("new customer → onboarding", landingPath() === "/onboarding/", landingPath());

state.onboarding = { completed_at: "2026-01-01T00:00:00Z" };
check("finished customer → dashboard", landingPath() === "/app/", landingPath());

/* The regression: an administrator who has ALSO completed onboarding (they have
   a business row) must still be routed to the console. */
state.isAdmin = true;
check("administrator with a completed business → console", landingPath() === "/admin/", landingPath());

state.onboarding = null;
state.business = null;
check("administrator without onboarding → console", landingPath() === "/admin/", landingPath());

/* The flag is server-derived; a session alone must never imply it. */
state.isAdmin = false;
state.session = { user: { id: "u2" } };
check("a session alone is never administrator access", landingPath() !== "/admin/", landingPath());

console.log("\nresolvePublishedSite");

/** Minimal stand-in for the Supabase query builder: chainable + thenable. */
function stubClient(tables) {
  return {
    from(table) {
      const rows = tables[table] ?? [];
      const result = { data: rows, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      };
      return chain;
    }
  };
}

check(
  "no signed-in account → nothing to open",
  (await resolvePublishedSite({ client: stubClient({}), userId: "" })) === null
);

const notPublished = stubClient({ projects: [] });
check(
  "no published project → null, not the marketing homepage",
  (await resolvePublishedSite({ client: notPublished, userId: "u1" })) === null
);

const platformHosted = stubClient({
  projects: [{ id: "p1", slug: "aster-studio", status: "published", updated_at: "2026-02-01" }],
  domains: []
});
check(
  "published project → the platform address for that project",
  (await resolvePublishedSite({ client: platformHosted, userId: "u1" })) === "/site/?p=aster-studio"
);

const customDomain = stubClient({
  projects: [{ id: "p1", slug: "aster-studio", status: "published", updated_at: "2026-02-01" }],
  domains: [{ fqdn: "asterstudio.in", project_id: "p1", status: "active", verified_at: "2026-02-02T00:00:00Z" }]
});
check(
  "a verified custom domain wins",
  (await resolvePublishedSite({ client: customDomain, userId: "u1" })) === "https://asterstudio.in"
);

const unverifiedDomain = stubClient({
  projects: [{ id: "p1", slug: "aster-studio", status: "published", updated_at: "2026-02-01" }],
  domains: [{ fqdn: "asterstudio.in", project_id: "p1", status: "pending", verified_at: null }]
});
check(
  "an unverified domain is never presented as the live address",
  (await resolvePublishedSite({ client: unverifiedDomain, userId: "u1" })) === "/site/?p=aster-studio"
);

const failing = {
  from: () => ({
    select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ then: (r) => r({ data: null, error: new Error("boom") }) }) }) }) }) })
  })
};
let threw = null;
try {
  await resolvePublishedSite({ client: failing, userId: "u1" });
} catch (error) {
  threw = error;
}
check("a failed lookup raises instead of inventing a URL", Boolean(threw && /boom/.test(threw.message)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
