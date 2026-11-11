/* ==========================================================================
   Notifications — the two halves that can actually be proven here
   --------------------------------------------------------------------------
   "I am not getting notifications on my freelancing account" is not one bug,
   it is a handful of different ones wearing the same sentence. So this suite
   pins down the parts that live in the browser:

     1. the operating-system alert is raised when the tab is behind, with the
        same title and body the in-app notice carries
     2. it is NOT raised when the tab is in front (two popups for one message is
        noise) and NOT raised when the member turned the preference off — the
        switch that used to do nothing
     3. with permission not granted, nothing is claimed: no alert, no toast
        saying it was delivered
     4. the "Test this account" card asks the server for a real row, reports
        what came back (group, push devices), and can delete those rows again

   What cannot be proven here is delivery to an operating system: that needs a
   real browser and a human looking at it. The card exists so the person can
   check it themselves in ten seconds.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

let counter = 0;

async function bundle(entry) {
  const stub = {
    name: "notify-stubs",
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
            : `export const env = { vapidPublicKey: "BDtestVapidKeyForTheHarnessOnly" };`,
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
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  return import(url);
}

function makeWorld({ permission = "granted", hidden = true, prefs = null, rpcAnswers = {} } = {}) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>"
  );

  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.location = new URL("https://shinzora.test/app/?view=messages");
  window.location = globalThis.location;
  /* A browser that supports Web Push but has no subscription yet — the state
     most accounts are actually in, and the one the card must describe. */
  globalThis.navigator = {
    userAgent: "shinzora-test",
    serviceWorker: { getRegistration: async () => null, ready: Promise.resolve(null) }
  };
  window.PushManager = function PushManager() {};
  window.isSecureContext = true;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.setTimeout = setTimeout;

  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });

  /** The fakes an OS notification needs. */
  const alerts = [];
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options || {};
      this.closed = false;
      alerts.push(this);
    }
    close() {
      this.closed = true;
    }
    static permission = permission;
    static requestPermission = async () => FakeNotification.permission;
  }
  globalThis.Notification = FakeNotification;
  window.Notification = FakeNotification;

  const calls = [];
  const answers = {
    notification_prefs_get: prefs || {
      groupMessages: true,
      groupMentions: true,
      sounds: false,
      desktopNotifications: true,
      mutedGroups: [],
      devices: 0
    },
    notification_self_test: { id: "n1", inGroup: true, groupName: "Design team", pushDevices: 0, pushEnabled: false },
    notification_self_test_clear: { removed: 2 },
    ...rpcAnswers
  };
  globalThis.__rpc = (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? null;
  };

  return { window, document, root: document.getElementById("root"), alerts, calls, Notification: FakeNotification };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const ROW = {
  id: "row-1",
  type: "group",
  title: "Design team",
  body: "Asha: the banner is ready",
  link: "/app/?view=messages&tab=groups&group=g1",
  meta: { groupId: "g1", groupName: "Design team", senderName: "Asha", messageId: "m1", kind: "message" }
};

test("with the tab behind another window, a notification row raises a system alert", async () => {
  const world = makeWorld({ hidden: true });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  const delivered = notify.presentNotification(ROW);
  await settle();

  assert.equal(delivered, true, "the row was delivered");
  assert.equal(world.alerts.length, 1, "exactly one operating-system alert");
  assert.equal(world.alerts[0].title, "Design team");
  assert.match(world.alerts[0].options.body, /the banner is ready/);
  assert.equal(world.alerts[0].options.tag, "shinzora-m1", "one alert per message, not per repaint");
  assert.ok(world.root.ownerDocument.querySelector(".notice"), "and the in-app notice is there too");
});

test("with the tab in front there is an in-app notice and no system alert", async () => {
  const world = makeWorld({ hidden: false });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  notify.presentNotification(ROW);
  await settle();

  assert.equal(world.alerts.length, 0, "no second popup for something already on screen");
  assert.ok(world.document.querySelector(".notice"), "the in-app notice still appears");
});

test("the desktop-alerts preference is now wired: off means no system alert", async () => {
  const world = makeWorld({
    hidden: true,
    prefs: {
      groupMessages: true,
      groupMentions: true,
      sounds: false,
      desktopNotifications: false,
      mutedGroups: [],
      devices: 0
    }
  });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  notify.presentNotification(ROW);
  await settle();

  assert.equal(world.alerts.length, 0, "the switch is honoured");
  assert.ok(world.document.querySelector(".notice"), "but the app still tells you");
});

test("when the browser has not granted permission, nothing is claimed", async () => {
  const world = makeWorld({ hidden: true, permission: "default" });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  notify.presentNotification(ROW);
  await settle();

  assert.equal(world.alerts.length, 0);
  const state = notify.pushState();
  assert.equal(state.ok, false, "closed-tab push is not available to this browser either");
  assert.equal(state.reason, "permission-required", "and pushState names the missing piece: the permission");
});

test("muting a group still suppresses it even with the tab open", async () => {
  const world = makeWorld({
    hidden: true,
    prefs: {
      groupMessages: true,
      groupMentions: true,
      sounds: false,
      desktopNotifications: true,
      mutedGroups: ["g1"],
      devices: 0
    }
  });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  assert.equal(notify.presentNotification(ROW), false, "a muted group delivers nothing");
  assert.equal(world.alerts.length, 0);
});

test("the settings card offers a real test and reports what the server did", async () => {
  const world = makeWorld({ hidden: false });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  await notify.loadPrefs(true);

  world.root.innerHTML = notify.notificationSettingsMarkup([]);
  notify.bindNotificationSettings(world.root, {});

  const send = world.root.querySelector("#notify-test-send");
  assert.ok(send, "the test button is in the card");
  send.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(120);

  assert.equal(world.calls.filter((call) => call.name === "notification_self_test").length, 1, "one real row requested");
  const report = world.root.querySelector("#notify-test-result");
  assert.equal(report.hidden, false, "a report is rendered");
  assert.match(report.textContent, /Design team/, "it says which group the row links to");
  assert.match(report.textContent, /No device is subscribed/, "and is honest that closed-tab push is not set up");
  assert.match(report.textContent, /permission is granted/i, "and says the browser permission is on");

  const clear = world.root.querySelector("#notify-test-clear");
  assert.equal(clear.hidden, false, "clearing is offered once a test exists");
  clear.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(120);
  assert.equal(world.calls.filter((call) => call.name === "notification_self_test_clear").length, 1);
  assert.match(world.root.querySelector("#notify-test-result").textContent, /Removed 2 test notification/);
});

test("a server that refuses the test is reported, not swallowed", async () => {
  const world = makeWorld({ hidden: false, rpcAnswers: { notification_self_test: new Error("Sign in first.") } });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));

  await world.root;
  world.root.innerHTML = notify.notificationSettingsMarkup([]);
  notify.bindNotificationSettings(world.root, {});
  world.root.querySelector("#notify-test-send").dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(120);

  const report = world.root.querySelector("#notify-test-result");
  assert.match(report.textContent, /refused to create the test notification: Sign in first/);
  assert.match(report.className, /is-bad/);
});

test("subscribed devices are counted out loud, so closed-tab alerts are not overclaimed", async () => {
  const world = makeWorld({
    hidden: false,
    rpcAnswers: {
      notification_self_test: { id: "n2", inGroup: false, groupName: null, pushDevices: 2, pushEnabled: true }
    }
  });
  const notify = await bundle(path.join(repo, "public/js/ui/notify.js"));
  world.root.innerHTML = notify.notificationSettingsMarkup([]);
  notify.bindNotificationSettings(world.root, {});
  world.root.querySelector("#notify-test-send").dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(120);

  const text = world.root.querySelector("#notify-test-result").textContent;
  assert.match(text, /2 devices subscribed/, "it says how many devices would receive a closed-tab alert");
  assert.match(text, /you are not in a group/, "and why the row links where it does");
});
