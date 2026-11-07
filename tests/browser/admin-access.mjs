/* Admin Access — browser test. Requires `node scripts/dev-server.mjs --port 4173`
   running. It mints a pre-launch administrator session cookie from the local
   .env secret (no stored password is touched) and drives the real console
   against the real sandbox backend. */
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const B = "http://127.0.0.1:4173";
const cookiePair = execSync("node --env-file=.env /tmp/mint.mjs", { cwd: "/home/user/shinzora" }).toString().trim();
const [name, value] = cookiePair.split("=");

let pass = 0, fail = 0;
const check = (n, c, d = "") => (c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? " — " + d : ""}`)));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name, value: decodeURIComponent(value), domain: "127.0.0.1", path: "/", httpOnly: true }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

console.log("\naccess view");
await page.goto(`${B}/admin/?view=access`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#access-table", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200);

const body = () => page.textContent("#access-table");
let text = (await body()).replace(/\s+/g, " ");
check("the page renders the directory", text.length > 20, text.slice(0, 60));
check("it lists the pre-launch customer", /business@business\.com/i.test(text));
check("it lists the owner", /Shinzora@admin/i.test(text));
check("roles are shown", /Super administrator/i.test(text) || /Customer/i.test(text), text.slice(0, 90));
const tabs = await page.$$eval("#access-tabs button", (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
check("four tabs: all / super admins / admins / customers", tabs.length === 4, tabs.join(" | "));
const protectedBadge = (await page.textContent("#access-table")).includes("Protected");
check("the owner is marked protected", protectedBadge);
const ownerRowHasRevoke = await page.$$eval("#access-table tr", (rows) => {
  const row = rows.find((r) => /Shinzora@admin/.test(r.textContent));
  return row ? /Revoke access/.test(row.textContent) : null;
});
check("the protected owner offers no revoke control", ownerRowHasRevoke === false, String(ownerRowHasRevoke));
await page.screenshot({ path: "/home/user/shinzora/docs/media/fixes/admin-access.png", fullPage: true });

console.log("\npromoting the customer through the UI");
const promote = page.locator('#access-table button[data-role="admin"]').first();
check("a promote control exists for the customer", (await promote.count()) === 1);
await promote.click();
await page.waitForSelector("#modal-root .modal, .modal", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);
const dialogText = (await page.textContent("body")).replace(/\s+/g, " ");
check("the dialog names the account", /Make administrator/i.test(dialogText), dialogText.slice(0, 80));
await page.fill('textarea[name="reason"]', "covering support while the owner is away").catch(() => {});
await page.click('.modal button[type="submit"], .modal .btn-primary').catch(() => {});
await page.waitForTimeout(2500);
const afterPromote = (await body()).replace(/\s+/g, " ");
check("the role is applied in the directory", /Administrator/.test(afterPromote) && afterPromote.match(/Administrator/g).length >= 1, afterPromote.slice(0, 100));

const auditText = (await page.textContent("#audit-table").catch(() => "")).replace(/\s+/g, " ");
check("the change appears in the audit trail", /admin\.set_role/.test(auditText), auditText.slice(0, 120));
check("the audit row carries the reason", /covering support/i.test(auditText));

console.log("\nrevoking it again");
const revoke = page.locator('#access-table button[data-role="none"]').first();
if (await revoke.count()) {
  await revoke.click();
  await page.waitForSelector('textarea[name="reason"]', { timeout: 8000 }).catch(() => {});
  await page.fill('textarea[name="reason"]', "cover finished").catch(() => {});
  await page.click('.modal button[type="submit"], .modal .btn-primary').catch(() => {});
  await page.waitForTimeout(2500);
  const afterRevoke = (await body()).replace(/\s+/g, " ");
  const revokedToCustomer = /Customer/.test(afterRevoke);
  check("access can be revoked back to customer", revokedToCustomer, afterRevoke.slice(0, 100));
  const audit2 = (await page.textContent("#audit-table").catch(() => "")).replace(/\s+/g, " ");
  check("the revoke is audited", /admin\.revoke/.test(audit2));
} else {
  check("a revoke control exists for an administrator", false, "none found");
}

console.log("\nmonitoring probes");
await page.goto(`${B}/admin/?view=monitoring`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#probe-body", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);
const probes = (await page.textContent("#probe-body").catch(() => "")).replace(/\s+/g, " ");
check("probes render real results", /readable|passing/i.test(probes), probes.slice(0, 100));
check("no uptime percentage is claimed", !/uptime|99\.9/i.test(probes));
await page.screenshot({ path: "/home/user/shinzora/docs/media/fixes/admin-monitoring-probes.png", fullPage: true });

console.log(`\n  console errors: ${errors.length ? errors.join(" | ") : "none"}`);
check("no uncaught page errors", errors.length === 0, errors.join(" | ").slice(0, 160));
console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
