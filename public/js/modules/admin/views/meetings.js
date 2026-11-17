/* ==========================================================================
   Shinzora admin — Meetings (SHINZORA CONNECT)
   --------------------------------------------------------------------------
   Administrators can:
     - create a meeting (a real Daily room, opened when someone joins)
     - see every Daily meeting: status, host, people inside now, link validity
     - end a live meeting for everyone, or lock and unlock its room
     - grant or revoke "meeting manager": a manager can host any meeting
     - read the activity log: created, joined, refused, locked, ended, removed,
       screen share, room cleaned

   Every action is a call to the `daily` Edge Function, which checks the
   administrator flag again on the server. Nothing here is decided in the
   browser.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { toast, toastError } from "../../../ui/toast.js";
import { pageHead, emptyState, skeletonView } from "../../dashboard/components.js";
import { connect, explain, newRequestId, whenText } from "../../dashboard/connect/api.js";
import { adminApi } from "../api.js";
import { meetingPath } from "../../../lib/invite.js";

const KIND_LABEL = { video: "Video", voice: "Voice" };
const STATUS_LABEL = {
  live: ["Live", "is-good"],
  waiting: ["Not started", ""],
  ended: ["Ended · link open", ""],
  expired: ["Expired", "is-bad"]
};
const EVENT_LABEL = {
  created: "created",
  session_started: "started a session",
  joined: "joined",
  left: "left",
  refused: "was refused entry",
  locked: "locked the room",
  unlocked: "unlocked the room",
  ended: "ended the meeting",
  removed: "removed a participant",
  room_cleaned: "expired room deleted",
  screen_share_started: "started screen share",
  screen_share_stopped: "stopped screen share",
  manager_granted: "granted manager rights",
  manager_revoked: "revoked manager rights"
};

const local = { overview: null, directory: null, filter: "all", query: "", error: "" };

export default async function render(root) {
  root.innerHTML = `${pageHead({
    title: "Meetings",
    desc: "Video and voice meetings: status, activity, host controls and who may host."
  })}
    <div id="admin-meetings">${skeletonView(4)}</div>`;
  await load(root);
}

async function load(root) {
  const host = qs("#admin-meetings", root);
  try {
    const [overview, directory] = await Promise.all([
      connect("admin_overview"),
      local.directory ? Promise.resolve(local.directory) : adminApi.directory().catch(() => ({ users: [] }))
    ]);
    local.overview = overview;
    local.directory = directory;
    local.error = "";
  } catch (error) {
    local.error = explain(error, "The meetings could not be loaded.");
  }
  paint(root);
}

function paint(root) {
  const host = qs("#admin-meetings", root);
  if (!host) return;
  if (local.error || !local.overview) {
    host.innerHTML = emptyState({
      icon: "video-off",
      title: "Meetings are not available",
      desc: local.error || "The meeting service did not answer.",
      action: `<button class="btn btn-secondary btn-sm" type="button" data-admin-meetings-retry>${icon("refresh-cw", { size: 13 })} Try again</button>`
    });
    on(qs("[data-admin-meetings-retry]", host), "click", () => load(root));
    return;
  }

  const { meetings = [], managers = [], events = [] } = local.overview;
  const counts = meetings.reduce((acc, m) => ((acc[m.status] = (acc[m.status] || 0) + 1), acc), {});
  const names = new Map(meetings.map((m) => [m.id, m]));
  const shown = meetings.filter((m) => {
    if (local.filter !== "all" && m.status !== local.filter) return false;
    const term = local.query.trim().toLowerCase();
    return !term || [m.title, m.code, m.hostName].some((v) => String(v || "").toLowerCase().includes(term));
  });

  host.innerHTML = `
    <div class="admin-meetings-stats">
      ${stat("Live now", counts.live || 0)}
      ${stat("Not started", counts.waiting || 0)}
      ${stat("Ended, link open", counts.ended || 0)}
      ${stat("Managers", managers.length)}
    </div>

    <section class="card">
      <div class="card-head"><div><h2 class="card-title">${icon("video", { size: 16 })} Start a meeting</h2><p class="card-sub">Creates a real room. Open the link to be its host; it stays valid for 24 hours after the meeting ends.</p></div></div>
      <form id="admin-meeting-create" class="admin-meeting-create" novalidate>
        <div class="field"><label for="admin-meeting-title">Meeting name</label><input class="input" id="admin-meeting-title" maxlength="120" placeholder="Team sync" autocomplete="off" /></div>
        <div class="field"><label for="admin-meeting-kind">Type</label><select class="input" id="admin-meeting-kind"><option value="video">Video</option><option value="voice">Voice only</option></select></div>
        <div class="card-actions connect-actions">
          <button class="btn btn-primary" type="submit" data-mode="create">${icon("plus", { size: 14 })} Create link</button>
          <button class="btn btn-secondary" type="button" data-mode="instant">${icon("video", { size: 14 })} Start now</button>
        </div>
        <p class="field-error" id="admin-meeting-error" role="alert"></p>
      </form>
    </section>

    <section class="card">
      <div class="card-head admin-meetings-head">
        <div><h2 class="card-title">${icon("calendar", { size: 16 })} Meetings</h2><p class="card-sub">Newest first. Host controls work here for any meeting.</p></div>
        <div class="admin-meetings-filters">
          <input class="input" id="admin-meeting-search" type="search" placeholder="Search title, code or host" value="${esc(local.query)}" aria-label="Search meetings" />
          <select class="input" id="admin-meeting-filter" aria-label="Filter by status">
            ${[["all", "All"], ["live", "Live"], ["waiting", "Not started"], ["ended", "Ended"], ["expired", "Expired"]]
              .map(([v, l]) => `<option value="${v}" ${local.filter === v ? "selected" : ""}>${l}</option>`)
              .join("")}
          </select>
        </div>
      </div>
      ${
        shown.length
          ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Meeting</th><th>Host</th><th>Status</th><th>Inside now</th><th>Link valid until</th><th></th></tr></thead><tbody>
              ${shown.map(meetingRow).join("")}
            </tbody></table></div>`
          : emptyState({ icon: "video", title: "No meetings match", desc: meetings.length ? "Change the filter or search." : "No meetings have been created yet." })
      }
    </section>

    <section class="card">
      <div class="card-head"><div><h2 class="card-title">${icon("shield-check", { size: 16 })} Meeting managers</h2><p class="card-sub">Managers can end, lock and remove people in any meeting. Only administrators grant this.</p></div></div>
      <form id="admin-manager-form" class="admin-manager-form">
        <div class="field"><label for="admin-manager-search">Find a person</label><input class="input" id="admin-manager-search" type="search" placeholder="Name or email" autocomplete="off" /></div>
        <ul class="admin-manager-results" id="admin-manager-results" aria-label="Matching people"></ul>
      </form>
      ${
        managers.length
          ? `<ul class="admin-manager-list">${managers
              .map(
                (row) => `<li class="admin-manager-row"><span>${esc(row.name || "Person")}</span><span class="card-sub">since ${esc(whenText(row.grantedAt))}</span>
                  <button class="btn btn-ghost btn-sm" type="button" data-manager-revoke="${esc(row.userId)}">${icon("user-minus", { size: 13 })} Revoke</button></li>`
              )
              .join("")}</ul>`
          : `<p class="card-sub">No managers yet. Administrators can always host.</p>`
      }
    </section>

    <section class="card">
      <div class="card-head"><div><h2 class="card-title">${icon("activity", { size: 16 })} Activity</h2><p class="card-sub">The latest events across meetings. Times are local.</p></div></div>
      ${
        events.length
          ? `<ul class="admin-activity">${events
              .map((event) => {
                const meeting = names.get(event.meeting_id);
                return `<li><time>${esc(whenText(event.created_at))}</time> <strong>${esc(meeting?.title || "Meeting")}</strong> · ${esc(EVENT_LABEL[event.kind] || event.kind)}</li>`;
              })
              .join("")}</ul>`
          : `<p class="card-sub">Nothing has happened yet.</p>`
      }
    </section>`;

  wire(root);
}

function stat(label, value) {
  return `<div class="admin-stat glass"><span class="admin-stat-value">${Number(value) || 0}</span><span class="admin-stat-label">${esc(label)}</span></div>`;
}

function meetingRow(m) {
  const [label, tone] = STATUS_LABEL[m.status] || [m.status, ""];
  const open = m.status === "live" || m.status === "waiting" || m.status === "ended";
  return `<tr>
    <td><strong>${esc(m.title)}</strong><div class="card-sub">${esc(KIND_LABEL[m.kind] || m.kind)} · code <code>${esc(m.code)}</code></div></td>
    <td>${esc(m.hostName || "Host")}</td>
    <td><span class="badge ${tone}">${esc(label)}</span></td>
    <td>${Number(m.attendeesNow) || 0}</td>
    <td>${m.expiresAt ? esc(whenText(m.expiresAt)) : "—"}</td>
    <td class="admin-row-actions">
      ${open ? `<a class="btn btn-ghost btn-sm" href="${esc(location.origin + meetingPath(m.code))}" target="_blank" rel="noopener">${icon("external-link", { size: 13 })} Open</a>` : ""}
      ${m.status === "live" ? `<button class="btn btn-danger btn-sm" type="button" data-meeting-end="${esc(m.code)}">End for everyone</button>` : ""}
      ${open && m.status !== "expired" ? `<button class="btn btn-secondary btn-sm" type="button" data-meeting-lock="${esc(m.code)}" data-locked="${m.locked ? "1" : "0"}">${m.locked ? "Unlock" : "Lock"}</button>` : ""}
    </td>
  </tr>`;
}

function wire(root) {
  const host = qs("#admin-meetings", root);

  on(qs("#admin-meeting-search", host), "input", (event) => {
    local.query = event.currentTarget.value;
    paint(root);
  });
  on(qs("#admin-meeting-filter", host), "change", (event) => {
    local.filter = event.currentTarget.value;
    paint(root);
  });

  /* Create a meeting: the same server path as everyone else's, so the room is a
     real Daily room and the request cannot be sent twice by a double click. */
  const form = qs("#admin-meeting-create", host);
  const submit = async (mode) => {
    const title = String(qs("#admin-meeting-title", host).value || "").trim() || "Meeting";
    const kind = qs("#admin-meeting-kind", host).value === "voice" ? "voice" : "video";
    const error = qs("#admin-meeting-error", host);
    const buttons = Array.from(host.querySelectorAll("#admin-meeting-create button"));
    buttons.forEach((b) => (b.disabled = true));
    error.textContent = "";
    try {
      const answer = await connect("create", { title, kind, requestId: newRequestId(), instant: mode === "instant" });
      toast({ title: "Meeting created", message: `${answer.meeting.title} · code ${answer.meeting.code}` }, { tone: "success" });
      if (mode === "instant" && answer.url) {
        window.open(`${location.origin}${meetingPath(answer.meeting.code)}`, "_blank", "noopener");
      }
      local.overview = null;
      await load(root);
    } catch (err) {
      error.textContent = explain(err, "The meeting could not be created.");
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  on(form, "submit", (event) => {
    event.preventDefault();
    submit("create");
  });
  on(qs('#admin-meeting-create [data-mode="instant"]', host), "click", () => submit("instant"));

  delegate(host, "click", "[data-meeting-end]", async (_event, button) => {
    if (!window.confirm("End this meeting for everyone? Everyone will be removed.")) return;
    button.disabled = true;
    try {
      await connect("end", { code: button.getAttribute("data-meeting-end") });
      toast({ title: "Meeting ended", message: "Everyone has been removed. The link stays valid for 24 hours." }, { tone: "info" });
      await load(root);
    } catch (error) {
      toastError(error, "The meeting could not be ended.");
      button.disabled = false;
    }
  });

  delegate(host, "click", "[data-meeting-lock]", async (_event, button) => {
    const locked = button.getAttribute("data-locked") !== "1";
    button.disabled = true;
    try {
      await connect("lock", { code: button.getAttribute("data-meeting-lock"), locked });
      await load(root);
    } catch (error) {
      toastError(error, "The room could not be changed.");
      button.disabled = false;
    }
  });

  /* Managers: search the people directory, then grant or revoke. */
  const search = qs("#admin-manager-search", host);
  const results = qs("#admin-manager-results", host);
  on(search, "input", () => {
    const term = search.value.trim().toLowerCase();
    if (term.length < 2) {
      results.innerHTML = "";
      return;
    }
    const managerIds = new Set((local.overview?.managers || []).map((m) => m.userId));
    const users = (local.directory?.users || [])
      .filter((u) => [u.full_name, u.email].some((v) => String(v || "").toLowerCase().includes(term)))
      .slice(0, 8);
    results.innerHTML = users.length
      ? users
          .map(
            (u) => `<li class="admin-manager-result">
              <span>${esc(u.full_name || u.email || "Person")} <span class="card-sub">${esc(u.email || "")}</span></span>
              <button class="btn btn-secondary btn-sm" type="button" data-manager-grant="${esc(u.user_id)}" data-manager-name="${esc(u.full_name || u.email || "Person")}" ${managerIds.has(u.user_id) ? "disabled" : ""}>${managerIds.has(u.user_id) ? "Already a manager" : "Grant"}</button>
            </li>`
          )
          .join("")
      : `<li class="card-sub">No one matches that.</li>`;
  });

  delegate(host, "click", "[data-manager-grant]", async (_event, button) => {
    button.disabled = true;
    try {
      await connect("admin_manager", { userId: button.getAttribute("data-manager-grant"), grant: true });
      toast({ title: "Manager added", message: `${button.getAttribute("data-manager-name")} can now host any meeting.` }, { tone: "success" });
      await load(root);
    } catch (error) {
      toastError(error, "Manager rights could not be granted.");
      button.disabled = false;
    }
  });

  delegate(host, "click", "[data-manager-revoke]", async (_event, button) => {
    if (!window.confirm("Revoke meeting manager rights for this person?")) return;
    button.disabled = true;
    try {
      await connect("admin_manager", { userId: button.getAttribute("data-manager-revoke"), grant: false });
      await load(root);
    } catch (error) {
      toastError(error, "Manager rights could not be revoked.");
      button.disabled = false;
    }
  });
}
