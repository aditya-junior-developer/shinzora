/* ==========================================================================
   Shinzora — website validation
   --------------------------------------------------------------------------
   The preview stage is only worth anything if it tells the truth. Each check
   here looks at the document that is actually about to be saved:

     broken internal links   a href="#/pricing" that no section answers
     missing assets          <img src="hero.jpg"> with no such file in the file
     javascript errors       an inline script that does not even parse
     layout problems         no viewport, no <h1>, images without alt text,
                             a stylesheet or script that failed to inline
     external requests       recorded, not failed: the page may use a CDN, but
                             the customer should know it needs a connection

   Nothing is inferred from the brief, and nothing reports "valid" on a document
   that was not inspected.
   ========================================================================== */

const JS_TYPES = /^(|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;

/** Collect the routes a document exposes. */
export function collectRoutes(html) {
  const routes = new Set();
  const target = String(html || "");
  for (const match of target.matchAll(/data-route\s*=\s*["']([^"']+)["']/gi)) {
    routes.add(match[1]);
  }
  /* A single-page document with no router still answers "/". */
  if (!routes.size) routes.add("/");
  return routes;
}

/** Collect the ids a document exposes, for #anchor links. */
export function collectIds(html) {
  const ids = new Set();
  for (const match of String(html || "").matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) {
    ids.add(match[1]);
  }
  for (const match of String(html || "").matchAll(/data-route\s*=\s*["']([^"']+)["']/gi)) {
    ids.add(match[1].replace(/^\//, ""));
  }
  return ids;
}

/**
 * Does every local reference in the document resolve to something that ships
 * with it? In a single-file site the only valid local references are hash
 * routes and anchors; a relative file path cannot exist.
 */
function localAssetReferences(html) {
  const found = [];
  const push = (value, where) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    if (/^(data:|https?:|\/\/|#|mailto:|tel:|javascript:|about:)/i.test(raw)) return;
    found.push({ value: raw, where });
  };

  for (const match of html.matchAll(/<img\b[^>]*src\s*=\s*["']([^"']*)["']/gi)) push(match[1], "img");
  for (const match of html.matchAll(/<source\b[^>]*srcset?\s*=\s*["']([^"']*)["']/gi)) push(match[1], "source");
  for (const match of html.matchAll(/<link\b[^>]*href\s*=\s*["']([^"']*)["']/gi)) {
    if (/#/.test(match[1])) continue;
    if (/\.(css|js|woff2?|ttf|ico)$/i.test(match[1])) push(match[1], "link");
  }
  for (const match of html.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']*)["']/gi)) push(match[1], "script");
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(match[1], "css url()");
  return found;
}

/**
 * Parse-only check of every inline script. A syntax error here is exactly the
 * class of bug that makes a generated page look broken in the preview, so the
 * document is not saved until the customer decides to fix it.
 */
function scriptErrors(html) {
  const errors = [];
  let index = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    index += 1;
    const attrs = match[1] || "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [, ""])[1];
    if (!JS_TYPES.test(type.trim())) continue;
    const code = match[2];
    if (!code.trim()) continue;
    try {
      /* Compiling without running is enough to catch the syntax errors that
         would fire before any of the page's own logic ran. */
      // eslint-disable-next-line no-new-func
      new Function(code);
    } catch (error) {
      errors.push({ index, message: String(error && error.message ? error.message : error) });
    }
  }
  return errors;
}

/**
 * Run every check.
 *
 * @param {string} html the exact document that would be saved
 * @param {{ requiredRoutes?: string[] }} [options]
 * @returns {{ issues: Array<{level:'error'|'warning'|'info', code:string, title:string, detail:string}>,
 *             counts: {error:number, warning:number, info:number}, ok: boolean,
 *             routes: string[], externalHosts: string[] }}
 */
export function validateSiteDocument(html, options = {}) {
  const doc = String(html || "");
  const issues = [];
  const add = (level, code, title, detail) => issues.push({ level, code, title, detail });

  if (!doc.trim()) {
    add("error", "empty", "There is no document to check", "The generated file was empty.");
    return { issues, counts: { error: 1, warning: 0, info: 0 }, ok: false, routes: [], externalHosts: [] };
  }

  const routes = collectRoutes(doc);
  const ids = collectIds(doc);

  /* ---------------------------------------------------------- document shell */
  if (!/<!doctype\s+html/i.test(doc)) {
    add("warning", "doctype", "No doctype", "The page does not start with <!doctype html>, so browsers will use quirks mode.");
  }
  if (!/<html[^>]*\slang\s*=/i.test(doc)) {
    add("warning", "lang", "No page language", "Add lang=\"en\" (or the customer's language) to <html> for screen readers and search engines.");
  }
  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(doc)) {
    add("error", "viewport", "Not responsive", "There is no viewport meta tag, so the page will not scale on a phone.");
  }
  if (!/<h1[\s>]/i.test(doc)) {
    add("warning", "h1", "No main heading", "The page has no <h1>, which weakens both accessibility and SEO.");
  }
  if (!doc.includes("<style") && !/<link\b[^>]*stylesheet/i.test(doc)) {
    add("info", "no-css", "No stylesheet", "The page ships without any CSS, so it will render as plain browser defaults.");
  }

  /* --------------------------------------------------------- internal links */
  let internalLinks = 0;
  for (const match of doc.matchAll(/href\s*=\s*["']#([^"']*)["']/gi)) {
    internalLinks += 1;
    const target = match[1].trim();
    if (!target) continue;
    if (target.startsWith("/")) {
      if (!routes.has(target) && !ids.has(target.replace(/^\//, ""))) {
        add("error", "broken-route", "Broken link", `A link points to “#${target}”, but no page answers that address.`);
      }
      continue;
    }
    if (!ids.has(target) && !routes.has(`/${target}`)) {
      add("warning", "broken-anchor", "Link jumps nowhere", `A link points to “#${target}”, but no element on the page has that id.`);
    }
  }

  /* A link to a relative file can never resolve inside one document. The
     rewrite in lib/single-file.js turns real pages into hash routes; anything
     still pointing at "pricing.html" points at a file that does not exist. */
  for (const match of doc.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']*)["']/gi)) {
    const raw = String(match[1]).trim();
    if (!raw) continue;
    if (/^(#|https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(raw)) continue;
    add("error", "broken-link", "Link to a file that is not in this document",
      `A link points to “${raw}”. A one-file site can only link to pages inside it (#/page), an anchor (#id), or an absolute URL.`);
  }

  /* ---------------------------------------------------------- expected pages */
  const required = Array.isArray(options.requiredRoutes) ? options.requiredRoutes : [];
  for (const route of required) {
    const wanted = route.startsWith("/") ? route : `/${route}`;
    if (!routes.has(wanted)) {
      add("warning", "missing-page", "A planned page is missing", `The plan asked for “${wanted}”, and the document has no section for it.`);
    }
  }

  /* ------------------------------------------------------- missing assets */
  for (const reference of localAssetReferences(doc)) {
    add(
      "error",
      "missing-asset",
      "Missing asset in a single-file site",
      `“${reference.value}” is referenced by ${reference.where}, but a one-file site can only load embedded (data:) or remote images.`
    );
  }

  /* -------------------------------------------------------- javascript errors */
  for (const error of scriptErrors(doc)) {
    add("error", "js-syntax", "JavaScript does not parse", `Inline script #${error.index}: ${error.message}`);
  }

  /* ------------------------------------------------------------ accessibility */
  let images = 0;
  for (const match of doc.matchAll(/<img\b[^>]*>/gi)) {
    images += 1;
    if (!/\salt\s*=/i.test(match[0])) {
      add("warning", "img-alt", "Image without alt text", "An <img> has no alt attribute, so screen readers cannot describe it.");
    }
  }
  if (/<form\b/i.test(doc) && !/<label\b/i.test(doc) && !/aria-label\s*=/i.test(doc)) {
    add("warning", "form-labels", "Form without labels", "The page has a form but no <label> or aria-label, so the fields are unnamed for assistive technology.");
  }

  /* ------------------------------------------------------- external requests */
  const hosts = new Set();
  for (const match of doc.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"'/]+)/gi)) {
    try {
      hosts.add(new URL(match[1]).host);
    } catch {
      /* not a URL, ignore */
    }
  }
  for (const match of doc.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/gi)) {
    try {
      hosts.add(new URL(match[1]).host);
    } catch {
      /* ignore */
    }
  }
  if (hosts.size) {
    add(
      "info",
      "external",
      "Loads from the internet",
      `The page requests ${[...hosts].slice(0, 6).join(", ")}. Those parts need a connection, and an offline copy will show them broken.`
    );
  }

  /* ------------------------------------------------------------- interactions */
  const buttons = (doc.match(/<button\b/gi) || []).length;
  const clickHandlers = (doc.match(/addEventListener\s*\(\s*["']click["']/gi) || []).length +
    (doc.match(/\sonclick\s*=/gi) || []).length;
  if (buttons && !clickHandlers && !/type\s*=\s*["']submit["']/i.test(doc)) {
    add("warning", "dead-buttons", "Buttons do nothing", `${buttons} button(s) have no click handler and are not submit buttons.`);
  }
  if (internalLinks === 0 && routes.size > 1) {
    add("warning", "no-nav", "Pages are not linked", "The document has several pages but no navigation links between them.");
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.level] += 1;

  return {
    issues,
    counts,
    ok: counts.error === 0,
    routes: [...routes],
    externalHosts: [...hosts]
  };
}

/** One line a customer can act on, derived from the real counts. */
export function validationSummary(result) {
  const { counts } = result || { counts: { error: 0, warning: 0, info: 0 } };
  if (!counts.error && !counts.warning) return "No problems found in this version.";
  const parts = [];
  if (counts.error) parts.push(`${counts.error} problem${counts.error === 1 ? "" : "s"} to fix`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
  if (counts.info) parts.push(`${counts.info} note${counts.info === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
