/* ==========================================================================
   Shinzora — auth callback
   Handles every Supabase redirect: email verification, magic links, OAuth
   (PKCE code exchange) and password recovery. Always ends in a definite state:
   signed in and forwarded, or a clear error with a way out.
   ========================================================================== */
import { hydrateIcons } from "../lib/icons.js";
/* Purple flame aurora — the only background treatment on auth pages. */
import "../ui/aurora.js";
import { qs, param } from "../lib/dom.js";
import { completeRedirect } from "../modules/auth/auth-service.js";
import { loadIdentity, landingPath, state } from "../lib/store.js";
import { normalizeError } from "../lib/supabase.js";

hydrateIcons();
document.querySelectorAll("[data-year]").forEach((n) => (n.textContent = String(new Date().getFullYear())));

const next = param("next");
const title = qs("#cb-title");
const message = qs("#cb-message");
const mark = qs("#cb-mark");
const actions = qs("#cb-actions");

/* Supabase can bounce a spent or mis-directed link straight back here with
   `error` / `error_code` in the query and no `code` at all. That is still a
   link problem, so it gets the same treatment as a failed exchange. */
const bouncedCode = (param("error_code") || "").toLowerCase();
const bounced = Boolean(param("error")) || /verifier|expired|invalid|already|used|not_found/.test(bouncedCode);

function finish(html, tone = "ok") {
  mark.innerHTML = `<i data-icon="${tone === "ok" ? "circle-check" : "circle-alert"}" data-size="22"></i>`;
  hydrateIcons(mark);
  actions.classList.remove("hidden");
  actions.innerHTML = html;
}

(async () => {
  try {
    const session = await completeRedirect();
    if (!session && bounced) {
      title.textContent = "This link cannot be used here";
      message.textContent =
        "This link has already been used, has expired, or was opened in a different browser than the one that asked for it. Send a new link and open it in the same window you asked from.";
      finish(
        `<a class="btn btn-primary" href="/auth/forgot-password/">Send a new link</a>
         <a class="btn btn-ghost" href="/auth/login/">Back to sign in</a>`,
        "error"
      );
      return;
    }
    if (!session) {
      title.textContent = "No active session found";
      message.textContent =
        "This link may have already been used, or it expired. Sign in to continue — or request a new verification email.";
      finish(
        `<a class="btn btn-primary" href="/auth/login/">Sign in</a>
         <a class="btn btn-secondary" href="/auth/signup/">Create account</a>`,
        "error"
      );
      return;
    }

    await loadIdentity({ force: true });
    title.textContent = "You are signed in";
    message.textContent = "Forwarding you to the right place…";
    const target = next && next.startsWith("/") ? next : landingPath();
    window.setTimeout(() => location.replace(target), 550);
  } catch (error) {
    const normalized = normalizeError(error);
    const isLinkProblem = /^link_/.test(normalized.code || "");
    title.textContent = isLinkProblem ? "This link cannot be used here" : "We could not complete that link";
    message.textContent = normalized.hint ? `${normalized.message} ${normalized.hint}` : normalized.message;
    /* A spent or mis-directed link is not a dead end: the answer is always a
       fresh link, so that is the primary action. */
    finish(
      isLinkProblem
        ? `<a class="btn btn-primary" href="/auth/forgot-password/">Send a new link</a>
           <a class="btn btn-ghost" href="/auth/login/">Back to sign in</a>`
        : `<a class="btn btn-primary" href="/auth/login/">Back to sign in</a>
           <a class="btn btn-ghost" href="/auth/forgot-password/">Reset password</a>`,
      "error"
    );
  }
})();

/* Keep the reference so tree-shaking does not drop the store import. */
void state;
