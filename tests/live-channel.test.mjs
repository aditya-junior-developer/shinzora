/* ==========================================================================
   Channels that can be re-opened
   --------------------------------------------------------------------------
   Reported symptom: `cannot add postgres_changes callbacks for
   realtime:group-live:<uuid> after subscribe()`, and separately
   "The call channel did not open."

   Both come from one property of supabase-js: `channel(topic)` returns the
   channel already stored under that topic, and `removeChannel()` is
   asynchronous. So the sequence

       removeChannel(old)                 // starts closing
       channel('group-live:<id>')         // → the old channel, still subscribed
       .on('postgres_changes', ...)       // → throws

   is guaranteed to happen for anybody who clicks between two groups quickly.
   The fix is a helper that closes first, waits, then binds, then subscribes.
   These tests use a fake client that behaves exactly like supabase-js on that
   point — the fake returns the existing channel for a known topic and throws on
   `.on()` after subscribe — so the contract is enforced, not hoped for.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * Load the browser module through esbuild so it can run under node.
 *
 * The module keeps a registry of open channels at module scope, so every load
 * appends a unique marker: node caches identical `data:` URLs, and a cached
 * copy would carry one test's channels into the next one's registry.
 */
let instances = 0;
async function loadModule() {
  const result = await esbuild.build({
    entryPoints: [path.join(repo, "public/js/lib/live-channel.js")],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser"
  });
  instances += 1;
  const code = `${result.outputFiles[0].text}\n/* instance ${instances} */`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/**
 * A client that reproduces the two behaviours that caused the bug:
 *   • `channel(topic)` hands back the channel already stored under that topic
 *   • `removeChannel()` resolves later, so a channel keeps its topic for a while
 */
function fakeClient({ closeDelay = 12 } = {}) {
  const channels = [];
  const log = [];
  const client = {
    channel(topic) {
      const key = `realtime:${topic}`;
      const existing = channels.find((channel) => channel.topic === key && !channel.removed);
      if (existing) {
        log.push(["reused", key]);
        return existing;
      }
      const channel = {
        topic: key,
        handlers: [],
        subscribed: false,
        removed: false,
        on(kind, filter, handler) {
          if (this.subscribed) {
            throw new Error(`cannot add ${kind} callbacks for ${key} after subscribe()`);
          }
          this.handlers.push({ kind, filter, handler });
          log.push(["bind", key]);
          return this;
        },
        subscribe(callback) {
          this.subscribed = true;
          log.push(["subscribe", key]);
          callback?.("SUBSCRIBED");
          return this;
        }
      };
      channels.push(channel);
      log.push(["create", key]);
      return channel;
    },
    getChannels() {
      return channels.filter((channel) => !channel.removed);
    },
    removeChannel(channel) {
      return new Promise((resolve) => {
        setTimeout(() => {
          channel.removed = true;
          channel.subscribed = false;
          log.push(["remove", channel.topic]);
          resolve("ok");
        }, closeDelay);
      });
    }
  };
  return { client, channels, log };
}

const tick = (ms = 40) => new Promise((done) => setTimeout(done, ms));

test("switching topics quickly never re-binds a subscribed channel", async () => {
  const { openLiveChannel } = await loadModule();
  const { client, channels } = fakeClient();

  /* What a fast double-click between two groups does. */
  openLiveChannel(client, "group-live", {
    topic: "group-live:aaa",
    bind: (channel) => channel.on("postgres_changes", { table: "community_messages" }, () => {})
  });
  openLiveChannel(client, "group-live", {
    topic: "group-live:bbb",
    bind: (channel) => channel.on("postgres_changes", { table: "community_messages" }, () => {})
  });
  await tick();

  const live = channels.filter((channel) => !channel.removed);
  assert.equal(live.length, 1, "exactly one channel should survive the switch");
  assert.equal(live[0].topic, "realtime:group-live:bbb", "the newest topic wins");
  assert.equal(live[0].handlers.length, 1);
});

test("the old channel is closed before its replacement is created", async () => {
  const { openLiveChannel } = await loadModule();
  const { client, log } = fakeClient();

  openLiveChannel(client, "dm-live", {
    topic: "dm-live:one",
    bind: (channel) => channel.on("postgres_changes", { table: "team_chat_messages" }, () => {})
  });
  await tick();
  openLiveChannel(client, "dm-live", {
    topic: "dm-live:two",
    bind: (channel) => channel.on("postgres_changes", { table: "team_chat_messages" }, () => {})
  });
  await tick();

  const remove = log.findIndex(([what, topic]) => what === "remove" && topic === "realtime:dm-live:one");
  const create = log.findIndex(([what, topic]) => what === "create" && topic === "realtime:dm-live:two");
  assert.ok(remove >= 0, "the first channel was removed");
  assert.ok(create >= 0, "the second channel was created");
  assert.ok(remove < create, "removal lands before the next channel is made");
});

test("handlers are bound before subscribe, which is the only legal order", async () => {
  const { openLiveChannel } = await loadModule();
  const { client, log } = fakeClient();

  openLiveChannel(client, "notifications", {
    topic: "notifications:user-1",
    bind: (channel) => channel.on("postgres_changes", { table: "notifications" }, () => {})
  });
  await tick();

  const bind = log.findIndex(([what]) => what === "bind");
  const subscribe = log.findIndex(([what]) => what === "subscribe");
  assert.ok(bind >= 0 && subscribe >= 0);
  assert.ok(bind < subscribe, "bind must come first");
});

test("closing a channel frees its topic for the next join", async () => {
  const { closeLiveChannel, liveChannelCount, releaseTopic } = await loadModule();
  const { client, channels } = fakeClient();

  client.channel("call-group:room").on("broadcast", { event: "hello" }, () => {}).subscribe();
  assert.equal(channels.length, 1);

  /* releaseTopic-style close, awaited: the topic must be reusable afterwards. */
  await releaseTopic(client, "call-group:room");
  assert.equal(client.getChannels().length, 0, "the topic is free again");

  const reused = client.channel("call-group:room");
  assert.notEqual(reused, channels[0], "a fresh channel object, not the closed one");
  assert.doesNotThrow(() => reused.on("broadcast", { event: "hello" }, () => {}));

  await closeLiveChannel("nothing-open");
  assert.equal(liveChannelCount(), 0);
});

test("a superseded request never resurrects a channel for a group already left", async () => {
  const { openLiveChannel, liveChannelCount } = await loadModule();
  const { client, channels } = fakeClient({ closeDelay: 20 });

  const first = openLiveChannel(client, "group-live", {
    topic: "group-live:old",
    bind: (channel) => channel.on("postgres_changes", { table: "community_messages" }, () => {})
  });
  await tick(5);
  /* Leaving the group before the first channel even exists. */
  await first.close();
  await tick();

  assert.equal(channels.filter((channel) => !channel.removed).length, 0, "nothing is left subscribed");
  assert.equal(liveChannelCount(), 0);
});

/* --------------------------------------------------------------- the ring */

test("no page opens a second Realtime channel on a call's own topic", async () => {
  /* This was the direct cause of "The call channel did not open.": the group
     and DM screens subscribed to `call-group:<id>` / `call-dm:<id>` to hear a
     ring, then the call itself tried to join the very same topic. One socket
     cannot join one topic twice, so the call's channel never reached
     SUBSCRIBED and the 15-second timer produced that message. Ringing is a
     notification now (migration 0044) — no page needs its own call topic. */
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };
  const offenders = [];
  for (const file of await walk(path.join(repo, "public/js"))) {
    const source = await readFile(file, "utf8");
    if (file.endsWith("webrtc.js")) continue; // the call itself owns the topic
    if (file.endsWith("notify.js")) continue; // the banner lives here now
    if (/watchForCalls|showRingBanner/.test(source)) offenders.push(`${path.relative(repo, file)} (old call watcher)`);
    if (/channel\(\s*callTopics\./.test(source)) offenders.push(`${path.relative(repo, file)} (subscribes to a call topic)`);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("a call notification does not ring for the call this tab is already in", async () => {
  const notify = await readFile(path.join(repo, "public/js/ui/notify.js"), "utf8");
  assert.match(notify, /export function setActiveCallTopic/, "the surface can report the call it opened");
  const callBranch = notify.slice(notify.indexOf('row?.type === "call"'), notify.indexOf("if (isGroup)"));
  assert.match(callBranch, /activeCallTopic === meta\.callTopic/, "an open call on this topic stays silent");
  assert.match(callBranch, /ringShowing\(meta\.callTopic\)/, "a second notification does not start a second ring");
  assert.match(callBranch, /expires > Date\.now\(\)/, "a stale invite never rings");

  const surface = await readFile(path.join(repo, "public/js/modules/messaging/call-ui.js"), "utf8");
  assert.match(surface, /setActiveCallTopic\(call\.state\.topic\)/, "opening a call marks its topic");
  assert.match(surface, /setActiveCallTopic\(null\)/, "leaving it clears the mark");
});

/* --------------------------------------------------------- the negotiation */

test("ICE candidates are queued until there is a remote description", async () => {
  /* addIceCandidate() before setRemoteDescription() rejects with
     InvalidStateError; every rejection used to be swallowed, so each side threw
     away the other's addresses and the call showed tiles and carried nothing. */
  const engine = await readFile(path.join(repo, "public/js/modules/messaging/webrtc.js"), "utf8");
  assert.match(engine, /function queueCandidate/, "candidates are queued");
  assert.match(engine, /pendingCandidates\.push\(candidate\)/, "the queue is filled");
  assert.match(engine, /function flushCandidates/, "the queue is drained once a remote description exists");
  assert.match(engine, /await flushCandidates\(entry\)/, "drained when the remote description is applied");
  /* and never applied straight away */
  assert.equal(/\n\s*connection\.addIceCandidate\(new RTCIceCandidate\(payload\.candidate\)\)\.catch/.test(engine), false,
    "no candidate is applied before the remote description exists");
});

test("only one side offers, so two peers cannot glare", async () => {
  const engine = await readFile(path.join(repo, "public/js/modules/messaging/webrtc.js"), "utf8");
  /* The newcomer waits for the offer instead of making one. */
  const here = engine.slice(engine.indexOf('message.event === "here"'), engine.indexOf('message.event === "offer"'));
  assert.match(here, /fallbackTimer/, "the newcomer waits, with a fallback");
  /* Any offer the newcomer makes has to be inside the fallback timer. */
  const firstOffer = here.search(/callPeer\(/);
  const timer = here.search(/setTimeout\(/);
  assert.ok(firstOffer > 0, "the newcomer can still offer eventually");
  assert.ok(timer > 0 && timer < firstOffer, "but only after the fallback delay");
  /* And a peer with an offer in flight cannot make another. */
  assert.match(engine, /if \(entry\.offered \|\| entry\.answered\) return;/, "one offer per peer");
});

test("the call asks the server for a relay before building a peer connection", async () => {
  const engine = await readFile(path.join(repo, "public/js/modules/messaging/webrtc.js"), "utf8");
  const joinIndex = engine.indexOf("await prepareRelay()");
  const channelIndex = engine.indexOf("channel = sb.channel(topic");
  assert.ok(joinIndex > 0, "prepareRelay is called in join()");
  assert.ok(channelIndex > joinIndex, "and before the channel and the peer connections exist");
  assert.match(engine, /functions\.invoke\("turn-credentials"/, "the relay comes from the turn-credentials function");
  assert.match(engine, /stun:stun\.cloudflare\.com:3478/, "more than one STUN resolver");
});
