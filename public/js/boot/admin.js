/* ==========================================================================
   Shinzora — Admin console boot
   --------------------------------------------------------------------------
   There is no sign-in form on this page: administrators sign in on the
   standard /auth/login/ page like every other account, and the role is decided
   server-side (public.admin_users, or the pre-launch administrator account).
   This module only resolves access and renders the console or refuses politely.

   Nothing here can grant access: `is_admin()` is checked on the server, and
   every admin action is re-authorised inside the function that performs it.
   ========================================================================== */

import { sb, getSession, normalizeError } from "../lib/supabase.js";
import { qs } from "../lib/dom.js";
import { hydrateIcons } from "../lib/icons.js";
import { checkAdmin } from "../modules/admin/api.js";
import { bindShell, renderView, adminState, viewExists } from "../modules/admin/shell.js";
import { registerServiceWorker } from "../ui/pwa.js";

const gate = qs("#admin-gate");
const shell = qs("#admin-shell");

function paintGate({ title, message, primary, secondary }) {
  if (!gate) return;
  gate.hidden = false;
  const titleNode = qs("#admin-gate-title");
  const messageNode = qs("#admin-gate-message");
  const primaryNode = qs("#admin-gate-primary");
  const secondaryNode = qs("#admin-gate-secondary");
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  if (primaryNode) {
    if (primary) {
      primaryNode.href = primary.href;
      primaryNode.textContent = primary.label;
      primaryNode.hidden = false;
    } else {
      primaryNode.hidden = true;
    }
  }
  if (secondaryNode) {
    if (secondary) {
      secondaryNode.href = secondary.href;
      secondaryNode.textContent = secondary.label;
      secondaryNode.hidden = false;
    } else {
      secondaryNode.hidden = true;
    }
  }
}

async function boot() {
  hydrateIcons();

  if (!sb) {
    paintGate({
      title: "Console unavailable",
      message: "The Supabase client could not be loaded. Check that /js/vendor/supabase-js.js is deployed.",
      primary: { href: "/", label: "Back to Shinzora" }
    });
    return;
  }

  let session = null;
  try {
    session = await getSession();
  } catch (error) {
    console.warn("[shinzora] admin session lookup failed:", error?.message);
  }

  /* No session at all → the standard sign-in page, then straight back here. */
  if (!session) {
    location.replace(`/auth/login/?next=${encodeURIComponent("/admin/")}`);
    return;
  }

  let access = { admin: false, role: null, user: session.user };
  try {
    access = await checkAdmin();
  } catch (error) {
    paintGate({
      title: "Access could not be verified",
      message: normalizeError(error).message || "The administrator check did not complete. Reload to try again.",
      primary: { href: "/admin/", label: "Reload" },
      secondary: { href: "/app/", label: "Open your workspace" }
    });
    return;
  }

  if (!access.admin) {
    /* A dead end is not acceptable here: the person reading this is usually the
       owner who has just registered the account they intend to administer, and
       the fix is one deliberate SQL statement. Show the exact identity the
       database knows (id + email — both already visible to this account) and the
       exact statement, so nobody has to guess which account is missing. */
    const user = access.user || session.user;
    const id = String(user?.id || "").replace(/[^a-f0-9-]/gi, "");
    const email = String(user?.email || "").replace(/[<>"]/g, "");
    const messageNode = qs("#admin-gate-message");
    paintGate({
      title: "Administrator access required",
      message:
        "You are signed in, but this account is not an administrator. Administrator rights live in public.admin_users and only the owner can grant them — never from this page.",
      primary: { href: "/app/", label: "Open your workspace" },
      secondary: { href: `/auth/login/?next=${encodeURIComponent("/admin/")}`, label: "Sign in with another account" }
    });

    if (messageNode && id) {
      const block = document.createElement("div");
      block.className = "alert alert-info";
      block.style.marginTop = "var(--s-3)";
      block.style.textAlign = "left";
      block.innerHTML = `
        <div>
          <div style="font-weight:600;margin-bottom:6px">This account</div>
          <div class="mono" style="font-size:var(--fs-xs);word-break:break-all">${email || "(no email)"}<br>${id}</div>
          <div style="font-weight:600;margin:12px 0 6px">Run once in the Supabase SQL editor</div>
          <pre style="white-space:pre-wrap;font-size:var(--fs-xs);margin:0">insert into public.admin_users (user_id, email, role)
values ('${id}', '${email}', 'superadmin')
on conflict (user_id) do update
  set role = 'superadmin', email = excluded.email;</pre>
          <p class="muted" style="font-size:var(--fs-xs);margin-top:8px">
            Then reload this page. Migration 0004_admin_bootstrap.sql does the same thing by email.
          </p>
        </div>`;
      messageNode.insertAdjacentElement("afterend", block);
    }
    return;
  }

  await enterApp(access.user || session.user, access.role);
}

async function enterApp(user, role) {
  if (gate) gate.hidden = true;
  if (shell) shell.hidden = false;
  adminState.identity = { user, role };

  bindShell({ user, role });

  /* The console registers the service worker itself. It used to be wired only on
     the marketing site and the dashboard, so a browser that went straight to
     /admin/ kept running whatever code the old worker had already cached — and
     an old admin.css keeps the navigation permanently on screen, which reads as
     "the drawer opens but will not close". Registering here means a new deploy
     replaces the old worker, and the shared controller reloads the tab once. */
  registerServiceWorker();

  const requested = new URL(location.href).searchParams.get("view");
  /* Any view the shell can load is reachable by link — including the ones added
     after this boot screen was written. */
  const startView = viewExists(requested) ? requested : "overview";

  await renderView(startView);
}

boot().catch((error) => {
  console.error(error);
  paintGate({
    title: "The console could not start",
    message: normalizeError(error).message || "An unexpected error stopped the console from loading.",
    primary: { href: "/admin/", label: "Reload" },
    secondary: { href: "/app/", label: "Open your workspace" }
  });
});
