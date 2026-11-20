/* ==========================================================================
   Shinzora — My Connections (phase 2)
   The investor's own connection requests, from my_connections(). Accept and
   decline are answered here. A declined request can be sent again.
   ========================================================================== */

import { qs, esc } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { pageHead, skeletonView, emptyState, setupNotice, chip, avatar } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { rpc, fmtTime } from "./investor-kit.js";

let host = null;

export default async function render(root) {
  host = root;
  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "My Connections",
      desc: "Investors you are connected with, and the requests waiting on either side.",
      badge: chip("Network", { tone: "violet", iconName: "users" })
    })}
    <div id="conn-results" aria-live="polite">${skeletonView(3)}</div>
  </div>`;
  host.addEventListener("click", onClick);
  await load();
}

async function load() {
  const box = qs("#conn-results", host);
  if (!box) return;
  try {
    const rows = await rpc("my_connections");
    paint(Array.isArray(rows) ? rows : []);
  } catch (error) {
    box.innerHTML = setupNotice(error, "My Connections");
  }
}

function paint(rows) {
  const box = qs("#conn-results", host);
  if (!box) return;
  const incoming = rows.filter((r) => r.status === "pending" && r.direction === "received");
  const outgoing = rows.filter((r) => r.status === "pending" && r.direction === "sent");
  const declinedSent = rows.filter((r) => r.status === "declined" && r.direction === "sent");
  const connected = rows.filter((r) => r.status === "accepted");

  if (!rows.length) {
    box.innerHTML = emptyState({
      iconName: "users",
      title: "No connections yet",
      desc: "Find investors in the Investor Network and send a connection request."
    });
    return;
  }

  box.innerHTML = `
    ${section("Waiting for you", incoming, (r) => `
      <button class="btn btn-primary btn-sm" type="button" data-respond="${esc(r.connection_id)}" data-accept="1">${icon("check", { size: 13 })} Accept</button>
      <button class="btn btn-ghost btn-sm" type="button" data-respond="${esc(r.connection_id)}" data-accept="0">Decline</button>`,
      "No requests waiting.")}
    ${section("Requests you sent", outgoing, () => `<span class="badge badge-neutral">${icon("clock", { size: 12 })} Waiting for reply</span>`,
      "You have no requests waiting for a reply.")}
    ${declinedSent.length ? section("Declined", declinedSent, (r) => `<button class="btn btn-ghost btn-sm" type="button" data-connect="${esc(r.user_id)}">Send again</button>`) : ""}
    ${section("Connected", connected, () => `<span class="badge badge-ok">${icon("circle-check", { size: 12 })} Connected</span>`,
      "You are not connected with anyone yet.")}`;
}

function section(title, items, actionFor, empty = "") {
  return `<section class="inv-section" aria-label="${esc(title)}">
    <h2 class="inv-section-title">${esc(title)} <span class="field-hint">${items.length}</span></h2>
    ${items.length
      ? `<div class="inv-grid">${items.map((r) => `<article class="card inv-card inv-rise">
            <div class="inv-person">
              ${avatar(r.display_name, "", "", r.avatar_url || null, "cover", r.user_id)}
              <div class="inv-card-title">
                <strong class="truncate">${esc(r.display_name || "Investor")}</strong>
                <span class="field-hint truncate">${esc(r.headline || "Investor")} · ${esc(fmtTime(r.created_at))}</span>
              </div>
            </div>
            <div class="card-actions">${actionFor(r)}</div>
          </article>`).join("")}</div>`
      : `<p class="field-hint">${esc(empty)}</p>`}
  </section>`;
}

async function onClick(event) {
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
    return;
  }
  const again = event.target.closest?.("[data-connect]");
  if (again) {
    again.disabled = true;
    try {
      await rpc("request_connection", { p_user: again.getAttribute("data-connect") });
      toast({ title: "Request sent again" }, { tone: "success" });
      await load();
    } catch (error) {
      again.disabled = false;
      toastError(error);
    }
  }
}
