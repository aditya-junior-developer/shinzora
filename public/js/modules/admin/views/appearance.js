/* ==========================================================================
   Admin · Appearance
   The administrator's own panel theme. It is saved on the administrator's
   profile (profiles.theme), exactly as a member's dashboard look is, and it
   changes only this admin's panel. Members' dashboards are not affected.
   ========================================================================== */

import { qs } from "../../../lib/dom.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { pageHead } from "../../dashboard/components.js";
import { lookPickerHtml, bindLookPicker } from "../../../ui/look-picker.js";
import { adminState } from "../shell.js";

export default async function render(root) {
  root.innerHTML = `${pageHead({
    title: "Appearance",
    desc: "The theme of your admin panel. Saved to your account; members' dashboards are not affected."
  })}
    <div id="appearance-body">${lookPickerHtml({ title: "Admin panel theme" })}</div>`;

  const uid = adminState.identity?.user?.id;
  const body = qs("#appearance-body", root);
  bindLookPicker(body, {
    save: async (id) => {
      if (!uid) throw new Error("Sign in again to save your theme.");
      const { error } = await sb
        .from("profiles")
        .update({ theme: id, updated_at: new Date().toISOString() })
        .eq("id", uid);
      if (error) throw normalizeError(error);
    }
  });
}
