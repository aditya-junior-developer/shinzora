/* ==========================================================================
   Shinzora — sign in
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs, param } from "../lib/dom.js";
import { validateForm, paintErrors, readForm, rules } from "../lib/validate.js";
import { setBusy, setAlert, showError, initPasswordToggles, fieldError } from "../ui/form.js";
import { toast } from "../ui/toast.js";
import { signIn, signInWithGoogle } from "../modules/auth/auth-service.js";
import { redirectIfSignedIn } from "../lib/guard.js";
import { loadIdentity, landingPath } from "../lib/store.js";
import { normalizeError } from "../lib/supabase.js";

/* The submit button ships disabled so a click that lands before this module has
   bound its handler cannot perform a native form submission (which would put the
   password in the URL). It is enabled the moment the handler is attached. */
const enableSubmit = () => {
  const button = qs("#login-submit");
  if (button) button.disabled = false;
};


hydrateIcons();
initPasswordToggles();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const form = qs("#login-form");
const alertBox = qs("#auth-alert");
const submit = qs("#login-submit");
const nextParam = param("next");

/* Contextual messages from redirects */
if (param("signedOut")) toast({ title: "Signed out", message: "Your session ended on this device." }, { tone: "info" });
if (param("verified")) setAlert(alertBox, "success", "Email verified", "Sign in to open your workspace.");
if (param("reset")) setAlert(alertBox, "success", "Password updated", "Use your new password to sign in.");
if (param("error")) setAlert(alertBox, "error", "Sign in could not complete", param("error"));
if (param("email") && form) form.elements.email.value = param("email");

/* Already signed in? Go straight to the workspace. */
redirectIfSignedIn();

enableSubmit();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm(form);
  const { valid, errors } = validateForm(values, {
    /* `rules.account` accepts an email address or an account identifier, so a
       provisioned account that is not a mailbox can still sign in here. The
       server is the only thing that decides whether an account exists. */
    email: [rules.required, rules.account],
    password: [rules.required, rules.min(1)]
  });
  paintErrors(form, errors);
  if (!valid) return;

  setBusy(submit, true, "Signing in");
  setAlert(alertBox, null);
  try {
    await signIn({ email: values.email, password: values.password });
    await loadIdentity({ force: true });
    const target = nextParam && nextParam.startsWith("/") ? nextParam : landingPath();
    location.replace(target);
  } catch (error) {
    const normalized = normalizeError(error);
    setBusy(submit, false);
    showError(alertBox, normalized);
    if (normalized.code === "email_unconfirmed") {
      setAlert(alertBox, "warning", "Email not verified", "Confirm your address, then sign in again.");
      const link = document.createElement("a");
      link.href = `/auth/verify-email/?email=${encodeURIComponent(values.email)}`;
      link.className = "btn btn-secondary btn-block";
      link.style.marginTop = "10px";
      link.textContent = "Resend verification email";
      alertBox.append(link);
    }
    if (normalized.code === "invalid_credentials") {
      fieldError(form.elements.password, "Email or password is incorrect.");
    }
  }
});

qs("[data-google]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Opening Google");
  try {
    await signInWithGoogle({ next: nextParam || "/app/" });
  } catch (error) {
    setBusy(button, false);
    showError(alertBox, normalizeError(error));
  }
});
