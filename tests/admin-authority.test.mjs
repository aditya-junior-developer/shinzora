/* ============================================================================
   Shinzora — administrator authority (sandbox backend)
   ----------------------------------------------------------------------------
   Phase 3 gave super administrators real power over other people's accounts and
   real power to remove records. This suite exercises the sandbox implementation
   of migration 0009 the way an attacker would use it: as a customer, as an
   ordinary administrator, and as a super administrator trying to break their
   own safeguards.

   The SQL rules themselves are proven separately, against real PostgreSQL 18,
   by `node scripts/staging-db.mjs` (25 checks under [0009]).

     node tests/admin-authority.test.mjs
   ========================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleFunction } from "../server/prelaunch/functions.mjs";
import * as store from "../server/prelaunch/store.mjs";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`));

/* A throwaway store so the checked-in sandbox data is never touched. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shinzora-admin-"));
process.env.PRELAUNCH_DATA_DIR = dir;
const root = { dir };
store.reset(root);
const db = () => store.load(root);

const ADMIN = { id: store.ADMIN_ACCOUNT, role: "admin", tenantId: "tenant_admin", displayEmail: "Shinzora@admin", name: "Shinzora Owner" };
const CUSTOMER = { id: store.USER_ACCOUNT, role: "customer", tenantId: "tenant_user", displayEmail: "business@business.com", name: "Tester" };

const admin = (action, payload = {}) => handleFunction(root, "admin", action, payload, { account: ADMIN });
const customer = (action, payload = {}) => handleFunction(root, "admin", action, payload, { account: CUSTOMER });

const refused = async (fn) => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: error.code, status: error.status, message: error.message };
  }
};

/* A second, ordinary customer to act on. */
const other = {
  id: "11111111-2222-4333-8444-555555555555",
  tenant_id: "tenant_other",
  full_name: "Other Owner",
  email: "other@example.test",
  role: "customer",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};
store.table(root, "profiles").push(other);
store.table(root, "subscriptions").push({
  id: "sub_other",
  user_id: other.id,
  plan: "free",
  status: "active",
  ai_credits_used: 12,
  ai_credits_limit: 30,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});
store.save(root);

console.log("\ncustomers cannot reach administrator surfaces");
for (const [action, payload] of [
  ["directory", {}],
  ["set_role", { userId: other.id, role: "superadmin" }],
  ["reset_credits", { userId: other.id }],
  ["subscription_change", { userId: CUSTOMER.id, plan: "enterprise" }],
  ["payment_delete", { paymentId: "x", reason: "mine now" }],
  ["archive_record", { table: "support_tickets", id: "x" }],
  ["audit", {}]
]) {
  const result = await refused(() => customer(action, payload));
  check(`customer → ${action} is refused`, !result.ok && result.status === 403, result.ok ? "succeeded" : `${result.status}`);
}

console.log("\nthe directory shows everyone, with roles");
const directory = await admin("directory");
const roles = new Set(directory.users.map((u) => u.role));
check("directory lists every account", directory.users.length >= 3, String(directory.users.length));
check("the owner is a super administrator", roles.has("superadmin"), [...roles].join(", "));
check("plain customers appear as users", roles.has("user"), [...roles].join(", "));
check("the protected owner is flagged", directory.users.some((u) => u.protected && u.role === "superadmin"));
check("super administrators are listed first", directory.users[0].role === "superadmin", directory.users[0].role);

console.log("\npromotion and demotion");
const promote = await admin("set_role", { userId: other.id, role: "admin", reason: "helping with support" });
check("a super administrator can promote", promote?.result?.role === "admin", JSON.stringify(promote));
check("promotion updates the profile too", db().tables.profiles.find((p) => p.id === other.id).role === "admin");
check("promotion is in the audit trail", db().tables.admin_audit.some((a) => a.action === "admin.set_role" && a.target_id === other.id));
check("the audit entry names the actor and reason", (() => {
  const entry = db().tables.admin_audit.find((a) => a.action === "admin.set_role");
  return Boolean(entry?.actor_email) && entry.reason === "helping with support";
})());

const selfDemote = await refused(() => admin("set_role", { userId: ADMIN.id, role: "none", reason: "stepping down" }));
check("the protected owner cannot be revoked", !selfDemote.ok && /protected owner/i.test(selfDemote.message), selfDemote.message);
check("and is still a super administrator", db().tables.admin_users.some((r) => r.user_id === ADMIN.id && r.role === "owner"));

const lastSuper = await refused(() => admin("set_role", { userId: ADMIN.id, role: "admin", reason: "demote myself" }));
check("the last super administrator cannot be demoted", !lastSuper.ok && /protected owner|last super/i.test(lastSuper.message), lastSuper.message);

const grantSuper = await admin("set_role", { userId: other.id, role: "superadmin", reason: "co-owner" });
check("a second super administrator can be created", grantSuper?.result?.role === "superadmin", JSON.stringify(grantSuper));
const demoteSecond = await admin("set_role", { userId: other.id, role: "admin", reason: "handing back" });
check("a second super administrator can be demoted", demoteSecond?.result?.role === "admin", JSON.stringify(demoteSecond));

const revoke = await admin("set_role", { userId: other.id, role: "none", reason: "no longer needed" });
check("administrator access can be revoked", revoke?.result?.role === "none", JSON.stringify(revoke));
check("revoking removes the administrator row", !db().tables.admin_users.some((r) => r.user_id === other.id));
check("revoking returns the profile to owner", db().tables.profiles.find((p) => p.id === other.id).role === "owner");
check("revoking is audited", db().tables.admin_audit.some((a) => a.action === "admin.revoke" && a.target_id === other.id));

const badRole = await refused(() => admin("set_role", { userId: other.id, role: "godmode" }));
check("an invented role is refused", !badRole.ok && /admin, superadmin or none/.test(badRole.message), badRole.message);

console.log("\nAI credits and subscriptions");
const before = db().tables.subscriptions.find((s) => s.user_id === other.id);
check("starting point: credits are used", Number(before.ai_credits_used) === 12, String(before.ai_credits_used));
const reset = await admin("reset_credits", { userId: other.id, reason: "goodwill" });
check("a super administrator can reset AI credits", reset?.result?.ok === true, JSON.stringify(reset));
check("credits are actually zero afterwards", Number(db().tables.subscriptions.find((s) => s.user_id === other.id).ai_credits_used) === 0);
check("the reset is recorded as a subscription event", db().tables.subscription_events.some((e) => e.action === "credits_reset" && e.user_id === other.id));
check("and in the audit trail", db().tables.admin_audit.some((a) => a.action === "subscription.reset_credits"));

const upgrade = await admin("subscription_change", { userId: other.id, plan: "pro", reason: "paid" });
const upgraded = db().tables.subscriptions.find((s) => s.user_id === other.id);
check("a plan change applies", upgraded.plan === "pro", JSON.stringify(upgrade));
check("the plan's credit limit comes with it", upgraded.ai_credits_limit === 800, String(upgraded.ai_credits_limit));
check("a plan change is recorded with from → to", db().tables.subscription_events.some((e) => e.action === "plan_changed" && e.from_plan === "free" && e.to_plan === "pro"));

const badPlan = await refused(() => admin("subscription_change", { userId: other.id, plan: "platinum" }));
check("an invented plan is refused", !badPlan.ok && /free, pro or enterprise/.test(badPlan.message), badPlan.message);
const nothing = await refused(() => admin("subscription_change", { userId: other.id }));
check("a no-op change is refused instead of silently succeeding", !nothing.ok, nothing.ok ? "succeeded" : nothing.message);

console.log("\npayment removal rules");
const payments = store.table(root, "payments");
const insert = (fields) => {
  const row = {
    id: `pay_${payments.length}_${Math.random().toString(36).slice(2, 6)}`,
    owner_id: CUSTOMER.id,
    tenant_id: CUSTOMER.tenantId,
    reference: `SZ-TEST${payments.length}`,
    purpose: "pro",
    label: "Pro plan",
    amount: 2499,
    currency: "INR",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...fields
  };
  payments.push(row);
  store.save(root);
  return row;
};

const verified = insert({ status: "verified", verified_at: new Date().toISOString(), utr: "UTRVERIFIED1" });
const claimed = insert({ status: "awaiting_verification", utr: "UTRCLAIMED1" });
const abandoned = insert({ status: "pending" });

const voidVerified = await admin("payment_delete", { paymentId: verified.id, reason: "customer disputed", hard: true });
const verifiedRow = db().tables.payments.find((p) => p.id === verified.id);
check("a verified payment is voided, not deleted", voidVerified?.result?.removal === "voided", JSON.stringify(voidVerified));
check("the verified row and its amount survive", Boolean(verifiedRow) && Number(verifiedRow.amount) === 2499);
check("it carries a void time and reason", Boolean(verifiedRow.voided_at) && verifiedRow.void_reason === "customer disputed");
check("the outcome is audited as a void", db().tables.admin_audit.some((a) => a.action === "payment.void" && a.target_id === verified.id));

const voidClaimed = await admin("payment_delete", { paymentId: claimed.id, reason: "no credit seen", hard: true });
check("a payment the customer claims to have sent is never hard-deleted", voidClaimed?.result?.removal === "voided", JSON.stringify(voidClaimed));

const hardDelete = await admin("payment_delete", { paymentId: abandoned.id, reason: "abandoned checkout", hard: true });
check("a payment that never held money can be deleted", hardDelete?.result?.removal === "deleted", JSON.stringify(hardDelete));
check("it is gone from the store", !db().tables.payments.some((p) => p.id === abandoned.id));
const snapshot = db().tables.admin_audit.find((a) => a.action === "payment.hard_delete" && a.target_id === abandoned.id);
check("the deleted row was preserved in the audit snapshot", Number(snapshot?.before?.amount) === 2499, JSON.stringify(snapshot?.before));

const softDefault = insert({ status: "rejected" });
const soft = await admin("payment_delete", { paymentId: softDefault.id, reason: "duplicate" });
check("a rejected payment is archived by default, not destroyed", soft?.result?.removal === "voided" && db().tables.payments.some((p) => p.id === softDefault.id));

const noReason = await refused(() => admin("payment_delete", { paymentId: verified.id, reason: "" }));
check("a removal without a reason is refused", !noReason.ok && /reason is required/i.test(noReason.message), noReason.message);

const listing = await admin("payments", { status: "all" });
check("voided payments leave the admin list", !listing.payments.some((p) => p.id === verified.id), `${listing.payments.length} rows`);

console.log("\narchiving");
store.table(root, "support_tickets").push({
  id: "ticket_1",
  owner_id: CUSTOMER.id,
  tenant_id: CUSTOMER.tenantId,
  subject: "Help",
  status: "open",
  created_at: new Date().toISOString()
});
store.save(root);
const archive = await admin("archive_record", { table: "support_tickets", id: "ticket_1", reason: "resolved by email" });
check("a ticket can be archived", archive?.result?.ok === true, JSON.stringify(archive));
check("the archived ticket keeps its row with a timestamp", Boolean(db().tables.support_tickets.find((t) => t.id === "ticket_1").archived_at));
const tickets = await admin("tickets", {});
check("archived tickets leave the active list", !tickets.tickets.some((t) => t.id === "ticket_1"));
const badTable = await refused(() => admin("archive_record", { table: "payments", id: verified.id }));
check("only archivable tables are accepted", !badTable.ok && /cannot be archived/.test(badTable.message), badTable.message);

console.log("\nthe audit trail");
const audit = await admin("audit", { limit: 200 });
const actions = new Set(audit.entries.map((e) => e.action));
check("every privileged action is present", ["admin.set_role", "admin.revoke", "subscription.reset_credits", "payment.void", "payment.hard_delete", "record.archive"].every((a) => actions.has(a)), [...actions].join(", "));
check("entries are newest first", audit.entries[0].created_at >= audit.entries[audit.entries.length - 1].created_at);
check("no entry exposes a password, token or key", !JSON.stringify(audit.entries).match(/password|sb_publishable|AQ\./i));

console.log("\nmonitoring probes are real reads");
const monitor = await admin("monitor");
check("probes return a check list", Array.isArray(monitor.checks) && monitor.checks.length >= 3, JSON.stringify(monitor.checks?.length));
check("each probe reports its own outcome", monitor.checks.every((c) => typeof c.ok === "boolean" && typeof c.name === "string"));
check("the sandbox says plainly that Supabase is not probed here", monitor.checks.some((c) => /sandbox/i.test(c.detail)));
check("nothing claims an uptime percentage", !JSON.stringify(monitor).match(/uptime|SLA|99\.9/i));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
