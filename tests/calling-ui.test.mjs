/* ==========================================================================
   Calling & meetings — the browser half
   --------------------------------------------------------------------------
   The database half is proven in tests/calling-meetings.test.mjs. What is left
   is the part the person actually touches, and it is where the reported
   defects lived:

     • "it rings but never connects" — the ring banner only navigated, so the
       answer never reached `call_invite_answer` and the caller rang until the
       invite expired
     • "no missed call" — an expired ring vanished silently
     • "a dead switch" — a control that changes nothing

   So this suite loads the real notify.js in a DOM and drives the real banner:
   Accept must call the registered answerer inside the click, Decline must call
   the decliner, an expired ring must become a missed call, and with nothing
   registered the fallback must still land somewhere that can place the call.

   The rest of the round is asserted against the source it has to exist in:
   the meeting route, the host controls, camera switching, ICE restart and the
   TURN secret never being shipped to a browser.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

let counter = 0;

async function bundleNotify() {
  const stub = {
    name: "calling-ui-stubs",
    setup(build) {
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onResolve({ filter: /config\/env\.js$/ }, () => ({ path: "env", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
        contents:
          args.path === "supabase"
            ? `
              export const sb = {
                rpc: async (name, args) => {
                  const out = await globalThis.__rpc(name, args);
                  if (out instanceof Error) return { data: null, error: out };
                  return { data: out, error: null };
                },
                channel: () => { const api = { on: () => api, subscribe: () => api }; return api; },
                removeChannel: () => {}
              };
              export const normalizeError = (error) =>
                error instanceof Error ? error : new Error(String(error?.message || error));
            `
            : `export const env = { vapidPublicKey: "" };`,
        loader: "js"
      }));
    }
  };

  const result = await esbuild.build({
    entryPoints: [path.join(repo, "public/js/ui/notify.js")],
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

function makeWorld({ rpcAnswers = {} } = {}) {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  const navigations = [];
  const rpcCalls = [];

  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.location = {
    origin: "https://shinzora.test",
    href: "https://shinzora.test/app/?view=messages",
    search: "?view=messages",
    assign: (url) => navigations.push(url)
  };
  window.location = globalThis.location;
  globalThis.navigator = { userAgent: "shinzora-test" };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  Object.defineProperty(document, "hidden", { value: false, configurable: true });

  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options || {};
    }
    close() {}
    static permission = "denied";
    static requestPermission = async () => "denied";
  }
  globalThis.Notification = FakeNotification;

  globalThis.__rpc = (name, args) => {
    rpcCalls.push({ name, args });
    return rpcAnswers[name] ?? null;
  };

  return { window, document, navigations, rpcCalls };
}

function callRow({ topic = "call-dm:abc", expiresIn = 30000, kind = "voice" } = {}) {
  return {
    id: "notif-1",
    type: "call",
    title: "Asha is calling",
    body: "Asha is calling",
    link: "/app/?view=messages&tab=direct",
    meta: {
      callTopic: topic,
      callKind: kind,
      senderName: "Asha",
      expiresAt: new Date(Date.now() + expiresIn).toISOString(),
      groupName: "Direct call"
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ the ring */

test("a call notification rings with Accept and Decline, not a dead Join", async () => {
  makeWorld();
  const notify = await bundleNotify();
  const row = callRow();
  assert.equal(notify.presentNotification(row), true);

  const banner = globalThis.document.querySelector(".ring-banner");
  assert.ok(banner, "the ring banner is on screen");
  assert.ok(banner.querySelector("[data-ring-accept]"), "there is an Accept button");
  assert.ok(banner.querySelector("[data-ring-decline]"), "there is a Decline button");
  assert.equal(banner.querySelector("[data-ring-join]"), null, "the old navigating Join button is gone");
  assert.match(banner.textContent, /Asha is calling/);

  notify.stopCallRinging();
  banner.remove();
});

test("Accept answers the call through the registered handler, inside the click", async () => {
  const world = makeWorld();
  const notify = await bundleNotify();
  const seen = [];
  notify.setCallAnswerer({
    answer: async (row) => {
      seen.push(row.meta.callTopic);
      return true;
    },
    decline: async () => true
  });

  notify.presentNotification(callRow({ topic: "call-dm:xyz" }));
  const banner = world.document.querySelector(".ring-banner");
  banner.querySelector("[data-ring-accept]").dispatchEvent(new world.window.Event("click"));

  /* The handler runs on the click itself — the microphone prompt and the audio
     unlock both need that gesture. */
  assert.deepEqual(seen, ["call-dm:xyz"], "the answerer was called with this call's topic");
  await wait(10);
  assert.equal(world.document.querySelector(".ring-banner"), null, "the ring closes once joined");
  notify.stopCallRinging();
});

test("a failed Accept keeps the ring and lets the person try again", async () => {
  const world = makeWorld();
  const notify = await bundleNotify();
  notify.setCallAnswerer({
    answer: async () => {
      throw new Error("That call is no longer ringing.");
    },
    decline: async () => true
  });

  notify.presentNotification(callRow({ topic: "call-dm:fail" }));
  const banner = world.document.querySelector(".ring-banner");
  const accept = banner.querySelector("[data-ring-accept]");
  accept.dispatchEvent(new world.window.Event("click"));
  await wait(20);

  assert.ok(world.document.querySelector(".ring-banner"), "the banner is still there");
  const after = world.document.querySelector("[data-ring-accept]");
  assert.equal(after.disabled, false, "the button is usable again");
  assert.equal(after.textContent.trim(), "Accept");
  notify.stopCallRinging();
});

test("Decline tells the caller instead of ringing into the void", async () => {
  const world = makeWorld();
  const notify = await bundleNotify();
  let declined = 0;
  notify.setCallAnswerer({
    answer: async () => true,
    decline: async () => {
      declined += 1;
      return true;
    }
  });

  notify.presentNotification(callRow({ topic: "call-dm:no" }));
  world.document.querySelector("[data-ring-decline]").dispatchEvent(new world.window.Event("click"));
  await wait(10);

  assert.equal(declined, 1, "the decline reached the call layer");
  assert.equal(world.document.querySelector(".ring-banner"), null, "the ring stopped");
  notify.stopCallRinging();
});

test("with no call engine on the page, Accept still goes somewhere that can place the call", async () => {
  const world = makeWorld();
  const notify = await bundleNotify();
  notify.setCallAnswerer(null);

  notify.presentNotification(callRow({ topic: "call-dm:fallback" }));
  world.document.querySelector("[data-ring-accept]").dispatchEvent(new world.window.Event("click"));
  await wait(10);

  assert.equal(world.navigations.length, 1, "the page navigated");
  assert.match(
    world.navigations[0],
    /answer=call-dm%3Afallback/,
    "and it carries the topic, so the destination can answer that call"
  );
  notify.stopCallRinging();
});

test("an unanswered ring becomes a missed call instead of vanishing", async () => {
  const world = makeWorld({ rpcAnswers: { call_invite_acknowledge: { acknowledged: true } } });
  const notify = await bundleNotify();

  notify.presentNotification(callRow({ topic: "call-dm:missed", expiresIn: 200 }));
  const banner = world.document.querySelector(".ring-banner");
  assert.ok(banner);

  await wait(1300);

  const still = world.document.querySelector(".ring-banner");
  assert.ok(still, "the banner is still on screen");
  assert.match(still.textContent, /Missed call/, "it now says the call was missed");
  assert.equal(still.querySelector("[data-ring-accept]"), null, "there is nothing left to answer");
  assert.ok(
    world.rpcCalls.some((call) => call.name === "call_invite_acknowledge"),
    "the stored ring is marked read so it cannot ring again on reload"
  );
  notify.stopCallRinging();
});

test("the same call does not ring twice", async () => {
  const world = makeWorld();
  const notify = await bundleNotify();
  const row = callRow({ topic: "call-dm:once" });
  notify.presentNotification(row);
  notify.presentNotification(row);
  assert.equal(world.document.querySelectorAll(".ring-banner").length, 1);
  notify.stopCallRinging();
});

/* ------------------------------------------------------- what must exist where */

test("answering is wired on every page, not only inside messages", () => {
  const shell = read("public/js/modules/dashboard/shell.js");
  assert.match(shell, /registerIncomingCalls\(\)/, "the shell registers the answer handler");
  assert.match(shell, /import \{ registerIncomingCalls \} from "\.\.\/messaging\/incoming-call\.js"/);

  const incoming = read("public/js/modules/messaging/incoming-call.js");
  assert.match(incoming, /call_invite_answer/, "answering goes through the database check");
  assert.match(incoming, /call_invite_decline/, "declining does too");
  assert.match(incoming, /openCallSurface/, "an accepted call opens the real call panel");
  assert.doesNotMatch(incoming, /localStorage|sessionStorage/, "a call is not authorised from the browser");
});

test("meetings are a route, a sidebar entry, and a real room", () => {
  const router = read("public/js/modules/dashboard/router.js");
  assert.match(router, /meeting: \(\) => import\("\.\/views\/meeting\.js"\)/);

  const shell = read("public/js/modules/dashboard/shell.js");
  assert.equal((shell.match(/id: "meeting", label: "Meetings"/g) || []).length, 2, "both navs have it");

  const view = read("public/js/modules/dashboard/views/meeting.js");
  for (const rpc of [
    "meeting_create",
    "meeting_lookup",
    "meeting_join",
    "meeting_leave",
    "meeting_end",
    "meeting_lock",
    "meeting_mine"
  ]) {
    assert.match(view, new RegExp(rpc), `${rpc} is used`);
  }
  assert.match(view, /view=meeting&code=/, "the invite link is a real link");
  assert.match(view, /postgres_changes/, "the room watches for the host ending it");
  assert.match(view, /shinzora:view/, "navigating away leaves the meeting instead of leaving the camera on");
  assert.match(view, /End for everyone/, "leave and end are different buttons");
  assert.match(view, /Leave/, "leaving keeps the room open");
});

test("the call surface has a participant list, fullscreen, camera flip and honest states", () => {
  const ui = read("public/js/modules/messaging/call-ui.js");
  assert.match(ui, /call-people/, "a participant list exists");
  assert.match(ui, /data-tile-fullscreen/, "remote video can go full screen");
  assert.match(ui, /data-call-flip/, "the camera can be switched");
  assert.match(ui, /Reconnecting/, "a dropped connection is named");
  assert.match(ui, /call_invite_missed/, "the caller records a missed call");
  assert.match(ui, /call_invite_state/, "the caller can see an invite declined");
  assert.match(ui, /announceMissed/, "hanging up without an answer writes the missed call");
});

test("the engine can switch camera, restart ICE and publish presence", () => {
  const engine = read("public/js/modules/messaging/webrtc.js");
  assert.match(engine, /async function switchCamera/);
  assert.match(engine, /restartIce/);
  assert.match(engine, /iceRestart: true/, "the ICE restart asks for a restart");
  assert.match(engine, /ch\.on\("presence"/, "the participant list is presence-backed");
  /* A handler added after subscribe() never fires in supabase-js — that is the
     "participants never appear" defect, so the order is pinned. */
  const bound = engine.indexOf("bindPresence(channel)");
  const subscribed = engine.indexOf("channel.subscribe(");
  assert.ok(bound > 0 && subscribed > bound, "presence is bound before the channel is subscribed");
  assert.match(engine, /state\.others/, "other participants are part of the call state");
  assert.match(engine, /switchCamera,/, "it is exported");
  assert.match(engine, /restartIce,/, "it is exported");
});

test("TURN credentials never reach the browser", () => {
  const engine = read("public/js/modules/messaging/webrtc.js");
  assert.doesNotMatch(engine, /CLOUDFLARE_TURN_API_TOKEN|TURN_KEY_API_TOKEN/, "no server secret in the client");
  assert.match(engine, /turn-credentials/, "the client asks the Edge Function for credentials");

  const fn = read("supabase/functions/turn-credentials/index.ts");
  assert.match(fn, /credentials\/generate-ice-servers/, "the documented Cloudflare path");
  assert.match(fn, /not_configured/, "and it says so plainly when unconfigured");
  assert.doesNotMatch(fn, /console\.log\(.*TOKEN/, "the token is never logged");
});

test("0047 finishes the ring protocol and puts meetings on the wire", () => {
  const sql = read("supabase/migrations/0047_call_ring_acknowledge.sql");
  assert.match(sql, /create or replace function public\.call_invite_acknowledge/);
  assert.match(sql, /create or replace function public\.call_invite_state/);
  assert.match(sql, /alter publication supabase_realtime add table public\.meetings/, "host end reaches attendees");
  assert.match(sql, /where type = 'call'/);
  assert.match(sql, /user_id = actor/, "only the person rung can silence their own ring");
});
