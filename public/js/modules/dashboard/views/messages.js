/* ==========================================================================
   Shinzora · Messages
   --------------------------------------------------------------------------
   One surface, two kinds of conversation:

     Direct   every one-to-one / team conversation this member is in, plus a
              search box that starts a new one by username.
     Groups   rooms they are a member of, with roles, @mentions and settings.

   Both tabs reuse the modules that already own that behaviour
   (`messaging/team-chat.js` and `messaging/group-chat.js`) rather than growing
   a third inbox here. The tab lives in the URL — `?view=messages&tab=groups` —
   so a notification link or a bookmark lands on the right one.

   `?group=<uuid>&message=<uuid>` is the deep link the database writes into a
   notification, and it opens that group with that message in view.
   ========================================================================== */

import { CALLS_ENABLED } from "../../../config/env.js";
import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { pageHead } from "../components.js";
import mountInbox from "../../messaging/team-chat.js";
import mountGroups from "../../messaging/group-chat.js";

export default async function render(root, ctx = {}) {
  const params = new URLSearchParams(location.search);
  if (ctx.params?.has?.("c") && !params.has("c")) params.set("c", ctx.params.get("c"));

  /* The ring banner's fallback (a page with no call engine) arrives here with
     `?answer=<topic>`; answering is the same database check either way. */
  const answerTopic = params.get("answer");

  const conversationId = params.get("c");
  let groupId = params.get("group");
  let messageId = params.get("message");
  /* Messages and Groups are two separate places in the navigation (brief 8).
     This module serves both: `view=groups` (or an old `tab=groups` link, or a
     notification's `group=`) opens groups; anything else opens direct messages. */
  let tab = params.get("view") === "groups" || params.get("tab") === "groups" || groupId ? "groups" : "direct";

  root.innerHTML = `
    ${pageHead({
      title: tab === "groups" ? "Groups" : "Messages",
      desc:
        tab === "groups"
          ? "Private group rooms you are a member of. Who can read what is decided by the database, not by this page."
          : "Direct conversations with members. Who can read what is decided by the database, not by this page."
    })}
    <div id="messages-mount"></div>`;

  if (answerTopic && CALLS_ENABLED) {
    import("../../messaging/incoming-call.js")
      .then(({ answerCall }) => answerCall(answerTopic, { kind: params.get("kind") || "voice" }))
      .catch(() => {});
  }

  const mount = qs("#messages-mount", root);
  let current = null;
  let mounted = null;

  async function mountTab() {
    if (current === tab && mounted) return;
    current = tab;
    mount.innerHTML = "";
    if (tab === "groups") {
      mounted = await mountGroups(mount, { groupId, messageId });
    } else {
      mounted = await mountInbox(mount, { conversationId });
    }
    /* Keep the address in step with the surface, without a reload. */
    const url = new URL(location.href);
    url.searchParams.set("view", tab === "groups" ? "groups" : "messages");
    url.searchParams.delete("tab");
    history.replaceState({}, "", url.toString());
  }

  await mountTab();

  /* A service-worker tap (closed-tab notification) asks this page to jump to a
     group instead of reloading into a new tab. */
  on(navigator.serviceWorker || document, "message", (event) => {
    const data = event.data || {};
    if (data.type !== "shinzora:open-group" || !data.groupId) return;
    tab = "groups";
    groupId = data.groupId;
    messageId = data.messageId || null;
    current = null;
    mountTab().catch(() => {});
  });

  return {
    open: (id) => mounted?.open?.(id),
    refresh: () => mounted?.refresh?.()
  };
}
