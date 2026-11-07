/* ==========================================================================
   Shinzora — verify email
   Shows the pending address, resends the verification mail with a cooldown and
   quietly polls for the session that appears once the link is opened.
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs, param } from "../lib/dom.js";
import { setBusy, setAlert, showError } from "../ui/form.js";
import { resendVerification } from "../modules/auth/auth-service.js";
import { normalizeError, getSession } from "../lib/supabase.js";
import { loadIdentity } from "../lib/store.js";
import { toast } from "../ui/toast.js";

hydrateIcons();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const email = param("email") || "";
const emailNode = qs("#verify-email-address");
const alertBox = qs("#auth-alert");
const resend = qs("#resend-button");

if (email && emailNode) emailNode.textContent = email;

let cooldown = 0;
let timer = null;

function startCooldown(seconds = 60) {
  cooldown = seconds;
  clearInterval(timer);
  timer = setInterval(() => {
    cooldown -= 1;
    if (cooldown <= 0) {
      clearInterval(timer);
      resend.disabled = false;
      resend.querySelector("span").textContent = "Resend verification email";
      return;
    }
    resend.disabled = true;
    resend.querySelector("span").textContent = `Resend available in ${cooldown}s`;
  }, 1000);
  resend.disabled = true;
  resend.querySelector("span").textContent = `Resend available in ${cooldown}s`;
}

resend?.addEventListener("click", async () => {
  if (!email) {
    setAlert(alertBox, "warning", "Email address missing", "Return to the sign up page to create your account again.");
    return;
  }
  setBusy(resend, true, "Sending");
  setAlert(alertBox, null);
  try {
    await resendVerification(email);
    setBusy(resend, false);
    startCooldown(60);
    setAlert(alertBox, "success", "Verification email sent", `Check ${email} again — it usually arrives within a minute. Nothing in your spam folder? Ask the owner to confirm the mail server under Supabase → Authentication → Emails.`);
    toast({ title: "Email sent" }, { tone: "success" });
  } catch (error) {
    setBusy(resend, false);
    const normalized = normalizeError(error);
    showError(alertBox, normalized);
    if (/security purposes|rate limit|too many/i.test(normalized.message)) startCooldown(90);
  }
});

/* Poll for the verified session, but only while somebody can see the page.
   This used to fire 40 times over ten minutes regardless — a background timer
   issuing an auth request every 15 seconds on a tab left open, which is real
   battery and CPU cost for no benefit. Nothing is polled while hidden, and one
   check runs immediately when the tab becomes visible again. */
let attempts = 0;
let poll = null;

async function checkVerified() {
  if (attempts > 40) {
    clearInterval(poll);
    poll = null;
    return;
  }
  attempts += 1;
  const session = await getSession();
  if (!session) return;
  clearInterval(poll);
  poll = null;
  document.removeEventListener("visibilitychange", onVisibility);
  await loadIdentity({ force: true }).catch(() => undefined);
  toast({ title: "Email verified", message: "Opening your onboarding." }, { tone: "success" });
  location.replace("/onboarding/");
}

function onVisibility() {
  if (document.visibilityState !== "visible") return;
  checkVerified();
}

function startPolling() {
  if (poll) return;
  poll = setInterval(() => {
    if (document.visibilityState === "visible") checkVerified();
  }, 15000);
}

document.addEventListener("visibilitychange", onVisibility);
startPolling();
