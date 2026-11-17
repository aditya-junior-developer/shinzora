/* ==========================================================================
   SHINZORA CONNECT — the live meeting room (Daily.co)
   --------------------------------------------------------------------------
   The room is drawn by SHINZORA, around Daily's call object. Daily carries the
   media; the server (`daily` function) decides who may join, mints each
   person's token, and enforces the 24-hour link window.

   What the room does, and only what it does:
     - camera and microphone on/off, speaker choice where the browser lists one
     - screen share start and stop, where the browser supports it
     - a participant list; the host can mute or remove people
     - in-meeting chat, saved to the meeting and also sent live to the room
     - host and managers: end for everyone, lock the room
     - reconnecting, denied-permission and blocked-browser states, shown as they are

   When the call ends for any reason, the after-meeting screen asks the server
   whether this link can still be used: "Return to call" only if it can, and an
   honest reason if it cannot.
   ========================================================================== */

import { qs, esc, on, delegate } from "../../../lib/dom.js";
import { icon } from "../../../lib/icons.js";
import { toast, toastError } from "../../../ui/toast.js";
import { env } from "../../../config/env.js";
import { connect, explain, whenText } from "./api.js";
import { loadDailySdk, callSupport, screenShareAvailable } from "./sdk.js";
import { meetingPath } from "../../../lib/invite.js";

const CHAT_MAX = 500; // a chat line is sent live as well, so it must fit Daily's 4 KB message limit

/** The room that is open right now, if any. The view uses it to leave on navigation. */
let active = null;

export function hasActiveRoom() {
  return Boolean(active);
}

/** Leave the room the person is in, if any. Used when the view changes. */
export function leaveActiveRoom() {
  active?.leave({ screen: false });
}

/* ------------------------------------------------------------------ joining */

/** Ask the server for a token, then open the room. Also used by "Return to call". */
export async function joinRoom(host, code, { devices = {}, subtitle = "", answer: joined = null } = {}) {
  if (active) return;
  host.innerHTML = `<section class="card connect-state" role="status" aria-live="polite">
      <span class="connect-spinner" aria-hidden="true"></span>
      <h2 class="card-title">Joining the meeting…</h2>
      <p class="card-sub">Checking the link and opening the room.</p>
    </section>`;

  const support = callSupport();
  if (!support.ok) {
    renderBlocked(host, support.reason, code);
    return;
  }

  /* A meeting started by "Start now" already carries its token: reuse it, so
     the server is asked once, not twice. */
  let answer = joined;
  if (!answer?.url) {
    try {
      answer = await connect("join", { code });
    } catch (error) {
      renderJoinFailure(host, code, error);
      return;
    }
  }

  /* The room must be a Daily room on the shinzora domain. The server checks the
     exact domain; this stops a malformed or foreign URL reaching the SDK. */
  if (!DAILY_ROOM_URL.test(String(answer?.url || ""))) {
    renderJoinFailure(host, code, Object.assign(new Error("room"), { code: "daily_unavailable", hint: "Try again in a moment." }), "The video room address was not valid.");
    return;
  }

  try {
    await loadDailySdk();
  } catch (error) {
    renderJoinFailure(host, code, error);
    return;
  }

  mount(host, { ...answer, code, subtitle, devices });
}

function renderBlocked(host, reason, code) {
  host.innerHTML = `<section class="card connect-state connect-state-warn" role="alert">
      ${icon("triangle-alert", { size: 20 })}
      <h2 class="card-title">This browser cannot join calls</h2>
      <p class="card-sub">${esc(reason)}</p>
      <div class="card-actions"><a class="btn btn-secondary btn-sm" href="?view=meeting&code=${esc(code)}">Back to the meeting</a></div>
    </section>`;
}

const JOIN_TIMEOUT_MS = 30000;
const DAILY_ROOM_URL = /^https:\/\/[a-z0-9-]+\.daily\.co\/shz[a-z0-9]{9}s[0-9]+$/;

function renderJoinFailure(host, code, error, message = "") {
  const failCode = String(error?.code || "");
  const expired = failCode === "meeting_expired";
  const locked = failCode === "meeting_locked";
  const title = expired ? "This link has expired" : locked ? "The host has locked this meeting" : "The meeting could not be joined";
  host.innerHTML = `<section class="card connect-state ${expired || locked ? "" : "connect-state-warn"}" role="alert">
      ${icon(expired ? "clock" : locked ? "lock" : "triangle-alert", { size: 20 })}
      <h2 class="card-title">${esc(title)}</h2>
      <p class="card-sub">${esc(message || explain(error))}</p>
      ${error?.hint ? `<p class="card-sub">${esc(error.hint)}</p>` : ""}
      <div class="card-actions">
        ${expired || locked ? "" : `<button class="btn btn-primary btn-sm" type="button" data-connect-retry>${icon("refresh-cw", { size: 13 })} Try again</button>`}
        <a class="btn btn-secondary btn-sm" href="?view=meeting&code=${esc(code)}">Back to the meeting</a>
      </div>
    </section>`;
  on(qs("[data-connect-retry]", host), "click", () => joinRoom(host, code));
}

/* -------------------------------------------------------------------- room */

const CONTROL_ICON = { on: "mic", off: "mic-off" };

function mount(host, session) {
  const { url, token, user, code, meeting, youAreHost, canManage, subtitle, devices } = session;
  const kind = meeting?.kind || "video";
  const title = meeting?.title || "Meeting";
  const state = {
    call: null,
    closed: false,
    joinedAt: 0,
    timer: null,
    tiles: new Map(),
    audios: new Map(),
    chatIds: new Set(),
    screenOn: false,
    locked: Boolean(meeting?.locked),
    manager: Boolean(canManage),
    host: Boolean(youAreHost)
  };

  host.innerHTML = `
    <div class="connect-room" id="connect-room" data-state="connecting">
      <header class="connect-bar glass">
        <div class="connect-id">
          <span class="connect-dot" data-status-dot aria-hidden="true"></span>
          <div class="connect-id-text">
            <strong>${esc(title)}</strong>
            <span class="connect-sub" data-status-text>Connecting…</span>
          </div>
        </div>
        <div class="connect-bar-actions">
          <span class="connect-clock" data-clock aria-label="Time in the meeting">0:00</span>
          <button class="btn btn-ghost btn-sm" type="button" data-share>${icon("copy", { size: 13 })}<span>Copy link</span></button>
          ${
            state.manager
              ? `<button class="btn btn-ghost btn-sm" type="button" data-lock="${state.locked ? "false" : "true"}">${icon(state.locked ? "unlock" : "lock", { size: 13 })}<span>${state.locked ? "Unlock" : "Lock"}</span></button>`
              : ""
          }
          <button class="btn btn-ghost btn-sm connect-panel-toggle" type="button" data-panel="people" aria-expanded="false">${icon("users", { size: 13 })}<span>People</span><b class="connect-count" data-count>1</b></button>
          <button class="btn btn-ghost btn-sm connect-panel-toggle" type="button" data-panel="chat" aria-expanded="false">${icon("message-square", { size: 13 })}<span>Chat</span></button>
        </div>
      </header>
      <div class="connect-notice" data-notice role="status" hidden></div>
      <main class="connect-stage">
        <div class="connect-grid" id="connect-grid" data-count-tiles="1" aria-label="People in the meeting"></div>
        <aside class="connect-panel glass" id="connect-panel" hidden aria-label="Meeting panel">
          <div class="connect-panel-head">
            <div class="connect-tabs" role="tablist">
              <button type="button" role="tab" data-tab="people" aria-selected="true">People</button>
              <button type="button" role="tab" data-tab="chat" aria-selected="false">Chat</button>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" data-panel-close aria-label="Close panel">${icon("x", { size: 14 })}</button>
          </div>
          <div class="connect-tabpanel" data-tabpanel="people"><ul class="connect-people" data-people></ul></div>
          <div class="connect-tabpanel" data-tabpanel="chat" hidden>
            <ol class="connect-messages" data-messages aria-live="polite"></ol>
            <form class="connect-compose" data-compose>
              <input class="input" type="text" name="message" maxlength="${CHAT_MAX}" placeholder="Message the room" autocomplete="off" aria-label="Message" />
              <button class="btn btn-primary btn-sm" type="submit" aria-label="Send message">${icon("send", { size: 14 })}</button>
            </form>
          </div>
        </aside>
      </main>
      <footer class="connect-dock glass" aria-label="Meeting controls">
        <button class="connect-ctl" type="button" data-ctl="mic" aria-pressed="true">${icon("mic", { size: 18 })}<span>Mute</span></button>
        <button class="connect-ctl" type="button" data-ctl="cam" aria-pressed="true">${icon("video", { size: 18 })}<span>Camera off</span></button>
        <button class="connect-ctl" type="button" data-ctl="screen" aria-pressed="false" ${screenShareAvailable() ? "" : "hidden"}>${icon("monitor", { size: 18 })}<span>Share screen</span></button>
        <label class="connect-ctl connect-speaker" data-speaker-field hidden>
          ${icon("users", { size: 18 })}<span class="sr-only">Speaker</span>
          <select data-speaker aria-label="Speaker"></select>
        </label>
        ${state.manager ? `<button class="connect-ctl connect-ctl-danger" type="button" data-ctl="end">${icon("phone-off", { size: 18 })}<span>End for everyone</span></button>` : ""}
        <button class="connect-ctl connect-ctl-leave" type="button" data-ctl="leave">${icon("log-out", { size: 18 })}<span>Leave</span></button>
      </footer>
    </div>`;

  const root = qs("#connect-room", host);
  const grid = qs("#connect-grid", host);
  const panel = qs("#connect-panel", host);
  const audioHost = document.createElement("div");
  audioHost.className = "connect-audio";
  audioHost.setAttribute("aria-hidden", "true");
  root.appendChild(audioHost);

  const setStatus = (status, text) => {
    root.dataset.state = status;
    qs("[data-status-text]", root).textContent = text;
  };
  const notice = (message, tone = "warn") => {
    const box = qs("[data-notice]", root);
    box.hidden = !message;
    box.className = `connect-notice connect-notice-${tone}`;
    box.textContent = message || "";
  };

  const call = window.DailyIframe.createCallObject({ subscribeToTracksAutomatically: true });
  state.call = call;
  active = {
    leave: (opts = {}) => leaveRoom({ screen: opts.screen !== false, reason: "left" })
  };

  /* ---------------------------------------------------------- media tiles */

  const tileFor = (key, label, extraClass = "") => {
    let tile = state.tiles.get(key);
    if (!tile) {
      tile = document.createElement("figure");
      tile.className = `connect-tile ${extraClass}`;
      tile.dataset.key = key;
      tile.innerHTML = `<div class="connect-avatar" aria-hidden="true"></div><video autoplay playsinline muted></video><figcaption></figcaption>`;
      grid.appendChild(tile);
      state.tiles.set(key, tile);
    }
    tile.querySelector("figcaption").textContent = label;
    return tile;
  };

  const audioFor = (sessionId) => {
    let node = state.audios.get(sessionId);
    if (!node) {
      node = document.createElement("audio");
      node.autoplay = true;
      node.playsInline = true;
      audioHost.appendChild(node);
      state.audios.set(sessionId, node);
    }
    return node;
  };

  /** Bring the tiles and audio in line with Daily's current participants. */
  function sync() {
    if (!state.call || state.closed) return;
    const people = Object.values(call.participants() || {});
    const liveKeys = new Set();

    for (const p of people) {
      const label = p.local ? `${user?.name || "You"} (you)` : p.user_name || "Participant";
      const video = p.tracks?.video;
      const camOn = Boolean(p.video && video?.persistentTrack);
      const tile = tileFor(`${p.session_id}:cam`, label, p.local ? "is-self" : "");
      liveKeys.add(`${p.session_id}:cam`);
      const avatar = tile.querySelector(".connect-avatar");
      const initialSource = String((p.local ? user?.name : p.user_name) || "");
      avatar.textContent = initialSource.trim().charAt(0).toUpperCase() || "?";
      avatar.hidden = camOn;
      const videoEl = tile.querySelector("video");
      videoEl.hidden = !camOn;
      if (camOn) attach(videoEl, video.persistentTrack);
      else videoEl.srcObject = null;
      tile.classList.toggle("is-muted", !p.audio);

      if (p.screen && p.tracks?.screenVideo?.persistentTrack) {
        const screen = tileFor(`${p.session_id}:screen`, `${p.local ? "Your" : `${label}’s`} screen`, "is-screen");
        liveKeys.add(`${p.session_id}:screen`);
        const screenEl = screen.querySelector("video");
        screenEl.hidden = false;
        screen.querySelector(".connect-avatar").hidden = true;
        attach(screenEl, p.tracks.screenVideo.persistentTrack);
      }

      if (!p.local) {
        const node = audioFor(p.session_id);
        const track = p.tracks?.audio?.persistentTrack;
        if (p.audio && track) {
          attach(node, track);
          applySpeaker(node);
        } else {
          node.srcObject = null;
        }
      }
    }

    for (const [key, tile] of state.tiles) {
      if (!liveKeys.has(key)) {
        tile.remove();
        state.tiles.delete(key);
      }
    }
    for (const [sessionId, node] of state.audios) {
      if (!people.some((p) => p.session_id === sessionId)) {
        node.srcObject = null;
        node.remove();
        state.audios.delete(sessionId);
      }
    }
    grid.dataset.countTiles = String(Math.max(1, Math.min(people.length, 12)));
    renderPeople();
    updateControls();
  }

  function attach(el, track) {
    if (!el) return;
    if (el.srcObject?.getTracks?.()[0]?.id === track.id) return;
    el.srcObject = new MediaStream([track]);
    el.play?.().catch(() => {
      /* autoplay can wait for a tap on mobile; the next sync retries */
    });
  }

  /* --------------------------------------------------------- participants */

  function renderPeople() {
    const list = qs("[data-people]", root);
    const people = Object.values(call.participants() || {});
    qs("[data-count]", root).textContent = String(people.length);
    list.innerHTML = people
      .map((p) => {
        const name = p.local ? `${user?.name || "You"} (you)` : p.user_name || "Participant";
        const badges = [p.owner ? "Host" : "", p.audio ? "" : "Muted", p.video ? "" : "Camera off"].filter(Boolean);
        const controls =
          state.manager && !p.local && p.user_id
            ? `<span class="connect-person-actions">
                 <button class="btn btn-ghost btn-sm" type="button" data-mute="${esc(p.session_id)}" ${p.audio ? "" : "disabled"}>${icon("mic-off", { size: 13 })}<span>Mute</span></button>
                 <button class="btn btn-ghost btn-sm" type="button" data-remove="${esc(p.user_id)}" data-name="${esc(name)}">${icon("user-minus", { size: 13 })}<span>Remove</span></button>
               </span>`
            : "";
        return `<li class="connect-person">
            <span class="connect-person-name">${esc(name)}</span>
            <span class="connect-person-badges">${badges.map((b) => `<em>${esc(b)}</em>`).join("")}</span>
            ${controls}
          </li>`;
      })
      .join("");
  }

  delegate(qs("[data-people]", root), "click", "[data-mute]", async (_event, button) => {
    button.disabled = true;
    try {
      await call.updateParticipant(button.getAttribute("data-mute"), { setAudio: false });
    } catch (error) {
      toastError(error, "That person could not be muted.");
    }
  });

  delegate(qs("[data-people]", root), "click", "[data-remove]", async (_event, button) => {
    const name = button.getAttribute("data-name") || "this person";
    if (!window.confirm(`Remove ${name} from the meeting? They can rejoin only if you allow it.`)) return;
    button.disabled = true;
    try {
      await connect("remove", { code, userId: button.getAttribute("data-remove"), ban: false });
      toast({ title: "Removed", message: `${name} has left the meeting.` }, { tone: "info" });
    } catch (error) {
      toastError(error, "That person could not be removed.");
      button.disabled = false;
    }
  });

  /* --------------------------------------------------------------- controls */

  function updateControls() {
    if (state.closed) return;
    const micOn = Boolean(call.localAudio?.());
    const camOn = Boolean(call.localVideo?.());
    const mic = qs('[data-ctl="mic"]', root);
    const cam = qs('[data-ctl="cam"]', root);
    mic.setAttribute("aria-pressed", String(micOn));
    mic.innerHTML = `${icon(micOn ? "mic" : "mic-off", { size: 18 })}<span>${micOn ? "Mute" : "Unmute"}</span>`;
    cam.setAttribute("aria-pressed", String(camOn));
    cam.innerHTML = `${icon(camOn ? "video" : "video-off", { size: 18 })}<span>${camOn ? "Camera off" : "Camera on"}</span>`;
    const share = qs('[data-ctl="screen"]', root);
    share.setAttribute("aria-pressed", String(state.screenOn));
    share.innerHTML = `${icon("monitor", { size: 18 })}<span>${state.screenOn ? "Stop sharing" : "Share screen"}</span>`;
  }

  on(qs('[data-ctl="mic"]', root), "click", () => {
    call.setLocalAudio(!call.localAudio?.());
    updateControls();
  });

  on(qs('[data-ctl="cam"]', root), "click", () => {
    call.setLocalVideo(!call.localVideo?.());
    updateControls();
  });

  on(qs('[data-ctl="screen"]', root), "click", async () => {
    try {
      if (state.screenOn) {
        call.stopScreenShare();
      } else {
        call.startScreenShare();
      }
    } catch (error) {
      toastError(error, "Screen sharing was cancelled or is blocked in this browser.");
    }
  });

  /* Speaker: offered only where the browser can list and choose an output. */
  const speakerField = qs("[data-speaker-field]", root);
  const speakerSelect = qs("[data-speaker]", root);
  async function wireSpeakers() {
    if (typeof call.setOutputDeviceAsync !== "function") return;
    try {
      const { devices: list = [] } = (await call.enumerateDevices()) || {};
      const outputs = list.filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default");
      if (!outputs.length) return;
      speakerSelect.innerHTML = outputs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Speaker ${i + 1}`)}</option>`).join("");
      if (devices.speakerId) speakerSelect.value = devices.speakerId;
      speakerField.hidden = false;
    } catch {
      /* no speaker list in this browser: the room uses the default output */
    }
  }
  on(speakerSelect, "change", async () => {
    try {
      await call.setOutputDeviceAsync({ outputDeviceId: speakerSelect.value });
      for (const node of state.audios.values()) applySpeaker(node);
    } catch (error) {
      toastError(error, "That speaker could not be used.");
    }
  });
  function applySpeaker(node) {
    if (speakerSelect.value && typeof node.setSinkId === "function") {
      node.setSinkId(speakerSelect.value).catch(() => {});
    }
  }

  /* Host and managers: lock the room, or end it for everyone. */
  const lockButton = qs("[data-lock]", root);
  if (lockButton) {
    on(lockButton, "click", async () => {
      const wanted = lockButton.getAttribute("data-lock") === "true";
      lockButton.disabled = true;
      try {
        await connect("lock", { code, locked: wanted });
        state.locked = wanted;
        lockButton.setAttribute("data-lock", String(!wanted));
        lockButton.innerHTML = `${icon(wanted ? "unlock" : "lock", { size: 13 })}<span>${wanted ? "Unlock" : "Lock"}</span>`;
        toast({ title: wanted ? "Room locked" : "Room unlocked", message: wanted ? "New people cannot join until you unlock it." : "Anyone with the link can join again." }, { tone: "info" });
      } catch (error) {
        toastError(error, "The room could not be locked.");
      } finally {
        lockButton.disabled = false;
      }
    });
  }

  const endButton = qs('[data-ctl="end"]', root);
  if (endButton) {
    on(endButton, "click", async () => {
      if (!window.confirm("End this meeting for everyone? Everyone will be removed. The link stays valid for 24 hours after this.")) return;
      endButton.disabled = true;
      try {
        await connect("end", { code });
        leaveRoom({ screen: true, reason: "ended" });
      } catch (error) {
        toastError(error, "The meeting could not be ended.");
        endButton.disabled = false;
      }
    });
  }

  on(qs('[data-ctl="leave"]', root), "click", () => leaveRoom({ screen: true, reason: "left" }));

  /* Copy and share the invite link. */
  const link = `${location.origin}${meetingPath(code)}`;
  on(qs("[data-share]", root), "click", async () => {
    try {
      if (navigator.share && window.matchMedia("(max-width: 900px)").matches) {
        await navigator.share({ title, text: `Join “${title}” on Shinzora`, url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", message: "Send it to whoever should join." });
    } catch (error) {
      if (error?.name === "AbortError") return;
      toastError(new Error("The clipboard is blocked in this browser. Copy the link from the meeting page."));
    }
  });

  /* Panels: people and chat, one open at a time. */
  function openPanel(name) {
    const open = panel.hidden || panel.dataset.view !== name;
    panel.hidden = !open;
    if (open) {
      panel.dataset.view = name;
      for (const tab of root.querySelectorAll("button[role=tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
      for (const pane of root.querySelectorAll("[data-tabpanel]")) pane.hidden = pane.dataset.tabpanel !== name;
      if (name === "chat") qs("[data-compose] input", root)?.focus();
    }
    for (const toggle of root.querySelectorAll("button[data-panel]")) {
      toggle.setAttribute("aria-expanded", String(!panel.hidden && panel.dataset.view === toggle.dataset.panel));
    }
  }
  delegate(root, "click", "button[data-panel]", (_event, button) => openPanel(button.getAttribute("data-panel")));
  delegate(root, "click", "button[role=tab]", (_event, button) => openPanel(button.getAttribute("data-tab")));
  on(qs("[data-panel-close]", root), "click", () => {
    panel.hidden = true;
    for (const toggle of root.querySelectorAll("button[data-panel]")) toggle.setAttribute("aria-expanded", "false");
  });

  /* ---------------------------------------------------------------- chat */

  const messages = qs("[data-messages]", root);
  function addChat(message) {
    if (!message || state.chatIds.has(message.id)) return;
    state.chatIds.add(message.id);
    const mine = message.author_id && message.author_id === user?.id;
    const item = document.createElement("li");
    item.className = `connect-msg${mine ? " is-mine" : ""}`;
    const when = new Date(message.created_at || Date.now()).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    item.innerHTML = `<span class="connect-msg-meta">${esc(message.author_name || "Participant")} · ${esc(when)}</span><span class="connect-msg-body">${esc(message.body)}</span>`;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  }

  on(qs("[data-compose]", root), "submit", async (event) => {
    event.preventDefault();
    const input = qs("[data-compose] input", root);
    const body = String(input.value || "").trim();
    if (!body) return;
    if (body.length > CHAT_MAX) {
      toastError(new Error(`Keep messages under ${CHAT_MAX} characters.`));
      return;
    }
    input.disabled = true;
    try {
      const { message } = await connect("chat_send", { code, body });
      input.value = "";
      addChat(message);
      /* Live to the people in the room now; the saved copy is the one above. */
      call.sendAppMessage({ type: "chat", message }, "*");
    } catch (error) {
      toastError(error, "The message was not sent.");
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  async function loadChat() {
    try {
      const { messages: saved = [] } = await connect("chat_list", { code });
      saved.forEach(addChat);
    } catch {
      /* the chat history is a convenience; new messages still arrive live */
    }
  }

  /* ----------------------------------------------------------- call events */

  call.on("joined-meeting", () => {
    clearTimeout(joinTimer);
    state.joinedAt = Date.now();
    setStatus("live", "Live");
    notice("");
    sync();
    startClock();
    loadChat();
  });
  call.on("participant-joined", sync);
  call.on("participant-updated", () => {
    sync();
    updateControls();
  });
  call.on("participant-left", sync);
  call.on("track-started", sync);
  call.on("track-stopped", sync);
  call.on("local-screen-share-started", () => {
    state.screenOn = true;
    updateControls();
    connect("activity", { code, kind: "screen_share_started" }).catch(() => {});
  });
  call.on("local-screen-share-stopped", () => {
    state.screenOn = false;
    updateControls();
    connect("activity", { code, kind: "screen_share_stopped" }).catch(() => {});
  });
  call.on("app-message", (event) => {
    if (event?.data?.type === "chat") addChat(event.data.message);
  });
  call.on("network-connection", (event) => {
    const kind = String(event?.event || "");
    if (kind === "interrupted") {
      setStatus("reconnecting", "Reconnecting…");
      notice("Your connection dropped. Reconnecting…", "warn");
    } else if (kind === "connected" || kind === "reconnected") {
      setStatus("live", "Live");
      notice("");
    }
  });
  call.on("camera-error", (event) => {
    const detail = typeof event?.errorMsg === "string" ? event.errorMsg : event?.errorMsg?.errorMsg;
    notice(
      `The camera or microphone could not be used${detail ? ` (${detail})` : ""}. Allow access in your browser settings, then turn it on again.`,
      "warn"
    );
  });
  call.on("error", (event) => {
    setStatus("lost", "Connection lost");
    notice(`${event?.errorMsg || "The call stopped unexpectedly."} Press Rejoin to get back in.`, "danger");
    ensureRejoin();
  });
  call.on("left-meeting", (event) => {
    if (state.closed) return;
    const reason = event?.reason === "ejected" ? "removed" : "ended";
    leaveRoom({ screen: true, reason });
  });

  function ensureRejoin() {
    if (qs("[data-rejoin]", root)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary btn-sm";
    button.setAttribute("data-rejoin", "");
    button.textContent = "Rejoin";
    on(button, "click", () => {
      button.disabled = true;
      joinAgain();
    });
    qs(".connect-notice", root).appendChild(button);
  }

  async function joinAgain() {
    try {
      await call.join({ url, token, userName: user?.name || "Participant", startVideoOff: kind === "voice", startAudioOff: false });
    } catch (error) {
      notice(explain(error, "The call could not be rejoined. Try again."), "danger");
      ensureRejoin();
    }
  }

  function startClock() {
    clearInterval(state.timer);
    const clock = qs("[data-clock]", root);
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - state.joinedAt) / 1000));
      const h = Math.floor(seconds / 3600);
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(h ? 2 : 1, "0");
      const s = String(seconds % 60).padStart(2, "0");
      clock.textContent = h ? `${h}:${m}:${s}` : `${m}:${s}`;
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  /* ------------------------------------------------------------ the exit */

  async function leaveRoom({ screen, reason }) {
    if (state.closed) return;
    state.closed = true;
    clearInterval(state.timer);
    active = null;
    try {
      await call.leave();
    } catch {
      /* already out */
    }
    try {
      call.destroy();
    } catch {
      /* already destroyed */
    }
    for (const node of state.audios.values()) node.srcObject = null;
    if (reason === "left") connect("leave", { code }).catch(() => {});
    if (screen) showAfter(host, code, { reason, title, subtitle });
  }

  /* Join now; the call's own state drives the screen from here. */
  setStatus("connecting", "Connecting…");
  if (subtitle) qs(".connect-sub", root).textContent = subtitle;
  /* A join that never completes must not leave the person on "Connecting…" forever. */
  const joinTimer = setTimeout(() => {
    if (state.closed || state.joinedAt) return;
    setStatus("lost", "Still connecting");
    notice("We could not reach the call yet. Check your connection, then press Rejoin.", "warn");
    ensureRejoin();
  }, JOIN_TIMEOUT_MS);
  call
    .join({ url, token, userName: user?.name || "Participant", startVideoOff: kind === "voice", startAudioOff: false })
    .then(async () => {
      if (devices.microphoneId || devices.cameraId) {
        await call.setInputDevicesAsync({
          audioDeviceId: devices.microphoneId || undefined,
          videoDeviceId: devices.cameraId || undefined
        }).catch(() => {});
      }
      await wireSpeakers();
    })
    .catch((error) => {
      clearTimeout(joinTimer);
      if (state.closed) return;
      setStatus("lost", "Could not join");
      notice(explain(error, "The call could not start. Check your connection and try again."), "danger");
      ensureRejoin();
    });
}

/* ------------------------------------------------------------- after call */

/**
 * The screen after a call. It asks the server whether this link can still be
 * used, so "Return to call" appears only when it truly works, and an expired
 * link says why instead of offering a dead button.
 */
export async function showAfter(host, code, { reason = "ended", title = "Meeting", subtitle = "" } = {}) {
  host.innerHTML = `<section class="card connect-after" role="status" aria-live="polite">
      <span class="connect-spinner" aria-hidden="true"></span>
      <p class="card-sub">Checking the link…</p>
    </section>`;

  let info = null;
  let failure = "";
  try {
    info = await connect("open", { code });
  } catch (error) {
    failure = explain(error, "The meeting could not be checked right now.");
  }

  const headline =
    reason === "removed"
      ? "You were removed from the meeting"
      : reason === "ended"
        ? "The meeting has ended"
        : "You left the meeting";

  let returnState = { enabled: false, text: "" };
  if (info && info.provider === "daily") {
    if (info.status === "expired") {
      returnState = {
        enabled: false,
        text: "This link has expired. It stayed valid for 24 hours after the meeting ended, so it cannot reopen the meeting. Ask the host for a new link."
      };
    } else if (!info.canJoin) {
      returnState = { enabled: false, text: info.reason || "This meeting cannot be rejoined right now." };
    } else {
      returnState = {
        enabled: true,
        text: info.expiresAt
          ? `This link is valid until ${whenText(info.expiresAt)}.`
          : "The room is still open for you."
      };
    }
  }

  const appUrl = env.appUrl || "https://shinzora.vercel.app";
  host.innerHTML = `<section class="card connect-after glass" aria-labelledby="after-title">
      <div class="connect-after-mark" aria-hidden="true">${icon(reason === "removed" ? "user-minus" : "phone-off", { size: 26 })}</div>
      <h2 class="card-title" id="after-title">${esc(headline)}</h2>
      <p class="card-sub">${esc(subtitle || title)}</p>
      ${failure ? `<p class="connect-notice connect-notice-danger" role="alert">${esc(failure)}</p>` : ""}
      ${returnState.text ? `<p class="card-sub connect-after-why${returnState.enabled ? "" : " is-blocked"}">${esc(returnState.text)}</p>` : ""}
      <div class="connect-after-actions">
        <button class="btn btn-primary" type="button" data-after-return ${returnState.enabled ? "" : "disabled"}>${icon("video", { size: 14 })} Return to call</button>
        <a class="btn btn-secondary" href="${esc(appUrl)}" rel="noopener">${icon("external-link", { size: 14 })} Return to website / application</a>
        <a class="btn btn-ghost" href="?view=meeting">Meetings</a>
      </div>
    </section>`;

  on(qs("[data-after-return]", host), "click", (event) => {
    event.currentTarget.disabled = true;
    joinRoom(host, code, { subtitle });
  });
}
