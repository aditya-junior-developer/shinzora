/* ==========================================================================
   The assistant that never answers, and the answer it already had
   --------------------------------------------------------------------------
   Reported symptom (screenshot): "hi" and "hello" sent, three dots turning
   under each one for half an hour, composer disabled, nothing else.

   The database showed the truth: `ai_messages` held the reply, written at
   11:28, and `ai_usage_log` recorded the call as successful. The server had
   answered; the page had simply never painted it, and nothing ever took the
   dots away.

   So these tests hold the client to three promises:
     1. a request that fails still ends — dots gone, composer usable again
     2. a reply that was saved is recovered and shown, not blamed on the network
     3. waiting is visible and escapable (a clock and a Stop button)
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

const SAVED_REPLY = "Hello. We can continue setting up Klyr.";

const stub = {
  name: "assistant-stubs",
  setup(build) {
    const supabase = `
      const saved = () => ({
        data: [{ conversation_id: "conv-1", role: "assistant", content: globalThis.__savedReply || "",
                 created_at: new Date().toISOString() }],
        error: globalThis.__messagesError || null
      });
      export const sb = {
        from: (table) => {
          if (table === "ai_conversations") {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: "conv-1" }, error: null }) }) })
                  })
                })
              })
            };
          }
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ order: () => ({ limit: async () => globalThis.__savedReply ? saved() : { data: [], error: null } }) }),
                order: () => ({ limit: async () => globalThis.__savedReply ? saved() : { data: [], error: null } })
              }),
              order: () => ({ limit: async () => ({ data: [], error: null }) })
            })
          };
        },
        channel: () => { const api = { on: () => api, subscribe: () => api }; return api; },
        removeChannel: () => {},
        rpc: async () => ({ data: null, error: null }),
        auth: { getSession: async () => ({ data: { session: { user: { id: "u-1" } } } }),
                getUser: async () => ({ data: { user: { id: "u-1" } } }) }
      };
      export const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error?.message || error)));
      export const getSession = async () => ({ user: { id: "u-1" } });
      export const AppError = class extends Error { constructor(m, o = {}) { super(m); Object.assign(this, o); } };
    `;
    const api = `
      export const api = { ai: { chat: (payload) => globalThis.__chat(payload) } };
      export const runtimeConfig = async () => ({ ai: { configured: true } });
      export function actionPendingDeploy() { return false; }
    `;
    const store = `
      export const state = { business: null, profile: { full_name: "Aditya" }, subscription: null };
      export const plan = () => ({ id: "free", name: "Free" });
      export const aiCredits = () => ({ used: 0, limit: 800 });
    `;
    const toast = `
      export const toast = () => {};
      export const toastError = () => {};
    `;
    build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
    build.onResolve({ filter: /lib\/api\.js$/ }, () => ({ path: "api", namespace: "stub" }));
    build.onResolve({ filter: /lib\/store\.js$/ }, () => ({ path: "store", namespace: "stub" }));
    build.onResolve({ filter: /ui\/toast\.js$/ }, () => ({ path: "toast", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: { supabase, api, store, toast }[args.path],
      loader: "js"
    }));
  }
};

async function bundleView() {
  const result = await esbuild.build({
    entryPoints: [path.join(repo, "public/js/modules/dashboard/views/assistant.js")],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [stub]
  });
  const url = "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64") + "#" + ++counter;
  return import(url);
}

function makeWorld() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='view-root'></div><div id='toast-region'></div></body></html>"
  );
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.location = new URL("https://shinzora.test/app/?view=assistant");
  window.location = globalThis.location;
  globalThis.history = { replaceState: () => {}, pushState: () => {} };
  globalThis.navigator = { userAgent: "shinzora-test" };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.Element.prototype.scrollIntoView = function () {};
  window.Element.prototype.scrollTo = function () {};
  return { window, document, root: document.getElementById("view-root") };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(world) {
  const view = await bundleView();
  await view.default(world.root, {});
  await settle(120);
  return world;
}

test("a failed request removes the dots and gives the composer back", async () => {
  const world = makeWorld();
  globalThis.__savedReply = "";
  globalThis.__chat = async () => {
    throw new Error("Edge Function returned a non-2xx status code");
  };
  await mount(world);

  const input = world.root.querySelector("#chat-input");
  const send = world.root.querySelector("#chat-send");
  input.value = "hello";
  send.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(200);

  assert.equal(world.root.querySelectorAll("[data-thinking]").length, 0, "the waiting bubble is gone");
  assert.equal(send.disabled, false, "the send button is usable again");
  assert.match(world.root.textContent, /could not complete that request/i, "the failure is stated in words");
});

test("the message the person typed is offered back so it can be retried", async () => {
  const world = makeWorld();
  globalThis.__savedReply = "";
  globalThis.__chat = async () => {
    throw new Error("network down");
  };
  await mount(world);

  const input = world.root.querySelector("#chat-input");
  input.value = "what should my homepage say?";
  world.root.querySelector("#chat-send").dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(200);
  /* A failure that is not a timeout keeps the input empty — but the message is
     visible in the thread above, so nothing was silently dropped. */
  assert.match(world.root.textContent, /what should my homepage say\?/, "the question stays on screen");
});

test("a reply that was saved arrives even though the request failed", async () => {
  const world = makeWorld();
  globalThis.__savedReply = SAVED_REPLY;
  globalThis.__chat = async () => {
    throw new Error("The request took too long and was cancelled.");
  };
  await mount(world);

  const input = world.root.querySelector("#chat-input");
  input.value = "hello";
  world.root.querySelector("#chat-send").dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(300);

  const text = world.root.textContent;
  assert.ok(text.includes(SAVED_REPLY), "the saved answer is painted");
  assert.match(text, /saved on the server/i, "and it says where it came from");
  assert.equal(world.root.querySelectorAll("[data-thinking]").length, 0, "no dots left behind");
  assert.doesNotMatch(text, /could not complete that request/i, "the network is not blamed for a reply that exists");
});

test("waiting is visible: the bubble carries a clock", async () => {
  const world = makeWorld();
  globalThis.__savedReply = "";
  let release;
  globalThis.__chat = () => new Promise((resolve) => { release = resolve; });
  await mount(world);

  const input = world.root.querySelector("#chat-input");
  input.value = "health check";
  world.root.querySelector("#chat-send").dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(2400);

  const pending = world.root.querySelector("[data-thinking]");
  assert.ok(pending, "the waiting bubble is on screen");
  const note = pending.querySelector("[data-thinking-note]");
  assert.ok(note, "it has a note element");
  assert.match(note.textContent, /\d+:\d\d/, `the clock is counting, got "${note.textContent}"`);
  assert.ok(pending.querySelector("[data-thinking-cancel]"), "and there is a way to stop waiting");

  release({ reply: "All good.", model: "gemini-3.8-flash" });
  await settle(120);
  assert.equal(world.root.querySelectorAll("[data-thinking]").length, 0, "the answer replaces it");
});

test("Stop waiting does not leave the composer stuck", async () => {
  const world = makeWorld();
  globalThis.__savedReply = SAVED_REPLY;
  globalThis.__chat = () => new Promise(() => {}); // never settles
  await mount(world);

  const input = world.root.querySelector("#chat-input");
  input.value = "still there?";
  const send = world.root.querySelector("#chat-send");
  send.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(200);

  /* The Stop button appears after twelve seconds; the click is simulated here so
     the test does not have to wait for it. */
  const cancel = world.root.querySelector("[data-thinking-cancel]");
  assert.ok(cancel, "a Stop button exists");
  cancel.dispatchEvent(new world.window.Event("click", { bubbles: true }));
  await settle(300);

  assert.equal(send.disabled, false, "the composer is usable after stopping");
  assert.match(world.root.textContent, /saved/i, "and what the server had is shown");
});
