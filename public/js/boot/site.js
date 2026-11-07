/* ==========================================================================
   Shinzora — published site renderer  (/site/?p=slug)
   --------------------------------------------------------------------------
   Loads the published version through the `site` Edge Function and renders it
   in a sandboxed iframe (no allow-same-origin), so generated code can never
   touch the viewer's session, cookies or the parent document.

   The slug can also arrive from a subdomain: acme.shinzora.in → "acme".
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import { buildPreviewDocument } from "../modules/dashboard/builder-core.js";
import { env } from "../config/env.js";

const root = document.getElementById("site-root");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
  });
}

function resolveSlug() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("p") || params.get("slug");
  if (fromQuery) return fromQuery.trim().toLowerCase();

  const host = location.hostname.toLowerCase();

  // Subdomain hosting only applies to real DNS names. On localhost or a bare IP
  // the "root domain" is meaningless and used to produce a bogus slug (an IP
  // like 127.0.0.1 was read as the subdomain "127.0"), so bail out first.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (isIp || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "";

  const rootDomain = (env.siteUrl || "").replace(/^https?:\/\//, "").split(":")[0].split(".").slice(-2).join(".");
  const suffix = `.shinzora.in`;
  if (host.endsWith(suffix) && host !== `shinzora.in` && host !== `www.shinzora.in`) {
    return host.slice(0, -suffix.length);
  }
  if (rootDomain && rootDomain.includes(".") && !/^\d/.test(rootDomain) && host.endsWith(rootDomain)) {
    const prefix = host.slice(0, -(rootDomain.length + 1));
    if (prefix && prefix !== "www" && prefix !== "app" && prefix !== "admin") return prefix;
  }
  return "";
}

function state({ title, desc, action = "" }) {
  document.title = title;
  root.innerHTML = `<div class="site-state"><div class="site-state-card">
    <h1>${escapeHtml(title)}</h1>
    <p>${desc}</p>
    ${action}
    <p style="margin-top:22px;font-size:.74rem;opacity:.55">
      <a href="/" style="color:#c4b5fd">Shinzora</a> — your business, built and managed with intelligence.
    </p>
  </div></div>`;
}

async function load(slug) {
  const response = await fetch(`${env.functionsUrl}/site`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.supabaseKey,
      Authorization: `Bearer ${env.supabaseKey}`
    },
    body: JSON.stringify({ slug })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.code = payload?.code || `site_${response.status}`;
    throw error;
  }
  return payload;
}

function mount(payload) {
  const { project, files, entry } = payload;
  // The server sends the owner's plan; the renderer only obeys it.
  const branding = payload.branding || { required: true, plan: "free" };
  const document_ = buildPreviewDocument(files, entry || "index.html", {
    branding: branding.required !== false,
    /* Published pages are not sandboxed: a form the customer asked for must be
       able to submit. */
    allowForms: true
  });

  const seo = payload.seo || {};
  document.title = seo.title || project?.name || "Published site";
  const metaDescription = document.createElement("meta");
  metaDescription.name = "description";
  metaDescription.content = seo.description || project?.description || "";
  document.head.append(metaDescription);

  root.innerHTML = `
    <div class="site-bar" role="contentinfo">
      <span>${escapeHtml(project?.name || "Published site")}</span>
      <span style="opacity:.45">v${escapeHtml(String(payload.version ?? 1))}</span>
      <span class="spacer">
        ${
          branding.required !== false
            ? `<a href="/">Built with Shinzora</a><a href="/auth/signup/">Create your own</a>`
            : `<a href="/" rel="noopener">View on Shinzora</a>`
        }
      </span>
    </div>
    <iframe
      class="site-frame"
      title="${escapeHtml(project?.name || "Published site")}"
      sandbox="allow-scripts allow-forms allow-popups"
      referrerpolicy="no-referrer"
      srcdoc="${escapeHtml(document_)}"></iframe>`;

  hydrateIcons();
}

async function boot() {
  hydrateIcons();
  const slug = resolveSlug();

  if (!slug) {
    state({
      title: "Which site?",
      desc: "This address is missing a project. Enter the published address of the site you want to view.",
      action: `<form id="slug-form"><input id="slug-input" placeholder="your-project" aria-label="Project address" /><button type="submit">Open</button></form>`
    });
    document.getElementById("slug-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = document.getElementById("slug-input").value.trim().toLowerCase();
      if (value) location.href = `/site/?p=${encodeURIComponent(value)}`;
    });
    return;
  }

  state({ title: "Loading published site", desc: `Fetching <span class="mono">${escapeHtml(slug)}</span>.` });

  try {
    const payload = await load(slug);
    mount(payload);
  } catch (error) {
    if (error.code === "not_found") {
      state({
        title: "This site is not published",
        desc: `No published project exists at <span class="mono">${escapeHtml(slug)}</span>. The owner may have unpublished it, or the address is mistyped.`,
        action: `<a href="/" style="color:#c4b5fd;font-size:.84rem">Go to Shinzora</a>`
      });
      return;
    }
    state({
      title: "The site could not be loaded",
      desc: `${escapeHtml(error.message || "The publishing service is unreachable.")}<br /><br />If you are the owner, check the <a href="/system-check/" style="color:#c4b5fd">system check</a> page.`
    });
  }
}

boot();
