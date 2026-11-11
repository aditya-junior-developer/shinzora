/* ==========================================================================
   Shinzora — two real browsers, one real WebRTC call
   --------------------------------------------------------------------------
   "Meeting video call not working." The room opened and no media ever flowed.
   Three signalling faults explain that without any relay being involved:

     1. glare — both sides offered at once, so both sat in "have-local-offer";
     2. ICE candidates applied before the remote description existed, which the
        browser rejects and the old code swallowed, so each side threw away the
        other's addresses;
     3. an answer applied in the wrong signalling state.

   None of that is visible in a unit test, and mocking RTCPeerConnection would
   only test the mock. So this harness runs **two real Chromium pages**, each
   running the real `webrtc.js`, with a fake Chromium camera and microphone, and
   a Realtime stand-in that ferries the broadcast messages between them. The
   only thing faked is the socket; the negotiation, SDP and ICE are real.

     node tests/call-negotiation.mjs          # needs a browser, not in npm test
   ========================================================================== */

import { chromium } from "playwright-core";
import * as esbuild from "esbuild";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/* Bundle the real engine, swapping only the Supabase module for a socket
   stand-in. Everything else — the negotiation, the peer connections, the media
   tracks — is production code. */
const STUB = `
  export const normalizeError = (error) => error;
  export const sb = {
    channel: (topic) => window.__makeChannel(topic),
    removeChannel: () => Promise.resolve(),
    getChannels: () => window.__channels || [],
    functions: { invoke: async () => ({ data: { relay: "none", reason: "test", iceServers: [] }, error: null }) }
  };
`;

/* ENGINE lets the same harness run against an older engine, which is how the
   bugs this file exists for were confirmed rather than assumed. */
const ENGINE = process.env.ENGINE || "public/js/modules/messaging/webrtc.js";

const build = await esbuild.build({
  entryPoints: [path.isAbsolute(ENGINE) ? ENGINE : path.join(repo, ENGINE)],
  bundle: true,
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stub-supabase",
      setup(build) {
        build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "sb-stub", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: STUB, loader: "js" }));
      }
    }
  ]
});

const bundle = build.outputFiles[0].text;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>call</title></head><body>
<script type="module">
import { createCall } from "/engine.js";

/* The Realtime stand-in: same surface the engine uses (channel/on/subscribe/
   send/removeChannel), but every broadcast is handed to the harness, which
   delivers it to the other page. */
window.__channels = [];
window.__log = [];
window.__makeChannel = (topic) => {
  const channel = {
    topic,
    handlers: [],
    subscribed: false,
    on(kind, filter, handler) {
      if (this.subscribed) throw new Error("cannot add callbacks after subscribe()");
      this.handlers.push({ kind, filter, handler });
      return this;
    },
    subscribe(callback) {
      this.subscribed = true;
      callback?.("SUBSCRIBED");
      return this;
    },
    send(message) {
      window.__log.push({ dir: "out", event: message.event });
      window.__signal(message.event, message.payload);
    },
    deliver(event, payload) {
      for (const handler of this.handlers) {
        if (handler.kind === "broadcast" && (handler.filter.event === "*" || handler.filter.event === event)) {
          handler.handler({ event, payload });
        }
      }
    }
  };
  window.__channels.push(channel);
  return channel;
};

/* Incoming signals from the other page. */
window.__receive = (event, payload) => {
  window.__log.push({ dir: "in", event });
  for (const channel of window.__channels) channel.deliver(event, payload);
};

window.__call = null;
window.__start = async ({ kind, topic, name }) => {
  window.__call = createCall({
    kind,
    topic,
    title: "Harness",
    self: { userId: name, name },
    onState: () => {}
  });
  await window.__call.join({ audioOnly: kind === "voice" });
  return true;
};
window.__state = () => {
  const state = window.__call?.state;
  if (!state) return null;
  return {
    status: state.status,
    peers: [...state.peers.values()].map((peer) => ({
      name: peer.name,
      state: peer.state,
      connection: peer.connection?.connectionState,
      signalling: peer.connection?.signalingState,
      hasRemoteStream: Boolean(peer.stream && peer.stream.getTracks().length)
    })),
    candidates: state.candidates
  };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/engine.js")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundle);
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((done) => server.listen(4311, "0.0.0.0", done));

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

async function context() {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4311/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready);
  return { ctx, page, errors };
}

async function waitFor(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

/* Bridge pages' broadcasts to each other. A page can only expose `__signal`
   once, so listeners are registered and every outgoing message fans out to all
   of them — which is what a Realtime topic does for a room of three. */
const listeners = new WeakMap();
async function wire(page) {
  if (listeners.has(page)) return;
  const targets = new Set();
  listeners.set(page, targets);
  await page.exposeFunction("__signal", async (event, payload) => {
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

async function runCall({ kind, label }) {
  console.log(`\n${label} (${kind})`);
  const one = await context();
  const two = await context();
  await bridge(one.page, two.page);

  /* A joins first, waits; B joins second. That is the exact order that produced
     glare, and the order two people use in practice. */
  await one.page.evaluate(({ kind }) => window.__start({ kind, topic: "call-group:harness", name: "aaa" }), { kind });
  await new Promise((done) => setTimeout(done, 700));
  await two.page.evaluate(({ kind }) => window.__start({ kind, topic: "call-group:harness", name: "bbb" }), { kind });

  const connected = await waitFor(async () => {
    const [stateA, stateB] = await Promise.all([
      one.page.evaluate(() => window.__state()),
      two.page.evaluate(() => window.__state())
    ]);
    const live = (state) => state?.peers?.some((peer) => peer.connection === "connected");
    return live(stateA) && live(stateB);
  });

  const [stateA, stateB] = await Promise.all([
    one.page.evaluate(() => window.__state()),
    two.page.evaluate(() => window.__state())
  ]);

  check(connected, "both peers reach connectionState connected", JSON.stringify(stateA?.peers?.map((p) => p.connection)));
  check(
    stateA?.peers?.[0]?.hasRemoteStream && stateB?.peers?.[0]?.hasRemoteStream,
    "both peers hold a remote media stream",
    `A tracks=${stateA?.peers?.[0]?.hasRemoteStream} B tracks=${stateB?.peers?.[0]?.hasRemoteStream}`
  );
  check(
    (stateA?.candidates?.host || 0) > 0 && (stateB?.candidates?.host || 0) > 0,
    "both peers gathered ICE candidates",
    `A ${JSON.stringify(stateA?.candidates)} B ${JSON.stringify(stateB?.candidates)}`
  );
  check(stateA?.peers?.length === 1 && stateB?.peers?.length === 1, "one peer on each side, not two", `${stateA?.peers?.length}/${stateB?.peers?.length}`);
  check(!one.errors.length && !two.errors.length, "no page errors", [...one.errors, ...two.errors].slice(0, 2).join(" | "));

  /* A third device joining must not disturb the two already connected. */
  const three = await context();
  await Promise.all([bridge(three.page, one.page), bridge(three.page, two.page)]);
  await three.page.evaluate(({ kind }) => window.__start({ kind, topic: "call-group:harness", name: "ccc" }), { kind });
  const threeWay = await waitFor(async () => {
    const [a, b, c] = await Promise.all([
      one.page.evaluate(() => window.__state()),
      two.page.evaluate(() => window.__state()),
      three.page.evaluate(() => window.__state())
    ]);
    const full = (state) => state?.peers?.filter((peer) => peer.connection === "connected").length;
    return full(a) >= 2 && full(b) >= 2 && full(c) >= 2;
  }, 25000);
  check(threeWay, "a third participant connects to both of the others (mesh)");

  for (const { ctx } of [one, two, three]) await ctx.close();
}

await runCall({ kind: "video", label: "video meeting" });
await runCall({ kind: "voice", label: "voice call" });

await browser.close();
server.close();

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("\nTwo real browsers negotiated a real call: glare, candidate ordering and answers all correct.\n");
