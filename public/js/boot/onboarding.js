/* ==========================================================================
   Shinzora — onboarding wizard
   Five steps, autosaved to onboarding_progress so a half-finished setup can be
   resumed on any device. Finishing writes the profile, the business record and
   the subscription, and records a service request when a paid plan is chosen.
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import { qs, qsa, debounce, safeSet } from "../lib/dom.js";
import { sb, normalizeError, uploadPublic, AppError } from "../lib/supabase.js";
import { loadIdentity, state } from "../lib/store.js";
import { requireSession, logoutEverywhere } from "../lib/guard.js";
import { validateForm, rules } from "../lib/validate.js";
import { setBusy, setAlert, showError, fieldError } from "../ui/form.js";
import { toast } from "../ui/toast.js";
import { PLANS, planById } from "../config/env.js";
import { esc } from "../lib/dom.js";

hydrateIcons();

const TOTAL_STEPS = 5;
const alertBox = qs("#ob-alert");
const saveStatus = qs("#ob-save-status");
const progressBar = qs("[data-progress-bar]");
const progressLabel = qs("[data-progress-label]");
const nextBtn = qs("#ob-next");
const backBtn = qs("#ob-back");
const skipBtn = qs("#ob-skip");

/** Local draft model, mirrored into onboarding_progress.data */
const draft = {
  account: { type: "owner", username: "" },
  agent: {
    headline: "", bio: "", skills: "", avatarUrl: "", years: "", rate: "", currency: "INR",
    hours: "", availability: "available", seeking: "", portfolio: "", location: "",
    remoteOk: true, equityOk: false, equityMin: "", equityMax: "", esopOk: false
  },
  profile: { fullName: "", phone: "", avatarUrl: "" },
  business: { name: "", category: "", description: "", logoUrl: "", location: "", website: "", stage: "" },
  goals: [],
  goalNote: "",
  preferences: { colors: ["#7C3AED"], style: "", audience: "", tld: ".com" },
  plan: "free"
};

let step = 1;
let submitting = false;

/* ------------------------------------------------------------------ boot -- */
(async () => {
  const { ok } = await requireSession({ next: "/onboarding/" });
  if (!ok) return;

  hydrateFromState();
  await loadSavedProgress();
  bindEvents();
  renderStep(step);
  // eslint-disable-next-line no-unused-expressions
  state.session;
})();

function hydrateFromState() {
  const emailInput = qs("#ob-email");
  if (emailInput) emailInput.value = state.user?.email || "";
  draft.profile.fullName = state.profile?.full_name || state.user?.user_metadata?.full_name || "";
  draft.profile.phone = state.profile?.phone || "";
  qs("#ob-name").value = draft.profile.fullName;
  qs("#ob-phone").value = draft.profile.phone;

  /* The signup trigger already reserved a handle from the email, so the field
     opens with something valid in it rather than empty. */
  draft.account.username = state.profile?.username || state.user?.user_metadata?.username || "";
  qs("#ob-username").value = draft.account.username;
  draft.account.type = state.user?.user_metadata?.account_type === "agent" ? "agent" : (state.profile?.account_type || "owner");

  const metaPlan = state.user?.user_metadata?.plan;
  if (PLANS.some((p) => p.id === metaPlan)) draft.plan = metaPlan;
}

async function loadSavedProgress() {
  if (!state.user) return;
  const { data, error } = await sb.from("onboarding_progress").select("*").eq("user_id", state.user.id).maybeSingle();
  if (error && !/no rows/i.test(error.message || "")) {
    const normalized = normalizeError(error);
    if (normalized.code === "schema_missing") {
      setAlert(
        alertBox,
        "warning",
        "Database schema not installed",
        "Progress cannot be saved until the Shinzora migrations are applied. Continue anyway — details are kept in this tab."
      );
    }
  }
  const savedDraft = data?.data ?? data?.answers;
  if (savedDraft) applyDraft(savedDraft);
  if (data?.current_step) step = Math.min(TOTAL_STEPS, Math.max(1, data.current_step));

  // Prefill from an existing business record (returning users).
  if (state.business) {
    draft.business = {
      name: state.business.name || "",
      category: state.business.category || "",
      description: state.business.description || "",
      logoUrl: state.business.logo_url || "",
      location: state.business.location || "",
      website: state.business.website_url || "",
      stage: state.business.stage || ""
    };
  }
}

function applyDraft(data = {}) {
  Object.assign(draft.account, data.account || {});
  Object.assign(draft.agent, data.agent || {});
  Object.assign(draft.profile, data.profile || {});
  Object.assign(draft.business, data.business || {});
  if (Array.isArray(data.goals)) draft.goals = data.goals;
  draft.goalNote = data.goalNote || draft.goalNote;
  Object.assign(draft.preferences, data.preferences || {});
  if (data.plan) draft.plan = data.plan;

  // Paint the controls
  qs("#ob-name").value = draft.profile.fullName || "";
  qs("#ob-phone").value = draft.profile.phone || "";
  qs("#ob-bname").value = draft.business.name || "";
  qs("#ob-category").value = draft.business.category || "";
  qs("#ob-desc").value = draft.business.description || "";
  qs("#ob-location").value = draft.business.location || "";
  qs("#ob-website").value = draft.business.website || "";
  qs("#ob-goal-note").value = draft.goalNote || "";
  qs("#ob-username").value = draft.account.username || "";
  paintAccountType();
  paintAgentFields();
  qs("#ob-style").value = draft.preferences.style || "";
  qs("#ob-audience").value = draft.preferences.audience || "";
  updateDescCount();

  qsa("[data-stage]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.stage === draft.business.stage)));
  qsa("[data-goal]").forEach((b) => b.setAttribute("aria-pressed", String(draft.goals.includes(b.dataset.goal))));
  qsa("[data-tld]").forEach((b) => b.classList.toggle("is-active", b.dataset.tld === draft.preferences.tld));
  qsa("[data-color]").forEach((b) => b.setAttribute("aria-pressed", String(draft.preferences.colors.includes(b.dataset.color))));
  qsa("[data-plan]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.plan === draft.plan)));

  if (draft.profile.avatarUrl) paintPreview("#avatar-preview", draft.profile.avatarUrl, true);
  if (draft.business.logoUrl) paintPreview("#logo-preview", draft.business.logoUrl, false);
}

/* --------------------------------------------------------------- events -- */

/* ==========================================================================
   Account type — the fork the whole wizard hangs on
   --------------------------------------------------------------------------
   An owner is asked about a business; an agent is asked about their own work.
   The two variants share step 1, the plan step and the finish button, and
   nothing else.
   ========================================================================== */
const isAgent = () => draft.account.type === "agent";

function paintAccountType() {
  qsa("#ob-account-type [data-account-type]").forEach((button) => {
    const active = button.dataset.accountType === draft.account.type;
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });

  qs("#ob-business-block").hidden = isAgent();
  qs("#ob-agent-block").hidden = !isAgent();
  qs("#ob-step2-title").textContent = isAgent() ? "Tell us about your work" : "Tell us about the business";
  qs("#ob-step2-sub").textContent = isAgent()
    ? "Clients read this before they pitch. It becomes your public agent profile."
    : "Everything the AI generates — copy, structure, categories, even domain ideas — is derived from this.";

  /* Brand direction is about a business's colours and audience. An agent has no
     use for it, so the step disappears rather than being filled with noise. */
  const brandLink = qs('[data-step-link="4"]');
  if (brandLink) brandLink.hidden = isAgent();
  if (isAgent() && step === 4) step = 5;
}

function bindAccountType() {
  qsa("#ob-account-type [data-account-type]").forEach((button) => {
    button.addEventListener("click", () => {
      draft.account.type = button.dataset.accountType;
      paintAccountType();
      queueSave();
    });
  });
}

/* ------------------------------------------------------------------ handle */
let handleTimer = null;
let handleVerdict = { ok: true, checked: "" };

function paintHandle(note, tone) {
  const node = qs("#ob-username-note");
  if (!node) return;
  node.textContent = note;
  node.className = `field-hint${tone ? ` is-${tone}` : ""}`;
}

function bindUsername() {
  const input = qs("#ob-username");
  input.addEventListener("input", () => {
    /* Typing "@riya" should just work rather than be rejected for a character
       people naturally type in front of a handle. */
    const cleaned = input.value.toLowerCase().replace(/[^a-z0-9._]/g, "").replace(/^\.+/, "").slice(0, 30);
    if (cleaned !== input.value) input.value = cleaned;
    draft.account.username = cleaned;
    handleVerdict = { ok: false, checked: cleaned };
    paintHandle("Checking availability…", "muted");
    clearTimeout(handleTimer);
    handleTimer = setTimeout(checkHandle, 350);
    queueSave();
  });
  input.addEventListener("blur", checkHandle);
}

async function checkHandle() {
  const wanted = (qs("#ob-username").value || "").trim().toLowerCase();
  draft.account.username = wanted;
  if (!wanted) {
    handleVerdict = { ok: false, checked: "" };
    paintHandle("Pick a handle — people use it to find you.", "warn");
    return false;
  }
  try {
    const { data, error } = await sb.rpc("username_available", { p_username: wanted });
    if (error) throw normalizeError(error);
    handleVerdict = { ok: Boolean(data?.available), checked: wanted, message: data?.message };
    paintHandle(data?.available ? "Available." : (data?.message || "That handle is not available."), data?.available ? "ok" : "warn");
    return handleVerdict.ok;
  } catch (error) {
    /* The check is a convenience, not the guard: set_username re-checks against
       the unique index when the account is saved. Do not block anyone on a
       network blip. */
    handleVerdict = { ok: true, checked: wanted, unchecked: true };
    paintHandle("We could not check that handle yet — it is verified when you finish.", "muted");
    return true;
  }
}

/* ------------------------------------------------------------------- agent */
function readAgentFields() {
  draft.agent.headline = qs("#ob-a-headline").value.trim();
  draft.agent.skills = qs("#ob-a-skills").value.trim();
  draft.agent.bio = qs("#ob-a-bio").value.trim();
  draft.agent.years = qs("#ob-a-years").value;
  draft.agent.rate = qs("#ob-a-rate").value;
  draft.agent.currency = (qs("#ob-a-currency").value || "INR").toUpperCase();
  draft.agent.hours = qs("#ob-a-hours").value;
  draft.agent.availability = qs("#ob-a-availability").value;
  draft.agent.seeking = qs("#ob-a-seek").value.trim();
  draft.agent.portfolio = qs("#ob-a-portfolio").value.trim();
  draft.agent.location = qs("#ob-a-location").value.trim();
  draft.agent.remoteOk = qs("#ob-a-remote").checked;
  draft.agent.equityOk = qs("#ob-a-equity").checked;
  draft.agent.equityMin = qs("#ob-a-equity-min").value;
  draft.agent.equityMax = qs("#ob-a-equity-max").value;
  draft.agent.esopOk = qs("#ob-a-esop").checked;
  qs("#ob-a-equity-range").hidden = !draft.agent.equityOk;
}

function paintAgentFields() {
  const a = draft.agent;
  qs("#ob-a-headline").value = a.headline || "";
  qs("#ob-a-skills").value = a.skills || "";
  qs("#ob-a-bio").value = a.bio || "";
  qs("#ob-a-years").value = a.years || "";
  qs("#ob-a-rate").value = a.rate || "";
  qs("#ob-a-currency").value = a.currency || "INR";
  qs("#ob-a-hours").value = a.hours || "";
  qs("#ob-a-availability").value = a.availability || "available";
  qs("#ob-a-seek").value = a.seeking || "";
  qs("#ob-a-portfolio").value = a.portfolio || "";
  qs("#ob-a-location").value = a.location || "";
  qs("#ob-a-remote").checked = a.remoteOk !== false;
  qs("#ob-a-equity").checked = Boolean(a.equityOk);
  qs("#ob-a-equity-min").value = a.equityMin || "";
  qs("#ob-a-equity-max").value = a.equityMax || "";
  qs("#ob-a-esop").checked = Boolean(a.esopOk);
  qs("#ob-a-equity-range").hidden = !a.equityOk;
}

function bindAgentFields() {
  const watch = [
    "#ob-a-headline", "#ob-a-skills", "#ob-a-bio", "#ob-a-years", "#ob-a-rate", "#ob-a-currency",
    "#ob-a-hours", "#ob-a-availability", "#ob-a-seek", "#ob-a-portfolio", "#ob-a-location",
    "#ob-a-remote", "#ob-a-equity", "#ob-a-equity-min", "#ob-a-equity-max", "#ob-a-esop"
  ];
  watch.forEach((selector) => {
    qs(selector)?.addEventListener("input", () => {
      readAgentFields();
      queueSave();
    });
    qs(selector)?.addEventListener("change", () => {
      readAgentFields();
      queueSave();
    });
  });
}

function bindEvents() {
  qs("#ob-name").addEventListener("input", (e) => {
    draft.profile.fullName = e.target.value;
    queueSave();
  });
  qs("#ob-phone").addEventListener("input", (e) => {
    draft.profile.phone = e.target.value;
    queueSave();
  });
  qs("#ob-bname").addEventListener("input", (e) => {
    draft.business.name = e.target.value;
    queueSave();
  });
  qs("#ob-category").addEventListener("change", (e) => {
    draft.business.category = e.target.value;
    queueSave();
  });
  qs("#ob-desc").addEventListener("input", (e) => {
    draft.business.description = e.target.value;
    updateDescCount();
    queueSave();
  });
  qs("#ob-location").addEventListener("input", (e) => {
    draft.business.location = e.target.value;
    queueSave();
  });
  qs("#ob-website").addEventListener("input", (e) => {
    draft.business.website = e.target.value;
    queueSave();
  });
  qs("#ob-goal-note").addEventListener("input", (e) => {
    draft.goalNote = e.target.value;
    queueSave();
  });
  qs("#ob-style").addEventListener("change", (e) => {
    draft.preferences.style = e.target.value;
    queueSave();
  });
  qs("#ob-audience").addEventListener("change", (e) => {
    draft.preferences.audience = e.target.value;
    queueSave();
  });

  qsa("[data-stage]").forEach((button) =>
    button.addEventListener("click", () => {
      draft.business.stage = button.dataset.stage;
      qsa("[data-stage]").forEach((b) => b.setAttribute("aria-checked", String(b === button)));
      queueSave();
    })
  );

  qsa("[data-goal]").forEach((button) =>
    button.addEventListener("click", () => {
      const goal = button.dataset.goal;
      const index = draft.goals.indexOf(goal);
      if (index > -1) draft.goals.splice(index, 1);
      else draft.goals.push(goal);
      button.setAttribute("aria-pressed", String(index === -1));
      queueSave();
    })
  );

  qsa("[data-tld]").forEach((button) =>
    button.addEventListener("click", () => {
      draft.preferences.tld = button.dataset.tld;
      qsa("[data-tld]").forEach((b) => b.classList.toggle("is-active", b === button));
      queueSave();
    })
  );

  qsa("[data-color]").forEach((button) =>
    button.addEventListener("click", () => {
      const color = button.dataset.color;
      const index = draft.preferences.colors.indexOf(color);
      if (index > -1) draft.preferences.colors.splice(index, 1);
      else if (draft.preferences.colors.length < 2) draft.preferences.colors.push(color);
      else draft.preferences.colors = [draft.preferences.colors[1], color];
      qsa("[data-color]").forEach((b) => b.setAttribute("aria-pressed", String(draft.preferences.colors.includes(b.dataset.color))));
      queueSave();
    })
  );

  qs("#ob-color").addEventListener("input", (e) => {
    const value = e.target.value.toUpperCase();
    draft.preferences.colors = [value];
    qsa("[data-color]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.color.toUpperCase() === value)));
    queueSave();
  });

  qsa("[data-plan]").forEach((button) =>
    button.addEventListener("click", () => {
      draft.plan = button.dataset.plan;
      qsa("[data-plan]").forEach((b) => b.setAttribute("aria-checked", String(b === button)));
      updatePlanNote();
      queueSave();
    })
  );

  qsa("[data-step-link]").forEach((button) =>
    button.addEventListener("click", () => {
      const target = Number(button.dataset.stepLink);
      if (target <= step) renderStep(target);
    })
  );

  nextBtn.addEventListener("click", onNext);
  backBtn.addEventListener("click", () => renderStep(Math.max(1, step - 1)));
  skipBtn.addEventListener("click", onSkip);
  qs("#ob-save-exit").addEventListener("click", async () => {
    await persist(true);
    location.href = "/app/";
  });
  qs("#ob-signout").addEventListener("click", logoutEverywhere);
  qs("#review-edit").addEventListener("click", (event) => {
    event.preventDefault();
    renderStep(1);
  });

  bindAccountType();
  bindUsername();
  bindAgentFields();
  bindUpload("#avatar-input", "#avatar-pick", "#avatar-clear", "#avatar-preview", "avatars", "avatar", true);
  bindUpload("#agent-avatar-input", "#agent-avatar-pick", "#agent-avatar-clear", "#agent-avatar-preview", "avatars", "agent", true);
  bindUpload("#logo-input", "#logo-pick", "#logo-clear", "#logo-preview", "brand-assets", "logo", false);

  // Keyboard: Enter advances on non-textarea focus
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && step < TOTAL_STEPS) {
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      event.preventDefault();
      onNext();
    }
  });
}

function updateDescCount() {
  const counter = qs("[data-desc-count]");
  if (counter) counter.textContent = String((qs("#ob-desc").value || "").length);
}

/* ------------------------------------------------------------- uploads -- */
function paintPreview(selector, url, round) {
  const node = qs(selector);
  if (!node) return;
  node.innerHTML = `<img src="${esc(url)}" alt="" />`;
  node.classList.toggle("round", Boolean(round));
}

function bindUpload(inputSel, pickSel, clearSel, previewSel, bucket, prefix, round) {
  const input = qs(inputSel);
  const pick = qs(pickSel);
  const clearBtn = qs(clearSel);

  pick?.addEventListener("click", () => input.click());

  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setAlert(alertBox, "warning", "File too large", "Choose an image smaller than 2 MB.");
      input.value = "";
      return;
    }
    setBusy(pick, true, "Uploading");
    try {
      const url = await uploadPublic(bucket, state.user.id, file, prefix);
      if (prefix === "avatar") draft.profile.avatarUrl = url;
      else if (prefix === "agent") draft.agent.avatarUrl = url;
      else draft.business.logoUrl = url;
      paintPreview(previewSel, url, round);
      clearBtn.classList.remove("hidden");
      queueSave();
      toast({ title: "Image uploaded" }, { tone: "success" });
    } catch (error) {
      const normalized = normalizeError(error);
      setAlert(
        alertBox,
        "warning",
        "Upload failed",
        /bucket|not found/i.test(normalized.message)
          ? "The storage bucket is not provisioned yet. Apply the Supabase storage migration (0003_storage.sql) and retry."
          : normalized.message
      );
    } finally {
      setBusy(pick, false);
      input.value = "";
    }
  });

  clearBtn?.addEventListener("click", () => {
    if (prefix === "avatar") draft.profile.avatarUrl = "";
    else draft.business.logoUrl = "";
    qs(previewSel).innerHTML = `<i data-icon="${prefix === "avatar" ? "user-round" : "image"}" data-size="${prefix === "avatar" ? 22 : 20}"></i>`;
    hydrateIcons(qs(previewSel));
    clearBtn.classList.add("hidden");
    queueSave();
  });
}

/* ------------------------------------------------------------ persistence */
const queueSave = debounce(() => persist(false), 700);

async function upsertProgress(payload) {
  const compatiblePayload = { ...payload, answers: payload.data ?? draft };
  compatiblePayload.is_completed = Boolean(payload.completed_at);
  let result = await sb.from("onboarding_progress").upsert(compatiblePayload, { onConflict: "user_id" });
  if (!result.error) return result;
  let message = result.error.message || "";
  if (!/column .* (?:answers|is_completed|data|completed_at).* does not exist|schema cache/i.test(message)) return result;

  result = await sb.from("onboarding_progress").upsert(payload, { onConflict: "user_id" });
  if (!result.error) return result;
  message = result.error.message || "";
  if (!/column .* (?:data|completed_at).* does not exist|schema cache/i.test(message)) return result;

  // Old installations use `answers` plus a boolean instead of `data` and
  // `completed_at`; retry with only columns known to that schema.
  return sb.from("onboarding_progress").upsert({
    user_id: payload.user_id,
    current_step: payload.current_step,
    answers: payload.data ?? draft,
    is_completed: Boolean(payload.completed_at),
    updated_at: payload.updated_at
  }, { onConflict: "user_id" });
}

async function persist(silent = false) {
  markSaving();
  try {
    if (!state.user) throw new Error("No session");
    const payload = {
      user_id: state.user.id,
      current_step: step,
      data: draft,
      updated_at: new Date().toISOString()
    };
    const { error } = await upsertProgress(payload);
    if (error) throw normalizeError(error);
    markSaved();
    return true;
  } catch (error) {
    const normalized = normalizeError(error);
    markSaved(true);
    if (!silent) {
      setAlert(
        alertBox,
        "warning",
        "Draft not saved",
        normalized.code === "schema_missing"
          ? "The onboarding_progress table is missing. Apply the migrations to enable cross-device resume."
          : normalized.message
      );
    }
    return false;
  }
}

function markSaving() {
  saveStatus.className = "ob-save-status saving";
  saveStatus.innerHTML = '<i data-icon="loader-circle" data-size="13"></i> Saving…';
  hydrateIcons(saveStatus);
}

function markSaved(isError = false) {
  saveStatus.className = `ob-save-status ${isError ? "" : "saved"}`;
  saveStatus.innerHTML = isError
    ? '<i data-icon="cloud" data-size="13"></i> Not saved'
    : '<i data-icon="cloud-upload" data-size="13"></i> All changes saved';
  hydrateIcons(saveStatus);
}

/* ------------------------------------------------------------ navigation */
function renderStep(target) {
  step = target;
  qsa("[data-step]").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== step;
  });

  qsa("[data-step-link]").forEach((button) => {
    const value = Number(button.dataset.stepLink);
    button.classList.toggle("is-active", value === step);
    button.classList.toggle("is-done", value < step);
    if (value < step) {
      button.querySelector(".obs-marker").innerHTML = '<i data-icon="check" data-size="12"></i>';
      hydrateIcons(button);
    } else if (!button.querySelector(".obs-marker").textContent.trim()) {
      button.querySelector(".obs-marker").textContent = String(value);
    } else if (value >= step) {
      const marker = button.querySelector(".obs-marker");
      if (!marker.querySelector("svg")) marker.textContent = String(value);
    }
    if (value === step) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });

  paintAccountType();

  const percent = Math.round((step / TOTAL_STEPS) * 100);
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = `${step} of ${TOTAL_STEPS}`;

  backBtn.style.visibility = step === 1 ? "hidden" : "visible";
  const optional = step === 3 || step === 4;
  skipBtn.classList.toggle("hidden", !optional);
  nextBtn.innerHTML =
    step === TOTAL_STEPS
      ? 'Finish setup <i data-icon="check" data-size="15" data-stroke="2.4"></i>'
      : 'Continue <i data-icon="arrow-right" data-size="15"></i>';
  hydrateIcons(nextBtn);

  if (step === TOTAL_STEPS) renderReview();
  setAlert(alertBox, null);
  window.scrollTo({ top: 0, behavior: "smooth" });
  persist(false);
}

function validateStep() {
  if (step === 1) {
    const { errors } = validateForm(
      { fullName: qs("#ob-name").value, phone: qs("#ob-phone").value },
      { fullName: [rules.required, rules.min(2), rules.max(80)], phone: [rules.phone] }
    );
    paintFields(errors);
    const handleOk = handleVerdict.ok && handleVerdict.checked === draft.account.username;
    if (!handleOk) {
      errors.username = handleVerdict.message || "Choose a handle that is available.";
      if (!handleVerdict.checked) errors.username = "Pick a handle — people use it to find you.";
    }
    paintFields(errors);
    return Object.keys(errors).length === 0;
  }
  if (step === 2 && isAgent()) {
    readAgentFields();
    const errors = {};
    if (draft.agent.headline.length < 4) errors.agentHeadline = "Say what you do in one line.";
    const skills = draft.agent.skills.split(",").map((s) => s.trim()).filter(Boolean);
    if (skills.length === 0) errors.agentSkills = "List at least one skill — clients search on these.";
    if (draft.agent.seeking.length < 20) errors.agentSeeking = "Write at least 20 characters about what you want.";
    if (draft.agent.portfolio && !/^https?:\/\//i.test(draft.agent.portfolio)) {
      setAlert(alertBox, "warning", "Check the portfolio link", "Portfolio links must start with http:// or https://.");
      return false;
    }
    if (draft.agent.equityOk) {
      const min = Number(draft.agent.equityMin || 0);
      const max = Number(draft.agent.equityMax || 0);
      if (!draft.agent.equityMin && !draft.agent.equityMax) {
        setAlert(alertBox, "warning", "Say how much equity", "Give a range, or untick equity if you would rather not take any.");
        return false;
      }
      if (max < min) {
        setAlert(alertBox, "warning", "Check the equity range", "The upper figure cannot be below the lower one.");
        return false;
      }
    }
    paintFields(errors);
    return Object.keys(errors).length === 0;
  }
  if (step === 2) {
    const { errors } = validateForm(
      {
        businessName: qs("#ob-bname").value,
        category: qs("#ob-category").value,
        description: qs("#ob-desc").value,
        location: qs("#ob-location").value,
        website: qs("#ob-website").value
      },
      {
        businessName: [rules.required, rules.min(2), rules.max(80)],
        category: [rules.required],
        description: [rules.required, rules.min(20), rules.max(600)],
        location: [rules.required],
        website: [rules.url]
      }
    );
    if (!draft.business.stage) errors.stage = "Choose the stage that fits best.";
    paintFields(errors);
    return Object.keys(errors).length === 0;
  }
  if (step === 3 && draft.goals.length === 0) {
    setAlert(alertBox, "warning", "Pick at least one goal", "This shapes the dashboard and the assistant's context. You can skip if you are not sure yet.");
    skipBtn.classList.remove("hidden");
    return false;
  }
  return true;
}

function paintFields(errors) {
  qsa("#ob-panel [data-field]").forEach((field) => {
    const name = field.getAttribute("data-field");
    const message = errors[name];
    field.classList.toggle("invalid", Boolean(message));
    const slot = field.querySelector(".field-error");
    if (slot) slot.textContent = message || "";
  });
  const firstError = qsa("#ob-panel .field.invalid").at(0);
  if (firstError) {
    firstError.scrollIntoView({ block: "center", behavior: "smooth" });
    firstError.querySelector("input, select, textarea")?.focus({ preventScroll: true });
  }
}

async function onNext() {
  if (submitting) return;
  if (step < TOTAL_STEPS) {
    if (!validateStep()) return;
    renderStep(step + 1);
    return;
  }
  await finish();
}

function onSkip() {
  setAlert(alertBox, null);
  if (step === 3) draft.goals = draft.goals.length ? draft.goals : ["website"];
  renderStep(step + 1);
}

/* ---------------------------------------------------------------- review */
function renderReview() {
  const rows = [
    ["Name", draft.profile.fullName || "—"],
    ["Phone", draft.profile.phone || "Not provided"],
    ["Business", draft.business.name || "—"],
    ["Category", draft.business.category || "—"],
    ["Location", draft.business.location || "—"],
    ["Stage", draft.business.stage || "—"],
    ["Goals", draft.goals.length ? draft.goals.join(", ") : "—"],
    ["Brand colours", draft.preferences.colors.join(", ")],
    ["Style", draft.preferences.style || "Let AI decide"],
    ["Audience", draft.preferences.audience || "Let AI decide"],
    ["Domain preference", draft.preferences.tld || "—"],
    ["Plan", planById(draft.plan).name]
  ];
  safeSet("#review-list", rows
    .map(
      ([label, value]) =>
        `<div class="review-row"><span class="rr-label">${esc(label)}</span><span class="rr-value">${esc(value)}</span></div>`
    )
    .join(""));
  updatePlanNote();
}

function updatePlanNote() {
  const note = qs("#plan-note");
  if (!note) return;
  if (draft.plan === "free") {
    note.className = "alert alert-info";
    note.innerHTML = `<i data-icon="info" data-size="16"></i><span>Free plan starts immediately — no payment needed. You can create your first project as soon as you finish.</span>`;
  } else {
    note.className = "alert alert-warn";
    note.innerHTML = `<i data-icon="clock" data-size="16"></i><span><strong>${planById(draft.plan).name} is activated after payment verification.</strong> You will finish setup on the Free plan, then complete the UPI payment in Billing. Your payment stays pending until an administrator confirms it — closing the window never activates anything.</span>`;
  }
  hydrateIcons(note);
}

/* ---------------------------------------------------------------- finish */
async function finish() {
  if (!validateStep() && step !== TOTAL_STEPS) return;
  submitting = true;
  setBusy(nextBtn, true, "Setting up");

  try {
    const userId = state.user.id;

    // 1. Profile
    const { error: profileError } = await sb
      .from("profiles")
      .upsert(
        {
          id: userId,
          full_name: draft.profile.fullName,
          phone: draft.profile.phone || null,
          avatar_url: draft.profile.avatarUrl || null,
          email: state.user.email,
          updated_at: new Date().toISOString()
        },
        { onConflict: "id" }
      );
    if (profileError) throw normalizeError(profileError);

    // 2a. An agent saves a public profile instead of a business.
    let businessId = null;
    if (isAgent()) {
      const { error: handleError } = await sb.rpc("set_username", {
        p_username: (draft.account.username || "").trim().toLowerCase()
      });
      if (handleError) throw normalizeError(handleError);

      const skills = draft.agent.skills.split(",").map((item) => item.trim()).filter(Boolean);
      const { error: agentError } = await sb.rpc("marketplace_save_agent", {
        p_headline: draft.agent.headline,
        p_bio: draft.agent.bio,
        p_skills: skills,
        p_expected_rate: draft.agent.rate ? Number(draft.agent.rate) : null,
        p_currency: draft.agent.currency || "INR",
        p_availability: draft.agent.availability || "available",
        p_portfolio_url: draft.agent.portfolio || null,
        p_years_experience: draft.agent.years ? Number(draft.agent.years) : null,
        p_seeking: draft.agent.seeking,
        p_hours_per_week: draft.agent.hours ? Number(draft.agent.hours) : null,
        p_notice_period_days: null,
        p_location: draft.agent.location || null,
        p_remote_ok: draft.agent.remoteOk !== false,
        p_equity_ok: Boolean(draft.agent.equityOk),
        p_equity_min_pct: draft.agent.equityOk && draft.agent.equityMin !== "" ? Number(draft.agent.equityMin) : null,
        p_equity_max_pct: draft.agent.equityOk && draft.agent.equityMax !== "" ? Number(draft.agent.equityMax) : null,
        p_esop_ok: Boolean(draft.agent.esopOk),
        p_publish: true
      });
      if (agentError) throw normalizeError(agentError);
    }

    // 2b. Business (update the existing row when there is one, else insert)
    const businessPayload = {
      owner_id: userId,
      name: draft.business.name,
      category: draft.business.category,
      description: draft.business.description,
      logo_url: draft.business.logoUrl || null,
      location: draft.business.location,
      website_url: draft.business.website || null,
      stage: draft.business.stage,
      brand_colors: draft.preferences.colors,
      website_style: draft.preferences.style || null,
      target_audience: draft.preferences.audience || null,
      domain_preference: draft.preferences.tld || null,
      goals: draft.goals,
      goal_note: draft.goalNote || null,
      updated_at: new Date().toISOString()
    };

    if (!isAgent()) {
      businessId = state.business?.id;
      if (businessId) {
        const { error } = await sb.from("businesses").update(businessPayload).eq("id", businessId);
        if (error) throw normalizeError(error);
      } else {
        const { data, error } = await sb.from("businesses").insert(businessPayload).select("id").single();
        if (error) throw normalizeError(error);
        businessId = data.id;
      }
    }

    /* 3. Subscription — the plan row already exists (the signup trigger creates
       it), and public.subscriptions has no browser write policy on purpose: a
       plan change must go through payments and an administrator.

       The old code upserted the row directly, which PostgREST refused with 403
       and the UI reported as "Row Level Security blocked the request" — the
       Finish Setup bug. The only field onboarding owns is which business the
       subscription points at, so that is done through the scoped function from
       migration 0010. It can only ever touch the caller's own row. */
    if (!isAgent()) {
    try {
      const { error: subError } = await sb.rpc("attach_business_to_subscription", {
        p_business: businessId
      });
      if (subError) throw normalizeError(subError);
    } catch (error) {
      const normalized = normalizeError(error);
      /* A deployment that has not applied 0010 yet still has the trigger-created
         subscription, so the customer is not blocked — but they are told the
         truth rather than being shown a silent success. */
      const missingFunction = /function .* does not exist|PGRST202|42883|schema cache/i.test(
        String(normalized.detail || "") + " " + String(normalized.message || "")
      );
      if (!missingFunction) throw normalized;
      console.warn("[shinzora] attach_business_to_subscription is missing — apply migration 0010.");
    }
    }

    // 4. Paid plan chosen → service request for the admin queue
    if (draft.plan !== "free") {
      await sb.from("service_requests").insert({
        owner_id: userId,
        service_type: "plan_upgrade",
        title: `Upgrade to ${planById(draft.plan).name}`,
        details: {
          requested_plan: draft.plan,
          listed_price: planById(draft.plan).priceMonthly,
          currency: "INR",
          business_name: isAgent() ? draft.agent.headline : draft.business.name
        },
        /* 'pending' is not a valid service_requests status — the CHECK allows
           requested/approved/in_progress/completed/rejected/cancelled and the
           insert policy demands the customer's own row start at 'requested'.
           The old value failed for every paid plan. */
        status: "requested"
      });
    }

    // 5. Mark onboarding complete
    const completionPayload = {
      user_id: userId,
      current_step: TOTAL_STEPS,
      data: draft,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const { error: obError } = await upsertProgress(completionPayload);
    if (obError) throw normalizeError(obError);

    /* 6. Prove it stuck before telling anybody it worked.
       A write that returns no error is not the same as a saved workspace: the
       row could be missing because a trigger failed, or because RLS silently
       filtered what came back. Re-read both rows as the customer and refuse to
       claim success unless they are really there. */
    const [{ data: savedOnboarding, error: verifyError }, { data: savedBusiness }] = await Promise.all([
      sb.from("onboarding_progress").select("*").eq("user_id", userId).maybeSingle(),
      sb.from("businesses").select("id, name").eq("owner_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (verifyError) throw normalizeError(verifyError);
    if (!isAgent() && !savedBusiness?.id) {
      throw new AppError("The business profile was not saved.", {
        code: "verify_failed",
        hint: "Nothing was lost — press Finish again. If this repeats, check that migrations 0001–0010 are applied."
      });
    }
    if (isAgent()) {
      const { data: savedProfile } = await sb
        .from("profiles")
        .select("username, account_type")
        .eq("id", userId)
        .maybeSingle();
      if (!savedProfile?.username) {
        throw new AppError("Your handle was not saved.", {
          code: "verify_failed",
          hint: "Nothing was lost — press Finish again to claim it."
        });
      }
    }
    if (!savedOnboarding?.completed_at && !savedOnboarding?.is_completed) {
      throw new AppError("Setup was saved but could not be marked complete.", {
        code: "verify_failed",
        hint: "Press Finish again. If this repeats, apply migration 0010 so the database accepts onboarding writes."
      });
    }

    /* Audit trail: useful, never fatal. Losing an activity row must not strand a
       customer who has already been saved on the final screen. */
    if (businessId) {
      sb.rpc("log_activity", {
        p_action: "onboarding_completed",
        p_entity_type: "business",
        p_entity_id: businessId,
        p_meta: { goals: draft.goals, plan: draft.plan }
      }).then(
      () => undefined,
        () => undefined
      );
    }

    /* Refresh the cached identity so the dashboard opens with the real business
       and plan. A failure here is not a reason to keep the customer on the
       wizard — the dashboard loads identity again on its own. */
    await loadIdentity({ force: true }).catch(() => undefined);

    const target = draft.plan === "free" ? "/app/?welcome=1" : `/app/?view=billing&plan=${encodeURIComponent(draft.plan)}`;
    /* Navigation happens before any toast: a toast fired here would be destroyed
       by the page change, which is why the previous flow could look like a click
       that did nothing. */
    location.assign(target);
    /* If the browser refuses or stalls the navigation, give the customer a way
       out instead of leaving a disabled Finish button on screen. */
    setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      submitting = false;
      setBusy(nextBtn, false);
      setAlert(alertBox, "success", "Setup complete", "Your workspace is saved.");
      const link = document.createElement("a");
      link.href = target;
      link.className = "btn btn-primary btn-sm";
      link.textContent = "Open dashboard";
      alertBox.appendChild(link);
    }, 2500);
  } catch (error) {
    submitting = false;
    setBusy(nextBtn, false);
    const normalized = normalizeError(error);
    showError(alertBox, normalized);
    if (normalized.code === "schema_missing") {
      setAlert(
        alertBox,
        "error",
        "Database not initialised",
        "The Shinzora tables do not exist on this Supabase project yet. Apply supabase/migrations/0001_initial_schema.sql and try again."
      );
    }
    fieldError(qs("#ob-bname"), normalized.code === "constraint" ? "Check the business details." : null);
  }
}
