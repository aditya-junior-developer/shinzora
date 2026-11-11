/* ==========================================================================
   Shinzora · Calls (WebRTC)
   --------------------------------------------------------------------------
   One engine for both kinds of call:

     voice   a one-to-one call inside a direct conversation. Audio only.
     video   a meeting inside a group. Every participant sends audio and video
             to every other participant (a mesh).

   Signalling goes over a Supabase Realtime **private** channel, so the database
   decides who may join: the policy in 0039 refuses any socket whose member is
   not in the group (topic `call-group:<id>`) or the conversation (topic
   `call-dm:<id>`). The audio and video never pass through Supabase — WebRTC
   sends them directly between browsers.

   Two honest limits, both surfaced in the UI rather than hidden:

     • A mesh is not a conference server. Six tiles is about what a browser and
       a home connection sustain; the room says so and refuses the seventh.
     • Without a TURN server, two peers behind strict carrier-grade NAT cannot
       connect. STUN alone covers most home and office networks. If the owner
       configures `SHINZORA_TURN_URL`/`USER`/`CREDENTIAL` the engine uses them
       automatically; until then a failed connection says it is a network
       problem and suggests a mobile hotspot, instead of spinning forever.
   ========================================================================== */

import { sb, normalizeError } from "../../lib/supabase.js";
import { env } from "../../config/env.js";

const MAX_PEERS = 6;

/** ICE servers: public STUN, plus TURN only when it has been configured. */
export function iceServers() {
  const servers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const url = env.turnUrl;
  if (url) {
    servers.push({
      urls: url.split(",").map((entry) => entry.trim()).filter(Boolean),
      username: env.turnUser || undefined,
      credential: env.turnCredential || undefined
    });
  }
  return servers;
}

export const turnConfigured = () => Boolean(env.turnUrl);

/**
 * @typedef {object} CallOptions
 * @property {"voice"|"video"} kind
 * @property {string} topic        `call-group:<uuid>` or `call-dm:<uuid>`
 * @property {string} title        shown on the call surface
 * @property {{userId:string,name:string,avatarUrl?:string}} self
 * @property {(state:object)=>void} onState
 */

/**
 * Create a call. Nothing is sent until `join()` is called, so the caller can
 * render the "calling…" surface first and cancel cleanly.
 */
export function createCall({ kind, topic, title, self, onState = () => {} }) {
  let listener = onState;
  const state = {
    kind,
    topic,
    title,
    status: "idle", // idle | connecting | live | ended | failed
    muted: false,
    cameraOn: kind === "video",
    screenSharing: false,
    peers: new Map(), // userId -> { name, stream, connection, state }
    startedAt: null,
    error: null,
    limitReached: false
  };

  /** @type {MediaStream|null} */
  let localStream = null;
  /** @type {import("supabase-js").RealtimeChannel|null} */
  let channel = null;
  /** Connections created before the socket was ready, flushed on join. */
  const pendingOffers = new Map();
  let closed = false;
  let statsTimer = null;
  let levelCtx = null;

  /* The panel that draws the call is mounted after the call object exists, so
     the listener has to be swappable. `setListener` also repaints immediately,
     which removes the first-frame flash of an empty stage. */
  const snapshot = () => ({
    ...state,
    peers: [...state.peers.entries()].map(([id, peer]) => ({ userId: id, ...peer, connection: undefined }))
  });
  const emit = () => listener(snapshot());

  const setStatus = (status, error = null) => {
    state.status = status;
    state.error = error;
    emit();
  };

  /* ------------------------------------------------------------- media */

  async function getMedia({ video }) {
    if (localStream) return localStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser cannot capture audio or video. Calls need an https address and a modern browser."
      );
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false
      });
    } catch (error) {
      const name = error?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error("Microphone or camera permission was refused. Allow it in the browser and try again.");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new Error(
          video
            ? "No camera was found. Start the call with the microphone only."
            : "No microphone was found on this device."
        );
      }
      if (name === "NotReadableError") {
        throw new Error("The microphone or camera is being used by another app or tab.");
      }
      throw new Error(error?.message || "The microphone could not be opened.");
    }
    return localStream;
  }

  /* ----------------------------------------------------------- peers */

  function peerEntry(userId, name = "Someone") {
    if (!state.peers.has(userId)) {
      state.peers.set(userId, { name, stream: null, connection: null, state: "new", remoteAudio: null });
    }
    return state.peers.get(userId);
  }

  function newConnection(userId, name) {
    const entry = peerEntry(userId, name);
    if (entry.connection) return entry.connection;

    const connection = new RTCPeerConnection({ iceServers: iceServers() });
    entry.connection = connection;

    for (const track of localStream?.getTracks() || []) connection.addTrack(track, localStream);

    connection.onicecandidate = (event) => {
      if (event.candidate) send("ice", { to: userId, candidate: event.candidate.toJSON() });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      entry.stream = stream || new MediaStream([event.track]);
      entry.state = "live";
      if (!stream) connection.addEventListener("track", () => emit());
      emit();
    };

    connection.onconnectionstatechange = () => {
      entry.state = connection.connectionState;
      emit();
      if (connection.connectionState === "failed") {
        /* One failed peer is a network problem between two people, not the end
           of the call: the others can still hear you. Say so on that tile. */
        entry.state = "failed";
        emit();
      }
    };

    return connection;
  }

  function send(event, payload) {
    if (!channel) return;
    channel.send({ type: "broadcast", event, payload: { ...payload, from: self.userId, name: self.name, kind: state.kind } });
  }

  async function callPeer(userId, name) {
    const connection = newConnection(userId, name);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    send("offer", { to: userId, sdp: connection.localDescription });
  }

  async function answerPeer(userId, name, sdp) {
    const connection = newConnection(userId, name);
    await connection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    send("answer", { to: userId, sdp: connection.localDescription });
    /* The newcomer already has our tracks; we need theirs, which arrive with the
       offer's transceivers once the answer is applied. */
  }

  /* ------------------------------------------------------- signalling */

  function bindChannel(ch) {
    ch.on("broadcast", { event: "*" }, (message) => {
      const payload = message?.payload || {};
      const from = payload.from;
      if (!from || from === self.userId) return;

      /* A private channel is already membership-checked by the database. This
         guard is about our own address book, not security. */
      if (payload.to && payload.to !== self.userId) return;

      const peer = peerEntry(from, payload.name || "Someone");

      if (message.event === "hello") {
        /* Somebody joined: tell them who is already here and offer to them. */
        send("here", { to: from });
        if (state.status === "live" || state.status === "connecting") {
          callPeer(from, peer.name).catch(() => {});
        }
        return;
      }

      if (message.event === "here") {
        /* We joined and found them first — offer, so exactly one side calls. */
        callPeer(from, peer.name).catch(() => {});
        return;
      }

      if (message.event === "offer") {
        answerPeer(from, peer.name, payload.sdp).catch((error) => {
          setStatus("failed", error?.message || "The connection could not be answered.");
        });
        return;
      }

      if (message.event === "answer") {
        const connection = peer.connection;
        if (connection && connection.signalingState !== "stable") {
          connection.setRemoteDescription(new RTCSessionDescription(payload.sdp)).catch(() => {});
        }
        return;
      }

      if (message.event === "ice") {
        const connection = peer.connection;
        if (connection && payload.candidate) {
          connection.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
        }
        return;
      }

      if (message.event === "bye") {
        leavePeer(from);
        return;
      }

      if (message.event === "mute") {
        peer.muted = Boolean(payload.muted);
        peer.cameraOn = payload.cameraOn !== false;
        emit();
      }
    });
  }

  function leavePeer(userId) {
    const entry = state.peers.get(userId);
    if (!entry) return;
    try {
      entry.connection?.close();
    } catch {
      /* already closed */
    }
    entry.stream?.getTracks?.().forEach((track) => track.stop());
    state.peers.delete(userId);
    emit();
  }

  /* ------------------------------------------------------------ api */

  async function join({ audioOnly = kind === "voice" } = {}) {
    if (closed) throw new Error("This call has already ended.");
    try {
      setStatus("connecting");
      await getMedia({ video: !audioOnly });

      if (!sb) throw new Error("Calls are not available right now.");
      channel = sb.channel(topic, { config: { private: true, broadcast: { self: false } } });
      bindChannel(channel);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The call channel did not open.")), 15000);
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            reject(
              new Error(
                "The call channel was refused. Check that you are still a member of this group or conversation."
              )
            );
          }
        });
      });

      state.startedAt = Date.now();
      setStatus("live");
      send("hello", {});

      /* Someone has to notice a peer that never connects, otherwise the call
         looks "live" while a tile stays black forever. */
      statsTimer = setInterval(() => {
        for (const [userId, entry] of state.peers) {
          if (entry.state === "failed") continue;
          const connection = entry.connection;
          if (!connection) continue;
          if (connection.connectionState === "disconnected" || connection.connectionState === "failed") {
            entry.state = connection.connectionState;
          }
        }
        flushPending();
      }, 4000);

      return state;
    } catch (error) {
      cleanup();
      setStatus("failed", normalizeError(error)?.message || error?.message || "The call could not start.");
      throw error;
    }
  }

  function flushPending() {
    for (const [userId, name] of pendingOffers) {
      if (state.status === "live") callPeer(userId, name).catch(() => {});
      pendingOffers.delete(userId);
    }
  }

  function toggleMute() {
    state.muted = !state.muted;
    localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !state.muted;
    });
    send("mute", { muted: state.muted, cameraOn: state.cameraOn });
    emit();
    return state.muted;
  }

  function toggleCamera() {
    const tracks = localStream?.getVideoTracks() || [];
    if (!tracks.length) return false;
    state.cameraOn = !state.cameraOn;
    tracks.forEach((track) => {
      track.enabled = state.cameraOn;
    });
    send("mute", { muted: state.muted, cameraOn: state.cameraOn });
    emit();
    return state.cameraOn;
  }

  /** Replace the outgoing video track with a screen share, and back again. */
  async function toggleScreenShare() {
    if (!localStream) return false;
    if (state.screenSharing) {
      await stopScreenShare();
      return false;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("This browser cannot share a screen.");
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const [screenTrack] = display.getVideoTracks();
    for (const entry of state.peers.values()) {
      const sender = entry.connection?.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(screenTrack);
    }
    state.screenSharing = true;
    screenTrack.addEventListener("ended", () => {
      stopScreenShare().catch(() => {});
    });
    emit();
    return true;
  }

  async function stopScreenShare() {
    const cameraTrack = localStream?.getVideoTracks()[0];
    for (const entry of state.peers.values()) {
      const sender = entry.connection?.getSenders().find((s) => s.track?.kind === "video");
      if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
    }
    state.screenSharing = false;
    emit();
  }

  /** Loudness of our own microphone, 0–1, for the level meter. */
  function ownLevel() {
    if (!localStream) return 0;
    try {
      const AnalyserCtor = window.AudioContext || window.webkitAudioContext;
      if (!AnalyserCtor) return 0;
      if (!levelCtx) {
        levelCtx = new AnalyserCtor();
        const source = levelCtx.createMediaStreamSource(localStream);
        const analyser = levelCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        levelCtx.__analyser = analyser;
      }
      const analyser = levelCtx.__analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
      return peak;
    } catch {
      return 0;
    }
  }

  function cleanup() {
    clearInterval(statsTimer);
    statsTimer = null;
    send("bye", {});
    for (const userId of [...state.peers.keys()]) leavePeer(userId);
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    if (channel && sb) {
      try {
        sb.removeChannel(channel);
      } catch {
        /* already gone */
      }
    }
    channel = null;
    try {
      levelCtx?.close();
    } catch {
      /* ignore */
    }
    levelCtx = null;
  }

  function leave(reason = "You left the call.") {
    if (closed) return;
    closed = true;
    cleanup();
    state.status = "ended";
    state.error = reason;
    state.peers.clear();
    emit();
  }

  return {
    state,
    setListener(fn) {
      listener = fn || (() => {});
      emit();
    },
    join,
    leave,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    ownLevel,
    getLocalStream: () => localStream,
    maxPeers: MAX_PEERS
  };
}

export const callTopics = {
  group: (groupId) => `call-group:${groupId}`,
  dm: (conversationId) => `call-dm:${conversationId}`
};
