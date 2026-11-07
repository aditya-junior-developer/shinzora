/* ==========================================================================
   Shinzora — Request for Extra Service
   --------------------------------------------------------------------------
   This is a request desk, not an advertising switchboard.

   A customer connects the accounts they already own, describes the business
   and the campaign they want, and submits it. An administrator reviews it and
   decides. Nothing in this file launches an advert, spends money or claims that
   a campaign is live — the only thing a submission does is create a record and
   tell the administrators it exists.

   Honesty rules kept here:
     • an account is "Verified" only when an administrator verified it; a newly
       submitted connection says "Submitted for verification"
     • OAuth is not configured on this deployment, so no connection pretends to
       have gone through an official consent screen
     • the status shown is the status in the database, including its reference
   ========================================================================== */

import { qs, qsa, esc, on, safeSet } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { money, timeAgo } from "../../../lib/format.js";
import { state } from "../../../lib/store.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { campaigns as fetchCampaigns } from "../data.js";
import { pageHead, emptyState, setupNotice, skeletonView, statusBadge, statCard } from "../components.js";
import { confirmDialog, openModal } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";

const CHANNELS = [
  { id: "instagram", label: "Instagram", icon: "instagram", what: "Profile URL or @username" },
  { id: "facebook", label: "Facebook Page", icon: "share-2", what: "Page URL and Page name" },
  { id: "whatsapp", label: "WhatsApp Business", icon: "whatsapp", what: "Business number and profile name" },
  { id: "email", label: "Email", icon: "mail", what: "Sending address for campaigns" },
  { id: "google_ads", label: "Google Ads", icon: "search", what: "Customer ID (10 digits) — Search is a campaign type inside Google Ads" }
];

const CAMPAIGN_TYPES = {
  meta_ads: {
    label: "Meta Ads",
    icon: "instagram",
    desc: "Instagram and Facebook advertising, managed together in one Meta campaign.",
    placements: ["Instagram feed", "Instagram stories", "Facebook feed", "Facebook reels", "Advantage+ placements"]
  },
  google_ads: {
    label: "Google Ads",
    icon: "search",
    desc: "Search, display and other Google Ads campaign types. Search is a campaign type here, not a separate account.",
    placements: ["Google Search", "Search partners", "Display network", "Performance Max"]
  }
};

const OBJECTIVES = [
  "Leads / enquiries",
  "Website traffic",
  "Messages on WhatsApp or Instagram",
  "Phone calls",
  "Store visits",
  "Sales / conversions",
  "Brand awareness"
];

const STEPS = [
  { id: 1, title: "Accounts", hint: "What we may work with" },
  { id: 2, title: "Business", hint: "Instagram and brand profile" },
  { id: 3, title: "Campaign", hint: "Objective, budget, audience" },
  { id: 4, title: "Review", hint: "Check and submit" }
];

const view = {
  requests: [],
  accounts: [],
  campaigns: [],
  events: {},
  step: 0,
  type: null,
  draft: { detail: {}, campaign: {}, accounts: [] },
  assets: [],
  busy: false
};

export default async function render(root) {
  root.innerHTML = skeletonView(3);

  try {
    const [requestRows, accountRows, campaignRows] = await Promise.all([
      sb.from("marketing_requests").select("*").order("created_at", { ascending: false }),
      sb.from("marketing_accounts").select("*").order("created_at", { ascending: false }),
      fetchCampaigns().catch(() => ({ data: [] }))
    ]);
    if (requestRows.error) throw normalizeError(requestRows.error);
    view.requests = requestRows.data || [];
    view.accounts = accountRows.data || [];
    view.campaigns = campaignRows.data || [];
  } catch (error) {
    root.innerHTML = `${pageHead({ title: "Request for Extra Service" })}${setupNotice(error, "Requests")}`;
    return;
  }

  paint(root);
}

/* ------------------------------------------------------------------ painting */

function paint(root) {
  const open = view.requests.filter((row) =>
    ["submitted", "under_review", "more_information_required", "approved", "in_progress"].includes(row.status)
  );
  const done = view.requests.filter((row) => row.status === "completed");
  const budget = view.requests
    .filter((row) => row.status !== "draft")
    .reduce((sum, row) => sum + Number(row.budget_paise || 0), 0);

  root.innerHTML = `
    ${pageHead({
      title: "Request for Extra Service",
      desc: "Ask the Shinzora team to plan, set up and run advertising for your business. A request is reviewed by a person before anything happens.",
      actions: `<button class="btn btn-primary btn-sm" id="new-request">${icon("plus", { size: 14 })}New request</button>`
    })}

    <div class="alert alert-info" style="margin-bottom:var(--s-4)">
      ${icon("shield-check", { size: 15 })}
      <span><span class="alert-title">Nothing here spends money</span>
      Submitting a request does not launch an advert. The team reviews it, agrees the plan with you, and only then starts work.</span>
    </div>

    <div class="grid-4" style="margin-bottom:var(--s-4)">
      ${statCard({ label: "Open requests", value: String(open.length), iconName: "inbox", foot: "Waiting or in progress" })}
      ${statCard({ label: "Completed", value: String(done.length), iconName: "check-check", foot: "Finished work" })}
      ${statCard({ label: "Budget requested", value: money(Math.round(budget / 100)), iconName: "indian-rupee", foot: "Across submitted requests" })}
      ${statCard({ label: "Accounts", value: String(view.accounts.length), iconName: "link", foot: "Submitted for verification" })}
    </div>

    ${view.step ? wizard() : list(root)}

    <div class="card" style="margin-top:var(--s-4)">
      <div class="card-head"><div class="card-title">Connected accounts</div>
        <button class="btn btn-secondary btn-sm" id="manage-accounts">${icon("plus", { size: 13 })}Add an account</button></div>
      <div class="card-body" id="accounts-body">${accountsMarkup()}</div>
    </div>

    ${
      view.campaigns.length
        ? `<div class="card" style="margin-top:var(--s-4)">
             <div class="card-head"><div class="card-title">Earlier campaign records</div><span class="card-sub">${view.campaigns.length} records</span></div>
             <div class="card-body stack gap-2">
               ${view.campaigns
                 .slice(0, 8)
                 .map(
                   (row) => `<div class="row gap-3" style="justify-content:space-between;font-size:var(--fs-xs)">
                     <span>${esc(row.name || "Campaign")} <span class="dim">· ${esc(row.channel || "")}</span></span>
                     <span class="dim">${statusBadge(row.status || "planned")}</span>
                   </div>`
                 )
                 .join("")}
               <p class="field-hint">These are historical campaign plans kept from before the request desk. They are records, not live adverts.</p>
             </div>
           </div>`
        : ""
    }
  `;

  wire(root);
}

/* --------------------------------------------------------------------- list */

function list() {
  if (!view.requests.length) {
    return emptyState({
      icon: "inbox",
      title: "No requests yet",
      desc: "Start a request and the team will review it. You will see its status and every reply here."
    });
  }
  return `<div class="stack gap-3">
    ${view.requests
      .map(
        (row) => `<div class="card request-card">
          <div class="card-head">
            <div class="card-title">${esc(CAMPAIGN_TYPES[row.campaign_type]?.label || row.campaign_type)}
              <span class="mono dim" style="font-size:var(--fs-2xs)">${esc(row.reference || "Draft")}</span></div>
            <div class="row gap-2">${statusBadge(row.status)}</div>
          </div>
          <div class="card-body stack gap-2">
            <div class="row gap-4 wrap" style="font-size:var(--fs-xs)">
              <span class="dim">Objective: <span style="color:var(--text-2)">${esc(row.objective || "—")}</span></span>
              <span class="dim">Budget: <span style="color:var(--text-2)">${money(Math.round(Number(row.budget_paise || 0) / 100))} ${esc(row.budget_mode || "")}</span></span>
              <span class="dim">Duration: <span style="color:var(--text-2)">${row.duration_days ? row.duration_days + " days" : "—"}</span></span>
              <span class="dim">Submitted: <span style="color:var(--text-2)">${esc(timeAgo(row.created_at))}</span></span>
            </div>
            ${row.admin_notes && row.status !== "submitted" ? `<p class="muted" style="font-size:var(--fs-xs)">${icon("message-square", { size: 12 })} ${esc(row.admin_notes)}</p>` : ""}
            <div class="row gap-2 wrap">
              <button class="btn btn-ghost btn-sm" data-events="${esc(row.id)}">${icon("history", { size: 13 })}History</button>
              ${row.status === "more_information_required" ? `<button class="btn btn-secondary btn-sm" data-update="${esc(row.id)}">${icon("pencil", { size: 13 })}Send the extra information</button>` : ""}
              ${row.status === "draft" ? `<button class="btn btn-primary btn-sm" data-submit="${esc(row.id)}">${icon("send", { size: 13 })}Submit for review</button>` : ""}
            </div>
            <div class="stack gap-1" id="events-${esc(row.id)}" hidden></div>
          </div>
        </div>`
      )
      .join("")}
  </div>`;
}

function accountsMarkup() {
  if (!view.accounts.length) {
    return `<p class="muted" style="font-size:var(--fs-xs);line-height:1.6">No accounts yet. Add the Instagram profile, Facebook Page, WhatsApp Business number, sending email and Google Ads customer ID the campaign should use.</p>`;
  }
  return `<div class="stack gap-2">
    ${view.accounts
      .map(
        (account) => `<div class="service-row row gap-3" style="justify-content:space-between">
          <span>${icon(accountIconFor(account.channel), { size: 14 })}
            <strong>${esc(account.channel === "google_ads" ? "Google Ads" : account.handle || account.channel)}</strong>
            ${account.profile_url ? `<span class="dim"> · ${esc(account.profile_url.replace(/^https?:\/\//, ""))}</span>` : ""}
          </span>
          <span class="dim" style="font-size:var(--fs-2xs)">${accountStatusLabel(account)}</span>
        </div>`
      )
      .join("")}
    <p class="field-hint">A connection is verified by the Shinzora team before it is used. Until then it says “Submitted for verification” — never “Connected”.</p>
  </div>`;
}

function accountIconFor(channel) {
  return CHANNELS.find((entry) => entry.id === channel)?.icon || "link";
}

function accountStatusLabel(account) {
  if (account.status === "verified") return `<span class="badge badge-ok">${icon("check", { size: 10 })}Verified by Shinzora</span>`;
  if (account.status === "rejected") return `<span class="badge badge-danger">Not accepted — ${esc(account.note || "see the team's note")}</span>`;
  if (account.status === "revoked") return `<span class="badge badge-muted">Revoked</span>`;
  return `<span class="badge badge-warning">Submitted for verification</span>`;
}

/* ------------------------------------------------------------------- wizard */

function wizard() {
  const step = STEPS[view.step];
  return `<div class="card">
    <div class="card-head">
      <div class="card-title">New request — ${esc(step.title)}</div>
      <span class="card-sub">Step ${step.id} of 4 · ${esc(step.hint)}</span>
    </div>
    <div class="card-body stack gap-4">
      <div class="wz-ticks">
        ${STEPS.map(
          (entry) => `<span class="wz-tick ${entry.id === step.id ? "is-active" : ""} ${entry.id < step.id ? "is-done" : ""}">
            <span class="wz-num">${entry.id < step.id ? icon("check", { size: 10, stroke: 3 }) : entry.id}</span>
            <span class="wz-label">${esc(entry.title)}</span></span>`
        ).join("")}
      </div>
      ${view.step === 0 ? stepAccounts() : ""}
      ${view.step === 1 ? stepBusiness() : ""}
      ${view.step === 2 ? stepCampaign() : ""}
      ${view.step === 3 ? stepReview() : ""}
      <div class="row gap-2 wrap">
        <button class="btn btn-ghost btn-sm" id="wizard-cancel">Cancel</button>
        ${view.step > 0 ? `<button class="btn btn-secondary btn-sm" id="wizard-back">Back</button>` : ""}
        ${view.step < 3 ? `<button class="btn btn-primary" id="wizard-next">Continue ${icon("arrow-right", { size: 14 })}</button>` : ""}
        ${view.step === 3 ? `<button class="btn btn-primary" id="wizard-submit" ${view.busy ? "disabled" : ""}>${icon("send", { size: 14 })}Submit request</button>` : ""}
      </div>
      <div id="wizard-error"></div>
    </div>
  </div>`;
}

function stepAccounts() {
  return `<div class="stack gap-3">
    <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
      Add the accounts the campaign should use. Official OAuth is not configured on this deployment, so a connection is recorded and checked by a person — no password is ever asked for, here or anywhere else.
    </p>
    <div class="grid-2">
      ${CHANNELS.map(
        (channel) => `<label class="wz-option ${view.draft.accounts.includes(channel.id) ? "is-active" : ""}">
          <input type="checkbox" data-channel="${channel.id}" ${view.draft.accounts.includes(channel.id) ? "checked" : ""}>
          <span><strong>${icon(channel.icon, { size: 13 })} ${esc(channel.label)}</strong>
          <span class="dim">${esc(channel.what)}</span></span>
        </label>`
      ).join("")}
    </div>
    <div class="field">
      <label class="field-label" for="account-handle">Handle, URL or ID</label>
      <input class="input" id="account-handle" placeholder="@yourbrand · https://instagram.com/yourbrand · 123-456-7890" />
      <div class="field-hint">One identifier per submission. Add the rest from the accounts card after this request.</div>
    </div>
    <div class="field">
      <label class="field-label" for="account-channel">Which account is this identifier for?</label>
      <select class="select" id="account-channel">
        ${CHANNELS.map((channel) => `<option value="${channel.id}">${esc(channel.label)}</option>`).join("")}
      </select>
    </div>
  </div>`;
}

function stepBusiness() {
  const d = view.draft.detail;
  return `<div class="stack gap-3">
    ${field("Instagram profile URL", "instagram", d.instagram, "https://instagram.com/yourbrand")}
    ${field("Business or brand name", "businessName", d.businessName || state.business?.name || "")}
    ${textarea("Business description", "businessDescription", d.businessDescription || state.business?.description || "")}
    ${textarea("Current profile details", "profileDetails", d.profileDetails, "Bio, follower count, what is already posted")}
    ${field("Target audience", "audience", d.audience)}
    ${field("Business location or service area", "location", d.location)}
    ${field("Website, if any", "website", d.website)}
    <div class="field">
      <label class="field-label">Campaign assets <span class="dim">optional</span></label>
      <input class="input" type="file" id="asset-input" accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf" multiple />
      <div class="field-hint">Logos, product photos or a brief PDF. Images up to 10 MB each, stored privately and shown only to you and the Shinzora team.</div>
      <div class="row gap-2 wrap" id="asset-list">
        ${view.assets.map((asset) => `<span class="badge badge-muted">${esc(asset.name)}${asset.path ? "" : " · not uploaded"}</span>`).join("")}
      </div>
    </div>
  </div>`;
}

function stepCampaign() {
  const c = view.draft.campaign;
  return `<div class="stack gap-3">
    <div class="field">
      <label class="field-label">Campaign platform</label>
      <div class="grid-2">
        ${Object.entries(CAMPAIGN_TYPES)
          .map(
            ([id, meta]) => `<label class="wz-option ${view.type === id ? "is-active" : ""}">
              <input type="radio" name="campaign-type" value="${id}" ${view.type === id ? "checked" : ""}>
              <span><strong>${icon(meta.icon, { size: 13 })} ${esc(meta.label)}</strong>
              <span class="dim">${esc(meta.desc)}</span></span>
            </label>`
          )
          .join("")}
      </div>
    </div>
    ${
      view.type
        ? `<div class="field"><label class="field-label" for="campaign-subtype">Campaign type</label>
             <select class="select" id="campaign-subtype">
               ${CAMPAIGN_TYPES[view.type].placements
                 .map((placement) => `<option ${c.subtype === placement ? "selected" : ""}>${esc(placement)}</option>`)
                 .join("")}
             </select></div>`
        : ""
    }
    <div class="field"><label class="field-label" for="objective">Objective</label>
      <select class="select" id="objective">
        ${OBJECTIVES.map((objective) => `<option ${c.objective === objective ? "selected" : ""}>${esc(objective)}</option>`).join("")}
      </select></div>
    <div class="grid-2">
      ${field("Budget (₹)", "budget", c.budget, "15000", "number")}
      <div class="field"><label class="field-label" for="budget-mode">Budget is</label>
        <select class="select" id="budget-mode">
          <option value="total" ${c.budgetMode === "total" ? "selected" : ""}>Total for the campaign</option>
          <option value="daily" ${c.budgetMode === "daily" ? "selected" : ""}>Per day</option>
        </select></div>
      ${field("Duration (days)", "duration", c.duration, "14", "number")}
      ${field("Start date", "startDate", c.startDate, "", "date")}
      ${field("Target location", "location", c.location || view.draft.detail.location)}
      ${field("Age range", "ageRange", c.ageRange, "25-34")}
    </div>
    ${field("Interests or targeting notes", "interests", c.interests)}
    ${textarea("Ad text", "adText", c.adText, "What the advert should say, or the points it must make")}
    ${field("Landing page URL", "landingPage", c.landingPage || view.draft.detail.website)}
    <div class="grid-2">
      ${field("Contact name", "contactName", c.contactName)}
      ${field("Contact phone or email", "contact", c.contact)}
    </div>
    ${textarea("Anything else the team should know", "instructions", c.instructions)}
    <div class="alert alert-info" style="font-size:var(--fs-2xs)">
      ${icon("info", { size: 14 })}
      <span>The budget above is the amount you want to spend on adverts. Shinzora's service charge for setting up and managing the campaign is quoted separately by the team — it is never taken from this number.</span>
    </div>
  </div>`;
}

function stepReview() {
  const d = view.draft.detail;
  const c = view.draft.campaign;
  const rows = [
    ["Platform", CAMPAIGN_TYPES[view.type]?.label || "—"],
    ["Campaign type", c.subtype || "—"],
    ["Objective", c.objective || "—"],
    ["Budget", c.budget ? `${money(Number(c.budget))} ${c.budgetMode === "daily" ? "per day" : "total"}` : "—"],
    ["Duration", c.duration ? `${c.duration} days` : "—"],
    ["Start date", c.startDate || "As soon as the team starts"],
    ["Location", c.location || d.location || "—"],
    ["Audience", d.audience || "—"],
    ["Age range", c.ageRange || "—"],
    ["Landing page", c.landingPage || d.website || "—"],
    ["Instagram", d.instagram || "—"],
    ["Contact", c.contact || "—"],
    ["Accounts added", view.draft.accounts.map((id) => CHANNELS.find((x) => x.id === id)?.label).join(", ") || "None"],
    ["Assets", view.assets.map((asset) => asset.name).join(", ") || "None"]
  ];
  return `<div class="stack gap-2">
    <div class="wz-review">
      ${rows.map(([label, value]) => `<div class="kv"><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`).join("")}
    </div>
    <div class="alert alert-warning">
      ${icon("circle-alert", { size: 15 })}
      <span><span class="alert-title">Submitting is not launching</span>
      This creates a request with a reference number and notifies the Shinzora team. No advert goes live, and no money is spent, until you and the team agree the plan.</span>
    </div>
  </div>`;
}

function field(label, name, value, placeholder = "", type = "text") {
  return `<div class="field"><label class="field-label" for="f-${name}">${esc(label)}</label>
    <input class="input" id="f-${name}" data-detail="${name}" type="${type}" value="${esc(value || "")}"
           placeholder="${esc(placeholder)}" /></div>`;
}

function textarea(label, name, value, placeholder = "") {
  return `<div class="field"><label class="field-label" for="f-${name}">${esc(label)}</label>
    <textarea class="textarea" id="f-${name}" data-detail="${name}" rows="3" placeholder="${esc(placeholder)}">${esc(value || "")}</textarea></div>`;
}

/* -------------------------------------------------------------------- wiring */

function wire(root) {
  on(qs("#new-request"), "click", () => {
    view.step = 0;
    view.type = null;
    view.draft = { detail: {}, campaign: {}, accounts: [] };
    view.assets = [];
    paint(root);
  });

  on(qs("#manage-accounts"), "click", () => accountDialog(root));

  qsa("[data-events]").forEach((button) => {
    button.addEventListener("click", () => toggleEvents(button, root));
  });
  qsa("[data-submit]").forEach((button) => {
    button.addEventListener("click", () => submitDraft(button.getAttribute("data-submit"), root));
  });
  qsa("[data-update]").forEach((button) => {
    button.addEventListener("click", () => {
      toast({ title: "Reply with the extra information", message: "Add it to the request notes and the team is notified immediately." }, { tone: "info" });
      const id = button.getAttribute("data-update");
      const row = view.requests.find((entry) => entry.id === id);
      if (row) openUpdateDialog(row, root);
    });
  });

  /* wizard */
  qsa("[data-detail]").forEach((node) => {
    node.addEventListener("input", () => {
      const name = node.getAttribute("data-detail");
      if (view.step === 1) view.draft.detail[name] = node.value;
      else view.draft.campaign[name] = node.value;
    });
  });
  qsa("[data-channel]").forEach((node) => {
    node.addEventListener("change", () => {
      const id = node.getAttribute("data-channel");
      view.draft.accounts = node.checked
        ? [...new Set([...view.draft.accounts, id])]
        : view.draft.accounts.filter((entry) => entry !== id);
      paint(root);
    });
  });
  qsa("input[name='campaign-type']").forEach((node) => {
    node.addEventListener("change", () => {
      view.type = node.value;
      paint(root);
    });
  });
  if (qs("#objective")) on(qs("#objective"), "change", (event) => (view.draft.campaign.objective = event.target.value));
  if (qs("#campaign-subtype")) on(qs("#campaign-subtype"), "change", (event) => (view.draft.campaign.subtype = event.target.value));
  if (qs("#budget-mode")) on(qs("#budget-mode"), "change", (event) => (view.draft.campaign.budgetMode = event.target.value));
  if (qs("#asset-input")) on(qs("#asset-input"), "change", (event) => collectAssets(event.target, root));

  if (qs("#wizard-cancel")) on(qs("#wizard-cancel"), "click", () => { view.step = 0; paint(root); });
  if (qs("#wizard-back")) on(qs("#wizard-back"), "click", () => { view.step -= 1; paint(root); });
  if (qs("#wizard-next")) on(qs("#wizard-next"), "click", () => advance(root));
  if (qs("#wizard-submit")) on(qs("#wizard-submit"), "click", () => submitRequest(root));
}

function showWizardError(root, problems) {
  const host = qs("#wizard-error");
  if (!host) return;
  host.innerHTML = `<div class="alert alert-warning"><span><span class="alert-title">Before continuing</span>
    <ul style="margin:6px 0 0 16px">${problems.map((problem) => `<li>${esc(problem)}</li>`).join("")}</ul></span></div>`;
  host.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function advance(root) {
  const problems = [];
  if (view.step === 0 && !view.accounts.length && !view.draft.accounts.length) {
    problems.push("Add at least one account — Instagram is the usual starting point.");
  }
  if (view.step === 1) {
    if (!String(view.draft.detail.instagram || "").trim()) problems.push("The Instagram profile URL or username is required.");
    if (!String(view.draft.detail.businessName || "").trim()) problems.push("The business or brand name is required.");
    if (String(view.draft.detail.businessDescription || "").trim().length < 10) problems.push("Describe the business in a sentence or two.");
    if (!String(view.draft.detail.audience || "").trim()) problems.push("Describe the target audience.");
    if (!String(view.draft.detail.location || "").trim()) problems.push("Add the business location or service area.");
  }
  if (view.step === 2) {
    if (!view.type) problems.push("Choose Meta Ads or Google Ads.");
    if (!view.draft.campaign.objective) view.draft.campaign.objective = OBJECTIVES[0];
    const budget = Number(view.draft.campaign.budget);
    if (!budget || budget <= 0) problems.push("Enter the advert budget.");
    if (!Number(view.draft.campaign.duration) || Number(view.draft.campaign.duration) <= 0) problems.push("Enter the campaign duration in days.");
    if (!String(view.draft.campaign.contact || "").trim()) problems.push("Add a contact phone number or email.");
  }
  if (problems.length) return showWizardError(root, problems);
  if (view.step >= 3) return;
  view.step += 1;
  paint(root);
}

/* ------------------------------------------------------------------ accounts */

async function accountDialog(root) {
  const body = `<div class="stack gap-3">
    <p class="muted" style="font-size:var(--fs-xs);line-height:1.6">
      Official OAuth is not configured on this deployment. You can still record the account here: it is saved against your business, marked “Submitted for verification”, and the team checks it by hand. A password is never requested.
    </p>
    <div class="field"><label class="field-label" for="dlg-channel">Account</label>
      <select class="select" id="dlg-channel">${CHANNELS.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("")}</select></div>
    <div class="field"><label class="field-label" for="dlg-handle">Handle, number or customer ID</label>
      <input class="input" id="dlg-handle" placeholder="@yourbrand" /></div>
    <div class="field"><label class="field-label" for="dlg-url">Profile URL <span class="dim">optional</span></label>
      <input class="input" id="dlg-url" placeholder="https://instagram.com/yourbrand" /></div>
    <div id="dlg-error"></div>
  </div>`;

  openModal({
    title: "Add an account",
    body,
    size: "md",
    footer: `<button class="btn btn-ghost btn-sm" data-close>Cancel</button>
             <button class="btn btn-primary btn-sm" id="dlg-save">${icon("plus", { size: 13 })}Add account</button>`,
    onMount: ({ close }) => {
      qs("[data-close]").addEventListener("click", close);
      qs("#dlg-save").addEventListener("click", async () => {
        const channel = qs("#dlg-channel").value;
        const handle = qs("#dlg-handle").value.trim();
        const profileUrl = qs("#dlg-url").value.trim();
        if (!handle) {
          safeSet("#dlg-error", `<div class="alert alert-warning"><span>An account handle or number is required.</span></div>`);
          return;
        }
        try {
          const { data, error } = await sb
            .from("marketing_accounts")
            .insert({
              user_id: state.user.id,
              business_id: state.business?.id || null,
              channel,
              handle,
              profile_url: profileUrl || null,
              /* 'submitted' is the only status a customer may write; the
                 database refuses anything else. */
              status: "submitted"
            })
            .select("*")
            .single();
          if (error) throw error;
          view.accounts = [data, ...view.accounts];
          close();
          paint(root);
          toast({ title: "Account added", message: "It is queued for verification by the Shinzora team." }, { tone: "success" });
        } catch (error) {
          const normalized = normalizeError(error);
          safeSet("#dlg-error", `<div class="alert alert-warning"><span>${esc(normalized.message)}</span></div>`);
        }
      });
    }
  });
}

async function toggleEvents(button, root) {
  const id = button.getAttribute("data-events");
  const host = qs(`#events-${id}`);
  if (!host) return;
  if (!host.hidden) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = `<p class="field-hint">Loading history…</p>`;
  try {
    const { data, error } = await sb
      .from("marketing_request_events")
      .select("*")
      .eq("request_id", id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    host.innerHTML = data?.length
      ? data
          .map(
            (event) => `<div class="row gap-2" style="font-size:var(--fs-2xs);align-items:flex-start">
              <span class="dim" style="white-space:nowrap">${esc(timeAgo(event.created_at))}</span>
              <span>${esc(event.body || event.kind)}</span>
            </div>`
          )
          .join("")
      : `<p class="field-hint">No events recorded yet.</p>`;
  } catch (error) {
    host.innerHTML = `<p class="field-hint">${esc(normalizeError(error).message)}</p>`;
  }
}

/* -------------------------------------------------------------------- assets */

async function collectAssets(input, root) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: `${file.name} is too large`, message: "Assets are limited to 10 MB." }, { tone: "warning" });
      continue;
    }
    const entry = { name: file.name, path: null, bytes: file.size };
    try {
      const path = `${state.user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error } = await sb.storage.from("marketing-assets").upload(path, file, { upsert: false });
      if (error) throw error;
      entry.path = path;
    } catch (error) {
      entry.error = normalizeError(error).message;
      toast(
        { title: `${file.name} was not uploaded`, message: entry.error },
        { tone: "warning", duration: 8000 }
      );
    }
    view.assets = [...view.assets, entry];
  }
  paint(root);
}

/* ------------------------------------------------------------------ submit */

async function submitRequest(root) {
  const detail = view.draft.detail;
  const campaign = view.draft.campaign;
  const budgetPaise = Math.round(Number(campaign.budget || 0) * 100);

  view.busy = true;
  const button = qs("#wizard-submit");
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span><span>Submitting…</span>`;
  }

  try {
    const { data, error } = await sb
      .from("marketing_requests")
      .insert({
        user_id: state.user.id,
        business_id: state.business?.id || null,
        campaign_type: view.type,
        objective: campaign.objective || "",
        audience: detail.audience || null,
        location: campaign.location || detail.location || null,
        budget_mode: campaign.budgetMode === "daily" ? "daily" : "total",
        budget_paise: budgetPaise,
        duration_days: Number(campaign.duration) || null,
        start_date: campaign.startDate || null,
        accounts: view.draft.accounts.map((id) => ({
          channel: id,
          handle: view.accounts.find((account) => account.channel === id)?.handle || null
        })),
        creative_notes: campaign.adText || null,
        contact_preference: campaign.contact || null,
        status: "submitted",
        details: {
          instagram: detail.instagram || null,
          businessName: detail.businessName || null,
          businessDescription: detail.businessDescription || null,
          profileDetails: detail.profileDetails || null,
          audience: detail.audience || null,
          location: detail.location || null,
          website: detail.website || null,
          subtype: campaign.subtype || null,
          ageRange: campaign.ageRange || null,
          interests: campaign.interests || null,
          adText: campaign.adText || null,
          landingPage: campaign.landingPage || null,
          contactName: campaign.contactName || null,
          contact: campaign.contact || null,
          instructions: campaign.instructions || null,
          assets: view.assets.map((asset) => ({ name: asset.name, path: asset.path, bytes: asset.bytes }))
        }
      })
      .select("*")
      .single();
    if (error) throw error;

    /* The customer's own timeline entry — the database policy allows exactly
       this: a customer-visible event on their own request. */
    await sb.from("marketing_request_events").insert({
      request_id: data.id,
      actor_id: state.user.id,
      kind: "status",
      body: `Request submitted for review${data.reference ? ` (${data.reference})` : ""}.`,
      internal: false
    });

    /* Tell the administrators, through the only function that may do it. */
    let notified = 0;
    try {
      const { data: count } = await sb.rpc("notify_admins", {
        p_title: "New marketing request",
        p_body: `${detail.businessName || "A customer"} · ${CAMPAIGN_TYPES[view.type]?.label || view.type} · ₹${Number(
          campaign.budget || 0
        ).toLocaleString("en-IN")}`,
        p_link: "/admin/?view=marketing"
      });
      notified = Number(count || 0);
    } catch {
      /* The request is saved; saying it was not announced is better than
         claiming it was. */
      notified = 0;
    }

    view.requests = [data, ...view.requests];
    view.step = 0;
    view.busy = false;
    view.draft = { detail: {}, campaign: {}, accounts: [] };
    view.assets = [];
    paint(root);

    openModal({
      title: "Request submitted",
      size: "md",
      body: `<div class="stack gap-3">
        <div class="alert alert-ok"><span><span class="alert-title">Reference ${esc(data.reference || "")}</span>
          Keep this number when you contact the team.</span></div>
        <p class="muted" style="font-size:var(--fs-xs);line-height:1.7">
          No advert has been launched and no money has been spent. The Shinzora team reviews the request, then contacts you on ${esc(
            campaign.contact || "the number you provided"
          )} to agree the plan and the service charge.
        </p>
        <p class="field-hint">${
          notified
            ? `${notified} administrator${notified === 1 ? "" : "s"} notified.`
            : "The request is saved, but the administrator notification could not be sent just now — the team still sees it in the admin area."
        }</p>
      </div>`,
      footer: `<button class="btn btn-primary btn-sm" data-close>Done</button>`,
      onMount: ({ close }) => qs("[data-close]").addEventListener("click", close)
    });
  } catch (error) {
    view.busy = false;
    const normalized = normalizeError(error);
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("send", { size: 14 })}Submit request`;
    }
    showWizardError(root, [normalized.message || "The request could not be saved."]);
    toastError(normalized);
  }
}

async function submitDraft(id, root) {
  const ok = await confirmDialog({
    title: "Submit this draft?",
    desc: "It gets a reference number and the team is notified. Nothing is launched and nothing is charged.",
    confirmLabel: "Submit for review"
  });
  if (!ok) return;
  try {
    const { data, error } = await sb
      .from("marketing_requests")
      .update({ status: "submitted" })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    view.requests = view.requests.map((row) => (row.id === id ? data : row));
    paint(root);
    toast({ title: "Submitted", message: `Reference ${data.reference || ""}` }, { tone: "success" });
  } catch (error) {
    toastError(normalizeError(error));
  }
}

function openUpdateDialog(row, root) {
  openModal({
    title: `Extra information for ${row.reference || "the request"}`,
    size: "md",
    body: `<div class="field"><label class="field-label" for="extra">What the team asked for</label>
      <textarea class="textarea" id="extra" rows="4" placeholder="Add the details here"></textarea></div>
      <div id="extra-error"></div>`,
    footer: `<button class="btn btn-ghost btn-sm" data-close>Cancel</button>
             <button class="btn btn-primary btn-sm" id="extra-save">Send to the team</button>`,
    onMount: ({ close }) => {
      qs("[data-close]").addEventListener("click", close);
      qs("#extra-save").addEventListener("click", async () => {
        const body = qs("#extra").value.trim();
        if (body.length < 4) {
          safeSet("#extra-error", `<div class="alert alert-warning"><span>Write the information first.</span></div>`);
          return;
        }
        try {
          const details = { ...(row.details || {}), customerReply: body, customerRepliedAt: new Date().toISOString() };
          const { data, error } = await sb
            .from("marketing_requests")
            .update({ details })
            .eq("id", row.id)
            .select("*")
            .single();
          if (error) throw error;
          await sb.from("marketing_request_events").insert({
            request_id: row.id,
            actor_id: state.user.id,
            kind: "note",
            body,
            internal: false
          });
          try {
            await sb.rpc("notify_admins", {
              p_title: "Extra information received",
              p_body: `${row.reference || "A request"} — the customer replied.`,
              p_link: "/admin/?view=marketing"
            });
          } catch {
            /* not fatal */
          }
          view.requests = view.requests.map((entry) => (entry.id === row.id ? data : entry));
          close();
          paint(root);
          toast({ title: "Sent", message: "The team has your reply." }, { tone: "success" });
        } catch (error) {
          safeSet("#extra-error", `<div class="alert alert-warning"><span>${esc(normalizeError(error).message)}</span></div>`);
        }
      });
    }
  });
}
