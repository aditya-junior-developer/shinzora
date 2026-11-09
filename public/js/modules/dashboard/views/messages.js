/* ==========================================================================
   Shinzora · Messages
   Team chat is the default channel. The existing Shinzora support conversation
   remains available as a separate channel and legacy links containing only ?c=
   continue to open support.
   ========================================================================== */

import { qs, on } from "../../../lib/dom.js";
import { pageHead } from "../components.js";
import mountChat from "../../messaging/chat.js";
import mountTeamChat from "../../messaging/team-chat.js";

export default async function render(root, ctx = {}) {
  const params = new URLSearchParams(location.search);
  if (ctx.params?.has?.("c") && !params.has("c")) params.set("c", ctx.params.get("c"));
  // Older support emails linked to /app/?view=messages&c=UUID with no channel.
  if (!params.has("channel") && params.has("c")) params.set("channel", "support");
  const channel = params.get("channel") === "support" ? "support" : "team";
  const conversationId = params.get("c");

  root.innerHTML = `
    ${pageHead({
      title: "Messages",
      desc: "Talk with your teammates or contact Shinzora support. Team membership and conversation access are checked by the database."
    })}
    <div class="segmented messages-channel-tabs" role="tablist" aria-label="Message channel">
      <button type="button" role="tab" aria-selected="${channel === "team"}" data-channel="team">Team chat</button>
      <button type="button" role="tab" aria-selected="${channel === "support"}" data-channel="support">Shinzora support</button>
    </div>
    <div id="messages-channel-mount"></div>`;

  const mount = qs("#messages-channel-mount", root);
  if (channel === "support") await mountChat(mount, { variant: "app", conversationId });
  else await mountTeamChat(mount, { conversationId });

  root.querySelectorAll("[data-channel]").forEach((button) => {
    on(button, "click", async () => {
      const next = button.dataset.channel;
      const url = new URL(location.href);
      url.searchParams.set("channel", next);
      if (next !== "support") url.searchParams.delete("c");
      history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      params.delete("c");
      await render(root, { params: url.searchParams });
    });
  });
}
