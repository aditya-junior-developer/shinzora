/* ==========================================================================
   Migration 0012 — the app package rules, in the database
   --------------------------------------------------------------------------
   Each rule is attacked the way a hostile (or merely buggy) client would attack
   it: a direct insert with the wrong pairing, an iOS request from a Free plan,
   and a job that claims to be built with no file behind it.
   ========================================================================== */

import path from "node:path";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this SQL suite did not run.");
  process.exit(0);
}

const { SCAFFOLD, migrationFiles, apply } = await import("../scripts/staging-db.mjs");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const db = new PGlite();
await db.exec(SCAFFOLD);

for (const file of migrationFiles()) {
  try {
    await apply(db, file);
  } catch (error) {
    check(`${path.basename(file)} applies`, false, error.message.split("\n")[0]);
  }
}

await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`);

/* The migration revokes these; the blanket grant above would undo it, so put the
   production privilege state back the way a real apply leaves it. */
await db.exec(`
  revoke all on function public.app_target_allowed(text, text, uuid) from public, anon;
  revoke all on function public.app_package_options(uuid) from public, anon;
  revoke all on function public.app_platform_slots(uuid) from public, anon;
`);

console.log("the migration landed");
const { rows: fn } = await db.query(`
  select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('app_target_allowed','app_package_options')`);
check("both functions exist", fn.length === 2, JSON.stringify(fn.map((f) => f.proname)));
check("both are SECURITY DEFINER", fn.every((f) => f.prosecdef === true));
const { rows: trigger } = await db.query(
  `select tgname from pg_trigger where tgname = 'conversion_jobs_guard' and not tgisinternal`
);
check("the conversion guard is installed", trigger.length === 1);

/* ---- fixtures ----------------------------------------------------------- */
await db.exec(`
  insert into auth.users (id, email) values
    ('${CUSTOMER}', 'customer@example.com'),
    ('${OTHER}',    'other@example.com'),
    ('${ADMIN}',    'admin@example.com');
  insert into public.admin_users (user_id, email, role) values ('${ADMIN}', 'admin@example.com', 'admin');
  insert into public.projects (owner_id, name, type) values ('${CUSTOMER}', 'Clinic app', 'app');
`);

const { rows: project } = await db.query(`select id from public.projects where owner_id = '${CUSTOMER}'`);
const projectId = project[0].id;

const asCustomer = async () => {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${CUSTOMER}', false);`);
};
const asOther = async () => {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false);`);
};
const asAdmin = async () => {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
};
const asService = async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
};
const setPlan = async (plan) => {
  await asService();
  await db.exec(`update public.subscriptions set plan = '${plan}' where user_id = '${CUSTOMER}'`);
  await asCustomer();
};

const insertJob = (platform, target, extra = "") =>
  db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name, package_id ${extra ? ", " + Object.keys(
    Object.fromEntries(extra.split(",").map((pair) => pair.split("=")))
  ).join(", ") : ""})
           values ('${CUSTOMER}', '${projectId}', '${platform}', '${target}', 'Clinic'${extra})`);

console.log("\nthe format must match the platform");
await asCustomer();
await setPlan("free");

let wrongPairing = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name)
                 values ('${CUSTOMER}', '${projectId}', 'ios', 'aab', 'Fake iOS bundle')`);
} catch (error) {
  wrongPairing = error.message;
}
check("an iOS AAB is refused", /does not belong|row-level security|check constraint/i.test(String(wrongPairing)), String(wrongPairing || "accepted"));

let androidIpa = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name)
                 values ('${CUSTOMER}', '${projectId}', 'android', 'ipa', 'Wrong way round')`);
} catch (error) {
  androidIpa = error.message;
}
check("an Android IPA is refused", /does not belong|row-level security|check constraint/i.test(String(androidIpa)), String(androidIpa || "accepted"));

console.log("\nthe plan decides the platforms");
await asCustomer();
await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name, package_id)
               values ('${CUSTOMER}', '${projectId}', 'android', 'apk', 'Clinic', 'in.shinzora.clinic')`);
const { rows: apkJob } = await db.query(`select id, target, status from public.conversion_jobs`);
check("a Free plan can queue an APK", apkJob.length === 1 && apkJob[0].target === "apk");
check("and it starts queued", apkJob[0].status === "queued");

let freeIos = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name, package_id)
                 values ('${CUSTOMER}', '${projectId}', 'ios', 'ipa', 'Clinic', 'in.shinzora.clinic')`);
} catch (error) {
  freeIos = error.message;
}
check("a Free plan cannot queue an iOS build", /Enterprise|one platform|row-level security/i.test(String(freeIos)), String(freeIos || "accepted"));

const { rows: options } = await db.query(`select platform, target, allowed from public.app_package_options('${CUSTOMER}') order by target`);
check("the option list offers three formats", options.length === 3, JSON.stringify(options));
check("Free: APK and AAB allowed", options.filter((o) => o.platform === "android").every((o) => o.allowed === true));
check("Free: IPA refused", options.find((o) => o.target === "ipa").allowed === false);

await setPlan("pro");
const { rows: proOptions } = await db.query(`select target, allowed from public.app_package_options('${CUSTOMER}') order by target`);
check("Pro still targets one platform", proOptions.find((o) => o.target === "ipa").allowed === false);

await setPlan("enterprise");
const { rows: entOptions } = await db.query(`select target, allowed, reason from public.app_package_options('${CUSTOMER}') order by target`);
check("Enterprise allows all three", entOptions.every((o) => o.allowed === true), JSON.stringify(entOptions));
check("and explains nothing is blocked", entOptions.every((o) => o.reason === ""));

console.log("\nEnterprise can queue the iOS job, but it still cannot claim a build");
await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name, package_id)
               values ('${CUSTOMER}', '${projectId}', 'ios', 'ipa', 'Clinic', 'in.shinzora.clinic')`);
const { rows: iosJob } = await db.query(`select id, platform, target, status from public.conversion_jobs where platform = 'ios'`);
check("an Enterprise IPA request is accepted", iosJob.length === 1 && iosJob[0].status === "queued");

let clientBuilt = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, platform, target, app_name, status)
                 values ('${CUSTOMER}', 'android', 'apk', 'Instant build', 'built')`);
} catch (error) {
  clientBuilt = error.message;
}
check("a client cannot open a job already marked built", /queued|row-level security|permission/i.test(String(clientBuilt)), String(clientBuilt || "accepted"));

const { rows: promoted } = await db.query(`update public.conversion_jobs set status = 'built' where id = '${iosJob[0].id}' returning id`);
check("a client cannot promote a job to built", promoted.length === 0);

console.log("\neven the server cannot claim a build with no file");
await asService();
let hollow = null;
try {
  await db.exec(`update public.conversion_jobs set status = 'built' where id = '${iosJob[0].id}'`);
} catch (error) {
  hollow = error.message;
}
check("built without an artifact is refused", /checksum|artifact/i.test(String(hollow)), String(hollow || "accepted"));

let noPath = null;
try {
  await db.exec(`update public.conversion_jobs set status = 'built', artifact_bytes = 1024, artifact_sha256 = 'abc'
                  where id = '${iosJob[0].id}'`);
} catch (error) {
  noPath = error.message;
}
check("a byte count and checksum without a path is refused", /artifact/i.test(String(noPath)), String(noPath || "accepted"));

const { rows: realBuild } = await db.query(`
  update public.conversion_jobs
     set status = 'built', artifact_path = 'builds/clinic.ipa', artifact_bytes = 4096, artifact_sha256 = repeat('a', 64)
   where id = '${iosJob[0].id}'
  returning status, artifact_path, artifact_sha256`);
check("a build with a file, a size and a checksum is accepted", realBuild.length === 1 && realBuild[0].status === "built");

let failedWithArtifact = null;
try {
  await db.exec(`update public.conversion_jobs set status = 'failed' where id = '${iosJob[0].id}'`);
} catch (error) {
  failedWithArtifact = error.message;
}
check("a failed job cannot keep pointing at an artifact", /failed or expired/i.test(String(failedWithArtifact)), String(failedWithArtifact || "accepted"));

console.log("\npackage ids and names");
await asCustomer();
let badId = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, platform, target, app_name, package_id)
                 values ('${CUSTOMER}', 'android', 'aab', 'Clinic', 'Not A Package Id')`);
} catch (error) {
  badId = error.message;
}
check("a malformed package id is refused", /package id/i.test(String(badId)), String(badId || "accepted"));

let noName = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, platform, target, app_name)
                 values ('${CUSTOMER}', 'android', 'aab', '   ')`);
} catch (error) {
  noName = error.message;
}
check("a blank app name is refused", /name/i.test(String(noName)), String(noName || "accepted"));

console.log("\nownership and duplicates");
await asOther();
const { rows: otherSees } = await db.query(`select count(*)::int n from public.conversion_jobs`);
check("another customer sees no jobs", Number(otherSees[0].n) === 0);

await asCustomer();
let duplicate = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, project_id, platform, target, app_name, package_id)
                 values ('${CUSTOMER}', '${projectId}', 'android', 'apk', 'Clinic', 'in.shinzora.clinic')`);
} catch (error) {
  duplicate = error.message;
}
check("a second open request for the same target is refused", /duplicate|unique/i.test(String(duplicate)), String(duplicate || "accepted"));

await asAdmin();
const { rows: adminSees } = await db.query(`select count(*)::int n from public.conversion_jobs`);
check("an administrator can see every request", Number(adminSees[0].n) >= 2);

console.log("\nentitlement cannot be self-granted");
await asCustomer();
const { rows: selfPlan } = await db.query(`update public.subscriptions set plan = 'enterprise' where user_id = '${CUSTOMER}' returning plan`);
check("a customer cannot upgrade their own plan", selfPlan.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
