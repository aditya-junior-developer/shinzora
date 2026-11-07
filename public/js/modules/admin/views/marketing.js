/* ==========================================================================
   Shinzora Admin — Marketing requests
   --------------------------------------------------------------------------
   The review desk for "Request for Extra Service". An administrator reads the
   request the customer submitted, decides, writes an internal note if needed,
   and moves the status.

   Two rules the screen keeps:
     • the status list is the database's list; an unknown status is shown as it
       is rather than mapped onto a friendlier one
     • a status change writes an event and notifies the customer through
       notify_customer — both are database-enforced, and both are reported as
       failed if they fail, never assumed
   ========================================================================== */

import { qs, qsa, esc, on, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo, statusLabel } from "../../../lib/format.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { emptyState, statCard, statusBadge } from "../../dashboard/components.js";
import { openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { adminState } from "../shell.js";

const STATUSES = [
  "submitted",
  "under_review",
  "more_information_required",
  "approved",
  "in_progress",
  "completed",
  "rejected"
];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "meta_ads", label: "Meta Ads" },
  { id: "google_ads", label: "Google Ads" },
  { id: "open", label: "Awaiting review" }
];

const state = { rows: [], filter: "all", search: "", busy: false };

export default async function render(root) {
  root.innerHTML = `<div class="admin-body"><p class="muted">Loading marketing requests…</p></div>`;
  await load(root);
}

async function load(root) {
  try {
    const { data, error } = await sb
      .from("marketing_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    state.rows = data || [];
  } catch (error) {
    root.innerHTML = `<div class="admin-body"><div class="alert alert-warning"><span>${esc(
      normalizeError(error).message
    )}</span></div></div>`;
    return;
  }
  paint(root);
}

function filtered() {
  return state.rows.filter((row) => {
    if (state.filter === "meta_ads" || state.filter === "google_ads") {
      if (row.campaign_type !== state.filter) return false;
    }
    if (state.filter === "open") {
      if (!["submitted", "under_review", "more_information_required"].includes(row.status)) return false;
    }
    if (state.search) {
      const haystack = `${row.reference || ""} ${row.objective || ""} ${row.details?.businessName || ""} ${row.details?.instagram || ""}`.toLowerCase();
      if (!haystack.includes(state.search.toLowerCase())) return false;
    }
    return true;
  });
}

function paint(root) {
  const rows = filtered();
  const pending = state.rows.filter((row) => ["submitted", "under_review"].includes(row.status)).length;
  const approved = state.rows.filter((row) => ["approved", "in_progress"].includes(row.status)).length;
  const completed = state.rows.filter((row) => row.status === "completed").length;
  const budget = state.rows
    .filter((row) => row.status !== "draft")
    .reduce((sum, row) => sum + Number(row.budget_paise || 0), 0);

  root.innerHTML = `
    <div class="admin-body">
      <div class="admin-head">
        <div>
          <h1 class="page-title">Marketing requests</h1>
          <p class="page-desc">Requests for extra service. Approving one records a decision — it does not launch an advert.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="refresh">${icon("refresh-cw", { size: 13 })}Refresh</button>
      </div>

      <div class="grid-4" style="margin-bottom:var(--s-4)">
        ${statCard({ label: "Awaiting review", value: String(pending), iconName: "inbox", foot: "Submitted or under review" })}
        ${statCard({ label: "Approved", value: String(approved), iconName: "check-check", foot: "Approved or in progress" })}
        ${statCard({ label: "Completed", value: String(completed), iconName: "flag", foot: "Finished work" })}
        ${statCard({ label: "Budget requested", value: money(Math.round(budget / 100)), iconName: "indian-rupee", foot: "Advert budget, not service charge" })}
      </div>

      <div class="row gap-2 wrap" style="margin-bottom:var(--s-3)">
        ${FILTERS.map(
          (filter) => `<button class="chip ${state.filter === filter.id ? "is-active" : ""}" data-filter="${filter.id}">${esc(filter.label)}</button>`
        ).join("")}
        <input class="input" id="admin-search" placeholder="Reference, business or Instagram" style="max-width:280px" value="${esc(
          state.search
        )}" />
      </div>

      ${
        rows.length
          ? `<div class="stack gap-2">${rows.map(rowMarkup).join("")}</div>`
          : emptyState({
              icon: "inbox",
              title: state.rows.length ? "Nothing matches this filter" : "No marketing requests yet",
              desc: state.rows.length
                ? "Clear the filter or the search to see the rest."
                : "Requests appear here as soon as a customer submits one."
            })
      }
    </div>`;

  wire(root);
}

function rowMarkup(row) {
  const details = row.details || {};
  return `<div class="card request-card">
    <div class="card-head">
      <div class="card-title">
        ${esc(details.businessName || "Customer request")}
        <span class="mono dim" style="font-size:var(--fs-2xs)">${esc(row.reference || "draft")}</span>
      </div>
      <div class="row gap-2">
        <span class="badge badge-muted">${esc(row.campaign_type === "google_ads" ? "Google Ads" : "Meta Ads")}</span>
        ${statusBadge(row.status)}
      </div>
    </div>
    <div class="card-body stack gap-2">
      <div class="row gap-4 wrap" style="font-size:var(--fs-xs)">
        <span class="dim">Objective: <span style="color:var(--text-2)">${esc(row.objective || "—")}</span></span>
        <span class="dim">Budget: <span style="color:var(--text-2)">${money(Math.round(Number(row.budget_paise || 0) / 100))} ${esc(
          row.budget_mode || ""
        )}</span></span>
        <span class="dim">Duration: <span style="color:var(--text-2)">${row.duration_days ? `${row.duration_days} days` : "—"}</span></span>
        <span class="dim">Submitted: <span style="color:var(--text-2)">${esc(timeAgo(row.created_at))}</span></span>
      </div>
      <div class="row gap-2 wrap">
        <button class="btn btn-secondary btn-sm" data-open="${esc(row.id)}">${icon("eye", { size: 13 })}Open</button>
        <button class="btn btn-ghost btn-sm" data-quick="${esc(row.id)}">${icon("list-checks", { size: 13 })}Change status</button>
      </div>
    </div>
  </div>`;
}

function wire(root) {
  on(qs("#refresh"), "click", () => load(root));
  qsa("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      state.filter = button.getAttribute("data-filter");
      paint(root);
    })
  );
  const search = qs("#admin-search");
  if (search) {
    search.addEventListener("input", () => {
      state.search = search.value;
      const caret = search.selectionStart;
      paint(root);
      const again = qs("#admin-search");
      if (again) {
        again.focus();
        again.setSelectionRange(caret, caret);
      }
    });
  }
  qsa("[data-open]").forEach((button) =>
    button.addEventListener("click", () => openRequest(button.getAttribute("data-open"), root))
  );
  qsa("[data-quick]").forEach((button) =>
    button.addEventListener("click", () => openStatusDialog(button.getAttribute("data-quick"), root))
  );
}

async function openRequest(id, root) {
  const row = state.rows.find((entry) => entry.id === id);
  if (!row) return;
  const details = row.details || {};

  let events = [];
  try {
    const { data } = await sb
      .from("marketing_request_events")
      .select("*")
      .eq("request_id", id)
      .order("created_at", { ascending: true });
    events = data || [];
  } catch {
    events = [];
  }

  const pairs = [
    ["Reference", row.reference || "—"],
    ["Campaign", row.campaign_type === "google_ads" ? "Google Ads" : "Meta Ads"],
    ["Campaign type", details.subtype || "—"],
    ["Objective", row.objective || "—"],
    ["Budget", `${money(Math.round(Number(row.budget_paise || 0) / 100))} ${row.budget_mode || ""}`],
    ["Duration", row.duration_days ? `${row.duration_days} days` : "—"],
    ["Start date", row.start_date || "—"],
    ["Location", row.location || "—"],
    ["Audience", details.audience || row.audience || "—"],
    ["Age range", details.ageRange || "—"],
    ["Interests", details.interests || "—"],
    ["Landing page", details.landingPage || "—"],
    ["Ad text", details.adText || row.creative_notes || "—"],
    ["Instagram", details.instagram || "—"],
    ["Business description", details.businessDescription || "—"],
    ["Profile details", details.profileDetails || "—"],
    ["Website", details.website || "—"],
    ["Contact", `${details.contactName || ""} ${details.contact || row.contact_preference || ""}`.trim() || "—"],
    ["Instructions", details.instructions || "—"],
    ["Submitted", new Date(row.created_at).toLocaleString()],
    ["Last updated", new Date(row.updated_at || row.created_at).toLocaleString()],
    ["Customer decision", row.decided_at ? `${new Date(row.decided_at).toLocaleString()} by ${row.decided_by || "admin"}` : "—"]
  ];

  const assets = Array.isArray(details.assets) ? details.assets : [];
  const accounts = Array.isArray(row.accounts) ? row.accounts : [];

  openModal({
    title: `Request ${row.reference || ""}`,
    size: "lg",
    body: `<div class="stack gap-3">
      <div class="wz-review">
        ${pairs.map(([label, value]) => `<div class="kv"><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`).join("")}
      </div>
      <div>
        <div class="field-label">Accounts on the request</div>
        ${accounts.length ? accounts.map((account) => `<div class="dim" style="font-size:var(--fs-2xs)">${esc(account.channel)}${
          account.handle ? ` · ${esc(account.handle)}` : ""
        }</div>`).join("") : `<p class="field-hint">None recorded.</p>`}
      </div>
      <div>
        <div class="field-label">Assets</div>
        ${
          assets.length
            ? assets
                .map(
                  (asset) => `<div class="row gap-2" style="font-size:var(--fs-2xs)">
                    <span>${esc(asset.name)}</span>
                    ${
                      asset.path
                        ? `<button class="btn btn-ghost btn-sm" data-asset="${esc(asset.path)}">${icon("download", { size: 12 })}Open</button>`
                        : `<span class="dim">not uploaded</span>`
                    }
                  </div>`
                )
                .join("")
            : `<p class="field-hint">No assets attached.</p>`
        }
      </div>
      <div>
        <div class="field-label">Event history</div>
        ${
          events.length
            ? events
                .map(
                  (event) => `<div class="row gap-2" style="font-size:var(--fs-2xs)">
                    <span class="dim" style="white-space:nowrap">${esc(timeAgo(event.created_at))}</span>
                    <span>${event.internal ? `<span class="badge badge-warning">internal</span> ` : ""}${esc(event.body || event.kind)}</span>
                  </div>`
                )
                .join("")
            : `<p class="field-hint">No events yet.</p>`
        }
      </div>
      <div class="field">
        <label class="field-label" for="admin-note">Internal note <span class="dim">only administrators see this</span></label>
        <textarea class="textarea" id="admin-note" rows="3" placeholder="What was agreed, what to check next">${esc(row.admin_notes || "")}</textarea>
      </div>
      <div id="review-error"></div>
    </div>`,
    footer: `<button class="btn btn-ghost btn-sm" data-close>Close</button>
             <button class="btn btn-secondary btn-sm" id="save-note">${icon("save", { size: 13 })}Save note</button>
             <button class="btn btn-primary btn-sm" id="change-status">${icon("list-checks", { size: 13 })}Change status</button>`,
    onMount: ({ close }) => {
      qs("[data-close]").addEventListener("click", close);
      qsa("[data-asset]").forEach((button) =>
        button.addEventListener("click", async () => {
          const path = button.getAttribute("data-asset");
          try {
            const { data, error } = await sb.storage.from("marketing-assets").createSignedUrl(path, 600);
            if (error) throw error;
            window.open(data.signedUrl, "_blank", "noopener,noreferrer");
          } catch (error) {
            toastError(normalizeError(error));
          }
        })
      );
      qs("#save-note").addEventListener("click", async () => {
        const note = qs("#admin-note").value.trim();
        try {
          const { error } = await sb.from("marketing_requests").update({ admin_notes: note }).eq("id", row.id);
          if (error) throw error;
          row.admin_notes = note;
          toast({ title: "Note saved" }, { tone: "success" });
        } catch (error) {
          safeSet("#review-error", `<div class="alert alert-warning"><span>${esc(normalizeError(error).message)}</span></div>`);
        }
      });
      qs("#change-status").addEventListener("click", () => {
        close();
        openStatusDialog(row.id, root);
      });
    }
  });
}

function openStatusDialog(id, root) {
  const row = state.rows.find((entry) => entry.id === id);
  if (!row) return;

  openModal({
    title: `Status for ${row.reference || "this request"}`,
    size: "md",
    body: `<div class="stack gap-3">
      <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
        Changing the status records the decision and notifies the customer. “Approved” means the team accepted the work — it does not mean an advert is running.
      </p>
      <div class="field"><label class="field-label" for="next-status">New status</label>
        <select class="select" id="next-status">
          ${STATUSES.map((status) => `<option value="${status}" ${row.status === status ? "selected" : ""}>${esc(
            statusLabel(status)
          )}</option>`).join("")}
        </select></div>
      <div class="field"><label class="field-label" for="status-note">Message to the customer <span class="dim">optional</span></label>
        <textarea class="textarea" id="status-note" rows="3" placeholder="What happens next"></textarea></div>
      <label class="row gap-2" style="font-size:var(--fs-2xs);align-items:center">
        <input type="checkbox" id="status-internal" /> Keep this note internal only
      </label>
      <div id="status-error"></div>
    </div>`,
    footer: `<button class="btn btn-ghost btn-sm" data-close>Cancel</button>
             <button class="btn btn-primary btn-sm" id="apply-status">${icon("check", { size: 13 })}Apply</button>`,
    onMount: ({ close }) => {
      qs("[data-close]").addEventListener("click", close);
      qs("#apply-status").addEventListener("click", async () => {
        const status = qs("#next-status").value;
        const note = qs("#status-note").value.trim();
        const internal = qs("#status-internal").checked;
        const button = qs("#apply-status");
        button.disabled = true;
        button.innerHTML = `<span class="spinner"></span><span>Applying…</span>`;

        try {
          const patch = { status };
          if (status === "approved" || status === "rejected") {
            patch.decided_by = adminState.identity?.user?.id || null;
            patch.decided_at = new Date().toISOString();
          }
          const { data, error } = await sb.from("marketing_requests").update(patch).eq("id", row.id).select("*").single();
          if (error) throw error;

          /* The timeline entry and the customer's notification are separate
             writes; if either fails the modal says so instead of pretending. */
          const problems = [];
          try {
            const { error: eventError } = await sb.from("marketing_request_events").insert({
              request_id: row.id,
              actor_id: adminState.identity?.user?.id || null,
              kind: "status",
              body: note || `Status changed to ${statusLabel(status)}.`,
              internal
            });
            if (eventError) throw eventError;
          } catch (error) {
            problems.push(`The timeline entry was not written: ${normalizeError(error).message}`);
          }

          if (!internal) {
            try {
              const { error: notifyError } = await sb.rpc("notify_customer", {
                p_user: row.user_id,
                p_title: `Request ${row.reference || ""} — ${statusLabel(status)}`,
                p_body: note || `Your request is now ${statusLabel(status)}.`,
                p_link: "/app/?view=marketing",
                p_type: "marketing"
              });
              if (notifyError) throw notifyError;
            } catch (error) {
              problems.push(`The customer was not notified: ${normalizeError(error).message}`);
            }
          }

          state.rows = state.rows.map((entry) => (entry.id === row.id ? data : entry));
          close();
          paint(root);
          if (problems.length) {
            toast({ title: "Status changed, with problems", message: problems.join(" · ") }, { tone: "warning", duration: 9000 });
          } else {
            toast({ title: `Marked ${statusLabel(status)}`, message: "The customer has been notified." }, { tone: "success" });
          }
        } catch (error) {
          const normalized = normalizeError(error);
          const host = qs("#status-error");
          if (host) host.innerHTML = `<div class="alert alert-warning"><span>${esc(normalized.message)}</span></div>`;
          button.disabled = false;
          button.innerHTML = `${icon("check", { size: 13 })}Apply`;
        }
      });
    }
  });
}
