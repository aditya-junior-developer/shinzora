/* ==========================================================================
   Shinzora · Messages
   The business side of the same conversation channel the admin console uses.
   A business can read what the platform sent, answer it, and open a new
   conversation with an administrator. Membership is enforced by the database
   functions — this view cannot widen it.
   ========================================================================== */

import { qs } from "../../../lib/dom.js";
import { pageHead } from "../components.js";
import mountChat from "../../messaging/chat.js";

export default async function render(root, ctx = {}) {
  const conversationId = ctx.params?.get?.("c") || new URLSearchParams(location.search).get("c");

  root.innerHTML = `
    ${pageHead({
      title: "Messages",
      desc: "Your conversations with the Shinzora team. Timestamps and read state are stored on the server."
    })}
    <div id="chat-mount"></div>`;

  await mountChat(qs("#chat-mount", root), { variant: "app", conversationId });
}
