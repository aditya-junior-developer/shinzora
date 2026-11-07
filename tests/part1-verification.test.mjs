/* ==========================================================================
   Part 1 verification — a real multi-page site, end to end
   --------------------------------------------------------------------------
   The earlier suites test each piece. This one takes a realistic model response
   (four pages, a stylesheet, a script, embedded images, a working form) and
   runs the whole pipeline the customer's browser runs:

     model output → toSingleFile → validator → the download
     → the emitted router executed against a DOM shim, page by page

   It fails if the downloaded file would need a server, a second request or a
   file that is not inside it.
   ========================================================================== */

import { toSingleFile, singleFileDownload, routeFor } from "../public/js/lib/single-file.js";
import { validateSiteDocument, validationSummary } from "../public/js/lib/site-validate.js";
import { computeProgress, GENERATION_TASKS, STAGE_ORDER } from "../public/js/modules/dashboard/builder/stages.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

/* --------------------------------------------------------------- the fixture
   Modelling what a competent model actually returns for "studio site with a
   booking form": index, about, services, contact, plus its own css and js. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const FILES = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aster Studio — wedding photography</title>
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-head"><a class="brand" href="index.html">Aster Studio</a>
  <nav><a href="index.html">Home</a><a href="about.html">About</a><a href="services.html">Services</a><a href="contact.html">Contact</a></nav>
</header>
<main>
  <h1>Wedding photography in Delhi NCR</h1>
  <p>Calm, documentary coverage of the whole day.</p>
  <img src="${PNG}" alt="A couple at golden hour" width="800" height="533">
  <a class="cta" href="contact.html">Check your date</a>
</main>
<footer><p>© 2026 Aster Studio · <a href="mailto:official.shinzora@proton.me">Email</a></p></footer>
<script src="assets/app.js"></script>
</body></html>`,

  "about.html": `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>About Aster Studio</title></head>
<body><header class="site-head"><nav><a href="index.html">Home</a><a href="about.html">About</a></nav></header>
<main><h1>About</h1><p id="team">Two photographers, eleven years.</p><img src="${PNG}" alt="The studio">
<a href="index.html#top">Back to the top</a></main></body></html>`,

  "services.html": `<!doctype html><html lang="en"><head><title>Services</title></head>
<body><h1>Services</h1><ul><li>Full day coverage</li><li>Half day</li></ul>
<a href="contact.html">Enquire</a></body></html>`,

  "contact.html": `<!doctype html><html lang="en"><head><title>Contact</title></head>
<body><h1>Contact</h1>
<form id="enquiry" action="#/contact" method="post">
  <label for="name">Your name</label><input id="name" name="name" required>
  <label for="date">Wedding date</label><input id="date" name="date" type="date">
  <label for="message">Message</label><textarea id="message" name="message"></textarea>
  <button type="submit">Send enquiry</button>
</form>
<p>Or email <a href="mailto:official.shinzora@proton.me">official.shinzora@proton.me</a></p></body></html>`,

  "assets/styles.css": `:root{--ink:#111;--paper:#faf7f2}
body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,sans-serif}
.site-head{display:flex;justify-content:space-between;padding:16px}
nav a{margin-right:14px}
main{padding:24px;max-width:70ch;margin:0 auto}
img{max-width:100%;height:auto}
@media (max-width:640px){.site-head{flex-direction:column;gap:8px}main{padding:16px}}
@media (min-width:1200px){main{max-width:80ch}}`,

  "assets/app.js": `document.querySelectorAll('a[href^="#/"]').forEach(function(link){
  link.addEventListener('click', function(){ document.body.dataset.navigated = '1'; });
});
document.addEventListener('submit', function(event){
  event.preventDefault();
  var status = document.getElementById('status') || document.createElement('p');
  status.id = 'status';
  status.textContent = 'Thanks — we will reply within a day.';
  event.target.appendChild(status);
});`
};

console.log("collapsing a realistic four-page site into one file");
const result = toSingleFile(FILES, { entry: "index.html" });
const html = result.html;

check("four pages were found", result.pages.length === 4, String(result.pages.length));
check("their routes are the real addresses", result.pages.map((p) => p.route).sort().join(",") === "/,/about,/contact,/services",
  result.pages.map((p) => p.route).join(","));
check("the entry page is first", result.pages[0].route === "/");
check("the stylesheet was inlined", html.includes("@media (max-width:640px)") && !/href="assets\/styles\.css"/.test(html));
check("the script was inlined", html.includes("we will reply within a day") && !/src="assets\/app\.js"/.test(html));
check("the stylesheet is inside the file exactly once", (html.match(/--paper:#faf7f2/g) || []).length === 1);
check("every page is a routed section", ["/about", "/services", "/contact"].every((route) => html.includes(`data-route="${route}"`)));
check("the home page is a route too", html.includes('data-route="/"'));
check("the images survive as embedded data", (html.match(/src="data:image\/png;base64,/g) || []).length === 2);
check("the form survived", html.includes('<form id="enquiry"') && html.includes("<label for=\"name\">"));
check("the mailto link is untouched", html.includes('href="mailto:official.shinzora@proton.me"'));

console.log("\nnavigation belongs to the site, not to one page");
const headerPosition = html.indexOf('<header class="site-head"');
const routeWrapper = html.indexOf('<div data-route="/"');
check("the header sits above the routed content", headerPosition > -1 && headerPosition < routeWrapper, `${headerPosition} vs ${routeWrapper}`);
check("the menu is not inside the route container",
  html.indexOf('</header>') < routeWrapper);
check("the other pages do not repeat the menu",
  (html.match(/<nav>/g) || []).length === 1, String((html.match(/<nav>/g) || []).length));
check("nav links point at hash routes",
  html.includes('href="#/about"') && !/href="about\.html"/.test(html));

console.log("\nthe downloaded file needs nothing but itself");
check("no local stylesheet reference", !/<link[^>]+href=["'][^"'#:]+\.css["']/i.test(html));
check("no local script reference", !/<script[^>]+src=["'][^"'#:]+["']/i.test(html));
check("no local page reference", !/href=["'][^"'#:]*\.html["']/i.test(html));
check("no absolute filesystem paths", !/(?:src|href)=["']\/[^"']+\.(?:css|js|png|jpg|svg)["']/i.test(html));
check("no protocol-relative URLs", !/(?:src|href)=["']\/\/[^"']+["']/i.test(html));
check("one document declares a doctype once", (html.match(/<!doctype/gi) || []).length === 1);
check("one body, one html element",
  (html.match(/<body/gi) || []).length === 1 && (html.match(/<html/gi) || []).length === 1);
const download = singleFileDownload("Aster Studio", html);
check("the download is one .html file", /^[a-z0-9-]+\.html$/.test(download.filename), download.filename);
check("and it is the whole document", download.content.length === html.length);

console.log("\nthe validator, on the real thing");
const report = validateSiteDocument(html, { requiredRoutes: ["/", "/about", "/services", "/contact"] });
check("no errors", report.counts.error === 0, JSON.stringify(report.issues.filter((i) => i.level === "error")));
check("no warnings", report.counts.warning === 0, JSON.stringify(report.issues.filter((i) => i.level === "warning")));
check("no missing page", !report.issues.some((i) => i.code === "missing-page"));
check("all four routes were recognised", report.routes.length === 4, JSON.stringify(report.routes));
check("the summary is truthful", validationSummary(report) === "No problems found in this version.", validationSummary(report));

console.log("\nthe same pipeline rejects a broken build");
const broken = toSingleFile(
  {
    ...FILES,
    /* A link to a page that was never generated, and a real image path that a
       one-file site cannot serve. Both live in the page body, so they survive
       the shared-header handling and must be caught. */
    "about.html": FILES["about.html"]
      .replace('<a href="index.html#top">Back to the top</a>', '<a href="pricing.html">Prices</a>')
      .replace(PNG, "img/team.jpg"),
    "assets/app.js": "function broken( {"
  },
  { entry: "index.html" }
);
const brokenReport = validateSiteDocument(broken.html, { requiredRoutes: ["/", "/about", "/services", "/contact"] });
check("the link to a page that was never built is caught",
  brokenReport.issues.some((i) => i.code === "broken-link"), JSON.stringify(brokenReport.issues.map((i) => i.code)));
check("a hash route to nowhere is caught too",
  validateSiteDocument(html.replace('href="#/about"', 'href="#/pricing"')).issues.some((i) => i.code === "broken-route"));
check("the missing image is caught", brokenReport.issues.some((i) => i.code === "missing-asset"));
check("the script that does not parse is caught", brokenReport.issues.some((i) => i.code === "js-syntax"));
check("it does not pass", brokenReport.ok === false);

/* ------------------------------------------------------------ the router run
   The emitted router is the only thing standing between "one file" and "a site
   that can be navigated". Run it for real against a small DOM shim. */
console.log("\nthe emitted router, executed");

function runRouter(html, hashes) {
  const script = html.match(/<script data-shinzora-router>([\s\S]*?)<\/script>/);
  if (!script) return { error: "no router was emitted" };

  const nodes = [];
  for (const match of html.matchAll(/<(?:section|div)\b[^>]*data-route="([^"]+)"[^>]*>/g)) {
    const titleMatch = match[0].match(/data-title="([^"]*)"/);
    nodes.push({
      route: match[1],
      title: titleMatch ? titleMatch[1] : null,
      hiddenFromMarkup: /\shidden/.test(match[0]),
      hidden: /\shidden/.test(match[0]),
      attributes: {},
      getAttribute(name) {
        if (name === "data-route") return this.route;
        if (name === "data-title") return this.title;
        return null;
      },
      hasAttribute(name) {
        return name === "data-route";
      },
      classList: {
        toggle() {},
        add() {},
        remove() {}
      },
      setAttribute() {},
      removeAttribute() {}
    });
  }

  const anchors = [...html.matchAll(/<a\b[^>]*href="(#\/[^"]*)"[^>]*>/g)].map((match) => ({
    href: match[1],
    getAttribute() {
      return this.href;
    },
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    removeAttribute() {}
  }));

  const listeners = {};
  const title = { documentTitle: "" };
  const documentShim = {
    readyState: "complete",
    title: "",
    querySelectorAll(selector) {
      if (selector === "[data-route]") return nodes;
      if (selector.startsWith("a[href^=")) return anchors;
      return [];
    },
    getElementById() {
      return null;
    },
    addEventListener() {}
  };
  const windowShim = {
    scrollY: 0,
    scrollTo() {},
    addEventListener(name, handler) {
      (listeners[name] = listeners[name] || []).push(handler);
    }
  };
  const locationShim = { hash: "" };

  // eslint-disable-next-line no-new-func
  new Function("document", "window", "location", script[1])(documentShim, windowShim, locationShim);

  const results = [];
  for (const hash of hashes) {
    locationShim.hash = hash;
    (listeners.hashchange || []).forEach((handler) => handler());
    const visible = nodes.filter((node) => !node.hidden).map((node) => node.route);
    results.push({ hash, visible, title: documentShim.title });
  }
  void title;
  return { nodes, results };
}

const routed = runRouter(html, ["#/about", "#/services", "#/contact", "#/", ""]);
check("the router ran without throwing", !routed.error, routed.error || "");
check("exactly one page is visible per route",
  routed.results.every((entry) => entry.visible.length === 1), JSON.stringify(routed.results.map((e) => e.visible)));
check("#/about shows the about page", routed.results[0].visible[0] === "/about", JSON.stringify(routed.results[0]));
check("#/services shows services", routed.results[1].visible[0] === "/services");
check("#/contact shows contact", routed.results[2].visible[0] === "/contact");
check("returning to #/ shows home", routed.results[3].visible[0] === "/");
check("an empty hash shows home", routed.results[4].visible[0] === "/");
check("the page title follows the route", routed.results[1].title === "Services", routed.results[1].title);
check("the home title is the site title", routed.results[3].title === "Aster Studio — wedding photography", routed.results[3].title);
check("an unknown route falls back to the first page instead of a blank screen", (() => {
  const single = runRouter(html, ["#/nope"]);
  return single.results[0].visible.length === 1;
})());

console.log("\nprogress cannot claim to be finished before it is");
const weights = computeProgress({});
void weights;

const afterReview = computeProgress({
  stage: "save",
  completedStages: ["brief", "information", "generate", "review"],
  completedTasks: GENERATION_TASKS.map((task) => task.id)
});
check("every task done but nothing confirmed is 93%, not 100%", afterReview.percent === 93, String(afterReview.percent));
check("and it does not report itself as done", afterReview.done === false);

const afterSave = computeProgress({
  stage: "save",
  completedStages: [...STAGE_ORDER]
});
check("only a completed save reaches 100%", afterSave.percent === 100 && afterSave.done === true);

const premature = computeProgress({ stage: "generate", completedTasks: GENERATION_TASKS.map((t) => t.id) });
check("a build with no earlier stages cannot jump to 100%", premature.percent < 80, String(premature.percent));

const noTasks = computeProgress({ stage: "generate", completedStages: ["brief", "information"] });
check("entering the build stage does not credit any of its tasks", noTasks.stagePercent === 0);
check("progress is monotonic as tasks complete", (() => {
  let last = -1;
  for (let i = 0; i <= GENERATION_TASKS.length; i += 1) {
    const value = computeProgress({
      stage: "generate",
      completedStages: ["brief", "information"],
      completedTasks: GENERATION_TASKS.slice(0, i).map((t) => t.id)
    }).percent;
    if (value < last) return false;
    last = value;
  }
  return true;
})());

console.log("\nroute helpers agree with the document");
check("every emitted route matches routeFor(file)",
  result.pages.every((page) => page.route === routeFor(page.file)),
  result.pages.map((p) => `${p.file}→${p.route}`).join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
