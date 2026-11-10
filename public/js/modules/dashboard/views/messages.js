/* ==========================================================================
   Shinzora · Messages
   --------------------------------------------------------------------------
   One surface: every conversation this member is in, and a search box that
   starts a new one by username.

   The Shinzora support channel that used to sit here as a second tab is gone —
   it was a second inbox for a support button that already exists in the sidebar,
   so the same question had two homes and neither was obvious. `?c=` links still
   resolve to the conversation they always pointed at.
   ========================================================================== */

import { qs } from "../../../lib/dom.js";
import { pageHead } from "../components.js";
import mountInbox from "../../messaging/team-chat.js";

export default async function render(root, ctx = {}) {
  const params = new URLSearchParams(location.search);
  if (ctx.params?.has?.("c") && !params.has("c")) params.set("c", ctx.params.get("c"));
  const conversationId = params.get("c");

  root.innerHTML = `
    ${pageHead({
      title: "Messages",
      desc: "Message a teammate, or find anyone on Shinzora by their username. Who can read a conversation is decided by the database, not the page."
    })}
    <div id="messages-mount"></div>`;

  await mountInbox(qs("#messages-mount", root), { conversationId });
}
