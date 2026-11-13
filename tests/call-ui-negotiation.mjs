/* ==========================================================================
   Shinzora — three real browsers, one real call panel
   --------------------------------------------------------------------------
   The unit suites prove the database rules and the ring banner's markup. What
   they cannot prove is that pressing a button in the call panel does anything
   to a microphone, a camera or a peer connection — and "the buttons are dead"
   is one of the things that was actually reported.

   So this harness runs **three real Chromium pages**, each with a fake camera
   and microphone, each loading the production `webrtc.js` and `call-ui.js`.
   Only the socket is faked (a Realtime stand-in that ferries broadcasts and
   presence between the pages). Everything else is the shipping code:

     • A mutes      → the real outbound audio track is disabled, and B and C
                      see "muted" in their participant list
     • A hides      → the real video track is disabled, and B and C see the
        the camera    camera flag drop
     • B and C join → A's participant list says three people
     • A leaves     → the tiles disappear on B and C, and the peer list shrinks

     node tests/call-ui-negotiation.mjs        # needs a browser; not in npm test
   ========================================================================== */

import { chromium } from "playwright-core";
import * as esbuild from "esbuild";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/* The Realtime stand-in. Broadcast and presence both go through the harness;
   RPC answers are canned, because the database behaviour is covered by the
   PGlite suite. */
const STUB = `
  export const normalizeError = (error) =>
    error instanceof Error ? error : new Error(String(error?.message || error));
  export const sb = {
    rpc: async (name) => {
      window.__rpcCalls = window.__rpcCalls || [];
      window.__rpcCalls.push(name);
      if (name === "call_invite_state") {
        return { data: { found: true, startedBy: "nobody", accepted: [], declined: [] }, error: null };
      }
      return { data: {}, error: null };
    },
    channel: (topic) => window.__makeChannel(topic),
    removeChannel: (channel) => { window.__channels = (window.__channels || []).filter((c) => c !== channel); return Promise.resolve(); },
    getChannels: () => window.__channels || [],
    functions: { invoke: async () => ({ data: { relay: "none", reason: "test", iceServers: [] }, error: null }) }
  };
`;

const ENTRY = `
  export { createCall, callTopics } from "./public/js/modules/messaging/webrtc.js";
  export { openCallSurface } from "./public/js/modules/messaging/call-ui.js";
`;

const build = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: repo, sourcefile: "call-ui-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "sb-stub", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: STUB, loader: "js" }));
      }
    }
  ]
});
const bundle = build.outputFiles[0].text;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>call ui</title>
<link rel="stylesheet" href="/theme.css">
</head><body><div id="app"></div>
<script type="module">
import { createCall, openCallSurface } from "/engine.js";

window.__channels = [];
window.__presence = {};
window.__rpcCalls = [];
window.__me = "nobody";
window.__call = null;

window.__makeChannel = (topic) => {
  const channel = {
    topic,
    handlers: [],
    presenceHandlers: [],
    subscribed: false,
    on(kind, filter, handler) {
      if (this.subscribed) throw new Error("cannot add callbacks after subscribe()");
      if (kind === "presence") this.presenceHandlers.push(handler);
      else this.handlers.push({ kind, filter, handler });
      return this;
    },
    subscribe(callback) {
      this.subscribed = true;
      callback?.("SUBSCRIBED");
      return this;
    },
    send(message) {
      window.__signal(message.event, message.payload);
      return Promise.resolve("ok");
    },
    track(data) {
      window.__presence[window.__me] = data;
      window.__signal("__presence", { from: window.__me, data });
      return Promise.resolve("ok");
    },
    presenceState() {
      /* One entry per member, in the shape supabase-js returns: topic → [metas] */
      return { [topic]: Object.values(window.__presence) };
    },
    deliver(event, payload) {
      for (const handler of this.handlers) {
        if (handler.kind === "broadcast" && (handler.filter.event === "*" || handler.filter.event === event)) {
          handler.handler({ event, payload });
        }
      }
    },
    syncPresence() {
      for (const handler of this.presenceHandlers) handler({ event: "sync" });
    }
  };
  window.__channels.push(channel);
  return channel;
};

window.__receive = (event, payload) => {
  if (event === "__presence") {
    window.__presence[payload.from] = payload.data;
    for (const channel of window.__channels) channel.syncPresence();
    return;
  }
  for (const channel of window.__channels) channel.deliver(event, payload);
};

window.__start = async ({ kind, topic, name, me, openPanel }) => {
  window.__me = me;
  window.__call = createCall({ kind, topic, title: "Harness", self: { userId: me, name }, onState: () => {} });
  if (openPanel) {
    openCallSurface({
      call: window.__call,
      self: { userId: me, name },
      subtitle: "Harness call"
    });
  }
  await window.__call.join({ audioOnly: kind === "voice" });
  return true;
};

window.__snap = () => {
  const surface = document.querySelector(".call-surface");
  const state = window.__call?.state;
  const local = window.__call?.getLocalStream?.();
  return {
    status: state?.status,
    hasSurface: Boolean(surface),
    tiles: [...document.querySelectorAll(".call-tile")].map((tile) => tile.getAttribute("data-tile")),
    people: [...document.querySelectorAll(".call-person-name")].map((node) => node.textContent.trim()),
    peopleHead: document.querySelector(".call-people-head")?.textContent.trim() || "",
    localAudioEnabled: local?.getAudioTracks?.().map((track) => track.enabled) || [],
    localVideoEnabled: local?.getVideoTracks?.().map((track) => track.enabled) || [],
    /* state.peers is a Map keyed by user id. */
    remoteTracks: [...(state?.peers?.values?.() || [])].map((peer) => ({
      name: peer.name,
      connection: peer.connection?.connectionState,
      hasRemoteAudio: Boolean(peer.stream?.getAudioTracks?.().length),
      hasRemoteVideo: Boolean(peer.stream?.getVideoTracks?.().length)
    })),
    peers: state?.peers?.size ?? 0,
    others: (state?.others || []).map((person) => ({ name: person.name, muted: person.muted, cameraOn: person.cameraOn })),
    rpcCalls: window.__rpcCalls
  };
};

window.__click = (selector) => {
  const node = document.querySelector(selector);
  if (!node) throw new Error("no element " + selector);
  node.click();
  return true;
};

window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/engine.js")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundle);
  }
  if (req.url.startsWith("/theme.css")) {
    /* The panel's layout tokens, so the DOM the surface builds is the real one. */
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(readThemeCss());
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});

function readThemeCss() {
  /* Only what the panel needs to exist and lay out; appearance is covered by
     the visual/theme suites. */
  return `:root{--s-2:8px;--s-3:12px;--s-4:16px;--s-5:20px;--r-sm:6px;--r-md:10px;--r-lg:14px;
    --line:rgba(255,255,255,.12);--line-violet:#7c3aed;--line-violet-soft:rgba(124,58,237,.5);
    --panel:#141218;--panel-2:#1b1822;--panel-3:#241f2e;--text:#f5f3ff;--text-2:#cfc9e0;--text-3:#a79fc0;
    --fs-sm:13px;--fs-xs:12px;--fs-2xs:11px;--grad-brand:linear-gradient(135deg,#7c3aed,#a855f7);
    --grad-panel:#141218;--lavender:#c4b5fd;--shadow-md:0 8px 24px rgba(0,0,0,.4);--shadow-lg:0 20px 50px rgba(0,0,0,.5);
    --shadow-inset-top:none;font-family:system-ui}
    body{margin:0;background:#0b0910;color:#f5f3ff}
    .call-surface{position:fixed;right:16px;bottom:16px;width:560px;border:1px solid #7c3aed;border-radius:14px;background:#141218;color:#f5f3ff}
    .call-stage{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;padding:12px}
    .call-tile{position:relative;aspect-ratio:4/3;border:1px solid rgba(255,255,255,.12);border-radius:10px;overflow:hidden;display:grid;place-items:center}
    .call-video{width:100%;height:100%;object-fit:cover;background:#000}
    .call-people{padding:12px}
    .call-people-list{list-style:none;margin:0;padding:0}
    .call-btn{display:inline-flex;gap:6px;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#1b1822;color:#f5f3ff;cursor:pointer}
    .call-notice,.call-diag{font-size:11px;padding:6px 12px}
    .call-people-head{font-size:10px;text-transform:uppercase}`;
}

await new Promise((done) => server.listen(4312, "0.0.0.0", done));

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required"
  ]
});

const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const contexts = [];
async function session() {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4312/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready);
  contexts.push({ ctx, page, errors });
  return { ctx, page, errors };
}

async function waitFor(predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, 200));
  }
  return false;
}

/* Broadcasts and presence fan out to every other page on the same topic. */
const listeners = new WeakMap();
const peers = new Map();
async function wire(page) {
  if (listeners.has(page)) return;
  const targets = new Set();
  listeners.set(page, targets);
  await page.exposeFunction("__signal", async (event, payload) => {
    if (process.env.TRACE) console.log("   signal", event, "→", targets.size, "target(s)");
    await Promise.all(
      [...targets].map((target) =>
        target.evaluate(([event, payload]) => window.__receive(event, payload), [event, payload]).catch(() => {})
      )
    );
  });
}
async function bridge(a, b) {
  await Promise.all([wire(a), wire(b)]);
  listeners.get(a).add(b);
  listeners.get(b).add(a);
}

const snap = (page) => page.evaluate(() => window.__snap());
const start = (page, options) => page.evaluate((o) => window.__start(o), options);
const click = (page, selector) => page.evaluate((s) => window.__click(s), selector);

console.log("\nthree browsers, one video call panel");

const A = await session();
const B = await session();
const C = await session();
await bridge(A.page, B.page);
await bridge(A.page, C.page);
await bridge(B.page, C.page);

/* A opens the panel and starts the call — this is the caller's path. */
await start(A.page, { kind: "video", topic: "call-group:ui", name: "Asha", me: "aaa", openPanel: true });
await new Promise((done) => setTimeout(done, 500));
const aOpen = await snap(A.page);
check(aOpen.hasSurface, "the call panel opens for the caller");
check(aOpen.tiles.includes("self"), "the caller sees their own tile");
check(new RegExp("1 in the call").test(aOpen.peopleHead), "the participant list counts the caller", aOpen.peopleHead);

await start(B.page, { kind: "video", topic: "call-group:ui", name: "Ravi", me: "bbb", openPanel: true });
await new Promise((done) => setTimeout(done, 400));
await start(C.page, { kind: "video", topic: "call-group:ui", name: "Meera", me: "ccc", openPanel: true });

const threeWay = await waitFor(async () => {
  const [a, b, c] = await Promise.all([snap(A.page), snap(B.page), snap(C.page)]);
  const connected = (s) => s.remoteTracks.filter((peer) => peer.connection === "connected").length;
  return connected(a) >= 2 && connected(b) >= 2 && connected(c) >= 2;
});
check(threeWay, "all three peer connections reach connected");

const [a1, b1, c1] = await Promise.all([snap(A.page), snap(B.page), snap(C.page)]);
check(
  a1.remoteTracks.every((peer) => peer.hasRemoteAudio && peer.hasRemoteVideo),
  "two-way audio and two-way video on every leg",
  JSON.stringify(a1.remoteTracks)
);
check(a1.tiles.length === 3 && b1.tiles.length === 3 && c1.tiles.length === 3, "every panel shows three tiles", `${a1.tiles.length}/${b1.tiles.length}/${c1.tiles.length}`);
check(
  /3 in the call/.test(a1.peopleHead) && /3 in the call/.test(b1.peopleHead),
  "the participant list shows all three people",
  `${a1.peopleHead} / ${b1.peopleHead}`
);

/* --- mute ---------------------------------------------------------------- */
await click(A.page, "[data-call-mute]");
const muted = await waitFor(async () => {
  const [a, b] = await Promise.all([snap(A.page), snap(B.page)]);
  return a.localAudioEnabled.every((on) => on === false) && b.others.some((person) => person.name === "Asha" && person.muted);
}, 8000);
check(muted, "mute silences the real outbound audio track and reaches the others' list");

await click(A.page, "[data-call-mute]");
const unmuted = await waitFor(async () => {
  const [a, b] = await Promise.all([snap(A.page), snap(B.page)]);
  return a.localAudioEnabled.every((on) => on === true) && b.others.some((person) => person.name === "Asha" && !person.muted);
}, 8000);
check(unmuted, "unmute turns it back on");

/* --- camera -------------------------------------------------------------- */
await click(A.page, "[data-call-camera]");
const cameraOff = await waitFor(async () => {
  const [a, c] = await Promise.all([snap(A.page), snap(C.page)]);
  return a.localVideoEnabled.every((on) => on === false) && c.others.some((person) => person.name === "Asha" && person.cameraOn === false);
}, 8000);
check(cameraOff, "camera off disables the real video track and shows on the others' list");

await click(A.page, "[data-call-camera]");
const cameraOn = await waitFor(async () => {
  const a = await snap(A.page);
  return a.localVideoEnabled.every((on) => on === true);
}, 8000);
check(cameraOn, "camera on turns it back on");

/* --- one participant leaves --------------------------------------------- */
await click(C.page, "[data-call-leave]");
const left = await waitFor(async () => {
  const [a, b] = await Promise.all([snap(A.page), snap(B.page)]);
  return a.peers === 1 && b.peers === 1;
}, 15000);
check(left, "leaving removes the peer for everyone else");

const afterLeave = await waitFor(async () => {
  const a = await snap(A.page);
  return !a.tiles.includes("ccc");
}, 8000);
check(afterLeave, "and the departed tile is gone from the panel");

check(
  A.errors.length === 0 && B.errors.length === 0 && C.errors.length === 0,
  "no page errors",
  [...A.errors, ...B.errors, ...C.errors].slice(0, 3).join(" | ")
);

for (const entry of contexts) await entry.ctx.close();
await browser.close();
server.close();

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("\nThe panel's buttons act on the real media: mute, camera, leave, participant list.\n");
