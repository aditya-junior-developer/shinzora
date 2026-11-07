/* ==========================================================================
   Shinzora — /admin-login/
   --------------------------------------------------------------------------
   This route is no longer a sign-in page. Administrators sign in on the
   standard /auth/login/ page, so this module only does two things: render the
   icons, and send anyone who is already an administrator straight to the
   console. Nothing here authenticates anybody.
   ========================================================================== */

import { hydrateIcons } from "../lib/icons.js";
import "../ui/aurora.js";
import { checkAdmin } from "../modules/admin/api.js";

hydrateIcons();
document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

checkAdmin()
  .then(({ admin }) => {
    if (admin) location.replace("/admin/");
  })
  .catch(() => {
    /* Not signed in, or the check is unavailable: the page stays as a pointer. */
  });
