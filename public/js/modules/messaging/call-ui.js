/* ==========================================================================
   Shinzora · Call surface
   --------------------------------------------------------------------------
   The panel a call appears in, for both kinds:

     voice    avatar tiles and a live level meter, like a phone call
     video    camera tiles, with your own preview mirrored

   The controls are the four anybody actually wants mid-call: microphone,
   camera (video only), screen share, leave. Every one of them changes the real
   MediaStreamTrack — nothing here is a decoration that looks like it works.

   Two states are shown honestly rather than hidden behind a spinner:
     • "waiting for others" while nobody has joined yet, with the reason
     • a failed tile that names the network cause and what to do about it
   ========================================================================== */

import { qs, esc, on, delegate } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { avatarMarkup } from "../../lib/avatar.js";
import { toast, toastError } from "../../ui/toast.js";
import { connectedTone, endedTone } from "./ringtone.js";
import { stopCallRinging, setActiveCallTopic } from "../../ui/notify.js";
import { sb, normalizeError } from "../../lib/supabase.js";

let active = null;

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * Paint the call panel.
 *
 * @param {object} options
 * @param {ReturnType<import("./webrtc.js").createCall>} options.call
 * @param {{userId:string,name:string,avatarUrl?:string}} options.self
 * @param {string} options.subtitle  e.g. the group name
 * @param {() => void} [options.onClose]
 */
export function openCallSurface({ call, self, subtitle = "", onClose = () => {} }) {
  /* Answering ends the ring, whichever path rang: the in-page banner or a call
     notification that arrived while the tab was in the background. */
  try {
    stopCallRinging();
    /* Tells the notification path "we are in this call" — a ring for the call
       we are already in is the definition of unnecessary sound. */
    setActiveCallTopic(call.state.topic);
  } catch {
    /* notifications not initialised on this page — nothing to stop */
  }
  if (active) active.destroy();

  const kind = call.state.kind;
  const wrap = document.createElement("section");
  wrap.className = `call-surface is-${kind}`;
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", `${kind === "video" ? "Video meeting" : "Voice call"}`);
  wrap.innerHTML = `
    <header class="call-head">
      <div class="call-head-id">
        <span class="call-dot" aria-hidden="true"></span>
        <div>
          <div class="call-title">${esc(call.state.title || "Call")}</div>
          <div class="call-sub">${esc(subtitle)}</div>
        </div>
      </div>
      <div class="call-timer" id="call-timer" aria-live="polite">00:00</div>
      <button class="call-close" type="button" data-call-minimise aria-label="Minimise the call panel">
        ${icon("chevron-down", { size: 14 })}
      </button>
    </header>

    <div class="call-body">
      <div class="call-stage" id="call-stage"></div>
      <aside class="call-people" id="call-people" aria-label="People in this call"></aside>
    </div>
    <div class="call-notice" id="call-notice" hidden></div>
    <div class="call-diag" id="call-diag" hidden></div>

    <footer class="call-controls">
      <button class="call-btn" type="button" data-call-mute aria-pressed="false" title="Microphone">
        ${icon("mic", { size: 16 })}<span>Mute</span>
      </button>
      ${
        kind === "video"
          ? `<button class="call-btn" type="button" data-call-camera aria-pressed="true" title="Camera">
               ${icon("video", { size: 16 })}<span>Camera</span>
             </button>
             <button class="call-btn" type="button" data-call-flip title="Switch camera">
               ${icon("refresh-cw", { size: 16 })}<span>Flip</span>
             </button>
             <button class="call-btn" type="button" data-call-screen title="Share screen">
               ${icon("monitor", { size: 16 })}<span>Share</span>
             </button>`
          : ""
      }
      <button class="call-btn is-danger" type="button" data-call-leave title="Leave the call">
        ${icon("phone-off", { size: 16 })}<span>Leave</span>
      </button>
    </footer>`;

  document.body.append(wrap);

  const stage = qs("#call-stage", wrap);
  const peopleEl = qs("#call-people", wrap);
  const notice = qs("#call-notice", wrap);
  const diag = qs("#call-diag", wrap);
  const timerEl = qs("#call-timer", wrap);
  const muteBtn = qs("[data-call-mute]", wrap);
  const cameraBtn = qs("[data-call-camera]", wrap);
  const leaveBtn = qs("[data-call-leave]", wrap);
  let minimised = false;
  let timer = null;
  let levelTimer = null;
  /* Declared with the other timers: `watchInvite()` runs during setup, and a
     `let` further down the function would be in its dead zone — which is a
     thrown error, not a silent no-op. */
  let inviteTimer = null;

  function tileMarkup({ id, label, stream, state: peerState, muted, cameraOn, mine }) {
    const showVideo = kind === "video" && stream && cameraOn !== false;
    return `<figure class="call-tile${mine ? " is-self" : ""}${peerState === "failed" ? " is-failed" : ""}" data-tile="${esc(id)}">
        ${
          showVideo
            ? `<video class="call-video" autoplay playsinline ${mine ? "muted" : ""} data-video="${esc(id)}"></video>`
            : `<div class="call-avatar">${avatarMarkup({ name: label, avatarUrl: null, alt: "" })}</div>`
        }
        <figcaption class="call-name">
          <span>${esc(label)}${mine ? " · you" : ""}</span>
          ${peerState === "failed" ? `<span class="call-badge is-bad">network</span>` : ""}
          ${peerState === "connecting" || peerState === "new" ? `<span class="call-badge">connecting…</span>` : ""}
          ${muted ? `<span class="call-badge">muted</span>` : ""}
        </figcaption>
        ${
          showVideo && !mine
            ? `<button class="call-tile-fs" type="button" data-tile-fullscreen="${esc(id)}" aria-label="Full screen ${esc(label)}">${icon("maximize-2", { size: 14 })}</button>`
            : ""
        }
      </figure>`;
  }

  let lastStatus = null;
  function paint() {
    const state = call.state;
    if (state.status !== lastStatus) {
      if (state.status === "live" && lastStatus !== "live") connectedTone();
      if (state.status === "ended") endedTone();
      lastStatus = state.status;
    }
    const rows = [];
    const localStream = call.getLocalStream();

    rows.push(
      tileMarkup({
        id: "self",
        label: self.name || "You",
        stream: localStream,
        state: "live",
        muted: state.muted,
        cameraOn: state.cameraOn,
        mine: true
      })
    );

    for (const peer of state.peers) {
      rows.push(
        tileMarkup({
          id: peer.userId,
          label: peer.name || "Someone",
          stream: peer.stream,
          state: peer.state,
          muted: peer.muted,
          cameraOn: peer.cameraOn,
          mine: false
        })
      );
    }

    stage.innerHTML = rows.join("");

    /* A <video> needs the stream attached after it exists in the DOM. */
    for (const video of stage.querySelectorAll("[data-video]")) {
      const id = video.getAttribute("data-video");
      const stream = id === "self" ? localStream : call.state.peers.find((p) => p.userId === id)?.stream;
      if (stream && video.srcObject !== stream) {
        video.srcObject = stream;
        video.muted = id === "self";
        video.play?.().catch(() => {});
      }
    }

    muteBtn.setAttribute("aria-pressed", String(state.muted));
    qs("span", muteBtn).textContent = state.muted ? "Unmute" : "Mute";
    if (cameraBtn) {
      cameraBtn.setAttribute("aria-pressed", String(state.cameraOn));
      qs("span", cameraBtn).textContent = state.cameraOn ? "Camera" : "Camera off";
    }

    const peerCount = state.peers.length;

    /* The participant list is presence, not media: somebody who has joined but
       whose peer connection is still negotiating appears here immediately. */
    const everyone = [
      { userId: "self", name: `${self.name || "You"}`, muted: state.muted, cameraOn: state.cameraOn, mine: true },
      ...(state.others || [])
    ];
    wrap.classList.toggle("has-people", everyone.length > 1);
    if (peopleEl) {
      peopleEl.innerHTML = `
        <div class="call-people-head">${icon("users", { size: 13 })}<span>${everyone.length} in the call</span></div>
        <ul class="call-people-list">
          ${everyone
            .map(
              (person) => `<li class="call-person${person.mine ? " is-self" : ""}">
                <span class="call-person-name">${esc(person.name)}${person.mine ? " · you" : ""}</span>
                <span class="call-person-flags">
                  ${person.muted ? icon("mic-off", { size: 12 }) : icon("mic", { size: 12 })}
                  ${kind === "video" && person.cameraOn === false ? icon("video-off", { size: 12 }) : ""}
                </span>
              </li>`
            )
            .join("")}
        </ul>`;
    }
    if (state.status === "failed") {
      notice.hidden = false;
      notice.className = "call-notice is-bad";
      /* A failure is only useful if the next step is one click away, so the
         notice carries the reason *and* the retry. */
      notice.innerHTML = `${icon("triangle-alert", { size: 14 })}<span>${esc(
        state.error || "The call could not connect."
      )}</span><button class="btn btn-secondary btn-sm" type="button" data-call-retry>Retry</button>`;
    } else if (state.status === "reconnecting") {
      notice.hidden = false;
      notice.className = "call-notice";
      notice.innerHTML = `${icon("loader-circle", { size: 14 })}<span>Reconnecting… the network changed. Your microphone is still open.</span>`;
    } else if (state.status === "connecting") {
      notice.hidden = false;
      notice.className = "call-notice";
      notice.innerHTML = `${icon("loader-circle", { size: 14 })}<span>Connecting…${
        state.relay?.kind === "none" ? " Direct connection only — no relay is set up for this deployment." : ""
      }</span>`;
    } else if (peerCount === 0) {
      notice.hidden = false;
      notice.className = "call-notice";
      notice.innerHTML = `${icon("users", { size: 14 })}<span>${
        kind === "video"
          ? "You are the only one here. Anyone in this group can join from the same button."
          : "Waiting for them to answer…"
      }</span>`;
    } else {
      notice.hidden = true;
    }

    /* A call that will not connect is much easier to fix when the panel says
       what ICE actually gathered: a direct address, a public address, or a
       relay. "Failed" alone is not a diagnosis. */
    const relay = state.relay || { kind: "none" };
    const cand = state.candidates || { host: 0, srflx: 0, relay: 0 };
    const gathered = `host ${cand.host || 0} · public ${cand.srflx || 0} · relay ${cand.relay || 0}`;
    diag.hidden = !(state.status === "live" || state.status === "failed" || peerCount > 0);
    if (!diag.hidden) {
      diag.innerHTML =
        `<span>${icon("activity", { size: 12 })}Relay: <b>${esc(relay.kind)}</b> · ICE ${esc(gathered)}</span>` +
        (relay.kind === "none"
          ? `<span class="call-diag-hint">Direct connections only — across two different networks this needs a relay.</span>`
          : "") +
        `<button class="btn btn-ghost btn-sm" type="button" data-call-copy>Copy</button>`;
    }

    /* Level meter on your own voice tile. A silent call looks like a broken
       call, so seeing the meter move is the fastest proof the microphone works. */
    if (kind === "voice") {
      clearInterval(levelTimer);
      levelTimer = setInterval(() => {
        const level = call.ownLevel?.() ?? 0;
        const node = stage.querySelector('[data-tile="self"] .call-avatar');
        if (node) {
          node.style.setProperty("--level", String(Math.min(1, level * 3)));
          node.classList.toggle("is-speaking", level > 0.06);
        }
      }, 180);
    }
  }

  call.setListener(paint);
  watchInvite();

  on(muteBtn, "click", () => call.toggleMute());
  if (cameraBtn) {
    on(cameraBtn, "click", () => {
      if (!call.toggleCamera()) {
        notice.hidden = false;
        notice.className = "call-notice";
        notice.innerHTML = `${icon("info", { size: 14 })}<span>This call started without a camera, so there is nothing to switch on.</span>`;
      }
    });
  }
  const screenBtn = qs("[data-call-screen]", wrap);
  if (screenBtn) {
    on(screenBtn, "click", async () => {
      try {
        const sharing = await call.toggleScreenShare();
        screenBtn.setAttribute("aria-pressed", String(sharing));
        qs("span", screenBtn).textContent = sharing ? "Stop sharing" : "Share";
      } catch (error) {
        toastError(error);
      }
    });
  }

  const flipBtn = qs("[data-call-flip]", wrap);
  if (flipBtn) {
    on(flipBtn, "click", async () => {
      const facing = await call.switchCamera();
      /* No second camera is a fact about the device, not an error. */
      if (facing === "environment") {
        toast({ title: "Back camera", message: "Using the rear camera." });
      } else if (facing === "user") {
        toast({ title: "Front camera", message: "Using the front camera." });
      } else {
        toast({ title: "One camera", message: "This device does not report a second camera to switch to." });
      }
    });
  }

  /* Double-click or the tile button puts a remote video full screen. */
  delegate(stage, "click", "[data-tile-fullscreen]", async (event, button) => {
    const tile = button.closest("[data-tile]");
    const video = tile?.querySelector("video");
    if (!video) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await (video.requestFullscreen?.() || tile.requestFullscreen?.());
    } catch {
      /* iOS refuses element fullscreen; the tile is already as large as it gets */
    }
  });
  delegate(stage, "dblclick", ".call-video", async (event, video) => {
    if (video.closest("[data-tile]")?.getAttribute("data-tile") === "self") return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await (video.requestFullscreen?.() || video.closest(".call-tile")?.requestFullscreen?.());
    } catch {
      /* not supported here */
    }
  });

  on(leaveBtn, "click", () => {
    announceMissed();
    call.leave("You left the call.");
  });

  delegate(notice, "click", "[data-call-retry]", async (event, button) => {
    button.disabled = true;
    button.textContent = "Retrying…";
    try {
      /* `join` re-requests the device, so a permission granted in the meantime
         takes effect without reopening the panel. */
      await call.join({ audioOnly: kind === "voice" });
    } catch (error) {
      if (!notice.textContent.includes("Retry")) {
        notice.innerHTML = `${icon("triangle-alert", { size: 14 })}<span>${esc(
          error?.message || "Still not connecting."
        )}</span><button class="btn btn-secondary btn-sm" type="button" data-call-retry>Retry</button>`;
      }
    } finally {
      button.disabled = false;
      button.textContent = "Retry";
    }
  });
  delegate(diag, "click", "[data-call-copy]", async () => {
    const state = call.state;
    const report = [
      `relay: ${state.relay?.kind || "none"}${state.relay?.reason ? ` (${state.relay.reason})` : ""}`,
      `ice: host ${state.candidates?.host || 0}, public ${state.candidates?.srflx || 0}, relay ${state.candidates?.relay || 0}`,
      `status: ${state.status}`,
      `peers: ${state.peers?.length || 0}`,
      `kind: ${state.kind}`,
      `error: ${state.error || "-"}`
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      toast({ title: "Copied", message: "Paste this wherever you are reporting the call." });
    } catch {
      toastError(new Error("The clipboard is blocked in this browser."));
    }
  });

  on(qs("[data-call-minimise]", wrap), "click", () => {
    minimised = !minimised;
    wrap.classList.toggle("is-minimised", minimised);
    qs("[data-call-minimise]", wrap).setAttribute(
      "aria-label",
      minimised ? "Expand the call panel" : "Minimise the call panel"
    );
  });

  /* ------------------------------------------------------- invite outcomes
     The other side of a ring. Declining, answering and ignoring all end in a
     different state for the caller, and a panel that shows "waiting…" for all
     three is a panel that leaves somebody ringing a phone that was put down. */
  async function inviteState() {
    const topic = call.state.topic;
    if (!topic || !/^call-(dm|group):/.test(topic)) return null;
    if (!sb) return null;
    const { data, error } = await sb.rpc("call_invite_state", { p_topic: topic });
    if (error) return null;
    return data?.found ? data : null;
  }

  function watchInvite() {
    clearInterval(inviteTimer);
    inviteTimer = setInterval(async () => {
      const state = call.state;
      const waiting = state.peers.length === 0 && !["ended", "failed"].includes(state.status);
      if (!waiting) return;
      const info = await inviteState();
      if (!info) return;
      const declined = info.declined || [];
      const accepted = info.accepted || [];
      if (accepted.length || declined.length === 0) return;
      /* Somebody said no, and nobody has said yes. Say it plainly; offer the
         retry the caller would want (a second invite is a new ring). */
      notice.hidden = false;
      notice.className = "call-notice";
      notice.innerHTML = `${icon("phone-missed", { size: 14 })}<span>${esc(
        declined.map((person) => person.name).join(", ")
      )} declined. Nobody else is ringing.</span>`;
    }, 5000);
  }

  /**
   * The caller hung up and nobody ever answered.
   *
   * Writing a missed call is the only honest record for the person who was
   * rung — otherwise they open the app later, see nothing, and cannot tell
   * whether they missed somebody.
   */
  async function announceMissed() {
    const topic = call.state.topic;
    if (!topic || !/^call-(dm|group):/.test(topic) || !sb) return;
    try {
      const { data, error } = await sb.rpc("call_invite_state", { p_topic: topic });
      if (error || !data?.found) return;
      if (data.startedBy !== self.userId) return;
      if ((data.accepted || []).length) return;
      await sb.rpc("call_invite_missed", { p_topic: topic });
    } catch {
      /* a missed-call notice is a courtesy, never a reason to block a hang-up */
    }
  }

  timer = setInterval(() => {
    const { status, startedAt } = call.state;
    if (status === "live" && startedAt) timerEl.textContent = formatDuration(Date.now() - startedAt);
    if (status === "ended") {
      timerEl.textContent = "ended";
      setTimeout(() => destroy(), 1400);
    }
  }, 500);

  function destroy() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    clearInterval(timer);
    clearInterval(inviteTimer);
    clearInterval(levelTimer);
    call.setListener(null);
    call.leave("The call ended.");
    wrap.remove();
    try {
      setActiveCallTopic(null);
    } catch {
      /* notifications not initialised on this page */
    }
    if (active && active.destroy === destroy) active = null;
    onClose();
  }

  active = { destroy };
  return { destroy, element: wrap };
}

