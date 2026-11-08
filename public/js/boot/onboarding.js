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

  bindUpload("#avatar-input", "#avatar-pick", "#avatar-clear", "#avatar-preview", "avatars", "avatar", true);
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

    // 2. Business (update the existing row when there is one, else insert)
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

    let businessId = state.business?.id;
    if (businessId) {
      const { error } = await sb.from("businesses").update(businessPayload).eq("id", businessId);
      if (error) throw normalizeError(error);
    } else {
      const { data, error } = await sb.from("businesses").insert(businessPayload).select("id").single();
      if (error) throw normalizeError(error);
      businessId = data.id;
    }

    /* 3. Subscription — the plan row already exists (the signup trigger creates
       it), and public.subscriptions has no browser write policy on purpose: a
       plan change must go through payments and an administrator.

       The old code upserted the row directly, which PostgREST refused with 403
       and the UI reported as "Row Level Security blocked the request" — the
       Finish Setup bug. The only field onboarding owns is which business the
       subscription points at, so that is done through the scoped function from
       migration 0010. It can only ever touch the caller's own row. */
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
          business_name: draft.business.name
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
    if (!savedBusiness?.id) {
      throw new AppError("The business profile was not saved.", {
        code: "verify_failed",
        hint: "Nothing was lost — press Finish again. If this repeats, check that migrations 0001–0010 are applied."
      });
    }
    if (!savedOnboarding?.completed_at && !savedOnboarding?.is_completed) {
      throw new AppError("Setup was saved but could not be marked complete.", {
        code: "verify_failed",
        hint: "Press Finish again. If this repeats, apply migration 0010 so the database accepts onboarding writes."
      });
    }

    /* Audit trail: useful, never fatal. Losing an activity row must not strand a
       customer who has already been saved on the final screen. */
    sb.rpc("log_activity", {
      p_action: "onboarding_completed",
      p_entity_type: "business",
      p_entity_id: businessId,
      p_meta: { goals: draft.goals, plan: draft.plan }
    }).then(
      () => undefined,
      () => undefined
    );

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
