/* ==========================================================================
   Shinzora — one file, many pages
   --------------------------------------------------------------------------
   The product promise: a generated website is exactly one `index.html`. All of
   its pages live inside that file and are reached by hash routing, so the
   customer can double-click the downloaded file and use the whole site with no
   server, no build step and no missing stylesheet.

   The AI is not always that disciplined. It returns `index.html`, `about.html`,
   `styles.css`, `script.js` — a perfectly reasonable shape for a static host,
   and a broken one for a single downloaded file. So the builder converts the
   model's output into the promised shape instead of trusting it:

     • local stylesheets and scripts are inlined, in order, once each
     • every extra HTML page becomes a <section data-route="/about"> inside the
       entry document, with its own title
     • every internal link is rewritten to the hash route that now owns that
       page
     • a small router (no dependency, no network) shows the right section and
       marks the matching nav link as current

   Everything here is a pure string transform: no DOM, no async, no network, so
   it can be tested directly in Node.
   ========================================================================== */

const HTML_EXT = /\.html?$/i;
const CSS_EXT = /\.css$/i;
const JS_EXT = /\.js$/i;

/** Normalise a path the way a browser would when the site is opened from disk. */
export function normalizePath(raw) {
  let name = String(raw || "").trim();
  if (!name) return "";
  name = name.replace(/^\.\//, "").replace(/^\//, "");
  name = name.split("#")[0].split("?")[0];
  return name.replace(/\/{2,}/g, "/");
}

/** "/about.html" → "/about"; "index.html" → "/" */
export function routeFor(fileName) {
  const name = normalizePath(fileName);
  if (!name) return "/";
  const base = name.replace(HTML_EXT, "");
  if (base === "index" || base === "" || base.endsWith("/index")) {
    const dir = base.replace(/\/?index$/, "");
    return dir ? `/${dir}` : "/";
  }
  return `/${base}`.replace(/\/{2,}/g, "/");
}

/** Escaped text for insertion into an HTML document. */
function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractBody(html) {
  const match = String(html).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (match) return match[1];
  /* No body tag at all: strip anything that clearly belongs to the head. */
  return String(html)
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<\/?html[^>]*>/gi, "");
}

function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : "";
}

/**
 * Inline every local <link rel="stylesheet"> and <script src>.
 * Remote references are left untouched — they are the customer's choice and
 * cannot be inlined without fetching them.
 */
function inlineLocalReferences(html, files) {
  let doc = html;

  doc = doc.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) return tag;
    const key = normalizePath(href[1]);
    const css = files[key];
    if (css == null || !CSS_EXT.test(key)) return tag;
    return `<style data-from="${escapeText(key)}">\n${css}\n</style>`;
  });

  doc = doc.replace(/<script\b([^>]*)><\/script>/gi, (tag, attrs) => {
    const src = String(attrs).match(/src\s*=\s*["']([^"']+)["']/i);
    if (!src) return tag;
    const key = normalizePath(src[1]);
    const js = files[key];
    if (js == null || !JS_EXT.test(key)) return tag;
    return `<script${String(attrs).replace(/\ssrc\s*=\s*["'][^"']+["']/i, "")} data-from="${escapeText(key)}">\n${js}\n</script>`;
  });

  return doc;
}

/** Rewrite every internal HTML link to the hash route that now owns that page. */
export function rewriteHrefs(html, pages, stats = { droppedFragments: 0 }) {
  const known = new Set(pages.map((page) => page.file));
  const routes = new Map(pages.map((page) => [page.file, page.route]));

  return String(html).replace(/href\s*=\s*["']([^"']*)["']/gi, (whole, href) => {
    const raw = String(href).trim();
    if (!raw) return whole;
    /* Leave anchors, external URLs, mail/phone and scripts alone. */
    if (/^(#|https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(raw)) return whole;
    const [pathPart, rest] = raw.split("#");
    const key = normalizePath(pathPart);
    if (!key) return whole;
    const target = routes.get(key);
    if (!target) return whole;
    /* A hash can address a page or a section on that page, not both: "#/about"
       already spends the hash. The page is kept and the section is dropped, and
       the caller is told how often that happened instead of pretending the jump
       still works. */
    if (rest) stats.droppedFragments += 1;
    return `href="#${target}"`;
  });
}

const ROUTER = `
(function () {
  var routes = Array.prototype.slice.call(document.querySelectorAll('[data-route]'));
  if (!routes.length) return;
  var originalTitle = document.title;
  function current() {
    var hash = (location.hash || '').replace(/^#/, '');
    if (!hash || hash === '/') return '/';
    return hash.charAt(0) === '/' ? hash : '/' + hash;
  }
  function paint() {
    var want = current();
    var match = routes.filter(function (node) { return node.getAttribute('data-route') === want; })[0];
    if (!match && want !== '/') {
      var byId = document.getElementById(want.replace(/^\\//, ''));
      if (byId && byId.hasAttribute('data-route')) match = byId;
    }
    if (!match) match = routes[0];
    routes.forEach(function (node) { node.hidden = node !== match; });
    var title = match.getAttribute('data-title');
    document.title = title || originalTitle;
    Array.prototype.forEach.call(document.querySelectorAll('a[href^="#/"]'), function (link) {
      var target = link.getAttribute('href').replace(/^#/, '');
      var active = target === match.getAttribute('data-route');
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (window.scrollY) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', paint);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
`;

/**
 * Collapse everything the model returned into one self-contained document.
 *
 * @param {Record<string,string>} files  the model's files
 * @param {{ entry?: string, title?: string }} [options]
 * @returns {{ html: string, pages: Array<{file:string, route:string, title:string}>,
 *             inlined: string[], dropped: string[], warnings: string[] }}
 */
export function toSingleFile(files, options = {}) {
  const source = {};
  for (const [rawName, content] of Object.entries(files || {})) {
    const name = normalizePath(rawName);
    if (!name || typeof content !== "string") continue;
    source[name] = content;
  }

  const htmlNames = Object.keys(source).filter((name) => HTML_EXT.test(name));
  const warnings = [];

  if (!htmlNames.length) {
    return { html: "", pages: [], inlined: [], dropped: [], warnings: ["The response contained no HTML document."] };
  }

  const requestedEntry = normalizePath(options.entry || "");
  const entry =
    (requestedEntry && source[requestedEntry] != null ? requestedEntry : null) ||
    (source["index.html"] != null ? "index.html" : null) ||
    htmlNames.sort((a, b) => a.length - b.length)[0];

  /* The entry page first, then the rest in a stable order. */
  const ordered = [entry, ...htmlNames.filter((name) => name !== entry).sort()];
  const seenRoutes = new Set();

  const pages = [];
  for (const file of ordered) {
    let route = routeFor(file);
    if (seenRoutes.has(route)) route = `${route}-${pages.length + 1}`;
    seenRoutes.add(route);
    pages.push({ file, route, title: extractTitle(source[file]) });
  }

  const inlined = [];
  for (const page of pages) {
    page.html = inlineLocalReferences(source[page.file], source);
    for (const key of Object.keys(source)) {
      if ((CSS_EXT.test(key) || JS_EXT.test(key)) && page.html.includes(`data-from="${key}"`)) {
        if (!inlined.includes(key)) inlined.push(key);
      }
    }
  }

  const entryPage = pages[0];
  let doc = entryPage.html;

  /* Guarantee a viewport: a site that is not responsive on a phone is not the
     site that was promised, and the validation stage says so either way. */
  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(doc)) {
    const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
    doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head([^>]*)>/i, `<head$1>\n${viewport}`) : `${viewport}\n${doc}`;
    warnings.push("The generated page had no viewport meta tag; one was added so it scales on phones.");
  }

  /* A site's header and navigation belong to the site, not to one of its pages.
     If they were left inside the entry page's route container, every other page
     would lose the navigation the moment the router hid the entry page — which
     is exactly what a visitor would call "the menu disappeared". So they are
     lifted out and shown above the routed content, and the other pages do not
     repeat them. */
  let chrome = "";
  if (pages.length > 1) {
    const blocks = [];
    doc = doc.replace(/<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
      blocks.push(match);
      return "";
    });
    if (blocks.length) chrome = `${blocks.join("\n")}\n`;
  }

  /* Extra pages become routed sections inside the entry document. */
  const sections = pages
    .slice(1)
    .map((page) => {
      let body = extractBody(page.html);
      /* With shared chrome above, a page's own copy of the menu would appear
         twice; without it, each page keeps its own navigation. */
      if (chrome) body = body.replace(/<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
      const title = page.title || page.route.replace(/^\//, "").replace(/[-_]/g, " ");
      return `<section data-route="${escapeText(page.route)}" data-page="${escapeText(page.file)}" data-title="${escapeText(title)}" hidden>\n${body.trim()}\n</section>`;
    })
    .join("\n");

  /* The entry page is itself a route, so the router has something to show. */
  if (pages.length > 1) {
    const entryTitle = entryPage.title || options.title || "";
    const wrapperOpen = `${chrome}<div data-route="${escapeText(entryPage.route)}" data-page="${escapeText(entryPage.file)}"${
      entryTitle ? ` data-title="${escapeText(entryTitle)}"` : ""
    }>`;
    if (/<body[^>]*>/i.test(doc)) {
      doc = doc.replace(/<body([^>]*)>/i, `<body$1>\n${wrapperOpen}`);
      doc = doc.replace(/<\/body>/i, `</div>\n${sections}\n</body>`);
    } else {
      doc = `${wrapperOpen}${doc}</div>\n${sections}`;
    }
  } else if (sections) {
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${sections}\n</body>`) : `${doc}\n${sections}`;
  }

  const hrefStats = { droppedFragments: 0 };
  doc = rewriteHrefs(doc, pages, hrefStats);
  if (hrefStats.droppedFragments) {
    warnings.push(
      `${hrefStats.droppedFragments} link(s) pointed at a section on another page; they now open that page at the top.`
    );
  }

  if (pages.length > 1) {
    doc = /<\/body>/i.test(doc)
      ? doc.replace(/<\/body>/i, `<script data-shinzora-router>${ROUTER}</script>\n</body>`)
      : `${doc}\n<script data-shinzora-router>${ROUTER}</script>`;
  }

  const dropped = Object.keys(source).filter(
    (name) => !HTML_EXT.test(name) && !CSS_EXT.test(name) && !JS_EXT.test(name)
  );
  if (dropped.length) {
    warnings.push(
      `${dropped.length} file(s) that cannot live inside a single page were left out: ${dropped.join(", ")}.`
    );
  }

  return { html: doc, pages, inlined, dropped, warnings };
}

/**
 * The download the customer gets: one file, named after the project.
 * Returns the filename and the content — the caller decides how to save it.
 */
export function singleFileDownload(projectName, html) {
  const slug = String(projectName || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return { filename: `${slug || "site"}.html`, content: html };
}
