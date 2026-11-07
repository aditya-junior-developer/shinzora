import { buildPreviewDocument, brandingBadge, brandingRemovable } from "../public/js/modules/dashboard/builder-core.js";
import { state } from "../public/js/lib/store.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`)); };

const files = {
  "index.html": `<!DOCTYPE html><html><head><title>T</title><link rel="stylesheet" href="styles.css"></head><body><h1>Hello</h1></body></html>`,
  "styles.css": "body{background:#000}",
};

const free = buildPreviewDocument(files, "index.html", { branding: true });
const paid = buildPreviewDocument(files, "index.html", { branding: false });
const noOpt = buildPreviewDocument(files, "index.html");

check("badge injected for free plan", free.includes("Made with Shinzora"));
check("badge absent for paid plan", !paid.includes("Made with Shinzora"));
check("no badge unless explicitly requested", !noOpt.includes("Made with Shinzora"));
check("badge is inside <body>", free.indexOf("Made with Shinzora") < free.indexOf("</body>"));
check("badge inline-styled (works in sandbox, no network)", /style="position:fixed/.test(brandingBadge()));
check("badge escapes target/rel safely", /rel="noopener"/.test(brandingBadge()));
check("CSS still inlined alongside badge", free.includes("background:#000"));
check("sandbox CSP guard still applied", free.includes("base-uri 'none'"));
check("paid output identical to unbranded build", paid === noOpt);
check("html without <body> still gets badge", buildPreviewDocument({"index.html":"<h1>x</h1>"}, "index.html", {branding:true}).includes("Made with Shinzora"));

// plan-driven
state.subscription = { plan: "free" };
check("brandingRemovable false on free", brandingRemovable() === false);
state.subscription = { plan: "pro" };
check("brandingRemovable true on pro", brandingRemovable() === true);
state.subscription = { plan: "enterprise" };
check("brandingRemovable true on enterprise", brandingRemovable() === true);
state.subscription = null;
check("missing subscription defaults to Free", brandingRemovable() === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
