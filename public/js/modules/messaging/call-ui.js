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
import { toastError } from "../../ui/toast.js";
import { joinRingtone, connectedTone, endedTone } from "./ringtone.js";

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

    <div class="call-stage" id="call-stage"></div>
    <div class="call-notice" id="call-notice" hidden></div>

    <footer class="call-controls">
      <button class="call-btn" type="button" data-call-mute aria-pressed="false" title="Microphone">
        ${icon("mic", { size: 16 })}<span>Mute</span>
      </button>
      ${
        kind === "video"
          ? `<button class="call-btn" type="button" data-call-camera aria-pressed="true" title="Camera">
               ${icon("video", { size: 16 })}<span>Camera</span>
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
  const notice = qs("#call-notice", wrap);
  const timerEl = qs("#call-timer", wrap);
  const muteBtn = qs("[data-call-mute]", wrap);
  const cameraBtn = qs("[data-call-camera]", wrap);
  const leaveBtn = qs("[data-call-leave]", wrap);
  let minimised = false;
  let timer = null;
  let levelTimer = null;

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
          ${muted ? `<span class="call-badge">muted</span>` : ""}
        </figcaption>
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
    if (state.status === "failed") {
      notice.hidden = false;
      notice.className = "call-notice is-bad";
      notice.innerHTML = `${icon("triangle-alert", { size: 14 })}<span>${esc(
        state.error || "The call could not connect."
      )}</span>`;
    } else if (state.status === "connecting") {
      notice.hidden = false;
      notice.className = "call-notice";
      notice.innerHTML = `${icon("loader-circle", { size: 14 })}<span>Connecting…</span>`;
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

  on(leaveBtn, "click", () => call.leave("You left the call."));
  on(qs("[data-call-minimise]", wrap), "click", () => {
    minimised = !minimised;
    wrap.classList.toggle("is-minimised", minimised);
    qs("[data-call-minimise]", wrap).setAttribute(
      "aria-label",
      minimised ? "Expand the call panel" : "Minimise the call panel"
    );
  });

  timer = setInterval(() => {
    const { status, startedAt } = call.state;
    if (status === "live" && startedAt) timerEl.textContent = formatDuration(Date.now() - startedAt);
    if (status === "ended") {
      timerEl.textContent = "ended";
      setTimeout(() => destroy(), 1400);
    }
  }, 500);

  function destroy() {
    clearInterval(timer);
    clearInterval(levelTimer);
    call.setListener(null);
    call.leave("The call ended.");
    wrap.remove();
    if (active && active.destroy === destroy) active = null;
    onClose();
  }

  active = { destroy };
  return { destroy, element: wrap };
}

/**
 * Listen for somebody else's call on one topic and offer a Join banner.
 *
 * The listener is a private Realtime channel, so the database checks membership
 * before it will deliver a single ring. It only runs while the surface that
 * cares about that topic is on screen — closing the tab stops the ringing,
 * which is the honest behaviour until push-based ringing exists.
 *
 * @returns {() => void} unsubscribe
 */
export function watchForCalls(sb, { topics, onRing }) {
  if (!sb || !topics?.length) return () => {};
  const channels = [];

  for (const topic of topics) {
    const channel = sb.channel(topic, { config: { private: true, broadcast: { self: false } } });
    channel.on("broadcast", { event: "hello" }, (message) => {
      const payload = message?.payload || {};
      if (!payload.from) return;
      onRing({ topic, kind: payload.kind || "voice", from: payload.from, name: payload.name || "Someone" });
    });
    channel.on("broadcast", { event: "bye" }, () => onRing({ topic, ended: true }));
    channel.subscribe();
    channels.push(channel);
  }

  return () => {
    for (const channel of channels) {
      try {
        sb.removeChannel(channel);
      } catch {
        /* already gone */
      }
    }
  };
}

/** The ringing banner. Returns a dismiss function. */
export function showRingBanner({ name, kind, groupName, onJoin, onDismiss, withSound = true }) {
  const node = document.createElement("div");
  node.className = "ring-banner";
  node.setAttribute("role", "alert");
  node.innerHTML = `
    <span class="ring-mark">${icon(kind === "video" ? "video" : "phone", { size: 16 })}</span>
    <div class="ring-copy">
      <div class="ring-title">${esc(name)} is calling</div>
      <div class="ring-sub">${esc(groupName || (kind === "video" ? "Video meeting" : "Voice call"))}</div>
    </div>
    <button class="btn btn-primary btn-sm" type="button" data-ring-join>Join</button>
    <button class="btn btn-ghost btn-sm" type="button" data-ring-dismiss aria-label="Dismiss">${icon("x", { size: 13 })}</button>`;
  document.body.append(node);

  const stopTone = withSound ? joinRingtone() : () => {};
  const close = () => {
    stopTone();
    node.remove();
    onDismiss?.();
  };

  on(qs("[data-ring-join]", node), "click", () => {
    stopTone();
    node.remove();
    onJoin?.();
  });
  on(qs("[data-ring-dismiss]", node), "click", close);

  /* Ringing forever is a nuisance; after 45 seconds it stops and says so. */
  const timeout = setTimeout(close, 45000);
  return () => {
    clearTimeout(timeout);
    close();
  };
}
