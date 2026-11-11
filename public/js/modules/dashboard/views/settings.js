/* ==========================================================================
   Shinzora — Settings
   Profile, business profile, security, preferences, integrations and data
   controls. Every save writes to Postgres and reports exactly what changed.
   ========================================================================== */

import { qs, qsa, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { date, timeAgo } from "../../../lib/format.js";
import { sb, normalizeError, uploadPublic } from "../../../lib/supabase.js";
import { api, runtimeConfig } from "../../../lib/api.js";
import { state, loadIdentity, plan, aiCredits } from "../../../lib/store.js";
import { BUSINESS_CATEGORIES } from "../../../config/env.js";
import { updateProfile, updateBusiness, logActivity } from "../data.js";
import { pageHead, setupNotice, skeletonView, statusBadge } from "../components.js";
import { confirmDialog } from "../../../ui/modal.js";
import { toast, toastError } from "../../../ui/toast.js";
import { validateForm, paintErrors, rules } from "../../../lib/validate.js";
import { applyTheme, saveThemeToProfile, currentTheme, themePicker } from "../../../ui/theme.js";
import { avatarMarkup } from "../../../lib/avatar.js";

const SECTIONS = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "business", label: "Business", icon: "building-2" },
  { id: "security", label: "Security", icon: "shield-check" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "preferences", label: "Preferences", icon: "sliders-horizontal" },
  { id: "referrals", label: "Referrals", icon: "gift" },
  { id: "integrations", label: "Integrations", icon: "plug-zap" },
  { id: "data", label: "Data", icon: "database" }
];

/* The social platforms a business profile offers. Keys are what the panel
   labels; values are stored in `businesses.socials` as { key: url }. */
const SOCIAL_FIELDS = [
  { key: "instagram", label: "Instagram" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "x", label: "X (Twitter)" },
  { key: "facebook", label: "Facebook" },
  { key: "youtube", label: "YouTube" },
  { key: "github", label: "GitHub" }
];

const businessSocials = () => {
  const socials = state.business?.socials;
  return socials && typeof socials === "object" && !Array.isArray(socials) ? socials : {};
};

let section = "profile";

export default async function render(root) {
  root.innerHTML = skeletonView(3);
  const runtime = await runtimeConfig();

  root.innerHTML = `
    ${pageHead({ title: "Settings", desc: "Account, business profile, security and integrations for this workspace." })}
    <div class="settings-layout">
      <div class="card" style="align-self:start">
        <nav class="settings-nav" id="settings-nav">
          ${SECTIONS.map(
            (item) => `<button class="settings-nav-item ${item.id === section ? "is-active" : ""}" data-section="${item.id}">
              ${icon(item.icon, { size: 15 })}<span>${esc(item.label)}</span>
            </button>`
          ).join("")}
        </nav>
      </div>
      <div id="settings-body"></div>
    </div>`;

  on(qs("#settings-nav"), "click", (event) => {
    const button = event.target.closest("[data-section]");
    if (!button) return;
    section = button.getAttribute("data-section");
    qsa("#settings-nav .settings-nav-item").forEach((node) => node.classList.toggle("is-active", node === button));
    paint();
    history.replaceState({}, "", `/app/?view=settings&section=${section}`);
  });

  paint();

  function paint() {
    const body = qs("#settings-body");
    if (section === "profile") body.innerHTML = profileSection();
    if (section === "business") body.innerHTML = businessSection();
    if (section === "security") body.innerHTML = securitySection();
    if (section === "appearance") body.innerHTML = appearanceSection();
    if (section === "preferences") body.innerHTML = preferencesSection();
    if (section === "referrals") body.innerHTML = referralSection();
    if (section === "integrations") body.innerHTML = integrationsSection(runtime);
    if (section === "data") body.innerHTML = dataSection();

    if (section === "profile") bindProfile();
    if (section === "business") {
      bindBusiness();
      bindLogo();
    }
    if (section === "security") bindSecurity();
    if (section === "appearance") bindAppearance();
    if (section === "preferences") bindPreferences();
    if (section === "referrals") bindReferrals();
    if (section === "data") bindData();
  }

  /* ------------------------------------------------------------- profile */
  function profileSection() {
    const profile = state.profile || {};
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-title">Your profile</div><div class="card-sub">Shown across your workspace and on your storefront footer.</div></div>
        <span class="badge badge-neutral">Member since ${esc(date(profile.created_at || state.user?.created_at))}</span>
      </div>
      <div class="card-body">
        <form class="stack gap-4" id="profile-form" novalidate>
          <div class="row gap-4 wrap" style="align-items:center">
            <span id="avatar-slot">${avatarMarkup({ name: profile.full_name, email: state.user?.email, avatarUrl: profile.avatar_url, size: "xl" })}</span>
            <div class="grow">
              <label class="field-label" for="avatar">Profile photo</label>
              <input class="input" id="avatar" type="file" accept="image/png,image/jpeg,image/webp" />
              <div class="field-hint">PNG, JPEG or WebP under 2 MB. The photo replaces your initials everywhere — here, the topbar, the admin console and the team directory.</div>
              <div class="row gap-2" style="margin-top:var(--s-2)">
                <button class="btn btn-ghost btn-sm" type="button" id="avatar-clear" ${profile.avatar_url ? "" : "disabled"}>${icon("trash-2", { size: 13 })}Remove photo</button>
              </div>
              <div id="avatar-status"></div>
            </div>
          </div>
          <div class="field" data-field="full_name">
            <label class="field-label" for="full_name">Full name</label>
            <input class="input" id="full_name" name="full_name" value="${esc(profile.full_name || "")}" autocomplete="name" />
            <div class="field-error"></div>
          </div>
          <div class="field" data-field="username">
            <label class="field-label" for="username">Handle</label>
            <div class="handle-wrap">
              <span class="handle-prefix">@</span>
              <input class="input" id="username" name="username" maxlength="30" autocomplete="off"
                     spellcheck="false" value="${esc(profile.username || "")}" />
            </div>
            <div class="field-hint" id="username-note">People find and connect with you by this handle. Lowercase letters, numbers, dots and underscores.</div>
            <div class="field-error"></div>
          </div>
          <div class="field" data-field="account_type">
            <label class="field-label" for="account_type">How you use Shinzora</label>
            <select class="input" id="account_type" name="account_type">
              <option value="owner" ${profile.account_type !== "agent" ? "selected" : ""}>I run a business</option>
              <option value="agent" ${profile.account_type === "agent" ? "selected" : ""}>I work as an agent</option>
            </select>
            <div class="field-hint">This decides which half of the marketplace the dashboard opens on. You can switch at any time.</div>
            <div class="field-error"></div>
          </div>
          <div class="field" data-field="phone">
            <label class="field-label" for="phone">Phone</label>
            <input class="input" id="phone" name="phone" value="${esc(profile.phone || "")}" placeholder="+91" autocomplete="tel" />
            <div class="field-error"></div>
          </div>
          <div class="field">
            <label class="field-label" for="email">Email</label>
            <input class="input" id="email" value="${esc(state.user?.email || "")}" disabled />
            <div class="field-hint">Email changes are handled by support to keep the account verified.</div>
          </div>
          <div class="row gap-2">
            <button class="btn btn-primary" type="submit" id="save-profile">Save profile</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  function bindProfile() {
    qs("#profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = {
        full_name: form.full_name.value.trim(),
        phone: form.phone.value.trim()
      };
      const { valid, errors } = validateForm(values, {
        full_name: [rules.required, rules.min(2)],
        phone: [rules.phone]
      });
      paintErrors(form, errors);
      if (!valid) return;
      const button = qs("#save-profile");
      button.disabled = true;
      try {
        await updateProfile(values);

        /* The handle and account type are not plain columns the browser may
           write: the first is unique across every account and the second
           decides which side of the marketplace you are on. Both go through
           the RPCs that enforce that. */
        const wantedHandle = form.username.value.trim().toLowerCase().replace(/^@+/, "");
        if (wantedHandle && wantedHandle !== (state.profile?.username || "")) {
          const { error } = await sb.rpc("set_username", { p_username: wantedHandle });
          if (error) throw normalizeError(error);
        }
        if (form.account_type.value !== (state.profile?.account_type || "owner")) {
          const { error } = await sb.rpc("set_account_type", { p_type: form.account_type.value });
          if (error) throw normalizeError(error);
        }

        await logActivity("profile_updated", "profile", state.user.id, { fields: Object.keys(values) });
        await loadIdentity({ force: true });
        toast({ title: "Profile saved" }, { tone: "success" });
      } catch (error) {
        toastError(normalizeError(error));
      } finally {
        button.disabled = false;
      }
    });

    /* The photo goes into the `avatars` bucket under the caller's own folder — the
       storage policy only accepts a write there — and the public URL is saved on
       the profile. Every screen reads that one column, so one upload changes the
       photo in the topbar, the admin console and the team directory. */
    const sayAvatar = (html) => {
      const host = qs("#avatar-status");
      if (host) host.innerHTML = html;
    };

    const uploadAvatar = async (file) => {
      if (!/^image\//.test(file.type)) {
        sayAvatar(`<div class="alert alert-warning" style="margin-top:var(--s-2)"><span>That file is not an image. Use PNG, JPEG or WebP.</span></div>`);
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        sayAvatar(`<div class="alert alert-warning" style="margin-top:var(--s-2)"><span>That photo is over 2 MB. Choose a smaller one.</span></div>`);
        return;
      }
      const slot = qs("#avatar-slot");
      sayAvatar(`<p class="field-hint" style="margin-top:var(--s-2)">Uploading…</p>`);
      try {
        const extension = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
        const path = `${state.user.id}/avatar-${Date.now()}.${extension}`;
        const { error } = await sb.storage.from("avatars").upload(path, file, { upsert: true, contentType: file.type });
        if (error) throw normalizeError(error);
        const { data } = sb.storage.from("avatars").getPublicUrl(path);
        await updateProfile({ avatar_url: data.publicUrl });
        await loadIdentity({ force: true });
        /* Painted immediately as well as after the reload: the round trip to
           loadIdentity() is a second of looking at the old picture. */
        if (slot) slot.innerHTML = avatarMarkup({ name: state.profile?.full_name, email: state.user?.email, avatarUrl: data.publicUrl, size: "xl" });
        const clear = qs("#avatar-clear");
        if (clear) clear.disabled = false;
        sayAvatar(`<div class="alert alert-ok" style="margin-top:var(--s-2)"><span>Photo saved. It now shows wherever your name did.</span></div>`);
        toast({ title: "Photo updated" }, { tone: "success" });
        paint();
      } catch (error) {
        const normalized = normalizeError(error);
        sayAvatar(`<div class="alert alert-warning" style="margin-top:var(--s-2)"><span>${esc(
          /bucket|not found/i.test(normalized.message)
            ? "The avatars storage bucket is not provisioned. Apply migration 0003 and retry."
            : normalized.message
        )}</span></div>`);
        toastError(normalized);
      }
    };

    qs("#avatar")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (file) await uploadAvatar(file);
      event.target.value = "";
    });

    qs("#avatar-clear")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await updateProfile({ avatar_url: null });
        await loadIdentity({ force: true });
        toast({ title: "Photo removed", message: "Your initials are shown again." }, { tone: "success" });
        paint();
      } catch (error) {
        toastError(normalizeError(error));
        event.currentTarget.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ business */
  function businessSection() {
    const business = state.business || {};
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-title">Business logo</div>
          <div class="card-sub">Used on generated sites, invoices and your storefront.</div></div>
        <span class="badge ${business.logo_url ? "badge-ok" : "badge-warn"}">${business.logo_url ? "Uploaded" : "Not set"}</span>
      </div>
      <div class="card-body stack gap-3">
        <div class="row gap-3" style="align-items:center">
          <div class="logo-preview" id="logo-preview" style="width:72px;height:72px;border-radius:14px;border:1px solid var(--line);display:grid;place-items:center;overflow:hidden;background:rgba(255,255,255,.03)">
            ${
              business.logo_url
                ? `<img src="${esc(business.logo_url)}" alt="Current business logo" style="width:100%;height:100%;object-fit:contain" />`
                : icon("image", { size: 20 })
            }
          </div>
          <div class="stack gap-2">
            <input type="file" id="logo-input" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden />
            <div class="row gap-2 wrap">
              <button class="btn btn-secondary btn-sm" id="logo-pick" type="button">${icon("upload", { size: 13 })}${business.logo_url ? "Replace logo" : "Upload logo"}</button>
              <button class="btn btn-ghost btn-sm" id="logo-clear" type="button" ${business.logo_url ? "" : "disabled"}>${icon("trash-2", { size: 13 })}Remove</button>
            </div>
            <div class="field-hint">PNG, JPEG, WebP or SVG · up to 2 MB · stored privately in your own folder.</div>
          </div>
        </div>
        <div id="logo-status"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">Business profile</div><div class="card-sub">The AI reads this before generating anything.</div></div>
        <span class="badge ${business.name ? "badge-ok" : "badge-warn"}">${business.name ? "Complete" : "Incomplete"}</span>
      </div>
      <div class="card-body">
        <form class="stack gap-4" id="business-form" novalidate>
          <div class="field" data-field="name">
            <label class="field-label" for="biz-name">Business name</label>
            <input class="input" id="biz-name" name="name" value="${esc(business.name || "")}" />
            <div class="field-error"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label" for="biz-category">Category</label>
              <select class="select" id="biz-category" name="category">
                <option value="">Select a category</option>
                ${BUSINESS_CATEGORIES.map(
                  (category) => `<option value="${esc(category)}" ${business.category === category ? "selected" : ""}>${esc(category)}</option>`
                ).join("")}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="biz-location">Location</label>
              <input class="input" id="biz-location" name="location" value="${esc(business.location || "")}" placeholder="City, state" />
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="biz-description">What the business does</label>
            <textarea class="textarea" id="biz-description" name="description" rows="4">${esc(business.description || "")}</textarea>
            <div class="field-hint">Two or three sentences is enough — be specific about what you sell and to whom.</div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label" for="biz-audience">Target audience</label>
              <input class="input" id="biz-audience" name="target_audience" value="${esc(business.target_audience || "")}" />
            </div>
            <div class="field">
              <label class="field-label" for="biz-website">Existing website</label>
              <input class="input" id="biz-website" name="website_url" value="${esc(business.website_url || "")}" placeholder="https://" />
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label class="field-label" for="biz-phone">Business phone</label>
              <input class="input" id="biz-phone" name="phone" value="${esc(business.phone || "")}" />
            </div>
            <div class="field">
              <label class="field-label" for="biz-email">Business email</label>
              <input class="input" id="biz-email" name="email" value="${esc(business.email || "")}" />
            </div>
          </div>

          <!-- A freelancer reading your pitch panel sees these, so they are
               grouped and labelled rather than mixed in with contact details. -->
          <div class="field">
            <span class="field-label">Social links</span>
            <p class="field-hint">Shown on your business card in the marketplace, next to the Pitch button.</p>
          </div>
          <div class="grid-2">
            ${SOCIAL_FIELDS.map(
              (social) => `<div class="field">
                <label class="field-label" for="biz-${social.key}">${esc(social.label)}</label>
                <input class="input" id="biz-${social.key}" name="social_${social.key}" type="url"
                  value="${esc(businessSocials()[social.key] || "")}" placeholder="https://" />
              </div>`
            ).join("")}
          </div>
          <div class="row gap-2">
            <button class="btn btn-primary" type="submit" id="save-business">Save business</button>
            <a class="btn btn-ghost" href="/onboarding/">Re-run onboarding</a>
          </div>
        </form>
      </div>
    </div>`;
  }

  function bindLogo() {
    const input = qs("#logo-input");
    const pick = qs("#logo-pick");
    const clear = qs("#logo-clear");
    if (!input || !pick) return;

    const say = (html) => {
      const host = qs("#logo-status");
      if (host) host.innerHTML = html;
    };

    pick.addEventListener("click", () => input.click());

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        say(`<div class="alert alert-warning"><span>That image is over 2 MB. Choose a smaller file.</span></div>`);
        input.value = "";
        return;
      }
      if (!/^image\//.test(file.type)) {
        say(`<div class="alert alert-warning"><span>Only images can be used as a logo.</span></div>`);
        input.value = "";
        return;
      }
      pick.disabled = true;
      say(`<p class="field-hint">Uploading…</p>`);
      try {
        const url = await uploadPublic("brand-assets", state.user.id, file, "logo");
        /* A logo attaches to a business row, and the row cannot exist without a
           name. If the profile has not been saved yet, the name typed in the form
           below is used, so uploading a logo first is not a dead end. */
        const patch = { logo_url: url };
        if (!state.business?.id) {
          const typed = qs("#biz-name")?.value?.trim();
          if (typed) patch.name = typed;
        }
        await updateBusiness(patch);
        await loadIdentity({ force: true });
        say(`<div class="alert alert-ok"><span>Logo saved to your business profile.</span></div>`);
        toast({ title: "Logo saved" }, { tone: "success" });
        paint();
      } catch (error) {
        const normalized = normalizeError(error);
        say(
          `<div class="alert alert-warning"><span>${esc(
            /bucket|not found/i.test(normalized.message)
              ? "The brand-assets storage bucket is not provisioned. Apply migration 0003 and retry."
              : normalized.message
          )}</span></div>`
        );
      } finally {
        pick.disabled = false;
        input.value = "";
      }
    });

    clear?.addEventListener("click", async () => {
      clear.disabled = true;
      try {
        await updateBusiness({ logo_url: null });
        await loadIdentity({ force: true });
        toast({ title: "Logo removed" }, { tone: "success" });
        paint();
      } catch (error) {
        say(`<div class="alert alert-warning"><span>${esc(normalizeError(error).message)}</span></div>`);
        clear.disabled = false;
      }
    });
  }

  function bindBusiness() {
    qs("#business-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const raw = Object.fromEntries(new FormData(form).entries());
      const socialRules = {};
      SOCIAL_FIELDS.forEach((social) => {
        socialRules[`social_${social.key}`] = [rules.url];
      });
      const { valid, errors } = validateForm(raw, {
        name: [rules.required, rules.min(2)],
        website_url: [rules.url],
        ...socialRules
      });
      /* Social inputs are not columns: they collect into the `socials` jsonb,
         dropping anything left blank so the panel never renders an empty link. */
      const socials = {};
      SOCIAL_FIELDS.forEach((social) => {
        const value = String(raw[`social_${social.key}`] || "").trim();
        if (value) socials[social.key] = value;
        delete raw[`social_${social.key}`];
      });
      const values = { ...raw, socials };
      paintErrors(form, errors);
      if (!valid) return;
      const button = qs("#save-business");
      button.disabled = true;
      try {
        await updateBusiness(values);
        await loadIdentity({ force: true });
        toast({ title: "Business saved", message: "The AI will use this on the next generation." }, { tone: "success" });
      } catch (error) {
        toastError(normalizeError(error));
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ security */
  function securitySection() {
    const lastSignIn = state.profile?.last_sign_in_at || state.user?.last_sign_in_at;
    return `<div class="stack gap-4">
      <div class="card">
        <div class="card-head"><div><div class="card-title">Password</div><div class="card-sub">Minimum 8 characters. You stay signed in on this device.</div></div></div>
        <div class="card-body">
          <form class="stack gap-4" id="password-form" novalidate>
            <div class="field" data-field="password">
              <label class="field-label" for="new-password">New password</label>
              <input class="input" id="new-password" name="password" type="password" autocomplete="new-password" />
              <div class="field-error"></div>
            </div>
            <div class="field" data-field="confirm">
              <label class="field-label" for="confirm-password">Confirm password</label>
              <input class="input" id="confirm-password" name="confirm" type="password" autocomplete="new-password" />
              <div class="field-error"></div>
            </div>
            <button class="btn btn-primary" type="submit" id="save-password">Update password</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Session</div></div>
        <div class="card-body">
          <dl>
            <div class="kv"><dt>Signed in as</dt><dd>${esc(state.user?.email || "")}</dd></div>
            <div class="kv"><dt>Last sign-in</dt><dd>${lastSignIn ? esc(timeAgo(lastSignIn)) : "—"}</dd></div>
            <div class="kv"><dt>Email verified</dt><dd>${state.user?.email_confirmed_at ? `<span class="badge badge-ok">Verified</span>` : `<span class="badge badge-warn">Pending</span>`}</dd></div>
            <div class="kv"><dt>Role</dt><dd>${esc(state.profile?.role || "owner")}</dd></div>
          </dl>
          <button class="btn btn-secondary btn-sm" style="margin-top:12px" id="signout-others">Sign out of all devices</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Two-factor authentication</div></div>
        <div class="card-body">
          <p class="muted" style="font-size:var(--fs-xs);line-height:1.65">
            Email verification is required for every account. TOTP enrolment is available once an authenticator factor is
            enabled on the Supabase project; until then the button below reports the server's response rather than
            pretending to be set up.
          </p>
          <button class="btn btn-secondary btn-sm" style="margin-top:10px" id="enrol-2fa">${icon("smartphone", { size: 14 })}Check availability</button>
        </div>
      </div>
    </div>`;
  }

  function bindSecurity() {
    qs("#password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const password = form.password.value;
      const confirm = form.confirm.value;
      qsa(".field", form).forEach((field) => field.classList.remove("invalid"));

      if (password.length < 8) {
        const field = qs('[data-field="password"]', form);
        field.classList.add("invalid");
        qs(".field-error", field).textContent = "Use at least 8 characters.";
        return;
      }
      if (password !== confirm) {
        const field = qs('[data-field="confirm"]', form);
        field.classList.add("invalid");
        qs(".field-error", field).textContent = "Passwords do not match.";
        return;
      }
      const button = qs("#save-password");
      button.disabled = true;
      try {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw normalizeError(error);
        form.reset();
        await logActivity("password_updated", "profile", state.user.id, {});
        toast({ title: "Password updated" }, { tone: "success" });
      } catch (error) {
        toastError(normalizeError(error));
      } finally {
        button.disabled = false;
      }
    });

    qs("#signout-others").addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Sign out of all devices?",
        desc: "Every session, including this one, will end and you will need to sign in again.",
        confirmLabel: "Sign out everywhere",
        tone: "danger"
      });
      if (!ok) return;
      try {
        const { error } = await sb.auth.signOut({ scope: "global" });
        if (error) throw normalizeError(error);
        location.href = "/auth/login/";
      } catch (error) {
        toastError(normalizeError(error));
      }
    });

    qs("#enrol-2fa").addEventListener("click", async () => {
      try {
        const { data, error } = await sb.auth.mfa.listFactors();
        if (error) throw normalizeError(error);
        const factors = data?.all || data?.totp || [];
        toast({
          title: factors.length ? `${factors.length} factor(s) enrolled` : "No factors enrolled",
          message: factors.length
            ? "Manage factors through your authenticator app."
            : "TOTP enrolment is not enabled on this Supabase project yet. Enable MFA in the dashboard to turn it on.",
          duration: 8000
        });
      } catch (error) {
        toastError(normalizeError(error));
      }
    });
  }

  /* ----------------------------------------------------------- appearance */
  function appearanceSection() {
    const active = currentTheme();
    return `<div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Theme</div>
          <div class="card-sub">Applies immediately, on this device and the next one you sign in on.</div>
        </div>
      </div>
      <div class="card-body">
        ${themePicker(active)}
        <div class="alert alert-info" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
          ${icon("info", { size: 14 })}
          <span>Blossom and Daylight are both light, but they are not the same white: Blossom is a clean page with pink in the rules, Daylight is warm paper with no pure white anywhere, which is the one that stops a light theme hurting after an hour. All three pass the same contrast checks, and your choice follows the account to other devices.</span>
        </div>
      </div>
    </div>`;
  }

  function bindAppearance() {
    delegate(qs("#settings-body"), "click", "[data-theme-choice]", async (event, button) => {
      const id = button.getAttribute("data-theme-choice");
      applyTheme(id);
      qsa("[data-theme-choice]").forEach((node) =>
        node.setAttribute("aria-pressed", String(node.getAttribute("data-theme-choice") === id))
      );
      const saved = await saveThemeToProfile(id);
      if (saved?.error) {
        toast({
          title: "Theme applied here",
          message: "It could not be saved to your account, so other devices will keep the old one.",
          tone: "warning"
        });
        return;
      }
      toast({ title: "Theme saved" }, { tone: "success", duration: 2000 });
    });
  }

  /* -------------------------------------------------------------- referrals */
  function referralSection() {
    return `<div class="stack gap-4">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Invite a member</div>
            <div class="card-sub">Both of you get 10 bonus AI credits a month for three months.</div>
          </div>
        </div>
        <div class="card-body" id="referral-body">
          <div class="dim" style="font-size:var(--fs-sm)">Loading your code…</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">Have a code?</div><div class="card-sub">One code per account, and it cannot be your own.</div></div></div>
        <div class="card-body">
          <form class="row gap-2 wrap" id="referral-redeem-form">
            <label class="sr-only" for="referral-code-input">Referral code</label>
            <input class="input grow" id="referral-code-input" placeholder="SHZ-XXXXXX" autocomplete="off" spellcheck="false" style="text-transform:uppercase" />
            <button class="btn btn-primary" type="submit" id="referral-redeem-submit">Redeem</button>
          </form>
          <div class="field-hint" id="referral-redeem-note">Bonus credits are added to your monthly AI allowance.</div>
        </div>
      </div>
    </div>`;
  }

  async function bindReferrals() {
    const body = qs("#referral-body");
    const paint = async () => {
      try {
        const { data, error } = await sb.rpc("referral_summary");
        if (error) throw normalizeError(error);
        const friends = Array.isArray(data?.friends) ? data.friends : [];
        body.innerHTML = `
          <div class="stack gap-3">
            <div class="row gap-2 wrap">
              <div class="grow">
                <div class="field-label">Your code</div>
                <div class="mono" id="referral-code" style="font-size:1.15rem;letter-spacing:0.12em;color:var(--text)">${esc(data?.code || "—")}</div>
              </div>
              <button class="btn btn-secondary btn-sm" type="button" id="referral-copy">${icon("copy", { size: 14 })}Copy</button>
            </div>
            <div class="row gap-4 wrap" style="font-size:var(--fs-xs)">
              <div><span class="dim">Invited</span> <strong>${Number(data?.invited || 0)}</strong></div>
              <div><span class="dim">Bonus credits / month</span> <strong>${Number(data?.bonusCredits || 0)}</strong></div>
              <div><span class="dim">Your plan allowance</span> <strong>${aiCredits().limit}</strong></div>
            </div>
            ${
              friends.length
                ? `<div class="stack gap-2">${friends
                    .map(
                      (friend) => `<div class="row between gap-3" style="font-size:var(--fs-xs);padding:8px 0;border-bottom:1px solid var(--line)">
                        <span>${esc(friend.name)}${friend.username ? ` <span class="dim mono">@${esc(friend.username)}</span>` : ""}</span>
                        <span class="dim">${Number(friend.monthsGranted || 0)} of ${Number(friend.monthsTotal || 3)} months credited</span>
                      </div>`
                    )
                    .join("")}</div>`
                : `<div class="dim" style="font-size:var(--fs-xs)">Nobody has used your code yet.</div>`
            }
            ${
              data?.redeemed
                ? `<div class="alert alert-ok" style="font-size:var(--fs-2xs)">${icon("check", { size: 14 })}<span>You redeemed a code. Bonus months left: ${Math.max(
                    0,
                    Number(data.redeemed.months_total || 0) - Number(data.redeemed.months_granted || 0)
                  )}.</span></div>`
                : ""
            }
          </div>`;
        qs("#referral-copy")?.addEventListener("click", async () => {
          const code = data?.code || "";
          try {
            await navigator.clipboard.writeText(code);
            toast({ title: "Code copied" }, { tone: "success", duration: 1800 });
          } catch {
            toast({ title: "Copy failed", message: code, tone: "warning" });
          }
        });
      } catch (error) {
        body.innerHTML = `<div class="dim" style="font-size:var(--fs-sm)">${esc(error.message || "Referrals are unavailable right now.")}</div>`;
      }
    };
    await paint();

    on(qs("#referral-redeem-form"), "submit", async (event) => {
      event.preventDefault();
      const input = qs("#referral-code-input");
      const button = qs("#referral-redeem-submit");
      const note = qs("#referral-redeem-note");
      const code = input.value.trim();
      if (!code) return;
      button.disabled = true;
      note.textContent = "Redeeming…";
      try {
        const { data, error } = await sb.rpc("referral_redeem", { p_code: code });
        if (error) throw normalizeError(error);
        note.innerHTML = `Code accepted. <strong>${Number(data?.bonusCredits || 10)}</strong> bonus AI credits are on your account, and ${
          Number(data?.monthsLeft || 0)
        } more month(s) will be added automatically.`;
        input.value = "";
        await loadIdentity();
        await paint();
        toast({ title: "Referral accepted" }, { tone: "success" });
      } catch (error) {
        note.textContent = error.message || "That code could not be redeemed.";
      } finally {
        button.disabled = false;
      }
    });
  }

  /* --------------------------------------------------------- preferences */
  function preferencesSection() {
    const prefs = readPrefs();
    const rows = [
      { id: "email_generation", label: "AI generation finished", desc: "When a site or app generation completes." },
      { id: "email_payment", label: "Payment verified", desc: "When a payment is confirmed or rejected." },
      { id: "email_domain", label: "Domain status", desc: "Registration and DNS changes." },
      { id: "email_admin", label: "Platform announcements", desc: "Maintenance, new features, policy changes." },
      { id: "weekly_digest", label: "Weekly business digest", desc: "Orders, stock and AI usage, once a week." }
    ];
    return `<div class="card">
      <div class="card-head"><div><div class="card-title">Notifications</div><div class="card-sub">In-app notifications are always on; these control email.</div></div></div>
      <div class="card-body">
        <div class="stack gap-3">
          ${rows
            .map(
              (row) => `<div class="row gap-3 setting-row">
                <div class="grow">
                  <div style="font-size:var(--fs-sm);color:var(--text)">${esc(row.label)}</div>
                  <div class="dim" style="font-size:var(--fs-2xs)">${esc(row.desc)}</div>
                </div>
                <label class="switch">
                  <input type="checkbox" data-pref="${row.id}" ${prefs[row.id] !== false ? "checked" : ""} />
                  <span class="switch-track"></span>
                </label>
              </div>`
            )
            .join("")}
        </div>
        <div class="alert alert-info" style="margin-top:var(--s-4);font-size:var(--fs-2xs)">
          ${icon("info", { size: 14 })}
          <span>Preferences are stored on this device and applied to in-app routing. Email delivery follows your plan's support tier.</span>
        </div>
      </div>
    </div>`;
  }

  function bindPreferences() {
    delegate(qs("#settings-body"), "change", "[data-pref]", (event, node) => {
      const prefs = readPrefs();
      prefs[node.getAttribute("data-pref")] = node.checked;
      localStorage.setItem("shinzora:prefs", JSON.stringify(prefs));
      toast({ title: "Preference saved" }, { tone: "success", duration: 2000 });
    });
  }

  /* -------------------------------------------------------- integrations */
  function integrationsSection(runtime) {
    const github = runtime?.integrations?.github_configured;
    const vercel = runtime?.integrations?.vercel_configured;
    return `<div class="stack gap-4">
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">GitHub</div><div class="card-sub">Push generated projects to a repository you own.</div></div>
          <span class="badge ${github ? "badge-ok" : "badge-neutral"}">${github ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          <p class="muted" style="font-size:var(--fs-xs);line-height:1.65">
            ${github
              ? "GitHub OAuth is configured server-side. Connect from any project's Publish panel to select or create a repository."
              : "Coming soon. Repository publishing is not enabled on this deployment yet."}
          </p>
          <a class="btn btn-secondary btn-sm" style="margin-top:10px" href="/app/?view=projects">Go to projects</a>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">Vercel</div><div class="card-sub">Deploy a project and track the real deployment status.</div></div>
          <span class="badge ${vercel ? "badge-ok" : "badge-neutral"}">${vercel ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          <p class="muted" style="font-size:var(--fs-xs);line-height:1.65">
            ${vercel
              ? "Vercel integration is configured. Deployments are only reported as successful when Vercel returns a READY state."
              : "Coming soon. Vercel deployment is not enabled on this deployment yet."}
          </p>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">Payments</div></div>
        <div class="card-body">
          <dl>
            <div class="kv"><dt>UPI QR</dt><dd>${runtime?.payments?.upi_configured ? `<span class="badge badge-ok">Configured</span>` : `<span class="badge badge-warn">Not configured</span>`}</dd></div>
            <div class="kv"><dt>Razorpay</dt><dd>${runtime?.payments?.razorpay_configured ? `<span class="badge badge-ok">Configured</span>` : `<span class="badge badge-neutral">Keys absent</span>`}</dd></div>
            <div class="kv"><dt>Domains</dt><dd>${runtime?.domains?.configured ? esc(runtime.domains.provider || "configured") : "No registrar connected"}</dd></div>
          </dl>
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------------- data */
  function dataSection() {
    const credits = aiCredits();
    return `<div class="stack gap-4">
      <div class="card">
        <div class="card-head"><div class="card-title">Your data</div></div>
        <div class="card-body">
          <dl>
            <div class="kv"><dt>Plan</dt><dd>${esc(plan().name)}</dd></div>
            <div class="kv"><dt>AI generations</dt><dd>${credits.used} / ${credits.limit}</dd></div>
            <div class="kv"><dt>Account created</dt><dd>${esc(date(state.user?.created_at))}</dd></div>
            <div class="kv"><dt>Storage used</dt><dd>Avatars and brand assets only</dd></div>
          </dl>
          <div class="row gap-2 wrap" style="margin-top:var(--s-4)">
            <button class="btn btn-secondary btn-sm" id="export-data">${icon("download", { size: 14 })}Export my data</button>
            <button class="btn btn-secondary btn-sm" id="request-deletion">${icon("trash-2", { size: 14 })}Request account deletion</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">Legal</div></div>
        <div class="card-body">
          <div class="stack gap-2" style="font-size:var(--fs-sm)">
            <a href="/legal/terms/">Terms of service</a>
            <a href="/legal/privacy/">Privacy policy</a>
            <a href="/legal/refunds/">Refund and cancellation policy</a>
            <a href="/legal/acceptable-use/">Acceptable use</a>
          </div>
        </div>
      </div>
    </div>`;
  }

  function bindData() {
    qs("#export-data")?.addEventListener("click", exportData);
    qs("#request-deletion")?.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Request account deletion?",
        desc: "A deletion request is logged for review. Your data stays until it is processed, and you will receive a confirmation.",
        confirmLabel: "Submit request",
        tone: "danger",
        requireText: "DELETE"
      });
      if (!ok) return;
      try {
        const { error } = await sb.from("service_requests").insert({
          owner_id: state.user.id,
          service_type: "account_deletion",
          title: "Account deletion request",
          details: `Requested from settings on ${new Date().toISOString()}`,
          status: "requested"
        });
        if (error) throw normalizeError(error);
        await logActivity("account_deletion_requested", "profile", state.user.id, {});
        toast({ title: "Deletion request submitted", message: "You will receive a confirmation before anything is removed." }, { tone: "success", duration: 8000 });
      } catch (error) {
        toastError(normalizeError(error));
      }
    });
  }

  async function exportData() {
    try {
      const [profile, business, projects, orders, products] = await Promise.all([
        sb.from("profiles").select("*").eq("id", state.user.id).maybeSingle(),
        sb.from("businesses").select("*").eq("owner_id", state.user.id),
        sb.from("projects").select("*").eq("owner_id", state.user.id),
        sb.from("store_orders").select("*").eq("owner_id", state.user.id),
        sb.from("store_products").select("*").eq("owner_id", state.user.id)
      ]);
      const payload = {
        exported_at: new Date().toISOString(),
        profile: profile.data || null,
        businesses: business.data || [],
        projects: projects.data || [],
        orders: orders.data || [],
        products: products.data || []
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `shinzora-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      toast({ title: "Export ready", message: "Downloaded as JSON." }, { tone: "success" });
    } catch (error) {
      toastError(normalizeError(error));
    }
  }

  void api;
  void statusBadge;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem("shinzora:prefs") || "{}");
  } catch {
    return {};
  }
}
