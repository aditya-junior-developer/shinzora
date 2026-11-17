/* ==========================================================================
   Business stage — the four stages, badges, roadmap and onboarding copy.
   Pure checks: no browser and no database. The database side is in
   business-stage-db.test.mjs; the page behaviour is in browser/business-stage.mjs.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const env = await import("../public/js/config/env.js");
const stage = await import("../public/js/lib/business-stage.js");
const { BUSINESS_STAGES } = env;

console.log("stages");
check("exactly four stages, in order", BUSINESS_STAGES.map((s) => s.id).join(",") === "ideation,mvp,scaling,established");
check(
  "labels are the approved names",
  BUSINESS_STAGES.map((s) => s.label).join("|") === "Ideation|MVP|Scaling|Established Business"
);
check("each stage has a tone for its badge", BUSINESS_STAGES.every((s) => ["ideation", "mvp", "scaling", "established"].includes(s.tone)));
check("each description is one short sentence", BUSINESS_STAGES.every((s) => s.desc.length > 40 && s.desc.length <= 140 && !/[\n<>]/.test(s.desc)));
check("descriptions are distinct", new Set(BUSINESS_STAGES.map((s) => s.desc)).size === 4);
check("each stage has a focus line", BUSINESS_STAGES.every((s) => typeof s.focus === "string" && s.focus.length > 20));

console.log("legacy values");
check("idea → ideation", stage.normalizeStage("idea") === "ideation");
check("starting → mvp", stage.normalizeStage("starting") === "mvp");
check("operating → scaling", stage.normalizeStage("operating") === "scaling");
check("growing → established", stage.normalizeStage("growing") === "established");
check("canonical values pass through", stage.normalizeStage("scaling") === "scaling");
check("unknown and empty become no stage", stage.normalizeStage("enterprise") === "" && stage.normalizeStage(null) === "");

console.log("badges");
check("ideation badge uses the brown tone", stage.stageBadge("ideation").includes("stage-badge--ideation"));
check("mvp badge uses the gold tone", stage.stageBadge("mvp").includes("stage-badge--mvp"));
check("scaling badge uses the purple-and-black tone", stage.stageBadge("scaling").includes("stage-badge--scaling"));
check("established badge uses the platinum tone", stage.stageBadge("established").includes("stage-badge--established"));
check("badge shows the approved label", stage.stageBadge("established").includes("Established Business"));
const unset = stage.stageBadge(null);
check("no stage shows a prompt, not a coloured badge", unset.includes("Stage not set") && unset.includes("stage-badge--unset"));
check("no-stage prompt can link to Settings", stage.stageBadge(null, { link: true }).includes('href="/app/?view=settings"'));
check("badge escapes its input", !stage.stageBadge("<img>").includes("<img>"));

console.log("option cards");
const cards = stage.stageOptionsHtml({ selected: "mvp", prefix: "t" });
check("four option cards", (cards.match(/data-stage-option=/g) || []).length === 4);
const checkedCards = cards.split("data-stage-option=").slice(1).filter((part) => part.includes('aria-checked="true"'));
check("only the selected card is checked, and it is MVP", checkedCards.length === 1 && checkedCards[0].startsWith('"mvp"'));
check("cards are a radio group's options", (cards.match(/role="radio"/g) || []).length === 4);

console.log("roadmap");
const views = new Set([...read("public/js/modules/dashboard/router.js").matchAll(/^\s+"?([a-z-]+)"?: \(\) => import/gm)].map((m) => m[1]));
for (const s of BUSINESS_STAGES) {
  const items = stage.stageChecklist(s.id, {}, {});
  check(`${s.label}: has steps`, items.length >= 3, `${items.length} steps`);
  const bad = items.filter((item) => {
    const m = /\?view=([a-z-]+)$/.exec(item.href);
    return !m || !views.has(m[1]);
  });
  check(`${s.label}: every step links to a real dashboard view`, bad.length === 0, bad.map((b) => b.href).join(", "));
}
const mvpDone = stage.stageChecklist("mvp", { productCount: 2, orderCount: 0, projects: [{ status: "published" }] }, {});
check("MVP step marked done only when a published project exists", mvpDone.find((i) => i.label.includes("publish")).done === true);
check("MVP product step done from the product count", mvpDone.find((i) => i.label.includes("product")).done === true);
check("MVP orders step stays open with no orders", mvpDone.find((i) => i.label.includes("orders")).done === false);
check("a step with no record is never marked done", stage.stageChecklist("scaling", {}, {}).every((i) => i.done !== true));
check("ideation description step done only when a description exists", stage.stageChecklist("ideation", {}, { description: "Coffee" })[0].done === true);
check("next step is the first open item", stage.nextStep(mvpDone).label.includes("customer support"));
check("no next step when every item is done", stage.nextStep([{ done: true }]) === null);

console.log("save guard");
let networkCalled = false;
try {
  await stage.saveBusinessStage("00000000-0000-4000-8000-000000000001", "growing");
} catch (error) {
  networkCalled = /Choose one of the four stages/.test(error.message);
}
check("an invalid stage is refused before any request", networkCalled);
let noBusiness = false;
try {
  await stage.saveBusinessStage("", "mvp");
} catch (error) {
  noBusiness = /Save your business profile/.test(error.message);
}
check("no business means no save", noBusiness);

console.log("onboarding copy");
const ob = read("public/onboarding/index.html");
check("heading is exact", ob.includes("What stage is your business currently in?"));
check("subtext is exact", ob.includes("Tell us where you are today so SHINZORA can help you move forward."));
check("no old onboarding labels remain", !/Idea stage|Just starting|>Operating<|>Growing</.test(ob));
check("stage cards are rendered from the shared list", /stageOptionsHtml/.test(read("public/js/boot/onboarding.js")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
