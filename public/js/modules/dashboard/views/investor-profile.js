/* ==========================================================================
   Shinzora — investor profile (phase 2)
   The investor's own profile. Visibility decides who may find it:
   public (anyone signed in), connections (accepted connections only), or
   private (nobody). Saved straight to investor_profiles under row-level
   security, which only lets an investor write their own row.
   ========================================================================== */

import { qs, esc, on } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { pageHead, skeletonView, setupNotice, chip } from "../components.js";
import { toast, toastError } from "../../../ui/toast.js";
import { INDUSTRIES, investorUid, loadProfile, settle } from "./investor-kit.js";

let host = null;

const VISIBILITY = [
  { id: "public", label: "Public", desc: "Any investor can find your profile and send a connection request. Founders can pitch you." },
  { id: "connections", label: "Connections only", desc: "Only investors you are connected with can see your profile. Founders cannot pitch you." },
  { id: "private", label: "Private", desc: "Nobody can see your profile. You can still use the portal to browse." }
];

const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export default async function render(root) {
  host = root;
  host.innerHTML = skeletonView(3);
  const uid = investorUid();
  const [profile] = await Promise.all([settle(() => loadProfile(uid))]);
  if (!profile.ok) {
    host.innerHTML = `${pageHead({ title: "Profile", desc: "Your investor profile." })}${setupNotice(profile.error, "Profile")}`;
    return;
  }
  paint(profile.value);
}

function paint(p) {
  const v = p || {};
  const picked = new Set(v.preferred_industries || []);
  host.innerHTML = `<div class="investor-view inv-page">
    ${pageHead({
      title: "Investor profile",
      desc: "How founders and other investors see you. You decide who can find it.",
      badge: chip(v.visibility ? `Visible to: ${v.visibility}` : "Not set up", { tone: v.visibility === "public" ? "ok" : "neutral", iconName: "eye" })
    })}
    <form class="card card-pad-lg inv-form inv-rise" id="inv-profile-form" novalidate>
      <div class="inv-form-grid">
        <label class="inv-field">
          <span class="field-label">Display name</span>
          <input class="input" name="display_name" required minlength="2" maxlength="80" value="${esc(v.display_name || state.profile?.full_name || "")}" />
        </label>
        <label class="inv-field">
          <span class="field-label">Headline</span>
          <input class="input" name="headline" maxlength="140" placeholder="e.g. Seed-stage fintech investor, Mumbai" value="${esc(v.headline || "")}" />
        </label>
      </div>
      <label class="inv-field">
        <span class="field-label">About you</span>
        <textarea class="input" name="bio" rows="4" maxlength="1200" placeholder="How you invest, what you look for, how you work with founders">${esc(v.bio || "")}</textarea>
      </label>
      <fieldset class="inv-field">
        <legend class="field-label">Preferred industries</legend>
        <div class="inv-checks">
          ${INDUSTRIES.map((i) => `<label class="inv-check"><input type="checkbox" name="industries" value="${esc(i)}" ${picked.has(i) ? "checked" : ""} /><span>${esc(i)}</span></label>`).join("")}
        </div>
        <p class="field-hint">Used to recommend businesses to you and to show your focus to others.</p>
      </fieldset>
      <div class="inv-form-grid">
        <label class="inv-field">
          <span class="field-label">Interests</span>
          <input class="input" name="interests" maxlength="400" placeholder="Comma separated, e.g. climate, edtech, D2C" value="${esc((v.interests || []).join(", "))}" />
        </label>
        <label class="inv-field">
          <span class="field-label">Portfolio</span>
          <textarea class="input" name="portfolio" rows="3" maxlength="1200" placeholder="Companies you have backed, if you want to share them">${esc(v.portfolio || "")}</textarea>
        </label>
      </div>
      <fieldset class="inv-field">
        <legend class="field-label">Who can see this profile</legend>
        <div class="inv-visibility">
          ${VISIBILITY.map((o) => `<label class="inv-vis ${(v.visibility || "private") === o.id ? "is-on" : ""}">
            <input type="radio" name="visibility" value="${o.id}" ${(v.visibility || "private") === o.id ? "checked" : ""} />
            <span><strong>${o.label}</strong><span class="field-hint">${esc(o.desc)}</span></span>
          </label>`).join("")}
        </div>
      </fieldset>
      <p class="field-hint inv-note">${icon("image", { size: 12 })} Your photo is your account picture. Change it in <a href="/app/?view=settings">Settings</a>.</p>
      <div class="inv-form-actions">
        <p class="field-hint" id="inv-profile-status" role="status"></p>
        <button class="btn btn-primary" type="submit" id="inv-profile-save">${icon("check", { size: 14 })} Save profile</button>
      </div>
    </form>
  </div>`;

  const form = qs("#inv-profile-form", host);
  on(form, "change", (event) => {
    if (event.target.name !== "visibility") return;
    qsAll(form, ".inv-vis").forEach((label) => label.classList.toggle("is-on", label.querySelector("input")?.checked));
  });
  on(form, "submit", (event) => {
    event.preventDefault();
    save(form);
  });
}

function qsAll(root, sel) {
  return [...root.querySelectorAll(sel)];
}

async function save(form) {
  const status = qs("#inv-profile-status", host);
  const button = qs("#inv-profile-save", host);
  const f = new FormData(form);
  const display = String(f.get("display_name") || "").trim();
  const interests = list(f.get("interests"));
  const industries = f.getAll("industries");

  const problem =
    display.length < 2 ? "Enter a display name of at least 2 characters."
    : interests.length > 12 ? "Keep interests to 12 or fewer."
    : interests.some((i) => i.length > 40) ? "Each interest must be 40 characters or fewer."
    : industries.length > 8 ? "Choose up to 8 preferred industries."
    : "";
  if (problem) {
    status.textContent = problem;
    return;
  }

  const row = {
    user_id: investorUid(),
    display_name: display,
    headline: String(f.get("headline") || "").trim() || null,
    bio: String(f.get("bio") || "").trim() || null,
    portfolio: String(f.get("portfolio") || "").trim() || null,
    interests,
    preferred_industries: industries,
    visibility: String(f.get("visibility") || "private"),
    updated_at: new Date().toISOString()
  };

  button.disabled = true;
  status.textContent = "Saving…";
  try {
    const { data, error } = await sb.from("investor_profiles").upsert(row, { onConflict: "user_id" }).select("*").single();
    if (error) throw normalizeError(error);
    status.textContent = "Saved.";
    toast({ title: "Profile saved", message: `Visible to: ${data.visibility}` }, { tone: "success" });
    paint(data);
  } catch (error) {
    button.disabled = false;
    status.textContent = "";
    toastError(error);
  }
}
