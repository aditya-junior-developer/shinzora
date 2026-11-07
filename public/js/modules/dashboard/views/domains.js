/* ==========================================================================
   Shinzora — Domains
   Three honest states:
     1. Shinzora subdomains — real, free, created instantly from a project slug.
     2. Custom domains — the integration layer exists; availability and pricing
        come from a registrar provider and are never invented.
     3. Domain orders — tracked in Postgres with a status the admin moves.
   ========================================================================== */

import { qs, qsa, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, slugify } from "../../../lib/format.js";
import { state } from "../../../lib/store.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { api, runtimeConfig } from "../../../lib/api.js";
import { domains as fetchDomains, domainOrders, projects as fetchProjects } from "../data.js";
import { pageHead, setupNotice, emptyState, statusBadge, skeletonView } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { confirmDialog, formDialog } from "../../../ui/modal.js";

export default async function render(root) {
  root.innerHTML = skeletonView(3);

  const runtime = await runtimeConfig();
  const registrarReady = Boolean(runtime?.domains?.configured);
  /* Two separate capabilities: a registrar can price and register; the public
     registry (RDAP) can only answer "taken or free". The page says which one it
     actually has instead of dead-ending on "not configured". */
  const availabilityMode = runtime?.domains?.availability ?? (registrarReady ? "registrar" : "rdap");
  const availabilityLive = availabilityMode === "registrar" || availabilityMode === "rdap";
  let domainRows = [];
  let orderRows = [];
  let projectRows = [];
  let loadError = null;

  try {
    const [d, o, p] = await Promise.all([fetchDomains(), domainOrders(), fetchProjects({ limit: 100 })]);
    domainRows = d.data;
    orderRows = o.data;
    projectRows = p.data;
  } catch (error) {
    loadError = error;
  }

  root.innerHTML = `
    ${pageHead({
      title: "Domains",
      desc: availabilityLive
        ? registrarReady
          ? "Publish on a free Shinzora subdomain, or bring your own domain. Availability and prices come from your connected registrar — never guessed."
          : "Publish on a free Shinzora subdomain, or bring your own domain. Availability is read from the public registry; prices are confirmed by a person before you pay."
        : "Publish on a free Shinzora subdomain, or bring your own domain. Domain checks are switched off on this deployment.",
      actions: `<button class="btn btn-primary btn-sm" id="suggest-domains" data-tip="AI suggests names from your business profile">
        ${icon("sparkles", { size: 14 })}Suggest with AI</button>`
    })}
    ${loadError ? setupNotice(loadError, "Domain data") : ""}

    <div class="grid-main-side">
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Search a domain</div>
              <div class="card-sub">${
                registrarReady ? "Live availability and prices from your registrar" : "Live availability from the public registry"
              }</div>
            </div>
            <span class="badge ${registrarReady ? "badge-ok" : availabilityLive ? "badge-ok" : "badge-neutral"}">
              <span class="dot"></span>${
                registrarReady
                  ? "Registrar connected"
                  : availabilityLive
                    ? "Live availability · register by request"
                    : "Checks switched off"
              }
            </span>
          </div>
          <div class="card-body stack gap-4">
            ${
              registrarReady
                ? `<div class="alert alert-info" style="font-size:var(--fs-xs)">
                    ${icon("badge-check", { size: 15 })}
                    <span>Availability and prices come from your connected registrar, and can be ordered here.</span>
                  </div>`
                : availabilityLive
                  ? `<div class="alert alert-info" style="font-size:var(--fs-xs)">
                      ${icon("globe", { size: 15 })}
                      <span><strong>Availability is live.</strong> It is read from the public registry (RDAP), so
                      "taken or free" is real. Prices need a registrar account — until one is connected, request a
                      domain and we confirm the price before you pay.</span>
                    </div>`
                  : `<div class="alert alert-warn" style="font-size:var(--fs-xs)">
                      ${icon("plug-zap", { size: 15 })}
                      <span><strong>Domain checks are switched off on this deployment.</strong>
                      Set <span class="mono">DOMAIN_AVAILABILITY</span> to <span class="mono">rdap</span> for free
                      availability, or connect a registrar
                      (<span class="mono">DOMAIN_PROVIDER</span> + <span class="mono">DOMAIN_API_KEY</span>) for
                      prices and ordering.</span>
                    </div>`
            }
            <form class="row gap-2 wrap" id="domain-search-form">
              <div class="input-icon grow" style="min-width:200px">
                ${icon("globe", { size: 16 })}
                <input class="input" id="domain-input" placeholder="yourbusiness.com" autocomplete="off" aria-label="Domain to check" />
              </div>
              <button class="btn btn-primary" type="submit">${icon("search", { size: 15 })}Check</button>
            </form>
            <div id="domain-results"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Shinzora subdomains</div>
              <div class="card-sub">Free on every plan · live immediately</div>
            </div>
          </div>
          <div class="card-body">
            ${
              projectRows.length
                ? projectRows
                    .map(
                      (project) => `<div class="domain-row">
                        <span class="notif-icon">${icon(project.type === "app" ? "blocks" : "panels-top-left", { size: 14 })}</span>
                        <div class="grow">
                          <div class="domain-name">${esc(project.slug || slugify(project.name))}.shinzora.in</div>
                          <div class="domain-meta">${esc(project.name)} · ${esc(project.status)}</div>
                        </div>
                        ${project.status === "published" ? statusBadge("live") : statusBadge("draft")}
                        ${
                          project.status === "published"
                            ? `<a class="btn btn-ghost btn-sm" href="/site/?p=${esc(project.slug)}" target="_blank" rel="noopener">Open</a>`
                            : `<a class="btn btn-secondary btn-sm" href="/app/?view=website-builder&id=${esc(project.id)}">Publish</a>`
                        }
                      </div>`
                    )
                    .join("")
                : emptyState({
                    icon: "globe",
                    title: "No projects to publish yet",
                    desc: "Generate a website or application first — every project gets a free Shinzora subdomain when published.",
                    action: `<a class="btn btn-primary btn-sm" href="/app/?view=website-builder">Create a project</a>`
                  })
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Custom domains</div>
            <span class="card-sub">${domainRows.length} record${domainRows.length === 1 ? "" : "s"}</span>
          </div>
          <div class="card-body">
            ${
              domainRows.length
                ? domainRows
                    .map(
                      (row) => `<div class="domain-row">
                        <span class="notif-icon">${icon("link-2", { size: 14 })}</span>
                        <div class="grow">
                          <div class="domain-name">${esc(row.fqdn || row.name)}</div>
                          <div class="domain-meta">
                            ${esc(row.provider || "registrar")}${row.project_id ? ` · connected to a project` : " · not connected"}
                            ${row.expires_at ? ` · renews ${esc(timeAgo(row.expires_at))}` : ""}
                          </div>
                        </div>
                        ${statusBadge(row.status)}
                        <button class="btn btn-ghost btn-sm" data-dns="${esc(row.id)}">DNS</button>
                      </div>`
                    )
                    .join("")
                : emptyState({
                    icon: "link-2",
                    title: "No custom domains yet",
                    desc: "Connect a domain you already own, or order one through Shinzora when a registrar provider is configured."
                  })
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Domain orders</div></div>
          <div class="card-body">
            ${
              orderRows.length
                ? `<div class="table-wrap"><table class="table">
                    <thead><tr><th>Domain</th><th>Price</th><th>Status</th><th>Created</th><th></th></tr></thead>
                    <tbody>${orderRows
                      .map(
                        (order) => `<tr>
                          <td class="cell-strong">${esc(order.domain_name)}</td>
                          <td>${esc(money(order.price, order.currency || "INR"))}</td>
                          <td>${statusBadge(order.status)}</td>
                          <td class="dim">${esc(timeAgo(order.created_at))}</td>
                          <td class="cell-actions">
                            ${
                              order.status === "pending_payment"
                                ? `<a class="btn btn-secondary btn-sm" href="/app/?view=billing&order=${esc(order.id)}">Pay</a>`
                                : `<span class="badge badge-neutral">${esc(order.status)}</span>`
                            }
                          </td>
                        </tr>`
                      )
                      .join("")}</tbody>
                  </table></div>`
                : emptyState({ icon: "receipt", title: "No domain orders", desc: "Orders appear here once a registrar provider is connected and you purchase a domain." })
            }
          </div>
        </div>
      </div>

      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><div class="card-title">AI suggestions</div></div>
          <div class="card-body" id="suggestions">
            <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
              The assistant proposes names from your business name, category and audience. Each suggestion still has to be
              checked against a registrar before it means anything.
            </p>
            <button class="btn btn-secondary btn-sm btn-block" style="margin-top:12px" id="suggest-inline">
              ${icon("sparkles", { size: 14 })}Generate name ideas
            </button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Connecting a domain you own</div></div>
          <div class="card-body">
            <ol class="pay-steps">
              <li class="pay-step"><span>Add the domain here and choose the project it should serve.</span></li>
              <li class="pay-step"><span>Create the DNS records we show you at your registrar (CNAME to <span class="mono">sites.shinzora.in</span>, or the A records provided).</span></li>
              <li class="pay-step"><span>Verification is checked against DNS — the status stays "pending" until the records resolve.</span></li>
              <li class="pay-step"><span>Once verified, HTTPS is issued automatically and the domain serves your published version.</span></li>
            </ol>
            <div class="alert alert-info" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
              ${icon("info", { size: 14 })}
              <span>DNS changes can take up to 24 hours to propagate. Shinzora never reports a domain as connected before DNS confirms it.</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  /* ------------------------------------------------------------- behaviour */
  const searchForm = qs("#domain-search-form");
  const results = qs("#domain-results");

  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = qs("#domain-input").value.trim().toLowerCase();
    if (value.length < 4) return toast({ title: "Enter a domain to check" }, { tone: "warning" });
    results.innerHTML = `<div class="row gap-2" style="padding:var(--s-3) 0"><span class="spinner"></span><span class="dim" style="font-size:var(--fs-xs)">Querying the registrar…</span></div>`;
    try {
      const response = await api.domains.search({ query: value });
      const rows = response?.results || [];
      if (!rows.length) {
        results.innerHTML = `<div class="alert alert-warn" style="font-size:var(--fs-xs)">${icon("plug-zap", { size: 15 })}
          <span><strong>No answer from the registry.</strong> ${esc(response?.message || "Try again in a moment.")}</span></div>`;
        return;
      }
      const ordering = Boolean(response?.registration_available);
      const note = ordering
        ? ""
        : `<div class="dim" style="font-size:var(--fs-2xs);margin-top:8px">Availability from ${esc(
            response?.source || "the public registry"
          )}. The price is confirmed by a person before any payment.</div>`;
      results.innerHTML =
        rows
          .map((row) => {
            const unknown = row.available === null || row.available === undefined;
            const state = unknown
              ? `<span class="badge badge-neutral">Could not check</span>`
              : row.available
                ? `<span class="badge badge-ok">Available</span>`
                : `<span class="badge badge-danger">Taken</span>`;
            const meta = unknown
              ? esc(row.detail || "The registry did not answer for this name.")
              : row.available
                ? `Available to register${row.renewal ? ` · renews at ${esc(money(row.renewal, row.currency))}` : ""}`
                : "Already registered — try a variation or another ending";
            const action = !row.available
              ? state
              : ordering
                ? `<div class="domain-price">${row.price_known === false ? "Price on request" : esc(money(row.price, row.currency))}
                     <button class="btn btn-primary btn-sm" data-buy="${esc(row.domain)}" data-price="${esc(row.price || 0)}">Buy</button></div>`
                : `<div class="domain-price">Price on request
                     <button class="btn btn-secondary btn-sm" data-request="${esc(row.domain)}">Request registration</button></div>`;
            return `<div class="domain-row">
              <div class="grow">
                <div class="domain-name">${esc(row.domain)}</div>
                <div class="domain-meta">${meta}</div>
              </div>
              ${action}
            </div>`;
          })
          .join("") + note;
    } catch (error) {
      const normalized = normalizeError(error);
      results.innerHTML = `<div class="alert alert-warn" style="font-size:var(--fs-xs)">${icon("triangle-alert", { size: 15 })}
        <span>${esc(normalized.message)} ${normalized.hint ? esc(normalized.hint) : ""}</span></div>`;
    }
  });

  async function suggest() {
    const host = qs("#suggestions");
    host.innerHTML = `<div class="row gap-2"><span class="spinner"></span><span class="dim" style="font-size:var(--fs-xs)">Thinking…</span></div>`;
    try {
      const response = await api.ai.domainIdeas({
        business: state.business || null,
        count: 10
      });
      const ideas = response?.ideas || [];
      host.innerHTML = ideas.length
        ? `<div class="stack gap-2">${ideas
            .map(
              (idea) => `<div class="domain-row">
                <div class="grow">
                  <div class="domain-name">${esc(idea.domain)}</div>
                  <div class="domain-meta">${esc(idea.reason || "")}</div>
                </div>
                <button class="btn btn-ghost btn-sm" data-check="${esc(idea.domain)}">Check</button>
              </div>`
            )
            .join("")}</div>
            <div class="dim" style="font-size:var(--fs-2xs);margin-top:10px">Ideas only — availability requires the registrar check.</div>`
        : `<p class="muted" style="font-size:var(--fs-xs)">No suggestions returned. Try again with a business profile filled in.</p>`;
    } catch (error) {
      const normalized = normalizeError(error);
      host.innerHTML = `<div class="alert alert-warn" style="font-size:var(--fs-xs)">${icon("triangle-alert", { size: 15 })}<span>${esc(
        normalized.message
      )} ${normalized.code === "functions_unavailable" ? esc(normalized.hint) : ""}</span></div>`;
    }
  }

  on(qs("#suggest-domains"), "click", suggest);
  on(qs("#suggest-inline"), "click", suggest);

  on(qs("#suggestions"), "click", (event) => {
    const check = event.target.closest("[data-check]");
    if (!check) return;
    qs("#domain-input").value = check.getAttribute("data-check");
    searchForm.requestSubmit();
  });

  /* No registrar connected: the honest route is a request, not a fake checkout.
     The record lands in service_requests, which the admin console already
     handles, and no money moves until a price is confirmed. */
  delegate(root, "click", "[data-request]", async (_event, node) => {
    const domain = node.getAttribute("data-request");
    const values = await formDialog({
      title: `Register ${domain}`,
      desc: "No registrar is connected to this deployment yet, so the price is confirmed by a person before any payment. Nothing is charged now.",
      fields: [
        { name: "detail", label: "Anything we should know?", type: "textarea", rows: 3, placeholder: "e.g. register for 2 years, .com only" },
        { name: "contact", label: "Best contact", value: state.profile?.phone || state.user?.email || "" }
      ],
      submitLabel: "Send request"
    });
    if (!values) return;
    try {
      const { error } = await sb.from("service_requests").insert({
        owner_id: state.user.id,
        service_type: "domain_registration",
        title: `Domain registration — ${domain}`,
        details: `Domain: ${domain}\n\n${values.detail}\n\nContact: ${values.contact}`,
        status: "requested"
      });
      if (error) throw normalizeError(error);
      toast({ title: "Request sent", message: `We will confirm the price for ${domain} before any payment.` }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  delegate(root, "click", "[data-buy]", async (_event, node) => {
    const domain = node.getAttribute("data-buy");
    const price = Number(node.getAttribute("data-price") || 0);
    const ok = await confirmDialog({
      title: `Order ${domain}?`,
      desc: "Shinzora creates a domain order and a payment request. Registration only starts after the payment is verified.",
      confirmLabel: "Create order"
    });
    if (!ok) return;
    try {
      const response = await api.domains.createOrder({ domain, price, currency: "INR" });
      toast({ title: "Order created", message: response?.payment_url ? "Continue to payment." : "Awaiting payment verification." }, { tone: "success" });
      location.href = "/app/?view=billing";
    } catch (error) {
      toastError(normalizeError(error));
    }
  });

  delegate(root, "click", "[data-dns]", async (_event, node) => {
    const id = node.getAttribute("data-dns");
    try {
      const response = await api.domains.dns({ domainId: id });
      const records = response?.records || [];
      toast({
        title: records.length ? "DNS records loaded" : "No DNS records yet",
        message: records.length ? records.map((r) => `${r.type} ${r.name} → ${r.value}`).join(" · ") : "Add the domain to a provider connection first.",
        duration: 9000
      });
    } catch (error) {
      toastError(normalizeError(error));
    }
  });
}
