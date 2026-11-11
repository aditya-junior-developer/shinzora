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

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { pageHead } from "../components.js";
import mountInbox from "../../messaging/team-chat.js";
import mountGroups from "../../messaging/group-chat.js";

export default async function render(root, ctx = {}) {
  const params = new URLSearchParams(location.search);
  if (ctx.params?.has?.("c") && !params.has("c")) params.set("c", ctx.params.get("c"));

  const conversationId = params.get("c");
  let groupId = params.get("group");
  let messageId = params.get("message");
  let tab = params.get("tab") === "groups" || groupId ? "groups" : "direct";

  root.innerHTML = `
    ${pageHead({
      title: "Messages",
      desc: "Direct conversations and group rooms. Who can read what is decided by the database, not by this page."
    })}
    <div class="messages-tabs" role="tablist" aria-label="Conversation type">
      <button class="messages-tab" type="button" role="tab" data-tab="direct" aria-selected="false">
        ${icon("message-square", { size: 14 })}<span>Direct</span>
      </button>
      <button class="messages-tab" type="button" role="tab" data-tab="groups" aria-selected="false">
        ${icon("users", { size: 14 })}<span>Groups</span>
      </button>
    </div>
    <div id="messages-mount"></div>`;

  const bar = qs(".messages-tabs", root);
  const mount = qs("#messages-mount", root);
  let current = null;
  let mounted = null;

  function paintTabs() {
    [...bar.querySelectorAll("[data-tab]")].forEach((button) => {
      const on_ = button.getAttribute("data-tab") === tab;
      button.setAttribute("aria-selected", String(on_));
      button.classList.toggle("is-active", on_);
    });
  }

  async function mountTab() {
    paintTabs();
    if (current === tab && mounted) return;
    current = tab;
    mount.innerHTML = "";
    if (tab === "groups") {
      mounted = await mountGroups(mount, { groupId, messageId });
    } else {
      mounted = await mountInbox(mount, { conversationId });
    }
    /* Remember the tab without a reload; the group/message deep link is dropped
       once it has been honoured so a refresh does not re-scroll forever. */
    const url = new URL(location.href);
    url.searchParams.set("view", "messages");
    if (tab === "groups") url.searchParams.set("tab", "groups");
    else url.searchParams.delete("tab");
    history.replaceState({}, "", url.toString());
  }

  delegate(bar, "click", "[data-tab]", (_event, button) => {
    const next = button.getAttribute("data-tab");
    if (!next || next === tab) return;
    tab = next;
    mountTab().catch((error) => {
      mount.innerHTML = `<div class="card"><div class="card-body"><p class="muted">${esc(
        error.message || "That tab could not be opened."
      )}</p></div></div>`;
    });
  });

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
