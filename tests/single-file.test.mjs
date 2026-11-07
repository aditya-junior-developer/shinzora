/* ==========================================================================
   Single-file export — one index.html, every page inside it
   --------------------------------------------------------------------------
   The model returns whatever shape it likes. These tests pin the contract the
   customer was promised: one file, hash routing, no local references left over,
   and a downloaded file that opens with everything in it.
   ========================================================================== */

import { toSingleFile, routeFor, normalizePath, rewriteHrefs, singleFileDownload } from "../public/js/lib/single-file.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

console.log("paths and routes");
check("index.html is the root route", routeFor("index.html") === "/");
check("./index.html normalises to index.html", normalizePath("./index.html") === "index.html");
check("a leading slash is removed", normalizePath("/assets/app.css") === "assets/app.css");
check("a query string is removed", normalizePath("page.html?x=1") === "page.html");
check("about.html becomes /about", routeFor("about.html") === "/about");
check("a nested page keeps its folder", routeFor("pages/pricing.html") === "/pages/pricing");

console.log("\nthe model's multi-file answer, collapsed");
const files = {
  "index.html": `<!doctype html><html lang="en"><head><title>Home</title>
<link rel="stylesheet" href="styles.css"></head>
<body><nav><a href="about.html">About</a><a href="index.html">Home</a><a href="https://example.com">Out</a></nav>
<h1>Aster Studio</h1><img src="hero.jpg" alt="studio">
<script src="app.js"></script></body></html>`,
  "about.html": `<!doctype html><html><head><title>About us</title></head><body><h1>About</h1><p>Since 2014.</p><a href="index.html">Back</a></body></html>`,
  "contact.html": `<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1></body></html>`,
  "styles.css": "h1{color:#111}",
  "app.js": "document.title=document.title;",
  "notes.md": "internal notes"
};

const result = toSingleFile(files, { entry: "index.html", title: "Aster Studio" });
const html = result.html;

check("the output is a single document", typeof html === "string" && html.includes("<h1>Aster Studio"));
check("it declares the pages it found", result.pages.length === 3, String(result.pages.length));
check("stylesheets are inlined, not linked", html.includes("h1{color:#111}") && !/href="styles\.css"/.test(html));
check("scripts are inlined, not linked", html.includes("document.title=document.title") && !/src="app\.js"/.test(html));
check("every page lives in the file", ["/about", "/contact"].every((route) => html.includes(`data-route="${route}"`)));
check("each section carries its own title", html.includes('data-title="About us"'));
check("navigation is rewritten to hash routes", html.includes('href="#/about"') && !/href="about\.html"/.test(html));
check("the home link becomes the root route", html.includes('href="#/"'));
check("external links are untouched", html.includes('href="https://example.com"'));
check("a router is installed", html.includes("data-shinzora-router"));
check("the router listens for hash changes", html.includes("hashchange"));
check("only one HTML document is produced", (html.match(/<!doctype/gi) || []).length === 1, String((html.match(/<!doctype/gi) || []).length));
check("inline CSS appears exactly once", (html.match(/h1\{color:#111\}/g) || []).length === 1);
check("the markdown file is reported as dropped", result.dropped.includes("notes.md"), JSON.stringify(result.dropped));

console.log("\nthe promise that it opens from disk");
check("there is no remaining local stylesheet link", !/<link[^>]+href="[^"#:]+\.css"/i.test(html));
check("there is no remaining local script src", !/<script[^>]+src="[^"#:]+"/i.test(html));
check("there is no remaining local .html link", !/href="[^"#:]*\.html"/i.test(html));
check("a viewport meta is present", /name="viewport"/i.test(html));
check("the download is named after the project", singleFileDownload("Aster Studio", html).filename === "aster-studio.html");
check("the download holds the whole document", singleFileDownload("Aster Studio", html).content === html);

console.log("\nalready-single-page output is left alone");
const single = toSingleFile({
  "index.html": `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>One</title></head><body><h1>One</h1><a href="#features">Features</a></body></html>`
});
check("a single page needs no router", !single.html.includes("data-shinzora-router"));
check("its own anchor is untouched", single.html.includes('href="#features"'));
check("nothing was dropped", single.dropped.length === 0);
check("it still reports one page", single.pages.length === 1);

console.log("\nedge cases");
const noViewport = toSingleFile({ "index.html": "<html><body><h1>x</h1></body></html>" });
check("a missing viewport is added and said out loud", noViewport.html.includes('name="viewport"') && noViewport.warnings.length > 0);
check("an entry that does not exist falls back to index.html", toSingleFile({ "index.html": "<p>a</p>" }, { entry: "missing.html" }).pages[0].file === "index.html");
check("no HTML at all is reported, not invented", toSingleFile({ "style.css": "a{}" }).html === "");
const dupes = toSingleFile({ "index.html": "<h1>a</h1>", "about.html": "<h1>b</h1>", "pages/about.html": "<h1>c</h1>" });
check("two files that map to one route do not collide", new Set(dupes.pages.map((p) => p.route)).size === dupes.pages.length, JSON.stringify(dupes.pages.map((p) => p.route)));
check("rewriteHrefs leaves mailto alone", rewriteHrefs(`<a href="mailto:a@b.c">m</a>`, []) === `<a href="mailto:a@b.c">m</a>`);
check("rewriteHrefs keeps an in-page anchor when the page is unknown", rewriteHrefs(`<a href="x.html#top">x</a>`, []).includes("x.html#top"));
check("a cross-page fragment opens the page (one hash cannot address both)",
  rewriteHrefs(`<a href="about.html#team">x</a>`, [{ file: "about.html", route: "/about" }]).includes('href="#/about"'));
check("and the drop is counted, not hidden", (() => {
  const stats = { droppedFragments: 0 };
  rewriteHrefs(`<a href="about.html#team">x</a>`, [{ file: "about.html", route: "/about" }], stats);
  return stats.droppedFragments === 1;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
