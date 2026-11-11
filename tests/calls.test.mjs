/* ==========================================================================
   Calls — the engine, driven against a fake browser
   --------------------------------------------------------------------------
   WebRTC cannot be exercised for real in Node: there is no camera, no
   microphone and no peer. What *can* be proven is everything the engine owns:

     • it asks for the microphone (and the camera only for a video call)
     • it opens a **private** Realtime channel on the right topic, so the
       database — not the page — decides who may join
     • it sends `hello` on join, offers to a peer that answers `here`, answers an
       offer, and forwards ICE candidates
     • muting actually disables the audio track and tells the peers
     • leaving closes every connection, stops every track and removes the
       channel
     • a refused channel is reported as a refused channel, not as a spinner

   The fake RTCPeerConnection below records what it was told to do, which is the
   contract the real one honours.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

let counter = 0;

async function bundle(entry) {
  const stub = {
    name: "call-stubs",
    setup(build) {
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: `
          export const sb = globalThis.__sb;
          export const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error?.message || error)));
        `,
        loader: "js"
      }));
    }
  };
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [stub]
  });
  const url =
    "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  return import(url);
}

/* ------------------------------------------------------------ fake browser */

function fakeTrack(kind) {
  return { kind, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

function installBrowser({ refuseSubscribe = false } = {}) {
  const log = { tracks: [], channels: [], offers: 0, answers: 0, ice: [] };

  const audio = fakeTrack("audio");
  const video = fakeTrack("video");
  log.tracks.push(audio, video);

  globalThis.navigator = {
    userAgent: "shinzora-test",
    mediaDevices: {
      getUserMedia: async (constraints) => {
        log.lastConstraints = constraints;
        const tracks = constraints.video ? [audio, video] : [audio];
        return { getTracks: () => tracks, getAudioTracks: () => [audio], getVideoTracks: () => (constraints.video ? [video] : []) };
      },
      getDisplayMedia: async () => ({ getVideoTracks: () => [fakeTrack("video")] })
    }
  };

  globalThis.MediaStream = class {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  };

  globalThis.RTCPeerConnection = class {
    constructor(config) {
      this.config = config;
      this.connectionState = "new";
      this.signalingState = "stable";
      this.senders = [];
      this.listeners = {};
    }
    addTrack(track) { this.senders.push({ track, replaceTrack: async (next) => { this.senders.find((s) => s === this.senders[0]); this.lastReplaced = next; } }); }
    getSenders() { return this.senders; }
    async createOffer() { log.offers += 1; return { type: "offer", sdp: "v=0 offer" }; }
    async createAnswer() { log.answers += 1; return { type: "answer", sdp: "v=0 answer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = "stable"; }
    async addIceCandidate(candidate) { log.ice.push(candidate); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    close() { this.connectionState = "closed"; }
  };
  globalThis.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
  globalThis.RTCIceCandidate = class { constructor(init) { Object.assign(this, init); } };

  /* A Realtime channel that records everything and lets the test inject
     broadcasts, exactly as the server would deliver them. */
  globalThis.__sb = {
    channel(topic, options) {
      const handlers = [];
      const channel = {
        topic,
        options,
        sent: [],
        status: null,
        on(_kind, filter, handler) { handlers.push({ filter, handler }); return channel; },
        send(message) { channel.sent.push(message); return Promise.resolve("ok"); },
        subscribe(cb) {
          log.channels.push(channel);
          setTimeout(() => {
            channel.status = refuseSubscribe ? "CHANNEL_ERROR" : "SUBSCRIBED";
            cb?.(channel.status);
          }, 0);
          return channel;
        },
        deliver(event, payload) {
          for (const { filter, handler } of handlers) {
            if (filter.event === "*" || filter.event === event) handler({ event, payload });
          }
        }
      };
      return channel;
    },
    removeChannel(channel) { channel.removed = true; }
  };

  return { log };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------- tests */

test("a video call opens a private channel and asks for camera and microphone", async () => {
  const { log } = installBrowser();
  const { createCall, callTopics } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));

  const call = createCall({
    kind: "video",
    topic: callTopics.group("11111111-1111-4111-8111-111111111111"),
    title: "Design team",
    self: { userId: "user-a", name: "Aditya" }
  });

  await call.join({ audioOnly: false });
  await settle();

  assert.equal(call.state.status, "live", "the call should be live");
  assert.equal(log.lastConstraints.video !== false, true, "a video call must ask for video");
  assert.equal(log.channels.length, 1, "exactly one channel");
  assert.equal(log.channels[0].topic, "call-group:11111111-1111-4111-8111-111111111111");
  assert.equal(log.channels[0].options?.config?.private, true, "the channel must be private so RLS applies");
  assert.ok(
    log.channels[0].sent.some((message) => message.event === "hello"),
    "joining must announce itself with hello"
  );
  call.leave();
});

test("a voice call never asks for the camera", async () => {
  const { log } = installBrowser();
  const { createCall, callTopics } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({
    kind: "voice",
    topic: callTopics.dm("22222222-2222-4222-8222-222222222222"),
    title: "Manglam",
    self: { userId: "user-a", name: "Aditya" }
  });
  await call.join({ audioOnly: true });
  await settle();
  assert.equal(log.lastConstraints.video, false, "a voice call must not request video");
  assert.equal(log.channels[0].topic, "call-dm:22222222-2222-4222-8222-222222222222");
  call.leave();
});

test("a peer who says hello gets an offer, and an offer gets an answer", async () => {
  const { log } = installBrowser();
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({
    kind: "video",
    topic: "call-group:abc",
    title: "Room",
    self: { userId: "user-a", name: "Aditya" }
  });
  await call.join({ audioOnly: false });
  await settle();
  const channel = log.channels[0];

  /* Somebody else joins and announces themselves: we offer. */
  channel.deliver("hello", { from: "user-b", name: "Asha", kind: "video" });
  await settle();
  assert.equal(log.offers, 1, "the resident peer must offer to the newcomer");
  const offer = channel.sent.find((message) => message.event === "offer" && message.payload.to === "user-b");
  assert.ok(offer, "the offer must be addressed to the peer");
  assert.ok(offer.payload.sdp, "the offer must carry an SDP");

  /* They answer, and their ICE arrives. */
  channel.deliver("answer", { from: "user-b", name: "Asha", sdp: { type: "answer", sdp: "v=0 remote" } });
  await settle();
  channel.deliver("ice", { from: "user-b", candidate: { candidate: "candidate:1" } });
  await settle();
  assert.equal(log.ice.length, 1, "the ICE candidate must reach the connection");
  call.leave();
});

test("an offer from a peer is answered rather than ignored", async () => {
  const { log } = installBrowser();
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-group:x", title: "Room", self: { userId: "user-a", name: "Aditya" } });
  await call.join({ audioOnly: true });
  await settle();
  const channel = log.channels[0];

  channel.deliver("offer", { from: "user-b", name: "Asha", sdp: { type: "offer", sdp: "v=0 remote offer" } });
  await settle();

  assert.equal(log.answers, 1, "an incoming offer must be answered");
  assert.ok(
    channel.sent.some((message) => message.event === "answer"),
    "the answer must be sent back"
  );
  call.leave();
});

test("mute disables the real track and tells the other peers", async () => {
  const { log } = installBrowser();
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-group:m", title: "Room", self: { userId: "user-a", name: "Aditya" } });
  await call.join({ audioOnly: true });
  await settle();
  const channel = log.channels[0];

  const audio = log.tracks[0];
  assert.equal(audio.enabled, true, "the track starts enabled");

  call.toggleMute();
  assert.equal(call.state.muted, true);
  assert.equal(audio.enabled, false, "muting must disable the track, not just the icon");
  assert.ok(channel.sent.some((message) => message.event === "mute" && message.payload.muted === true));

  call.toggleMute();
  assert.equal(audio.enabled, true, "unmuting must re-enable it");
  call.leave();
});

test("leaving stops the microphone, closes peers and removes the channel", async () => {
  const { log } = installBrowser();
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "video", topic: "call-group:leave", title: "Room", self: { userId: "user-a", name: "Aditya" } });
  await call.join({ audioOnly: false });
  await settle();
  const channel = log.channels[0];
  channel.deliver("hello", { from: "user-b", name: "Asha" });
  await settle();

  call.leave();

  assert.equal(call.state.status, "ended");
  assert.equal(log.tracks.every((track) => track.stopped), true, "every capture track must be stopped");
  assert.equal(channel.removed, true, "the realtime channel must be removed");
  assert.ok(channel.sent.some((message) => message.event === "bye"), "peers must be told");
});

test("a refused channel is reported as refusal, not left connecting", async () => {
  installBrowser({ refuseSubscribe: true });
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-group:refused", title: "Room", self: { userId: "x", name: "X" } });

  await assert.rejects(() => call.join({ audioOnly: true }), /refused/i);
  assert.equal(call.state.status, "failed");
  assert.match(String(call.state.error), /member/, "the message must point at membership");
});

test("a refused microphone is explained in words a person can act on", async () => {
  installBrowser();
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error("denied");
    error.name = "NotAllowedError";
    throw error;
  };
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:x", title: "Call", self: { userId: "x", name: "X" } });
  /* No Permissions API in this fake browser, so the state is unknown and the
     message names the one action that always works: allow it in site settings,
     then retry. It must not say "permission was refused" as if it knows. */
  await assert.rejects(() => call.join({ audioOnly: true }), /Site settings/i);
});

test("the seventh peer is told the meeting is full instead of degrading it", async () => {
  const { log } = installBrowser();
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "video", topic: "call-group:full", title: "Room", self: { userId: "user-a", name: "A" } });
  await call.join({ audioOnly: false });
  await settle();
  const channel = log.channels[0];

  /* Six people say hello: each gets a connection, taking the room to its cap. */
  for (let index = 0; index < 6; index += 1) {
    channel.deliver("hello", { from: `peer-${index}`, name: `Peer ${index}` });
    await settle(5);
  }
  const offersSoFar = log.offers;
  channel.deliver("hello", { from: "peer-7", name: "Seventh" });
  await settle();

  assert.equal(log.offers, offersSoFar, "the seventh peer must not get a connection");
  assert.equal(
    channel.sent.some((message) => message.event === "full" && message.payload.to === "peer-7"),
    true,
    "and must be told why"
  );
  call.leave();
});

test("ICE servers include STUN, and TURN only when configured", async () => {
  installBrowser();
  const { iceServers } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const servers = iceServers();
  assert.ok(servers.some((server) => String(server.urls).includes("stun:")), "public STUN must always be present");
  assert.equal(servers.length, 1, "no TURN until one is configured — the UI says so");
});

/* ---------------------------------------------------- the permission message */

/**
 * The bug this covers: "Microphone or camera permission was refused" was shown
 * to people who had already allowed it. The cause was a blanket mapping of
 * `NotAllowedError` onto "you refused" — which also describes a tab loaded
 * before the grant, a blocked frame, and a page whose policy forbids capture.
 * Each of those now gets its own words, because each has a different fix.
 */

function refuseWith(permissionState) {
  installBrowser();
  globalThis.navigator.permissions = {
    query: async ({ name }) => ({ state: typeof permissionState === "function" ? permissionState(name) : permissionState })
  };
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";
    throw error;
  };
}

test("permission granted but the tab predates it asks for a reload, not a settings change", async () => {
  refuseWith("granted");
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:stale", title: "Call", self: { userId: "x", name: "X" } });

  const message = await call.join({ audioOnly: true }).then(
    () => "",
    (error) => String(error.message)
  );
  assert.match(message, /already allows the microphone/, "it says the permission is already on");
  assert.match(message, /[Rr]eload/, "and the fix is a reload");
  assert.doesNotMatch(message, /refused/i, "it must not accuse the user of refusing it");
});

test("a denied permission points at site settings", async () => {
  refuseWith("denied");
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:denied", title: "Call", self: { userId: "x", name: "X" } });
  await assert.rejects(() => call.join({ audioOnly: true }), /blocked for this site/i);
});

test("a page that never showed the prompt is told to press Retry", async () => {
  refuseWith("prompt");
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:prompt", title: "Call", self: { userId: "x", name: "X" } });
  await assert.rejects(() => call.join({ audioOnly: true }), /Retry/);
});

test("a browser with no Permissions API still gets a message with a next step", async () => {
  installBrowser(); // navigator.permissions is deliberately absent, as in Safari
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error("denied");
    error.name = "NotAllowedError";
    throw error;
  };
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:safari", title: "Call", self: { userId: "x", name: "X" } });
  await assert.rejects(() => call.join({ audioOnly: true }), /Site settings/i);
});

test("a device held by another app is named as such, with Retry", async () => {
  installBrowser();
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error("Device in use");
    error.name = "NotReadableError";
    throw error;
  };
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:busy", title: "Call", self: { userId: "x", name: "X" } });
  await assert.rejects(() => call.join({ audioOnly: true }), /another app or tab/i);
});

test("a stream whose tracks ended is never handed back as if it were live", async () => {
  const { log } = installBrowser();
  let asked = 0;
  const real = globalThis.navigator.mediaDevices.getUserMedia;
  globalThis.navigator.mediaDevices.getUserMedia = async (constraints) => {
    asked += 1;
    return real(constraints);
  };
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:stale-stream", title: "Call", self: { userId: "x", name: "X" } });
  await call.join({ audioOnly: true });
  assert.equal(asked, 1);
  call.leave();
  assert.equal(log.tracks[0].stopped, true, "leaving stopped the microphone");

  const second = createCall({ kind: "voice", topic: "call-dm:stale-stream-2", title: "Call", self: { userId: "x", name: "X" } });
  await second.join({ audioOnly: true });
  assert.equal(asked, 2, "the second call asked the browser again rather than reusing a dead stream");
  second.leave();
});

test("the call object exposes what the browser said about the devices", async () => {
  refuseWith("granted");
  const { createCall } = await bundle(path.join(repo, "public/js/modules/messaging/webrtc.js"));
  const call = createCall({ kind: "voice", topic: "call-dm:state", title: "Call", self: { userId: "x", name: "X" } });
  assert.equal(typeof call.mediaState, "function", "mediaState is part of the call's contract");
  const state = await call.mediaState();
  assert.equal(state.microphone, "granted");
  assert.equal(state.camera, "granted");
  assert.equal(typeof state.secure, "boolean");
});
