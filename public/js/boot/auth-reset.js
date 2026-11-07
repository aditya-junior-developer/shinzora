/* ==========================================================================
   Shinzora — set a new password
   Requires the recovery session created when the reset link is opened.
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs } from "../lib/dom.js";
import { validateForm, paintErrors, readForm, rules } from "../lib/validate.js";
import { setBusy, setAlert, showError, initPasswordToggles, fieldError } from "../ui/form.js";
import { updatePassword, passwordScore, PASSWORD_LABELS } from "../modules/auth/auth-service.js";
import { normalizeError, getSession } from "../lib/supabase.js";
import { toast } from "../ui/toast.js";

/* The submit button ships disabled so a click that lands before this module has
   bound its handler cannot perform a native form submission (which would put the
   password in the URL). It is enabled the moment the handler is attached. */
const enableSubmit = () => {
  const button = qs("#reset-submit");
  if (button) button.disabled = false;
};


hydrateIcons();
initPasswordToggles();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const form = qs("#reset-form");
const alertBox = qs("#auth-alert");
const submit = qs("#reset-submit");
const meter = qs("[data-pw-meter]");
const meterLabel = qs("[data-pw-label]");
const passwordInput = qs("#rp-password");

passwordInput?.addEventListener("input", () => {
  const score = passwordScore(passwordInput.value);
  if (meter) meter.setAttribute("data-score", String(score));
  if (meterLabel && passwordInput.value) meterLabel.textContent = PASSWORD_LABELS[score];
  if (passwordInput.value) fieldError(passwordInput, null);
});

/* Guard: this page is only usable with a recovery session, and the reason it is
   missing should be specific. Supabase returns the reason in the URL fragment
   (implicit flow) or the query string (PKCE), and "expired", "already used" and
   "wrong device" are three different things to a customer. */
const LINK_ERRORS = {
  otp_expired: {
    title: "This reset link has expired",
    body: "Recovery links are valid for one hour. Request a new email and the new link will work."
  },
  access_denied: {
    title: "This reset link has already been used",
    body: "A reset link works once. If you did not finish setting a password, request a new email."
  },
  bad_code_verifier: {
    title: "This link was opened in a different browser",
    body: "For safety, the link only works in the browser that requested it. Request a new email here and open it in this window."
  }
};

function linkFailure() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  const code = hash.get("error_code") || query.get("error_code") || "";
  const description = hash.get("error_description") || query.get("error_description") || "";
  const entry = LINK_ERRORS[code];
  if (entry) return entry;
  return {
    title: "This reset link is no longer valid",
    body:
      description.replace(/\+/g, " ") ||
      "Recovery links expire after one hour and can only be used once. Request a new email to continue."
  };
}

function disableForm(message) {
  setAlert(alertBox, "warning", message.title, message.body);
  form?.querySelectorAll("input, button").forEach((node) => (node.disabled = true));
  /* A dead end is a bug: always leave the customer a way forward. */
  const card = form?.closest(".auth-card") || form?.parentElement;
  if (card && !qs("#request-new-link", card)) {
    const actions = document.createElement("p");
    actions.className = "auth-footer-note";
    actions.style.marginTop = "var(--s-4)";
    actions.innerHTML =
      '<a class="btn btn-secondary btn-block" id="request-new-link" href="/auth/forgot-password/">Send a new link</a>';
    card.appendChild(actions);
  }
}

(async () => {
  const session = await getSession();
  if (!session) disableForm(linkFailure());
})();

enableSubmit();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm(form);
  const { valid, errors } = validateForm(values, {
    password: [rules.required, rules.password],
    confirm: [rules.required, rules.match(() => values.password, "Passwords do not match.")]
  });
  paintErrors(form, errors);
  if (!valid) return;

  setBusy(submit, true, "Updating password");
  setAlert(alertBox, null);
  try {
    await updatePassword(values.password);
    /* The link is spent now. Clearing the fragment means a refresh cannot look
       like a fresh recovery link, and the page states the outcome once. */
    if (location.hash) history.replaceState({}, "", location.pathname);
    setAlert(alertBox, "success", "Password updated", "Taking you to your workspace…");
    toast({ title: "Password updated", message: "You are signed in with the new password." }, { tone: "success" });
    setTimeout(() => location.replace("/app/"), 900);
  } catch (error) {
    setBusy(submit, false);
    showError(alertBox, normalizeError(error));
  }
});
