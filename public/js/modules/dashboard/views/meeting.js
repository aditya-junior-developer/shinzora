/* ==========================================================================
   Shinzora · Meetings
   --------------------------------------------------------------------------
   A meeting is a room with an identity: a short code, a host, an attendee
   list and an end. Before 0046 a "video meeting" was a group call — it had no
   code to share, no lobby, and nothing that could tell a participant the host
   had ended it.

   Three screens live here, chosen by the URL (?view=meeting&code=…):

     start    no code: title, kind, "Create meeting", plus your recent meetings
     lobby    code known: who is hosting, whether it is locked, join button
     live     joined: the call surface, plus the host controls

   Access is decided by the database. `meeting_join` writes the attendee row
   that authorises signalling on the meeting's topic; a guessed code for a
   locked meeting is refused there, not here. The lobby is deliberately a
   lobby: nothing is joined, and no device is requested, until a person presses
   Join.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { sb, normalizeError } from "../../../lib/supabase.js";
import { state } from "../../../lib/store.js";
import { toast, toastError } from "../../../ui/toast.js";
import { pageHead } from "../components.js";
import { createCall, turnConfigured } from "../../messaging/webrtc.js";
import { openCallSurface } from "../../messaging/call-ui.js";
import { listCallDevices, canChooseSpeaker } from "../../messaging/call-devices.js";

/* Devices chosen in the lobby. They apply when the call is created, and are
   kept for the rest of the page session so a rejoin does not ask again. */
let devicePrefs = { microphoneId: "", cameraId: "", speakerId: "" };

const SCHEDULE_MIN_MS = 60_000;
const SCHEDULE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/* A value the datetime-local input accepts, in the user's own timezone. */
function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function whenLabel(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "Time not set"
    : at.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

async function paintSchedule(host) {
  host.insertAdjacentHTML(
    "beforeend",
    `<section class="card meeting-schedule" id="meeting-schedule" aria-labelledby="schedule-title-heading">
      <div class="card-head">
        <div>
          <h2 class="card-title" id="schedule-title-heading">${icon("calendar", { size: 16 })} Schedule a meeting</h2>
          <p class="card-sub">Book a time and share the link. You can let people in early from the room.</p>
        </div>
      </div>
      <form id="schedule-form" novalidate>
        <div class="field">
          <label for="schedule-title">Meeting name</label>
          <input class="input" id="schedule-title" name="title" type="text" maxlength="120" placeholder="Client kickoff" autocomplete="off" />
        </div>
        <div class="field">
          <label for="schedule-when">When</label>
          <input class="input" id="schedule-when" name="when" type="datetime-local" required />
          <span class="field-hint">Your local time. Up to a year ahead, and at least a minute from now.</span>
        </div>
        <div class="field">
          <label for="schedule-kind">Type</label>
          <select class="input" id="schedule-kind" name="kind">
            <option value="video">Video</option>
            <option value="voice">Voice only</option>
          </select>
        </div>
        <div class="field-error" id="schedule-error" role="alert"></div>
        <div class="card-actions">
          <button class="btn btn-primary" type="submit">${icon("calendar-check", { size: 14 })} Book meeting</button>
        </div>
      </form>
      <div class="schedule-upcoming" id="schedule-upcoming" aria-live="polite"></div>
    </section>`
  );

  const form = qs("#schedule-form", host);
  const when = qs("#schedule-when", host);
  const error = qs("#schedule-error", host);
  when.min = localInputValue(new Date(Date.now() + SCHEDULE_MIN_MS));

  async function paintUpcoming() {
    const list = qs("#schedule-upcoming", host);
    let rows = [];
    try {
      rows = (await rpc("meeting_upcoming", { p_limit: 20 })) || [];
    } catch {
      list.innerHTML = "";
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<p class="card-sub">No meetings booked yet.</p>`;
      return;
    }
    list.innerHTML = `<h3 class="schedule-heading">Upcoming</h3><ul class="schedule-items">${rows
      .map((row) => {
        const link = `${location.origin}/app/?view=meeting&code=${row.code}`;
        return `<li class="schedule-item">
          <div>
            <strong>${esc(row.title || "Meeting")}</strong>
            <div class="card-sub">${esc(whenLabel(row.scheduledFor))} · ${row.kind === "voice" ? "Voice" : "Video"} · code <code>${esc(row.code)}</code></div>
          </div>
          <div class="schedule-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-copy-link="${esc(link)}">${icon("copy", { size: 13 })} Copy link</button>
            <a class="btn btn-ghost btn-sm" href="?view=meeting&code=${esc(row.code)}">Open</a>
          </div>
        </li>`;
      })
      .join("")}</ul>`;
  }

  on(form, "submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const title = String(qs("#schedule-title", host).value || "").trim();
    const kind = qs("#schedule-kind", host).value === "voice" ? "voice" : "video";
    const value = when.value;
    const at = value ? new Date(value) : null;
    const delta = at ? at.getTime() - Date.now() : NaN;

    /* The same limits the database enforces. Checked here so the reason sits
       next to the field, instead of arriving as an error toast after a round trip. */
    if (!at || Number.isNaN(delta)) {
      error.textContent = "Choose a date and time for the meeting.";
      when.focus();
      return;
    }
    if (delta < SCHEDULE_MIN_MS) {
      error.textContent = "Choose a time at least a minute from now.";
      when.focus();
      return;
    }
    if (delta > SCHEDULE_MAX_MS) {
      error.textContent = "Choose a time within the next year.";
      when.focus();
      return;
    }

    const submit = qs("#schedule-form button[type=submit]", host);
    submit.disabled = true;
    try {
      const booked = await rpc("meeting_schedule", { p_title: title || "Meeting", p_kind: kind, p_at: at.toISOString() });
      toast({ title: "Meeting booked", message: `${booked.title} · ${whenLabel(booked.scheduledFor)}` }, { tone: "success" });
      form.reset();
      when.min = localInputValue(new Date(Date.now() + SCHEDULE_MIN_MS));
      await paintUpcoming();
    } catch (err) {
      error.textContent = err?.message || "The meeting could not be booked.";
    } finally {
      submit.disabled = false;
    }
  });

  delegate(host, "click", "[data-copy-link]", async (_event, node) => {
    try {
      await navigator.clipboard.writeText(node.getAttribute("data-copy-link"));
      toast({ title: "Link copied" }, { tone: "success" });
    } catch {
      toastError(new Error("The clipboard is blocked in this browser. Copy the code from the list instead."));
    }
  });

  await paintUpcoming();
}

/* Fill the lobby's device pickers from what the browser can see. Labels only
   appear once the user has allowed the microphone, so an unlabelled device
   still gets a numbered name rather than a blank option. */
async function wireDevices(host) {
  const groups = await listCallDevices();
  const fill = (name, items, placeholder) => {
    const select = qs(`[data-device="${name}"]`, host);
    if (!select) return;
    select.innerHTML = [`<option value="">${esc(placeholder)}</option>`]
      .concat(items.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`))
      .join("");
    select.value = devicePrefs[name] || "";
    select.addEventListener("change", () => {
      devicePrefs = { ...devicePrefs, [name]: select.value };
    });
  };
  fill("microphoneId", groups.microphones, "Default microphone");
  fill("cameraId", groups.cameras, "Default camera");
  const speaker = qs('[data-device="speakerId"]', host);
  if (speaker && canChooseSpeaker() && groups.speakers.length) {
    fill("speakerId", groups.speakers, "Default speaker");
  } else if (speaker) {
    speaker.closest("[data-speaker-field]")?.setAttribute("hidden", "");
  }
}

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Meetings are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

function selfIdentity() {
  const profile = state?.profile || state?.user || {};
  return {
    userId: profile.id || profile.userId || null,
    name: profile.full_name || profile.fullName || profile.name || "You"
  };
}

function meetingLink(code) {
  return `${location.origin}/app/?view=meeting&code=${encodeURIComponent(code)}`;
}

let current = null;

/* Leave the room when the tab closes or the view is torn down. Without this a
   participant row stays "live" after somebody closes the tab, and the lobby
   reports people who are not there. */
function installUnloadGuard() {
  if (window.__shinzoraMeetingUnload) return;
  window.__shinzoraMeetingUnload = true;
  window.addEventListener("pagehide", () => {
    try {
      current?.call?.leave("The page was closed.");
      const id = current?.meeting?.id;
      if (id && sb) sb.rpc("meeting_leave", { p_meeting: id });
    } catch {
      /* unloading */
    }
  });
}

/* Navigating away from the meeting is leaving it. The router swaps the view's
   markup without telling it, so before this guard the camera stayed on and the
   attendee row stayed live after the person had gone somewhere else. */
function installRouteGuard() {
  if (window.__shinzoraMeetingRouteGuard) return;
  window.__shinzoraMeetingRouteGuard = true;
  window.addEventListener("shinzora:view", (event) => {
    if (event?.detail?.view === "meeting") return;
    if (current?.call) current.call.leave("You left the meeting.");
    const meeting = current?.meeting;
    current = null;
    meetingChannel?.unsubscribe?.();
    meetingChannel = null;
    if (meeting?.id && sb) sb.rpc("meeting_leave", { p_meeting: meeting.id }).then(() => {}, () => {});
  });
}

export default async function render(root, { params } = {}) {
  installUnloadGuard();
  installRouteGuard();
  const code = String(params?.get?.("code") || "").trim();

  root.innerHTML = `${pageHead({ title: "Meetings", desc: "Start a room, or join one with a code." })}
    <div id="meeting-root"><div class="card"><div class="skeleton skeleton-line" style="height:14px;width:40%"></div></div></div>`;
  const host = qs("#meeting-root", root);

  if (!code) {
    await paintStart(host);
    return;
  }
  await paintLobby(host, code);
}

/* -------------------------------------------------------------- start screen */

async function paintStart(host) {
  let mine = [];
  try {
    const { data, error } = await sb.rpc("meeting_mine", { p_limit: 10 });
    if (error) throw normalizeError(error);
    mine = data || [];
  } catch {
    /* the list is a convenience; creating still works without it */
  }

  host.innerHTML = `
    <form class="card meeting-start" id="meeting-create">
      <div class="card-head">
        <div>
          <h2 class="card-title">${icon("video", { size: 16 })} Start a meeting</h2>
          <p class="card-sub">You will get a short code and a link. Only signed-in people with the code can join.</p>
        </div>
      </div>
      <div class="field">
        <label for="meeting-title">Meeting name</label>
        <input class="input" id="meeting-title" name="title" type="text" maxlength="120" required placeholder="Weekly design review" autocomplete="off" />
      </div>
      <div class="field">
        <label>Type</label>
        <div class="segmented" id="meeting-kind">
          <button type="button" data-kind="video" aria-pressed="true">${icon("video", { size: 14 })} Video</button>
          <button type="button" data-kind="voice" aria-pressed="false">${icon("mic", { size: 14 })} Voice only</button>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" type="submit">${icon("plus", { size: 14 })} Create meeting</button>
      </div>
    </form>

    ${
      mine.length
        ? `<section class="card">
             <div class="card-head"><h2 class="card-title">${icon("calendar", { size: 16 })} Your recent meetings</h2></div>
             <ul class="meeting-list">
               ${mine
                 .map(
                   (row) => `<li class="meeting-row">
                     <div>
                       <div class="meeting-row-title">${esc(row.title || "Meeting")}</div>
                       <div class="meeting-row-sub">${esc(row.status || "")} · code ${esc(row.code || "")}</div>
                     </div>
                     ${
                       row.ended
                         ? `<span class="badge">ended</span>`
                         : `<a class="btn btn-secondary btn-sm" href="?view=meeting&code=${esc(row.code)}">Open</a>`
                     }
                   </li>`
                 )
                 .join("")}
             </ul>
           </section>`
        : ""
    }`;

  let kind = "video";
  delegate(qs("#meeting-kind", host), "click", "[data-kind]", (event, button) => {
    kind = button.getAttribute("data-kind");
    for (const other of host.querySelectorAll("[data-kind]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });

  on(qs("#meeting-create", host), "submit", async (event) => {
    event.preventDefault();
    const title = String(qs("#meeting-title", host)?.value || "").trim();
    const submit = qs("#meeting-create button[type=submit]", host);
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const meeting = await rpc("meeting_create", { p_title: title || "Meeting", p_kind: kind });
      /* Straight into the room: creating a meeting you then have to click into
         is a needless extra step, and the host's own join is what makes the
         lobby honest for the people arriving. */
      history.replaceState({}, "", `?view=meeting&code=${meeting.code}`);
      await paintLobby(host, meeting.code);
    } catch (error) {
      toastError(error);
      submit.disabled = false;
      submit.textContent = "Create meeting";
    }
  });

  void paintSchedule(host);
}

/* -------------------------------------------------------------------- lobby */

async function paintLobby(host, code) {
  let info;
  try {
    info = await rpc("meeting_lookup", { p_code: code });
  } catch (error) {
    host.innerHTML = `<div class="card"><p class="card-sub">${esc(error?.message || "Could not read that meeting.")}</p></div>`;
    return;
  }

  if (!info?.found) {
    host.innerHTML = `
      <div class="card meeting-missing">
        <h2 class="card-title">${icon("search-x", { size: 16 })} No meeting with that code</h2>
        <p class="card-sub">Codes are nine characters. Ask the host to send the link again.</p>
        <div class="card-actions"><a class="btn btn-secondary btn-sm" href="?view=meeting">Start a meeting instead</a></div>
      </div>`;
    return;
  }

  if (info.ended) {
    host.innerHTML = `
      <div class="card meeting-missing">
        <h2 class="card-title">${icon("phone-off", { size: 16 })} This meeting has ended</h2>
        <p class="card-sub">"${esc(info.title || "That meeting")}" was ended by its host.</p>
        <div class="card-actions"><a class="btn btn-secondary btn-sm" href="?view=meeting">Start a meeting instead</a></div>
      </div>`;
    return;
  }

  const link = meetingLink(info.code);
  host.innerHTML = `
    <section class="card meeting-lobby">
      <div class="card-head">
        <div>
          <h2 class="card-title">${esc(info.title || "Meeting")}</h2>
          <p class="card-sub">
            Hosted by ${esc(info.hostName || "someone")} · ${Number(info.participants) || 0} already inside
            ${info.locked ? `<span class="badge">locked</span>` : ""}
          </p>
        </div>
        ${info.youAreHost ? `<span class="badge is-good">You are the host</span>` : ""}
      </div>

      <div class="meeting-linkbox">
        <label for="meeting-link">Invite link</label>
        <div class="meeting-linkrow">
          <input id="meeting-link" type="text" readonly value="${esc(link)}" />
          <button class="btn btn-secondary btn-sm" type="button" data-meeting-copy>${icon("copy", { size: 13 })} Copy</button>
        </div>
        <p class="card-sub">The code is <code>${esc(info.code)}</code>. Anyone you send this to must be signed in to Shinzora.</p>
      </div>

      <div class="meeting-devices" id="meeting-devices" aria-label="Devices for this call">
        <label class="field"><span>Microphone</span><select class="input" data-device="microphoneId"></select></label>
        <label class="field"><span>Camera</span><select class="input" data-device="cameraId"></select></label>
        <label class="field" data-speaker-field><span>Speaker</span><select class="input" data-device="speakerId"></select></label>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary" type="button" data-meeting-join>
          ${icon(info.kind === "voice" ? "phone" : "video", { size: 14 })}
          Join ${info.kind === "voice" ? "voice call" : "with video"}
        </button>
        ${
          info.youAreHost
            ? `<button class="btn btn-secondary btn-sm" type="button" data-meeting-lock="${info.locked ? "false" : "true"}">
                 ${icon(info.locked ? "unlock" : "lock", { size: 13 })} ${info.locked ? "Unlock" : "Lock"} the room
               </button>`
            : ""
        }
      </div>
      <p class="card-sub meeting-hint" id="meeting-hint" hidden></p>
    </section>`;

  on(qs("[data-meeting-copy]", host), "click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", message: "Send it to whoever should join." });
    } catch {
      /* clipboard blocked: the field is selectable */
      qs("#meeting-link", host)?.select();
      toastError(new Error("The clipboard is blocked in this browser — the link is selected for you to copy."));
    }
  });

  const lockBtn = qs("[data-meeting-lock]", host);
  if (lockBtn) {
    on(lockBtn, "click", async () => {
      const wanted = lockBtn.getAttribute("data-meeting-lock") === "true";
      lockBtn.disabled = true;
      try {
        await rpc("meeting_lock", { p_meeting: info.id, p_locked: wanted });
        await paintLobby(host, code);
      } catch (error) {
        toastError(error);
        lockBtn.disabled = false;
      }
    });
  }

  void wireDevices(host);

  on(qs("[data-meeting-join]", host), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Joining…";
    try {
      await joinMeeting(host, code, info);
    } catch (error) {
      const message = String(error?.message || "");
      const hint = qs("#meeting-hint", host);
      if (hint) {
        hint.hidden = false;
        hint.textContent = message;
      }
      toastError(error);
      button.disabled = false;
      button.textContent = "Try again";
    }
  });
}

/* --------------------------------------------------------------------- live */

async function joinMeeting(host, code, lobby) {
  const joined = await rpc("meeting_join", { p_code: code });
  const self = selfIdentity();
  if (!self.userId) throw new Error("Your session expired. Sign in again to join.");

  const call = createCall({
    kind: joined.kind || lobby.kind || "video",
    topic: joined.topic,
    title: joined.title || lobby.title,
    self
  });
  /* Before the call starts this only remembers the choice; the media is then
     captured with it. */
  await call.selectDevices({ ...devicePrefs });

  current = { meeting: joined, call, host: Boolean(joined.youAreHost) };

  host.innerHTML = `
    <div class="meeting-live" id="meeting-live">
      <div class="meeting-live-bar">
        <div class="meeting-live-id">
          <span class="call-dot" aria-hidden="true"></span>
          <strong>${esc(joined.title || "Meeting")}</strong>
          <span class="meeting-code">code ${esc(joined.code)}</span>
        </div>
        <div class="meeting-live-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-meeting-copy>${icon("copy", { size: 13 })} Copy invite link</button>
          ${
            joined.youAreHost
              ? `<button class="btn btn-secondary btn-sm" type="button" data-meeting-lock="${joined.locked ? "false" : "true"}">
                   ${icon(joined.locked ? "unlock" : "lock", { size: 13 })} ${joined.locked ? "Unlock" : "Lock"}
                 </button>
                 <button class="btn btn-danger btn-sm" type="button" data-meeting-end>${icon("phone-off", { size: 13 })} End for everyone</button>`
              : ""
          }
          <button class="btn btn-secondary btn-sm" type="button" data-meeting-leave>${icon("log-out", { size: 13 })} Leave</button>
        </div>
      </div>
      <p class="call-note">${icon("info", { size: 13 })} <span>Ending the meeting removes everybody; leaving keeps it open for the rest.</span></p>
    </div>`;

  openCallSurface({
    call,
    self,
    subtitle: `${joined.title || "Meeting"} · code ${joined.code}`,
    onClose: () => {
      leaveLocal({ silent: true });
    }
  });

  /* Watch the room itself: if the host ends or locks it while we are inside,
     every attendee's client hears about it without polling. */
  watchMeeting(joined.id);

  on(qs("[data-meeting-copy]", host), "click", async () => {
    try {
      await navigator.clipboard.writeText(meetingLink(joined.code));
      toast({ title: "Link copied", message: "Send it to whoever should join." });
    } catch {
      toastError(new Error("The clipboard is blocked in this browser."));
    }
  });

  const lockBtn = qs("[data-meeting-lock]", host);
  if (lockBtn) {
    on(lockBtn, "click", async () => {
      const wanted = lockBtn.getAttribute("data-meeting-lock") === "true";
      lockBtn.disabled = true;
      try {
        await rpc("meeting_lock", { p_meeting: joined.id, p_locked: wanted });
        current.meeting = { ...current.meeting, locked: wanted };
        lockBtn.setAttribute("data-meeting-lock", String(!wanted));
        lockBtn.innerHTML = `${icon(wanted ? "unlock" : "lock", { size: 13 })} ${wanted ? "Unlock" : "Lock"}`;
        toast({ title: wanted ? "Room locked" : "Room unlocked", message: wanted ? "New people cannot join until you unlock it." : "Anyone with the code can join again." });
      } catch (error) {
        toastError(error);
      } finally {
        lockBtn.disabled = false;
      }
    });
  }

  const endBtn = qs("[data-meeting-end]", host);
  if (endBtn) {
    on(endBtn, "click", async () => {
      endBtn.disabled = true;
      endBtn.textContent = "Ending…";
      try {
        await rpc("meeting_end", { p_meeting: joined.id });
        toast({ title: "Meeting ended", message: "Everybody has been removed from the room." });
        finish("The host ended the meeting.");
      } catch (error) {
        toastError(error);
        endBtn.disabled = false;
      }
    });
  }

  on(qs("[data-meeting-leave]", host), "click", () => {
    leaveLocal({ silent: false });
  });

  try {
    await call.join({ audioOnly: (joined.kind || "video") === "voice" });
  } catch (error) {
    const message = String(error?.message || "");
    if ((joined.kind || "") === "video" && /camera|video|permission|denied/i.test(message)) {
      await call.join({ audioOnly: true }).catch(() => {});
      toastError(new Error("Joined with the microphone only — the camera was not available."));
    } else if (!turnConfigured()) {
      toastError(
        new Error(
          `${message} Across two different networks this needs a TURN relay, which is not configured on this deployment.`
        )
      );
    } else {
      toastError(error);
    }
  }
}

let meetingChannel = null;
function watchMeeting(meetingId) {
  if (!sb) return;
  try {
    meetingChannel?.unsubscribe?.();
    meetingChannel = sb
      .channel(`meeting:${meetingId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "meetings", filter: `id=eq.${meetingId}` },
        (payload) => {
          const row = payload.new || {};
          if (row.ended_at) {
            finish("The host ended the meeting.");
            return;
          }
          if (row.is_locked && current && !current.host) {
            toast({ title: "Room locked", message: "The host has locked the room; you are still inside." }, { tone: "info" });
          }
        }
      )
      .subscribe();
  } catch {
    /* realtime unavailable: the Host's End still works for them, and everybody
       else sees the call drop, which is honest even if less clear */
  }
}

/** Tear the local side down: camera off, channel closed, attendee row closed. */
async function leaveLocal({ silent }) {
  const meeting = current?.meeting;
  const call = current?.call;
  current = null;
  try {
    call?.leave("You left the meeting.");
  } catch {
    /* already gone */
  }
  meetingChannel?.unsubscribe?.();
  meetingChannel = null;
  if (meeting?.id) {
    try {
      await rpc("meeting_leave", { p_meeting: meeting.id });
    } catch {
      /* the row will be cleaned when the meeting ends */
    }
  }
  if (!silent) {
    toast({ title: "Left the meeting", message: "You can rejoin with the same link." });
    location.assign(`?view=meeting&code=${encodeURIComponent(meeting?.code || "")}`);
  }
}

function finish(reason) {
  const meeting = current?.meeting;
  current = null;
  meetingChannel?.unsubscribe?.();
  meetingChannel = null;
  if (meeting?.id && sb) sb.rpc("meeting_leave", { p_meeting: meeting.id }).then(() => {}, () => {});
  document.dispatchEvent(new CustomEvent("shinzora:call-ended", { detail: { reason } }));
  toast({ title: "Meeting over", message: reason }, { tone: "info" });
  location.assign("?view=meeting");
}
