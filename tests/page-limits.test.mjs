/* ==========================================================================
   Page limits and mandatory standards (P4)
   --------------------------------------------------------------------------
   Checks, with no network:
   - the pure builder helpers (limits, panel state, trimming, upgrade options,
     reading database refusals)
   - the browser's mandatory list is exactly the SQL rule set (0050), minus
     js-syntax, which SQL cannot check
   - the plan numbers agree across env.js, the database and the edge function
   - the wiring: the build reads the plan from the database, and the publish
     guard checks pages (0051)
   ========================================================================== */

import { readFileSync } from "node:fs";
import { PLAN_LIMITS } from "../public/js/config/env.js";
import { MANDATORY_CODES, isMandatory, blockingIssues, validateSiteDocument } from "../public/js/lib/site-validate.js";
import {
  pageLimitFor,
  resolveLimit,
  pageState,
  trimToLimit,
  upgradeOptions,
  limitWords,
  standardsFailure
} from "../public/js/modules/dashboard/builder/page-limits.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

console.log("plan limits");
check("free allows 1 page", pageLimitFor("free") === 1);
check("pro allows 3 pages", pageLimitFor("pro") === 3);
check("enterprise is unlimited", pageLimitFor("enterprise") === null);
check("an unknown plan counts as free", pageLimitFor("nonsense") === 1 && pageLimitFor(undefined) === 1);
check("starter is Free (1 page)", pageLimitFor("starter") === 1);
check("growth is Pro (3 pages)", pageLimitFor("growth") === 3);
check("scale is Enterprise (unlimited)", pageLimitFor("scale") === null);
check("plan names are case-insensitive", pageLimitFor("PRO") === 3);

console.log("server-reported limit");
check("uses the server's answer when it has one", resolveLimit({ plan: "pro", page_limit: 3 }, "free").limit === 3);
check("server says unlimited", resolveLimit({ plan: "enterprise", page_limit: null }, "enterprise").limit === null);
check("a failed lookup falls back to free, never wider", resolveLimit(null, "free").limit === 1);
check("a failed lookup for a legacy growth plan is Pro, not free", resolveLimit(null, "growth").limit === 3);
check("reports whether the server answered", resolveLimit({ page_limit: 1, plan: "free" }, "free").fromServer === true);

console.log("page state");
check("one of one is at the limit", pageState(["index"], 1).atLimit === true);
check("two of one is over", pageState(["a", "b"], 1).over === true);
check("unlimited never reports over", pageState(["a", "b", "c", "d", "e", "f"], null).over === false);
check("remaining counts down", pageState(["a"], 3).remaining === 2);

console.log("trimming");
check("keeps the first pages in order", JSON.stringify(trimToLimit(["Home", "About", "Shop"], 2)) === '["Home","About"]');
check("unlimited keeps every page", trimToLimit(["a", "b", "c", "d"], null).length === 4);
check("a non-array becomes empty", trimToLimit(null, 1).length === 0);

console.log("upgrade options");
const fromFree = upgradeOptions("free").map((o) => o.id);
check("free is offered pro and enterprise", fromFree.includes("pro") && fromFree.includes("enterprise"), JSON.stringify(fromFree));
check("free does not offer itself", !fromFree.includes("free"));
check("enterprise has nothing above it", upgradeOptions("enterprise").length === 0, JSON.stringify(upgradeOptions("enterprise")));
check("options are cheapest first", upgradeOptions("free").length < 2 || upgradeOptions("free")[0].priceMonthly <= upgradeOptions("free")[1].priceMonthly);

console.log("wording");
check("1 page is singular", limitWords(1) === "1 page");
check("3 pages is plural", limitWords(3) === "3 pages");
check("unlimited says so", limitWords(null) === "unlimited pages");
check("screens for apps", limitWords(2, "screen") === "2 screens");

console.log("reading a database refusal");
const pageRefusal = { hint: '{"code":"page_limit","plan":"free","limit":1,"pages":3}' };
check("reads a page-limit refusal", standardsFailure(pageRefusal)?.kind === "page_limit" && standardsFailure(pageRefusal).limit === 1);
const qualityRefusal = { hint: JSON.stringify({ code: "quality", problems: [{ title: "Missing language", detail: "Set lang." }] }) };
check("reads a quality refusal with its problems", standardsFailure(qualityRefusal)?.problems?.[0]?.title === "Missing language");
check("reads a no-version refusal", standardsFailure({ hint: '{"code":"no_version"}' })?.kind === "no_version");
check("ignores an unrelated error", standardsFailure({ message: "network down", hint: null }) === null);
check("ignores a hint that is not JSON", standardsFailure({ hint: "try again" }) === null);

console.log("mandatory standards");
const sqlSource = read("supabase/migrations/0050_site_quality_page_limits.sql");
const fnStart = sqlSource.indexOf("function public.sz_site_standard_problems");
const fnEnd = sqlSource.indexOf("$$;", fnStart);
const sqlBody = sqlSource.slice(fnStart, fnEnd);
const sqlCodes = [...new Set([...sqlBody.matchAll(/'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))].filter((c) =>
  ["broken-anchor", "broken-link", "broken-route", "doctype", "empty", "img-alt", "lang", "missing-asset", "placeholder-text", "title", "viewport"].includes(c)
);
const expected = [...sqlCodes].sort();
const browser = MANDATORY_CODES.filter((c) => c !== "js-syntax").sort();
check("the browser's mandatory list matches the database rules", JSON.stringify(browser) === JSON.stringify(expected), `browser=${browser} sql=${expected}`);
check("js-syntax is the only browser-only mandatory check", MANDATORY_CODES.includes("js-syntax") && !expected.includes("js-syntax"));
check("h1 is advice, not a gate", !MANDATORY_CODES.includes("h1"));
check("an error-level issue is always mandatory", isMandatory({ level: "error", code: "anything" }));
check("a listed warning is mandatory", isMandatory({ level: "warning", code: "lang" }));
check("an unlisted warning is not", !isMandatory({ level: "warning", code: "no-nav" }));

const noLang = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>X</title></head><body><div data-route="/"><h1>X</h1></div></body></html>`;
const blocked = blockingIssues(validateSiteDocument(noLang));
check("a page with no lang is refused by the browser too", blocked.some((i) => i.code === "lang"), JSON.stringify(blocked.map((i) => i.code)));

console.log("plan numbers agree");
check("env.js: free 1, pro 3, enterprise unlimited", PLAN_LIMITS.free.pages === 1 && PLAN_LIMITS.pro.pages === 3 && PLAN_LIMITS.enterprise.pages === null);
const sqlPlan = sqlSource.match(/function public\.sz_page_limit[\s\S]*?\$\$;/)?.[0] || "";
check("0050 sz_page_limit: free 1, pro 3, enterprise null", /'free'[\s\S]*?1/.test(sqlPlan) && /'pro'[\s\S]*?3/.test(sqlPlan) && /'enterprise'[\s\S]*?null/.test(sqlPlan), sqlPlan.slice(0, 200));
const aiSource = read("supabase/functions/ai/index.ts");
const aiLimit = aiSource.match(/function pageLimitFor[\s\S]*?\n}\n/)?.[0] || "";
check("ai/index.ts pageLimitFor: free 1, pro 3, enterprise null", /enterprise[\s\S]*?null/.test(aiLimit) && /pro[\s\S]*?3/.test(aiLimit) && /return 1/.test(aiLimit), aiLimit);

console.log("wiring");
check("the build reads the plan from the database, not the request", /from\("subscriptions"\)\.select\("plan"\)\.eq\("user_id", caller\.user\.id\)/.test(aiSource));
check("a build over the limit is refused before any work starts", /requestedPages\.length > pageLimit[\s\S]{0,300}"page_limit"/.test(aiSource));
check("the old fixed cap is gone", !/BUILD_MAX_PAGES/.test(aiSource));
const mig51 = read("supabase/migrations/0051_publish_page_limit.sql");
check("0051 publish guard checks the owner's page limit", /sz_page_limit\(v_plan\)/.test(mig51) && /code', 'page_limit'/.test(mig51));
check("0052 maps starter, growth and scale in sz_page_limit", /when 'growth'\s+then 3/.test(read("supabase/migrations/0052_plan_names_page_limits.sql")) && /when 'scale'\s+then null/.test(read("supabase/migrations/0052_plan_names_page_limits.sql")));
check("0051 keeps the early return for unchanged published sites", /old\.published_version_id is not distinct from new\.published_version_id/.test(mig51));
const builder = read("public/js/modules/dashboard/builder-core.js");
check("the builder sends the chosen pages, not a fixed list", /S\.answers\.information\[pagesField\]/.test(builder));
check("the builder shows the limit and upgrade options", /pageLimitPanel\(\)/.test(builder) && /upgradeOptions/.test(builder));
check("save is refused before any write when a standard fails", /versionBlocker\(generated\.html, S\.validation \|\| generated\.validation\)/.test(builder));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
