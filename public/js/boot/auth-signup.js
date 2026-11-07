/* ==========================================================================
   Shinzora — create account
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs, param } from "../lib/dom.js";
import { validateForm, paintErrors, readForm, rules } from "../lib/validate.js";
import { setBusy, setAlert, showError, initPasswordToggles, fieldError } from "../ui/form.js";
import { signUp, signInWithGoogle, passwordScore, PASSWORD_LABELS } from "../modules/auth/auth-service.js";
import { redirectIfSignedIn } from "../lib/guard.js";
import { loadIdentity } from "../lib/store.js";
import { normalizeError } from "../lib/supabase.js";
import { PLANS } from "../config/env.js";

/* The submit button ships disabled so a click that lands before this module has
   bound its handler cannot perform a native form submission (which would put the
   password in the URL). It is enabled the moment the handler is attached. */
const enableSubmit = () => {
  const button = qs("#signup-submit");
  if (button) button.disabled = false;
};


hydrateIcons();
initPasswordToggles();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const form = qs("#signup-form");
const alertBox = qs("#auth-alert");
const submit = qs("#signup-submit");
const meter = qs("[data-pw-meter]");
const meterLabel = qs("[data-pw-label]");
const passwordInput = qs("#su-password");

/* Plan preselection from ?plan= (validated against the catalogue) */
const requestedPlan = (param("plan") || "").toLowerCase();
const plan = PLANS.find((p) => p.id === requestedPlan)?.id || "free";
if (plan !== "free") {
  const chip = qs("#plan-chip");
  const label = qs("#plan-chip-label");
  if (chip && label) {
    label.textContent = `${PLANS.find((p) => p.id === plan).name} plan`;
    chip.classList.remove("hidden");
  }
}

/* Nav intent stored by the marketing page */
const intentPlan = (() => {
  try {
    return sessionStorage.getItem("shinzora.intent.plan");
  } catch {
    return null;
  }
})();
const finalPlan = PLANS.some((p) => p.id === intentPlan) ? intentPlan : plan;

redirectIfSignedIn();

/* Password strength meter */
passwordInput?.addEventListener("input", () => {
  const score = passwordScore(passwordInput.value);
  if (meter) meter.setAttribute("data-score", String(score));
  if (meterLabel) {
    meterLabel.textContent = passwordInput.value
      ? `${PASSWORD_LABELS[score]} — ${
          score >= 3 ? "good to go" : "add length, mixed case, numbers or symbols"
        }`
      : "Use 8+ characters with a letter and a number";
  }
  if (passwordInput.value) fieldError(passwordInput, null);
});

enableSubmit();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm(form);

  const { valid, errors } = validateForm(values, {
    fullName: [rules.required, rules.min(2), rules.max(80)],
    email: [rules.required, rules.email],
    password: [rules.required, rules.password],
    confirm: [rules.required, rules.match(() => values.password, "Passwords do not match.")]
  });
  paintErrors(form, errors);

  const termsField = qs('[data-field="terms"]');
  if (!values.terms) {
    termsField.classList.add("invalid");
    termsField.textContent = "Accept the terms to continue.";
    errors.terms = "terms";
  } else if (termsField) {
    termsField.classList.remove("invalid");
    termsField.textContent = "";
  }
  if (!valid || errors.terms) return;

  setBusy(submit, true, "Creating account");
  setAlert(alertBox, null);

  try {
    const result = await signUp({
      fullName: values.fullName,
      email: values.email,
      password: values.password,
      plan: finalPlan,
      next: "/onboarding/"
    });

    if (result.session) {
      await loadIdentity({ force: true });
      location.replace("/onboarding/");
      return;
    }
    location.replace(`/auth/verify-email/?email=${encodeURIComponent(values.email)}`);
  } catch (error) {
    setBusy(submit, false);
    const normalized = normalizeError(error);
    showError(alertBox, normalized);
    if (normalized.code === "user_exists") {
      fieldError(form.elements.email, "This email is already registered.");
    }
  }
});

qs("[data-google]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Opening Google");
  try {
    await signInWithGoogle({ next: "/onboarding/" });
  } catch (error) {
    setBusy(button, false);
    showError(alertBox, normalizeError(error));
  }
});
