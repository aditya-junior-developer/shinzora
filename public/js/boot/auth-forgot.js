/* ==========================================================================
   Shinzora — request password reset
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs, esc } from "../lib/dom.js";
import { validateForm, paintErrors, readForm, rules } from "../lib/validate.js";
import { setBusy, setAlert, showError } from "../ui/form.js";
import { requestPasswordReset } from "../modules/auth/auth-service.js";
import { normalizeError } from "../lib/supabase.js";

hydrateIcons();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const form = qs("#forgot-form");
const alertBox = qs("#auth-alert");
const submit = qs("#forgot-submit");
const success = qs("#forgot-success");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm(form);
  const { valid, errors } = validateForm(values, { email: [rules.required, rules.email] });
  paintErrors(form, errors);
  if (!valid) return;

  setBusy(submit, true, "Sending link");
  setAlert(alertBox, null);
  try {
    await requestPasswordReset(values.email);
    form.classList.add("hidden");
    success.classList.remove("hidden");
    success.innerHTML = `<div class="auth-status">
        <div class="as-mark"><i data-icon="mail" data-size="22"></i></div>
        <h3>Reset link sent</h3>
        <p>If an account exists for this address, a reset link is on its way to</p>
        <div class="as-email">${esc(values.email)}</div>
        <p style="margin-top:var(--s-1)">The link expires in one hour and can only be used once.</p>
      </div>
      <p class="auth-footer-note" style="margin-top:var(--s-4)">
        Still nothing? Check spam, or <a href="/auth/forgot-password/">send another link</a>.
      </p>`;
    hydrateIcons(success);
  } catch (error) {
    setBusy(submit, false);
    const normalized = normalizeError(error);
    showError(alertBox, normalized);
    if (normalized.code === "rate_limited" || /security purposes|too many/i.test(normalized.message)) {
      setAlert(alertBox, "warning", "Please wait", "For security, reset emails are rate-limited. Try again in a few minutes.");
    }
  }
});
