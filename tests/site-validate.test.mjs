/* ==========================================================================
   Validation — the preview stage has to be able to say "this is broken"
   --------------------------------------------------------------------------
   Each check is exercised twice: once on a document that has the fault (it must
   be reported) and once on a document that does not (it must stay quiet).
   ========================================================================== */

import { validateSiteDocument, validationSummary, collectRoutes, collectIds } from "../public/js/lib/site-validate.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const clean = `<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aster Studio</title><style>h1{color:#111}</style></head>
<body>
<nav><a href="#/">Home</a><a href="#/about">About</a><a href="#/contact">Contact</a></nav>
<div data-route="/"><h1>Aster Studio</h1><img src="data:image/png;base64,AAA" alt="Studio interior">
<button id="go">Enquire</button><script>document.getElementById('go').addEventListener('click',function(){});</script></div>
<section data-route="/about" hidden><h1>About</h1><p id="team">Team</p><a href="#/about">Top</a></section>
<section data-route="/contact" hidden><h1>Contact</h1></section>
</body></html>`;

console.log("a document with nothing wrong");
const good = validateSiteDocument(clean);
check("it passes", good.ok, JSON.stringify(good.issues));
check("no errors", good.counts.error === 0);
check("no warnings", good.counts.warning === 0, JSON.stringify(good.issues.map((i) => i.code)));
check("the routes are read from the document", good.routes.length === 3, JSON.stringify(good.routes));
check("the summary is honest about a clean document", validationSummary(good) === "No problems found in this version.");

console.log("\nbroken internal links");
const brokenRoute = validateSiteDocument(clean.replace('href="#/contact"', 'href="#/pricing"'));
check("a link to a page that does not exist is an error",
  brokenRoute.issues.some((i) => i.code === "broken-route" && i.level === "error"),
  JSON.stringify(brokenRoute.issues.map((i) => i.code)));
check("the message names the address", brokenRoute.issues.some((i) => i.detail.includes("#/pricing")));

const brokenAnchor = validateSiteDocument(clean.replace('<a href="#/about">Top</a>', '<a href="#/about">Top</a><a href="#nope">x</a>'));
check("an anchor with no target is a warning",
  brokenAnchor.issues.some((i) => i.code === "broken-anchor" && i.level === "warning"));
check("a working anchor is not reported", !good.issues.some((i) => i.code === "broken-anchor"));

console.log("\nlinks that cannot resolve in one file");
const fileLink = validateSiteDocument(clean.replace('<a href="#/contact">Contact</a>', '<a href="contact.html">Contact</a>'));
check("a link to a relative .html file is an error", fileLink.issues.some((i) => i.code === "broken-link" && i.level === "error"));
check("a hash route is not reported as a file link", !good.issues.some((i) => i.code === "broken-link"));
check("a mailto link is not a file link", !validateSiteDocument(clean.replace('href="#/contact"', 'href="mailto:a@b.c"')).issues.some((i) => i.code === "broken-link"));
check("an external link is not a file link", !validateSiteDocument(clean.replace('href="#/contact"', 'href="https://example.com/x.html"')).issues.some((i) => i.code === "broken-link"));

console.log("\nmissing assets in a one-file site");
const missing = validateSiteDocument(clean.replace('src="data:image/png;base64,AAA"', 'src="images/hero.jpg"'));
check("a relative image path is an error", missing.ok === false);
check("it is reported as a missing asset", missing.issues.some((i) => i.code === "missing-asset"));
check("an embedded data URI is accepted", !good.issues.some((i) => i.code === "missing-asset"));
const remote = validateSiteDocument(clean.replace('src="data:image/png;base64,AAA"', 'src="https://images.example.com/hero.jpg"'));
check("a remote image is not an error", remote.ok);
check("but the customer is told it needs a connection", remote.issues.some((i) => i.code === "external" && i.level === "info"));
check("the host is named", remote.externalHosts.includes("images.example.com"));

console.log("\njavascript errors");
const badScript = validateSiteDocument(clean.replace("document.getElementById('go').addEventListener('click',function(){});", "const = ;"));
check("an inline script that does not parse is an error", badScript.ok === false);
check("it is reported as a syntax error", badScript.issues.some((i) => i.code === "js-syntax"));
check("a document with valid JS stays clean", !good.issues.some((i) => i.code === "js-syntax"));
const jsonScript = validateSiteDocument(clean.replace("<style>", '<script type="application/ld+json">{"a":1}</script><style>'));
check("a JSON-LD block is not treated as JavaScript", !jsonScript.issues.some((i) => i.code === "js-syntax"));

console.log("\nlayout and accessibility");
const noViewport = validateSiteDocument(clean.replace(/<meta name="viewport"[^>]*>/, ""));
check("no viewport is an error", noViewport.issues.some((i) => i.code === "viewport" && i.level === "error"));

const noH1 = validateSiteDocument(clean.replace(/<h1>Aster Studio<\/h1>/, "<h2>Aster Studio</h2>").replace(/<h1>About<\/h1>/, "").replace(/<h1>Contact<\/h1>/, ""));
check("no h1 is a warning", noH1.issues.some((i) => i.code === "h1" && i.level === "warning"));

const noAlt = validateSiteDocument(clean.replace(' alt="Studio interior"', ""));
check("an image without alt text is a warning", noAlt.issues.some((i) => i.code === "img-alt"));

const noLang = validateSiteDocument(clean.replace(' lang="en"', ""));
check("a missing lang is a warning", noLang.issues.some((i) => i.code === "lang"));

const noDoctype = validateSiteDocument(clean.replace("<!doctype html>", ""));
check("a missing doctype is a warning", noDoctype.issues.some((i) => i.code === "doctype"));

const deadButtons = validateSiteDocument(clean.replace(/<script>document[\s\S]*?<\/script>/, ""));
check("buttons with no handler are reported", deadButtons.issues.some((i) => i.code === "dead-buttons"));

console.log("\nplanned pages");
const planned = validateSiteDocument(clean, { requiredRoutes: ["/", "/about", "/contact", "/pricing"] });
check("a planned page that is absent is reported", planned.issues.some((i) => i.code === "missing-page"));
check("planned pages that exist are not reported twice",
  planned.issues.filter((i) => i.code === "missing-page").length === 1,
  String(planned.issues.filter((i) => i.code === "missing-page").length));

console.log("\nhonesty rules");
const empty = validateSiteDocument("");
check("an empty document fails rather than passing by default", empty.ok === false);
check("and says there is nothing to check", empty.issues[0].code === "empty");
check("the summary counts the real problems", validationSummary(noViewport).includes("problem"));
check("collectRoutes falls back to / when there is no router", [...collectRoutes("<h1>x</h1>")].join() === "/");
check("collectIds sees ids and routes", collectIds('<div id="a"></div><section data-route="/b"></section>').has("b"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
