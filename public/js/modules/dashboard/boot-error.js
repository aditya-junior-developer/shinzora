/* ==========================================================================
   Shinzora — what the dashboard shows when boot cannot finish
   --------------------------------------------------------------------------
   The reported failure was a dashboard with an empty sidebar, an empty content
   area and nothing to click. That is the worst possible answer to "the network
   hiccuped": it looks like the account is gone, and reloading is a guess.

   Two surfaces instead:

     paintBootFailure   identity or the session could not be resolved at all.
                        Full-width panel, plain-language reason, Retry.

     paintIdentityWarning  the shell is fine but part of the identity payload
                        failed. A slim banner above the content; the views still
                        load, so the page stays usable.

   Neither one ever hides the sidebar — navigation stays available in both.
   ========================================================================== */

import { esc } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";

const reasonText = (error) => {
  const message = String(error?.message || "").trim();
  if (!message) return "The workspace did not finish loading.";
  /* Postgres and fetch errors are long and shouty; keep the first sentence. */
  return message.split(/\n/)[0].slice(0, 240);
};

/**
 * Replace the view area with a recoverable error panel.
 * @returns {HTMLElement|null}
 */
export function paintBootFailure(root, error, { onRetry, onSignIn } = {}) {
  const host = root || (typeof document !== "undefined" ? document.getElementById("view-root") : null);
  if (!host) return null;
  const detail = error?.detail || error?.hint || "";

  host.innerHTML = `
    <div class="boot-failure" role="alert" data-boot-failure>
      <span class="boot-failure-icon">${icon("wifi-off", { size: 22 })}</span>
      <div class="boot-failure-body">
        <h2 class="boot-failure-title">We couldn't load your workspace</h2>
        <p class="boot-failure-text">${esc(reasonText(error))}</p>
        ${detail ? `<p class="boot-failure-detail">${esc(String(detail).slice(0, 300))}</p>` : ""}
        <p class="boot-failure-hint">You are still signed in — nothing was lost. This is usually a slow or dropped connection.</p>
        <div class="boot-failure-actions">
          <button class="btn btn-primary btn-sm" type="button" data-boot-retry>
            ${icon("rotate-cw", { size: 14 })}Try again
          </button>
          <a class="btn btn-ghost btn-sm" href="/auth/login/" data-boot-signin>Sign in again</a>
        </div>
      </div>
    </div>`;

  host.querySelector("[data-boot-retry]")?.addEventListener("click", () => {
    if (typeof onRetry === "function") onRetry();
    else if (typeof location !== "undefined") location.reload();
  });
  const signIn = host.querySelector("[data-boot-signin]");
  if (signIn && typeof onSignIn === "function") {
    signIn.addEventListener("click", (event) => {
      event.preventDefault();
      onSignIn();
    });
  }
  return host.firstElementChild;
}

/**
 * A slim, dismissible-but-reappearing notice for a partial identity failure.
 * Put it directly above the view area; it does not cover anything.
 */
export function paintIdentityWarning(error, { onRetry, host, area } = {}) {
  const parent = host || (typeof document !== "undefined" ? document.getElementById("app-content") : null);
  if (!parent) return null;
  parent.querySelector("[data-identity-warning]")?.remove();

  const node = document.createElement("div");
  node.className = "boot-warning";
  node.setAttribute("data-identity-warning", "");
  node.setAttribute("role", "status");
  node.innerHTML = `
    <span class="boot-warning-icon">${icon("circle-alert", { size: 15 })}</span>
    <span class="boot-warning-text">${esc(area ? `${area} didn't load` : "Some of your account details didn't load")}: ${esc(reasonText(error))}</span>
    <button class="btn btn-ghost btn-sm" type="button" data-identity-retry>${icon("rotate-cw", { size: 13 })}Retry</button>`;
  node.querySelector("[data-identity-retry]")?.addEventListener("click", () => {
    node.remove();
    if (typeof onRetry === "function") onRetry();
    else if (typeof location !== "undefined") location.reload();
  });
  parent.prepend(node);
  return node;
}
