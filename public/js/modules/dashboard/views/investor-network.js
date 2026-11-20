/* ==========================================================================
   Shinzora — Investor Network (phase 2)
   Shows the investor profiles the database allows this investor to see:
   public profiles, connections-only profiles of accepted connections, and
   their own. Private profiles never appear. Connection state comes from the
   database, and the actions are the database's own functions.
   ========================================================================== */

import { qs, esc, on, debounce } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { pageHead, skeletonView, emptyState, setupNotice, chip, avatar } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { openModal } from "../../../ui/modal.js";
import { rpc, INDUSTRIES } from "./investor-kit.js";

let host = null;

export default async function render(root) {
  host = root;
  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Investor Network",
      desc: "Investor profiles you are allowed to see. Connect with investors who share your interests.",
      badge: chip("Investors", { tone: "violet", iconName: "users-round" })
    })}
    <form class="card inv-filters inv-rise" id="net-filters" role="search" aria-label="Find investors">
      <label class="inv-field inv-field-wide">
        <span class="field-label">Search</span>
        <input class="input" name="q" type="search" placeholder="Name or headline" autocomplete="off" />
      </label>
      <label class="inv-field">
        <span class="field-label">Preferred industry</span>
        <select class="input" name="industry">
          <option value="">All industries</option>
          ${INDUSTRIES.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}
        </select>
      </label>
    </form>
    <div id="net-results" aria-live="polite">${skeletonView(3)}</div>
  </div>`;

  const form = qs("#net-filters", host);
  on(form, "input", debounce(() => load(), 280));
  on(form, "change", (event) => {
    if (event.target.tagName === "SELECT") load();
  });
  host.addEventListener("click", onClick);
  await load();
}

async function load() {
  const box = qs("#net-results", host);
  if (!box) return;
  const f = new FormData(qs("#net-filters", host));
  if (!box.childElementCount) box.innerHTML = skeletonView(3);
  box.setAttribute("aria-busy", "true");
  try {
    const [people, mine] = await Promise.all([
      rpc("investor_network_directory", {
        p_query: String(f.get("q") || "").trim() || null,
        p_industry: String(f.get("industry") || "") || null
      }),
      rpc("my_connections")
    ]);
    paint(Array.isArray(people) ? people : [], Array.isArray(mine) ? mine : []);
  } catch (error) {
    box.innerHTML = setupNotice(error, "Investor Network");
  }
}

/* A card's buttons follow the state the database reports. A pending request is
   answered from My Connections, so its id is looked up there. */
let lastSignature = "";

function paint(people, mine) {
  const box = qs("#net-results", host);
  if (!box) return;
  box.removeAttribute("aria-busy");
  const byUser = new Map(mine.map((c) => [c.user_id, c]));
  const signature = JSON.stringify([people.map((p) => [p.user_id, p.connection_status]), mine.map((c) => [c.connection_id, c.status])]);
  if (signature === lastSignature && box.childElementCount) return;
  lastSignature = signature;

  box.innerHTML = people.length
    ? `<div class="inv-grid">${people.map((p) => card(p, byUser.get(p.user_id))).join("")}</div>`
    : emptyState({
        iconName: "users-round",
        title: "No investor profiles to show",
        desc: "Investors appear here once they make their profile public, or once they connect with you."
      });
}

function card(p, link) {
  const status = p.connection_status;
  const visibilityNote =
    p.visibility === "connections" ? chip("Connections only", { tone: "neutral", iconName: "lock" }) : "";
  let action = "";
  if (status === "self") action = chip("This is you", { tone: "neutral" });
  else if (status === "connected") action = `<span class="badge badge-ok">${icon("circle-check", { size: 12 })} Connected</span>`;
  else if (status === "request_sent") action = `<span class="badge badge-neutral">${icon("clock", { size: 12 })} Request sent</span>`;
  else if (status === "request_received" && link)
    action = `<button class="btn btn-primary btn-sm" type="button" data-respond="${esc(link.connection_id)}" data-accept="1">Accept</button>
              <button class="btn btn-ghost btn-sm" type="button" data-respond="${esc(link.connection_id)}" data-accept="0">Decline</button>`;
  else if (status === "request_received") action = chip("Wants to connect", { tone: "info" });
  else action = `<button class="btn btn-primary btn-sm" type="button" data-connect="${esc(p.user_id)}">${icon("users", { size: 13 })} Connect</button>`;

  return `<article class="card inv-card inv-rise" data-user="${esc(p.user_id)}">
    <div class="inv-person">
      ${avatar(p.display_name, "", "", p.avatar_url || null, "cover", p.user_id)}
      <div class="inv-card-title">
        <strong class="truncate">${esc(p.display_name || "Investor")}</strong>
        <span class="field-hint truncate">${esc(p.headline || "Investor")}</span>
      </div>
      ${visibilityNote}
    </div>
    ${(p.preferred_industries || []).length ? `<div class="inv-chips">${p.preferred_industries.slice(0, 4).map((i) => chip(i, { tone: "violet" })).join("")}</div>` : ""}
    ${(p.interests || []).length ? `<div class="inv-chips">${p.interests.slice(0, 4).map((i) => chip(i)).join("")}</div>` : ""}
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-profile="${esc(p.user_id)}">${icon("eye", { size: 13 })} View profile</button>
      ${action}
    </div>
  </article>`;
}

async function onClick(event) {
  const profile = event.target.closest?.("[data-profile]");
  if (profile) return openProfile(profile.getAttribute("data-profile"));

  const connect = event.target.closest?.("[data-connect]");
  if (connect) {
    connect.disabled = true;
    try {
      await rpc("request_connection", { p_user: connect.getAttribute("data-connect") });
      toast({ title: "Request sent", message: "They will see your request in their Connections." }, { tone: "success" });
      await load();
    } catch (error) {
      connect.disabled = false;
      toastError(error);
    }
    return;
  }

  const respond = event.target.closest?.("[data-respond]");
  if (respond) {
    respond.disabled = true;
    try {
      const accept = respond.getAttribute("data-accept") === "1";
      await rpc("respond_connection", { p_connection: respond.getAttribute("data-respond"), p_accept: accept });
      toast({ title: accept ? "Connected" : "Request declined" }, { tone: "success" });
      await load();
    } catch (error) {
      respond.disabled = false;
      toastError(error);
    }
  }
}

async function openProfile(userId) {
  try {
    const rows = await rpc("investor_profile_detail", { p_user: userId });
    const p = Array.isArray(rows) ? rows[0] : rows;
    if (!p) return;
    const list = (items) => (items || []).length ? items.map((i) => chip(i)).join(" ") : `<span class="field-hint">None listed</span>`;
    openModal({
      title: p.display_name || "Investor",
      desc: p.headline || "",
      size: "lg",
      body: `<div class="inv-detail">
        <p class="inv-detail-desc">${esc(p.bio || "No bio yet.")}</p>
        <div class="inv-detail-row"><span class="field-hint">Preferred industries</span><div class="inv-chips">${list(p.preferred_industries)}</div></div>
        <div class="inv-detail-row"><span class="field-hint">Interests</span><div class="inv-chips">${list(p.interests)}</div></div>
        <div class="inv-detail-row"><span class="field-hint">Portfolio</span><p>${esc(p.portfolio || "Not shared.")}</p></div>
      </div>`,
      footer: `<button class="btn btn-ghost" data-modal-close>Close</button>`
    });
  } catch (error) {
    toastError(error);
  }
}

