/* ==========================================================================
   Shinzora Admin · Messages
   One-to-one and group conversations between administrators and businesses.
   The list, the thread, the timestamps and the read state all come from the
   database — reloading the console loses nothing.
   ========================================================================== */

import { qs } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import mountChat, { unreadMessageCount } from "../../messaging/chat.js";

export default async function render(root) {
  const conversationId = new URLSearchParams(location.search).get("c");

  root.innerHTML = `
    <div class="admin-head">
      <div>
        <h1>Messages</h1>
        <p>
          Conversations between administrators, and between an administrator and a business. Messages are stored
          server-side, so the history is the same on every device and nothing is lost on reload.
        </p>
      </div>
      <div class="admin-head-actions" id="chat-unread-note"></div>
    </div>
    <div id="chat-mount"></div>`;

  await mountChat(qs("#chat-mount", root), { variant: "admin", conversationId });

  try {
    const unread = await unreadMessageCount();
    const note = qs("#chat-unread-note", root);
    if (note && unread > 0) {
      note.innerHTML = `<span class="badge badge-warn">${icon("bell", { size: 12 })}${unread} unread</span>`;
    }
  } catch {
    /* A badge is decoration; the conversation list already shows the truth. */
  }
}
